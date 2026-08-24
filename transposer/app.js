// Transposer — main application.
//
// Library of imported scores (IndexedDB), a MusicXML viewer that transposes
// to any key and renders via OpenSheetMusicDisplay, and a PDF viewer that
// transposes chord symbols found in the PDF text layer in place.

const PDFJS_URL = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.6.82/build/pdf.min.mjs';
const PDFJS_WORKER_URL =
  'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.6.82/build/pdf.worker.min.mjs';

const T = window.Transpose;
const Chords = window.Chords;

const $ = (id) => document.getElementById(id);

// ============ IndexedDB ============

const DB_NAME = 'transposer-db';
const STORE = 'scores';

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore(STORE, { keyPath: 'id' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function dbOp(mode, fn) {
  const db = await openDb();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const out = fn(tx.objectStore(STORE));
      tx.oncomplete = () => resolve(out.result !== undefined ? out.result : out);
      tx.onerror = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

const dbAll = () => dbOp('readonly', (s) => s.getAll());
const dbGet = (id) => dbOp('readonly', (s) => s.get(id));
const dbPut = (rec) => dbOp('readwrite', (s) => s.put(rec));
const dbDelete = (id) => dbOp('readwrite', (s) => s.delete(id));

// ============ View switching ============

const VIEWS = ['library-view', 'score-view', 'pdf-view'];

function showView(id) {
  for (const v of VIEWS) $(v).classList.toggle('hidden', v !== id);
  window.scrollTo(0, 0);
}

// ============ Library ============

async function renderLibrary() {
  const grid = $('library-grid');
  const scores = (await dbAll()).sort((a, b) => b.added - a.added);
  grid.innerHTML = '';
  $('library-empty').classList.toggle('hidden', scores.length > 0);
  for (const rec of scores) {
    const card = document.createElement('div');
    card.className = 'score-card';
    const kind = document.createElement('span');
    kind.className = 'score-kind' + (rec.kind === 'xml' ? ' xml' : '');
    kind.textContent = rec.kind === 'xml' ? 'MusicXML' : 'PDF';
    const name = document.createElement('div');
    name.className = 'score-name';
    name.textContent = rec.name;
    const row = document.createElement('div');
    row.className = 'card-row';
    const meta = document.createElement('span');
    meta.className = 'score-meta';
    meta.textContent = new Date(rec.added).toLocaleDateString();
    const del = document.createElement('button');
    del.className = 'delete-btn';
    del.textContent = 'Delete';
    del.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (confirm(`Delete "${rec.name}"?`)) {
        await dbDelete(rec.id);
        renderLibrary();
      }
    });
    row.append(meta, del);
    card.append(kind, name, row);
    card.addEventListener('click', () => openRecord(rec.id));
    grid.appendChild(card);
  }
}

function setImportStatus(msg, isError) {
  const el = $('import-status');
  if (!msg) {
    el.classList.add('hidden');
    return;
  }
  el.textContent = msg;
  el.classList.toggle('error', !!isError);
  el.classList.remove('hidden');
}

async function importFiles(files) {
  let lastId = null;
  for (const file of files) {
    try {
      setImportStatus(`Importing ${file.name}…`);
      const buffer = await file.arrayBuffer();
      const head = new Uint8Array(buffer.slice(0, 4));
      const magic = String.fromCharCode(...head);
      let rec;
      const baseName = file.name.replace(/\.(pdf|xml|musicxml|mxl)$/i, '');
      if (magic.startsWith('%PDF')) {
        rec = { kind: 'pdf', data: buffer };
      } else if (magic.startsWith('PK')) {
        rec = { kind: 'xml', xml: checkMusicXml(await window.Mxl.extractMusicXml(buffer)) };
      } else {
        rec = { kind: 'xml', xml: checkMusicXml(new TextDecoder().decode(buffer)) };
      }
      rec.id = `s_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      rec.name = baseName;
      rec.added = Date.now();
      await dbPut(rec);
      lastId = rec.id;
    } catch (err) {
      setImportStatus(`Could not import ${file.name}: ${err.message}`, true);
      await renderLibrary();
      return;
    }
  }
  setImportStatus(null);
  await renderLibrary();
  if (files.length === 1 && lastId) openRecord(lastId);
}

function checkMusicXml(text) {
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  if (doc.querySelector('parsererror')) throw new Error('not valid XML');
  if (!doc.querySelector('score-partwise')) {
    throw new Error(
      doc.querySelector('score-timewise')
        ? 'timewise MusicXML is not supported — re-export as partwise (the default)'
        : 'not a MusicXML score',
    );
  }
  return text;
}

async function loadDemo() {
  try {
    const resp = await fetch('demo/amazing-grace.musicxml');
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const xml = checkMusicXml(await resp.text());
    const rec = {
      id: 'demo-amazing-grace',
      kind: 'xml',
      xml,
      name: 'Amazing Grace (demo)',
      added: Date.now(),
    };
    await dbPut(rec);
    await renderLibrary();
    openRecord(rec.id);
  } catch (err) {
    setImportStatus(`Could not load demo: ${err.message}`, true);
  }
}

async function openRecord(id) {
  const rec = await dbGet(id);
  if (!rec) return;
  if (rec.kind === 'xml') openScore(rec);
  else openPdf(rec);
}

// ============ MusicXML score view ============

const score = {
  rec: null,
  osmd: null,
  keys: [],       // targetKeys() entries for the piece's mode
  sourceKey: null, // {fifths, mode, tonic}
  targetIdx: -1,  // index into keys, -1 = original
  octave: 0,
  doc: null,      // last rendered (possibly transposed) document
  player: null,
  renderSeq: 0,
};

// The OSMD bundle loads from a CDN with `defer`; on a slow first visit it may
// still be in flight when a score is opened, so poll briefly before giving up.
async function osmdAvailable() {
  for (let i = 0; i < 50; i++) {
    if (typeof window.opensheetmusicdisplay !== 'undefined') return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return typeof window.opensheetmusicdisplay !== 'undefined';
}

async function openScore(rec) {
  stopPlayback();
  score.rec = rec;
  score.targetIdx = -1;
  score.octave = 0;
  showView('score-view');

  const probe = new DOMParser().parseFromString(rec.xml, 'application/xml');
  score.sourceKey = T.initialKey(probe);
  score.sourceKey.tonic = T.keyTonic(score.sourceKey.fifths, score.sourceKey.mode);
  score.keys = T.targetKeys(score.sourceKey.mode);
  $('score-title').textContent = T.scoreTitle(probe) || rec.name;

  const sel = $('key-select');
  sel.innerHTML = '';
  const orig = document.createElement('option');
  orig.value = '-1';
  orig.textContent = `Original — ${T.keyLabel(score.sourceKey.fifths, score.sourceKey.mode)}`;
  sel.appendChild(orig);
  score.keys.forEach((k, i) => {
    const opt = document.createElement('option');
    opt.value = String(i);
    opt.textContent = k.label;
    sel.appendChild(opt);
  });
  sel.value = '-1';

  if (!score.osmd) {
    if (!(await osmdAvailable())) {
      $('sheet').innerHTML =
        '<p style="padding:30px;color:#555">The notation renderer failed to load — check your connection and reload once; after that it works offline.</p>';
      return;
    }
    score.osmd = new window.opensheetmusicdisplay.OpenSheetMusicDisplay($('sheet'), {
      autoResize: true,
      backend: 'svg',
      drawTitle: true,
    });
  }
  await renderScore();
}

function currentInterval() {
  let iv = { steps: 0, semitones: 0 };
  if (score.targetIdx >= 0) {
    iv = T.intervalBetween(score.sourceKey.tonic, score.keys[score.targetIdx].tonic, 'closest');
  }
  if (score.octave !== 0) iv = T.shiftOctaves(iv, score.octave);
  return iv;
}

async function renderScore() {
  if (!score.osmd) return;
  const seq = ++score.renderSeq;
  $('score-status').textContent = 'rendering…';
  const doc = new DOMParser().parseFromString(score.rec.xml, 'application/xml');
  const iv = currentInterval();
  if (iv.steps !== 0 || iv.semitones !== 0) T.transposeMusicXml(doc, iv);
  score.doc = doc;

  const from = T.keyLabel(score.sourceKey.fifths, score.sourceKey.mode);
  $('score-keyinfo').textContent =
    score.targetIdx < 0
      ? from
      : `${from} → ${score.keys[score.targetIdx].label}` +
        (score.octave ? ` (${score.octave > 0 ? '+' : ''}${score.octave} oct)` : '');
  $('oct-label').textContent = String(score.octave);

  try {
    const xml = new XMLSerializer().serializeToString(doc);
    await score.osmd.load(xml);
    if (seq !== score.renderSeq) return; // superseded by a newer render
    score.osmd.render();
    $('score-status').textContent = '';
  } catch (err) {
    $('score-status').textContent = `render failed: ${err.message || err}`;
  }
}

function stopPlayback() {
  if (score.player) {
    score.player.stop();
    score.player = null;
  }
  const btn = $('score-play');
  btn.classList.remove('playing');
  btn.innerHTML = '&#9654; Play';
}

function togglePlayback() {
  if (score.player) {
    stopPlayback();
    return;
  }
  if (!score.doc) return;
  const btn = $('score-play');
  btn.classList.add('playing');
  btn.innerHTML = '&#9632; Stop';
  score.player = window.Player.play(score.doc, { onDone: stopPlayback });
}

function downloadXml() {
  if (!score.doc) return;
  const xml = new XMLSerializer().serializeToString(score.doc);
  const label =
    score.targetIdx >= 0 ? ` - ${score.keys[score.targetIdx].label}` : '';
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([xml], { type: 'application/vnd.recordare.musicxml+xml' }));
  a.download = `${score.rec.name}${label}.musicxml`.replace(/[♯]/g, '#').replace(/[♭]/g, 'b');
  a.click();
  URL.revokeObjectURL(a.href);
}

// ============ PDF view ============

const pdf = {
  rec: null,
  pages: [], // {canvas, overlay, chords: [{x, y, fontH, width, text}]}
  shift: 0,
  loadSeq: 0,
};

async function loadPdfJs() {
  const lib = await import(PDFJS_URL);
  lib.GlobalWorkerOptions.workerSrc = PDFJS_WORKER_URL;
  return lib;
}

async function openPdf(rec) {
  stopPlayback();
  pdf.rec = rec;
  pdf.shift = 0;
  pdf.pages = [];
  const seq = ++pdf.loadSeq;
  showView('pdf-view');
  $('pdf-title').textContent = rec.name;
  $('shift-label').textContent = '0';
  $('chord-controls').classList.add('hidden');
  $('pdf-notice').classList.add('hidden');
  const pagesEl = $('pdf-pages');
  pagesEl.innerHTML = '<p class="hint" style="padding:30px">Loading PDF…</p>';

  let lib, doc;
  try {
    lib = await loadPdfJs();
    doc = await lib.getDocument({ data: rec.data.slice(0) }).promise;
  } catch (err) {
    pagesEl.innerHTML = `<p class="hint" style="padding:30px">Could not open PDF: ${err.message || err}</p>`;
    return;
  }
  if (seq !== pdf.loadSeq) return;
  pagesEl.innerHTML = '';

  const cssWidth = Math.min(900, document.documentElement.clientWidth - 24);
  const dpr = Math.min(window.devicePixelRatio || 1, 3);
  let hasText = false;

  for (let n = 1; n <= doc.numPages; n++) {
    const page = await doc.getPage(n);
    if (seq !== pdf.loadSeq) return;
    const base = page.getViewport({ scale: 1 });
    const scale = (cssWidth / base.width) * dpr;
    const viewport = page.getViewport({ scale });

    const wrap = document.createElement('div');
    wrap.className = 'pdf-page';
    const canvas = document.createElement('canvas');
    const overlay = document.createElement('canvas');
    overlay.className = 'chord-overlay';
    for (const c of [canvas, overlay]) {
      c.width = Math.floor(viewport.width);
      c.height = Math.floor(viewport.height);
      c.style.width = `${cssWidth}px`;
      c.style.height = `${(cssWidth * viewport.height) / viewport.width}px`;
    }
    wrap.append(canvas, overlay);
    pagesEl.appendChild(wrap);

    await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;

    const text = await page.getTextContent();
    if (text.items.length) hasText = true;
    const chords = [];
    for (const item of text.items) {
      const token = item.str.trim();
      if (!token || token.length > 12) continue;
      const parsed = Chords.parseChord(token);
      if (!parsed) continue;
      const tx = lib.Util.transform(viewport.transform, item.transform);
      const fontH = Math.hypot(tx[2], tx[3]);
      if (fontH < 4) continue;
      chords.push({
        x: tx[4],
        y: tx[5],
        fontH,
        width: item.width * scale,
        text: token,
        strong: !!(parsed.quality || parsed.bass || parsed.root.alter),
      });
    }
    pdf.pages.push({ canvas, overlay, chords });
  }

  // Weak tokens (bare A–G letters) count only on pages that also contain
  // unambiguous chord symbols, so prose pages don't get letters "transposed".
  let total = 0;
  for (const p of pdf.pages) {
    const strong = p.chords.filter((c) => c.strong).length;
    p.active = strong >= 2 || (strong >= 1 && p.chords.length >= 4);
    if (p.active) total += p.chords.length;
  }
  const docActive = total >= 3;

  if (docActive) {
    $('chord-controls').classList.remove('hidden');
    $('chord-count').textContent = `${total} chord symbols`;
    $('pdf-notice-text').textContent =
      'Chord symbols transpose right here. The printed notes are an image — to transpose those too, convert this PDF to MusicXML once and import that.';
  } else if (hasText) {
    $('pdf-notice-text').textContent =
      'No chord symbols found in this PDF’s text. The notes are an image, so they can’t be transposed directly — convert the PDF to MusicXML (free, one-time) and import that for full transposition.';
  } else {
    $('pdf-notice-text').textContent =
      'This PDF is a scan with no text layer. Convert it to MusicXML with a free music-OCR tool and import that file for full transposition.';
  }
  $('pdf-notice').classList.remove('hidden');
  applyChordShift();
}

function applyChordShift() {
  $('shift-label').textContent = (pdf.shift > 0 ? '+' : '') + pdf.shift;
  const highlight = $('highlight-chords').checked;
  const preferFlats = $('prefer-flats').checked;
  const iv = pdf.shift === 0 ? null : Chords.intervalForChordShift(pdf.shift);
  for (const page of pdf.pages) {
    const ctx = page.overlay.getContext('2d');
    ctx.clearRect(0, 0, page.overlay.width, page.overlay.height);
    if (!iv || !page.active) continue;
    for (const c of page.chords) {
      const out = Chords.transposeChordText(c.text, iv, preferFlats || undefined);
      if (out === null) continue;
      ctx.font = `600 ${c.fontH}px Helvetica, Arial, sans-serif`;
      const w = Math.max(c.width, ctx.measureText(out).width);
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(c.x - 2, c.y - c.fontH * 0.92, w + 6, c.fontH * 1.22);
      ctx.fillStyle = highlight ? '#7a41c9' : '#111111';
      ctx.fillText(out, c.x, c.y);
    }
  }
}

// ============ Wiring ============

function init() {
  $('import-btn').addEventListener('click', () => $('file-input').click());
  $('file-input').addEventListener('change', (e) => {
    if (e.target.files.length) importFiles([...e.target.files]);
    e.target.value = '';
  });
  $('demo-btn').addEventListener('click', loadDemo);

  $('score-back').addEventListener('click', () => {
    stopPlayback();
    showView('library-view');
    renderLibrary();
  });
  $('key-select').addEventListener('change', (e) => {
    score.targetIdx = parseInt(e.target.value, 10);
    stopPlayback();
    renderScore();
  });
  $('oct-down').addEventListener('click', () => {
    score.octave = Math.max(-3, score.octave - 1);
    stopPlayback();
    renderScore();
  });
  $('oct-up').addEventListener('click', () => {
    score.octave = Math.min(3, score.octave + 1);
    stopPlayback();
    renderScore();
  });
  $('score-reset').addEventListener('click', () => {
    score.targetIdx = -1;
    score.octave = 0;
    $('key-select').value = '-1';
    stopPlayback();
    renderScore();
  });
  $('score-play').addEventListener('click', togglePlayback);
  $('score-print').addEventListener('click', () => window.print());
  $('score-download').addEventListener('click', downloadXml);

  $('pdf-back').addEventListener('click', () => {
    pdf.loadSeq++;
    showView('library-view');
    renderLibrary();
  });
  $('pdf-print').addEventListener('click', () => window.print());
  $('shift-down').addEventListener('click', () => {
    pdf.shift = Math.max(-11, pdf.shift - 1);
    applyChordShift();
  });
  $('shift-up').addEventListener('click', () => {
    pdf.shift = Math.min(11, pdf.shift + 1);
    applyChordShift();
  });
  $('prefer-flats').addEventListener('change', applyChordShift);
  $('highlight-chords').addEventListener('change', applyChordShift);

  $('omr-help-btn').addEventListener('click', () => $('omr-modal').classList.remove('hidden'));
  $('omr-close').addEventListener('click', () => $('omr-modal').classList.add('hidden'));

  renderLibrary();

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
}

init();
