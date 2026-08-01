# Page Turner — Hands-Free Sheet Music Viewer

A PWA for iPad that displays PDF sheet music and turns pages when you **wink**
— so your hands never leave the piano.

- **Wink your RIGHT eye** (hold ~0.4s) → next page
- **Wink your LEFT eye** (hold ~0.4s) → previous page
- **Look-at-camera gate** — a wink only registers if you were looking at
  the camera when it started, so nothing you do while reading the music or
  watching your hands can turn a page. (Optional, on by default.)
- **Blinks are ignored** — a blink closes both eyes together; a wink only
  counts when one eye is closed while the other stays clearly open, held
  deliberately, with a cooldown so one wink never turns two pages.
- **Tap fallback** — tap the right/left edge of the screen to turn pages
  manually at any time; tap the middle to show/hide the controls.
- **Fast navigation** — drag the page slider in the top bar to jump
  anywhere in the score; the bar stays visible except while tracking is
  armed (it auto-hides during performance; tap the middle to bring it back).
- **Two-page spread** — rotate the iPad to landscape and pages display side
  by side like an open book (turns move two pages at a time).
- **Movable camera view** — the tracking panel can be minimized to a slim
  status pill or moved between all four corners with the buttons on it, so
  it never covers the music.

## Use it

Open <https://jj-12.github.io/ios-getting-started-samples/page-turner/> on the
iPad, then **Share → Add to Home Screen**. Installing it matters for two
reasons: iOS protects the app's stored PDFs from cache eviction, and it runs
full-screen without Safari chrome.

## Getting music in (incl. Notability)

The app imports PDFs through the iOS Files picker:

1. In **Notability**: open the note → Share → **PDF** → **Save to Files**.
2. In **Page Turner**: tap **Import PDF** and pick the file (iCloud Drive,
   On My iPad, Downloads, etc.).

Imported scores are stored inside the app (IndexedDB), so the library and the
viewer work fully offline. The original PDF stays in Files as your backup.

## First-time setup

The first time you tap **Start tracking**, a short calibration runs:

1. Sit in your normal playing position so the camera learns your posture.
2. Look directly at the camera lens — this becomes the "turn the page" look
   that arms the wink detector.
3. Wink your right eye and hold — this becomes "next page".
4. Wink your left eye and hold — this becomes "previous page".

Calibration also resolves camera mirroring automatically (front cameras flip
left/right, a classic source of backwards page turns). You can recalibrate,
swap eyes, or adjust the wink hold time in Settings (⚙) any time.

## How wink detection works

Face tracking runs entirely on-device in the browser using MediaPipe Face
Landmarker (WASM/GPU), which outputs per-eye "closedness" blendshape scores.
The detector (`wink.js`, pure logic, unit-tested in `test/wink.test.js`)
fires only when **all** of these hold:

| Guard | Purpose |
| --- | --- |
| Gaze gate: head + eye direction near the calibrated "at the camera" look | rejects everything you do while reading music or watching your hands |
| One eye closed **and** the other clearly open | rejects blinks and squints |
| Held for `HOLD_MS` (default 400ms, adjustable) | rejects twitches and blink tails |
| Both-eyes-closed cancels + guards for 300ms | rejects asymmetric blink onset/reopen |
| 1.2s cooldown + both eyes must reopen | one wink = one page turn |

The gaze gate only applies at the *start* of a wink — once the hold begins,
looking away or the closed eye skewing the gaze estimate can't cancel it.
The HUD shows "Look at camera…" vs "Ready" so you always know whether a
wink will count.

Thresholds are **per eye**, learned during calibration. This matters when
the camera sits to one side of your face (portrait orientation on most
iPads): the eye farther from the camera produces compressed scores — its
winks peak lower and its resting score sits higher — so a single fixed
threshold would only ever register the near eye. Calibration measures each
eye's open baseline and wink peak from the camera's actual viewpoint and
sets each eye's bars accordingly. If one eye ever stops registering,
recalibrate from Settings (⚙) in your playing position.

No video ever leaves the device; the camera stream is processed locally and
nothing is uploaded.

## Notes & limitations

- Requires a fairly recent iPadOS (16.4+) for wake lock and module workers.
- iOS may re-ask for camera permission when the app launches, depending on
  iPadOS version — one tap before you start playing.
- Good, even lighting on your face improves tracking; strong backlight hurts.
- First online run downloads pdf.js and the MediaPipe model (~10 MB); the
  service worker caches everything after that for offline use.
