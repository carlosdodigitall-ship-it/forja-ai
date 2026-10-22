"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { reserveCredits, finalizeCredits } = require("../lib/ai/credit-ledger");

function fakeDb(initialAvailable = 10) {
  const data = new Map([["users/u1/billing/wallet", { availableCredits: initialAvailable, reservedCredits: 0 }]]);
  const db = {
    collection(name) { return ref(name); },
    async runTransaction(fn) {
      const changes = [];
      const tx = {
        async get(r) {
          const value = data.get(r.path);
          return { exists: value !== undefined, data: () => value && { ...value } };
        },
        update(r, value) { changes.push(["update", r.path, value]); },
        create(r, value) { changes.push(["create", r.path, value]); }
      };
      const result = await fn(tx);
      for (const [mode, path, value] of changes) {
        if (mode === "create" && data.has(path)) throw Error("duplicate");
        data.set(path, { ...(data.get(path) || {}), ...value });
      }
      return result;
    }
  };
  function ref(path) {
    return { path, doc(id) { return ref(path + "/" + id); }, collection(id) { return ref(path + "/" + id); } };
  }
  return { db, data };
}
const args = { uid: "u1", operationId: "request_0001", amount: 3 };
const walletPath = "users/u1/billing/wallet";

test("reserva e confirma sem cobrar duas vezes", async () => {
  const { db, data } = fakeDb();
  assert.equal((await reserveCredits(db, args)).status, "reserved");
  assert.equal((await reserveCredits(db, args)).duplicate, true);
  assert.deepEqual(data.get(walletPath), { availableCredits: 7, reservedCredits: 3 });
  assert.equal((await finalizeCredits(db, { ...args, outcome: "confirm" })).status, "confirmed");
  assert.equal((await finalizeCredits(db, { ...args, outcome: "confirm" })).duplicate, true);
  assert.deepEqual(data.get(walletPath), { availableCredits: 7, reservedCredits: 0 });
});

test("estorna reserva uma única vez", async () => {
  const { db, data } = fakeDb();
  await reserveCredits(db, args);
  await finalizeCredits(db, { ...args, outcome: "refund" });
  assert.equal((await finalizeCredits(db, { ...args, outcome: "refund" })).duplicate, true);
  assert.deepEqual(data.get(walletPath), { availableCredits: 10, reservedCredits: 0 });
});

test("bloqueia saldo insuficiente", async () => {
  const { db } = fakeDb(2);
  await assert.rejects(reserveCredits(db, args), { code: "INSUFFICIENT_CREDITS" });
});

test("bloqueia reuso do identificador com valor diferente", async () => {
  const { db } = fakeDb();
  await reserveCredits(db, args);
  await assert.rejects(reserveCredits(db, { ...args, amount: 4 }), { code: "OPERATION_CONFLICT" });
});

test("impede confirmar depois de estornar", async () => {
  const { db } = fakeDb();
  await reserveCredits(db, args);
  await finalizeCredits(db, { ...args, outcome: "refund" });
  await assert.rejects(finalizeCredits(db, { ...args, outcome: "confirm" }), { code: "OPERATION_FINALIZED" });
});

test("não inicializa créditos implicitamente", async () => {
  const { db, data } = fakeDb();
  data.delete(walletPath);
  await assert.rejects(reserveCredits(db, args), { code: "WALLET_NOT_FOUND" });
});

test("rejeita valores e identificadores inválidos", async () => {
  const { db } = fakeDb();
  await assert.rejects(reserveCredits(db, { ...args, amount: -1 }), { code: "INVALID_AMOUNT" });
  await assert.rejects(reserveCredits(db, { ...args, operationId: "../escape" }), { code: "INVALID_OPERATION" });
});
