// Training Capture v0.1 — pure-JS image processing primitives.
// Deliberately dependency-free (no OpenCV.js) so the tool has no external
// vision-library load to wait on or fail: everything here runs on plain
// Canvas2D ImageData at a small "detection resolution", separate from the
// full-resolution frame that actually gets saved as a capture.
(function (global) {
  'use strict';

  // Luma-weighted grayscale, matching standard perceptual weighting.
  function toGrayscale(imageData) {
    var data = imageData.data, n = imageData.width * imageData.height;
    var out = new Uint8ClampedArray(n);
    for (var i = 0, p = 0; i < n; i++, p += 4) {
      out[i] = (data[p] * 0.299 + data[p + 1] * 0.587 + data[p + 2] * 0.114) | 0;
    }
    return out;
  }

  // Cheap separable box blur (radius 1) to knock down single-pixel sensor
  // noise before diffing, without pulling in a real vision library.
  function boxBlur3(gray, width, height) {
    var out = new Uint8ClampedArray(gray.length);
    for (var y = 0; y < height; y++) {
      for (var x = 0; x < width; x++) {
        var sum = 0, count = 0;
        for (var dy = -1; dy <= 1; dy++) {
          var yy = y + dy;
          if (yy < 0 || yy >= height) continue;
          for (var dx = -1; dx <= 1; dx++) {
            var xx = x + dx;
            if (xx < 0 || xx >= width) continue;
            sum += gray[yy * width + xx];
            count++;
          }
        }
        out[y * width + x] = (sum / count) | 0;
      }
    }
    return out;
  }

  // Draws the given video-like source into a canvas at targetWidth (height
  // derived from the source's own aspect ratio), returning the grayscale
  // (blurred) buffer plus the dimensions used.
  function grabDetectionFrame(source, sourceWidth, sourceHeight, targetWidth) {
    var w = Math.min(targetWidth, sourceWidth);
    var h = Math.max(1, Math.round(sourceHeight * w / sourceWidth));
    var canvas = grabDetectionFrame._canvas || (grabDetectionFrame._canvas = document.createElement('canvas'));
    canvas.width = w; canvas.height = h;
    var ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(source, 0, 0, w, h);
    var imageData = ctx.getImageData(0, 0, w, h);
    var gray = boxBlur3(toGrayscale(imageData), w, h);
    return { gray: gray, width: w, height: h };
  }

  // Mean absolute difference between two same-sized grayscale buffers,
  // restricted to an optional rect { x, y, w, h }.
  function meanAbsDiff(a, b, width, height, rect) {
    var x0 = rect ? Math.max(0, rect.x) : 0;
    var y0 = rect ? Math.max(0, rect.y) : 0;
    var x1 = rect ? Math.min(width, rect.x + rect.w) : width;
    var y1 = rect ? Math.min(height, rect.y + rect.h) : height;
    var sum = 0, count = 0;
    for (var y = y0; y < y1; y++) {
      var row = y * width;
      for (var x = x0; x < x1; x++) {
        sum += Math.abs(a[row + x] - b[row + x]);
        count++;
      }
    }
    return count ? sum / count : 0;
  }

  // Mean absolute difference OUTSIDE a rect — used for camera-movement
  // detection against the background, not the board itself.
  function meanAbsDiffOutside(a, b, width, height, rect) {
    if (!rect) return 0;
    var sum = 0, count = 0;
    for (var y = 0; y < height; y++) {
      var row = y * width;
      var insideRow = y >= rect.y && y < rect.y + rect.h;
      for (var x = 0; x < width; x++) {
        if (insideRow && x >= rect.x && x < rect.x + rect.w) continue;
        sum += Math.abs(a[row + x] - b[row + x]);
        count++;
      }
    }
    return count ? sum / count : 0;
  }

  // Thresholded binary diff mask (1 = changed), restricted to rect.
  function diffMask(a, b, width, height, threshold, rect) {
    var mask = new Uint8Array(width * height);
    var x0 = rect ? Math.max(0, rect.x) : 0;
    var y0 = rect ? Math.max(0, rect.y) : 0;
    var x1 = rect ? Math.min(width, rect.x + rect.w) : width;
    var y1 = rect ? Math.min(height, rect.y + rect.h) : height;
    for (var y = y0; y < y1; y++) {
      var row = y * width;
      for (var x = x0; x < x1; x++) {
        var idx = row + x;
        if (Math.abs(a[idx] - b[idx]) > threshold) mask[idx] = 1;
      }
    }
    return mask;
  }

  function countNonZero(mask) {
    var c = 0;
    for (var i = 0; i < mask.length; i++) c += mask[i];
    return c;
  }

  // 3x3 binary dilate/erode/close. Without this, two darts landing close
  // together (or a single dart's own noisy edge) makes a raw threshold
  // mask flicker tick-to-tick between "one connected blob" and "two/more
  // separate pieces" from just a handful of noisy pixels at the boundary
  // — confirmed on real field-test data (candidate blob area jumping
  // between ~400 and ~7000 on consecutive ticks for what was physically
  // one settled scene). Closing (dilate then erode) bridges those small
  // gaps and removes isolated speckle noise, the same fix production's
  // own OpenCV-based detector gets from its morphological close/open —
  // reimplemented here in plain JS since this module has no OpenCV
  // dependency by design.
  function dilate3x3(mask, width, height) {
    var out = new Uint8Array(mask.length);
    for (var y = 0; y < height; y++) {
      for (var x = 0; x < width; x++) {
        var idx = y * width + x;
        if (mask[idx]) { out[idx] = 1; continue; }
        var on = false;
        for (var dy = -1; dy <= 1 && !on; dy++) {
          var yy = y + dy;
          if (yy < 0 || yy >= height) continue;
          var rowBase = yy * width;
          for (var dx = -1; dx <= 1; dx++) {
            var xx = x + dx;
            if (xx < 0 || xx >= width) continue;
            if (mask[rowBase + xx]) { on = true; break; }
          }
        }
        out[idx] = on ? 1 : 0;
      }
    }
    return out;
  }

  function erode3x3(mask, width, height) {
    var out = new Uint8Array(mask.length);
    for (var y = 0; y < height; y++) {
      for (var x = 0; x < width; x++) {
        var idx = y * width + x;
        if (!mask[idx]) { out[idx] = 0; continue; }
        var allOn = true;
        for (var dy = -1; dy <= 1 && allOn; dy++) {
          var yy = y + dy;
          if (yy < 0 || yy >= height) { allOn = false; break; }
          var rowBase = yy * width;
          for (var dx = -1; dx <= 1; dx++) {
            var xx = x + dx;
            if (xx < 0 || xx >= width || !mask[rowBase + xx]) { allOn = false; break; }
          }
        }
        out[idx] = allOn ? 1 : 0;
      }
    }
    return out;
  }

  function closeMask(mask, width, height) {
    return erode3x3(dilate3x3(mask, width, height), width, height);
  }

  // Largest 4-connected component in a binary mask. Iterative flood fill
  // (no recursion) so it stays safe at detection resolution (~480x360).
  function largestComponent(mask, width, height) {
    var n = width * height;
    var visited = new Uint8Array(n);
    var stack = new Int32Array(n);
    var best = null;
    for (var idx = 0; idx < n; idx++) {
      if (!mask[idx] || visited[idx]) continue;
      var sp = 0;
      stack[sp++] = idx; visited[idx] = 1;
      var area = 0, minX = width, minY = height, maxX = 0, maxY = 0, sumX = 0, sumY = 0;
      while (sp > 0) {
        var cur = stack[--sp];
        var cx = cur % width, cy = (cur / width) | 0;
        area++; sumX += cx; sumY += cy;
        if (cx < minX) minX = cx; if (cx > maxX) maxX = cx;
        if (cy < minY) minY = cy; if (cy > maxY) maxY = cy;
        if (cx > 0) { var l = cur - 1; if (mask[l] && !visited[l]) { visited[l] = 1; stack[sp++] = l; } }
        if (cx < width - 1) { var r = cur + 1; if (mask[r] && !visited[r]) { visited[r] = 1; stack[sp++] = r; } }
        if (cy > 0) { var u = cur - width; if (mask[u] && !visited[u]) { visited[u] = 1; stack[sp++] = u; } }
        if (cy < height - 1) { var d = cur + width; if (mask[d] && !visited[d]) { visited[d] = 1; stack[sp++] = d; } }
      }
      if (!best || area > best.area) {
        best = { area: area, minX: minX, minY: minY, maxX: maxX, maxY: maxY, cx: sumX / area, cy: sumY / area };
      }
    }
    return best;
  }

  // All connected components in a binary mask with area >= minArea,
  // largest first. Used to count how many distinct dart-sized regions are
  // present at once (e.g. to tell that more than one new dart landed
  // within a single settle window), rather than only ever looking at the
  // single largest blob.
  function allComponents(mask, width, height, minArea) {
    var n = width * height;
    var visited = new Uint8Array(n);
    var stack = new Int32Array(n);
    var out = [];
    for (var idx = 0; idx < n; idx++) {
      if (!mask[idx] || visited[idx]) continue;
      var sp = 0;
      stack[sp++] = idx; visited[idx] = 1;
      var area = 0, minX = width, minY = height, maxX = 0, maxY = 0, sumX = 0, sumY = 0;
      while (sp > 0) {
        var cur = stack[--sp];
        var cx = cur % width, cy = (cur / width) | 0;
        area++; sumX += cx; sumY += cy;
        if (cx < minX) minX = cx; if (cx > maxX) maxX = cx;
        if (cy < minY) minY = cy; if (cy > maxY) maxY = cy;
        if (cx > 0) { var l = cur - 1; if (mask[l] && !visited[l]) { visited[l] = 1; stack[sp++] = l; } }
        if (cx < width - 1) { var r = cur + 1; if (mask[r] && !visited[r]) { visited[r] = 1; stack[sp++] = r; } }
        if (cy > 0) { var u = cur - width; if (mask[u] && !visited[u]) { visited[u] = 1; stack[sp++] = u; } }
        if (cy < height - 1) { var d = cur + width; if (mask[d] && !visited[d]) { visited[d] = 1; stack[sp++] = d; } }
      }
      if (area >= minArea) {
        out.push({ area: area, minX: minX, minY: minY, maxX: maxX, maxY: maxY, cx: sumX / area, cy: sumY / area });
      }
    }
    out.sort(function (a, b) { return b.area - a.area; });
    return out;
  }

  function defaultRoi(width, height) {
    var insetX = Math.round(width * 0.1), insetY = Math.round(height * 0.1);
    return { x: insetX, y: insetY, w: width - insetX * 2, h: height - insetY * 2 };
  }

  function pad2(n) { return n < 10 ? '0' + n : '' + n; }
  function pad4(n) { var s = '' + n; while (s.length < 4) s = '0' + s; return s; }

  function todayDateString(d) {
    d = d || new Date();
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
  }

  function randomHex(len) {
    var chars = '0123456789abcdef', out = '';
    for (var i = 0; i < len; i++) out += chars[Math.floor(Math.random() * 16)];
    return out;
  }

  global.TC = global.TC || {};
  global.TC.Utils = {
    toGrayscale: toGrayscale,
    boxBlur3: boxBlur3,
    grabDetectionFrame: grabDetectionFrame,
    meanAbsDiff: meanAbsDiff,
    meanAbsDiffOutside: meanAbsDiffOutside,
    diffMask: diffMask,
    countNonZero: countNonZero,
    closeMask: closeMask,
    largestComponent: largestComponent,
    allComponents: allComponents,
    defaultRoi: defaultRoi,
    pad2: pad2,
    pad4: pad4,
    todayDateString: todayDateString,
    randomHex: randomHex
  };
})(window);
