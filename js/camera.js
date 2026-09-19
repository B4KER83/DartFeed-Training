// Training Capture v0.1 — camera access.
// Adapted from the ideas in the existing DartFeed camera module (rear/
// environment-facing camera, ideal-resolution constraint trick, zoom
// defaulting to 1.0x) but reimplemented standalone here — this file has no
// dependency on and makes no reference to any production module.
(function (global) {
  'use strict';

  var stream = null;
  var videoEl = null;
  var zoomCapabilities = null;
  var frameCounter = 0;
  var lastFpsSampleTime = 0;
  var measuredFps = null;
  var rvfcHandle = null;

  function getVideoElement() {
    return videoEl;
  }

  function setVideoElement(el) {
    videoEl = el;
  }

  function isRunning() {
    return !!stream;
  }

  function tryOptimizeTrack(track) {
    try {
      if (!track.getCapabilities) return;
      var caps = track.getCapabilities();
      var advanced = {};
      if (caps.focusMode && caps.focusMode.indexOf('continuous') !== -1) advanced.focusMode = 'continuous';
      if (caps.exposureMode && caps.exposureMode.indexOf('continuous') !== -1) advanced.exposureMode = 'continuous';
      if (Object.keys(advanced).length > 0) {
        track.applyConstraints({ advanced: [advanced] }).catch(function () {});
      }
    } catch (e) { /* getCapabilities/applyConstraints missing entirely on this browser — ignore */ }
  }

  function getZoomCapabilities() {
    if (!stream) return null;
    var track = stream.getVideoTracks()[0];
    if (!track || !track.getCapabilities) return null;
    var caps = track.getCapabilities();
    if (!caps.zoom) return null;
    return caps.zoom;
  }

  function setZoom(value) {
    if (!stream) return Promise.reject(new Error('no stream'));
    var track = stream.getVideoTracks()[0];
    if (!track) return Promise.reject(new Error('no track'));
    return track.applyConstraints({ advanced: [{ zoom: value }] });
  }

  function getZoom() {
    if (!stream) return null;
    var track = stream.getVideoTracks()[0];
    if (!track || !track.getSettings) return null;
    var settings = track.getSettings();
    return settings.zoom != null ? settings.zoom : null;
  }

  function startFpsMeter() {
    frameCounter = 0;
    lastFpsSampleTime = performance.now();
    measuredFps = null;
    if (videoEl && videoEl.requestVideoFrameCallback) {
      var onFrame = function () {
        frameCounter++;
        var now = performance.now();
        var elapsed = now - lastFpsSampleTime;
        if (elapsed >= 1000) {
          measuredFps = (frameCounter * 1000 / elapsed);
          frameCounter = 0;
          lastFpsSampleTime = now;
        }
        if (stream) rvfcHandle = videoEl.requestVideoFrameCallback(onFrame);
      };
      rvfcHandle = videoEl.requestVideoFrameCallback(onFrame);
    }
  }

  function getMeasuredFps() {
    return measuredFps; // null if requestVideoFrameCallback is unsupported
  }

  // Targets a fixed 1920x2560 (portrait, 3:4) capture — smaller/faster to
  // export than the sensor's native max, while still ample resolution for
  // a bounded scoring-area photo. The browser/device clamps to whatever it
  // actually supports if this exact size isn't available, and the
  // ACHIEVED resolution is always reported back to the caller (never
  // assumed) via getResolution().
  function startCamera() {
    return navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: { ideal: 'environment' },
        aspectRatio: { ideal: 1920 / 2560 },
        width: { ideal: 1920 },
        height: { ideal: 2560 }
      },
      audio: false
    }).then(function (s) {
      stream = s;
      videoEl.srcObject = s;
      var track = s.getVideoTracks()[0];
      if (track) {
        tryOptimizeTrack(track);
        zoomCapabilities = getZoomCapabilities();
        if (zoomCapabilities) {
          var defaultZoom = Math.max(zoomCapabilities.min, Math.min(zoomCapabilities.max, 1.0));
          setZoom(defaultZoom).catch(function () {});
        }
      }
      return new Promise(function (resolve) {
        if (videoEl.readyState >= 2) { resolve(s); return; }
        videoEl.onloadedmetadata = function () { resolve(s); };
      });
    }).then(function (s) {
      startFpsMeter();
      return s;
    });
  }

  function stopCamera() {
    if (stream) {
      stream.getTracks().forEach(function (t) { t.stop(); });
      stream = null;
    }
    if (videoEl) videoEl.srcObject = null;
    zoomCapabilities = null;
    if (rvfcHandle && videoEl && videoEl.cancelVideoFrameCallback) {
      try { videoEl.cancelVideoFrameCallback(rvfcHandle); } catch (e) {}
    }
  }

  function getResolution() {
    if (!videoEl || !videoEl.videoWidth) return null;
    return { width: videoEl.videoWidth, height: videoEl.videoHeight };
  }

  // Draws the CURRENT video frame into a canvas synchronously, at full
  // native resolution — never upscaled, never downsized. Both the master
  // image and its thumbnail must be derived from this one snapshot rather
  // than re-reading the live <video> element later, since the video keeps
  // playing while the (async) toBlob encoding happens — re-sampling it a
  // second time after that gap could pick up a newer frame (e.g. the next
  // dart already landing on a fast throw).
  function captureFrameSnapshot() {
    if (!videoEl || !videoEl.videoWidth) throw new Error('camera not ready');
    var canvas = document.createElement('canvas');
    canvas.width = videoEl.videoWidth;
    canvas.height = videoEl.videoHeight;
    var ctx = canvas.getContext('2d');
    ctx.drawImage(videoEl, 0, 0, canvas.width, canvas.height);
    return { canvas: canvas, width: canvas.width, height: canvas.height };
  }

  function canvasToBlob(canvas, quality) {
    return new Promise(function (resolve, reject) {
      canvas.toBlob(function (blob) {
        if (!blob) { reject(new Error('toBlob failed')); return; }
        resolve(blob);
      }, 'image/jpeg', quality);
    });
  }

  // Captures a still at the FULL native video resolution — the "master"
  // image that gets saved, never edited/resized afterward.
  function captureFullResolutionBlob(quality) {
    var snap = captureFrameSnapshot();
    return canvasToBlob(snap.canvas, quality || 0.92).then(function (blob) {
      return { blob: blob, width: snap.width, height: snap.height };
    });
  }

  // Thumbnail generated from an EXISTING full-resolution canvas snapshot
  // (not the live video) so it's guaranteed to match the master image.
  function makeThumbnailFromSnapshot(snapshotCanvas, sourceWidth, sourceHeight, targetWidth, quality) {
    var w = Math.min(targetWidth, sourceWidth);
    var h = Math.max(1, Math.round(sourceHeight * w / sourceWidth));
    var canvas = document.createElement('canvas');
    canvas.width = w; canvas.height = h;
    var ctx = canvas.getContext('2d');
    ctx.drawImage(snapshotCanvas, 0, 0, w, h);
    return canvasToBlob(canvas, quality || 0.8);
  }

  global.TC = global.TC || {};
  global.TC.Camera = {
    setVideoElement: setVideoElement,
    getVideoElement: getVideoElement,
    isRunning: isRunning,
    startCamera: startCamera,
    stopCamera: stopCamera,
    getResolution: getResolution,
    getZoomCapabilities: getZoomCapabilities,
    setZoom: setZoom,
    getZoom: getZoom,
    getMeasuredFps: getMeasuredFps,
    captureFrameSnapshot: captureFrameSnapshot,
    captureFullResolutionBlob: captureFullResolutionBlob,
    makeThumbnailFromSnapshot: makeThumbnailFromSnapshot
  };
})(window);
