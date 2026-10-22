"use strict";

// Server-only credit ledger. Not wired to /api/generate until integration tests pass.
// Schema: users/{uid}/billing/wallet { availableCredits, reservedCredits }
//         users/{uid}/creditOperations/{operationId} { amount, status, ... }
// Wallet provisioning / plan renewals must be performed by trusted server code.
const STATES = Object.freeze({ RESERVED: "reserved", CONFIRMED: "confirmed", REFUNDED: "refunded" });

class CreditError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "CreditError";
    this.code = code;
  }
}

function checkInput(uid, operationId, amount) {
  if (typeof uid !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(uid)) {
    throw new CreditError("INVALID_USER", "Usuário inválido.");
  }
  if (typeof operationId !== "string" || !/^[a-zA-Z0-9_-]{8,128}$/.test(operationId)) {
    throw new CreditError("INVALID_OPERATION", "Identificador de operação inválido.");
  }
  if (amount !== undefined && (!Number.isSafeInteger(amount) || amount <= 0 || amount > 1000000)) {
    throw new CreditError("INVALID_AMOUNT", "Quantidade de créditos inválida.");
  }
}

function refs(db, uid, operationId) {
  const user = db.collection("users").doc(uid);
  return { wallet: user.collection("billing").doc("wallet"), operation: user.collection("creditOperations").doc(operationId) };
}

function balance(data) {
  const available = data.availableCredits;
  const reserved = data.reservedCredits;
  if (!Number.isSafeInteger(available) || available < 0 || !Number.isSafeInteger(reserved) || reserved < 0) {
    throw new CreditError("INVALID_WALLET", "Saldo não inicializado ou inconsistente.");
  }
  return { available, reserved };
}

async function reserveCredits(db, { uid, operationId, amount }) {
  checkInput(uid, operationId, amount);
  const { wallet, operation } = refs(db, uid, operationId);
  return db.runTransaction(async tx => {
    // All reads must precede all writes in Firestore transactions.
    const [opSnap, walletSnap] = await Promise.all([tx.get(operation), tx.get(wallet)]);
    if (opSnap.exists) {
      const previous = opSnap.data();
      if (previous.amount !== amount) throw new CreditError("OPERATION_CONFLICT", "Operação já existe com outro valor.");
      return { status: previous.status, duplicate: true };
    }
    if (!walletSnap.exists) throw new CreditError("WALLET_NOT_FOUND", "Carteira não configurada.");
    const { available, reserved } = balance(walletSnap.data());
    if (available < amount) throw new CreditError("INSUFFICIENT_CREDITS", "Créditos insuficientes.");
    tx.update(wallet, { availableCredits: available - amount, reservedCredits: reserved + amount });
    tx.create(operation, { amount, status: STATES.RESERVED, createdAt: new Date().toISOString() });
    return { status: STATES.RESERVED, duplicate: false };
  });
}

async function finalizeCredits(db, { uid, operationId, outcome }) {
  checkInput(uid, operationId);
  if (!["confirm", "refund"].includes(outcome)) throw new CreditError("INVALID_OUTCOME", "Resultado inválido.");
  const { wallet, operation } = refs(db, uid, operationId);
  return db.runTransaction(async tx => {
    const [opSnap, walletSnap] = await Promise.all([tx.get(operation), tx.get(wallet)]);
    if (!opSnap.exists) throw new CreditError("OPERATION_NOT_FOUND", "Reserva inexistente.");
    if (!walletSnap.exists) throw new CreditError("WALLET_NOT_FOUND", "Carteira inexistente.");
    const current = opSnap.data();
    const target = outcome === "confirm" ? STATES.CONFIRMED : STATES.REFUNDED;
    if (current.status === target) return { status: target, duplicate: true };
    if (current.status !== STATES.RESERVED) throw new CreditError("OPERATION_FINALIZED", "Operação já encerrada com outro resultado.");
    const { available, reserved } = balance(walletSnap.data());
    if (!Number.isSafeInteger(current.amount) || current.amount <= 0 || reserved < current.amount) {
      throw new CreditError("INVALID_WALLET", "Reserva inconsistente.");
    }
    tx.update(wallet, {
      availableCredits: outcome === "refund" ? available + current.amount : available,
      reservedCredits: reserved - current.amount
    });
    tx.update(operation, { status: target, finalizedAt: new Date().toISOString() });
    return { status: target, duplicate: false };
  });
}

module.exports = { STATES, CreditError, reserveCredits, finalizeCredits };
