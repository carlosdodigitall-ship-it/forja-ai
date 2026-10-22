"use strict";
const crypto = require("node:crypto");

const JOB_STATES = Object.freeze({ RUNNING: "running", SUCCEEDED: "succeeded", FAILED: "failed" });
function jobRef(db, uid, operationId) {
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(uid) || !/^[a-zA-Z0-9_-]{8,128}$/.test(operationId)) throw Error("Invalid job identity");
  return db.collection("users").doc(uid).collection("generationJobs").doc(operationId);
}
async function createJob(db, { uid, operationId, leaseMs = 300000 }) {
  if (!Number.isSafeInteger(leaseMs) || leaseMs < 30000 || leaseMs > 900000) throw Error("Invalid lease");
  const ref = jobRef(db, uid, operationId);
  const leaseToken = crypto.randomUUID();
  const now = Date.now();
  await db.runTransaction(async tx => {
    const existing = await tx.get(ref);
    if (existing.exists) throw Error("Job already exists");
    tx.create(ref, { status: JOB_STATES.RUNNING, leaseToken, leaseExpiresAt: now + leaseMs, startedAt: now, updatedAt: now });
  });
  return { uid, operationId, leaseToken };
}
async function heartbeatJob(db, job, leaseMs = 300000) {
  if (!Number.isSafeInteger(leaseMs) || leaseMs < 30000 || leaseMs > 900000) throw Error("Invalid lease");
  const ref = jobRef(db, job.uid, job.operationId);
  return db.runTransaction(async tx => {
    const snap = await tx.get(ref);
    const current = snap.exists ? snap.data() : null;
    if (!current || current.leaseToken !== job.leaseToken || current.status !== JOB_STATES.RUNNING) throw Error("Job no longer active");
    const now = Date.now();
    tx.update(ref, { leaseExpiresAt: now + leaseMs, updatedAt: now });
    return { status: JOB_STATES.RUNNING };
  });
}
async function completeJob(db, job, succeeded) {
  const ref = jobRef(db, job.uid, job.operationId);
  return db.runTransaction(async tx => {
    const snap = await tx.get(ref);
    const current = snap.exists ? snap.data() : null;
    if (!current || current.leaseToken !== job.leaseToken) throw Error("Job ownership mismatch");
    const target = succeeded ? JOB_STATES.SUCCEEDED : JOB_STATES.FAILED;
    if (current.status === target) return { status: target, duplicate: true };
    if (current.status !== JOB_STATES.RUNNING) throw Error("Job already finalized");
    tx.update(ref, { status: target, finishedAt: Date.now(), updatedAt: Date.now() });
    return { status: target, duplicate: false };
  });
}
// A lease expiry is a candidate for inspection, NOT proof of termination.
// Do not automatically refund based only on expiry.
async function inspectExpiredJob(db, { uid, operationId, now = Date.now() }) {
  const snap = await jobRef(db, uid, operationId).get();
  if (!snap.exists) return { action: "missing" };
  const data = snap.data();
  if (data.status === JOB_STATES.SUCCEEDED) return { action: "confirm" };
  if (data.status === JOB_STATES.FAILED) return { action: "refund" };
  if (data.status === JOB_STATES.RUNNING && data.leaseExpiresAt <= now) return { action: "manual_review" };
  return { action: "wait" };
}
module.exports = { JOB_STATES, jobRef, createJob, heartbeatJob, completeJob, inspectExpiredJob };
