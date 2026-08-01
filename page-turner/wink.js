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

// CLOSED_MIN / OPEN_MAX may be a single number for both eyes, or a
// per-channel object {left, right}. Per-channel thresholds matter when the
// camera views the face at an angle: the far eye's blendshape scores are
// compressed (its winks peak lower, its resting score sits higher), so one
// fixed threshold makes only the near eye's winks register.
function channelThreshold(t, channel) {
  return typeof t === 'number' ? t : t[channel];
}

const GAZE_CONFIG = {
  TOLERANCE: 0.45,   // max weighted distance from the calibrated baseline
  HEAD_WEIGHT: 1.6,  // head direction counts more than eyeball direction
  GAZE_WEIGHT: 1.0,
  RECENT_MS: 300,    // gaze must have been on target this recently for a wink to start
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
 * @param {boolean} [gateOk] - external gate (e.g. "user is looking at the
 *   camera"). When false, NEW wink candidates may not start; a wink already
 *   in progress keeps accruing, because closing one eye corrupts the gaze
 *   estimate and must not cancel a legitimate turn. Defaults to true.
 * @returns {{ action: 'left'|'right'|null, state: object }}
 *   action names the CHANNEL that winked ('left'/'right' in the score
 *   provider's frame of reference); the app maps channels to page
 *   directions via calibration.
 */
function processWink(left, right, now, state, config, gateOk) {
  config = config || WINK_CONFIG;
  if (gateOk === undefined) gateOk = true;

  // No face / missing scores: drop any candidate, keep timers.
  if (left === null || left === undefined || right === null || right === undefined) {
    return { action: null, state: clearCandidate(state) };
  }

  const leftClosed = left > channelThreshold(config.CLOSED_MIN, 'left');
  const rightClosed = right > channelThreshold(config.CLOSED_MIN, 'right');
  const leftOpen = left < channelThreshold(config.OPEN_MAX, 'left');
  const rightOpen = right < channelThreshold(config.OPEN_MAX, 'right');

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
      // Starting a new candidate (or the held eye switched) requires the
      // external gate to be open right now.
      if (!gateOk) {
        return { action: null, state: clearCandidate(next) };
      }
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

/* ============ Calibration capture ============

   During calibration we cannot rely on the fixed live thresholds - at an
   oblique camera angle the far eye may never cross them (the very problem
   calibration is there to fix). Instead, capture judges a wink RELATIVE to
   each eye's measured open baseline: one channel rises well above its own
   baseline while the other stays near its own, held briefly. The peak
   score reached feeds deriveEyeThresholds() below.
   */

const CAPTURE_CONFIG = {
  RISE_MIN: 0.18,        // winked eye must rise this far above its baseline
  OTHER_RISE_MAX: 0.10,  // other eye must stay this close to its baseline
  HOLD_MS: 500,
};

function createCaptureState() {
  return { eye: null, start: 0, peak: 0 };
}

/**
 * Process one frame of a calibration wink capture.
 *
 * @param {number|null} left/right - closedness scores this frame
 * @param {number} now - timestamp ms
 * @param {object} state - from createCaptureState()
 * @param {object} baseline - {left, right} open-eye baseline scores
 * @param {object} [config] - defaults to CAPTURE_CONFIG
 * @returns {{ captured: {eye:'left'|'right', peak:number}|null, state }}
 */
function processCapture(left, right, now, state, baseline, config) {
  config = config || CAPTURE_CONFIG;
  if (left === null || left === undefined || right === null || right === undefined) {
    return { captured: null, state: createCaptureState() };
  }

  const riseL = left - baseline.left;
  const riseR = right - baseline.right;
  let eye = null;
  if (riseL > config.RISE_MIN && riseR < config.OTHER_RISE_MAX) eye = 'left';
  else if (riseR > config.RISE_MIN && riseL < config.OTHER_RISE_MAX) eye = 'right';

  if (!eye) return { captured: null, state: createCaptureState() };

  let next = state;
  if (next.eye !== eye) {
    next = { eye, start: now, peak: 0 };
  }
  next = { eye: next.eye, start: next.start, peak: Math.max(next.peak, eye === 'left' ? left : right) };

  if (now - next.start >= config.HOLD_MS) {
    return { captured: { eye: next.eye, peak: next.peak }, state: createCaptureState() };
  }
  return { captured: null, state: next };
}

/** Hold progress of the current capture candidate (0..1). */
function captureProgress(state, now, config) {
  config = config || CAPTURE_CONFIG;
  if (state.eye === null) return 0;
  return Math.min(1, (now - state.start) / config.HOLD_MS);
}

/**
 * Turn measured open baselines + wink peaks into per-channel live
 * thresholds. Each eye's "closed" bar sits a fraction of the way between
 * its own baseline and its own wink peak, so an eye the camera sees at an
 * angle (low peak, high baseline) gets a proportionally easier bar.
 *
 * @param {object} baseline - {left, right} open-eye scores
 * @param {object} peaks - {left, right} wink peak scores
 * @returns {{ closedMin: {left,right}, openMax: {left,right} }}
 */
function deriveEyeThresholds(baseline, peaks) {
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const closedMin = {};
  const openMax = {};
  for (const chan of ['left', 'right']) {
    const base = baseline[chan];
    const peak = Math.max(peaks[chan], base + 0.2); // guard degenerate capture
    closedMin[chan] = clamp(base + (peak - base) * 0.55, 0.25, 0.75);
    openMax[chan] = clamp(base + 0.12, 0.15, closedMin[chan] - 0.05);
  }
  return { closedMin, openMax };
}

/* ============ Gaze gating ============

   "Looking at the camera" is judged as a distance from a calibrated
   baseline in a small feature space combining head direction and eyeball
   direction. Using distance-from-baseline (instead of absolute angles)
   sidesteps camera mounting angle, mirroring, and blendshape sign
   conventions entirely - the calibration step defines what "at the
   camera" looks like for this user and this music stand.
   */

/**
 * Build gaze features from eye-gaze blendshape scores and an optional
 * facial transformation matrix.
 *
 * @param {object} eyeLook - scores 0..1:
 *   { upLeft, upRight, downLeft, downRight, inLeft, inRight, outLeft, outRight }
 * @param {ArrayLike|null} matrix - 16-element column-major facial
 *   transformation matrix (its third column is the face's forward axis);
 *   pass null if unavailable and head direction is treated as neutral.
 * @returns {{ nx: number, ny: number, h: number, v: number }}
 */
function gazeFeatures(eyeLook, matrix) {
  const v = (eyeLook.upLeft + eyeLook.upRight - eyeLook.downLeft - eyeLook.downRight) / 2;
  const h = (eyeLook.inLeft + eyeLook.outRight - eyeLook.outLeft - eyeLook.inRight) / 2;
  let nx = 0;
  let ny = 0;
  if (matrix && matrix.length === 16) {
    nx = matrix[8];
    ny = matrix[9];
  }
  return { nx, ny, h, v };
}

/** Weighted distance between a gaze feature vector and a baseline. */
function gazeDistance(f, baseline, config) {
  config = config || GAZE_CONFIG;
  const dnx = (f.nx - baseline.nx) * config.HEAD_WEIGHT;
  const dny = (f.ny - baseline.ny) * config.HEAD_WEIGHT;
  const dh = (f.h - baseline.h) * config.GAZE_WEIGHT;
  const dv = (f.v - baseline.v) * config.GAZE_WEIGHT;
  return Math.sqrt(dnx * dnx + dny * dny + dh * dh + dv * dv);
}

/** True when the gaze features are close enough to the baseline. */
function isGazeOnTarget(f, baseline, config) {
  config = config || GAZE_CONFIG;
  return gazeDistance(f, baseline, config) <= config.TOLERANCE;
}

function clearCandidate(state) {
  if (state.candidateEye === null) return state;
  return withChanges(state, { candidateEye: null, candidateStart: 0, lastValidTime: 0 });
}

function withChanges(state, changes) {
  return Object.assign({}, state, changes);
}

// Export for Node.js testing, or attach to window for browser
const WinkExports = {
  processWink,
  createWinkState,
  winkProgress,
  channelThreshold,
  processCapture,
  createCaptureState,
  captureProgress,
  deriveEyeThresholds,
  gazeFeatures,
  gazeDistance,
  isGazeOnTarget,
  WINK_CONFIG,
  GAZE_CONFIG,
  CAPTURE_CONFIG,
};
if (typeof module !== 'undefined' && module.exports) {
  module.exports = WinkExports;
} else if (typeof window !== 'undefined') {
  window.Wink = WinkExports;
}
