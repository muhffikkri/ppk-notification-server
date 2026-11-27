import assert from "node:assert/strict";
import { test } from "node:test";
import {
  fineCreatedEvents,
  inboxEntries,
  leaveEvents,
  paymentEvents,
  pushMessage,
  sessionCreatedEvents,
  sessionEvents,
} from "../src/pushEvents.js";

const now = new Date("2026-11-27T01:00:00.000Z");

test("sessionCreatedEvents hanya untuk sesi scheduled dan peserta unik", () => {
  const session = {
    status: "scheduled",
    participantIds: ["student1", "student1", "student2", "bad/id", null],
  };
  assert.deepEqual(sessionCreatedEvents(session, "s1"), [
    {
      type: "session_scheduled",
      sessionId: "s1",
      recipients: ["student1", "student2"],
    },
  ]);
  assert.deepEqual(
    sessionCreatedEvents({ ...session, status: "open" }, "s1"),
    [],
  );
});

test("sessionEvents mendeteksi sesi dibuka dan perubahan jadwal", () => {
  const before = {
    status: "scheduled",
    startsAt: "2026-11-20T01:00:00Z",
    participantIds: ["student1"],
  };
  assert.deepEqual(sessionEvents(before, { ...before, status: "open" }, "s1"), [
    {
      type: "session_opened",
      sessionId: "s1",
      recipients: ["student1"],
    },
  ]);
  assert.deepEqual(sessionEvents(before, { ...before, lab: "Lab A" }, "s1"), [
    {
      type: "schedule_changed",
      sessionId: "s1",
      recipients: ["student1"],
    },
  ]);
  assert.deepEqual(
    sessionEvents(before, { ...before, status: "closed" }, "s1"),
    [],
  );
});

test("leaveEvents hanya untuk keputusan pending -> approved/rejected", () => {
  const before = { status: "pending", studentId: "student1" };
  assert.deepEqual(
    leaveEvents(before, { ...before, status: "approved" }, "l1"),
    [{ type: "leave_decided", leaveId: "l1", recipients: ["student1"] }],
  );
  assert.deepEqual(
    leaveEvents(before, { ...before, status: "pending" }, "l1"),
    [],
  );
});

test("fineCreatedEvents hanya untuk denda unpaid milik praktikan", () => {
  assert.deepEqual(
    fineCreatedEvents(
      { status: "unpaid", studentId: "student1", amount: 25000 },
      "f1",
    ),
    [{ type: "fine_issued", fineId: "f1", recipients: ["student1"] }],
  );
  assert.deepEqual(
    fineCreatedEvents({ status: "paid", studentId: "student1" }, "f1"),
    [],
  );
});

test("paymentEvents hanya untuk perubahan status success/failed", () => {
  const after = {
    status: "success",
    studentId: "student1",
    fineId: "f1",
  };
  assert.deepEqual(paymentEvents({ ...after, status: "pending" }, after), [
    {
      type: "payment_success",
      fineId: "f1",
      recipients: ["student1"],
    },
  ]);
  assert.deepEqual(paymentEvents(after, { ...after, status: "failed" }), [
    { type: "payment_failed", fineId: "f1", recipients: ["student1"] },
  ]);
  assert.deepEqual(paymentEvents(after, after), []);
});

test("inboxEntries memakai ID deterministik dan isi lengkap per event", () => {
  const notices = [
    {
      type: "fine_issued",
      fineId: "f1",
      recipients: ["student1", "student1"],
    },
  ];
  const source = {
    studentId: "student1",
    status: "unpaid",
    amount: 25000,
    courseName: "Praktikum",
  };
  const first = inboxEntries("event-1", notices, source, now);
  const second = inboxEntries("event-1", notices, source, now);

  assert.equal(first.length, 1);
  assert.equal(first[0].id, second[0].id);
  assert.match(first[0].id, /^[a-f0-9]{40}$/);
  assert.equal(first[0].uid, "student1");
  assert.equal(first[0].data.type, "fine_issued");
  assert.equal(first[0].data.fineId, "f1");
  assert.equal(first[0].data.title, "Tagihan denda baru");
  assert.match(first[0].data.body, /Rp 25\.000/);
  assert.equal(first[0].data.createdAt, now.toISOString());
  assert.equal(first[0].data.readAt, null);
});

test("pushMessage membawa ttl, notificationId, dan target navigasi", () => {
  const message = pushMessage(
    {
      type: "payment_success",
      uid: "student1",
      fineId: "f1",
      notificationId: "notif-1",
      title: "Pembayaran denda berhasil",
      body: "Lunas.",
      sendUntil: Date.now() + 60_000,
    },
    "ExpoPushToken[abc]",
  );
  assert.equal(message.title, "Pembayaran denda berhasil");
  assert.equal(message.body, "Lunas.");
  assert.equal(message.channelId, "practicum");
  assert.ok(message.ttl >= 1);
  assert.deepEqual(message.data, {
    recipientUid: "student1",
    type: "payment_success",
    fineId: "f1",
    notificationId: "notif-1",
  });
});
