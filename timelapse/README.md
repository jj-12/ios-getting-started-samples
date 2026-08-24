# Aligned Timelapse

Point it at years of photos of the same person and it flips through them with
their **eyes pinned to the same two points** on every frame. Backgrounds,
haircuts and decades fly past; the face stays put.

Live at
<https://jj-12.github.io/ios-getting-started-samples/timelapse/> —
open it on a phone and **Share → Add to Home Screen** to install it.

Photos never leave the device. Decoding, face detection, alignment and video
encoding all happen in the browser; there is no server to upload to.

## Using it

1. **Add photos** — drop them on the page, or tap *Choose photos* (on
   iPhone/iPad that opens your photo library, including anything saved out of
   a Google Photos album). Or import straight from
   [Google Photos](#google-photos-setup).
2. Photos are sorted by **capture date** — EXIF first, file date as backup,
   filename as a last resort.
3. **Faces are found automatically.** Any photo the detector misses is flagged
   in the *Photos* tab: tap it and drag the two markers onto the eyes. A
   magnifier follows your finger so you can place them precisely.
4. **Frame it** — face size, height and position on the canvas, output shape
   and resolution.
5. **Press play**, then **Export video** (or *Export frames* for a `.zip` of
   aligned JPEGs to drop into a video editor).

## The controls that matter

| Control | What it does |
| --- | --- |
| **Face size** | How much of the frame width the eyes span. Bigger = tighter crop. |
| **Face height / Horizontal** | Where the face sits on the canvas. |
| **Stabilize** | Detector output is a pixel or two noisy, which shimmers at 8 photos/second. This lets each photo drift toward its neighbours to cancel that — capped at 2% of the frame width, so faces never wander off their mark. |
| **Level the eyes** | On: photos are rotated so the eye line is horizontal. Off: each photo keeps its own tilt and is only moved and resized. |
| **Fill the frame** | Aligning photos taken at different distances means some do not cover the whole canvas. This crops in — by the same amount on every frame, so alignment survives — until they do. *Most photos* tolerates edges on the worst few instead of cropping everyone tightly. |
| **Photos per second** | 8 is a good "flip book" speed; 2–4 reads more like a slideshow. |
| **Crossfade** | Blends between photos. Leave it at *none* for the snappy flip-book look. |

## How the alignment works

Each photo gives two anchor points — the eyes. Fitting a **similarity
transform** (move, rotate, uniform scale — no distortion) that carries those
two points onto the same canvas targets is what locks the face in place.
`align.js` holds that geometry, with no DOM or canvas in sight, and
[`test/align.test.js`](../test/align.test.js) checks it: transforms land the
anchors on target to within a millionth of a pixel, stabilization respects its
drift budget, the shared crop really does cover the frame, EXIF dates parse in
both byte orders.

Faces come from **MediaPipe Face Landmarker**, running on-device via WASM. It
is trained on selfie-sized faces, so a head that occupies 10% of a wide
progress shot is invisible to it. When the whole-frame pass finds nothing, the
app re-runs the detector on crops — starting where the previous photo's face
was, then a coarse-to-fine grid — which is what makes full-body shots work.
Group photos are handled by picking the face that continues the previous
photo's: same size, same place, rather than whoever happens to be biggest.

Alignment is cached per photo (by name and size), so reopening the app with the
same photos skips detection entirely. *Re-detect faces* clears that.

## Google Photos setup

Google retired the "read my library" API scopes in 2025. The only supported
route now is the **Picker API**: Google shows its own picker, you choose an
album, and the app receives just those photos. This is a static site with no
server, so it cannot ship credentials — you supply a client ID from your own
Google Cloud project. It is stored in your browser only.

1. In the [Google Cloud console](https://console.cloud.google.com/), create a
   project (or reuse one).
2. **APIs & Services → Library** → enable **Photos Picker API**.
3. **APIs & Services → OAuth consent screen** → set it up as *External*, and
   add your own Google account under **Test users**.
4. **Credentials → Create credentials → OAuth client ID → Web application**.
   Under *Authorized JavaScript origins* add
   `https://jj-12.github.io` (the page shows the exact origin to use).
5. Copy the client ID into the app's *Google Photos* panel and tap
   **Pick photos**.

Some browsers block the authenticated cross-origin download of the picked
photos. If that happens the app says so — save the album to your device and use
*Choose photos* instead.

## Known limits

- Photos live in the tab for the session. Reloading means re-adding them
  (alignment is remembered, so it is quick).
- HEIC files only decode in Safari. Elsewhere, export JPEGs from Photos first.
- Video export records in real time — a 30-second timelapse takes about 30
  seconds and needs the tab in front. Browsers that cannot record fall back to
  the frames `.zip`.
- Faces only. For anything else — a growing tree, a building — place the two
  markers by hand on any pair of fixed points; the rest of the pipeline does
  not care what they are.
