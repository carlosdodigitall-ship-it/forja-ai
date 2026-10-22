"use strict";
const { finalizeCredits } = require("./credit-ledger");

// Result is saved before credits are confirmed. A disconnected browser is not
// evidence that generation failed. Recovery requires an explicit terminal state.
function resultRef(db, uid, operationId) {
  if (typeof uid !== "string" || !/^[\w-]{1,128}$/.test(uid) ||
      typeof operationId !== "string" || !/^[\w-]{8,128}$/.test(operationId)) {
    throw Error("Identificador inválido.");
  }
  return db.collection("users").doc(uid).collection("generationResults").doc(operationId);
}
async function saveValidatedResult(db, { uid, operationId, html }) {
  if (typeof html !== "string" || html.length > 900000 ||
      !/<html[\s>]/i.test(html) || !/<\/html\s*>/i.test(html)) {
    throw Error("HTML não validado.");
  }
  const ref = resultRef(db, uid, operationId);
  return db.runTransaction(async tx => {
    const snap = await tx.get(ref);
    if (snap.exists) {
      // Never overwrite a result under the same operation ID.
      if (snap.data().html !== html) throw Error("Resultado conflitante.");
      return { duplicate: true };
    }
    tx.create(ref, { html, status: "validated", createdAt: new Date().toISOString() });
    return { duplicate: false };
  });
}
async function reconcileTerminalOperation(db, { uid, operationId, executionStopped }) {
  if (executionStopped !== true) throw Error("Execução não confirmada como encerrada.");
  const ref = resultRef(db, uid, operationId);
  const snap = await ref.get();
  // If a validated result exists, charge it; otherwise refund only after the
  // worker has independently verified that the generation is no longer active.
  const success = snap.exists && snap.data().status === "validated";
  return finalizeCredits(db, { uid, operationId, outcome: success ? "confirm" : "refund" });
}
module.exports = { resultRef, saveValidatedResult, reconcileTerminalOperation };
