import "dotenv/config";
import { createHash } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import util from "node:util";
import admin from "firebase-admin";
import {
  fineCreatedEvents,
  inboxEntries,
  leaveEvents,
  paymentEvents,
  pushMessage,
  sessionCreatedEvents,
  sessionEvents,
} from "./pushEvents.js";

const LOG_FILE = process.env.LOG_FILE || "./logs/server.log";
fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
for (const level of ["log", "error", "warn", "info", "debug"]) {
  const orig = console[level].bind(console);
  console[level] = (...args) => {
    const message = args
      .map((a) =>
        typeof a === "string"
          ? a
          : util.inspect(a, { depth: 4, breakLength: Infinity }),
      )
      .join(" ");
    const stamp = new Date().toISOString();
    const line = `[${stamp}] [${level.toUpperCase()}] ${message}\n`;
    try {
      fs.appendFileSync(LOG_FILE, line);
    } catch {}
    orig(`[${stamp}] [${level.toUpperCase()}] ${message}`);
  };
}

process.on("uncaughtException", (err) => {
  console.error("[fatal] uncaughtException", err);
  process.exit(1);
});
process.on("unhandledRejection", (err) => {
  console.error("[fatal] unhandledRejection", err);
});

const credPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;
if (!credPath) {
  console.error("Missing GOOGLE_APPLICATION_CREDENTIALS in .env");
  process.exit(1);
}
if (!process.env.EXPO_PUSH_ACCESS_TOKEN) {
  console.error("Missing EXPO_PUSH_ACCESS_TOKEN in .env");
  process.exit(1);
}

const serviceAccount = JSON.parse(fs.readFileSync(credPath, "utf8"));
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});
const db = admin.firestore();
const { FieldValue } = admin.firestore;

const jobs = db.collection("push_delivery");
const tokenPattern = /^(Expo|Exponent)PushToken\[[A-Za-z0-9_-]+\]$/;
const minute = 60_000;
const day = 24 * minute;
const sendWindow = 60 * minute;
const queueInterval = Number(process.env.QUEUE_INTERVAL_MS || minute);
const previous = {
  sessions: new Map(),
  leave_requests: new Map(),
  fines: new Map(),
  payment_transactions: new Map(),
};
const ready = Object.fromEntries(
  Object.keys(previous).map((name) => [name, false]),
);
let queueRunning = false;
let lastQueueAt = null;

const ignoreExisting = (error) => (error.code === 6 ? null : error);

function stampOf(change) {
  return change.type === "added"
    ? change.doc.createTime
    : change.doc.updateTime;
}

function eventIdOf(name, change) {
  const stamp = stampOf(change);
  return `${name}:${change.doc.id}:${stamp?.toMillis?.() ?? Date.now()}`;
}

function eventTimeOf(change) {
  return stampOf(change)?.toDate?.().toISOString() ?? new Date().toISOString();
}

async function getTokens(uid) {
  const snap = await db
    .collection("users")
    .doc(uid)
    .collection("push_tokens")
    .get();
  return snap.docs
    .map((d) => ({ id: d.id, token: d.get("token") }))
    .filter((d) => typeof d.token === "string" && tokenPattern.test(d.token));
}

/**
 * Inbox selalu ditulis (Admin SDK). Push yang masih dalam jendela 60 menit
 * masuk antrean `push_delivery` dengan ID deterministik agar event yang
 * diulang tidak mengirim dobel.
 */
async function enqueue(eventId, eventTime, notices, source) {
  const occurredAt = Date.parse(eventTime) || Date.now();
  const sendUntil = occurredAt + sendWindow;
  const inbox = inboxEntries(eventId, notices, source, new Date(occurredAt));
  const inboxByKey = new Map(
    inbox.map((entry) => [entry.data.type + "/" + entry.uid, entry]),
  );
  const writer = db.bulkWriter();
  const writes = [];

  try {
    for (const entry of inbox) {
      writes.push(
        writer
          .create(
            db
              .collection("users")
              .doc(entry.uid)
              .collection("notifications")
              .doc(entry.id),
            entry.data,
          )
          .catch(ignoreExisting),
      );
    }
    if (sendUntil > Date.now()) {
      for (const { recipients, ...notice } of notices) {
        for (const uid of recipients) {
          const entry = inboxByKey.get(notice.type + "/" + uid);
          const tokens = await getTokens(uid);
          for (const device of tokens) {
            const id = createHash("sha256")
              .update(JSON.stringify([eventId, notice.type, uid, device.id]))
              .digest("hex");
            writes.push(
              writer
                .create(jobs.doc(id), {
                  ...notice,
                  uid,
                  title: entry.data.title,
                  body: entry.data.body,
                  notificationId: entry.id,
                  installationId: device.id,
                  phase: "send",
                  dueAt: occurredAt,
                  sendUntil,
                  expireAt: new Date(occurredAt + 7 * day),
                  attempts: 0,
                })
                .catch(ignoreExisting),
            );
          }
        }
      }
    }
  } finally {
    await writer.close();
  }
  const failure = (await Promise.all(writes)).find(Boolean);
  if (failure) throw failure;
  void processQueue();
}

async function callExpo(endpoint, body) {
  const response = await fetch(`https://exp.host/--/api/v2/push/${endpoint}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.EXPO_PUSH_ACCESS_TOKEN}`,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  if (response.status === 429 || response.status >= 500)
    throw new Error("Expo push temporarily unavailable");
  if (!response.ok)
    return { status: "error", details: { error: "HTTP_" + response.status } };
  const { data } = await response.json();
  return endpoint === "send" ? data?.[0] : data?.[body.ids[0]];
}

async function stillEligible(job) {
  if (job.sessionId) {
    const session = await db.collection("sessions").doc(job.sessionId).get();
    const participants = session.get("participantIds");
    return (
      Array.isArray(participants) &&
      participants.includes(job.uid) &&
      (job.type !== "session_opened" || session.get("status") === "open")
    );
  }
  if (job.leaveId) {
    const leave = await db.collection("leave_requests").doc(job.leaveId).get();
    return (
      leave.get("studentId") === job.uid &&
      ["approved", "rejected"].includes(leave.get("status"))
    );
  }
  if (job.fineId) {
    const fine = await db.collection("fines").doc(job.fineId).get();
    if (!fine.exists || fine.get("studentId") !== job.uid) return false;
    if (job.type === "fine_issued") return fine.get("status") === "unpaid";
    if (job.type === "payment_success") return fine.get("status") === "paid";
    if (job.type === "payment_failed") return fine.get("status") === "unpaid";
  }
  return true;
}

async function invalidateToken(ref, token) {
  await db.runTransaction(async (transaction) => {
    const current = await transaction.get(ref);
    if (current.get("token") === token) transaction.delete(ref);
  });
}

async function deliver(ref) {
  const job = await db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(ref);
    const data = snapshot.data();
    if (!data || typeof data.dueAt !== "number" || data.dueAt > Date.now())
      return null;
    transaction.update(ref, { dueAt: Date.now() + 5 * minute });
    return data;
  });
  if (!job) return;

  const finish = (phase, error = null) =>
    ref.update({
      phase,
      error,
      dueAt: FieldValue.delete(),
      token: FieldValue.delete(),
    });
  const retry = () =>
    ref.update({
      attempts: job.attempts + 1,
      dueAt: Date.now() + Math.min(30, 2 ** job.attempts) * minute,
    });
  const tokenRef = db
    .collection("users")
    .doc(job.uid)
    .collection("push_tokens")
    .doc(job.installationId);

  try {
    if (job.phase === "receipt") {
      if (Date.now() >= job.receiptUntil)
        return await finish("unknown", "receipt_missing");
      const receipt = await callExpo("getReceipts", { ids: [job.ticketId] });
      if (!receipt) return await retry();
      if (receipt.status === "ok") return await finish("accepted");
      const code = receipt.details?.error ?? "receipt_error";
      if (code === "DeviceNotRegistered")
        await invalidateToken(tokenRef, job.token);
      return await finish("failed", code);
    }

    if (Date.now() >= job.sendUntil || !(await stillEligible(job)))
      return await finish("skipped");
    const token = (await tokenRef.get()).get("token");
    if (!tokenPattern.test(token)) return await finish("skipped");

    const ticket = await callExpo("send", [pushMessage(job, token)]);
    if (ticket?.status === "ok" && ticket.id) {
      return await ref.update({
        phase: "receipt",
        ticketId: ticket.id,
        token,
        dueAt: Date.now() + 15 * minute,
        receiptUntil: Date.now() + day,
        attempts: 0,
      });
    }
    const code = ticket?.details?.error ?? "invalid_ticket";
    if (code === "DeviceNotRegistered") await invalidateToken(tokenRef, token);
    if (code === "MessageRateExceeded") return await retry();
    await finish("failed", code);
  } catch {
    console.warn("[push] delivery will be retried", {
      deliveryId: ref.id,
      phase: job.phase,
    });
    await retry();
  }
}

async function processQueue() {
  if (queueRunning) return;
  queueRunning = true;
  try {
    const due = await jobs
      .where("dueAt", "<=", Date.now())
      .orderBy("dueAt")
      .limit(100)
      .get();
    for (let i = 0; i < due.size; i += 20) {
      await Promise.all(
        due.docs.slice(i, i + 20).map((job) => deliver(job.ref)),
      );
    }
    lastQueueAt = new Date().toISOString();
  } catch (err) {
    console.error("[queue] error", err);
  } finally {
    queueRunning = false;
  }
}

const handlers = {
  sessions: {
    added: (after, id) => ({
      notices: sessionCreatedEvents(after, id),
      source: after,
    }),
    modified: (before, after, id) => ({
      notices: sessionEvents(before, after, id),
      source: after,
    }),
  },
  leave_requests: {
    modified: (before, after, id) => ({
      notices: leaveEvents(before, after, id),
      source: after,
    }),
  },
  fines: {
    added: (after, id) => ({
      notices: fineCreatedEvents(after, id),
      source: after,
    }),
  },
  payment_transactions: {
    modified: async (before, after) => {
      const notices = paymentEvents(before, after);
      if (!notices.length) return { notices, source: after };
      let source = after;
      if (after.fineId) {
        const fine = await db.collection("fines").doc(after.fineId).get();
        if (fine.exists) source = { ...fine.data(), ...after };
      }
      return { notices, source };
    },
  },
};

function watchCollection(name) {
  const map = previous[name];
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
        if (change.type === "added") {
          map.set(id, after);
          const result = handlers[name].added?.(after, id);
          if (result?.notices.length)
            await enqueue(
              eventIdOf(name, change),
              eventTimeOf(change),
              result.notices,
              result.source,
            );
          continue;
        }
        if (change.type === "removed") {
          map.delete(id);
          continue;
        }
        if (change.type === "modified") {
          const before = map.get(id);
          map.set(id, after);
          if (!before) continue;
          const result = await handlers[name].modified?.(before, after, id);
          if (result?.notices.length)
            await enqueue(
              eventIdOf(name, change),
              eventTimeOf(change),
              result.notices,
              result.source,
            );
        }
      }
    },
    (err) => console.error(`[watch] ${name} error`, err),
  );
}

const unsubs = Object.keys(handlers).map(watchCollection);
const queueTimer = setInterval(() => void processQueue(), queueInterval);
queueTimer.unref();
void processQueue();

const port = Number(process.env.PORT || 8787);
const server = http.createServer((req, res) => {
  if (req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        ok: true,
        ready,
        watched: Object.fromEntries(
          Object.entries(previous).map(([name, map]) => [name, map.size]),
        ),
        lastQueueAt,
      }),
    );
    return;
  }
  res.writeHead(404);
  res.end();
});
server.listen(port, () => console.log(`[health] listening on :${port}`));

function shutdown() {
  console.log("Shutting down...");
  clearInterval(queueTimer);
  unsubs.forEach((unsubscribe) => unsubscribe());
  server.close(() => process.exit(0));
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
