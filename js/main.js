// Training Capture v0.1 — UI wiring.
(function (global) {
  'use strict';

  var video, overlay, overlayCtx;
  var sm = new global.TC.StateMachine();
  var detectionTimer = null;

  function $(id) { return document.getElementById(id); }

  function initTabs() {
    var buttons = document.querySelectorAll('.tab-btn');
    buttons.forEach(function (btn) {
      btn.addEventListener('click', function () {
        buttons.forEach(function (b) { b.classList.remove('active'); });
        btn.classList.add('active');
        document.querySelectorAll('.tab-panel').forEach(function (p) { p.classList.remove('active'); });
        $('tab-' + btn.dataset.tab).classList.add('active');
        if (btn.dataset.tab === 'review') global.TC.Review.refresh();
      });
    });
  }

  function resizeOverlay() {
    var rect = video.getBoundingClientRect();
    // Backing resolution matches the DETECTION resolution (not the CSS
    // display size) so ROI clicks map 1:1 to detection-space pixels — see
    // js/roi.js.
    var cfg = global.TC.Config.current;
    var vidRes = global.TC.Camera.getResolution();
    var detW = cfg.DETECTION_WIDTH;
    var detH = vidRes ? Math.round(vidRes.height * detW / vidRes.width) : Math.round(detW * 4 / 3); // portrait fallback (matches the requested 1920x2560 capture) before the camera reports its real aspect ratio
    overlay.width = detW;
    overlay.height = detH;
    overlay.style.width = rect.width + 'px';
    overlay.style.height = rect.height + 'px';
  }

  function drawAiMarker() {
    var cfg = global.TC.Config.current;
    if (cfg.DETECTION_MODE === 'background') return;
    var d = sm.debug;
    if (d.aiTipXDet == null || d.aiTipYDet == null) return;
    var confident = (d.aiConfidence || 0) >= cfg.AI_CONFIDENCE_THRESHOLD;
    var color = d.aiState === 'STABLE_DART' || d.aiState === 'WAITING_FOR_NEXT_DART' ? '#3ddc6a'
      : (confident ? '#ffb347' : '#ff5c5c');
    var x = d.aiTipXDet, y = d.aiTipYDet;
    overlayCtx.strokeStyle = color;
    overlayCtx.fillStyle = color;
    overlayCtx.lineWidth = 2;
    overlayCtx.beginPath();
    overlayCtx.arc(x, y, 10, 0, Math.PI * 2);
    overlayCtx.stroke();
    overlayCtx.beginPath();
    overlayCtx.moveTo(x - 14, y); overlayCtx.lineTo(x + 14, y);
    overlayCtx.moveTo(x, y - 14); overlayCtx.lineTo(x, y + 14);
    overlayCtx.stroke();
    overlayCtx.font = '12px sans-serif';
    var label = (d.aiConfidence != null ? d.aiConfidence.toFixed(2) : '—') + ' ' + (d.aiState || '');
    overlayCtx.fillText(label, x + 14, y - 14);
  }

  function drawOverlay() {
    if (!overlayCtx) return;
    overlayCtx.clearRect(0, 0, overlay.width, overlay.height);
    var roi = global.TC.Config.current.ROI;
    if (roi) {
      overlayCtx.strokeStyle = sm.state === 'IDLE' ? '#666' : '#4f8cff';
      overlayCtx.lineWidth = 2;
      overlayCtx.strokeRect(roi.x, roi.y, roi.w, roi.h);
    }
    var drag = global.TC.Roi.getPendingDragRect();
    if (drag) {
      overlayCtx.strokeStyle = '#ffb347';
      overlayCtx.setLineDash([6, 4]);
      overlayCtx.strokeRect(drag.x, drag.y, drag.w, drag.h);
      overlayCtx.setLineDash([]);
    }
    drawAiMarker();
    requestAnimationFrame(drawOverlay);
  }

  function updateStatusUi() {
    var status = sm.getStatus();
    $('stat-session').textContent = status.session ? status.session.session_id : '—';
    $('stat-round').textContent = status.round ? global.TC.Utils.pad4(status.round.round_number) : '—';
    $('stat-dartcount').textContent = status.round ? status.round.dart_count + ' / 3' : '—';
    $('stat-state').textContent = status.cameraPaused ? 'CAMERA_MOVEMENT_PAUSED' : status.state;
    $('stat-captures').textContent = status.captureCount;

    var res = global.TC.Camera.getResolution();
    $('stat-resolution').textContent = res ? (res.width + ' x ' + res.height) : '—';
    var fps = global.TC.Camera.getMeasuredFps();
    $('stat-fps').textContent = fps ? fps.toFixed(1) : 'n/a';

    var cfg = global.TC.Config.current;
    var aiOn = cfg.DETECTION_MODE !== 'background';
    $('ai-status-block').classList.toggle('hidden', !aiOn);
    if (aiOn) {
      $('ai-state').textContent = status.debug.aiState || '—';
      $('ai-confidence').textContent = status.debug.aiConfidence != null ? status.debug.aiConfidence.toFixed(2) : '—';
    }

    if (!$('chk-debug').checked) return;
    var fields = $('debug-fields');
    var rows = [
      ['consecutiveDiff', status.debug.consecutiveDiff],
      ['outsideRoiDiff', status.debug.outsideRoiDiff],
      ['candidateArea / MIN_CHANGE_AREA', (status.debug.candidateArea != null ? status.debug.candidateArea.toFixed(0) : '—') + ' / ' + (status.debug.minChangeArea != null ? status.debug.minChangeArea : '—')],
      ['totalChangedVsWorking', status.debug.totalChangedVsWorking],
      ['areaVsEmpty / emptyThreshold', (status.debug.areaVsEmpty != null ? status.debug.areaVsEmpty.toFixed(0) : '—') + ' / ' + (status.debug.emptyThreshold != null ? status.debug.emptyThreshold.toFixed(0) : '—')],
      ['lastConfirmedAreaVsEmpty', status.debug.lastConfirmedAreaVsEmpty],
      ['stableAccumMs', status.debug.stableAccumMs],
      ['stabilityTargetMs', status.debug.stabilityTargetMs],
      ['emptyStableTicks', status.debug.emptyStableTicks],
      ['note', status.debug.note]
    ];
    if (aiOn) {
      rows.push(
        ['— AI detector —', ''],
        ['aiInputResolution', status.debug.aiInputResolution],
        ['aiNativeResolution', status.debug.aiNativeResolution],
        ['aiTipX / aiTipY (native)', (status.debug.aiTipX != null ? status.debug.aiTipX.toFixed(0) : '—') + ' / ' + (status.debug.aiTipY != null ? status.debug.aiTipY.toFixed(0) : '—')],
        ['aiConfidence / threshold', (status.debug.aiConfidence != null ? status.debug.aiConfidence.toFixed(3) : '—') + ' / ' + status.debug.aiConfidenceThreshold],
        ['aiState', status.debug.aiState],
        ['aiStableFrames / required', (status.debug.aiStableFrames != null ? status.debug.aiStableFrames : '—') + ' / ' + cfg.AI_STABILITY_FRAMES],
        ['aiMovementPx', status.debug.aiMovementPx != null ? status.debug.aiMovementPx.toFixed(1) : '—'],
        ['aiPrevDartPositions (det-res)', (status.debug.aiPrevDartPositions || []).map(function (p) { return '(' + p.x.toFixed(0) + ',' + p.y.toFixed(0) + ')'; }).join(' ') || '—'],
        ['aiLocalDiffArea (combined mode)', status.debug.aiLocalDiffArea != null ? status.debug.aiLocalDiffArea : '—']
      );
    }
    fields.innerHTML = rows.map(function (r) {
      var v = r[1] === undefined || r[1] === null ? '—' : (typeof r[1] === 'number' ? r[1].toFixed(2) : r[1]);
      return '<div>' + r[0] + '</div><div>' + v + '</div>';
    }).join('');

    var log = $('debug-log');
    log.innerHTML = sm.history.slice(-40).reverse().map(function (h) {
      return '<div>' + h.t.slice(11, 19) + ' — ' + h.state + (h.note ? ' — ' + h.note : '') + '</div>';
    }).join('');
  }

  // Everything needed to diagnose a detection problem remotely, without
  // needing more screenshots: the full event history (every state
  // transition ever logged this session, up to 500), the exact config in
  // effect, camera/ROI info, and the live debug numbers at export time.
  // `extra` (used by the recording feature below) merges in recording
  // start/end times and filename so a clip and its log pair up
  // unambiguously.
  function buildDebugLogPayload(extra) {
    var status = sm.getStatus();
    var res = global.TC.Camera.getResolution();
    var payload = {
      exported_at: new Date().toISOString(),
      app_version: global.TC.VERSION,
      state: status.state,
      camera_paused_for_movement: status.cameraPaused,
      camera: {
        resolution: res,
        measured_fps: global.TC.Camera.getMeasuredFps()
      },
      roi: status.roi,
      config: global.TC.Config.current,
      session: status.session,
      round: status.round,
      capture_count_this_session: status.captureCount,
      live_debug_numbers: status.debug,
      full_event_history: sm.history
    };
    if (extra) { for (var k in extra) payload[k] = extra[k]; }
    return payload;
  }

  function triggerDownload(blob, filename) {
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 10000);
  }

  function exportDebugLog(extra, stampOverride) {
    var payload = buildDebugLogPayload(extra);
    var stamp = stampOverride || ((payload.session ? payload.session.session_id : 'no-session') + '_' + Date.now());
    var blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    triggerDownload(blob, 'training_capture_debug_log_' + stamp + '.json');
  }

  // ---------- clip recording (camera feed + live status HUD, paired with a debug log) ----------
  var recordingCanvas = null, recordingCtx = null, mediaRecorder = null;
  var recordedChunks = [], recordingRafId = null, recordingStartedAt = null, recordingMimeType = null;

  function pickRecordingMimeType() {
    if (!window.MediaRecorder) return null;
    var candidates = ['video/mp4;codecs=h264', 'video/mp4', 'video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'];
    for (var i = 0; i < candidates.length; i++) {
      if (MediaRecorder.isTypeSupported(candidates[i])) return candidates[i];
    }
    return null;
  }

  function drawRecordingFrame() {
    if (!recordingCtx) return;
    recordingCtx.drawImage(video, 0, 0, recordingCanvas.width, recordingCanvas.height);
    var status = sm.getStatus();
    var line1 = status.state
      + '  |  Round ' + (status.round ? global.TC.Utils.pad4(status.round.round_number) : '—')
      + '  |  Darts ' + (status.round ? status.round.dart_count : '—') + '/3'
      + '  |  Captures ' + status.captureCount;
    var line2 = new Date().toISOString();
    recordingCtx.font = '16px monospace';
    var w = Math.max(recordingCtx.measureText(line1).width, recordingCtx.measureText(line2).width);
    recordingCtx.fillStyle = 'rgba(0,0,0,0.6)';
    recordingCtx.fillRect(4, 4, w + 12, 44);
    recordingCtx.fillStyle = '#fff';
    recordingCtx.fillText(line1, 10, 22);
    recordingCtx.fillText(line2, 10, 42);
    recordingRafId = requestAnimationFrame(drawRecordingFrame);
  }

  function startRecording() {
    recordingMimeType = pickRecordingMimeType();
    if (!recordingMimeType) {
      $('record-unsupported').classList.remove('hidden');
      return;
    }
    var res = global.TC.Camera.getResolution();
    if (!res) return;
    var scale = Math.min(1, 960 / res.width);
    recordingCanvas = document.createElement('canvas');
    recordingCanvas.width = Math.round(res.width * scale);
    recordingCanvas.height = Math.round(res.height * scale);
    recordingCtx = recordingCanvas.getContext('2d');
    recordedChunks = [];
    recordingStartedAt = new Date().toISOString();
    drawRecordingFrame();

    var stream = recordingCanvas.captureStream(15);
    try {
      mediaRecorder = new MediaRecorder(stream, { mimeType: recordingMimeType });
    } catch (e) {
      $('record-unsupported').classList.remove('hidden');
      if (recordingRafId) cancelAnimationFrame(recordingRafId);
      recordingRafId = null; recordingCtx = null;
      return;
    }
    mediaRecorder.ondataavailable = function (e) { if (e.data && e.data.size > 0) recordedChunks.push(e.data); };
    mediaRecorder.onstop = finishRecording;
    mediaRecorder.start();
    $('btn-record').textContent = 'Stop Recording';
    $('btn-record').classList.add('primary');
  }

  function stopRecording() {
    if (mediaRecorder && mediaRecorder.state !== 'inactive') mediaRecorder.stop();
    if (recordingRafId) cancelAnimationFrame(recordingRafId);
    recordingRafId = null;
    recordingCtx = null;
    $('btn-record').textContent = 'Record Clip';
    $('btn-record').classList.remove('primary');
  }

  // Bundles the clip and its matching debug log into ONE zip and triggers
  // a single download. Originally this triggered two separate downloads
  // back-to-back (clip, then log) — iOS Safari in particular only
  // reliably allows one programmatic download per user gesture, and was
  // silently dropping the clip while the log (triggered second) still
  // went through. A single zip sidesteps that entirely.
  function finishRecording() {
    var ext = recordingMimeType.indexOf('mp4') !== -1 ? 'mp4' : 'webm';
    var clipBlob = new Blob(recordedChunks, { type: recordingMimeType });
    var recordingEndedAt = new Date().toISOString();
    var stamp = String(Date.now());
    var clipFilename = 'training_capture_clip_' + stamp + '.' + ext;
    var logFilename = 'training_capture_debug_log_' + stamp + '.json';

    var logPayload = buildDebugLogPayload({
      recording_started_at: recordingStartedAt,
      recording_ended_at: recordingEndedAt,
      recording_clip_filename: clipFilename,
      recording_clip_size_bytes: clipBlob.size
    });

    if (clipBlob.size === 0) {
      alert('Recording produced an empty clip (0 bytes) — nothing usable to export. The debug log will still download on its own.');
      exportDebugLog({ recording_started_at: recordingStartedAt, recording_ended_at: recordingEndedAt, recording_failed: true }, stamp);
      return;
    }

    global.TC.Exporter.ensureJsZip().then(function () {
      var zip = new global.JSZip();
      zip.file(clipFilename, clipBlob);
      zip.file(logFilename, JSON.stringify(logPayload, null, 2));
      return zip.generateAsync({ type: 'blob' });
    }).then(function (zipBlob) {
      triggerDownload(zipBlob, 'training_capture_clip_and_log_' + stamp + '.zip');
    }).catch(function (err) {
      alert('Could not bundle the clip and log into a zip (' + err.message + ') — exporting the log on its own instead.');
      exportDebugLog({ recording_started_at: recordingStartedAt, recording_ended_at: recordingEndedAt, zip_bundle_failed: true }, stamp);
    });
  }

  var aiLoadPromise = null;
  function loadAiModel() {
    if (aiLoadPromise) return aiLoadPromise;
    $('ai-model-status').textContent = 'loading…';
    aiLoadPromise = global.TC.AiDetector.init().then(function () {
      $('ai-model-status').textContent = 'ready';
    }).catch(function (err) {
      $('ai-model-status').textContent = 'failed to load (' + err.message + ')';
      aiLoadPromise = null; // allow retry (e.g. after the network comes back)
    });
    return aiLoadPromise;
  }

  function startDetectionLoop() {
    stopDetectionLoop();
    var cfg = global.TC.Config.current;
    var intervalMs = 1000 / (cfg.DETECTION_FPS || 8);
    detectionTimer = setInterval(function () {
      var res = global.TC.Camera.getResolution();
      if (!res) return;
      sm.tick(video, res.width, res.height);
      updateStatusUi();
    }, intervalMs);
  }

  function stopDetectionLoop() {
    if (detectionTimer) { clearInterval(detectionTimer); detectionTimer = null; }
  }

  function setupZoomControl() {
    var caps = global.TC.Camera.getZoomCapabilities();
    var panel = $('zoom-panel');
    var unsupported = $('zoom-unsupported');
    if (!caps) {
      panel.classList.add('hidden');
      unsupported.classList.remove('hidden');
      return;
    }
    unsupported.classList.add('hidden');
    panel.classList.remove('hidden');
    var slider = $('zoom-slider');
    slider.min = caps.min;
    slider.max = caps.max;
    slider.step = caps.step || 0.1;
    var current = global.TC.Camera.getZoom ? global.TC.Camera.getZoom() : 1;
    slider.value = current || 1;
    $('zoom-value').textContent = Number(slider.value).toFixed(1) + 'x';
    slider.oninput = function () {
      $('zoom-value').textContent = Number(slider.value).toFixed(1) + 'x';
      global.TC.Camera.setZoom(parseFloat(slider.value)).catch(function () { /* device rejected this value mid-drag — ignore, next input retries */ });
    };
  }

  function teardownZoomControl() {
    $('zoom-panel').classList.add('hidden');
    $('zoom-unsupported').classList.add('hidden');
  }

  function initCaptureTab() {
    video = $('video');
    overlay = $('overlay');
    overlayCtx = overlay.getContext('2d');
    global.TC.Camera.setVideoElement(video);
    global.TC.Roi.init(overlay, function () { /* ROI changed, nothing extra to do */ });

    window.addEventListener('resize', resizeOverlay);
    resizeOverlay();
    requestAnimationFrame(drawOverlay);

    $('chk-debug').addEventListener('change', function (e) {
      $('debug-panel').classList.toggle('hidden', !e.target.checked);
    });

    $('btn-roi-toggle').addEventListener('click', function () {
      var editing = !global.TC.Roi.isEditing();
      global.TC.Roi.setEditing(editing);
      this.textContent = editing ? 'Stop drawing ROI' : 'Draw ROI';
      this.classList.toggle('primary', editing);
    });

    $('btn-start-session').addEventListener('click', function () {
      var btn = this;
      btn.disabled = true;
      global.TC.Camera.startCamera().then(function () {
        resizeOverlay();
        var res = global.TC.Camera.getResolution();
        var detW = global.TC.Config.current.DETECTION_WIDTH;
        var detH = Math.round(res.height * detW / res.width);
        global.TC.Roi.ensureRoi(detW, detH);
        setupZoomControl();
        return global.TC.Session.generateSessionId();
      }).then(function (sessionId) {
        sm.startSession(sessionId);
        startDetectionLoop();
        $('btn-end-session').disabled = false;
        $('btn-darts-removed').disabled = false;
        $('btn-force-capture').disabled = false;
        $('btn-record').disabled = false;
        $('record-unsupported').classList.add('hidden');
      }).catch(function (err) {
        alert('Could not start camera: ' + err.message);
        btn.disabled = false;
      });
    });

    $('btn-end-session').addEventListener('click', function () {
      if (mediaRecorder && mediaRecorder.state !== 'inactive') stopRecording();
      stopDetectionLoop();
      sm.endSession();
      global.TC.Camera.stopCamera();
      teardownZoomControl();
      $('btn-start-session').disabled = false;
      $('btn-end-session').disabled = true;
      $('btn-darts-removed').disabled = true;
      $('btn-force-capture').disabled = true;
      $('btn-record').disabled = true;
      updateStatusUi();
    });

    $('btn-darts-removed').addEventListener('click', function () {
      var res = global.TC.Camera.getResolution();
      if (!res) return;
      sm.manualDartsRemoved(video, res.width, res.height);
      updateStatusUi();
    });

    $('btn-force-capture').addEventListener('click', function () {
      var res = global.TC.Camera.getResolution();
      if (!res) return;
      sm.manualForceCapture(video, res.width, res.height);
      updateStatusUi();
    });

    var modeSelect = $('detection-mode');
    modeSelect.value = global.TC.Config.current.DETECTION_MODE || 'ai';
    modeSelect.addEventListener('change', function () {
      global.TC.Config.set('DETECTION_MODE', modeSelect.value);
      if (modeSelect.value !== 'background') loadAiModel();
      updateStatusUi();
    });
    if (modeSelect.value !== 'background') loadAiModel();

    $('btn-record').addEventListener('click', function () {
      if (mediaRecorder && mediaRecorder.state !== 'inactive') stopRecording();
      else startRecording();
    });

    $('btn-export-debug-log').addEventListener('click', function () { exportDebugLog(); });

    sm.onCapture(function () { updateStatusUi(); });
    sm.onRoundComplete(function () { updateStatusUi(); });
  }

  function initReviewTab() {
    global.TC.Review.init($('review-root'));
    $('btn-refresh-review').addEventListener('click', function () { global.TC.Review.refresh(); });
    $('lightbox-close').addEventListener('click', function () { $('lightbox').classList.add('hidden'); });
  }

  var CONFIG_FIELD_ORDER = [
    'AI_CONFIDENCE_THRESHOLD', 'AI_STABILITY_FRAMES', 'AI_STABILITY_MAX_MOVEMENT_PX',
    'AI_MIN_NEW_DART_SEPARATION_PX', 'AI_COMBINED_MIN_LOCAL_DIFF_AREA',
    'CHANGE_THRESHOLD', 'MIN_CHANGE_AREA', 'CANDIDATE_SUSTAIN_RATIO', 'CANDIDATE_GRACE_TICKS',
    'STABILITY_THRESHOLD', 'STABILITY_DURATION_MS',
    'COOLDOWN_MS', 'CAMERA_MOVEMENT_THRESHOLD', 'EMPTY_BOARD_MATCH_THRESHOLD',
    'OBSTRUCTION_FRACTION', 'DETECTION_WIDTH', 'DETECTION_FPS', 'EMPTY_BASELINE_STABLE_FRAMES',
    'CAPTURE_JPEG_QUALITY', 'THUMBNAIL_WIDTH'
  ];

  function initConfigTab() {
    var root = $('config-root');
    root.innerHTML = '';
    CONFIG_FIELD_ORDER.forEach(function (key) {
      var field = document.createElement('div');
      field.className = 'config-field';
      var label = document.createElement('label');
      label.textContent = key;
      label.htmlFor = 'cfg-' + key;
      var input = document.createElement('input');
      input.type = 'number';
      input.step = 'any';
      input.id = 'cfg-' + key;
      input.value = global.TC.Config.current[key];
      field.appendChild(label);
      field.appendChild(input);
      root.appendChild(field);
    });

    $('btn-config-save').addEventListener('click', function () {
      CONFIG_FIELD_ORDER.forEach(function (key) {
        var v = parseFloat($('cfg-' + key).value);
        if (!isNaN(v)) global.TC.Config.set(key, v);
      });
      alert('Config saved. Takes effect on next Start Session.');
    });

    $('btn-config-reset').addEventListener('click', function () {
      global.TC.Config.reset();
      initConfigTab();
    });
  }

  document.addEventListener('DOMContentLoaded', function () {
    document.getElementById('tc-version-tag').textContent = 'v' + global.TC.VERSION;
    initTabs();
    initCaptureTab();
    initReviewTab();
    initConfigTab();
  });
})(window);
