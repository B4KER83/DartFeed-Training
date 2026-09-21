// Training Capture v0.7 — negative-capture Framing Guide.
//
// WHY THIS EXISTS: the first real batch of empty-board negatives
// (2026-09-21) turned out to be captured at a much wider field of view
// than the 61-image positive dataset the v0.3/v0.4 model trains on — the
// board filled ~75% of frame width / ~100%+ of frame height in the
// negatives, vs. ~93.4% / ~70.1% in the positives. A model trained on
// that mismatch could trivially tell "positive" from "negative" by field
// of view alone (background/margin/ring-light visibility) instead of by
// whether a dart is actually present — a worse, more misleading failure
// than the false-positive problem this whole negative-data effort exists
// to fix. Measured after the fact, that mismatch turned out to be a hard
// geometry problem (the negatives' raw capture didn't have enough
// vertical field of view to be cropped into a match) — so the fix has to
// happen AT CAPTURE TIME, not in post-processing. This module is that
// fix: it measures the board's own ring geometry live, live, from the
// actual video feed, and only allows a negative to be saved once that
// geometry matches the positive dataset's own measured framing, within a
// tolerance derived from the positive dataset's own real variation (not
// an invented number).
//
// TARGET / TOLERANCE PROVENANCE (see chat — computed from the actual 61
// dataset images, not assumed from filenames or capture settings):
//   Board/cabinet-ring diameter ÷ image width:  61-image median 0.9344,
//     10th/90th percentile band [0.8219, 0.9391] -> PASS band [0.82, 0.94]
//   Board/cabinet-ring diameter ÷ image height: 61-image median 0.7011,
//     10th/90th percentile band [0.6166, 0.7046] -> PASS band [0.62, 0.71]
//   Board centre offset from frame centre: measured (refined-centre fit)
//     on a 16-image sample at roughly +/-3-4% of width/height -> centre
//     tolerance set to 5% for a small margin of safety.
//   Frame orientation: all 61 positives are portrait (640x853). The
//   2026-09-21 negatives were captured in landscape (2560x1920) — this
//   was itself part of the problem, so orientation is checked explicitly,
//   not just left as a side effect of the diameter/height ratio.
//
// This is a TEMPORARY data-collection aid for building the v0.4 negative
// set. It does not touch production DartFeed, calibration, scoring, the
// v0.3 model, or the existing 61-image dataset in any way — it only reads
// the live camera frame and draws an overlay / gates the existing
// "Save Empty Board" control in this app.
(function (global) {
  'use strict';

  var TARGET_DIAM_FRAC_W = 0.9344;
  var TARGET_DIAM_FRAC_H = 0.7011;
  var DIAM_FRAC_W_RANGE = [0.82, 0.94];
  var DIAM_FRAC_H_RANGE = [0.62, 0.71];
  var CENTER_TOLERANCE_FRAC = 0.05;
  var ORIENTATION_ASPECT_MAX = 1.0; // width/height must be <= this (portrait or square) to pass

  var WORK_LONG_EDGE = 480;   // downscale target for the live scan — cheap enough for every-frame use on a phone
  var N_ANGLES = 180;
  var GRAD_THRESHOLD = 5;     // on a 0-255 grayscale scale, per ~2px radial step
  var R_MIN_FRAC = 0.18;
  var R_MAX_FRAC = 0.62;

  var workCanvas = null, workCtx = null;

  function toGray(imageData) {
    var d = imageData.data;
    var n = imageData.width * imageData.height;
    var gray = new Float32Array(n);
    for (var i = 0, p = 0; i < n; i++, p += 4) {
      gray[i] = 0.299 * d[p] + 0.587 * d[p + 1] + 0.114 * d[p + 2];
    }
    return gray;
  }

  // Simple separable-ish box blur (3x3, one pass) — enough to knock down
  // per-pixel sensor noise without softening the ring edge away, matching
  // the intent (not the exact kernel) of the Python reference's
  // GaussianBlur(9,9) at a much smaller working resolution here.
  function boxBlur3(gray, w, h) {
    var out = new Float32Array(gray.length);
    for (var y = 0; y < h; y++) {
      for (var x = 0; x < w; x++) {
        var sum = 0, cnt = 0;
        for (var dy = -1; dy <= 1; dy++) {
          var yy = y + dy;
          if (yy < 0 || yy >= h) continue;
          for (var dx = -1; dx <= 1; dx++) {
            var xx = x + dx;
            if (xx < 0 || xx >= w) continue;
            sum += gray[yy * w + xx];
            cnt++;
          }
        }
        out[y * w + x] = sum / cnt;
      }
    }
    return out;
  }

  // Ports the same method validated offline in Python (radial_ring2.py):
  // march outward from the frame centre at many angles, find the OUTERMOST
  // strong dark->light transition within a plausible radius band (the
  // outer edge of the black numbered cabinet ring — present and the same
  // physical size in both the positive dataset and any Training Capture
  // shot of this rig), take the robust median across angles.
  function detectBoardRing(canvas) {
    var w = canvas.width, h = canvas.height;
    var longEdge = Math.max(w, h);
    var scale = WORK_LONG_EDGE / longEdge;
    var ww = Math.max(1, Math.round(w * scale)), wh = Math.max(1, Math.round(h * scale));

    if (!workCanvas) {
      workCanvas = document.createElement('canvas');
      workCtx = workCanvas.getContext('2d', { willReadFrequently: true });
    }
    workCanvas.width = ww; workCanvas.height = wh;
    workCtx.drawImage(canvas, 0, 0, ww, wh);
    var imageData = workCtx.getImageData(0, 0, ww, wh);
    var gray = boxBlur3(toGray(imageData), ww, wh);

    var cx = ww / 2, cy = wh / 2;
    var ref = Math.min(ww, wh);
    var rMin = ref * R_MIN_FRAC, rMax = ref * R_MAX_FRAC;
    var step = 2;

    var edgeRadii = [];
    for (var a = 0; a < N_ANGLES; a++) {
      var theta = 2 * Math.PI * a / N_ANGLES;
      var dx = Math.cos(theta), dy = Math.sin(theta);
      var samples = [], radii = [];
      for (var r = rMin; r < rMax; r += step) {
        var x = cx + r * dx, y = cy + r * dy;
        if (x < 0 || x >= ww || y < 0 || y >= wh) break;
        samples.push(gray[Math.round(y) * ww + Math.round(x)]);
        radii.push(r);
      }
      if (samples.length < 10) continue;
      // outermost strong positive gradient (dark -> light) along this ray
      var bestIdx = -1;
      for (var i = 1; i < samples.length; i++) {
        var grad = samples[i] - samples[i - 1];
        if (grad > GRAD_THRESHOLD) bestIdx = i;
      }
      if (bestIdx >= 0) edgeRadii.push(radii[bestIdx]);
    }

    if (edgeRadii.length < 20) return null; // not enough consistent edge — board not clearly framed at all

    edgeRadii.sort(function (a, b) { return a - b; });
    var med = edgeRadii[Math.floor(edgeRadii.length / 2)];
    var kept = edgeRadii.filter(function (r) { return Math.abs(r - med) < med * 0.20; });
    if (kept.length < 15) return null;
    kept.sort(function (a, b) { return a - b; });
    var med2 = kept[Math.floor(kept.length / 2)];

    return {
      cx: cx / scale, cy: cy / scale, r: med2 / scale,
      frameW: w, frameH: h,
      nAngles: N_ANGLES, nEdges: edgeRadii.length, nKept: kept.length
    };
  }

  function classifyFraming(ring) {
    if (!ring) {
      return { status: 'NOT_DETECTED', reasons: ['Could not find the board/cabinet ring clearly — check lighting and that the board is in view.'] };
    }
    var w = ring.frameW, h = ring.frameH;
    var diamFracW = (2 * ring.r) / w;
    var diamFracH = (2 * ring.r) / h;
    var centerFracX = ring.cx / w;
    var centerFracY = ring.cy / h;

    var reasons = [];
    var status = 'PASS';

    if (w / h > ORIENTATION_ASPECT_MAX) {
      status = 'WRONG_ORIENTATION';
      reasons.push('Camera is in landscape (' + w + '×' + h + '). The positive dataset is portrait — rotate the phone/mount to portrait.');
    }

    if (diamFracW > DIAM_FRAC_W_RANGE[1] || diamFracH > DIAM_FRAC_H_RANGE[1]) {
      if (status === 'PASS') status = 'TOO_CLOSE';
      reasons.push('Board fills more of the frame than the positive dataset ever does — move the camera back / zoom out a little.');
    } else if (diamFracW < DIAM_FRAC_W_RANGE[0] || diamFracH < DIAM_FRAC_H_RANGE[0]) {
      if (status === 'PASS') status = 'TOO_FAR';
      reasons.push('Board is smaller in-frame than the positive dataset — move the camera closer / zoom in a little.');
    }

    var offX = Math.abs(centerFracX - 0.5), offY = Math.abs(centerFracY - 0.5);
    if (offX > CENTER_TOLERANCE_FRAC || offY > CENTER_TOLERANCE_FRAC) {
      if (status === 'PASS') status = 'OFF_CENTRE';
      reasons.push('Board centre is off — recentre the board in the frame.');
    }

    return {
      status: status, reasons: reasons,
      diamFracW: diamFracW, diamFracH: diamFracH,
      centerFracX: centerFracX, centerFracY: centerFracY,
      target: { diamFracW: TARGET_DIAM_FRAC_W, diamFracH: TARGET_DIAM_FRAC_H }
    };
  }

  // measure(): one-shot, synchronous measurement of an arbitrary canvas
  // (e.g. a just-captured full-resolution snapshot). Used both by the live
  // overlay loop and — this is the important one — by the actual
  // save-gate in stateMachine.js, so the gate always reflects the REAL
  // frame being saved, not just whatever the live low-res overlay last
  // happened to show.
  function measure(canvas) {
    var ring = detectBoardRing(canvas);
    return classifyFraming(ring);
  }

  function statusColor(status) {
    switch (status) {
      case 'PASS': return '#3ddc6a';
      case 'NOT_DETECTED': return '#999999';
      default: return '#ff5252'; // TOO_CLOSE / TOO_FAR / OFF_CENTRE / WRONG_ORIENTATION
    }
  }

  function statusLabel(status) {
    switch (status) {
      case 'PASS': return 'PASS';
      case 'TOO_CLOSE': return 'TOO CLOSE';
      case 'TOO_FAR': return 'TOO FAR';
      case 'OFF_CENTRE': return 'OFF-CENTRE';
      case 'WRONG_ORIENTATION': return 'ROTATE TO PORTRAIT';
      case 'NOT_DETECTED': return 'NO BOARD DETECTED';
      default: return status;
    }
  }

  // Draws the guide onto the existing overlay canvas (same canvas/coordinate
  // space main.js already uses for the ROI box and AI marker, and the same
  // "compute on your own schedule, draw every rAF frame from the last
  // cached result" pattern as the AI marker — see drawIfLive() below).
  // canvasW/H are the overlay's own backing-resolution size; result is
  // whatever classifyFraming() returned (ring may be absent for
  // NOT_DETECTED). ring, when present, is in NATIVE video-frame
  // coordinates (ring.frameW/frameH) and is scaled here to the overlay's
  // own (usually smaller) backing resolution.
  function draw(ctx, canvasW, canvasH, result, ring) {
    var color = statusColor(result.status);
    var cx = canvasW / 2, cy = canvasH / 2;

    // Target circle: the expected board diameter at THIS canvas's own
    // width/height, using the two independent width/height targets (their
    // average radius keeps a single circle even though the true target is
    // an ellipse-shaped tolerance region in most aspect ratios).
    var targetRW = (TARGET_DIAM_FRAC_W * canvasW) / 2;
    var targetRH = (TARGET_DIAM_FRAC_H * canvasH) / 2;
    var targetR = (targetRW + targetRH) / 2;

    ctx.save();
    ctx.setLineDash([10, 8]);
    ctx.strokeStyle = 'rgba(255,255,255,0.85)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(cx, cy, targetR, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);

    // centre guides
    ctx.strokeStyle = 'rgba(255,255,255,0.5)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(cx, 0); ctx.lineTo(cx, canvasH);
    ctx.moveTo(0, cy); ctx.lineTo(canvasW, cy);
    ctx.stroke();

    // actual detected ring, colour-coded by status — scaled from the
    // native video-frame coordinates it was measured in to this canvas's
    // own backing resolution (they're usually not the same size).
    if (ring) {
      var s = canvasW / ring.frameW;
      ctx.strokeStyle = color;
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.arc(ring.cx * s, ring.cy * s, ring.r * s, 0, Math.PI * 2);
      ctx.stroke();
    }

    // status banner
    var label = statusLabel(result.status);
    ctx.font = 'bold 20px sans-serif';
    var pad = 8;
    var textW = ctx.measureText(label).width;
    ctx.fillStyle = color;
    ctx.globalAlpha = 0.85;
    ctx.fillRect(cx - textW / 2 - pad, 8, textW + pad * 2, 30);
    ctx.globalAlpha = 1;
    ctx.fillStyle = '#000';
    ctx.textAlign = 'center';
    ctx.fillText(label, cx, 30);
    ctx.textAlign = 'left';

    if (result.diamFracW != null) {
      var detail = 'w ' + (result.diamFracW * 100).toFixed(1) + '% (target ' + (TARGET_DIAM_FRAC_W * 100).toFixed(0) +
        '%)  h ' + (result.diamFracH * 100).toFixed(1) + '% (target ' + (TARGET_DIAM_FRAC_H * 100).toFixed(0) + '%)';
      ctx.font = '13px sans-serif';
      ctx.fillStyle = '#fff';
      var dW = ctx.measureText(detail).width;
      ctx.fillStyle = 'rgba(0,0,0,0.6)';
      ctx.fillRect(cx - dW / 2 - 6, 42, dW + 12, 20);
      ctx.fillStyle = '#fff';
      ctx.textAlign = 'center';
      ctx.fillText(detail, cx, 57);
      ctx.textAlign = 'left';
    }
    ctx.restore();
  }

  // --- live measurement loop ---
  // Measurement runs on its own throttled interval (cheap enough, but no
  // need to run it 60x/sec). Drawing is separate: main.js's existing
  // drawOverlay() rAF loop calls drawIfLive() every frame, the same
  // "compute on a schedule, draw the cached result every frame" pattern
  // already used for the AI marker — the overlay canvas gets cleared every
  // rAF tick regardless of what this module does, so drawing has to
  // happen inside that same per-frame cycle, not independently.
  var liveVideoEl = null, liveTimer = null, lastResult = null, lastRing = null;
  var snapCanvas = null;

  function liveTick() {
    if (!liveVideoEl || !liveVideoEl.videoWidth) return;
    if (!snapCanvas) snapCanvas = document.createElement('canvas');
    snapCanvas.width = liveVideoEl.videoWidth;
    snapCanvas.height = liveVideoEl.videoHeight;
    snapCanvas.getContext('2d').drawImage(liveVideoEl, 0, 0);
    var ring = detectBoardRing(snapCanvas);
    lastResult = classifyFraming(ring);
    lastRing = ring;
  }

  function startLive(videoEl) {
    liveVideoEl = videoEl;
    stopLive();
    liveTimer = setInterval(liveTick, 300); // ~3fps — plenty for a positioning aid, cheap on battery
    liveTick();
  }

  function stopLive() {
    if (liveTimer) { clearInterval(liveTimer); liveTimer = null; }
    lastResult = null; lastRing = null;
  }

  function isLive() { return !!liveTimer; }

  function getLastResult() { return lastResult; }

  // Called every rAF frame by main.js's drawOverlay() while the guide is
  // toggled on — draws the last cached measurement at whatever backing
  // resolution the overlay canvas currently has.
  function drawIfLive(ctx, canvasW, canvasH) {
    if (!isLive() || !lastResult) return;
    draw(ctx, canvasW, canvasH, lastResult, lastRing);
  }

  global.TC = global.TC || {};
  global.TC.FramingGuide = {
    TARGET_DIAM_FRAC_W: TARGET_DIAM_FRAC_W,
    TARGET_DIAM_FRAC_H: TARGET_DIAM_FRAC_H,
    DIAM_FRAC_W_RANGE: DIAM_FRAC_W_RANGE,
    DIAM_FRAC_H_RANGE: DIAM_FRAC_H_RANGE,
    CENTER_TOLERANCE_FRAC: CENTER_TOLERANCE_FRAC,
    detectBoardRing: detectBoardRing,
    classifyFraming: classifyFraming,
    measure: measure,
    draw: draw,
    statusLabel: statusLabel,
    startLive: startLive,
    stopLive: stopLive,
    isLive: isLive,
    getLastResult: getLastResult,
    drawIfLive: drawIfLive
  };
})(window);
