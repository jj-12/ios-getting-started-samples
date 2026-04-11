/* ========================================
   Tilt Detection - Pure logic (testable)
   ======================================== */

const TILT_CONFIG = {
  CORRECT_MIN: 120,   // beta above this = tilted forward/down = CORRECT
  PASS_MAX: 55,       // beta below this = tilted back/up = PASS
  NEUTRAL_MIN: 65,    // neutral zone lower bound
  NEUTRAL_MAX: 115,   // neutral zone upper bound
  DEBOUNCE_MS: 500,   // minimum ms between gestures
};

/**
 * Convert raw beta/gamma into an effective tilt value that works regardless
 * of whether the device is in portrait or landscape.
 *
 * In portrait: beta directly measures the nod gesture (90 = vertical).
 * In landscape: the nod gesture maps to gamma instead. We convert gamma
 * into a beta-equivalent value so processTilt thresholds work the same.
 *
 * @param {number|null} beta - Raw device beta (-180 to 180)
 * @param {number|null} gamma - Raw device gamma (-90 to 90)
 * @param {number} orientationAngle - Screen orientation angle (0, 90, -90, 180, 270)
 * @returns {number|null} Normalized tilt value (90 = vertical on forehead)
 */
function getEffectiveTilt(beta, gamma, orientationAngle) {
  if (beta === null || beta === undefined) return null;
  if (gamma === null || gamma === undefined) gamma = 0;

  // Normalize orientation angle
  const angle = ((orientationAngle % 360) + 360) % 360;

  if (angle === 90) {
    // Landscape: device rotated clockwise (right side up)
    // gamma = 0 when vertical, positive when tilted forward
    return 90 + gamma;
  } else if (angle === 270) {
    // Landscape: device rotated counter-clockwise (left side up)
    // gamma = 0 when vertical, negative when tilted forward
    return 90 - gamma;
  }

  // Portrait (0 or 180): beta works directly
  return beta;
}

/**
 * Process a device orientation event and determine if a gesture occurred.
 *
 * @param {number|null} beta - The device beta angle (front-to-back tilt, -180 to 180)
 * @param {number} now - Current timestamp in ms (passed in for testability)
 * @param {object} state - Current tilt state { lastGestureTime, waitingForNeutral }
 * @param {object} config - Tilt thresholds (defaults to TILT_CONFIG)
 * @returns {{ action: string|null, state: object }}
 *   action is 'correct', 'pass', or null (no gesture detected)
 *   state is the updated tilt state to carry forward
 */
function processTilt(beta, now, state, config) {
  config = config || TILT_CONFIG;

  // Ignore null beta (sensor not ready)
  if (beta === null || beta === undefined) {
    return { action: null, state: state };
  }

  // Debounce: ignore if too soon after last gesture
  if (now - state.lastGestureTime < config.DEBOUNCE_MS) {
    return { action: null, state: state };
  }

  // If waiting for neutral, check if we've returned to neutral position
  if (state.waitingForNeutral) {
    if (beta > config.NEUTRAL_MIN && beta < config.NEUTRAL_MAX) {
      return { action: null, state: { lastGestureTime: state.lastGestureTime, waitingForNeutral: false } };
    }
    return { action: null, state: state };
  }

  // Check for CORRECT gesture: tilted forward/down (beta rises above threshold)
  if (beta > config.CORRECT_MIN) {
    return {
      action: 'correct',
      state: { lastGestureTime: now, waitingForNeutral: true }
    };
  }

  // Check for PASS gesture: tilted back/up (beta drops below threshold)
  if (beta > 0 && beta < config.PASS_MAX) {
    return {
      action: 'pass',
      state: { lastGestureTime: now, waitingForNeutral: true }
    };
  }

  // In neutral zone or negative beta - no action
  return { action: null, state: state };
}

// Export for Node.js testing, or attach to window for browser
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { processTilt, getEffectiveTilt, TILT_CONFIG };
}
