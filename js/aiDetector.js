// Training Capture v0.6 — AI-assisted dart-tip detector.
//
// Wraps DartFeed AI's own trained tip-heatmap model (dartfeed_ai/dartfeed_ai
// /training/checkpoints/v0.3_best.pt, exported to ONNX by
// dartfeed_ai/dartfeed_ai/training/export_onnx.py — see that script's
// header for how, and README.md "AI detection mode" for what the model
// is/isn't). Runs entirely client-side via onnxruntime-web (loaded from a
// CDN on demand, same pattern as JSZip in exporter.js). No network call
// per inference — the model is fetched once and cached by the browser.
//
// This module ONLY answers "is there a dart tip in this frame, and where"
// — it does not score, does not touch calibration/geometry, and is not
// wired to any of that. See stateMachine.js for how its output is turned
// into capture decisions.
(function (global) {
  'use strict';

  var ORT_URL = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.19.2/dist/ort.min.js';
  var MODEL_URL = 'models/dart_tip_v0.3.onnx';

  // Must match dartfeed_ai/dartfeed_ai/training/dataset.py exactly — this
  // is the model's fixed input/output contract, not a tunable setting.
  var INPUT_W = 320, INPUT_H = 416;
  var OUTPUT_STRIDE = 4;
  var MEAN = [0.485, 0.456, 0.406];
  var STD = [0.229, 0.224, 0.225];

  var ortLoadPromise = null;
  var session = null;
  var sessionLoadPromise = null;
  var inputCanvas = null, inputCtx = null;

  function ensureOrt() {
    if (global.ort) return Promise.resolve();
    if (ortLoadPromise) return ortLoadPromise;
    ortLoadPromise = new Promise(function (resolve, reject) {
      var script = document.createElement('script');
      script.src = ORT_URL;
      script.onload = function () { resolve(); };
      script.onerror = function () { reject(new Error('Could not load onnxruntime-web from CDN — check your internet connection.')); };
      document.head.appendChild(script);
    });
    return ortLoadPromise;
  }

  // Builds the (1,3,416,320) NCHW float32 tensor the model expects,
  // matching dartfeed_ai/dartfeed_ai/training/infer.py's preprocessing
  // exactly: resize to (INPUT_W, INPUT_H), scale to [0,1], normalize with
  // ImageNet mean/std per channel, RGB channel order.
  function preprocess(source) {
    if (!inputCanvas) {
      inputCanvas = document.createElement('canvas');
      inputCanvas.width = INPUT_W; inputCanvas.height = INPUT_H;
      inputCtx = inputCanvas.getContext('2d', { willReadFrequently: true });
    }
    inputCtx.drawImage(source, 0, 0, INPUT_W, INPUT_H);
    var imageData = inputCtx.getImageData(0, 0, INPUT_W, INPUT_H).data;

    var chw = new Float32Array(3 * INPUT_H * INPUT_W);
    var plane = INPUT_H * INPUT_W;
    for (var y = 0; y < INPUT_H; y++) {
      for (var x = 0; x < INPUT_W; x++) {
        var pixelIdx = (y * INPUT_W + x) * 4;
        var outIdx = y * INPUT_W + x;
        var r = imageData[pixelIdx] / 255, g = imageData[pixelIdx + 1] / 255, b = imageData[pixelIdx + 2] / 255;
        chw[outIdx] = (r - MEAN[0]) / STD[0];
        chw[plane + outIdx] = (g - MEAN[1]) / STD[1];
        chw[2 * plane + outIdx] = (b - MEAN[2]) / STD[2];
      }
    }
    return chw;
  }

  function sigmoid(v) { return 1 / (1 + Math.exp(-v)); }

  // Peak of the (post-sigmoid) heatmap = predicted tip (heatmap-resolution
  // coords) + confidence, matching train.py's heatmap_to_tip() exactly.
  function findPeak(heatmapData, heatH, heatW) {
    var bestIdx = 0, bestVal = -Infinity;
    for (var i = 0; i < heatmapData.length; i++) {
      var v = sigmoid(heatmapData[i]);
      if (v > bestVal) { bestVal = v; bestIdx = i; }
    }
    var y = Math.floor(bestIdx / heatW);
    var x = bestIdx % heatW;
    return { x: x, y: y, confidence: bestVal };
  }

  function init() {
    if (sessionLoadPromise) return sessionLoadPromise;
    sessionLoadPromise = ensureOrt().then(function () {
      global.ort.env.wasm.numThreads = 1; // simplest, most compatible default for phone browsers
      return global.ort.InferenceSession.create(MODEL_URL, { executionProviders: ['wasm'] });
    }).then(function (sess) {
      session = sess;
      return true;
    });
    return sessionLoadPromise;
  }

  function isReady() { return !!session; }

  // `source` is anything drawImage() accepts (a <video>, <canvas>, or
  // <img>). sourceW/sourceH are its native pixel dimensions, used to scale
  // the prediction back up. `detW`/`detH` (the detection-resolution frame
  // size the rest of the app already works in — see utils.js
  // grabDetectionFrame) are used to also return the prediction in that
  // same coordinate space, so it lines up with the ROI and the debug
  // overlay without every caller re-deriving the scale factor itself.
  function detect(source, sourceW, sourceH, detW, detH) {
    if (!session) return Promise.reject(new Error('AI model not loaded yet'));
    var chw = preprocess(source);
    var tensor = new global.ort.Tensor('float32', chw, [1, 3, INPUT_H, INPUT_W]);
    return session.run({ input: tensor }).then(function (results) {
      var out = results.heatmap; // (1,1,104,80)
      var heatH = out.dims[2], heatW = out.dims[3];
      var peak = findPeak(out.data, heatH, heatW);

      var inputXPx = peak.x * OUTPUT_STRIDE; // back to 320x416 input-resolution space
      var inputYPx = peak.y * OUTPUT_STRIDE;

      return {
        confidence: peak.confidence,
        xNative: inputXPx * (sourceW / INPUT_W),
        yNative: inputYPx * (sourceH / INPUT_H),
        xDet: inputXPx * (detW / INPUT_W),
        yDet: inputYPx * (detH / INPUT_H)
      };
    });
  }

  global.TC = global.TC || {};
  global.TC.AiDetector = {
    init: init,
    isReady: isReady,
    detect: detect,
    INPUT_W: INPUT_W,
    INPUT_H: INPUT_H
  };
})(window);
