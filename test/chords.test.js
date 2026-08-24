const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const C = require('../transposer/chords.js');
const T = require('../transposer/transpose.js');

const N = (step, alter = 0) => ({ step, alter });

describe('parseChord', () => {
  it('parses roots and accidentals', () => {
    assert.deepEqual(C.parseChord('C'), { root: N('C'), quality: '', bass: null });
    assert.deepEqual(C.parseChord('F#'), { root: N('F', 1), quality: '', bass: null });
    assert.deepEqual(C.parseChord('Bb'), { root: N('B', -1), quality: '', bass: null });
    assert.deepEqual(C.parseChord('E♭'), { root: N('E', -1), quality: '', bass: null });
  });

  it('parses common qualities verbatim', () => {
    for (const q of ['m', '7', 'm7', 'maj7', 'M7', '6', 'm6', '9', '13',
      'sus4', 'sus2', '7sus4', 'dim', 'dim7', 'm7b5', 'aug', '+', '7#9',
      '7b9', 'add9', 'madd9', '°7', 'ø7', 'Δ7', '11']) {
      const parsed = C.parseChord('C' + q);
      assert.ok(parsed, `C${q} should parse`);
      assert.equal(parsed.quality, q);
    }
  });

  it('parses slash basses and slash tensions', () => {
    assert.deepEqual(C.parseChord('G/B'), { root: N('G'), quality: '', bass: N('B') });
    assert.deepEqual(C.parseChord('A/C#'), { root: N('A'), quality: '', bass: N('C', 1) });
    assert.deepEqual(C.parseChord('C6/9'), { root: N('C'), quality: '6/9', bass: null });
    assert.deepEqual(C.parseChord('Dm7/G'), { root: N('D'), quality: 'm7', bass: N('G') });
  });

  it('rejects prose that merely starts with a note letter', () => {
    for (const word of ['Bed', 'Cat', 'Do', 'Go', 'Dog', 'Grace', 'Andante',
      'Fine', 'Coda', 'D.C.', 'Gm7x', 'H7', 'Allegro', 'Book']) {
      assert.equal(C.parseChord(word), null, `${word} should not parse`);
    }
  });

  it('accepts single bare letters (resolved by page-level heuristics)', () => {
    assert.ok(C.parseChord('A'));
    assert.ok(C.parseChord('G'));
  });
});

describe('transposeChordText', () => {
  const up2 = T.intervalBetween(N('C'), N('D'), 'up'); // major 2nd up

  it('moves root and bass together, keeping quality', () => {
    assert.equal(C.transposeChordText('C', up2), 'D');
    assert.equal(C.transposeChordText('Am7', up2), 'Bm7');
    assert.equal(C.transposeChordText('G/B', up2), 'A/C#');
    assert.equal(C.transposeChordText('F#m7b5', up2), 'G#m7b5');
  });

  it('respects spelling preference', () => {
    const up1 = T.intervalForSemitones(1, [0]); // semitone up, flat-ward
    assert.equal(C.transposeChordText('C', up1), 'Db');
    assert.equal(C.transposeChordText('G7', up1), 'Ab7');
    assert.equal(C.transposeChordText('B', up1), 'C');
  });

  it('never emits double accidentals', () => {
    const up2 = T.intervalBetween(N('C'), N('D'), 'up');
    // F# up a major 2nd is G#; G# up a major 2nd would be A# — fine.
    // But E# up a major 2nd would be F## → respelled to G.
    assert.equal(C.transposeChordText('E#', up2), 'G');
  });

  it('down transposition', () => {
    const down3 = T.intervalBetween(N('C'), N('A'), 'closest'); // m3 down
    assert.equal(C.transposeChordText('C', down3), 'A');
    assert.equal(C.transposeChordText('Em', down3), 'C#m');
    assert.equal(C.transposeChordText('Bb7', down3), 'G7');
  });

  it('returns null for non-chords', () => {
    assert.equal(C.transposeChordText('Hello', up2), null);
  });
});

describe('intervalForChordShift', () => {
  it('keeps shifted chords readable', () => {
    const up1 = C.intervalForChordShift(1);
    assert.equal(C.transposeChordText('C', up1), 'Db');
    const down1 = C.intervalForChordShift(-1);
    assert.equal(C.transposeChordText('C', down1), 'B');
    const up6 = C.intervalForChordShift(6);
    const out = C.transposeChordText('C', up6);
    assert.ok(out === 'F#' || out === 'Gb', out);
  });
});
