"use strict";
const crypto = require("node:crypto");
const { reserveCredits, finalizeCredits } = require("./credit-ledger");

// Feature flag is server-side only; default is disabled.
// No client-supplied cost, UID or operation identifier is trusted.
function creditsEnabled() {
  return process.env.FORJA_CREDITS_V2_ENABLED === "true";
}
function creditsPerGeneration() {
  const raw = process.env.FORJA_CREDITS_V2_COST || "1";
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1 || value > 1000) {
    throw Error("FORJA_CREDITS_V2_COST inválido.");
  }
  return value;
}
function newOperationId() {
  return "gen_" + crypto.randomUUID().replace(/-/g, "");
}
async function beginGeneration(db, uid) {
  const operationId = newOperationId();
  await reserveCredits(db, { uid, operationId, amount: creditsPerGeneration() });
  return { uid, operationId };
}
async function finishGeneration(db, reservation, success) {
  if (!reservation) return;
  return finalizeCredits(db, {
    uid: reservation.uid,
    operationId: reservation.operationId,
    outcome: success ? "confirm" : "refund"
  });
}
module.exports = { creditsEnabled, creditsPerGeneration, newOperationId, beginGeneration, finishGeneration };
