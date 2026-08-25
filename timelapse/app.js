/* ========================================
   Aligned Timelapse

   Give it a pile of photos taken over years; it finds your face in each
   one, pins your eyes to the same two points on the canvas, and flips
   through them. The face stays still while hair, houses and decades move.

   Pipeline
     import   photos in (files or Google Photos), EXIF date, thumbnail
     detect   MediaPipe Face Landmarker -> two eye anchors per photo
     build    anchors -> similarity transform -> shared crop -> baked JPEGs
     play     flip through the baked frames; export records the same walk

   The geometry lives in align.js (pure, unit tested); this file is the
   browser half: decoding, canvases, controls, recording.
   ======================================== */

const VERSION = 'v2';
const VISION_CDN = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14';
const MODEL_URL =
  'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task';

const {
  transformFor, smoothTransforms, compose, toCanvas,
  scaleOf, targetAnchors, timelineAt, frameStarts, totalDurationMs,
  orderPhotos, parseExifDate, pickFace, landmarksToAnchors, normalizeAnchors,
  candidateRegions, mergeFaces, anchorExtents, autoFraming, coversFrame,
  medianAspect, FILL_AT,
} = window.Align;

const MAX_DETECT_PX = 1280;   // faces resolve fine at this size, and it is quick
const CROP_DETECT_PX = 640;   // detector input size when searching a crop
const MAX_CROP_TRIES = 14;    // give up rather than grind through every tile
const PREVIEW_CACHE = 24;     // decoded playback frames held in memory
const EXPORT_FPS = 30;        // video frame rate; photos hold for several frames

/* ============ settings ============ */

const DEFAULT_SETTINGS = {
  // 0 = show whole photos, 60 = they fill the frame, 100 = close-up.
  zoomPct: 0,
  nudgeYPct: 0,
  stabilizePct: 35,
  levelEyes: true,
  background: 'blur',
  fps: 8,
  crossfadeMs: 0,
  holdFirstMs: 0,
  holdLastMs: 800,
  loop: true,
  aspect: 'auto',
  quality: 1080,
  clientId: '',
};

const SETTINGS_KEY = 'timelapse:settings:v1';
const ANCHORS_KEY = 'timelapse:anchors:v1';

function loadSettings() {
  try {
    return { ...DEFAULT_SETTINGS, ...JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}') };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

function saveSettings() {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch { /* private mode */ }
}

// Anchors are worth keeping: re-importing the same photos after a reload
// should not mean re-running detection over hundreds of photos, nor
// placing every manual marker again.
function loadSavedAnchors() {
  try {
    return JSON.parse(localStorage.getItem(ANCHORS_KEY) || '{}');
  } catch {
    return {};
  }
}

function rememberAnchors(photo) {
  if (!photo.anchors) return;
  savedAnchors[photo.key] = {
    left: photo.anchors.left,
    right: photo.anchors.right,
    source: photo.anchorSource || 'manual',
  };
  try {
    localStorage.setItem(ANCHORS_KEY, JSON.stringify(savedAnchors));
  } catch { /* quota - not worth interrupting the user */ }
}

const settings = loadSettings();
const savedAnchors = loadSavedAnchors();

/* ============ state ============ */

const photos = [];          // see makePhoto() for the shape
let nextId = 1;
let framesDirty = true;     // baked frames no longer match the settings
let building = null;        // in-flight build token
let detecting = false;
let cancelDetect = false;
let faceLandmarker = null;
let playing = false;
let playhead = 0;           // ms into the timeline
let lastTick = 0;
let currentIndex = 0;
let editorIndex = -1;

/** True once the zoom control is asking for photos that fill the frame. */
function wantsFullFrame() {
  return settings.zoomPct / 100 >= FILL_AT - 0.02;
}

/** Zoom slider readout: the position matters more than the number. */
function describeZoom(value) {
  const z = Number(value) / 100;
  if (z <= 0.001) return 'whole photos';
  if (z < FILL_AT - 0.02) return 'mostly whole';
  if (z <= FILL_AT + 0.02) return 'fills the frame';
  return z > 0.9 ? 'close-up' : 'cropped in';
}

const el = (id) => document.getElementById(id);
const dom = {
  importView: el('import-view'), studioView: el('studio-view'), editorView: el('editor-view'),
  dropzone: el('dropzone'), fileInput: el('file-input'), chooseBtn: el('choose-btn'),
  gphotosBtn: el('gphotos-btn'), gphotosPanel: el('gphotos-panel'), gphotosStatus: el('gphotos-status'),
  gphotosStart: el('gphotos-start'), gphotosClose: el('gphotos-close'), clientId: el('client-id'),
  originLabel: el('origin-label'), importStatus: el('import-status'),
  stage: el('stage-canvas'), caption: el('stage-caption'), badge: el('stage-badge'),
  playBtn: el('play-btn'), scrub: el('scrub'), timeLabel: el('time-label'),
  filmstrip: el('filmstrip'), photosSummary: el('photos-summary'),
  buildProgress: el('build-progress'), buildBar: el('build-bar'), buildLabel: el('build-label'),
  buildCancel: el('build-cancel'), durationLabel: el('duration-label'),
  exportStatus: el('export-status'), toast: el('toast'),
  editorCanvas: el('editor-canvas'), loupe: el('loupe'), editorTitle: el('editor-title'),
};

const stageCtx = dom.stage.getContext('2d');

/* ============ small helpers ============ */

function show(view) {
  for (const v of [dom.importView, dom.studioView, dom.editorView]) v.classList.add('hidden');
  view.classList.remove('hidden');
  // A hidden element has no box, so the stage can only be measured once it
  // is actually on screen.
  if (view === dom.studioView) {
    requestAnimationFrame(() => {
      if (sizeStage()) previewCache.clear();
      renderPreview();
    });
  }
}

let toastTimer = 0;
function toast(message, ms = 3200) {
  dom.toast.textContent = message;
  dom.toast.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => dom.toast.classList.add('hidden'), ms);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

function formatDate(ms) {
  if (!Number.isFinite(ms)) return '';
  return new Date(ms).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

function outputSize() {
  const short = Number(settings.quality);
  let ratio;
  if (settings.aspect === 'auto') {
    // Match the photos rather than imposing a shape on them: a set of
    // landscape shots in a portrait frame is mostly background.
    const median = medianAspect(photos.filter((p) => p.width && p.height));
    ratio = clamp(median || 0.8, 0.5, 2);
  } else {
    const [w, h] = settings.aspect.split(':').map(Number);
    ratio = w / h;
  }
  const even = (n) => Math.max(2, Math.round(n / 2) * 2);
  return ratio >= 1
    ? { width: even(short * ratio), height: even(short) }
    : { width: even(short), height: even(short / ratio) };
}

/** Per-photo reach beyond its anchors, the input to the shared framing. */
function extentsFor(list, levelEyes) {
  return list.map((p) => anchorExtents(p.anchors, { width: p.width, height: p.height }, levelEyes));
}

/** The framing the whole set gets, derived from the zoom control. */
function framing() {
  const plan = computePlan();
  return plan.framing;
}

function timing() {
  return {
    fps: settings.fps,
    crossfadeMs: settings.crossfadeMs,
    holdFirstMs: settings.holdFirstMs,
    holdLastMs: settings.holdLastMs,
  };
}

const readyPhotos = () => photos.filter((p) => p.status === 'ready' && p.anchors);

/* ============ decoding ============ */

/**
 * Decode a photo, optionally downscaled. Returns the bitmap plus the scale
 * it was decoded at, because every transform is expressed in full-size
 * image pixels and has to be corrected for the decode.
 */
async function decodeBlob(blob, targetWidth) {
  if (window.createImageBitmap) {
    const options = { imageOrientation: 'from-image' };
    if (targetWidth) {
      options.resizeWidth = Math.max(1, Math.round(targetWidth));
      options.resizeQuality = 'high';
    }
    try {
      return await createImageBitmap(blob, options);
    } catch {
      try {
        return await createImageBitmap(blob);
      } catch { /* fall through to <img> */ }
    }
  }
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    img.src = url;
    await (img.decode ? img.decode() : new Promise((res, rej) => { img.onload = res; img.onerror = rej; }));
    return img;
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  }
}

const sizeOf = (src) => ({
  width: src.naturalWidth || src.width,
  height: src.naturalHeight || src.height,
});

function closeBitmap(src) {
  if (src && typeof src.close === 'function') src.close();
}

/* ============ drawing ============ */

const scratch = [document.createElement('canvas'), document.createElement('canvas')];

/**
 * Halve repeatedly until the final drawImage is scaling by no less than a
 * half - browsers alias badly past that, and a 4000px photo drawn straight
 * into a 1080px frame sparkles.
 *
 * @param wantedScale - canvas pixels per pixel of `source` in the final draw
 * @returns the (possibly reduced) source and its scale relative to the
 *   original, which the caller folds into the transform
 */
function stepDown(source, wantedScale) {
  const start = sizeOf(source);
  let src = source;
  let scale = 1;
  let slot = 0;
  // Note the direction: each halving makes `scale` smaller, which makes the
  // remaining draw factor (wantedScale / scale) bigger, so this terminates.
  while (wantedScale / scale < 0.5 && Math.min(sizeOf(src).width, sizeOf(src).height) > 16) {
    const cur = sizeOf(src);
    const w = Math.max(1, Math.round(cur.width / 2));
    const h = Math.max(1, Math.round(cur.height / 2));
    const canvas = scratch[slot % 2];
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.clearRect(0, 0, w, h);
    ctx.drawImage(src, 0, 0, w, h);
    src = canvas;
    scale = w / start.width;
    slot++;
  }
  return { source: src, scale };
}

const scaleOnly = (k) => ({ a: k, b: 0, tx: 0, ty: 0 });

/**
 * Draw one photo through its alignment transform.
 * @param sourceScale - bitmap pixels per full-size image pixel
 */
function drawAligned(ctx, source, transform, sourceScale = 1, alpha = 1) {
  // The transform is expressed in original-photo pixels; `source` may have
  // been decoded smaller, so the draw scales by transform / sourceScale.
  const { source: src, scale: step } = stepDown(source, scaleOf(transform) / sourceScale);
  const total = sourceScale * step;
  const m = compose(transform, scaleOnly(1 / total));

  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.setTransform(...toCanvas(m));
  ctx.drawImage(src, 0, 0);
  ctx.restore();
}

/** Whatever shows through where the photo does not reach. */
function paintBackground(ctx, source, size, mode) {
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  if (mode === 'white' || mode === 'black') {
    ctx.fillStyle = mode === 'white' ? '#ffffff' : '#000000';
    ctx.fillRect(0, 0, size.width, size.height);
    return;
  }
  ctx.fillStyle = '#000000';
  ctx.fillRect(0, 0, size.width, size.height);
  const s = sizeOf(source);
  const cover = Math.max(size.width / s.width, size.height / s.height) * 1.2;
  const w = s.width * cover;
  const h = s.height * cover;
  ctx.save();
  try {
    ctx.filter = 'blur(28px)';
  } catch { /* filter unsupported: a plain stretched fill still reads fine */ }
  ctx.globalAlpha = 0.85;
  ctx.drawImage(source, (size.width - w) / 2, (size.height - h) / 2, w, h);
  ctx.restore();
}

/* ============ import ============ */

function makePhoto({ name, blob, timeMs, source }) {
  return {
    id: nextId++,
    key: `${name}:${blob.size}`,
    name,
    blob,
    timeMs,
    source: source || 'file',
    width: 0,
    height: 0,
    thumb: null,
    faces: [],
    faceIndex: -1,
    anchors: null,
    anchorSource: null,
    status: 'pending',   // pending | ready | noface | error | skipped
    frame: null,         // baked JPEG blob
    gap: false,          // true when the aligned frame does not fill the canvas
  };
}

async function addFiles(fileList) {
  const files = [...fileList].filter((f) => /^image\//.test(f.type) || /\.(jpe?g|png|heic|heif|webp)$/i.test(f.name));
  if (!files.length) {
    toast('Those files are not photos.');
    return;
  }
  const incoming = files.map((f) => ({ name: f.name, blob: f, timeMs: f.lastModified, source: 'file' }));
  await addPhotos(incoming);
}

async function addPhotos(list) {
  const existing = new Set(photos.map((p) => p.key));
  let added = 0;
  for (const item of list) {
    const key = `${item.name}:${item.blob.size}`;
    if (existing.has(key)) continue;
    existing.add(key);
    const photo = makePhoto(item);
    // EXIF beats the file timestamp: copying photos around resets file dates,
    // and 8 years of progress shots are worthless in the wrong order.
    const exif = await readExifDate(item.blob);
    if (Number.isFinite(exif)) photo.timeMs = exif;
    photos.push(photo);
    added++;
  }
  if (!added) {
    toast('Those photos are already loaded.');
    return;
  }
  sortPhotos();
  show(dom.studioView);
  renderFilmstrip();
  invalidateFrames();
  await runDetection();
}

async function readExifDate(blob) {
  try {
    const head = await blob.slice(0, 256 * 1024).arrayBuffer();
    return parseExifDate(new Uint8Array(head));
  } catch {
    return null;
  }
}

function sortPhotos() {
  const sorted = orderPhotos(photos);
  photos.length = 0;
  photos.push(...sorted);
}

/* ============ face detection ============ */

async function ensureModel() {
  if (faceLandmarker) return faceLandmarker;
  const { FaceLandmarker, FilesetResolver } = await import(`${VISION_CDN}/vision_bundle.mjs`);
  const fileset = await FilesetResolver.forVisionTasks(`${VISION_CDN}/wasm`);
  const options = {
    baseOptions: { modelAssetPath: MODEL_URL, delegate: 'GPU' },
    runningMode: 'IMAGE',
    numFaces: 5,
  };
  try {
    faceLandmarker = await FaceLandmarker.createFromOptions(fileset, options);
  } catch {
    options.baseOptions.delegate = 'CPU';
    faceLandmarker = await FaceLandmarker.createFromOptions(fileset, options);
  }
  return faceLandmarker;
}

async function runDetection(force = false) {
  if (force) {
    // A re-detect means "forget what you knew", including manual markers.
    for (const photo of photos) {
      delete savedAnchors[photo.key];
      photo.status = 'pending';
    }
    try { localStorage.setItem(ANCHORS_KEY, JSON.stringify(savedAnchors)); } catch { /* quota */ }
  }
  if (detecting) return;              // the running pass will pick these up
  if (!photos.some((p) => p.status === 'pending')) return;

  detecting = true;
  cancelDetect = false;

  let model = null;
  try {
    model = await ensureModel();
  } catch (err) {
    console.warn(err);
    toast('Face detection is offline - place the eye markers by hand instead.');
  }

  // A queue rather than a snapshot: photos dropped in while this runs join
  // the same pass instead of sitting at "pending" forever.
  let done = 0;
  for (;;) {
    if (cancelDetect) break;
    const photo = photos.find((p) => p.status === 'pending');
    if (!photo) break;
    const remaining = photos.filter((p) => p.status === 'pending').length;
    progress(done, done + remaining, `Finding faces ${done + 1}/${done + remaining}`);
    try {
      await analyzePhoto(photo, model, force);
    } catch (err) {
      console.warn('analyze failed', photo.name, err);
      photo.status = 'error';
    }
    done++;
    renderFilmstrip();
    if (done === 1) renderPreview();
    await sleep(0); // let the UI breathe between photos
  }

  detecting = false;
  progress(null);
  invalidateFrames();
  renderFilmstrip();
  renderPreview();

  const missing = photos.filter((p) => p.status === 'noface').length;
  if (missing) toast(`${missing} photo${missing > 1 ? 's need' : ' needs'} manual eye markers - see Photos.`);
}

async function analyzePhoto(photo, model, ignoreSaved = false) {
  const full = await decodeBlob(photo.blob);
  const size = sizeOf(full);
  photo.width = size.width;
  photo.height = size.height;
  photo.thumb = await makeThumb(full);

  const saved = ignoreSaved ? null : savedAnchors[photo.key];
  if (saved) {
    // Known photo: skip the detector entirely, which is the slow part.
    photo.anchors = normalizeAnchors(saved);
    photo.anchorSource = saved.source === 'auto' ? 'auto' : 'manual';
    photo.status = 'ready';
    closeBitmap(full);
    return;
  }

  // The previous photo's face guides both where to look and which face to
  // keep when several people are in shot.
  const previous = lastAlignedBefore(photo);
  photo.faces = model ? detectFaces(model, full, size, previous) : [];

  if (photo.faces.length) {
    const index = pickFace(photo.faces, previous);
    photo.faceIndex = index;
    photo.anchors = index >= 0 ? photo.faces[index].anchors : null;
    photo.anchorSource = 'auto';
    photo.status = photo.anchors ? 'ready' : 'noface';
    if (photo.anchors) rememberAnchors(photo);
  } else {
    photo.anchors = null;
    photo.anchorSource = null;
    photo.status = 'noface';
  }

  closeBitmap(full);
}

function detectFaces(model, source, size, previous) {
  const whole = detectIn(model, source, { x: 0, y: 0, width: size.width, height: size.height }, MAX_DETECT_PX);
  if (whole.length) return whole;

  // Nothing at full frame: the face is probably small in a wide shot, so
  // search crops - most likely region first - and stop at the first hit.
  const regions = candidateRegions(size, previous).slice(0, MAX_CROP_TRIES);
  for (const region of regions) {
    const found = detectIn(model, source, region, CROP_DETECT_PX);
    if (found.length) return mergeFaces(found);
  }
  return [];
}

/** Run the detector over one rectangle of the photo, in full-size coords. */
function detectIn(model, source, region, maxPx) {
  const scale = Math.min(1, maxPx / Math.max(region.width, region.height));
  const canvas = scratch[0];
  canvas.width = Math.max(1, Math.round(region.width * scale));
  canvas.height = Math.max(1, Math.round(region.height * scale));
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(source, region.x, region.y, region.width, region.height, 0, 0, canvas.width, canvas.height);

  let result;
  try {
    result = model.detect(canvas);
  } catch (err) {
    console.warn('detector failed on a region', err);
    return [];
  }

  const faces = [];
  for (const landmarks of result.faceLandmarks || []) {
    // Landmarks are normalized to the crop; shift them back into the photo.
    const local = landmarksToAnchors(landmarks, { width: region.width, height: region.height });
    if (!local) continue;
    faces.push({
      anchors: {
        left: { x: local.left.x + region.x, y: local.left.y + region.y },
        right: { x: local.right.x + region.x, y: local.right.y + region.y },
      },
    });
  }
  return faces;
}

/** The nearest already-aligned photo before this one, for face continuity. */
function lastAlignedBefore(photo) {
  const index = photos.indexOf(photo);
  for (let i = index - 1; i >= 0; i--) {
    const p = photos[i];
    if (p.anchors && p.status === 'ready') return { anchors: p.anchors, image: { width: p.width, height: p.height } };
  }
  return null;
}

async function makeThumb(source) {
  const size = sizeOf(source);
  const scale = Math.min(1, 220 / Math.max(size.width, size.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(size.width * scale));
  canvas.height = Math.max(1, Math.round(size.height * scale));
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
  return canvas;
}

/* ============ build (bake aligned frames) ============ */

function invalidateFrames() {
  framesDirty = true;
  if (building) building.cancelled = true;
  stopPlayback();
  updateTransport();
  renderPreview();
}

/**
 * Everything the renderer needs for the current settings: one framing for
 * the whole set, and the transform that puts each photo into it.
 */
function computePlan() {
  const list = readyPhotos();
  const size = outputSize();
  const levelEyes = settings.levelEyes;

  const extents = extentsFor(list, levelEyes);
  const auto = autoFraming(extents, size, {
    zoom: settings.zoomPct / 100,
    nudgeY: settings.nudgeYPct / 100,
  });
  const shared = { ...auto, roll: 0, levelEyes };

  const base = list.map((p) => transformFor(p.anchors, size, shared));
  const target = targetAnchors(size, shared);
  // The stabilize slider buys drift, not blur. The budget is measured
  // against the face rather than the frame: detector noise is a fraction of
  // the eye spacing, and at the whole-photo end of the zoom a face can be a
  // small part of a big frame, where a frame-relative budget would let it
  // wobble wildly.
  const spanPx = shared.eyeSpan * size.width;
  const transforms = smoothTransforms(base, {
    strength: 0.6,
    radius: 2,
    maxShift: Math.min((settings.stabilizePct / 100) * spanPx * 0.15, size.width * 0.03),
    probes: [target.left, target.right],
  });

  return {
    size,
    list,
    framing: shared,
    transforms,
    gaps: extents.map((e) => !coversFrame(e, shared, size)),
  };
}

async function buildFrames() {
  if (!framesDirty && readyPhotos().every((p) => p.frame)) return true;
  if (building) building.cancelled = true;

  const token = { cancelled: false };
  building = token;
  const plan = computePlan();
  if (!plan.list.length) {
    building = null;
    return false;
  }

  const canvas = document.createElement('canvas');
  canvas.width = plan.size.width;
  canvas.height = plan.size.height;
  const ctx = canvas.getContext('2d');

  for (let i = 0; i < plan.list.length; i++) {
    if (token.cancelled) { building = null; progress(null); return false; }
    const photo = plan.list[i];
    progress(i, plan.list.length, `Aligning ${i + 1}/${plan.list.length}`);

    const transform = plan.transforms[i];
    // Decode only as many pixels as the output frame can show.
    const wanted = clamp(Math.round(photo.width * scaleOf(transform) * 1.2), 64, photo.width);
    const source = await decodeBlob(photo.blob, wanted < photo.width ? wanted : 0);
    const sourceScale = sizeOf(source).width / photo.width;

    paintBackground(ctx, source, plan.size, settings.background);
    drawAligned(ctx, source, transform, sourceScale, 1);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    closeBitmap(source);

    photo.frame = await canvasToBlob(canvas, 'image/jpeg', 0.9);
    photo.gap = plan.gaps[i];
    await sleep(0);
  }

  building = null;
  framesDirty = false;
  progress(null);
  previewCache.clear();
  updateTransport();
  return true;
}

function canvasToBlob(canvas, type, quality) {
  return new Promise((resolve) => canvas.toBlob(resolve, type, quality));
}

function progress(done, total, label) {
  if (done === null) {
    dom.buildProgress.classList.add('hidden');
    return;
  }
  dom.buildProgress.classList.remove('hidden');
  dom.buildBar.style.width = `${total ? (done / total) * 100 : 0}%`;
  dom.buildLabel.textContent = label || '';
}

/* ============ preview & playback ============ */

const previewCache = new Map(); // photo id -> ImageBitmap at stage resolution
const originalCache = new Map(); // photo id -> {source, scale} for live framing

/** Match the canvas to the space it has; returns true if it changed. */
function sizeStage() {
  const size = outputSize();
  const box = dom.stage.parentElement.getBoundingClientRect();
  if (box.width < 4 || box.height < 4) return false;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const fit = Math.min(box.width / size.width, box.height / size.height, 1);
  const width = Math.max(2, Math.round(size.width * fit * dpr));
  const height = Math.max(2, Math.round(size.height * fit * dpr));
  dom.stage.style.aspectRatio = `${size.width} / ${size.height}`;
  if (width === dom.stage.width && height === dom.stage.height) return false;
  dom.stage.width = width;
  dom.stage.height = height;
  return true;
}

/** Paused view: render straight from the original so the sliders feel live. */
async function renderPreview() {
  if (playing) return;
  if (sizeStage()) previewCache.clear();
  const list = readyPhotos();
  updateTransport();
  if (!list.length) {
    stageCtx.setTransform(1, 0, 0, 1, 0, 0);
    stageCtx.clearRect(0, 0, dom.stage.width, dom.stage.height);
    dom.caption.textContent = photos.length ? 'No aligned photos yet' : '';
    return;
  }
  currentIndex = clamp(currentIndex, 0, list.length - 1);
  const photo = list[currentIndex];
  const plan = computePlan();
  const index = plan.list.indexOf(photo);
  if (index < 0) return;

  const cached = await getOriginal(photo);
  if (!cached) return;

  const stageSize = { width: dom.stage.width, height: dom.stage.height };
  const fit = stageSize.width / plan.size.width;
  const transform = compose(scaleOnly(fit), plan.transforms[index]);

  paintBackground(stageCtx, cached.source, stageSize, settings.background);
  drawAligned(stageCtx, cached.source, transform, cached.scale, 1);
  stageCtx.setTransform(1, 0, 0, 1, 0, 0);

  dom.caption.textContent = formatDate(photo.timeMs) || photo.name;
  // Background around a photo is the point below "fills the frame", so it
  // is only worth flagging once the user has asked for a filled frame.
  dom.badge.textContent = 'shows edges';
  dom.badge.classList.toggle('hidden', !(wantsFullFrame() && plan.gaps[index]));
}

async function getOriginal(photo) {
  if (originalCache.has(photo.id)) return originalCache.get(photo.id);
  try {
    const wanted = clamp(Math.round(dom.stage.width * 2), 320, photo.width || 4096);
    const source = await decodeBlob(photo.blob, photo.width && wanted < photo.width ? wanted : 0);
    const entry = { source, scale: sizeOf(source).width / (photo.width || sizeOf(source).width) };
    originalCache.set(photo.id, entry);
    while (originalCache.size > 3) {
      const [oldId, old] = originalCache.entries().next().value;
      originalCache.delete(oldId);
      closeBitmap(old.source);
    }
    return entry;
  } catch (err) {
    console.warn('decode failed', photo.name, err);
    return null;
  }
}

async function frameBitmap(photo) {
  if (previewCache.has(photo.id)) return previewCache.get(photo.id);
  if (!photo.frame) return null;
  const bmp = await decodeBlob(photo.frame, dom.stage.width);
  previewCache.set(photo.id, bmp);
  while (previewCache.size > PREVIEW_CACHE) {
    const [oldId, old] = previewCache.entries().next().value;
    previewCache.delete(oldId);
    closeBitmap(old);
  }
  return bmp;
}

async function startPlayback() {
  const list = readyPhotos();
  if (list.length < 2) {
    toast('Add at least two aligned photos.');
    return;
  }
  if (framesDirty || !list.every((p) => p.frame)) {
    const ok = await buildFrames();
    if (!ok) return;
  }
  if (playhead >= totalDurationMs(readyPhotos().length, timing())) playhead = 0;
  playing = true;
  lastTick = performance.now();
  dom.playBtn.innerHTML = '&#10074;&#10074;';
  dom.playBtn.setAttribute('aria-label', 'Pause');
  requestAnimationFrame(tick);
}

function stopPlayback() {
  playing = false;
  dom.playBtn.innerHTML = '&#9654;';
  dom.playBtn.setAttribute('aria-label', 'Play');
}

function tick(now) {
  if (!playing) return;
  const list = readyPhotos();
  const total = totalDurationMs(list.length, timing());
  playhead += now - lastTick;
  lastTick = now;

  if (playhead >= total) {
    if (settings.loop) {
      playhead = 0;
    } else {
      playhead = total;
      stopPlayback();
      renderPlayhead(list);
      return;
    }
  }
  renderPlayhead(list);
  requestAnimationFrame(tick);
}

let drawing = false;
async function renderPlayhead(list) {
  const spot = timelineAt(playhead, list.length, timing());
  currentIndex = spot.a;
  dom.scrub.value = String(spot.a);
  const photo = list[spot.a];
  dom.caption.textContent = formatDate(photo.timeMs) || photo.name;
  dom.timeLabel.textContent = `${spot.a + 1} / ${list.length}`;
  dom.badge.classList.toggle('hidden', !(wantsFullFrame() && photo.gap));

  if (drawing) return;
  drawing = true;
  try {
    const a = await frameBitmap(photo);
    if (a) {
      stageCtx.setTransform(1, 0, 0, 1, 0, 0);
      stageCtx.globalAlpha = 1;
      stageCtx.drawImage(a, 0, 0, dom.stage.width, dom.stage.height);
      if (spot.mix > 0 && spot.b !== spot.a) {
        const b = await frameBitmap(list[spot.b]);
        if (b) {
          stageCtx.globalAlpha = spot.mix;
          stageCtx.drawImage(b, 0, 0, dom.stage.width, dom.stage.height);
          stageCtx.globalAlpha = 1;
        }
      }
    }
    // Decode a little ahead so the next flip is instant.
    const ahead = list[spot.a + 1];
    if (ahead) frameBitmap(ahead);
  } finally {
    drawing = false;
  }
}

function updateTransport() {
  const list = readyPhotos();
  dom.scrub.max = String(Math.max(0, list.length - 1));
  dom.scrub.value = String(clamp(currentIndex, 0, Math.max(0, list.length - 1)));
  dom.timeLabel.textContent = list.length ? `${clamp(currentIndex, 0, list.length - 1) + 1} / ${list.length}` : '0 / 0';
  const secs = totalDurationMs(list.length, timing()) / 1000;
  dom.durationLabel.textContent = list.length
    ? `${list.length} photos - ${secs.toFixed(1)}s of video`
    : 'No aligned photos yet.';
  dom.photosSummary.textContent = summarize();
}

function summarize() {
  const ready = photos.filter((p) => p.status === 'ready').length;
  const missing = photos.filter((p) => p.status === 'noface').length;
  const skipped = photos.filter((p) => p.status === 'skipped').length;
  const failed = photos.filter((p) => p.status === 'error').length;
  const bits = [`${ready} aligned`];
  if (missing) bits.push(`${missing} need markers`);
  if (skipped) bits.push(`${skipped} skipped`);
  if (failed) bits.push(`${failed} unreadable`);
  return bits.join(' - ');
}

/* ============ filmstrip ============ */

function renderFilmstrip() {
  dom.filmstrip.innerHTML = '';
  for (const photo of photos) {
    const item = document.createElement('div');
    item.className = `strip-item status-${photo.status}`;
    item.title = photo.name;

    if (photo.thumb) {
      const thumb = photo.thumb.cloneNode();
      thumb.getContext('2d').drawImage(photo.thumb, 0, 0);
      thumb.className = 'strip-thumb';
      item.appendChild(thumb);
      if (photo.anchors) markAnchors(thumb, photo);
    } else {
      const blank = document.createElement('div');
      blank.className = 'strip-thumb blank';
      item.appendChild(blank);
    }

    const label = document.createElement('span');
    label.className = 'strip-label';
    label.textContent = formatDate(photo.timeMs) || photo.name;
    item.appendChild(label);

    const badge = document.createElement('span');
    badge.className = 'strip-badge';
    badge.textContent = {
      pending: '…', ready: photo.anchorSource === 'manual' ? 'set' : 'auto',
      noface: 'no face', error: 'error', skipped: 'skipped',
    }[photo.status] || '';
    item.appendChild(badge);

    const remove = document.createElement('button');
    remove.className = 'strip-remove';
    remove.innerHTML = '&times;';
    remove.title = 'Remove photo';
    remove.addEventListener('click', (e) => {
      e.stopPropagation();
      removePhoto(photo);
    });
    item.appendChild(remove);

    item.addEventListener('click', () => openEditor(photos.indexOf(photo)));
    dom.filmstrip.appendChild(item);
  }
  updateTransport();
}

function markAnchors(canvas, photo) {
  const ctx = canvas.getContext('2d');
  const scale = canvas.width / photo.width;
  ctx.fillStyle = '#3ddc97';
  for (const p of [photo.anchors.left, photo.anchors.right]) {
    ctx.beginPath();
    ctx.arc(p.x * scale, p.y * scale, 2.5, 0, Math.PI * 2);
    ctx.fill();
  }
}

function removePhoto(photo) {
  const index = photos.indexOf(photo);
  if (index < 0) return;
  photos.splice(index, 1);
  closeBitmap(previewCache.get(photo.id));
  previewCache.delete(photo.id);
  originalCache.delete(photo.id);
  invalidateFrames();
  renderFilmstrip();
  if (!photos.length) show(dom.importView);
}

/* ============ anchor editor ============ */

const editor = {
  source: null,
  scale: 1,      // canvas px per full-size image px
  offset: { x: 0, y: 0 },
  anchors: null,
  dragging: null,
};

async function openEditor(index) {
  const photo = photos[index];
  if (!photo) return;
  if (!photo.width || !photo.height) {
    toast('That photo is still being read.');
    return;
  }
  editorIndex = index;
  stopPlayback();
  show(dom.editorView);
  dom.editorTitle.textContent = `${formatDate(photo.timeMs) || photo.name}`;

  const cached = await getOriginal(photo);
  if (!cached) {
    toast('That photo could not be decoded.');
    show(dom.studioView);
    return;
  }
  editor.source = cached.source;
  editor.anchors = photo.anchors
    ? { left: { ...photo.anchors.left }, right: { ...photo.anchors.right } }
    : defaultAnchors(photo);
  layoutEditor(photo);
  drawEditor(photo);
}

/** A first guess when nothing was detected: eye-height, third-width apart. */
function defaultAnchors(photo) {
  return {
    left: { x: photo.width * 0.38, y: photo.height * 0.4 },
    right: { x: photo.width * 0.62, y: photo.height * 0.4 },
  };
}

function layoutEditor(photo) {
  const stage = dom.editorCanvas.parentElement.getBoundingClientRect();
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const fit = Math.min(stage.width / photo.width, stage.height / photo.height);
  dom.editorCanvas.style.width = `${photo.width * fit}px`;
  dom.editorCanvas.style.height = `${photo.height * fit}px`;
  dom.editorCanvas.width = Math.round(photo.width * fit * dpr);
  dom.editorCanvas.height = Math.round(photo.height * fit * dpr);
  editor.scale = (photo.width * fit * dpr) / photo.width;
}

function drawEditor(photo) {
  const ctx = dom.editorCanvas.getContext('2d');
  const { width, height } = dom.editorCanvas;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, width, height);
  ctx.drawImage(editor.source, 0, 0, width, height);

  const pts = [editor.anchors.left, editor.anchors.right];
  ctx.strokeStyle = 'rgba(61, 220, 151, 0.9)';
  ctx.lineWidth = Math.max(1, width / 400);
  ctx.beginPath();
  ctx.moveTo(pts[0].x * editor.scale, pts[0].y * editor.scale);
  ctx.lineTo(pts[1].x * editor.scale, pts[1].y * editor.scale);
  ctx.stroke();
  pts.forEach((p, i) => {
    const x = p.x * editor.scale;
    const y = p.y * editor.scale;
    const r = Math.max(6, width / 60);
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.strokeStyle = i === 0 ? '#3ddc97' : '#ffd166';
    ctx.lineWidth = Math.max(2, width / 220);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(x, y, 1.5, 0, Math.PI * 2);
    ctx.fillStyle = '#fff';
    ctx.fill();
  });
}

function editorPoint(event) {
  const rect = dom.editorCanvas.getBoundingClientRect();
  const dpr = dom.editorCanvas.width / rect.width;
  return {
    x: ((event.clientX - rect.left) * dpr) / editor.scale,
    y: ((event.clientY - rect.top) * dpr) / editor.scale,
  };
}

function nearestAnchor(point) {
  const dl = Math.hypot(point.x - editor.anchors.left.x, point.y - editor.anchors.left.y);
  const dr = Math.hypot(point.x - editor.anchors.right.x, point.y - editor.anchors.right.y);
  return dl <= dr ? 'left' : 'right';
}

function drawLoupe(event, point) {
  const photo = photos[editorIndex];
  if (!photo) return;
  const loupe = dom.loupe;
  const ctx = loupe.getContext('2d');
  const zoom = 4;
  const size = loupe.width;
  const src = sizeOf(editor.source);
  const sx = (point.x / photo.width) * src.width;
  const sy = (point.y / photo.height) * src.height;
  const half = size / (2 * zoom);

  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, size, size);
  ctx.save();
  ctx.beginPath();
  ctx.arc(size / 2, size / 2, size / 2 - 2, 0, Math.PI * 2);
  ctx.clip();
  ctx.drawImage(editor.source, sx - half, sy - half, half * 2, half * 2, 0, 0, size, size);
  ctx.strokeStyle = 'rgba(61, 220, 151, 0.95)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(size / 2, 0); ctx.lineTo(size / 2, size);
  ctx.moveTo(0, size / 2); ctx.lineTo(size, size / 2);
  ctx.stroke();
  ctx.restore();

  const rect = dom.editorCanvas.getBoundingClientRect();
  const top = event.clientY - rect.top < rect.height / 2;
  loupe.style.left = `${clamp(event.clientX - rect.left - size / 2, 0, rect.width - size)}px`;
  loupe.style.top = top ? `${rect.height - size - 8}px` : '8px';
  loupe.classList.remove('hidden');
}

function bindEditor() {
  const canvas = dom.editorCanvas;
  const move = (event) => {
    if (!editor.dragging) return;
    event.preventDefault();
    const point = editorPoint(event);
    const photo = photos[editorIndex];
    editor.anchors[editor.dragging] = {
      x: clamp(point.x, 0, photo.width),
      y: clamp(point.y, 0, photo.height),
    };
    drawEditor(photo);
    drawLoupe(event, editor.anchors[editor.dragging]);
  };

  canvas.addEventListener('pointerdown', (event) => {
    if (editorIndex < 0) return;
    canvas.setPointerCapture(event.pointerId);
    editor.dragging = nearestAnchor(editorPoint(event));
    move(event);
  });
  canvas.addEventListener('pointermove', move);
  const end = () => {
    editor.dragging = null;
    dom.loupe.classList.add('hidden');
  };
  canvas.addEventListener('pointerup', end);
  canvas.addEventListener('pointercancel', end);

  el('editor-back').addEventListener('click', () => { show(dom.studioView); renderPreview(); });
  el('editor-done').addEventListener('click', saveEditor);
  el('editor-skip').addEventListener('click', () => {
    const photo = photos[editorIndex];
    photo.status = 'skipped';
    photo.anchors = null;
    finishEditor();
  });
  el('editor-next-face').addEventListener('click', () => {
    const photo = photos[editorIndex];
    if (!photo.faces.length) {
      toast('No other faces were detected here.');
      return;
    }
    photo.faceIndex = (photo.faceIndex + 1) % photo.faces.length;
    editor.anchors = { ...photo.faces[photo.faceIndex].anchors };
    drawEditor(photo);
  });
  el('editor-auto').addEventListener('click', async () => {
    const photo = photos[editorIndex];
    try {
      const model = await ensureModel();
      photo.status = 'pending';
      delete savedAnchors[photo.key];
      await analyzePhoto(photo, model, force);
      editor.anchors = photo.anchors ? { ...photo.anchors } : defaultAnchors(photo);
      drawEditor(photo);
      toast(photo.anchors ? 'Face found.' : 'Still no face here - place the markers by hand.');
    } catch {
      toast('Face detection is unavailable right now.');
    }
  });
}

function saveEditor() {
  const photo = photos[editorIndex];
  if (!photo) return;
  photo.anchors = normalizeAnchors(editor.anchors);
  photo.anchorSource = 'manual';
  photo.status = 'ready';
  rememberAnchors(photo);
  finishEditor();
}

function finishEditor() {
  editorIndex = -1;
  invalidateFrames();
  renderFilmstrip();
  show(dom.studioView);
  renderPreview();
}

/* ============ export ============ */

function pickMime() {
  if (typeof MediaRecorder === 'undefined') return null;
  const candidates = [
    'video/mp4;codecs=avc1.42E01E',
    'video/mp4',
    'video/webm;codecs=vp9',
    'video/webm;codecs=vp8',
    'video/webm',
  ];
  return candidates.find((m) => {
    try { return MediaRecorder.isTypeSupported(m); } catch { return false; }
  }) || null;
}

function download(blob, filename) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 20000);
}

async function exportVideo() {
  const built = await buildFrames();
  const list = readyPhotos();
  if (!built || list.length < 2) {
    toast('Align at least two photos first.');
    return;
  }
  const mime = pickMime();
  if (!mime) {
    dom.exportStatus.textContent =
      'This browser cannot record video. Use "Export frames (.zip)" and assemble them in a video editor.';
    return;
  }

  stopPlayback();
  const size = outputSize();
  const canvas = document.createElement('canvas');
  canvas.width = size.width;
  canvas.height = size.height;
  const ctx = canvas.getContext('2d');

  const stream = canvas.captureStream(0);
  const track = stream.getVideoTracks()[0];
  const manual = typeof track.requestFrame === 'function';
  const recorder = new MediaRecorder(manual ? stream : canvas.captureStream(EXPORT_FPS), {
    mimeType: mime,
    videoBitsPerSecond: Math.round(size.width * size.height * 9),
  });
  const chunks = [];
  recorder.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
  const finished = new Promise((resolve) => { recorder.onstop = resolve; });

  const cache = new Map();
  const frameAt = async (photo) => {
    if (!cache.has(photo.id)) {
      cache.set(photo.id, await decodeBlob(photo.frame));
      for (const [id, bmp] of cache) {
        if (cache.size <= 4) break;
        cache.delete(id);
        closeBitmap(bmp);
      }
    }
    return cache.get(photo.id);
  };

  const total = totalDurationMs(list.length, timing());
  const step = 1000 / EXPORT_FPS;
  recorder.start();
  const started = performance.now();

  try {
    for (let t = 0; t <= total; t += step) {
      const spot = timelineAt(Math.min(t, total - 0.001), list.length, timing());
      const a = await frameAt(list[spot.a]);
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.globalAlpha = 1;
      ctx.drawImage(a, 0, 0, size.width, size.height);
      if (spot.mix > 0 && spot.b !== spot.a) {
        const b = await frameAt(list[spot.b]);
        ctx.globalAlpha = spot.mix;
        ctx.drawImage(b, 0, 0, size.width, size.height);
        ctx.globalAlpha = 1;
      }
      if (manual) track.requestFrame();
      dom.exportStatus.textContent = `Recording ${Math.round((t / total) * 100)}%…`;
      // Recorders timestamp by wall clock, so the walk has to happen in real time.
      const due = started + t + step;
      const wait = due - performance.now();
      if (wait > 0) await sleep(wait);
    }
  } finally {
    recorder.stop();
    await finished;
    for (const bmp of cache.values()) closeBitmap(bmp);
    stream.getTracks().forEach((t) => t.stop());
  }

  const blob = new Blob(chunks, { type: mime });
  const ext = mime.startsWith('video/mp4') ? 'mp4' : 'webm';
  download(blob, `timelapse-${Date.now()}.${ext}`);
  dom.exportStatus.textContent = `Saved ${(blob.size / 1e6).toFixed(1)} MB as .${ext}.`;
}

async function exportFrames() {
  const built = await buildFrames();
  const list = readyPhotos();
  if (!built || !list.length) {
    toast('Align some photos first.');
    return;
  }
  dom.exportStatus.textContent = 'Packing frames…';
  const entries = [];
  for (let i = 0; i < list.length; i++) {
    const bytes = new Uint8Array(await list[i].frame.arrayBuffer());
    entries.push({ name: `frame-${String(i + 1).padStart(4, '0')}.jpg`, data: bytes });
  }
  const zip = window.Zip.zipStore(entries, new Date());
  download(new Blob([zip], { type: 'application/zip' }), `timelapse-frames-${Date.now()}.zip`);
  dom.exportStatus.textContent =
    `Saved ${entries.length} aligned frames. In a video editor, import them as an image sequence at ${settings.fps} fps.`;
}

/* ============ controls ============ */

function bindControls() {
  const sliders = [
    ['ctl-zoom', 'zoomPct', 'out-zoom', describeZoom, true],
    ['ctl-nudge', 'nudgeYPct', 'out-nudge', (v) => (Number(v) ? `${v > 0 ? 'down' : 'up'} ${Math.abs(v)}%` : 'centred'), true],
    ['ctl-stab', 'stabilizePct', 'out-stab', (v) => `${v}%`, true],
    ['ctl-fps', 'fps', 'out-fps', (v) => `${v}/s`, false],
    ['ctl-xfade', 'crossfadeMs', 'out-xfade', (v) => (Number(v) ? `${v} ms` : 'none'), false],
    ['ctl-hold-first', 'holdFirstMs', 'out-hold-first', (v) => `${(v / 1000).toFixed(1)}s`, false],
    ['ctl-hold-last', 'holdLastMs', 'out-hold-last', (v) => `${(v / 1000).toFixed(1)}s`, false],
  ];

  for (const [id, key, outId, format, rebake] of sliders) {
    const input = el(id);
    const output = el(outId);
    input.value = String(settings[key]);
    output.textContent = format(settings[key]);
    input.addEventListener('input', () => {
      settings[key] = Number(input.value);
      output.textContent = format(settings[key]);
      saveSettings();
      if (rebake) {
        invalidateFrames();
      } else {
        updateTransport();
      }
    });
  }

  const selects = [
    ['ctl-background', 'background', true],
    ['ctl-aspect', 'aspect', true],
    ['ctl-quality', 'quality', true],
  ];
  for (const [id, key, rebake] of selects) {
    const input = el(id);
    input.value = String(settings[key]);
    input.addEventListener('change', () => {
      settings[key] = input.value;
      saveSettings();
      if (key === 'aspect' || key === 'quality') sizeStage();
      if (rebake) invalidateFrames();
    });
  }

  const level = el('ctl-level');
  level.checked = settings.levelEyes;
  level.addEventListener('change', () => {
    settings.levelEyes = level.checked;
    saveSettings();
    invalidateFrames();
  });

  const loop = el('ctl-loop');
  loop.checked = settings.loop;
  loop.addEventListener('change', () => {
    settings.loop = loop.checked;
    saveSettings();
  });

  for (const tab of document.querySelectorAll('.tab')) {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t === tab));
      document.querySelectorAll('.tab-panel').forEach((p) => {
        p.classList.toggle('hidden', p.dataset.panel !== tab.dataset.tab);
      });
    });
  }

  dom.playBtn.addEventListener('click', () => (playing ? stopPlayback() : startPlayback()));
  dom.scrub.addEventListener('input', () => {
    stopPlayback();
    currentIndex = Number(dom.scrub.value);
    const { starts } = frameStarts(readyPhotos().length, timing());
    playhead = starts[currentIndex] || 0;
    renderPreview();
  });
  dom.buildCancel.addEventListener('click', () => {
    if (building) building.cancelled = true;
    cancelDetect = true;
    progress(null);
  });

  el('export-video').addEventListener('click', () => {
    exportVideo().catch((err) => {
      console.warn(err);
      dom.exportStatus.textContent = `Export failed: ${err.message}`;
    });
  });
  el('export-frames').addEventListener('click', () => {
    exportFrames().catch((err) => {
      console.warn(err);
      dom.exportStatus.textContent = `Export failed: ${err.message}`;
    });
  });

  el('add-more').addEventListener('click', () => dom.fileInput.click());
  el('redetect').addEventListener('click', () => runDetection(true));
  el('clear-all').addEventListener('click', () => {
    if (!confirm('Remove all photos from this timelapse?')) return;
    photos.length = 0;
    previewCache.clear();
    originalCache.clear();
    invalidateFrames();
    renderFilmstrip();
    show(dom.importView);
  });
}

/* ============ import wiring ============ */

function bindImport() {
  dom.chooseBtn.addEventListener('click', () => dom.fileInput.click());
  dom.fileInput.addEventListener('change', () => {
    const files = dom.fileInput.files;
    dom.importStatus.textContent = 'Reading photos…';
    addFiles(files).finally(() => {
      dom.importStatus.textContent = '';
      dom.fileInput.value = '';
    });
  });

  for (const type of ['dragenter', 'dragover']) {
    dom.dropzone.addEventListener(type, (e) => {
      e.preventDefault();
      dom.dropzone.classList.add('over');
    });
  }
  for (const type of ['dragleave', 'drop']) {
    dom.dropzone.addEventListener(type, (e) => {
      e.preventDefault();
      dom.dropzone.classList.remove('over');
    });
  }
  dom.dropzone.addEventListener('drop', (e) => {
    if (e.dataTransfer && e.dataTransfer.files.length) addFiles(e.dataTransfer.files);
  });
  // A photo dropped anywhere else would otherwise replace the page with it.
  for (const type of ['dragover', 'drop']) {
    window.addEventListener(type, (e) => {
      if (!dom.dropzone.contains(e.target)) e.preventDefault();
    });
  }

  dom.originLabel.textContent = location.origin;
  dom.clientId.value = settings.clientId || '';
  dom.gphotosBtn.addEventListener('click', () => dom.gphotosPanel.classList.toggle('hidden'));
  dom.gphotosClose.addEventListener('click', () => dom.gphotosPanel.classList.add('hidden'));
  dom.gphotosStart.addEventListener('click', importFromGooglePhotos);
}

async function importFromGooglePhotos() {
  const clientId = dom.clientId.value.trim();
  if (!clientId) {
    dom.gphotosStatus.textContent = 'Paste your OAuth client ID first.';
    return;
  }
  settings.clientId = clientId;
  saveSettings();

  dom.gphotosStart.disabled = true;
  const status = (msg) => { dom.gphotosStatus.textContent = msg; };
  try {
    const picked = await window.GooglePhotos.pick({
      clientId,
      onStatus: status,
      onPickerUri: (uri) => {
        dom.gphotosStatus.innerHTML = '';
        const link = document.createElement('a');
        link.href = uri;
        link.target = '_blank';
        link.rel = 'noopener';
        link.className = 'btn btn-primary';
        link.textContent = 'Open Google Photos and choose an album';
        dom.gphotosStatus.appendChild(link);
        const note = document.createElement('p');
        note.className = 'hint';
        note.textContent = 'Pick the photos, press Done in Google Photos, then come back to this tab.';
        dom.gphotosStatus.appendChild(note);
      },
    });
    if (!picked.length) {
      status('No photos were imported.');
      return;
    }
    status(`Imported ${picked.length} photos.`);
    dom.gphotosPanel.classList.add('hidden');
    await addPhotos(picked);
  } catch (err) {
    console.warn(err);
    status(err.message || 'Google Photos import failed.');
  } finally {
    dom.gphotosStart.disabled = false;
  }
}

/* ============ boot ============ */

// A deliberate handle on the internals: the browser smoke test drives the
// real UI but reads state through here, and it is handy in the console when
// a photo aligns oddly.
window.Timelapse = {
  photos, settings, readyPhotos, buildFrames, computePlan, outputSize, framing, timing,
  decodeBlob, runDetection, editor,
  state: () => ({
    detecting,
    building: Boolean(building),
    framesDirty,
    playing,
    playhead,
    currentIndex,
    editorIndex,
  }),
};

function boot() {
  el('version-label').textContent = VERSION;
  bindImport();
  bindControls();
  bindEditor();
  sizeStage();
  updateTransport();

  window.addEventListener('resize', () => {
    if (sizeStage()) previewCache.clear();
    if (!playing) renderPreview();
  });

  if ('serviceWorker' in navigator) {
    const register = () => navigator.serviceWorker.register('sw.js').catch(() => {});
    if (document.readyState === 'complete') register();
    else window.addEventListener('load', register);
  }
}

boot();
