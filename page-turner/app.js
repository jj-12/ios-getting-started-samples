/* ========================================
   Page Turner - hands-free sheet music viewer
   Wink right eye = next page, wink left eye = previous page.
   ======================================== */

import * as pdfjsLib from 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.6.82/build/pdf.min.mjs';
pdfjsLib.GlobalWorkerOptions.workerSrc =
  'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.6.82/build/pdf.worker.min.mjs';

const VISION_CDN = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14';
const MODEL_URL =
  'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task';

const VERSION = 'v2';
const {
  processWink,
  createWinkState,
  winkProgress,
  gazeFeatures,
  isGazeOnTarget,
  WINK_CONFIG,
  GAZE_CONFIG,
} = window.Wink;

/* ============ Settings ============ */

const DEFAULT_SETTINGS = {
  holdMs: 400,
  cooldownMs: 1200,
  // Detector channel that maps to "forward" (the eye you wink to go to the
  // next page). Calibration sets this; 'right' is the expected default for
  // "wink your right eye to go forward".
  forwardChannel: 'right',
  showPreview: true,
  calibrated: false,
  // Require looking at the camera for a wink to register. The baseline is
  // captured during calibration; without one, "at the camera" falls back to
  // head-and-eyes-neutral, which roughly means facing the camera.
  gazeGate: true,
  gazeBaseline: null,
};

let settings = loadSettings();

function loadSettings() {
  try {
    return { ...DEFAULT_SETTINGS, ...JSON.parse(localStorage.getItem('pt-settings') || '{}') };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}
function saveSettings() {
  localStorage.setItem('pt-settings', JSON.stringify(settings));
}
function winkConfig() {
  return { ...WINK_CONFIG, HOLD_MS: settings.holdMs, COOLDOWN_MS: settings.cooldownMs };
}

/* ============ IndexedDB library ============ */

const DB_NAME = 'page-turner-db';
let dbPromise = null;

function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      db.createObjectStore('meta', { keyPath: 'id' });
      db.createObjectStore('files', { keyPath: 'id' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

async function idbPut(store, value) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readwrite');
    tx.objectStore(store).put(value);
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
}
async function idbGet(store, key) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const req = db.transaction(store).objectStore(store).get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function idbGetAll(store) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const req = db.transaction(store).objectStore(store).getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function idbDelete(store, key) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readwrite');
    tx.objectStore(store).delete(key);
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
}

/* ============ Elements ============ */

const $ = (id) => document.getElementById(id);
const libraryView = $('library-view');
const readerView = $('reader-view');
const calView = $('calibrate-view');
const libraryGrid = $('library-grid');
const libraryEmpty = $('library-empty');
const importStatus = $('import-status');
const pageCanvas = $('page-canvas');
const ctx = pageCanvas.getContext('2d');
const readerBar = $('reader-bar');
const hud = $('hud');
const armBtn = $('arm-btn');
const settingsDialog = $('settings-dialog');

$('version-label').textContent = VERSION;

// Shared camera <video>, moved between the calibration card and the HUD.
const video = document.createElement('video');
video.setAttribute('playsinline', '');
video.muted = true;
video.autoplay = true;

/* ============ Library view ============ */

async function renderLibrary() {
  const docs = (await idbGetAll('meta')).sort(
    (a, b) => (b.openedAt || b.addedAt) - (a.openedAt || a.addedAt)
  );
  libraryGrid.innerHTML = '';
  libraryEmpty.classList.toggle('hidden', docs.length > 0);

  for (const doc of docs) {
    const card = document.createElement('div');
    card.className = 'doc-card';
    card.innerHTML = `
      <img class="doc-thumb" alt="">
      <div class="doc-info">
        <div class="doc-name"></div>
        <div class="doc-pages"></div>
      </div>
      <div class="doc-actions">
        <button class="rename-btn" aria-label="Rename">&#9998;</button>
        <button class="delete-btn" aria-label="Delete">&#10005;</button>
      </div>`;
    card.querySelector('.doc-thumb').src = doc.thumb || '';
    card.querySelector('.doc-name').textContent = doc.name;
    card.querySelector('.doc-pages').textContent =
      doc.lastPage > 1 ? `p. ${doc.lastPage} of ${doc.pages}` : `${doc.pages} pages`;
    card.addEventListener('click', () => openDoc(doc.id));
    card.querySelector('.delete-btn').addEventListener('click', async (e) => {
      e.stopPropagation();
      if (!confirm(`Delete "${doc.name}" from your library?`)) return;
      await idbDelete('meta', doc.id);
      await idbDelete('files', doc.id);
      renderLibrary();
    });
    card.querySelector('.rename-btn').addEventListener('click', async (e) => {
      e.stopPropagation();
      const name = prompt('Rename score:', doc.name);
      if (name && name.trim()) {
        doc.name = name.trim();
        await idbPut('meta', doc);
        renderLibrary();
      }
    });
    libraryGrid.appendChild(card);
  }
}

function showImportStatus(text, isError = false) {
  importStatus.textContent = text;
  importStatus.classList.toggle('error', isError);
  importStatus.classList.toggle('hidden', !text);
}

$('import-btn').addEventListener('click', () => $('file-input').click());

$('file-input').addEventListener('change', async (e) => {
  const files = [...e.target.files];
  e.target.value = '';
  let ok = 0;
  for (const file of files) {
    try {
      showImportStatus(`Importing ${file.name}…`);
      const bytes = new Uint8Array(await file.arrayBuffer());
      // pdf.js transfers the buffer to its worker, so give it a copy.
      const pdf = await pdfjsLib.getDocument({ data: bytes.slice() }).promise;
      const thumb = await renderThumb(pdf);
      const id = crypto.randomUUID ? crypto.randomUUID() : String(Date.now() + Math.random());
      await idbPut('files', { id, data: bytes.buffer });
      await idbPut('meta', {
        id,
        name: file.name.replace(/\.pdf$/i, ''),
        pages: pdf.numPages,
        lastPage: 1,
        addedAt: Date.now(),
        openedAt: 0,
        thumb,
      });
      pdf.destroy();
      ok++;
    } catch (err) {
      console.error('Import failed', err);
      showImportStatus(`Could not import ${file.name}: ${err.message || err}`, true);
      await new Promise((r) => setTimeout(r, 2500));
    }
  }
  showImportStatus(ok ? `Imported ${ok} ${ok === 1 ? 'score' : 'scores'}.` : '');
  setTimeout(() => showImportStatus(''), 3000);
  renderLibrary();
});

async function renderThumb(pdf) {
  const page = await pdf.getPage(1);
  const base = page.getViewport({ scale: 1 });
  const scale = 320 / base.width;
  const viewport = page.getViewport({ scale });
  const canvas = document.createElement('canvas');
  canvas.width = viewport.width;
  canvas.height = viewport.height;
  await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
  return canvas.toDataURL('image/jpeg', 0.75);
}

/* ============ Reader ============ */

let currentDoc = null; // meta record
let currentPdf = null;
let currentPage = 1;
let pageCache = new Map(); // pageNum -> offscreen canvas
let renderToken = 0;
let barTimer = null;
let wakeLock = null;

async function openDoc(id) {
  const meta = await idbGet('meta', id);
  const file = await idbGet('files', id);
  if (!meta || !file) return;

  currentDoc = meta;
  currentPdf = await pdfjsLib.getDocument({ data: new Uint8Array(file.data.slice(0)) }).promise;
  currentPage = Math.min(Math.max(meta.lastPage || 1, 1), currentPdf.numPages);
  pageCache = new Map();

  meta.openedAt = Date.now();
  idbPut('meta', meta);

  $('doc-title').textContent = meta.name;
  libraryView.classList.add('hidden');
  readerView.classList.remove('hidden');
  showBar(true);
  scheduleBarHide();

  await showPage(currentPage);
  requestWakeLock();
}

function closeDoc() {
  stopTracking();
  releaseWakeLock();
  if (currentPdf) currentPdf.destroy();
  currentPdf = null;
  currentDoc = null;
  pageCache = new Map();
  readerView.classList.add('hidden');
  libraryView.classList.remove('hidden');
  renderLibrary();
}

$('back-btn').addEventListener('click', closeDoc);

function canvasSize() {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  return { w: readerView.clientWidth, h: readerView.clientHeight, dpr };
}

async function renderPageToCanvas(pageNum) {
  const { w, h, dpr } = canvasSize();
  const page = await currentPdf.getPage(pageNum);
  const base = page.getViewport({ scale: 1 });
  const scale = Math.min(w / base.width, h / base.height) * dpr;
  const viewport = page.getViewport({ scale });
  const off = document.createElement('canvas');
  off.width = Math.floor(viewport.width);
  off.height = Math.floor(viewport.height);
  const octx = off.getContext('2d');
  octx.fillStyle = '#fff';
  octx.fillRect(0, 0, off.width, off.height);
  await page.render({ canvasContext: octx, viewport }).promise;
  return off;
}

async function getRenderedPage(pageNum) {
  if (pageCache.has(pageNum)) return pageCache.get(pageNum);
  const off = await renderPageToCanvas(pageNum);
  pageCache.set(pageNum, off);
  // Keep the cache small: current page +/- 2
  for (const key of pageCache.keys()) {
    if (Math.abs(key - currentPage) > 2) pageCache.delete(key);
  }
  return off;
}

async function showPage(pageNum) {
  if (!currentPdf) return;
  const token = ++renderToken;
  const { w, h, dpr } = canvasSize();
  const off = await getRenderedPage(pageNum);
  if (token !== renderToken || !currentPdf) return; // superseded

  pageCanvas.width = Math.floor(w * dpr);
  pageCanvas.height = Math.floor(h * dpr);
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, pageCanvas.width, pageCanvas.height);
  const x = Math.floor((pageCanvas.width - off.width) / 2);
  const y = Math.floor((pageCanvas.height - off.height) / 2);
  ctx.drawImage(off, x, y);

  $('page-indicator').textContent = `${pageNum} / ${currentPdf.numPages}`;

  // Pre-render neighbors so wink turns are instant.
  if (pageNum < currentPdf.numPages) getRenderedPage(pageNum + 1).catch(() => {});
  if (pageNum > 1) getRenderedPage(pageNum - 1).catch(() => {});
}

function goTo(delta, source) {
  if (!currentPdf) return;
  const target = currentPage + delta;
  if (target < 1 || target > currentPdf.numPages) {
    showBar(true);
    scheduleBarHide();
    return;
  }
  currentPage = target;
  showPage(currentPage);
  if (currentDoc) {
    currentDoc.lastPage = currentPage;
    idbPut('meta', currentDoc);
  }
  if (source === 'wink') flashTurn(delta > 0);
}

function flashTurn(forward) {
  const el = forward ? $('turn-flash-fwd') : $('turn-flash-back');
  el.classList.add('show');
  setTimeout(() => el.classList.remove('show'), 80);
}

$('tap-right').addEventListener('click', () => goTo(1, 'tap'));
$('tap-left').addEventListener('click', () => goTo(-1, 'tap'));
$('tap-center').addEventListener('click', () => {
  const hidden = readerBar.classList.toggle('bar-hidden');
  if (!hidden) scheduleBarHide();
});

function showBar(show) {
  readerBar.classList.toggle('bar-hidden', !show);
}
function scheduleBarHide() {
  clearTimeout(barTimer);
  barTimer = setTimeout(() => showBar(false), 4000);
}

window.addEventListener('resize', () => {
  if (!currentPdf) return;
  pageCache = new Map();
  showPage(currentPage);
});

/* ============ Wake lock ============ */

async function requestWakeLock() {
  try {
    if ('wakeLock' in navigator) {
      wakeLock = await navigator.wakeLock.request('screen');
    }
  } catch (e) {
    console.warn('Wake lock unavailable:', e.message);
  }
}
function releaseWakeLock() {
  if (wakeLock) {
    wakeLock.release().catch(() => {});
    wakeLock = null;
  }
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && currentPdf) requestWakeLock();
});

/* ============ Eye tracking ============ */

let faceLandmarker = null;
let camStream = null;
let trackingLoopId = null;
let lastVideoTime = -1;
let winkState = createWinkState();
let armState = 'off'; // 'off' | 'armed' | 'paused'
let fireFlashUntil = 0;

async function ensureModel() {
  if (faceLandmarker) return;
  setHudText('Loading model…', 'warn');
  const { FaceLandmarker, FilesetResolver } = await import(`${VISION_CDN}/vision_bundle.mjs`);
  const fileset = await FilesetResolver.forVisionTasks(`${VISION_CDN}/wasm`);
  faceLandmarker = await FaceLandmarker.createFromOptions(fileset, {
    baseOptions: { modelAssetPath: MODEL_URL, delegate: 'GPU' },
    outputFaceBlendshapes: true,
    outputFacialTransformationMatrixes: true,
    runningMode: 'VIDEO',
    numFaces: 1,
  });
}

async function ensureCamera() {
  if (camStream && camStream.active) return;
  camStream = await navigator.mediaDevices.getUserMedia({
    video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 } },
    audio: false,
  });
  video.srcObject = camStream;
  await video.play();
}

function stopCamera() {
  if (camStream) {
    camStream.getTracks().forEach((t) => t.stop());
    camStream = null;
  }
  video.srcObject = null;
}

/** Extract eye closedness + gaze features from a FaceLandmarker result. */
function extractFrame(result) {
  const shapes = result && result.faceBlendshapes && result.faceBlendshapes[0];
  if (!shapes) return null;
  const s = {};
  for (const c of shapes.categories) s[c.categoryName] = c.score;
  if (s.eyeBlinkLeft === undefined || s.eyeBlinkRight === undefined) return null;

  const matrixes = result.facialTransformationMatrixes;
  const matrix = matrixes && matrixes[0] ? matrixes[0].data : null;
  const gaze = gazeFeatures(
    {
      upLeft: s.eyeLookUpLeft || 0,
      upRight: s.eyeLookUpRight || 0,
      downLeft: s.eyeLookDownLeft || 0,
      downRight: s.eyeLookDownRight || 0,
      inLeft: s.eyeLookInLeft || 0,
      inRight: s.eyeLookInRight || 0,
      outLeft: s.eyeLookOutLeft || 0,
      outRight: s.eyeLookOutRight || 0,
    },
    matrix
  );
  return { left: s.eyeBlinkLeft, right: s.eyeBlinkRight, gaze };
}

const NEUTRAL_BASELINE = { nx: 0, ny: 0, h: 0, v: 0 };
let lastGazeOkTime = 0;

function gazeBaseline() {
  return settings.gazeBaseline || NEUTRAL_BASELINE;
}

/** Update the gaze gate for this frame and return whether winks may start. */
function updateGazeGate(frame, now) {
  if (!settings.gazeGate) return true;
  if (frame && isGazeOnTarget(frame.gaze, gazeBaseline(), GAZE_CONFIG)) {
    lastGazeOkTime = now;
  }
  return now - lastGazeOkTime < GAZE_CONFIG.RECENT_MS;
}

function trackingLoop() {
  trackingLoopId = requestAnimationFrame(trackingLoop);
  if (!faceLandmarker || video.readyState < 2) return;
  if (video.currentTime === lastVideoTime) return;
  lastVideoTime = video.currentTime;

  const now = performance.now();
  let result;
  try {
    result = faceLandmarker.detectForVideo(video, now);
  } catch {
    return;
  }
  const frame = extractFrame(result);

  if (calibration.active) {
    calibrationFrame(frame, now);
    return;
  }

  const gateOk = updateGazeGate(frame, now);
  updateHud(frame, now, gateOk);

  if (armState !== 'armed' || !currentPdf) return;

  const r = frame
    ? processWink(frame.left, frame.right, now, winkState, winkConfig(), gateOk)
    : processWink(null, null, now, winkState, winkConfig(), gateOk);
  winkState = r.state;

  if (r.action) {
    fireFlashUntil = now + 700;
    const forward = r.action === settings.forwardChannel;
    goTo(forward ? 1 : -1, 'wink');
  }
}

function updateHud(frame, now, gateOk) {
  const fwdDot = $('eye-fwd-dot');
  const backDot = $('eye-back-dot');
  const fired = now < fireFlashUntil;

  if (!frame) {
    setHudText(armState === 'armed' ? 'No face' : 'Paused', armState === 'armed' ? 'warn' : '');
    fwdDot.className = 'eye-dot';
    backDot.className = 'eye-dot';
    $('hold-progress-fill').style.width = '0%';
    return;
  }

  const fwdScore = settings.forwardChannel === 'left' ? frame.left : frame.right;
  const backScore = settings.forwardChannel === 'left' ? frame.right : frame.left;
  fwdDot.className = 'eye-dot' + (fired ? ' fired' : fwdScore > 0.55 ? ' closed' : '');
  backDot.className = 'eye-dot' + (backScore > 0.55 ? ' closed' : '');

  if (armState === 'armed') {
    const holding = winkState.candidateEye !== null;
    if (fired) setHudText('Turn!', 'ok');
    else if (gateOk || holding) setHudText('Ready', 'ok');
    else setHudText('Look at camera…', 'warn');
    const p = winkProgress(winkState, now, winkConfig());
    $('hold-progress-fill').style.width = `${Math.round(p * 100)}%`;
  } else {
    setHudText('Paused', '');
    $('hold-progress-fill').style.width = '0%';
  }
}

function setHudText(text, cls) {
  const el = $('hud-text');
  el.textContent = text;
  el.className = 'hud-text' + (cls ? ` ${cls}` : '');
}

async function startTracking() {
  try {
    armBtn.textContent = 'Starting…';
    await ensureCamera();
    await ensureModel();
  } catch (err) {
    console.error('Tracking start failed', err);
    alert(
      'Could not start eye tracking: ' +
        (err && err.name === 'NotAllowedError'
          ? 'camera permission was denied. Enable camera access in Settings > Page Turner.'
          : err.message || err) +
        '\n\nYou can still turn pages by tapping the left/right edges.'
    );
    setArmState('off');
    stopCamera();
    return false;
  }
  hud.classList.remove('hidden');
  applyPreviewSetting();
  winkState = createWinkState();
  lastGazeOkTime = 0;
  lastVideoTime = -1;
  if (!trackingLoopId) trackingLoop();
  return true;
}

function stopTracking() {
  if (trackingLoopId) {
    cancelAnimationFrame(trackingLoopId);
    trackingLoopId = null;
  }
  stopCamera();
  hud.classList.add('hidden');
  setArmState('off');
}

function setArmState(next) {
  armState = next;
  armBtn.classList.toggle('armed', next === 'armed');
  armBtn.classList.toggle('paused', next === 'paused');
  armBtn.innerHTML =
    next === 'armed'
      ? '&#128065; Tracking on'
      : next === 'paused'
        ? '&#9208; Paused'
        : '&#128065; Start tracking';
}

armBtn.addEventListener('click', async () => {
  if (armState === 'off') {
    if (!settings.calibrated) {
      startCalibration();
      return;
    }
    if (await startTracking()) setArmState('armed');
  } else if (armState === 'armed') {
    setArmState('paused');
    winkState = createWinkState();
  } else {
    winkState = createWinkState();
    setArmState('armed');
  }
  scheduleBarHide();
});

function applyPreviewSetting() {
  const wrap = $('cam-wrap');
  if (settings.showPreview) {
    if (video.parentElement !== wrap) wrap.appendChild(video);
  } else if (video.parentElement === wrap) {
    wrap.removeChild(video);
  }
}

/* ============ Calibration ============ */

const calibration = {
  active: false,
  step: null, // 'position' | 'gaze' | 'forward' | 'back'
  faceSince: 0,
  gazeSince: 0,
  gazeSamples: [],
  baseline: null,
  state: createWinkState(),
  forwardChannel: null,
  lastGazeOk: 0,
};

const CAL_HOLD = { ...WINK_CONFIG, HOLD_MS: 500, COOLDOWN_MS: 800 };

async function startCalibration() {
  calView.classList.remove('hidden');
  $('cal-title').textContent = 'Set up wink tracking';
  $('cal-text').innerHTML = 'Starting camera…';
  $('cal-progress-fill').style.width = '0%';
  $('cal-video-slot').appendChild(video);

  calibration.active = true;
  calibration.step = 'position';
  calibration.faceSince = 0;
  calibration.gazeSince = 0;
  calibration.gazeSamples = [];
  calibration.baseline = null;
  calibration.state = createWinkState();
  calibration.forwardChannel = null;
  calibration.lastGazeOk = 0;

  try {
    await ensureCamera();
    await ensureModel();
  } catch (err) {
    console.error(err);
    $('cal-text').innerHTML =
      'Camera or model failed to start. Check camera permission and network, then try again.';
    return;
  }
  lastVideoTime = -1;
  if (!trackingLoopId) trackingLoop();
  $('cal-text').innerHTML =
    'Sit at the piano in your normal playing position and look at the screen.';
}

function calibrationFrame(frame, now) {
  const cal = calibration;
  const fill = $('cal-progress-fill');

  if (cal.step === 'position') {
    if (frame) {
      if (!cal.faceSince) cal.faceSince = now;
      const held = now - cal.faceSince;
      fill.style.width = `${Math.min(100, (held / 1500) * 100)}%`;
      if (held > 1500) {
        cal.step = 'gaze';
        cal.gazeSince = 0;
        cal.gazeSamples = [];
        fill.style.width = '0%';
        $('cal-text').innerHTML =
          'Now look <strong>directly at the camera lens</strong> and hold still. ' +
          'This is the "turn the page" look.';
      }
    } else {
      cal.faceSince = 0;
      fill.style.width = '0%';
      $('cal-text').innerHTML =
        'Looking for your face… make sure it is visible and well lit.';
    }
    return;
  }

  if (cal.step === 'gaze') {
    if (!frame) {
      cal.gazeSince = 0;
      cal.gazeSamples = [];
      fill.style.width = '0%';
      return;
    }
    if (!cal.gazeSince) cal.gazeSince = now;
    cal.gazeSamples.push(frame.gaze);
    const held = now - cal.gazeSince;
    fill.style.width = `${Math.min(100, (held / 1200) * 100)}%`;
    if (held > 1200) {
      const n = cal.gazeSamples.length;
      cal.baseline = cal.gazeSamples.reduce(
        (acc, g) => ({
          nx: acc.nx + g.nx / n,
          ny: acc.ny + g.ny / n,
          h: acc.h + g.h / n,
          v: acc.v + g.v / n,
        }),
        { nx: 0, ny: 0, h: 0, v: 0 }
      );
      cal.step = 'forward';
      cal.state = createWinkState();
      fill.style.width = '0%';
      $('cal-text').innerHTML =
        'Keep looking at the camera and wink your <strong>RIGHT</strong> eye ' +
        '(next-page eye). <strong>Hold it</strong> until the bar fills.';
    }
    return;
  }

  if (cal.step === 'forward' || cal.step === 'back') {
    // Practice with the same gaze gate that live tracking uses.
    let gateOk = true;
    if (settings.gazeGate && cal.baseline) {
      if (frame && isGazeOnTarget(frame.gaze, cal.baseline, GAZE_CONFIG)) cal.lastGazeOk = now;
      gateOk = now - cal.lastGazeOk < GAZE_CONFIG.RECENT_MS;
    }

    const r = frame
      ? processWink(frame.left, frame.right, now, cal.state, CAL_HOLD, gateOk)
      : processWink(null, null, now, cal.state, CAL_HOLD, gateOk);
    cal.state = r.state;
    fill.style.width = `${Math.round(winkProgress(cal.state, now, CAL_HOLD) * 100)}%`;

    if (!r.action) return;

    if (cal.step === 'forward') {
      cal.forwardChannel = r.action;
      cal.step = 'back';
      cal.state = createWinkState();
      fill.style.width = '0%';
      $('cal-text').innerHTML =
        'Got it! Still looking at the camera, wink your <strong>LEFT</strong> eye ' +
        '(previous-page eye) and hold.';
    } else if (r.action === cal.forwardChannel) {
      $('cal-text').innerHTML =
        'That looked like the <strong>same eye</strong>. Wink the <strong>other</strong> eye and hold.';
      fill.style.width = '0%';
    } else {
      settings.forwardChannel = cal.forwardChannel;
      settings.gazeBaseline = cal.baseline;
      settings.calibrated = true;
      saveSettings();
      finishCalibration(true);
    }
  }
}

async function finishCalibration(success) {
  calibration.active = false;
  calView.classList.add('hidden');
  if (success && currentPdf) {
    applyPreviewSetting();
    if (await startTracking()) setArmState('armed');
  } else if (!currentPdf) {
    stopTracking();
  }
}

$('cal-skip').addEventListener('click', () => {
  settings.calibrated = true; // accept defaults, stop prompting
  saveSettings();
  finishCalibration(true);
});
$('cal-cancel').addEventListener('click', () => {
  calibration.active = false;
  calView.classList.add('hidden');
  stopTracking();
});

/* ============ Settings dialog ============ */

$('settings-btn').addEventListener('click', () => {
  $('hold-range').value = settings.holdMs;
  $('hold-label').textContent = `${(settings.holdMs / 1000).toFixed(2)}s`;
  $('cooldown-range').value = settings.cooldownMs;
  $('cooldown-label').textContent = `${(settings.cooldownMs / 1000).toFixed(1)}s`;
  $('swap-eyes').checked = false;
  $('gaze-gate').checked = settings.gazeGate;
  $('show-preview').checked = settings.showPreview;
  settingsDialog.showModal();
});

$('gaze-gate').addEventListener('change', (e) => {
  settings.gazeGate = e.target.checked;
  saveSettings();
});

$('hold-range').addEventListener('input', (e) => {
  settings.holdMs = Number(e.target.value);
  $('hold-label').textContent = `${(settings.holdMs / 1000).toFixed(2)}s`;
  saveSettings();
});
$('cooldown-range').addEventListener('input', (e) => {
  settings.cooldownMs = Number(e.target.value);
  $('cooldown-label').textContent = `${(settings.cooldownMs / 1000).toFixed(1)}s`;
  saveSettings();
});
$('swap-eyes').addEventListener('change', () => {
  settings.forwardChannel = settings.forwardChannel === 'right' ? 'left' : 'right';
  saveSettings();
});
$('show-preview').addEventListener('change', (e) => {
  settings.showPreview = e.target.checked;
  saveSettings();
  applyPreviewSetting();
});
$('recalibrate-btn').addEventListener('click', () => {
  settingsDialog.close();
  startCalibration();
});
$('settings-close').addEventListener('click', () => settingsDialog.close());

/* ============ Boot ============ */

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js').catch(() => {});
}

renderLibrary();
