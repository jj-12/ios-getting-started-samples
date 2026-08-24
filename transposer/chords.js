// Transposer — chord symbol parsing and transposition.
//
// Handles chord symbols as they appear in lead sheets: "Bb", "F#m7", "Cmaj7",
// "G7sus4", "Dm7b5", "A/C#", "E7(#9)", "F6/9" … The quality suffix is kept
// verbatim; only the root (and slash bass) letters move. Shares the interval
// representation of transpose.js. Dual browser/node export like transpose.js.

(function () {
  const t =
    typeof module !== 'undefined' && module.exports
      ? require('./transpose.js')
      : window.Transpose;

  const ACCIDENTALS = { '#': 1, '♯': 1, b: -1, '♭': -1, x: 2, '##': 2, bb: -2, '♭♭': -2 };

  // Quality suffixes are validated against composable pieces so that chord
  // detection in PDF text has decent precision (rejecting words like "Bad").
  const QUALITY_PIECE =
    /^(?:maj|Maj|MAJ|min|mi|m|M|dim|aug|sus[24]?|add[0-9]{1,2}|alt|Δ|∆|ø|°|o|\+|-|[0-9]{1,2}|[#♯b♭][0-9]{1,2}|\((?:[#♯b♭]?[0-9]{1,2}|no[0-9]|omit[0-9]|add[0-9]{1,2})\)|\/[0-9]{1,2})*$/;

  // Parse "F#m7/A#" → {root, quality, bass}. Returns null if not a chord.
  function parseChord(text) {
    const s = String(text).trim();
    // "/9"-style tensions (C6/9) stay in the quality via the lookahead; only
    // "/<letter>" is a slash bass.
    const m = s.match(/^([A-G])(♯♯|♭♭|##|bb|[#♯xb♭])?((?:[^/]|\/(?=[0-9]))*)(?:\/([A-G])(♯♯|♭♭|##|bb|[#♯xb♭])?)?$/);
    if (!m) return null;
    const [, rootStep, rootAcc, quality, bassStep, bassAcc] = m;
    if (quality && !QUALITY_PIECE.test(quality)) return null;
    // Bare "o" needs the ° glyph to count as diminished, else "Do"/"Go" match.
    if (quality === 'o') return null;
    if (quality && /[A-Za-z]{5,}/.test(quality.replace(/maj|Maj|MAJ|min|dim|aug|sus|add|omit|alt/g, ''))) return null;
    return {
      root: { step: rootStep, alter: rootAcc ? ACCIDENTALS[rootAcc] : 0 },
      quality: quality || '',
      bass: bassStep
        ? { step: bassStep, alter: bassAcc ? ACCIDENTALS[bassAcc] : 0 }
        : null,
    };
  }

  // ASCII accidentals by default — that's how lead sheets are usually typed.
  function formatChordNote(note, unicode) {
    const marks = unicode
      ? { '-2': '𝄫', '-1': '♭', 0: '', 1: '♯', 2: '𝄪' }
      : { '-2': 'bb', '-1': 'b', 0: '', 1: '#', 2: '##' };
    return note.step + (marks[note.alter] ?? '');
  }

  function formatChord(chord, unicode) {
    let out = formatChordNote(chord.root, unicode) + chord.quality;
    if (chord.bass) out += '/' + formatChordNote(chord.bass, unicode);
    return out;
  }

  // Keep transposed chords readable: no double accidentals, and respell by
  // the flat/sharp preference of the destination context.
  function tidy(note, preferFlats) {
    if (note.alter >= -1 && note.alter <= 1) return note;
    return t.spellChromatic(t.LETTER_SEMITONES[note.step] + note.alter, preferFlats);
  }

  function transposeChord(chord, interval, preferFlats) {
    const pf =
      preferFlats !== undefined
        ? preferFlats
        : chord.root.alter < 0 || (chord.bass && chord.bass.alter < 0);
    return {
      root: tidy(t.transposeNote(chord.root, interval), pf),
      quality: chord.quality,
      bass: chord.bass ? tidy(t.transposeNote(chord.bass, interval), pf) : null,
    };
  }

  // Transpose a chord symbol string; returns null if it doesn't parse.
  function transposeChordText(text, interval, preferFlats, unicode) {
    const chord = parseChord(text);
    if (!chord) return null;
    return formatChord(transposeChord(chord, interval, preferFlats), unicode);
  }

  // For a raw semitone shift (PDF path, where no key signature is known),
  // choose an interval spelling that keeps common chords readable.
  function intervalForChordShift(semitones) {
    return t.intervalForSemitones(semitones, [0, 1, -1, 2, -2]);
  }

  const api = {
    parseChord,
    formatChord,
    formatChordNote,
    transposeChord,
    transposeChordText,
    intervalForChordShift,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.Chords = api;
})();
