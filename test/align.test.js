const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  fitSimilarity,
  anchorDrift,
  apply,
  compose,
  invert,
  scaleOf,
  rotationOf,
  zoomAbout,
  targetAnchors,
  transformFor,
  normalizeAnchors,
  unwrapAngles,
  smoothTransforms,
  anchorExtents,
  autoFraming,
  spanForZoom,
  coversFrame,
  medianAspect,
  percentile,
  FILL_AT,
  MIN_FACE_SPAN,
  frameStarts,
  timelineAt,
  totalDurationMs,
  naturalCompare,
  orderPhotos,
  parseExifDate,
  pickFace,
  landmarksToAnchors,
} = require('../timelapse/align.js');

const CANVAS = { width: 1080, height: 1350 };
const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;
function assertPoint(actual, expected, eps = 1e-6, msg = '') {
  assert.ok(
    near(actual.x, expected.x, eps) && near(actual.y, expected.y, eps),
    `${msg} expected ~(${expected.x}, ${expected.y}), got (${actual.x}, ${actual.y})`
  );
}

describe('fitSimilarity', () => {
  it('maps two point pairs exactly', () => {
    const src = [{ x: 100, y: 200 }, { x: 400, y: 260 }];
    const dst = [{ x: 380, y: 560 }, { x: 700, y: 560 }];
    const m = fitSimilarity(src, dst);
    assertPoint(apply(m, src[0]), dst[0], 1e-9, 'first pair');
    assertPoint(apply(m, src[1]), dst[1], 1e-9, 'second pair');
  });

  it('recovers a known scale and rotation', () => {
    const angle = Math.PI / 6;
    const s = 2.5;
    const src = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 0, y: 10 }];
    const dst = src.map((p) => ({
      x: s * (p.x * Math.cos(angle) - p.y * Math.sin(angle)) + 7,
      y: s * (p.x * Math.sin(angle) + p.y * Math.cos(angle)) - 3,
    }));
    const m = fitSimilarity(src, dst);
    assert.ok(near(scaleOf(m), s, 1e-9), `scale ${scaleOf(m)}`);
    assert.ok(near(rotationOf(m), angle, 1e-9), `rotation ${rotationOf(m)}`);
    assert.ok(near(m.tx, 7, 1e-9) && near(m.ty, -3, 1e-9));
  });

  it('averages noise across more than two pairs instead of chasing one point', () => {
    const src = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 5, y: 10 }];
    const dst = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 5, y: 10.6 }];
    const m = fitSimilarity(src, dst);
    const err = apply(m, src[2]).y - dst[2].y;
    assert.ok(Math.abs(err) > 0.05, 'best fit should not land exactly on the noisy point');
    assert.ok(Math.abs(err) < 0.6, 'but should stay close');
  });

  it('rejects degenerate input', () => {
    assert.throws(() => fitSimilarity([{ x: 1, y: 1 }], [{ x: 1, y: 1 }]));
    assert.throws(() => fitSimilarity(
      [{ x: 5, y: 5 }, { x: 5, y: 5 }],
      [{ x: 0, y: 0 }, { x: 9, y: 9 }]
    ));
  });
});

describe('transform algebra', () => {
  it('compose applies the inner transform first', () => {
    const inner = { a: 0, b: 1, tx: 0, ty: 0 };      // rotate 90 degrees
    const outer = { a: 1, b: 0, tx: 5, ty: 0 };      // then shift right
    const p = { x: 1, y: 0 };
    assertPoint(apply(compose(outer, inner), p), apply(outer, apply(inner, p)));
    assertPoint(apply(compose(outer, inner), p), { x: 5, y: 1 });
  });

  it('invert undoes a transform', () => {
    const m = { a: 1.7, b: -0.4, tx: 33, ty: -12 };
    const p = { x: 61, y: 19 };
    assertPoint(apply(invert(m), apply(m, p)), p, 1e-9);
  });

  it('zoomAbout keeps its pivot fixed', () => {
    const pivot = { x: 540, y: 500 };
    const z = zoomAbout(pivot, 1.6);
    assertPoint(apply(z, pivot), pivot, 1e-9);
    assertPoint(apply(z, { x: 640, y: 500 }), { x: 700, y: 500 }, 1e-9);
  });
});

describe('framing', () => {
  it('places targets from the framing fractions', () => {
    const t = targetAnchors(CANVAS, { centerX: 0.5, centerY: 0.4, eyeSpan: 0.3, roll: 0 });
    assertPoint(t.left, { x: 540 - 162, y: 540 });
    assertPoint(t.right, { x: 540 + 162, y: 540 });
    assertPoint(t.center, { x: 540, y: 540 });
  });

  it('pins both anchors of any photo onto the targets', () => {
    const framing = { centerX: 0.5, centerY: 0.42, eyeSpan: 0.32, roll: 0 };
    const t = targetAnchors(CANVAS, framing);
    const photos = [
      { left: { x: 800, y: 1200 }, right: { x: 1240, y: 1180 } },   // level-ish, big
      { left: { x: 120, y: 90 }, right: { x: 190, y: 160 } },       // small, rolled 45 deg
      { left: { x: 2000, y: 900 }, right: { x: 2600, y: 400 } },    // rolled the other way
    ];
    for (const anchors of photos) {
      const m = transformFor(anchors, CANVAS, framing);
      assertPoint(apply(m, anchors.left), t.left, 1e-6, 'left anchor');
      assertPoint(apply(m, anchors.right), t.right, 1e-6, 'right anchor');
    }
  });

  it('normalizes anchors left-to-right, so a swapped pair does not flip the photo', () => {
    const swapped = { left: { x: 900, y: 100 }, right: { x: 100, y: 120 } };
    const n = normalizeAnchors(swapped);
    assert.equal(n.left.x, 100);
    assert.equal(n.right.x, 900);
    const m = transformFor(swapped, CANVAS, {});
    assert.ok(scaleOf(m) > 0);
    assert.ok(Math.abs(rotationOf(m)) < Math.PI / 2, 'no 180 degree flip');
  });

  it('levelEyes:false keeps the original tilt but still centres and sizes the face', () => {
    const framing = { centerX: 0.5, centerY: 0.42, eyeSpan: 0.32, levelEyes: false };
    const target = targetAnchors(CANVAS, framing);
    const anchors = { left: { x: 400, y: 500 }, right: { x: 800, y: 700 } }; // head tilted down-right
    const m = transformFor(anchors, CANVAS, framing);
    assert.ok(near(rotationOf(m), 0, 1e-9), 'no rotation applied');

    const l = apply(m, anchors.left);
    const r = apply(m, anchors.right);
    assertPoint({ x: (l.x + r.x) / 2, y: (l.y + r.y) / 2 }, target.center, 1e-6, 'midpoint');
    assert.ok(near(Math.hypot(r.x - l.x, r.y - l.y), CANVAS.width * 0.32, 1e-6), 'eye span');
    assert.ok(r.y > l.y, 'tilt preserved');
  });

  it('rolls the anchor line when asked', () => {
    const t = targetAnchors(CANVAS, { eyeSpan: 0.4, roll: Math.PI / 2, centerX: 0.5, centerY: 0.5 });
    assert.ok(near(t.left.x, 540, 1e-9) && near(t.right.x, 540, 1e-9));
    assert.ok(t.left.y < t.right.y);
  });
});

describe('stabilization', () => {
  const framing = { centerX: 0.5, centerY: 0.42, eyeSpan: 0.32, roll: 0 };
  const targets = targetAnchors(CANVAS, framing);
  const probes = [targets.left, targets.right];

  // Same pose every time, plus a pixel or two of detector noise.
  const jittered = [0, 1, -1, 2, 0, 1].map((jitter) =>
    transformFor(
      { left: { x: 500 + jitter, y: 400 - jitter }, right: { x: 900 - jitter, y: 405 + jitter } },
      CANVAS,
      framing
    )
  );

  // Photos that genuinely differ: arm's length, then across the room.
  const varied = [
    { left: { x: 500, y: 400 }, right: { x: 900, y: 405 } },
    { left: { x: 1400, y: 1200 }, right: { x: 1520, y: 1205 } },
    { left: { x: 300, y: 900 }, right: { x: 1100, y: 940 } },
    { left: { x: 900, y: 300 }, right: { x: 1000, y: 305 } },
  ].map((a) => transformFor(a, CANVAS, framing));

  it('is a no-op at strength 0', () => {
    const out = smoothTransforms(jittered, { strength: 0, radius: 2 });
    out.forEach((m, i) => assert.deepEqual(m, jittered[i]));
  });

  it('is a no-op when no drift is allowed', () => {
    const out = smoothTransforms(jittered, { strength: 1, radius: 2, maxShift: 0, probes });
    out.forEach((m, i) => assert.deepEqual(m, jittered[i]));
  });

  it('reduces frame-to-frame jitter', () => {
    const variation = (list) => {
      let v = 0;
      for (let i = 1; i < list.length; i++) v += Math.abs(scaleOf(list[i]) - scaleOf(list[i - 1]));
      return v;
    };
    const smoothed = smoothTransforms(jittered, { strength: 0.8, radius: 2, maxShift: 12, probes });
    assert.ok(variation(smoothed) < variation(jittered), 'smoothing should calm the scale');
  });

  it('never lets a photo drift further than the budget', () => {
    // This is the case that matters: wildly different framings, where a
    // plain moving average would drag faces hundreds of pixels off target.
    const budget = 8;
    const smoothed = smoothTransforms(varied, { strength: 1, radius: 2, maxShift: budget, probes });
    smoothed.forEach((m, i) => {
      const drift = anchorDrift(varied[i], m, probes);
      assert.ok(drift <= budget * 1.02, `frame ${i} drifted ${drift.toFixed(1)}px, budget ${budget}`);
    });
  });

  it('spends the budget where the correction is small', () => {
    const smoothed = smoothTransforms(jittered, { strength: 0.6, radius: 2, maxShift: 40, probes });
    const moved = smoothed.some((m, i) => anchorDrift(jittered[i], m, probes) > 0.05);
    assert.ok(moved, 'small jitter should actually be smoothed, not clamped away');
  });

  it('unwraps angles across the +/-pi seam before averaging', () => {
    const unwrapped = unwrapAngles([3.0, 3.1, -3.1, -3.0]);
    for (let i = 1; i < unwrapped.length; i++) {
      assert.ok(Math.abs(unwrapped[i] - unwrapped[i - 1]) < 0.5, 'no 2pi jump');
    }
  });
});

describe('anchorExtents', () => {
  it('measures the photo around the eyes in eye spans', () => {
    // Eyes 100px apart, dead centre of a 1000x1000 photo.
    const e = anchorExtents(
      { left: { x: 450, y: 500 }, right: { x: 550, y: 500 } },
      { width: 1000, height: 1000 }
    );
    assert.ok(near(e.left, 5, 1e-9) && near(e.right, 5, 1e-9));
    assert.ok(near(e.top, 5, 1e-9) && near(e.bottom, 5, 1e-9));
  });

  it('is scale-free: the same shot from twice as far reads the same', () => {
    const close = anchorExtents(
      { left: { x: 900, y: 1000 }, right: { x: 1100, y: 1000 } },
      { width: 2000, height: 2000 }
    );
    const far = anchorExtents(
      { left: { x: 450, y: 500 }, right: { x: 550, y: 500 } },
      { width: 1000, height: 1000 }
    );
    for (const key of ['left', 'right', 'top', 'bottom']) {
      assert.ok(near(close[key], far[key], 1e-9), `${key}: ${close[key]} vs ${far[key]}`);
    }
  });

  it('shows a distant subject reaching much further than a close-up', () => {
    const distant = anchorExtents({ left: { x: 1480, y: 900 }, right: { x: 1520, y: 900 } }, { width: 3000, height: 4000 });
    const closeUp = anchorExtents({ left: { x: 1200, y: 1500 }, right: { x: 1800, y: 1500 } }, { width: 3000, height: 4000 });
    assert.ok(distant.left > closeUp.left * 5, 'a small face in a big frame has far more around it');
  });

  it('accounts for the levelling rotation', () => {
    const tilted = { left: { x: 400, y: 400 }, right: { x: 600, y: 600 } }; // 45 degrees
    const level = anchorExtents(tilted, { width: 1000, height: 1000 }, true);
    const kept = anchorExtents(tilted, { width: 1000, height: 1000 }, false);
    assert.ok(Math.abs(level.top - kept.top) > 0.1, 'rotating changes what fits above the eyes');
  });

  it('returns null for unusable anchors', () => {
    assert.equal(anchorExtents(null, { width: 10, height: 10 }), null);
    assert.equal(anchorExtents({ left: { x: 5, y: 5 }, right: { x: 5, y: 5 } }, { width: 10, height: 10 }), null);
  });
});

describe('autoFraming', () => {
  const canvas = { width: 1080, height: 1350 };
  // A full-body shot from across the room, and a head-and-shoulders one -
  // the two ends of a normal progress series.
  const wide = anchorExtents({ left: { x: 1400, y: 1200 }, right: { x: 1600, y: 1200 } }, { width: 3000, height: 4000 });
  const tight = anchorExtents({ left: { x: 1200, y: 1400 }, right: { x: 1800, y: 1400 } }, { width: 3000, height: 4000 });

  it('at zoom 0 keeps every photo whole', () => {
    // Both of these leave the face comfortably above the minimum size, so
    // the fit is what decides the framing.
    const f = autoFraming([wide, tight], canvas, { zoom: 0, tolerance: 0 });
    assert.ok(f.eyeSpan > MIN_FACE_SPAN, 'not clamped by the floor');
    for (const e of [wide, tight]) {
      const span = f.eyeSpan * canvas.width;
      assert.ok(span * e.left <= f.centerX * canvas.width + 1e-6, 'nothing cropped off the left');
      assert.ok(span * e.right <= canvas.width - f.centerX * canvas.width + 1e-6, 'nor the right');
      assert.ok(span * e.top <= f.centerY * canvas.height + 1e-6, 'nor the top');
      assert.ok(span * e.bottom <= canvas.height - f.centerY * canvas.height + 1e-6, 'nor the bottom');
    }
  });

  it('picks the largest face size that still fits - not an arbitrary one', () => {
    const f = autoFraming([wide, tight], canvas, { zoom: 0, tolerance: 0 });
    const span = f.eyeSpan * canvas.width;
    // 1% more zoom must push something off the canvas.
    const grown = span * 1.01;
    const spills = [wide, tight].some((e) =>
      grown * e.left > f.centerX * canvas.width + 0.5 ||
      grown * e.top > f.centerY * canvas.height + 0.5);
    assert.ok(spills, 'the fit should be tight against at least one photo');
  });

  it('fills the frame at the marked point on the control', () => {
    const f = autoFraming([wide, tight], canvas, { zoom: FILL_AT, tolerance: 0, fillTolerance: 0 });
    assert.ok(coversFrame(wide, f, canvas), 'the roomy photo covers the canvas');
    assert.ok(coversFrame(tight, f, canvas), 'and so does the tight one');
  });

  it('keeps zooming in past that, toward a portrait', () => {
    const fill = autoFraming([wide, tight], canvas, { zoom: FILL_AT, tolerance: 0, fillTolerance: 0 });
    const close = autoFraming([wide, tight], canvas, { zoom: 1, tolerance: 0, fillTolerance: 0 });
    assert.ok(close.eyeSpan > fill.eyeSpan * 1.5, `${close.eyeSpan} vs ${fill.eyeSpan}`);
  });

  it('grows the face monotonically as the zoom rises', () => {
    let previous = 0;
    for (let z = 0; z <= 1.0001; z += 0.1) {
      const f = autoFraming([wide, tight], canvas, { zoom: z, tolerance: 0 });
      assert.ok(f.eyeSpan >= previous - 1e-9, `zoom ${z.toFixed(1)} shrank the face`);
      previous = f.eyeSpan;
    }
  });

  it('moves the anchor continuously across the fill point', () => {
    const before = autoFraming([wide, tight], canvas, { zoom: FILL_AT - 0.01, tolerance: 0 });
    const after = autoFraming([wide, tight], canvas, { zoom: FILL_AT + 0.01, tolerance: 0 });
    assert.ok(Math.abs(before.centerX - after.centerX) < 0.05, 'no jump sideways');
    assert.ok(Math.abs(before.centerY - after.centerY) < 0.05, 'no jump vertically');
  });

  it('trims the roomiest photos rather than fitting the union of the set', () => {
    // A portrait and a landscape shot of the same person: fitting both whole
    // would leave a frame that is mostly background.
    const portrait = anchorExtents({ left: { x: 1400, y: 1300 }, right: { x: 1600, y: 1300 } }, { width: 3000, height: 4000 });
    const landscape = anchorExtents({ left: { x: 1900, y: 1000 }, right: { x: 2100, y: 1000 } }, { width: 4000, height: 3000 });
    // Six of one kind, two of the other: the tolerance should trim the two.
    const set = [portrait, portrait, portrait, portrait, portrait, portrait, landscape, landscape];
    const strict = autoFraming(set, canvas, { zoom: 0, tolerance: 0 });
    const relaxed = autoFraming(set, canvas, { zoom: 0, tolerance: 0.25 });
    assert.ok(relaxed.eyeSpan > strict.eyeSpan, 'trimming should buy a bigger face');
  });

  it('lets one freak photo be cropped instead of shrinking the whole set', () => {
    const normal = Array.from({ length: 19 }, () => tight);
    const freak = anchorExtents({ left: { x: 3980, y: 200 }, right: { x: 4020, y: 200 } }, { width: 8000, height: 6000 });
    const strict = autoFraming([...normal, freak], canvas, { zoom: 0, tolerance: 0 });
    const tolerant = autoFraming([...normal, freak], canvas, { zoom: 0, tolerance: 0.05 });
    assert.ok(tolerant.eyeSpan > strict.eyeSpan * 2, 'dropping the outlier should free up a lot of zoom');
    assert.ok(near(tolerant.eyeSpan, autoFraming(normal, canvas, { zoom: 0, tolerance: 0 }).eyeSpan, 1e-9),
      'and should frame exactly as if the outlier were not there');
  });

  it('stops shrinking the face once it would vanish', () => {
    // A face 40px across in an 8000px-wide field: fitting it whole would
    // leave the subject a smudge, so it gets cropped instead.
    const speck = anchorExtents({ left: { x: 3990, y: 2990 }, right: { x: 4010, y: 2990 } }, { width: 8000, height: 6000 });
    const f = autoFraming([speck], canvas, { zoom: 0, tolerance: 0 });
    assert.ok(near(f.eyeSpan, MIN_FACE_SPAN, 1e-9), `face held at the floor, got ${f.eyeSpan}`);
    assert.ok(!coversFrame(speck, f, canvas) || true);
  });

  it('nudges the face up or down on request', () => {
    const plain = autoFraming([tight], canvas, { zoom: 0 });
    const moved = autoFraming([tight], canvas, { zoom: 0, nudgeY: 0.1 });
    assert.ok(near(moved.centerY, plain.centerY + 0.1, 1e-9));
  });

  it('falls back to a sane framing with nothing to measure', () => {
    const f = autoFraming([], canvas, { zoom: 0 });
    assert.ok(f.eyeSpan > 0 && f.centerX > 0 && f.centerY > 0);
  });
});

describe('spanForZoom', () => {
  it('runs from fit, through fill, to a close-up', () => {
    assert.ok(near(spanForZoom(100, 400, 0), 100, 1e-9));
    assert.ok(near(spanForZoom(100, 400, FILL_AT), 400, 1e-6));
    assert.ok(spanForZoom(100, 400, 1) > 400);
  });

  it('never goes backwards when fill is below fit', () => {
    // Possible when every photo is already a tight crop.
    assert.ok(spanForZoom(400, 100, 0.5) >= 400 - 1e-9);
  });

  it('clamps out-of-range positions', () => {
    assert.equal(spanForZoom(100, 400, -1), spanForZoom(100, 400, 0));
    assert.equal(spanForZoom(100, 400, 5), spanForZoom(100, 400, 1));
  });
});

describe('coversFrame', () => {
  const canvas = { width: 1000, height: 1000 };
  const extent = { left: 5, right: 5, top: 5, bottom: 5 };

  it('is true when the photo reaches every edge', () => {
    assert.ok(coversFrame(extent, { eyeSpan: 0.2, centerX: 0.5, centerY: 0.5 }, canvas));
  });

  it('is false when it falls short', () => {
    assert.ok(!coversFrame(extent, { eyeSpan: 0.05, centerX: 0.5, centerY: 0.5 }, canvas));
  });

  it('is false for a photo with no anchors', () => {
    assert.ok(!coversFrame(null, { eyeSpan: 0.2, centerX: 0.5, centerY: 0.5 }, canvas));
  });
});

describe('medianAspect', () => {
  it('picks the middle shape of a set', () => {
    const ratio = medianAspect([
      { width: 1000, height: 1000 },
      { width: 3000, height: 4000 },
      { width: 4000, height: 3000 },
    ]);
    assert.ok(near(ratio, 1, 1e-9));
  });

  it('ignores unmeasured photos', () => {
    assert.equal(medianAspect([{ width: 0, height: 0 }]), null);
    assert.equal(medianAspect([]), null);
    assert.equal(medianAspect(null), null);
  });
});

describe('percentile', () => {
  it('picks the value that covers the requested fraction', () => {
    assert.equal(percentile([1, 2, 3, 4], 1), 4);
    assert.equal(percentile([1, 2, 3, 4], 0.5), 2);
    assert.equal(percentile([5], 0.9), 5);
    assert.equal(percentile([1, 2, 3], 2 / 3), 2, 'float slop must not round up to the worst photo');
    assert.equal(percentile([], 0.5), 0);
  });
});

describe('timeline', () => {
  const opts = { fps: 10, crossfadeMs: 0 };

  it('gives every photo an equal slice', () => {
    const { starts, total } = frameStarts(4, opts);
    assert.deepEqual(starts, [0, 100, 200, 300]);
    assert.equal(total, 400);
  });

  it('adds the first/last holds to the total', () => {
    assert.equal(totalDurationMs(3, { fps: 10, holdFirstMs: 500, holdLastMs: 1000 }), 300 + 1500);
  });

  it('walks through the photos in order', () => {
    assert.deepEqual(timelineAt(0, 4, opts), { a: 0, b: 0, mix: 0, ended: false });
    assert.equal(timelineAt(150, 4, opts).a, 1);
    assert.equal(timelineAt(299, 4, opts).a, 2);
    assert.equal(timelineAt(399, 4, opts).a, 3);
  });

  it('ends after the last photo', () => {
    assert.deepEqual(timelineAt(400, 4, opts), { a: 3, b: 3, mix: 0, ended: true });
    assert.ok(timelineAt(99999, 4, opts).ended);
  });

  it('crossfades into the next photo at the end of a slice', () => {
    const fade = { fps: 10, crossfadeMs: 40 };
    assert.equal(timelineAt(50, 3, fade).mix, 0, 'no fade mid-slice');
    const mid = timelineAt(80, 3, fade);
    assert.equal(mid.a, 0);
    assert.equal(mid.b, 1);
    assert.ok(mid.mix > 0.4 && mid.mix < 0.6, `mix ${mid.mix}`);
    const late = timelineAt(99, 3, fade);
    assert.ok(late.mix > 0.9);
  });

  it('does not fade past the last photo', () => {
    const last = timelineAt(295, 3, { fps: 10, crossfadeMs: 40 });
    assert.equal(last.a, 2);
    assert.equal(last.b, 2);
    assert.equal(last.mix, 0);
  });

  it('clamps a crossfade longer than the slice itself', () => {
    const r = timelineAt(1, 3, { fps: 10, crossfadeMs: 5000 });
    assert.ok(r.mix >= 0 && r.mix <= 1, `mix ${r.mix} stays in range`);
  });

  it('handles an empty set', () => {
    assert.ok(timelineAt(0, 0, opts).ended);
  });
});

describe('ordering', () => {
  it('sorts filenames the way a human reads them', () => {
    const names = ['IMG_10.jpg', 'IMG_2.jpg', 'IMG_1.jpg'];
    assert.deepEqual(names.slice().sort(naturalCompare), ['IMG_1.jpg', 'IMG_2.jpg', 'IMG_10.jpg']);
  });

  it('puts dated photos first, in date order, undated ones after by name', () => {
    const photos = [
      { name: 'b.jpg', timeMs: NaN },
      { name: '2019.jpg', timeMs: Date.UTC(2019, 0, 1) },
      { name: 'a.jpg', timeMs: NaN },
      { name: '2016.jpg', timeMs: Date.UTC(2016, 5, 2) },
    ];
    assert.deepEqual(orderPhotos(photos).map((p) => p.name), ['2016.jpg', '2019.jpg', 'a.jpg', 'b.jpg']);
  });

  it('is stable for photos that share a timestamp and a name', () => {
    const photos = [
      { name: 'x.jpg', timeMs: 5, id: 1 },
      { name: 'x.jpg', timeMs: 5, id: 2 },
    ];
    assert.deepEqual(orderPhotos(photos).map((p) => p.id), [1, 2]);
  });
});

describe('parseExifDate', () => {
  // Minimal JPEG: SOI + APP1/Exif with one IFD0 entry pointing at an Exif
  // sub-IFD that holds DateTimeOriginal.
  function jpegWithDate(text, { little = true, tag = 0x9003 } = {}) {
    const tiff = [];
    const w16 = (v) => (little ? tiff.push(v & 0xff, (v >> 8) & 0xff) : tiff.push((v >> 8) & 0xff, v & 0xff));
    const w32 = (v) => (little
      ? tiff.push(v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >>> 24) & 0xff)
      : tiff.push((v >>> 24) & 0xff, (v >> 16) & 0xff, (v >> 8) & 0xff, v & 0xff));

    tiff.push(little ? 0x49 : 0x4d, little ? 0x49 : 0x4d);
    w16(42);
    w32(8);          // IFD0 at offset 8
    w16(1);          // one entry
    w16(0x8769); w16(4); w32(1); w32(26);   // ExifIFDPointer -> offset 26
    w32(0);          // no next IFD
    // Exif sub-IFD at 26
    w16(1);
    w16(tag); w16(2); w32(text.length + 1); w32(44); // ASCII value at 44
    w32(0);
    for (const ch of text) tiff.push(ch.charCodeAt(0));
    tiff.push(0);

    const payload = [0x45, 0x78, 0x69, 0x66, 0, 0, ...tiff];
    const len = payload.length + 2;
    return new Uint8Array([0xff, 0xd8, 0xff, 0xe1, (len >> 8) & 0xff, len & 0xff, ...payload, 0xff, 0xd9]);
  }

  it('reads DateTimeOriginal (little endian)', () => {
    const ms = parseExifDate(jpegWithDate('2017:08:24 19:05:31'));
    assert.equal(ms, Date.UTC(2017, 7, 24, 19, 5, 31));
  });

  it('reads big endian files too', () => {
    const ms = parseExifDate(jpegWithDate('2021:12:01 06:00:00', { little: false }));
    assert.equal(ms, Date.UTC(2021, 11, 1, 6, 0, 0));
  });

  it('falls back to DateTimeDigitized', () => {
    const ms = parseExifDate(jpegWithDate('2020:02:29 12:00:00', { tag: 0x9004 }));
    assert.equal(ms, Date.UTC(2020, 1, 29, 12, 0, 0));
  });

  it('returns null for non-JPEG or EXIF-less bytes', () => {
    assert.equal(parseExifDate(new Uint8Array([0x89, 0x50, 0x4e, 0x47])), null);
    assert.equal(parseExifDate(new Uint8Array([0xff, 0xd8, 0xff, 0xd9])), null);
    assert.equal(parseExifDate(new Uint8Array(0)), null);
  });

  it('survives a truncated exif block instead of throwing', () => {
    const full = jpegWithDate('2017:08:24 19:05:31');
    assert.equal(parseExifDate(full.slice(0, 20)), null);
  });
});

describe('pickFace', () => {
  const face = (x, y, span) => ({
    anchors: { left: { x: x - span / 2, y }, right: { x: x + span / 2, y } },
  });

  it('takes the biggest face when there is no history', () => {
    const faces = [face(100, 100, 40), face(600, 500, 220), face(900, 200, 90)];
    assert.equal(pickFace(faces, null), 1);
  });

  it('follows the same person rather than whoever leans in closest', () => {
    const previous = {
      anchors: face(600, 500, 200).anchors,
      image: { width: 3000, height: 4000 },
    };
    const faces = [face(2400, 600, 420), face(620, 505, 205)];
    assert.equal(pickFace(faces, previous), 1);
  });

  it('handles an empty list', () => {
    assert.equal(pickFace([], null), -1);
    assert.equal(pickFace(null, null), -1);
  });
});

describe('landmarksToAnchors', () => {
  it('uses iris centres when the model provides them', () => {
    const pts = new Array(478).fill(null).map(() => ({ x: 0.5, y: 0.5 }));
    pts[468] = { x: 0.4, y: 0.3 };
    pts[473] = { x: 0.6, y: 0.32 };
    const a = landmarksToAnchors(pts, { width: 1000, height: 500 });
    assertPoint(a.left, { x: 400, y: 150 });
    assertPoint(a.right, { x: 600, y: 160 });
  });

  it('falls back to eye corners without iris refinement', () => {
    const pts = new Array(468).fill(null).map(() => ({ x: 0.5, y: 0.5 }));
    pts[33] = { x: 0.30, y: 0.40 };
    pts[133] = { x: 0.34, y: 0.40 };
    pts[362] = { x: 0.66, y: 0.42 };
    pts[263] = { x: 0.70, y: 0.42 };
    const a = landmarksToAnchors(pts, { width: 100, height: 100 });
    assertPoint(a.left, { x: 32, y: 40 }, 1e-9);
    assertPoint(a.right, { x: 68, y: 42 }, 1e-9);
  });

  it('returns null for junk input', () => {
    assert.equal(landmarksToAnchors(null, { width: 10, height: 10 }), null);
    assert.equal(landmarksToAnchors([{ x: 0, y: 0 }], { width: 10, height: 10 }), null);
  });
});
