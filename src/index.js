import 'dotenv/config';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import util from 'node:util';
import admin from 'firebase-admin';
import { leaveEvents, pushMessage, sessionEvents } from './pushEvents.js';

const LOG_FILE = process.env.LOG_FILE || './logs/server.log';
fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
for (const level of ['log', 'error', 'warn']) {
  const orig = console[level].bind(console);
  console[level] = (...args) => {
    const line = `[${new Date().toISOString()}] [${level.toUpperCase()}] ${args
      .map((a) => (typeof a === 'string' ? a : util.inspect(a, { depth: 4, breakLength: Infinity })))
      .join(' ')}\n`;
    try { fs.appendFileSync(LOG_FILE, line); } catch {}
    orig(...args);
  };
}

process.on('uncaughtException', (err) => {
  console.error('[fatal] uncaughtException', err);
  process.exit(1);
});
process.on('unhandledRejection', (err) => {
  console.error('[fatal] unhandledRejection', err);
});

const credPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;
if (!credPath) {
  console.error('Missing GOOGLE_APPLICATION_CREDENTIALS in .env');
  process.exit(1);
}
if (!process.env.EXPO_PUSH_ACCESS_TOKEN) {
  console.error('Missing EXPO_PUSH_ACCESS_TOKEN in .env');
  process.exit(1);
}

const serviceAccount = JSON.parse(fs.readFileSync(credPath, 'utf8'));
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});
const db = admin.firestore();

const tokenPattern = /^(Expo|Exponent)PushToken\[[A-Za-z0-9_-]+\]$/;
const seen = new Set();
const MAX_SEEN = 5000;
const previous = { sessions: new Map(), leaves: new Map() };
let ready = { sessions: false, leaves: false };

function remember(key) {
  if (seen.has(key)) return false;
  seen.add(key);
  if (seen.size > MAX_SEEN) {
    const first = seen.values().next().value;
    seen.delete(first);
  }
  return true;
}

async function getTokens(uid) {
  const snap = await db.collection('users').doc(uid).collection('push_tokens').get();
  return snap.docs
    .map((d) => ({ id: d.id, token: d.get('token') }))
    .filter((d) => typeof d.token === 'string' && tokenPattern.test(d.token));
}

async function sendExpo(messages) {
  if (!messages.length) return;
  const res = await fetch('https://exp.host/--/api/v2/push/send', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${process.env.EXPO_PUSH_ACCESS_TOKEN}`,
    },
    body: JSON.stringify(messages),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Expo push failed: ${res.status} ${text}`);
  }
  return res.json().catch(() => null);
}

async function deliver(notices, source) {
  for (const { recipients, ...notice } of notices) {
    for (const uid of recipients) {
      const tokens = await getTokens(uid);
      const messages = [];
      for (const device of tokens) {
        const key = createHash('sha256')
          .update(JSON.stringify([source, notice.type, notice.sessionId ?? notice.leaveId, uid, device.id]))
          .digest('hex');
        if (!remember(key)) continue;
        messages.push(pushMessage({ ...notice, uid }, device.token));
      }
      if (!messages.length) continue;
      try {
        await sendExpo(messages);
        console.log(`[push] sent ${notice.type} -> ${uid} (${messages.length})`);
      } catch (err) {
        console.error('[push] send error', err);
      }
    }
  }
}

function watchCollection(name, map, makeEvents) {
  return db.collection(name).onSnapshot(
    async (snap) => {
      if (!ready[name]) {
        snap.docs.forEach((d) => map.set(d.id, d.data()));
        ready[name] = true;
        console.log(`[watch] ${name} ready (${map.size} docs)`);
        return;
      }

      for (const change of snap.docChanges()) {
        const id = change.doc.id;
        const after = change.doc.data();
        const before = map.get(id);

        if (change.type === 'added') {
          map.set(id, after);
          continue;
        }
        if (change.type === 'removed') {
          map.delete(id);
          continue;
        }
        if (change.type === 'modified') {
          map.set(id, after);
          if (!before) continue;
          const notices = makeEvents(before, after, id);
          if (notices.length) await deliver(notices, `${name}:${id}:${change.doc.updateTime?.toMillis?.() ?? Date.now()}`);
        }
      }
    },
    (err) => console.error(`[watch] ${name} error`, err),
  );
}

const unsubSessions = watchCollection('sessions', previous.sessions, sessionEvents);
const unsubLeaves = watchCollection('leave_requests', previous.leaves, leaveEvents);

const port = Number(process.env.PORT || 8787);
const server = http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, ready, sessions: previous.sessions.size, leaves: previous.leaves.size, seen: seen.size }));
    return;
  }
  res.writeHead(404);
  res.end();
});
server.listen(port, () => console.log(`[health] listening on :${port}`));

function shutdown() {
  console.log('Shutting down...');
  unsubSessions();
  unsubLeaves();
  server.close(() => process.exit(0));
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
