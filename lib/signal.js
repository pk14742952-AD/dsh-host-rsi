// DSH host RSI — signal ladder (pure, no DSH/Node deps; unit-testable).
//
// A captured outcome is assigned a LAYER (provenance) and a trusted flag + weight.
// Only `trusted` lessons are injected. Uncertain / unverified self-judgment goes to
// quarantine and is NOT injected until a stronger signal later confirms it — this is
// what keeps continual self-improvement from drifting into drift.
//
//   L1  real verifiable check (code test / math==expected / SQL match / schema valid).
//       Strongest, fully automatic. A FAILING L1 check is a high-value corrective lesson.
//   L2  self-interrogation (反问): the model counter-reasons its own answer.
//       CONFIRMED -> trusted; REFUTED -> corrective lesson (the model caught its own error).
//   L3  user final tap (对 / 错 / correction). Last-resort authoritative signal.
//   Q   uncertain / unverified self-judgment -> quarantine (trusted=false).

export const LAYERS = Object.freeze({ L1: 'L1', L2: 'L2', L3: 'L3', Q: 'Q' });

// Lower = stronger; used to rank which lessons to prefer when injecting.
export const LAYER_ORDER = Object.freeze({ L1: 0, L3: 1, L2: 2, Q: 9 });

/**
 * Classify a captured outcome into a signal layer.
 *
 * @param {object} p
 * @param {('CONFIRMED'|'REFUTED'|'UNCERTAIN'|string)} [p.verdict]   self-interrogation verdict
 * @param {number|null}  [p.conf]          self-report confidence 0..1 (from the [VERIFY] tag)
 * @param {object}  [p.scorer]            L1 check result: { definitive:bool, passed:bool } when a real check ran
 * @param {object}  [p.userTap]           user final feedback: { verdict: 'CONFIRMED'|'REFUTED'|'UNCERTAIN' }
 * @param {number}  [p.threshold=0.6]     min conf for a self-CONFIRMED to be trusted (else quarantine)
 * @returns {{layer:string, trusted:boolean, weight:number, note:string}}
 */
export function classifySignal({ verdict, conf, scorer, userTap, threshold = 0.6 } = {}) {
  // L1 wins outright when a definitive verifiable check actually ran.
  if (scorer && scorer.definitive) {
    return scorer.passed
      ? { layer: LAYERS.L1, trusted: true, weight: 1.0, note: 'L1 verifiable check passed' }
      : { layer: LAYERS.L1, trusted: true, weight: 1.0, note: 'L1 verifiable check FAILED -> corrective lesson' };
  }

  // L3: an explicit user tap is authoritative (last-resort gate).
  if (userTap && userTap.verdict && userTap.verdict !== 'UNCERTAIN') {
    return {
      layer: LAYERS.L3,
      trusted: userTap.verdict === 'CONFIRMED',
      weight: 1.0,
      note: 'L3 user final tap',
    };
  }

  // L2: self-interrogation verdict.
  if (verdict === 'REFUTED') {
    // The original answer was wrong; the FIX is a high-value recovery lesson.
    return { layer: LAYERS.L2, trusted: true, weight: 0.85, note: 'L2 self-refuted -> corrective lesson' };
  }
  if (verdict === 'CONFIRMED') {
    if (conf == null) return { layer: LAYERS.L2, trusted: true, weight: 0.8, note: 'L2 self-verified (counter-reason confirmed)' };
    const c = Number(conf);
    if (!Number.isFinite(c)) return { layer: LAYERS.L2, trusted: true, weight: 0.8, note: 'L2 self-verified' };
    return c >= threshold
      ? { layer: LAYERS.L2, trusted: true, weight: 0.8, note: `L2 self-verified (conf=${c})` }
      : { layer: LAYERS.Q, trusted: false, weight: 0.3, note: `L2 low conf (${c}) -> quarantine pending` };
  }

  // UNCERTAIN or no verdict -> quarantine.
  return { layer: LAYERS.Q, trusted: false, weight: 0.3, note: 'uncertain/unverified -> quarantine' };
}

/** Whether a classified outcome should be injected now. */
export function isInjectable(c) {
  return !!(c && c.trusted);
}

/** Whether a classified outcome should be quarantined (kept but not injected). */
export function isQuarantined(c) {
  return !!(c && !c.trusted);
}
