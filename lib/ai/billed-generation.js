"use strict";
const { beginGeneration, finishGeneration } = require("./generation-billing");
const { createJob, completeJob } = require("./generation-jobs");
const { saveValidatedResult } = require("./generation-results");

// Server-only coordinator. The caller MUST verify Firebase identity and
// persist the completed result before signaling success to the browser.
async function executeBilledGeneration({ db, uid, generate }) {
  if (!db || typeof generate !== "function") throw Error("Invalid generation configuration");
  const reservation = await beginGeneration(db, uid);
  let job;
  try {
    job = await createJob(db, reservation);
    const html = await generate({ operationId: reservation.operationId, job });
    await saveValidatedResult(db, { ...reservation, html });
    await completeJob(db, job, true);
    await finishGeneration(db, reservation, true);
    return { html, operationId: reservation.operationId };
  } catch (error) {
    // Once the result is saved or a job is marked successful, do NOT refund:
    // a crash between persistence and confirmation requires reconciliation.
    if (job) {
      try {
        const snap = await db.collection("users").doc(uid).collection("generationResults").doc(reservation.operationId).get();
        if (snap.exists) throw error;
        await completeJob(db, job, false);
        await finishGeneration(db, reservation, false);
      } catch (recoveryError) {
        error.recoveryPending = true;
      }
    } else {
      try { await finishGeneration(db, reservation, false); }
      catch (_) { error.recoveryPending = true; }
    }
    throw error;
  }
}
module.exports = { executeBilledGeneration };
