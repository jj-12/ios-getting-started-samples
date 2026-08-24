# Transposer — Sheet Music in Any Key

A PWA that transposes sheet music. Import a score, pick a target key, and
read, play, or print it in the new key.

Live at <https://jj-12.github.io/ios-getting-started-samples/transposer/>.

## What it does

**MusicXML scores** (`.musicxml`, `.xml`, `.mxl`) transpose *fully*:

- Pick any of the 12 major/minor target keys (the list matches the piece's
  mode), or nudge the result up/down by octaves.
- Notes, key signatures, chord symbols and accidentals are all rewritten
  with correct spelling — G major → D major turns F♯ into C♯, not D♭.
- The re-engraved score renders in the browser
  ([OpenSheetMusicDisplay](https://opensheetmusicdisplay.org/)), can be
  **played back** with a small synth to hear the new key, **printed** (or
  saved as PDF via the print dialog), and **downloaded** as transposed
  MusicXML.

**PDF lead sheets** get their chord symbols transposed *in place*:

- The app scans the PDF's text layer for chord symbols (`Bb`, `F#m7`,
  `C6/9`, `A/C#`…), then redraws them shifted by your chosen number of
  semitones, directly on the page — lyrics and everything else stay put.
- Sharp/flat spelling is chosen automatically (or force flats), changed
  chords can be highlighted, and the result prints.

**PDFs of full notation** can't be re-engraved from pixels — a PDF stores a
*picture* of the notes. The app says so honestly and links free
music-OCR tools ([Audiveris](https://audiveris.github.io/audiveris/),
[homr](https://homr.site), [MuseScore](https://musescore.org)) that convert
a PDF to MusicXML once; import the result and full transposition, playback
and printing all apply.

Imported scores are stored in the app (IndexedDB), so the library works
offline. A public-domain demo score (Amazing Grace, with chords) is included
to try the whole flow without a file.

## How transposition works

Everything is interval arithmetic on *spelled* pitches
(`transpose.js`, no dependencies, unit-tested):

- A key choice becomes a diatonic interval between the two tonics — letter
  steps and semitones move independently, which is what keeps every note
  spelled correctly (E♭ down a major 3rd is C♭… respelled to B only when
  a double accidental would appear).
- Key signatures move on the line of fifths (`Δfifths = 7·semitones −
  12·steps`), and raw semitone shifts pick the spelling that keeps the
  resulting signature simplest.
- Explicit accidentals are regenerated from scratch against the new key
  signature with standard measure-scoped rules.
- Chord symbols (`chords.js`) share the same math for roots and slash
  basses; the quality suffix (`m7b5`, `sus4`, `6/9`…) is preserved verbatim.

`.mxl` files are unpacked by a ~90-line ZIP reader (`mxl.js`) using the
browser's built-in `DecompressionStream` — no libraries.

## Tests

Engine, chords, and the .mxl reader are covered by `node:test` suites in
[`../test/`](../test):

```
node --test test/*.test.js
```

## Install

Open the link on your phone/tablet and **Add to Home Screen**. After one
online visit the app (including the notation renderer) is cached and works
offline.
