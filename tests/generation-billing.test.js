"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { creditsEnabled, creditsPerGeneration, newOperationId } = require("../lib/ai/generation-billing");
const { saveValidatedResult, reconcileTerminalOperation } = require("../lib/ai/generation-results");

function dbFixture() {
  const data = new Map([["users/u1/billing/wallet", { availableCredits: 5, reservedCredits: 1 }],
    ["users/u1/creditOperations/gen_12345678", { amount: 1, status: "reserved" }]]);
  function ref(path) {
    return { path, doc(x) { return ref(path + "/" + x); }, collection(x) { return ref(path + "/" + x); },
      async get() { return snapshot(path); } };
  }
  function snapshot(path) { return { exists: data.has(path), data: () => ({ ...data.get(path) }) }; }
  const db = { collection: ref, async runTransaction(fn) {
    const writes = [];
    const tx = { get: async r => snapshot(r.path), create: (r,v) => writes.push(["create",r.path,v]),
      update: (r,v) => writes.push(["update",r.path,v]) };
    const result = await fn(tx);
    for (const [type,path,value] of writes) {
      if (type === "create" && data.has(path)) throw Error("duplicate");
      data.set(path, { ...(data.get(path) || {}), ...value });
    }
    return result;
  }};
  return { db, data };
}
const input = { uid: "u1", operationId: "gen_12345678" };
const html = "<!doctype html><html><body>OK</body></html>";

test("flag de cobrança é desligada por padrão", () => {
  const original = process.env.FORJA_CREDITS_V2_ENABLED;
  try {
    delete process.env.FORJA_CREDITS_V2_ENABLED;
    assert.equal(creditsEnabled(), false);
    process.env.FORJA_CREDITS_V2_ENABLED = "true";
    assert.equal(creditsEnabled(), true);
  } finally {
    if (original === undefined) delete process.env.FORJA_CREDITS_V2_ENABLED;
    else process.env.FORJA_CREDITS_V2_ENABLED = original;
  }
});

test("custo é definido e validado no servidor", () => {
  const original = process.env.FORJA_CREDITS_V2_COST;
  try {
    process.env.FORJA_CREDITS_V2_COST = "2";
    assert.equal(creditsPerGeneration(), 2);
    process.env.FORJA_CREDITS_V2_COST = "-4";
    assert.throws(() => creditsPerGeneration());
  } finally {
    if (original === undefined) delete process.env.FORJA_CREDITS_V2_COST;
    else process.env.FORJA_CREDITS_V2_COST = original;
  }
});

test("IDs de operação são exclusivos", () => {
  assert.notEqual(newOperationId(), newOperationId());
});

test("resultado validado persiste e é idempotente", async () => {
  const { db, data } = dbFixture();
  assert.equal((await saveValidatedResult(db, { ...input, html })).duplicate, false);
  assert.equal((await saveValidatedResult(db, { ...input, html })).duplicate, true);
  assert.equal(data.get("users/u1/generationResults/gen_12345678").status, "validated");
  await assert.rejects(saveValidatedResult(db, { ...input, html: "<html>outro</html>" }), /conflitante/);
});

test("não salva resultado incompleto", async () => {
  const { db } = dbFixture();
  await assert.rejects(saveValidatedResult(db, { ...input, html: "<html>incompleto" }), /validado/);
});

test("não reconcilia sem comprovar encerramento", async () => {
  const { db } = dbFixture();
  await assert.rejects(reconcileTerminalOperation(db, { ...input, executionStopped: false }), /encerrada/);
});

test("resultado persistido é confirmado após encerramento", async () => {
  const { db, data } = dbFixture();
  await saveValidatedResult(db, { ...input, html });
  const result = await reconcileTerminalOperation(db, { ...input, executionStopped: true });
  assert.equal(result.status, "confirmed");
  assert.equal(data.get("users/u1/billing/wallet").reservedCredits, 0);
});

test("execução encerrada sem resultado é estornada", async () => {
  const { db, data } = dbFixture();
  const result = await reconcileTerminalOperation(db, { ...input, executionStopped: true });
  assert.equal(result.status, "refunded");
  assert.equal(data.get("users/u1/billing/wallet").availableCredits, 6);
});
