const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const T = require('../transposer/transpose.js');

const N = (step, alter = 0) => ({ step, alter });
const P = (step, alter, octave) => ({ step, alter, octave });

describe('line of fifths', () => {
  it('spells positions correctly', () => {
    assert.deepEqual(T.noteFromFifthsPos(0), N('C'));
    assert.deepEqual(T.noteFromFifthsPos(1), N('G'));
    assert.deepEqual(T.noteFromFifthsPos(-1), N('F'));
    assert.deepEqual(T.noteFromFifthsPos(6), N('F', 1));
    assert.deepEqual(T.noteFromFifthsPos(-6), N('G', -1));
    assert.deepEqual(T.noteFromFifthsPos(7), N('C', 1));
    assert.deepEqual(T.noteFromFifthsPos(-7), N('C', -1));
  });

  it('round-trips through fifthsPosOf', () => {
    for (let p = -10; p <= 10; p++) {
      assert.equal(T.fifthsPosOf(T.noteFromFifthsPos(p)), p);
    }
  });

  it('derives key tonics from fifths and mode', () => {
    assert.deepEqual(T.keyTonic(0, 'major'), N('C'));
    assert.deepEqual(T.keyTonic(0, 'minor'), N('A'));
    assert.deepEqual(T.keyTonic(2, 'major'), N('D'));
    assert.deepEqual(T.keyTonic(2, 'minor'), N('B'));
    assert.deepEqual(T.keyTonic(-3, 'major'), N('E', -1));
    assert.deepEqual(T.keyTonic(-3, 'minor'), N('C'));
  });
});

describe('intervalBetween', () => {
  it('finds simple upward intervals', () => {
    assert.deepEqual(T.intervalBetween(N('C'), N('D'), 'up'), { steps: 1, semitones: 2 });
    assert.deepEqual(T.intervalBetween(N('C'), N('F'), 'up'), { steps: 3, semitones: 5 });
    assert.deepEqual(T.intervalBetween(N('G'), N('C'), 'up'), { steps: 3, semitones: 5 });
    assert.deepEqual(T.intervalBetween(N('C'), N('B', -1), 'up'), { steps: 6, semitones: 10 });
  });

  it('finds downward intervals', () => {
    assert.deepEqual(T.intervalBetween(N('C'), N('B', -1), 'down'), { steps: -1, semitones: -2 });
    assert.deepEqual(T.intervalBetween(N('D'), N('C'), 'down'), { steps: -1, semitones: -2 });
  });

  it('closest picks the smaller direction, ties upward', () => {
    assert.deepEqual(T.intervalBetween(N('C'), N('B'), 'closest'), { steps: -1, semitones: -1 });
    assert.deepEqual(T.intervalBetween(N('C'), N('G'), 'closest'), { steps: -3, semitones: -5 });
    assert.deepEqual(T.intervalBetween(N('C'), N('E'), 'closest'), { steps: 2, semitones: 4 });
    assert.deepEqual(T.intervalBetween(N('C'), N('F', 1), 'closest'), { steps: 3, semitones: 6 });
  });

  it('keeps odd spellings consistent (C→B♯ is an augmented 7th)', () => {
    assert.deepEqual(T.intervalBetween(N('C'), N('B', 1), 'up'), { steps: 6, semitones: 12 });
    assert.deepEqual(T.intervalBetween(N('C'), N('C', -1), 'closest'), { steps: 0, semitones: -1 });
  });

  it('identity is zero', () => {
    assert.deepEqual(T.intervalBetween(N('E', -1), N('E', -1), 'closest'), { steps: 0, semitones: 0 });
  });
});

describe('transposeNote / transposePitch', () => {
  const M2up = { steps: 1, semitones: 2 };
  const m3down = { steps: -2, semitones: -3 };

  it('transposes spellings with correct accidentals', () => {
    assert.deepEqual(T.transposeNote(N('C'), M2up), N('D'));
    assert.deepEqual(T.transposeNote(N('E'), M2up), N('F', 1));
    assert.deepEqual(T.transposeNote(N('B', -1), M2up), N('C'));
    assert.deepEqual(T.transposeNote(N('B'), M2up), N('C', 1));
    assert.deepEqual(T.transposeNote(N('C'), m3down), N('A'));
    assert.deepEqual(T.transposeNote(N('D'), m3down), N('B'));
    assert.deepEqual(T.transposeNote(N('E', -1), m3down), N('C'));
  });

  it('crosses octaves correctly', () => {
    assert.deepEqual(T.transposePitch(P('B', 0, 4), M2up), P('C', 1, 5));
    assert.deepEqual(T.transposePitch(P('C', 0, 4), m3down), P('A', 0, 3));
    assert.deepEqual(T.transposePitch(P('D', 0, 4), m3down), P('B', 0, 3));
  });

  it('a full octave up preserves spelling', () => {
    const oct = { steps: 7, semitones: 12 };
    assert.deepEqual(T.transposePitch(P('F', 1, 3), oct), P('F', 1, 4));
  });

  it('respells triple accidentals to something readable', () => {
    // G## up an augmented 2nd would be spelled with a triple sharp
    const aug2 = { steps: 1, semitones: 3 };
    const out = T.transposeNote(N('G', 2), aug2);
    assert.ok(out.alter >= -1 && out.alter <= 1);
    // must land on the right chromatic pitch class: G##=9, +3 → 0 (C)
    const chroma = ((T.LETTER_SEMITONES[out.step] + out.alter) % 12 + 12) % 12;
    assert.equal(chroma, 0);
  });
});

describe('key signature transposition', () => {
  it('moves fifths by the interval', () => {
    const M2up = { steps: 1, semitones: 2 };
    assert.equal(T.transposeFifths(0, M2up), 2); // C → D
    assert.equal(T.transposeFifths(-1, M2up), 1); // F → G
    const P4up = { steps: 3, semitones: 5 };
    assert.equal(T.transposeFifths(1, P4up), 0); // G → C
    const m2down = { steps: -1, semitones: -1 };
    assert.equal(T.transposeFifths(0, m2down), 5); // C down a m2 → B major
  });

  it('C down a minor 2nd lands on B major when spelled as an interval to B', () => {
    const iv = T.intervalBetween(N('C'), N('B'), 'closest');
    assert.equal(T.transposeFifths(0, iv), 5); // B major, 5 sharps
  });

  it('intervalForSemitones keeps key signatures simple', () => {
    // +1 semitone from C: Db (5 flats) beats C# (7 sharps)
    const iv = T.intervalForSemitones(1, [0]);
    assert.equal(Math.abs(T.transposeFifths(0, iv)), 5);
    // +6 from C: either 6 sharps or 6 flats — both fine
    const tritone = T.intervalForSemitones(6, [0]);
    assert.equal(Math.abs(T.transposeFifths(0, tritone)), 6);
    // -2 from D (2 sharps): C major (0)
    const down = T.intervalForSemitones(-2, [2]);
    assert.equal(T.transposeFifths(2, down), 0);
  });

  it('keyAlterFor reflects the signature', () => {
    assert.equal(T.keyAlterFor('F', 1), 1); // G major: F#
    assert.equal(T.keyAlterFor('C', 1), 0);
    assert.equal(T.keyAlterFor('B', -2), -1); // Bb major: Bb, Eb
    assert.equal(T.keyAlterFor('E', -2), -1);
    assert.equal(T.keyAlterFor('A', -2), 0);
    assert.equal(T.keyAlterFor('B', 0), 0);
  });
});

describe('targetKeys', () => {
  it('offers 12 sensibly spelled major keys', () => {
    const keys = T.targetKeys('major');
    assert.equal(keys.length, 12);
    const labels = keys.map((k) => k.label);
    assert.ok(labels.includes('C major'));
    assert.ok(labels.includes('E♭ major'));
    assert.ok(labels.includes('F♯ major')); // not Gb
    assert.ok(labels.includes('D♭ major')); // not C#
    for (const k of keys) assert.ok(Math.abs(k.fifths) <= 6, k.label);
  });

  it('offers 12 sensibly spelled minor keys', () => {
    const keys = T.targetKeys('minor');
    assert.equal(keys.length, 12);
    const labels = keys.map((k) => k.label);
    assert.ok(labels.includes('A minor'));
    assert.ok(labels.includes('E♭ minor')); // not D#
    assert.ok(labels.includes('C♯ minor'));
    for (const k of keys) assert.ok(Math.abs(k.fifths) <= 6, k.label);
  });
});

describe('end-to-end interval choice (UI flow)', () => {
  it('G major → A major moves every note up a major 2nd', () => {
    const from = T.keyTonic(1, 'major');
    const to = { step: 'A', alter: 0 };
    const iv = T.intervalBetween(from, to, 'closest');
    assert.deepEqual(iv, { steps: 1, semitones: 2 });
    assert.deepEqual(T.transposePitch(P('F', 1, 4), iv), P('G', 1, 4));
    assert.deepEqual(T.transposePitch(P('B', 0, 4), iv), P('C', 1, 5));
    assert.equal(T.transposeFifths(1, iv), 3);
  });

  it('E minor → C minor for an alto part goes down a major 3rd', () => {
    const from = T.keyTonic(1, 'minor');
    const to = { step: 'C', alter: 0 };
    const iv = T.intervalBetween(from, to, 'closest');
    assert.deepEqual(iv, { steps: -2, semitones: -4 });
    assert.equal(T.transposeFifths(1, iv), -3); // C minor, 3 flats
    // leading tone D# → B natural
    assert.deepEqual(T.transposePitch(P('D', 1, 5), iv), P('B', 0, 4));
  });
});
