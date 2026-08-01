/* ========================================
   Wink Detection - Pure logic (testable)

   Consumes per-eye "closedness" scores (0 = fully open, 1 = fully
   closed), e.g. MediaPipe FaceLandmarker's eyeBlinkLeft/eyeBlinkRight
   blendshapes, and decides when a deliberate one-eyed wink happened.

   Design goals, in priority order:
   1. Never fire on a blink (both eyes closing together).
   2. Never fire twice for one wink (cooldown + must-reopen).
   3. Fire reliably on a held, deliberate wink.
   ======================================== */

const WINK_CONFIG = {
  CLOSED_MIN: 0.55,     // score above this = eye considered closed
  OPEN_MAX: 0.35,       // other eye must stay below this = clearly open
  HOLD_MS: 400,         // wink must be held this long before firing
  BLINK_GUARD_MS: 300,  // after a blink, ignore wink candidates this long
  COOLDOWN_MS: 1200,    // after firing, ignore all gestures this long
  GRACE_MS: 120,        // tolerated dropout within a held wink (noisy frames)
};

function createWinkState() {
  return {
    candidateEye: null,   // 'left' | 'right' | null (channel currently held closed)
    candidateStart: 0,    // when the current candidate began
    lastValidTime: 0,     // last frame that satisfied the candidate condition
    blinkGuardUntil: 0,   // ignore candidates until this time (blink suppression)
    cooldownUntil: 0,     // ignore everything until this time (post-fire)
    needReopen: false,    // after firing, both eyes must open before a new candidate
  };
}

/**
 * Process one frame of per-eye closedness scores.
 *
 * @param {number|null} left - closedness of the LEFT channel (0..1)
 * @param {number|null} right - closedness of the RIGHT channel (0..1)
 * @param {number} now - timestamp in ms (passed in for testability)
 * @param {object} state - state from createWinkState() / previous call
 * @param {object} [config] - thresholds (defaults to WINK_CONFIG)
 * @returns {{ action: 'left'|'right'|null, state: object }}
 *   action names the CHANNEL that winked ('left'/'right' in the score
 *   provider's frame of reference); the app maps channels to page
 *   directions via calibration.
 */
function processWink(left, right, now, state, config) {
  config = config || WINK_CONFIG;

  // No face / missing scores: drop any candidate, keep timers.
  if (left === null || left === undefined || right === null || right === undefined) {
    return { action: null, state: clearCandidate(state) };
  }

  const leftClosed = left > config.CLOSED_MIN;
  const rightClosed = right > config.CLOSED_MIN;
  const leftOpen = left < config.OPEN_MAX;
  const rightOpen = right < config.OPEN_MAX;

  let next = state;

  // Both eyes closed = blink. Cancel any in-progress candidate and
  // suppress new candidates briefly (eyes often reopen asymmetrically,
  // which would otherwise look like a short wink).
  if (leftClosed && rightClosed) {
    next = clearCandidate(next);
    next = withChanges(next, { blinkGuardUntil: now + config.BLINK_GUARD_MS });
    return { action: null, state: next };
  }

  // Both eyes clearly open: the post-fire reopen requirement is satisfied.
  if (leftOpen && rightOpen) {
    if (next.needReopen || next.candidateEye !== null) {
      next = withChanges(clearCandidate(next), { needReopen: false });
    }
    return { action: null, state: next };
  }

  // Gated: cooling down after a fire, waiting for reopen, or inside the
  // post-blink guard window. No candidate may accrue.
  if (now < next.cooldownUntil || next.needReopen || now < next.blinkGuardUntil) {
    return { action: null, state: clearCandidate(next) };
  }

  // A valid wink posture: exactly one eye closed, the other clearly open.
  const winkEye = leftClosed && rightOpen ? 'left' : rightClosed && leftOpen ? 'right' : null;

  if (winkEye) {
    if (next.candidateEye !== winkEye) {
      // New candidate (or the held eye switched - restart the clock).
      next = withChanges(next, { candidateEye: winkEye, candidateStart: now, lastValidTime: now });
    } else {
      next = withChanges(next, { lastValidTime: now });
    }

    if (now - next.candidateStart >= config.HOLD_MS) {
      next = withChanges(clearCandidate(next), {
        cooldownUntil: now + config.COOLDOWN_MS,
        needReopen: true,
      });
      return { action: winkEye, state: next };
    }
    return { action: null, state: next };
  }

  // Ambiguous frame (e.g. one eye half-closed): tolerate brief dropouts
  // inside a held wink, otherwise drop the candidate.
  if (next.candidateEye !== null && now - next.lastValidTime > config.GRACE_MS) {
    next = clearCandidate(next);
  }
  return { action: null, state: next };
}

/**
 * Fraction of the hold completed for the current candidate (0..1).
 * Used by the UI to show a "charging" indicator while a wink is held.
 */
function winkProgress(state, now, config) {
  config = config || WINK_CONFIG;
  if (state.candidateEye === null) return 0;
  return Math.min(1, (now - state.candidateStart) / config.HOLD_MS);
}

function clearCandidate(state) {
  if (state.candidateEye === null) return state;
  return withChanges(state, { candidateEye: null, candidateStart: 0, lastValidTime: 0 });
}

function withChanges(state, changes) {
  return Object.assign({}, state, changes);
}

// Export for Node.js testing, or attach to window for browser
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { processWink, createWinkState, winkProgress, WINK_CONFIG };
} else if (typeof window !== 'undefined') {
  window.Wink = { processWink, createWinkState, winkProgress, WINK_CONFIG };
}
