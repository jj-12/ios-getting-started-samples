const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { processWink, createWinkState, winkProgress, WINK_CONFIG } = require('../page-turner/wink.js');

const config = WINK_CONFIG;
const FRAME = 33; // ~30fps

// Helper: run a sequence of { left, right } frames spaced FRAME ms apart
// starting at t0, and return the list of fired actions (nulls omitted).
function simulate(frames, t0 = 1000, cfg = config, initialState = null) {
  let state = initialState || createWinkState();
  const fired = [];
  let now = t0;
  for (const f of frames) {
    const result = processWink(f.left, f.right, now, state, cfg);
    state = result.state;
    if (result.action) fired.push({ action: result.action, time: now });
    now += FRAME;
  }
  return { fired, state, endTime: now };
}

// Frame factories
const open = { left: 0.05, right: 0.05 };
const winkLeft = { left: 0.9, right: 0.1 };   // left channel closed, right open
const winkRight = { left: 0.1, right: 0.9 };
const bothClosed = { left: 0.9, right: 0.9 };
const repeat = (frame, n) => Array(n).fill(frame);
const framesFor = (ms) => Math.ceil(ms / FRAME);

describe('processWink - deliberate winks', () => {
  it('fires "left" after a held left-channel wink', () => {
    const { fired } = simulate([
      ...repeat(open, 3),
      ...repeat(winkLeft, framesFor(config.HOLD_MS) + 2),
    ]);
    assert.equal(fired.length, 1);
    assert.equal(fired[0].action, 'left');
  });

  it('fires "right" after a held right-channel wink', () => {
    const { fired } = simulate([
      ...repeat(open, 3),
      ...repeat(winkRight, framesFor(config.HOLD_MS) + 2),
    ]);
    assert.equal(fired.length, 1);
    assert.equal(fired[0].action, 'right');
  });

  it('does not fire before HOLD_MS has elapsed', () => {
    const { fired } = simulate([
      ...repeat(open, 3),
      ...repeat(winkLeft, framesFor(config.HOLD_MS) - 3),
      ...repeat(open, 3),
    ]);
    assert.equal(fired.length, 0);
  });

  it('fires exactly once for one long-held wink', () => {
    const { fired } = simulate([
      ...repeat(open, 3),
      ...repeat(winkLeft, framesFor(config.HOLD_MS * 4)),
    ]);
    assert.equal(fired.length, 1, 'continued hold must not re-fire');
  });

  it('requires both eyes to reopen before the next wink can fire', () => {
    // Wink left, keep holding past cooldown, never reopen -> only 1 fire
    const { fired } = simulate([
      ...repeat(open, 3),
      ...repeat(winkLeft, framesFor(config.HOLD_MS + config.COOLDOWN_MS + 1000)),
    ]);
    assert.equal(fired.length, 1);
  });

  it('allows a second wink after reopening and cooldown', () => {
    const { fired } = simulate([
      ...repeat(open, 3),
      ...repeat(winkLeft, framesFor(config.HOLD_MS) + 2),
      ...repeat(open, framesFor(config.COOLDOWN_MS) + 2),
      ...repeat(winkRight, framesFor(config.HOLD_MS) + 2),
    ]);
    assert.equal(fired.length, 2);
    assert.equal(fired[0].action, 'left');
    assert.equal(fired[1].action, 'right');
  });

  it('restarts the hold clock if the winking eye switches', () => {
    const half = framesFor(config.HOLD_MS / 2);
    const { fired } = simulate([
      ...repeat(open, 3),
      ...repeat(winkLeft, half),
      ...repeat(winkRight, half + 1), // not enough on its own after switch
      ...repeat(open, 3),
    ]);
    assert.equal(fired.length, 0);
  });
});

describe('processWink - blink rejection', () => {
  it('never fires on a symmetric blink', () => {
    const { fired } = simulate([
      ...repeat(open, 5),
      ...repeat(bothClosed, framesFor(200)),
      ...repeat(open, 5),
    ]);
    assert.equal(fired.length, 0);
  });

  it('never fires on a blink with asymmetric onset (one eye leads)', () => {
    // One eye closes 2 frames before the other - a very common real blink
    const { fired } = simulate([
      ...repeat(open, 5),
      ...repeat(winkLeft, 2),
      ...repeat(bothClosed, framesFor(200)),
      ...repeat(open, 5),
    ]);
    assert.equal(fired.length, 0);
  });

  it('never fires on a blink with asymmetric reopen (one eye lags)', () => {
    // Eyes reopen unevenly: looks like a short "wink" at the tail.
    // The post-blink guard must suppress it.
    const lagFrames = framesFor(config.BLINK_GUARD_MS) - 1;
    const { fired } = simulate([
      ...repeat(open, 5),
      ...repeat(bothClosed, framesFor(150)),
      ...repeat(winkLeft, lagFrames),
      ...repeat(open, 5),
    ]);
    assert.equal(fired.length, 0);
  });

  it('cancels an in-progress wink candidate if the other eye also closes', () => {
    // Started as a wink but became a blink before HOLD_MS
    const { fired } = simulate([
      ...repeat(open, 3),
      ...repeat(winkLeft, framesFor(config.HOLD_MS) - 4),
      ...repeat(bothClosed, 3),
      ...repeat(winkLeft, 3), // reopen lag, inside blink guard
      ...repeat(open, 3),
    ]);
    assert.equal(fired.length, 0);
  });

  it('still fires a deliberate wink held well past a preceding blink', () => {
    const { fired } = simulate([
      ...repeat(open, 5),
      ...repeat(bothClosed, framesFor(150)),          // blink
      ...repeat(open, framesFor(config.BLINK_GUARD_MS) + 2),
      ...repeat(winkRight, framesFor(config.HOLD_MS) + 2),
    ]);
    assert.equal(fired.length, 1);
    assert.equal(fired[0].action, 'right');
  });
});

describe('processWink - noise tolerance', () => {
  it('tolerates a single noisy frame inside a held wink (grace window)', () => {
    const half = framesFor(config.HOLD_MS / 2);
    const ambiguous = { left: 0.45, right: 0.45 }; // neither closed nor clearly open
    const { fired } = simulate([
      ...repeat(open, 3),
      ...repeat(winkLeft, half),
      ambiguous, // one dropped frame (33ms < GRACE_MS)
      ...repeat(winkLeft, half + 2),
    ]);
    assert.equal(fired.length, 1, 'brief dropout should not reset the hold');
  });

  it('drops the candidate after a dropout longer than GRACE_MS', () => {
    const half = framesFor(config.HOLD_MS / 2);
    const ambiguous = { left: 0.45, right: 0.45 };
    const { fired } = simulate([
      ...repeat(open, 3),
      ...repeat(winkLeft, half),
      ...repeat(ambiguous, framesFor(config.GRACE_MS) + 2),
      ...repeat(winkLeft, half + 1), // not enough on its own
      ...repeat(open, 3),
    ]);
    assert.equal(fired.length, 0);
  });

  it('drops the candidate when the face is lost (null scores)', () => {
    const half = framesFor(config.HOLD_MS / 2);
    const { fired } = simulate([
      ...repeat(open, 3),
      ...repeat(winkLeft, half),
      ...repeat({ left: null, right: null }, 5),
      ...repeat(winkLeft, half + 1),
      ...repeat(open, 3),
    ]);
    assert.equal(fired.length, 0);
  });

  it('returns no action and keeps working after null scores', () => {
    const { fired } = simulate([
      ...repeat({ left: null, right: null }, 10),
      ...repeat(open, 3),
      ...repeat(winkRight, framesFor(config.HOLD_MS) + 2),
    ]);
    assert.equal(fired.length, 1);
  });

  it('does not treat a half-closed squint as a wink', () => {
    // Looking down at the keys narrows both eyes - scores rise but stay
    // below CLOSED_MIN. Must never fire.
    const squint = { left: 0.5, right: 0.4 };
    const { fired } = simulate(repeat(squint, framesFor(3000)));
    assert.equal(fired.length, 0);
  });
});

describe('processWink - cooldown', () => {
  it('ignores gestures during the cooldown window', () => {
    const { fired } = simulate([
      ...repeat(open, 3),
      ...repeat(winkLeft, framesFor(config.HOLD_MS) + 2),   // fires
      ...repeat(open, 3),                                    // reopen quickly
      ...repeat(winkRight, framesFor(config.HOLD_MS) + 2),  // still inside cooldown
      ...repeat(open, 3),
    ]);
    assert.equal(fired.length, 1);
  });
});

describe('processWink - custom config', () => {
  it('respects a shorter HOLD_MS', () => {
    const fast = { ...config, HOLD_MS: 150 };
    const { fired } = simulate([
      ...repeat(open, 3),
      ...repeat(winkLeft, framesFor(150) + 2),
    ], 1000, fast);
    assert.equal(fired.length, 1);
  });

  it('respects custom closed/open thresholds', () => {
    const strict = { ...config, CLOSED_MIN: 0.8, OPEN_MAX: 0.15 };
    // 0.7 closed-score wink is not closed enough under strict config
    const weak = { left: 0.7, right: 0.1 };
    const { fired } = simulate(repeat(weak, framesFor(2000)), 1000, strict);
    assert.equal(fired.length, 0);
  });
});

describe('processWink - state handling', () => {
  it('does not mutate the input state object', () => {
    const state = createWinkState();
    const copy = { ...state };
    processWink(0.9, 0.1, 1000, state, config);
    assert.deepEqual(state, copy);
  });

  it('returns a new state object when a candidate starts', () => {
    const state = createWinkState();
    const result = processWink(0.9, 0.1, 1000, state, config);
    assert.notEqual(result.state, state);
    assert.equal(result.state.candidateEye, 'left');
  });
});

describe('winkProgress', () => {
  it('is 0 with no candidate', () => {
    assert.equal(winkProgress(createWinkState(), 1000, config), 0);
  });

  it('reports fractional progress during a hold', () => {
    let state = createWinkState();
    state = processWink(0.9, 0.1, 1000, state, config).state;
    const p = winkProgress(state, 1000 + config.HOLD_MS / 2, config);
    assert.ok(p > 0.4 && p < 0.6, `expected ~0.5, got ${p}`);
  });

  it('caps at 1', () => {
    let state = createWinkState();
    state = processWink(0.9, 0.1, 1000, state, config).state;
    assert.equal(winkProgress(state, 999999, config), 1);
  });
});
