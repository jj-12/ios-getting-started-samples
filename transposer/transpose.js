// Transposer — music transposition engine.
//
// Pure interval math (spelled pitches, keys, line of fifths) plus a MusicXML
// DOM transform. The math functions have no DOM dependency so they run under
// node:test; the DOM transform only touches standard DOM APIs on a Document
// produced by DOMParser in the browser.
//
// A pitch spelling is {step:'A'..'G', alter:int} (alter: -2..2, flats negative).
// An interval is {steps, semitones}: diatonic letter steps and chromatic
// semitones, both signed (negative = downward). Deriving intervals from two
// *spelled* tonics is what keeps every transposed note correctly spelled — the
// letter distance and the chromatic distance are transposed independently.

const LETTERS = ['C', 'D', 'E', 'F', 'G', 'A', 'B'];
const LETTER_SEMITONES = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

const mod = (n, m) => ((n % m) + m) % m;

// ---- Line of fifths ----------------------------------------------------
// Position p on the line of fifths: ... Bb=-2, F=-1, C=0, G=1, D=2 ...

function noteFromFifthsPos(p) {
  return {
    step: LETTERS[mod(4 * p, 7)],
    alter: Math.floor((p + 1) / 7),
  };
}

function fifthsPosOf(note) {
  // Inverse of noteFromFifthsPos: letter contributes its base position
  // (C=0 G=1 D=2 A=3 E=4 B=5 F=-1), each sharp adds 7, each flat subtracts 7.
  const base = { C: 0, G: 1, D: 2, A: 3, E: 4, B: 5, F: -1 };
  return base[note.step] + 7 * note.alter;
}

// Tonic spelling for a MusicXML key signature (fifths, mode).
function keyTonic(fifths, mode) {
  const minor = String(mode || 'major').toLowerCase() === 'minor';
  return noteFromFifthsPos(minor ? fifths + 3 : fifths);
}

// ---- Intervals ---------------------------------------------------------

const chromaticOf = (note) => LETTER_SEMITONES[note.step] + note.alter;

// Interval from one spelled note to another. direction:
//   'up'      → 0..11 semitones upward
//   'down'    → 0..-11 semitones downward
//   'closest' → within ±6 semitones (ties resolve upward)
function intervalBetween(from, to, direction = 'closest') {
  const NATURAL_SPAN = [0, 2, 4, 5, 7, 9, 11]; // unison..seventh in semitones
  let steps = mod(LETTERS.indexOf(to.step) - LETTERS.indexOf(from.step), 7);
  // Pick the semitone count congruent to the real chromatic distance (mod 12)
  // that matches the letter distance, so C→B♯ is 12 (aug 7th), not 0.
  let semitones = mod(chromaticOf(to) - chromaticOf(from), 12);
  if (semitones - NATURAL_SPAN[steps] > 6) semitones -= 12;
  if (semitones - NATURAL_SPAN[steps] < -6) semitones += 12;
  if (steps === 0 && semitones === 0) return { steps: 0, semitones: 0 };
  if (direction === 'up' && semitones < 0) {
    steps += 7;
    semitones += 12;
  } else if (direction === 'down' && semitones > 0) {
    steps -= 7;
    semitones -= 12;
  } else if (direction === 'closest' && semitones > 6) {
    steps -= 7;
    semitones -= 12;
  } else if (direction === 'closest' && semitones < -6) {
    steps += 7;
    semitones += 12;
  }
  return { steps, semitones };
}

const invertInterval = (iv) => ({ steps: -iv.steps, semitones: -iv.semitones });

const shiftOctaves = (iv, n) => ({ steps: iv.steps + 7 * n, semitones: iv.semitones + 12 * n });

// ---- Transposing spelled pitches ---------------------------------------

// Transpose a spelling (no octave), e.g. chord roots.
function transposeNote(note, interval) {
  const li = LETTERS.indexOf(note.step) + interval.steps;
  const step = LETTERS[mod(li, 7)];
  const alter =
    chromaticOf(note) + interval.semitones
    - LETTER_SEMITONES[step] - 12 * Math.floor(li / 7);
  return respellIfExtreme({ step, alter });
}

// Transpose {step, alter, octave} (MusicXML octave: C4 = middle C's octave 4).
function transposePitch(pitch, interval) {
  const li = LETTERS.indexOf(pitch.step) + interval.steps;
  const step = LETTERS[mod(li, 7)];
  const octave = pitch.octave + Math.floor(li / 7);
  const target = pitch.octave * 12 + chromaticOf(pitch) + interval.semitones;
  let out = { step, alter: target - (octave * 12 + LETTER_SEMITONES[step]), octave };
  if (out.alter < -2 || out.alter > 2) {
    const re = respellIfExtreme({ step: out.step, alter: out.alter });
    // Re-derive the octave from absolute chromatic position after respelling.
    let oct = octave;
    while (oct * 12 + chromaticOf(re) < target - 6) oct++;
    while (oct * 12 + chromaticOf(re) > target + 6) oct--;
    out = { step: re.step, alter: re.alter, octave: oct };
  }
  return out;
}

// Triple accidentals never help anyone: respell to at most one accidental.
function respellIfExtreme(note) {
  if (note.alter >= -2 && note.alter <= 2) return note;
  const chroma = mod(chromaticOf(note), 12);
  return spellChromatic(chroma, note.alter < 0);
}

// Spell a chromatic pitch class with at most one accidental.
function spellChromatic(chroma, preferFlats) {
  chroma = mod(chroma, 12);
  for (const alter of preferFlats ? [0, -1, 1] : [0, 1, -1]) {
    for (const step of LETTERS) {
      if (mod(LETTER_SEMITONES[step] + alter, 12) === chroma) return { step, alter };
    }
  }
  return { step: 'C', alter: 0 }; // unreachable
}

// ---- Key signatures -----------------------------------------------------

// How a key signature's fifths value moves under an interval.
// Derivation: on the line of fifths, an interval of (d steps, c semitones)
// displaces every note by 7c − 12d positions.
const transposeFifths = (fifths, interval) =>
  fifths + 7 * interval.semitones - 12 * interval.steps;

// Choose the interval spelling for a raw semitone shift that keeps the
// resulting key signatures simplest across the given fifths values.
function intervalForSemitones(semitones, fifthsList = [0]) {
  if (semitones === 0) return { steps: 0, semitones: 0 };
  let best = null;
  const guess = Math.round((7 * semitones) / 12);
  for (let d = guess - 2; d <= guess + 2; d++) {
    const iv = { steps: d, semitones };
    const worst = Math.max(
      ...fifthsList.map((f) => Math.abs(transposeFifths(f, iv))),
    );
    if (!best || worst < best.worst) best = { iv, worst };
  }
  return best.iv;
}

// Alteration a key signature imposes on a letter (F# in G major → 1, etc.).
function keyAlterFor(step, fifths) {
  const SHARPS = ['F', 'C', 'G', 'D', 'A', 'E', 'B'];
  if (fifths > 0) return SHARPS.indexOf(step) < fifths ? 1 : 0;
  if (fifths < 0) return SHARPS.slice().reverse().indexOf(step) < -fifths ? -1 : 0;
  return 0;
}

const ACCIDENTAL_NAMES = {
  '-2': 'flat-flat', '-1': 'flat', 0: 'natural', 1: 'sharp', 2: 'double-sharp',
};

// The 12 major (or minor) target keys offered by the UI, spelled canonically.
function targetKeys(mode) {
  const minor = String(mode || 'major').toLowerCase() === 'minor';
  const names = [];
  for (let pc = 0; pc < 12; pc++) {
    // Major tonics: pick spelling whose key signature is simplest; F#(6) wins
    // the tritone tie for majors, D#(6 sharps? no — Eb minor / D# minor tie) —
    // prefer |fifths| ≤ 6 and flats on ties for minors, sharps for F#/Gb major
    // per common practice (F# major and Eb minor are the usual choices).
    let bestNote = null;
    let bestF = Infinity;
    for (const preferFlats of [false, true]) {
      const n = spellChromatic(pc, preferFlats);
      const f = fifthsPosOf(n) - (minor ? 3 : 0);
      if (Math.abs(f) < Math.abs(bestF) ||
          (Math.abs(f) === Math.abs(bestF) && (minor ? f < 0 : f > 0) && bestF !== f)) {
        bestF = f;
        bestNote = n;
      }
    }
    names.push({
      tonic: bestNote,
      fifths: bestF,
      label: formatNote(bestNote) + (minor ? ' minor' : ' major'),
    });
  }
  return names;
}

function formatNote(note) {
  const marks = { '-2': '♭♭', '-1': '♭', 0: '', 1: '♯', 2: '\u{1D12A}' };
  return note.step + (marks[note.alter] ?? '');
}

function keyLabel(fifths, mode) {
  const minor = String(mode || 'major').toLowerCase() === 'minor';
  return formatNote(keyTonic(fifths, mode)) + (minor ? ' minor' : ' major');
}

// ---- MusicXML DOM transform ---------------------------------------------

// Read the initial key of the score: first <key> with <fifths> in the first
// part, plus its mode (defaults to major).
function initialKey(doc) {
  const key = doc.querySelector('part measure attributes key fifths');
  if (!key) return { fifths: 0, mode: 'major' };
  const keyEl = key.parentElement;
  const mode = keyEl.querySelector('mode');
  return {
    fifths: parseInt(key.textContent, 10) || 0,
    mode: mode ? mode.textContent.trim() : 'major',
  };
}

function scoreTitle(doc) {
  const t =
    doc.querySelector('work work-title') ||
    doc.querySelector('movement-title');
  return t ? t.textContent.trim() : '';
}

// Transpose an entire score-partwise document in place.
function transposeMusicXml(doc, interval) {
  if (!interval || (interval.steps === 0 && interval.semitones === 0)) {
    regenerateAccidentals(doc);
    return doc;
  }

  for (const keyEl of doc.querySelectorAll('key')) {
    const fifthsEl = keyEl.querySelector('fifths');
    if (!fifthsEl) continue; // non-traditional key signature
    const fifths = parseInt(fifthsEl.textContent, 10) || 0;
    fifthsEl.textContent = String(transposeFifths(fifths, interval));
  }

  for (const part of doc.querySelectorAll('part')) {
    if (isPercussionPart(part)) continue;
    for (const pitchEl of part.querySelectorAll('pitch')) {
      const p = readPitch(pitchEl);
      writePitch(pitchEl, transposePitch(p, interval));
    }
    for (const harmony of part.querySelectorAll('harmony')) {
      transposeHarmonyNode(harmony, 'root', 'root-step', 'root-alter', interval);
      transposeHarmonyNode(harmony, 'bass', 'bass-step', 'bass-alter', interval);
    }
  }

  regenerateAccidentals(doc);
  return doc;
}

function isPercussionPart(part) {
  const clef = part.querySelector('attributes clef sign');
  return !!clef && clef.textContent.trim() === 'percussion';
}

function readPitch(pitchEl) {
  const get = (tag) => {
    const el = pitchEl.querySelector(tag);
    return el ? el.textContent.trim() : null;
  };
  return {
    step: get('step') || 'C',
    alter: parseInt(get('alter') || '0', 10) || 0,
    octave: parseInt(get('octave') || '4', 10),
  };
}

function writePitch(pitchEl, p) {
  const doc = pitchEl.ownerDocument;
  const set = (tag, value, afterTag) => {
    let el = pitchEl.querySelector(tag);
    if (value === null) {
      if (el) el.remove();
      return;
    }
    if (!el) {
      el = doc.createElement(tag);
      const anchor = afterTag && pitchEl.querySelector(afterTag);
      if (anchor && anchor.nextSibling) pitchEl.insertBefore(el, anchor.nextSibling);
      else if (anchor) pitchEl.appendChild(el);
      else pitchEl.insertBefore(el, pitchEl.firstChild);
    }
    el.textContent = String(value);
  };
  set('step', p.step);
  set('alter', p.alter === 0 ? null : p.alter, 'step');
  set('octave', p.octave, pitchEl.querySelector('alter') ? 'alter' : 'step');
}

function transposeHarmonyNode(harmony, parentTag, stepTag, alterTag, interval) {
  const parent = harmony.querySelector(parentTag);
  if (!parent) return;
  const stepEl = parent.querySelector(stepTag);
  if (!stepEl) return;
  const alterEl = parent.querySelector(alterTag);
  const from = {
    step: stepEl.textContent.trim(),
    alter: alterEl ? parseInt(alterEl.textContent, 10) || 0 : 0,
  };
  if (!LETTERS.includes(from.step)) return;
  const to = transposeNote(from, interval);
  stepEl.textContent = to.step;
  if (to.alter === 0) {
    if (alterEl) alterEl.remove();
  } else if (alterEl) {
    alterEl.textContent = String(to.alter);
  } else {
    const el = harmony.ownerDocument.createElement(alterTag);
    el.textContent = String(to.alter);
    parent.appendChild(el);
  }
}

// Drop stale <accidental> display elements and re-emit them from pitch alters
// against the (new) key signature, with standard measure-scoped memory per
// staff + letter + octave.
function regenerateAccidentals(doc) {
  for (const part of doc.querySelectorAll('part')) {
    if (isPercussionPart(part)) continue;
    let fifths = 0;
    for (const measure of part.querySelectorAll('measure')) {
      const fifthsEl = measure.querySelector('attributes key fifths');
      if (fifthsEl) fifths = parseInt(fifthsEl.textContent, 10) || 0;
      const inForce = new Map(); // "staff|step|octave" → alter
      for (const note of measure.querySelectorAll('note')) {
        const old = note.querySelector('accidental');
        if (old) old.remove();
        const pitchEl = note.querySelector('pitch');
        if (!pitchEl) continue;
        const p = readPitch(pitchEl);
        const staffEl = note.querySelector('staff');
        const slot = `${staffEl ? staffEl.textContent.trim() : '1'}|${p.step}|${p.octave}`;
        const current = inForce.has(slot) ? inForce.get(slot) : keyAlterFor(p.step, fifths);
        if (p.alter !== current) {
          const tied = note.querySelector('tie[type="stop"]');
          if (!tied) {
            const acc = doc.createElement('accidental');
            acc.textContent = ACCIDENTAL_NAMES[p.alter] || 'natural';
            insertAccidental(note, acc);
          }
          inForce.set(slot, p.alter);
        }
      }
    }
  }
}

// <accidental> must land after <type>/<dot> and before <stem>/<notations> to
// keep the MusicXML element order valid enough for renderers.
function insertAccidental(note, acc) {
  const anchor =
    note.querySelector('stem') ||
    note.querySelector('notehead') ||
    note.querySelector('staff') ||
    note.querySelector('beam') ||
    note.querySelector('notations') ||
    note.querySelector('lyric');
  if (anchor) note.insertBefore(acc, anchor);
  else note.appendChild(acc);
}

const api = {
  LETTERS,
  LETTER_SEMITONES,
  noteFromFifthsPos,
  fifthsPosOf,
  keyTonic,
  intervalBetween,
  invertInterval,
  shiftOctaves,
  transposeNote,
  transposePitch,
  transposeFifths,
  intervalForSemitones,
  keyAlterFor,
  spellChromatic,
  targetKeys,
  formatNote,
  keyLabel,
  initialKey,
  scoreTitle,
  transposeMusicXml,
  regenerateAccidentals,
};

if (typeof module !== 'undefined' && module.exports) module.exports = api;
if (typeof window !== 'undefined') window.Transpose = api;
