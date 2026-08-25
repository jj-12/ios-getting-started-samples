/* ========================================
   Aligned Timelapse - pure geometry & ordering logic (testable)

   The app pins two anchor points (normally the two eyes) of every photo
   to the same place on the output canvas, so a subject photographed over
   years stays rock-steady while everything else changes around them - and
   by default it picks the framing that keeps the *whole* photo in shot, so
   the body and the room come along with the face.

   Everything in here is pure: no DOM, no canvas, no network. The browser
   side (app.js) supplies anchors - from MediaPipe face landmarks or from
   taps - and this module turns them into per-photo transforms, a common
   crop, and a playback timeline.

   Coordinate spaces
     image space  - pixels of the decoded photo (after EXIF orientation)
     canvas space - pixels of the output frame (e.g. 1080x1350)

   A transform is a 2D similarity (uniform scale + rotation + translation),
   stored as { a, b, tx, ty } and meaning

     x' = a*x - b*y + tx
     y' = b*x + a*y + ty

   which is exactly a canvas setTransform(a, b, -b, a, tx, ty). Similarity
   is the right family here: it can move, rotate and resize a face to a
   canonical pose without shearing or otherwise distorting the photo.
   ======================================== */

/* ============ similarity transforms ============ */

function identity() {
  return { a: 1, b: 0, tx: 0, ty: 0 };
}

/** Build a transform from its parts (rotation in radians). */
function fromParams(scale, rotation, tx, ty) {
  return {
    a: scale * Math.cos(rotation),
    b: scale * Math.sin(rotation),
    tx,
    ty,
  };
}

function apply(m, p) {
  return { x: m.a * p.x - m.b * p.y + m.tx, y: m.b * p.x + m.a * p.y + m.ty };
}

/** compose(outer, inner): apply `inner` first, then `outer`. */
function compose(outer, inner) {
  return {
    a: outer.a * inner.a - outer.b * inner.b,
    b: outer.a * inner.b + outer.b * inner.a,
    tx: outer.a * inner.tx - outer.b * inner.ty + outer.tx,
    ty: outer.b * inner.tx + outer.a * inner.ty + outer.ty,
  };
}

function invert(m) {
  const det = m.a * m.a + m.b * m.b;
  if (det === 0) throw new Error('degenerate transform');
  const a = m.a / det;
  const b = -m.b / det;
  return { a, b, tx: -(a * m.tx - b * m.ty), ty: -(b * m.tx + a * m.ty) };
}

function scaleOf(m) {
  return Math.hypot(m.a, m.b);
}

function rotationOf(m) {
  return Math.atan2(m.b, m.a);
}

/** Split into smoothing-friendly parameters (log scale keeps zoom ratios linear). */
function decompose(m) {
  return {
    logScale: Math.log(scaleOf(m)),
    rotation: rotationOf(m),
    tx: m.tx,
    ty: m.ty,
  };
}

function recompose(p) {
  return fromParams(Math.exp(p.logScale), p.rotation, p.tx, p.ty);
}

/** Canvas setTransform() argument order. */
function toCanvas(m) {
  return [m.a, m.b, -m.b, m.a, m.tx, m.ty];
}

/** Scale about a fixed point - used for the shared "fill the frame" zoom. */
function zoomAbout(pivot, z) {
  return { a: z, b: 0, tx: pivot.x * (1 - z), ty: pivot.y * (1 - z) };
}

/**
 * Least-squares similarity that maps `src` points onto `dst` points
 * (Umeyama, uniform scale). Exact for two pairs, best-fit for more.
 */
function fitSimilarity(src, dst) {
  const n = src.length;
  if (n < 2 || dst.length !== n) throw new Error('need >= 2 matched point pairs');

  let sx = 0, sy = 0, dx = 0, dy = 0;
  for (let i = 0; i < n; i++) {
    sx += src[i].x; sy += src[i].y;
    dx += dst[i].x; dy += dst[i].y;
  }
  sx /= n; sy /= n; dx /= n; dy /= n;

  let num1 = 0, num2 = 0, den = 0;
  for (let i = 0; i < n; i++) {
    const x = src[i].x - sx, y = src[i].y - sy;
    const u = dst[i].x - dx, v = dst[i].y - dy;
    num1 += x * u + y * v;   // scale * cos(theta) * sum(r^2)
    num2 += x * v - y * u;   // scale * sin(theta) * sum(r^2)
    den += x * x + y * y;
  }
  if (den === 0) throw new Error('source points are coincident');

  const a = num1 / den;
  const b = num2 / den;
  return { a, b, tx: dx - (a * sx - b * sy), ty: dy - (b * sx + a * sy) };
}

/* ============ framing ============ */

// Where the anchors land on the output frame. eyeSpan is the distance
// between them as a fraction of the canvas width, so a bigger span means
// a tighter crop on the face.
const DEFAULT_FRAMING = {
  centerX: 0.5,   // midpoint of the anchors, fraction of canvas width
  centerY: 0.42,  // ... and of canvas height
  eyeSpan: 0.32,  // anchor separation, fraction of canvas width
  roll: 0,        // tilt of the anchor line in radians (0 = perfectly level)
  levelEyes: true, // false keeps each photo's own tilt (moves and resizes only)
};

/** Anchors are stored left-to-right as they appear in the photo. */
function normalizeAnchors(anchors) {
  if (!anchors || !anchors.left || !anchors.right) return null;
  const { left, right } = anchors;
  return left.x <= right.x
    ? { left: { x: left.x, y: left.y }, right: { x: right.x, y: right.y } }
    : { left: { x: right.x, y: right.y }, right: { x: left.x, y: left.y } };
}

/** Canvas-space positions the two anchors are pinned to. */
function targetAnchors(canvas, framing) {
  const f = { ...DEFAULT_FRAMING, ...(framing || {}) };
  const cx = f.centerX * canvas.width;
  const cy = f.centerY * canvas.height;
  const half = (f.eyeSpan * canvas.width) / 2;
  const dx = Math.cos(f.roll) * half;
  const dy = Math.sin(f.roll) * half;
  return {
    left: { x: cx - dx, y: cy - dy },
    right: { x: cx + dx, y: cy + dy },
    center: { x: cx, y: cy },
  };
}

/** The transform that puts one photo's anchors onto the canonical targets. */
function transformFor(anchors, canvas, framing) {
  const a = normalizeAnchors(anchors);
  if (!a) throw new Error('photo has no anchors');
  const f = { ...DEFAULT_FRAMING, ...(framing || {}) };
  const t = targetAnchors(canvas, f);

  if (f.levelEyes === false) {
    // Move and resize only: a head tilted in the original photo stays
    // tilted, which reads as more natural when the photos were casual.
    const span = Math.hypot(a.right.x - a.left.x, a.right.y - a.left.y);
    if (!(span > 0)) throw new Error('anchors are coincident');
    const scale = Math.hypot(t.right.x - t.left.x, t.right.y - t.left.y) / span;
    const mid = { x: (a.left.x + a.right.x) / 2, y: (a.left.y + a.right.y) / 2 };
    return fromParams(scale, 0, t.center.x - scale * mid.x, t.center.y - scale * mid.y);
  }
  return fitSimilarity([a.left, a.right], [t.left, t.right]);
}

/* ============ stabilization ============ */

/** Make an angle series continuous so averaging it is meaningful. */
function unwrapAngles(angles) {
  const out = [];
  let offset = 0;
  for (let i = 0; i < angles.length; i++) {
    if (i > 0) {
      const d = angles[i] + offset - out[i - 1];
      if (d > Math.PI) offset -= 2 * Math.PI;
      else if (d < -Math.PI) offset += 2 * Math.PI;
    }
    out.push(angles[i] + offset);
  }
  return out;
}

/**
 * Blend each transform toward a moving average of its neighbours.
 *
 * Anchor detection is a few pixels noisy, and pinning every photo exactly
 * turns that noise into a shimmer once frames flip past at 8fps. Pulling
 * each frame partway toward its neighbours calms that down.
 *
 * The catch: photos taken years apart genuinely differ - one from across
 * the room, the next from arm's length - and averaging those honest
 * differences would drag faces right out of position. So the correction is
 * capped: `maxShift` is how far, in canvas pixels, the anchor points are
 * allowed to move away from where they were pinned. Jitter is a couple of
 * pixels, so a small budget removes it while leaving alignment intact.
 *
 * @param {Array} transforms
 * @param {object} options
 * @param {number} [options.strength] - 0..1 pull toward the neighbourhood mean
 * @param {number} [options.radius] - neighbours averaged on each side
 * @param {number} [options.maxShift] - pixel budget for the drift (default: no cap)
 * @param {Array<{x:number,y:number}>} [options.probes] - canvas points to
 *   measure the drift at, normally the two anchor targets
 */
function smoothTransforms(transforms, options) {
  const { strength = 0.6, radius = 2, maxShift = Infinity, probes = [] } = options || {};
  if (!transforms.length || strength <= 0 || radius < 1 || maxShift <= 0) return transforms.slice();

  const parts = transforms.map(decompose);
  const rot = unwrapAngles(parts.map((p) => p.rotation));
  const keys = ['logScale', 'tx', 'ty'];

  const averaged = parts.map((p, i) => {
    const lo = Math.max(0, i - radius);
    const hi = Math.min(parts.length - 1, i + radius);
    const n = hi - lo + 1;
    const out = { ...p, rotation: rot[i] };
    for (const k of keys) {
      let sum = 0;
      for (let j = lo; j <= hi; j++) sum += parts[j][k];
      out[k] = sum / n;
    }
    let rsum = 0;
    for (let j = lo; j <= hi; j++) rsum += rot[j];
    out.rotation = rsum / n;
    return out;
  });

  return transforms.map((exact, i) => {
    const from = { ...parts[i], rotation: rot[i] };
    const to = averaged[i];
    const mix = (k) => recompose({
      logScale: from.logScale + k * (to.logScale - from.logScale),
      rotation: from.rotation + k * (to.rotation - from.rotation),
      tx: from.tx + k * (to.tx - from.tx),
      ty: from.ty + k * (to.ty - from.ty),
    });

    let k = strength;
    let candidate = mix(k);
    if (Number.isFinite(maxShift) && probes.length) {
      // Shrink the correction until the anchors stay inside the budget.
      for (let attempt = 0; attempt < 4; attempt++) {
        const drift = anchorDrift(exact, candidate, probes);
        if (drift <= maxShift || drift === 0) break;
        k *= maxShift / drift;
        candidate = mix(k);
      }
    }
    return candidate;
  });
}

/** How far `candidate` moves points that `exact` had put at `probes`. */
function anchorDrift(exact, candidate, probes) {
  const correction = compose(candidate, invert(exact));
  let worst = 0;
  for (const p of probes) {
    const moved = apply(correction, p);
    worst = Math.max(worst, Math.hypot(moved.x - p.x, moved.y - p.y));
  }
  return worst;
}

/* ============ how much of each photo to show ============ */

/**
 * How far the photo reaches beyond its own anchor point, measured in eye
 * spans: left/right/top/bottom of the aligned photo relative to the eye
 * midpoint, after any levelling rotation.
 *
 * Eye spans are the unit that matters here. Two photos of the same person
 * taken from different distances have wildly different pixel dimensions,
 * but if one leaves three eye spans of room above the eyes and the other
 * leaves five, that difference survives alignment - and it is exactly what
 * decides how much of each photo can fit on the canvas.
 */
function anchorExtents(anchors, image, levelEyes = true) {
  const a = normalizeAnchors(anchors);
  if (!a) return null;
  const dx = a.right.x - a.left.x;
  const dy = a.right.y - a.left.y;
  const span = Math.hypot(dx, dy);
  if (!(span > 0)) return null;

  const mid = { x: (a.left.x + a.right.x) / 2, y: (a.left.y + a.right.y) / 2 };
  const theta = levelEyes ? -Math.atan2(dy, dx) : 0;
  const cos = Math.cos(theta);
  const sin = Math.sin(theta);

  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const corner of [
    { x: 0, y: 0 },
    { x: image.width, y: 0 },
    { x: image.width, y: image.height },
    { x: 0, y: image.height },
  ]) {
    const ux = corner.x - mid.x;
    const uy = corner.y - mid.y;
    const x = (ux * cos - uy * sin) / span;
    const y = (ux * sin + uy * cos) / span;
    minX = Math.min(minX, x); maxX = Math.max(maxX, x);
    minY = Math.min(minY, y); maxY = Math.max(maxY, y);
  }
  return { left: -minX, right: maxX, top: -minY, bottom: maxY };
}

function percentile(values, p) {
  if (!values.length) return 0;
  const sorted = values.slice().sort((x, y) => x - y);
  // 1e-9 keeps a request like 2/3 of 3 photos from rounding up to all 3.
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length - 1e-9) - 1));
  return sorted[idx];
}

// Where "the photos fill the frame" sits on the zoom control. Below it the
// timelapse shows whole photos with background around them; above it, it
// keeps cropping in toward a portrait.
const FILL_AT = 0.6;
const CLOSE_UP = 1.8; // how far past filling the frame the control can go

// However wide the widest photo is, there is a point below which the face
// stops being the subject of anything. This is deliberately low - a normal
// full-body photo sits around 0.06, and cropping those is the opposite of
// what the whole-photo default is for - so it only catches the pathological
// case of someone standing at the far end of a field.
const MIN_FACE_SPAN = 0.04; // eye spacing as a fraction of canvas width

// Once photos are being cropped, the anchor goes where portraits have
// always put eyes: centred, a little above the middle.
const CROPPED_ANCHOR = { x: 0.5, y: 0.42 };

/** Eye span at which this photo would cover a canvas anchored at `at`. */
function spanToCover(extent, canvas, at) {
  return Math.max(
    (at.x * canvas.width) / extent.left,
    ((1 - at.x) * canvas.width) / extent.right,
    (at.y * canvas.height) / extent.top,
    ((1 - at.y) * canvas.height) / extent.bottom
  );
}

/** Eye span, in canvas pixels, for a zoom position between fit and close-up. */
function spanForZoom(fitSpan, fillSpan, zoom) {
  const z = Math.min(1, Math.max(0, zoom));
  const fill = Math.max(fillSpan, fitSpan);
  if (z <= FILL_AT) return fitSpan * Math.pow(fill / fitSpan, z / FILL_AT);
  return fill * Math.pow(CLOSE_UP, (z - FILL_AT) / (1 - FILL_AT));
}

/**
 * Choose one framing for a whole set of photos.
 *
 * Pinning the eyes scales every photo until the face is the same size, so
 * the framing cannot be chosen per photo - one number has to suit the set.
 * At zoom 0 that number is the largest face size at which the photos still
 * fit on the canvas whole, which is the point of a progress timelapse: the
 * body, the room and the years around it stay in shot. Turning the zoom up
 * crops in, first until the photos fill the frame, then toward a portrait.
 *
 * One exception to "fit everything": faces never shrink past
 * MIN_FACE_SPAN. A single shot from the far end of a field would otherwise
 * reduce the subject of every other frame to a smudge.
 *
 * The anchor lands where the leftover space divides evenly, so photos sit
 * centred rather than shoved against an edge, and it moves continuously as
 * the zoom changes.
 *
 * `tolerance` is the fraction of photos allowed to break the rule at each
 * end. It is not just outlier protection: insisting that literally every
 * photo fit whole means fitting the *union* of the set, and a series that
 * mixes portrait and landscape then leaves the frame mostly background.
 * Trimming the outer edges of the roomiest quarter keeps ~90% of each photo
 * while using far more of the frame. The fill end is stricter
 * (`fillTolerance`), because being strict there only costs a little extra
 * crop, and a control labelled "fills the frame" should mean it.
 *
 * @param {Array<{left,right,top,bottom}>} extents - from anchorExtents()
 * @param {{width:number,height:number}} canvas
 * @returns {{eyeSpan:number, centerX:number, centerY:number, fitSpan:number, fillSpan:number}}
 *   fractions of the canvas, ready to hand to targetAnchors()/transformFor()
 */
function autoFraming(extents, canvas, options) {
  const { zoom = 0, tolerance = 0.25, fillTolerance = 0.1, nudgeY = 0 } = options || {};
  const usable = extents.filter(Boolean);
  if (!usable.length) {
    return { eyeSpan: DEFAULT_FRAMING.eyeSpan, centerX: 0.5, centerY: 0.42, fitSpan: 0, fillSpan: 0 };
  }

  const at = (key, p) => percentile(usable.map((e) => e[key]), p);
  // The roomiest photos decide what fits...
  const hi = {
    left: at('left', 1 - tolerance), right: at('right', 1 - tolerance),
    top: at('top', 1 - tolerance), bottom: at('bottom', 1 - tolerance),
  };
  const fitSpan = Math.max(
    Math.min(canvas.width / (hi.left + hi.right), canvas.height / (hi.top + hi.bottom)),
    MIN_FACE_SPAN * canvas.width
  );

  // ...and the tightest decide what it takes to fill the frame, measured
  // against the anchor a cropped frame actually uses.
  const fillSpan = percentile(
    usable.map((e) => spanToCover(e, canvas, CROPPED_ANCHOR)),
    1 - fillTolerance
  );

  const span = spanForZoom(fitSpan, fillSpan, zoom);

  // At zoom 0 the anchor goes where the leftover space divides evenly, so
  // the photos sit centred. As the zoom rises it slides to the anchor a
  // cropped frame uses, arriving exactly at the fill point - which is the
  // placement fillSpan was measured against.
  const fitSlackX = canvas.width - fitSpan * (hi.left + hi.right);
  const fitSlackY = canvas.height - fitSpan * (hi.top + hi.bottom);
  const fitX = (fitSpan * hi.left + fitSlackX / 2) / canvas.width;
  const fitY = (fitSpan * hi.top + fitSlackY / 2) / canvas.height;
  const t = Math.min(1, Math.max(0, zoom / FILL_AT));
  const centerX = fitX + t * (CROPPED_ANCHOR.x - fitX);
  const centerY = fitY + t * (CROPPED_ANCHOR.y - fitY) + nudgeY;

  return {
    eyeSpan: span / canvas.width,
    centerX: Math.min(0.95, Math.max(0.05, centerX)),
    centerY: Math.min(0.95, Math.max(0.05, centerY)),
    fitSpan,
    fillSpan,
  };
}

/** Does this photo reach every edge of the canvas, or will background show? */
function coversFrame(extent, framing, canvas) {
  if (!extent) return false;
  const span = framing.eyeSpan * canvas.width;
  const x = framing.centerX * canvas.width;
  const y = framing.centerY * canvas.height;
  return (
    span * extent.left >= x - 0.5 &&
    span * extent.right >= canvas.width - x - 0.5 &&
    span * extent.top >= y - 0.5 &&
    span * extent.bottom >= canvas.height - y - 0.5
  );
}

/** The shape that suits a set of photos, for "match my photos" output. */
function medianAspect(sizes) {
  const ratios = (sizes || [])
    .filter((s) => s && s.width > 0 && s.height > 0)
    .map((s) => s.width / s.height);
  if (!ratios.length) return null;
  return percentile(ratios, 0.5);
}

/* ============ playback timeline ============ */

const DEFAULT_TIMELINE = {
  fps: 8,           // photos per second
  crossfadeMs: 0,   // blend between consecutive photos
  holdFirstMs: 0,   // linger on the first photo
  holdLastMs: 0,    // ... and the last
};

/** Start time of each photo, plus the total duration, in ms. */
function frameStarts(count, options) {
  const o = { ...DEFAULT_TIMELINE, ...(options || {}) };
  const base = 1000 / Math.max(0.01, o.fps);
  const starts = [];
  let t = 0;
  for (let i = 0; i < count; i++) {
    starts.push(t);
    t += base + (i === 0 ? o.holdFirstMs : 0) + (i === count - 1 ? o.holdLastMs : 0);
  }
  return { starts, total: t, base };
}

function totalDurationMs(count, options) {
  return frameStarts(count, options).total;
}

/**
 * Which photo(s) are on screen at time t.
 * Returns { a, b, mix }: draw photo `a`, then photo `b` at opacity `mix`.
 */
function timelineAt(t, count, options) {
  if (count <= 0) return { a: 0, b: 0, mix: 0, ended: true };
  const o = { ...DEFAULT_TIMELINE, ...(options || {}) };
  const { starts, total } = frameStarts(count, o);
  if (t <= 0) return { a: 0, b: 0, mix: 0, ended: false };
  if (t >= total) return { a: count - 1, b: count - 1, mix: 0, ended: true };

  let i = 0;
  while (i + 1 < count && starts[i + 1] <= t) i++;
  const dwell = (i + 1 < count ? starts[i + 1] : total) - starts[i];
  const into = t - starts[i];

  const fade = Math.min(o.crossfadeMs, dwell * 0.9);
  if (fade > 0 && i + 1 < count && into > dwell - fade) {
    return { a: i, b: i + 1, mix: (into - (dwell - fade)) / fade, ended: false };
  }
  return { a: i, b: i, mix: 0, ended: false };
}

/* ============ ordering photos ============ */

/** "IMG_2.jpg" before "IMG_10.jpg". */
function naturalCompare(a, b) {
  const re = /(\d+)|(\D+)/g;
  const ax = String(a).toLowerCase().match(re) || [];
  const bx = String(b).toLowerCase().match(re) || [];
  for (let i = 0; i < Math.min(ax.length, bx.length); i++) {
    const an = parseInt(ax[i], 10);
    const bn = parseInt(bx[i], 10);
    if (!Number.isNaN(an) && !Number.isNaN(bn)) {
      if (an !== bn) return an - bn;
    } else if (ax[i] !== bx[i]) {
      return ax[i] < bx[i] ? -1 : 1;
    }
  }
  return ax.length - bx.length;
}

/**
 * Chronological order: EXIF capture time when the photo has one, then the
 * file's own timestamp, and finally natural filename order so photos
 * without any date still land somewhere sensible instead of shuffling.
 */
function orderPhotos(photos) {
  return photos
    .map((p, i) => ({ p, i }))
    .sort((x, y) => {
      const tx = x.p.timeMs, ty = y.p.timeMs;
      const hx = Number.isFinite(tx), hy = Number.isFinite(ty);
      if (hx && hy && tx !== ty) return tx - ty;
      if (hx !== hy) return hx ? -1 : 1;
      const byName = naturalCompare(x.p.name || '', y.p.name || '');
      return byName !== 0 ? byName : x.i - y.i;
    })
    .map((e) => e.p);
}

/* ============ EXIF capture time ============ */

/**
 * Read DateTimeOriginal out of a JPEG's EXIF block. Returns epoch ms (the
 * timestamp has no zone, so it is read as UTC - consistent, which is all
 * ordering needs) or null when the photo carries no date.
 */
function parseExifDate(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return null;

  let i = 2;
  let tiff = -1;
  while (i + 4 < b.length) {
    if (b[i] !== 0xff) { i++; continue; }
    const marker = b[i + 1];
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; }
    if (marker === 0xda || marker === 0xd9) break; // image data starts
    const len = (b[i + 2] << 8) | b[i + 3];
    if (len < 2) break;
    if (marker === 0xe1 && i + 10 < b.length &&
        b[i + 4] === 0x45 && b[i + 5] === 0x78 && b[i + 6] === 0x69 && b[i + 7] === 0x66) {
      tiff = i + 10;
      break;
    }
    i += 2 + len;
  }
  if (tiff < 0 || tiff + 8 > b.length) return null;

  const little = b[tiff] === 0x49 && b[tiff + 1] === 0x49;
  const big = b[tiff] === 0x4d && b[tiff + 1] === 0x4d;
  if (!little && !big) return null;
  const u16 = (o) => (little ? b[o] | (b[o + 1] << 8) : (b[o] << 8) | b[o + 1]);
  const u32 = (o) =>
    little
      ? (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0
      : ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;

  if (u16(tiff + 2) !== 42) return null;

  const readAscii = (entry) => {
    const count = u32(entry + 4);
    const offset = count <= 4 ? entry + 8 : tiff + u32(entry + 8);
    if (offset + count > b.length) return null;
    let s = '';
    for (let k = 0; k < count; k++) {
      const c = b[offset + k];
      if (c === 0) break;
      s += String.fromCharCode(c);
    }
    return s;
  };

  const scanIfd = (start, wanted) => {
    if (start + 2 > b.length) return {};
    const n = u16(start);
    const found = {};
    for (let e = 0; e < n; e++) {
      const entry = start + 2 + e * 12;
      if (entry + 12 > b.length) break;
      const tag = u16(entry);
      if (wanted.includes(tag)) found[tag] = entry;
    }
    return found;
  };

  const ifd0 = scanIfd(tiff + u32(tiff + 4), [0x8769, 0x0132]);
  let entry = null;
  if (ifd0[0x8769] !== undefined) {
    const sub = scanIfd(tiff + u32(ifd0[0x8769] + 8), [0x9003, 0x9004]);
    entry = sub[0x9003] !== undefined ? sub[0x9003] : sub[0x9004];
  }
  if (entry === undefined || entry === null) entry = ifd0[0x0132];
  if (entry === undefined || entry === null) return null;

  const text = readAscii(entry);
  const m = text && text.match(/^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/);
  if (!m) return null;
  const ms = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
  return Number.isNaN(ms) ? null : ms;
}

/* ============ choosing a face ============ */

/**
 * Group shots are the norm in progress photos, so "biggest face" alone
 * picks the wrong person as soon as someone leans toward the camera.
 * Prefer the face that continues the previous photo's face: similar size,
 * similar position, with size as the tie-breaker for the first photo.
 */
function pickFace(faces, previous) {
  if (!faces || !faces.length) return -1;

  const span = (f) => {
    const a = normalizeAnchors(f.anchors);
    return a ? Math.hypot(a.right.x - a.left.x, a.right.y - a.left.y) : 0;
  };
  const mid = (f) => {
    const a = normalizeAnchors(f.anchors);
    return a ? { x: (a.left.x + a.right.x) / 2, y: (a.left.y + a.right.y) / 2 } : null;
  };

  const spans = faces.map(span);
  const biggest = Math.max(...spans);
  if (!(biggest > 0)) return -1;

  const prevMid = previous ? mid({ anchors: previous.anchors }) : null;
  const prevSpan = previous ? span({ anchors: previous.anchors }) : 0;
  const prevSize = previous && previous.image
    ? Math.hypot(previous.image.width, previous.image.height)
    : 0;

  let best = -1;
  let bestScore = -Infinity;
  faces.forEach((f, i) => {
    if (!(spans[i] > 0)) return;
    let score = spans[i] / biggest; // 0..1, relative size
    if (prevMid && prevSpan > 0) {
      const m = mid(f);
      // Positions come from different photos, so compare them in units of
      // the previous photo's diagonal (falling back to face width).
      const unit = prevSize > 0 ? prevSize : prevSpan * 8;
      const moved = Math.hypot(m.x - prevMid.x, m.y - prevMid.y) / unit;
      const resized = Math.abs(Math.log(spans[i] / prevSpan));
      score += 2.5 * Math.exp(-moved * 4) + 1.5 * Math.exp(-resized * 2);
    }
    if (score > bestScore) { bestScore = score; best = i; }
  });
  return best;
}

/* ============ where to look for a face ============ */

/**
 * Face detectors are trained on selfies: a head that fills a quarter of
 * the frame is easy, a head in a full-body shot from across the garden is
 * invisible to them. When a whole-image pass finds nothing, we re-run the
 * detector on crops - the head fills far more of a crop - working from the
 * most likely region outwards.
 *
 * @param {{width:number,height:number}} image
 * @param {{anchors:object,image:{width:number,height:number}}} [previous]
 *   the last photo that aligned, whose face is a good bet for where this
 *   one's face is too (people stand in the same spot year after year).
 * @returns {Array<{x:number,y:number,width:number,height:number}>}
 */
function candidateRegions(image, previous) {
  const regions = [];
  const push = (cx, cy, w, h) => {
    const width = Math.min(image.width, w);
    const height = Math.min(image.height, h);
    const x = Math.round(Math.min(Math.max(0, cx - width / 2), image.width - width));
    const y = Math.round(Math.min(Math.max(0, cy - height / 2), image.height - height));
    regions.push({ x, y, width: Math.round(width), height: Math.round(height) });
  };

  if (previous && previous.anchors && previous.image) {
    const a = normalizeAnchors(previous.anchors);
    if (a) {
      const span = Math.hypot(a.right.x - a.left.x, a.right.y - a.left.y);
      // Same fraction of the frame as last time, generously padded.
      const cx = ((a.left.x + a.right.x) / 2 / previous.image.width) * image.width;
      const cy = ((a.left.y + a.right.y) / 2 / previous.image.height) * image.height;
      // ~4.5x the eye separation covers head and shoulders with room for
      // the person having moved or grown between photos.
      const spanHere = (span / previous.image.width) * image.width;
      const size = spanHere * 4.5 + Math.max(image.width, image.height) * 0.05;
      push(cx, cy, size, size);
    }
  }

  // Overlapping grids, coarse then fine, each ordered from the middle out
  // because that is where people put themselves in a photo.
  for (const fraction of [0.5, 0.33]) {
    const w = image.width * fraction;
    const h = image.height * fraction;
    const steps = fraction === 0.5 ? 3 : 4;
    const cells = [];
    for (let row = 0; row < steps; row++) {
      for (let col = 0; col < steps; col++) {
        const cx = ((col + 0.5) / steps) * image.width;
        const cy = ((row + 0.5) / steps) * image.height;
        const fromCentre = Math.hypot(cx - image.width / 2, cy - image.height / 2);
        cells.push({ cx, cy, fromCentre });
      }
    }
    cells.sort((p, q) => p.fromCentre - q.fromCentre);
    for (const cell of cells) push(cell.cx, cell.cy, w, h);
  }
  return regions;
}

/** Drop faces that two overlapping crops both found. */
function mergeFaces(faces) {
  const kept = [];
  for (const face of faces) {
    const a = normalizeAnchors(face.anchors);
    if (!a) continue;
    const span = Math.hypot(a.right.x - a.left.x, a.right.y - a.left.y);
    const mid = { x: (a.left.x + a.right.x) / 2, y: (a.left.y + a.right.y) / 2 };
    const duplicate = kept.some((other) => {
      const b = normalizeAnchors(other.anchors);
      const otherMid = { x: (b.left.x + b.right.x) / 2, y: (b.left.y + b.right.y) / 2 };
      return Math.hypot(mid.x - otherMid.x, mid.y - otherMid.y) < span * 0.6;
    });
    if (!duplicate) kept.push({ ...face, anchors: a });
  }
  return kept;
}

/* ============ MediaPipe landmarks -> anchors ============ */

// Iris centres when the model refines them, otherwise the midpoint of each
// eye's inner and outer corner.
const LANDMARKS = {
  leftIris: 468,
  rightIris: 473,
  leftCorners: [33, 133],
  rightCorners: [362, 263],
};

/**
 * @param {Array<{x:number,y:number}>} landmarks - normalized 0..1 points
 * @param {{width:number,height:number}} image
 */
function landmarksToAnchors(landmarks, image) {
  if (!landmarks || landmarks.length < 400) return null;
  const px = (p) => ({ x: p.x * image.width, y: p.y * image.height });
  const mean = (idx) => {
    let x = 0, y = 0;
    for (const i of idx) { x += landmarks[i].x; y += landmarks[i].y; }
    return px({ x: x / idx.length, y: y / idx.length });
  };

  const hasIris = landmarks.length > LANDMARKS.rightIris;
  const one = hasIris ? px(landmarks[LANDMARKS.leftIris]) : mean(LANDMARKS.leftCorners);
  const two = hasIris ? px(landmarks[LANDMARKS.rightIris]) : mean(LANDMARKS.rightCorners);
  return normalizeAnchors({ left: one, right: two });
}

/* ============ exports ============ */

const Align = {
  identity, fromParams, apply, compose, invert, scaleOf, rotationOf,
  decompose, recompose, toCanvas, zoomAbout, fitSimilarity,
  normalizeAnchors, targetAnchors, transformFor,
  unwrapAngles, smoothTransforms, anchorDrift,
  anchorExtents, autoFraming, spanForZoom, spanToCover, coversFrame, medianAspect, percentile,
  MIN_FACE_SPAN,
  frameStarts, totalDurationMs, timelineAt,
  naturalCompare, orderPhotos, parseExifDate,
  pickFace, landmarksToAnchors, candidateRegions, mergeFaces,
  DEFAULT_FRAMING, DEFAULT_TIMELINE, LANDMARKS, FILL_AT,
};

if (typeof module !== 'undefined' && module.exports) module.exports = Align;
if (typeof window !== 'undefined') window.Align = Align;
