"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { createJob, heartbeatJob, completeJob, inspectExpiredJob } = require("../lib/ai/generation-jobs");

function fixture() {
  const data = new Map();
  const ref = path => ({ path, collection(x) { return ref(path + "/" + x); }, doc(x) { return ref(path + "/" + x); }, async get() { return snapshot(path); } });
  const snapshot = path => ({ exists: data.has(path), data: () => ({ ...data.get(path) }) });
  const db = { collection: ref, async runTransaction(callback) {
    const writes = [];
    const tx = { get: async r => snapshot(r.path), create: (r, v) => writes.push(["create",r.path,v]), update: (r,v) => writes.push(["update",r.path,v]) };
    const result = await callback(tx);
    for (const [mode,path,values] of writes) {
      if (mode === "create" && data.has(path)) throw Error("duplicate");
      data.set(path, { ...(data.get(path) || {}), ...values });
    }
    return result;
  }};
  return { db, data };
}
const identity = { uid: "user1", operationId: "gen_123456789" };

test("cria job com lease e token de posse", async () => {
  const { db } = fixture();
  const job = await createJob(db, identity);
  assert.ok(job.leaseToken);
  assert.deepEqual(await inspectExpiredJob(db, identity), { action: "wait" });
  await assert.rejects(createJob(db, identity), /already exists/);
});

test("heartbeat exige token correto", async () => {
  const { db } = fixture();
  const job = await createJob(db, identity);
  await assert.rejects(heartbeatJob(db, { ...job, leaseToken: "other" }), /no longer active/);
  assert.equal((await heartbeatJob(db, job)).status, "running");
});

test("finalização é idempotente e não permite mudança de resultado", async () => {
  const { db } = fixture();
  const job = await createJob(db, identity);
  assert.equal((await completeJob(db, job, true)).status, "succeeded");
  assert.equal((await completeJob(db, job, true)).duplicate, true);
  await assert.rejects(completeJob(db, job, false), /already finalized/);
  assert.deepEqual(await inspectExpiredJob(db, identity), { action: "confirm" });
});

test("falha terminal permite estorno", async () => {
  const { db } = fixture();
  const job = await createJob(db, identity);
  await completeJob(db, job, false);
  assert.deepEqual(await inspectExpiredJob(db, identity), { action: "refund" });
});

test("lease expirado não autoriza estorno automático", async () => {
  const { db, data } = fixture();
  await createJob(db, identity);
  const path = "users/user1/generationJobs/gen_123456789";
  data.get(path).leaseExpiresAt = Date.now() - 1;
  assert.deepEqual(await inspectExpiredJob(db, identity), { action: "manual_review" });
});
