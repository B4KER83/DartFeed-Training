// Training Capture v0.1 — dataset export (spec section 21).
// Produces:
//   training_session_<session_id>/
//     session.json
//     round_0001/
//       dart_1.jpg
//       dart_2.jpg
//       dart_3.jpg
//       metadata.json
//     round_0002/
//       ...
// Uses JSZip (loaded on demand from a CDN, same "load a vision/utility lib
// only when needed" pattern the existing DartFeed app uses for OpenCV.js).
// If the CDN is unreachable (offline), export fails loudly rather than
// silently producing a broken/partial file.
(function (global) {
  'use strict';

  var JSZIP_URL = 'https://cdn.jsdelivr.net/npm/jszip@3.10.1/dist/jszip.min.js';
  var loadPromise = null;

  function ensureJsZip() {
    if (global.JSZip) return Promise.resolve();
    if (loadPromise) return loadPromise;
    loadPromise = new Promise(function (resolve, reject) {
      var script = document.createElement('script');
      script.src = JSZIP_URL;
      script.onload = function () { resolve(); };
      script.onerror = function () { reject(new Error('Could not load JSZip from CDN — check your internet connection.')); };
      document.head.appendChild(script);
    });
    return loadPromise;
  }

  function metadataFor(capture, round) {
    return {
      session_id: capture.session_id,
      round_id: capture.round_id,
      dart_number: capture.dart_number,
      round_status: round ? round.round_status : capture.round_status,
      timestamp: capture.timestamp,
      image_width: capture.image_width,
      image_height: capture.image_height,
      stability_ms: capture.stability_ms,
      detection_method: capture.detection_method,
      detection_confidence: capture.detection_confidence,
      camera_movement_detected: capture.camera_movement_detected,
      quality_flags: capture.quality_flags || [],
      // Future ground-truth hooks (spec section 27) — present, null until
      // a scoring workflow is added; the image format never has to change.
      dart_score: capture.dart_score,
      score_confidence: capture.score_confidence,
      reviewer_mark: capture.mark || null
    };
  }

  function exportSession(sessionId, onProgress) {
    return ensureJsZip().then(function () {
      return Promise.all([
        global.TC.Storage.getSession(sessionId),
        global.TC.Storage.getRoundsForSession(sessionId),
        global.TC.Storage.getCapturesForSession(sessionId)
      ]);
    }).then(function (results) {
      var session = results[0], rounds = results[1], captures = results[2];
      var zip = new global.JSZip();
      var root = zip.folder('training_session_' + sessionId);

      root.file('session.json', JSON.stringify({
        session_id: sessionId,
        started_at: session ? session.started_at : null,
        ended_at: session ? session.ended_at : null,
        round_count: rounds.length,
        total_captures: captures.length,
        config_snapshot: session ? session.config_snapshot : null
      }, null, 2));

      var byRound = {};
      captures.forEach(function (c) {
        (byRound[c.round_id] = byRound[c.round_id] || []).push(c);
      });

      rounds.sort(function (a, b) { return a.round_number - b.round_number; }).forEach(function (round) {
        var folder = root.folder('round_' + global.TC.Utils.pad4(round.round_number));
        var caps = (byRound[round.round_id] || []).sort(function (a, b) { return a.dart_number - b.dart_number; });
        var metaAll = { round: round, darts: [] };
        caps.forEach(function (c) {
          folder.file('dart_' + c.dart_number + '.jpg', c.image_blob);
          metaAll.darts.push(metadataFor(c, round));
        });
        folder.file('metadata.json', JSON.stringify(metaAll, null, 2));
      });

      if (onProgress) onProgress({ phase: 'zipping' });
      return zip.generateAsync({ type: 'blob' }, function (meta) {
        if (onProgress) onProgress({ phase: 'compressing', percent: meta.percent });
      });
    }).then(function (blob) {
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url;
      a.download = 'training_session_' + sessionId + '.zip';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(function () { URL.revokeObjectURL(url); }, 10000);
    });
  }

  global.TC = global.TC || {};
  global.TC.Exporter = { exportSession: exportSession, ensureJsZip: ensureJsZip };
})(window);
