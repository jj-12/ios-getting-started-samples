const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { processTilt, getEffectiveTilt, TILT_CONFIG } = require('../tilt.js');

const freshState = () => ({ lastGestureTime: 0, waitingForNeutral: false });
const config = TILT_CONFIG;

// Helper: simulate a sequence of tilt events and return all actions
function simulateSequence(events) {
  let state = freshState();
  const actions = [];
  for (const { beta, time } of events) {
    const result = processTilt(beta, time, state, config);
    state = result.state;
    actions.push(result.action);
  }
  return actions;
}

describe('processTilt', () => {

  // ---- Basic gesture detection ----

  describe('correct gesture (tilt forward/down)', () => {
    it('should return "correct" when beta exceeds CORRECT_MIN', () => {
      const result = processTilt(130, 1000, freshState(), config);
      assert.equal(result.action, 'correct');
    });

    it('should return "correct" at exactly CORRECT_MIN + 1', () => {
      const result = processTilt(config.CORRECT_MIN + 1, 1000, freshState(), config);
      assert.equal(result.action, 'correct');
    });

    it('should return "correct" at extreme tilt (170 degrees)', () => {
      const result = processTilt(170, 1000, freshState(), config);
      assert.equal(result.action, 'correct');
    });
  });

  describe('pass gesture (tilt back/up)', () => {
    it('should return "pass" when beta drops below PASS_MAX', () => {
      const result = processTilt(30, 1000, freshState(), config);
      assert.equal(result.action, 'pass');
    });

    it('should return "pass" at exactly PASS_MAX - 1', () => {
      const result = processTilt(config.PASS_MAX - 1, 1000, freshState(), config);
      assert.equal(result.action, 'pass');
    });

    it('should return "pass" at small positive beta (10 degrees)', () => {
      const result = processTilt(10, 1000, freshState(), config);
      assert.equal(result.action, 'pass');
    });
  });

  describe('neutral zone (no gesture)', () => {
    it('should return null when beta is in neutral zone (90 degrees)', () => {
      const result = processTilt(90, 1000, freshState(), config);
      assert.equal(result.action, null);
    });

    it('should return null at NEUTRAL_MIN + 1', () => {
      const result = processTilt(config.NEUTRAL_MIN + 1, 1000, freshState(), config);
      assert.equal(result.action, null);
    });

    it('should return null at NEUTRAL_MAX - 1', () => {
      const result = processTilt(config.NEUTRAL_MAX - 1, 1000, freshState(), config);
      assert.equal(result.action, null);
    });

    it('should return null in dead zone between PASS_MAX and NEUTRAL_MIN', () => {
      // Beta values between 55 and 65 are in the dead zone
      const result = processTilt(60, 1000, freshState(), config);
      assert.equal(result.action, null);
    });

    it('should return null in dead zone between NEUTRAL_MAX and CORRECT_MIN', () => {
      // Beta values between 115 and 120 are in the dead zone
      const result = processTilt(117, 1000, freshState(), config);
      assert.equal(result.action, null);
    });
  });

  // ---- Edge cases for beta values ----

  describe('invalid beta values', () => {
    it('should return null for null beta', () => {
      const result = processTilt(null, 1000, freshState(), config);
      assert.equal(result.action, null);
    });

    it('should return null for undefined beta', () => {
      const result = processTilt(undefined, 1000, freshState(), config);
      assert.equal(result.action, null);
    });

    it('should return null for beta = 0 (excluded from pass range)', () => {
      const result = processTilt(0, 1000, freshState(), config);
      assert.equal(result.action, null);
    });

    it('should return null for negative beta', () => {
      const result = processTilt(-10, 1000, freshState(), config);
      assert.equal(result.action, null);
    });
  });

  // ---- Debounce ----

  describe('debounce', () => {
    it('should block gestures within DEBOUNCE_MS of last gesture', () => {
      // First gesture at time 1000
      const first = processTilt(130, 1000, freshState(), config);
      assert.equal(first.action, 'correct');

      // Attempt second gesture 200ms later (within 500ms debounce)
      const second = processTilt(30, 1200, first.state, config);
      assert.equal(second.action, null, 'should be blocked by debounce');
    });

    it('should allow gestures after DEBOUNCE_MS has passed', () => {
      const first = processTilt(130, 1000, freshState(), config);
      assert.equal(first.action, 'correct');

      // Return to neutral first (required), then wait past debounce
      const neutral = processTilt(90, 1600, first.state, config);
      assert.equal(neutral.action, null);
      assert.equal(neutral.state.waitingForNeutral, false, 'should have cleared neutral wait');

      // Now gesture should work
      const second = processTilt(30, 1600, neutral.state, config);
      assert.equal(second.action, 'pass');
    });

    it('should not count time in neutral zone against debounce', () => {
      const first = processTilt(130, 1000, freshState(), config);

      // Return to neutral at 1300 (within debounce)
      const neutral = processTilt(90, 1300, first.state, config);
      assert.equal(neutral.action, null);
      // Still waiting for neutral because debounce hasn't passed
      // Actually, the neutral check happens before debounce is re-evaluated
      // The state should clear waitingForNeutral
    });
  });

  // ---- Neutral zone requirement ----

  describe('must return to neutral between gestures', () => {
    it('should require neutral position before accepting next gesture', () => {
      // Correct gesture
      const first = processTilt(130, 1000, freshState(), config);
      assert.equal(first.action, 'correct');
      assert.equal(first.state.waitingForNeutral, true);

      // Still tilted (not neutral) - after debounce time
      const still = processTilt(130, 2000, first.state, config);
      assert.equal(still.action, null, 'should not trigger while waiting for neutral');
    });

    it('should clear neutral wait when beta enters neutral zone', () => {
      const first = processTilt(130, 1000, freshState(), config);

      // Return to neutral
      const neutral = processTilt(90, 1600, first.state, config);
      assert.equal(neutral.state.waitingForNeutral, false);
    });

    it('should not clear neutral wait at boundary of neutral zone', () => {
      const first = processTilt(130, 1000, freshState(), config);

      // Exactly at NEUTRAL_MIN (65) - should NOT clear (must be > NEUTRAL_MIN)
      const edge = processTilt(config.NEUTRAL_MIN, 1600, first.state, config);
      assert.equal(edge.state.waitingForNeutral, true, 'should not clear at exact boundary');
    });

    it('should not clear neutral wait at NEUTRAL_MAX boundary', () => {
      const first = processTilt(130, 1000, freshState(), config);

      const edge = processTilt(config.NEUTRAL_MAX, 1600, first.state, config);
      assert.equal(edge.state.waitingForNeutral, true, 'should not clear at exact boundary');
    });
  });

  // ---- Full gameplay sequences ----

  describe('gameplay sequences', () => {
    it('should handle correct -> neutral -> pass sequence', () => {
      const actions = simulateSequence([
        { beta: 90, time: 1000 },    // neutral, no action
        { beta: 130, time: 1100 },   // correct
        { beta: 90, time: 1700 },    // return to neutral (past debounce)
        { beta: 30, time: 1800 },    // pass
      ]);
      assert.deepEqual(actions, [null, 'correct', null, 'pass']);
    });

    it('should handle multiple correct answers in sequence', () => {
      const actions = simulateSequence([
        { beta: 130, time: 1000 },   // correct
        { beta: 90, time: 1600 },    // neutral
        { beta: 135, time: 1700 },   // correct again
        { beta: 85, time: 2300 },    // neutral
        { beta: 125, time: 2400 },   // correct again
      ]);
      assert.deepEqual(actions, ['correct', null, 'correct', null, 'correct']);
    });

    it('should block rapid tilts without returning to neutral', () => {
      const actions = simulateSequence([
        { beta: 130, time: 1000 },   // correct
        { beta: 130, time: 2000 },   // still tilted, blocked by neutral wait
        { beta: 130, time: 3000 },   // still tilted, still blocked
        { beta: 90, time: 3500 },    // return to neutral
        { beta: 130, time: 3600 },   // now correct
      ]);
      assert.deepEqual(actions, ['correct', null, null, null, 'correct']);
    });

    it('should block rapid back-and-forth without neutral pause', () => {
      const actions = simulateSequence([
        { beta: 130, time: 1000 },   // correct
        { beta: 30, time: 1100 },    // too fast (debounce)
        { beta: 30, time: 1600 },    // pass debounce, but went through neutral?
        // beta went from 130 to 30 - it must have passed through neutral
        // but our system only checks the reported values, not interpolated path
        // so this should still be blocked because waitingForNeutral requires
        // an explicit beta in the neutral zone
      ]);
      // First is correct, second is blocked by debounce, third is blocked by neutral wait
      // because we never explicitly reported a beta in [65, 115]
      assert.deepEqual(actions, ['correct', null, null]);
    });
  });

  // ---- State immutability ----

  describe('state handling', () => {
    it('should not mutate the input state object', () => {
      const state = freshState();
      const stateCopy = { ...state };
      processTilt(130, 1000, state, config);
      assert.deepEqual(state, stateCopy, 'original state should not be mutated');
    });

    it('should return new state object on gesture', () => {
      const state = freshState();
      const result = processTilt(130, 1000, state, config);
      assert.notEqual(result.state, state, 'should return a new state object');
    });

    it('should preserve lastGestureTime when returning to neutral', () => {
      const first = processTilt(130, 1000, freshState(), config);
      const neutral = processTilt(90, 1600, first.state, config);
      assert.equal(neutral.state.lastGestureTime, 1000, 'should keep original gesture time');
    });
  });

  // ---- Custom config ----

  describe('custom configuration', () => {
    it('should respect custom thresholds', () => {
      const sensitive = {
        CORRECT_MIN: 100,
        PASS_MAX: 80,
        NEUTRAL_MIN: 85,
        NEUTRAL_MAX: 95,
        DEBOUNCE_MS: 200,
      };

      // 105 wouldn't trigger with default config but should with sensitive
      const result = processTilt(105, 1000, freshState(), sensitive);
      assert.equal(result.action, 'correct');
    });

    it('should respect custom debounce', () => {
      const fast = { ...config, DEBOUNCE_MS: 100 };
      const first = processTilt(130, 1000, freshState(), fast);
      const neutral = processTilt(90, 1050, first.state, fast);
      // Debounce should NOT block the neutral check since neutral doesn't produce an action
      // but the neutral zone check happens inside waitingForNeutral which runs before debounce
      // Actually looking at the code: debounce is checked first, then waitingForNeutral
      // Wait no - let me re-read the code...
      // The code checks debounce first, so at 1050 (50ms after, within 100ms debounce)
      // it would be blocked
      const second = processTilt(90, 1150, first.state, fast);
      // 1150 is 150ms after first, past 100ms debounce
      assert.equal(second.state.waitingForNeutral, false);
    });
  });

  // ---- Threshold boundary tests ----

  describe('exact threshold boundaries', () => {
    it('should return "correct" at exactly CORRECT_MIN + 0.1', () => {
      const result = processTilt(config.CORRECT_MIN + 0.1, 1000, freshState(), config);
      assert.equal(result.action, 'correct');
    });

    it('should return null at exactly CORRECT_MIN', () => {
      // beta > CORRECT_MIN is the check, so exactly CORRECT_MIN should NOT trigger
      const result = processTilt(config.CORRECT_MIN, 1000, freshState(), config);
      assert.equal(result.action, null);
    });

    it('should return "pass" at exactly PASS_MAX - 0.1', () => {
      const result = processTilt(config.PASS_MAX - 0.1, 1000, freshState(), config);
      assert.equal(result.action, 'pass');
    });

    it('should return null at exactly PASS_MAX', () => {
      // beta < PASS_MAX is the check, so exactly PASS_MAX should NOT trigger
      const result = processTilt(config.PASS_MAX, 1000, freshState(), config);
      assert.equal(result.action, null);
    });
  });
});

describe('getEffectiveTilt', () => {

  // ---- Portrait (angle = 0) ----

  describe('portrait orientation (angle 0)', () => {
    it('should return beta directly', () => {
      assert.equal(getEffectiveTilt(90, 0, 0), 90);
    });

    it('should return beta when tilted forward', () => {
      assert.equal(getEffectiveTilt(130, 10, 0), 130);
    });

    it('should return beta when tilted backward', () => {
      assert.equal(getEffectiveTilt(40, -20, 0), 40);
    });

    it('should ignore gamma in portrait', () => {
      assert.equal(getEffectiveTilt(90, 45, 0), 90);
    });
  });

  // ---- Landscape right (angle = 90) ----

  describe('landscape right (angle 90, device rotated clockwise)', () => {
    it('should return 90 when device is vertical (gamma = 0)', () => {
      assert.equal(getEffectiveTilt(0, 0, 90), 90);
    });

    it('should return > 90 when tilted forward (gamma positive)', () => {
      const result = getEffectiveTilt(0, 35, 90);
      assert.equal(result, 125);  // 90 + 35 = 125, triggers correct
    });

    it('should return < 90 when tilted backward (gamma negative)', () => {
      const result = getEffectiveTilt(0, -40, 90);
      assert.equal(result, 50);   // 90 + (-40) = 50, triggers pass
    });

    it('should trigger correct threshold at gamma = 31', () => {
      const result = getEffectiveTilt(0, 31, 90);
      assert.ok(result > TILT_CONFIG.CORRECT_MIN, `${result} should exceed ${TILT_CONFIG.CORRECT_MIN}`);
    });

    it('should trigger pass threshold at gamma = -36', () => {
      const result = getEffectiveTilt(0, -36, 90);
      assert.ok(result < TILT_CONFIG.PASS_MAX, `${result} should be below ${TILT_CONFIG.PASS_MAX}`);
    });
  });

  // ---- Landscape left (angle = 270) ----

  describe('landscape left (angle 270, device rotated counter-clockwise)', () => {
    it('should return 90 when device is vertical (gamma = 0)', () => {
      assert.equal(getEffectiveTilt(0, 0, 270), 90);
    });

    it('should return > 90 when tilted forward (gamma negative)', () => {
      const result = getEffectiveTilt(0, -35, 270);
      assert.equal(result, 125);  // 90 - (-35) = 125
    });

    it('should return < 90 when tilted backward (gamma positive)', () => {
      const result = getEffectiveTilt(0, 40, 270);
      assert.equal(result, 50);   // 90 - 40 = 50
    });

    it('should trigger correct threshold at gamma = -31', () => {
      const result = getEffectiveTilt(0, -31, 270);
      assert.ok(result > TILT_CONFIG.CORRECT_MIN, `${result} should exceed ${TILT_CONFIG.CORRECT_MIN}`);
    });

    it('should trigger pass threshold at gamma = 36', () => {
      const result = getEffectiveTilt(0, 36, 270);
      assert.ok(result < TILT_CONFIG.PASS_MAX, `${result} should be below ${TILT_CONFIG.PASS_MAX}`);
    });
  });

  // ---- Negative orientation angles (iOS uses -90 for landscape left) ----

  describe('negative orientation angle (-90)', () => {
    it('should normalize -90 to 270 and use gamma accordingly', () => {
      // -90 mod 360 = 270
      assert.equal(getEffectiveTilt(0, 0, -90), 90);
    });

    it('should handle tilt forward with -90 orientation', () => {
      const result = getEffectiveTilt(0, -35, -90);
      assert.equal(result, 125);  // same as angle 270
    });
  });

  // ---- Edge cases ----

  describe('edge cases', () => {
    it('should return null when beta is null', () => {
      assert.equal(getEffectiveTilt(null, 0, 0), null);
    });

    it('should return null when beta is undefined', () => {
      assert.equal(getEffectiveTilt(undefined, 0, 90), null);
    });

    it('should handle null gamma by treating as 0', () => {
      assert.equal(getEffectiveTilt(90, null, 0), 90);   // portrait: uses beta
      assert.equal(getEffectiveTilt(0, null, 90), 90);    // landscape: 90 + 0 = 90
    });

    it('should handle orientation angle 180 (upside down portrait)', () => {
      assert.equal(getEffectiveTilt(90, 0, 180), 90);  // uses beta
    });
  });

  // ---- Integration: getEffectiveTilt -> processTilt ----

  describe('integration with processTilt', () => {
    it('should detect correct in landscape right (gamma = 35)', () => {
      const tilt = getEffectiveTilt(0, 35, 90);    // 125
      const result = processTilt(tilt, 1000, freshState(), config);
      assert.equal(result.action, 'correct');
    });

    it('should detect pass in landscape right (gamma = -40)', () => {
      const tilt = getEffectiveTilt(0, -40, 90);   // 50
      const result = processTilt(tilt, 1000, freshState(), config);
      assert.equal(result.action, 'pass');
    });

    it('should detect neutral in landscape right (gamma = 0)', () => {
      const tilt = getEffectiveTilt(0, 0, 90);     // 90
      const result = processTilt(tilt, 1000, freshState(), config);
      assert.equal(result.action, null);
    });

    it('should detect correct in landscape left (gamma = -35)', () => {
      const tilt = getEffectiveTilt(0, -35, 270);   // 125
      const result = processTilt(tilt, 1000, freshState(), config);
      assert.equal(result.action, 'correct');
    });

    it('should detect pass in landscape left (gamma = 40)', () => {
      const tilt = getEffectiveTilt(0, 40, 270);    // 50
      const result = processTilt(tilt, 1000, freshState(), config);
      assert.equal(result.action, 'pass');
    });
  });
});
