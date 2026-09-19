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

    if (!$('chk-debug').checked) return;
    var fields = $('debug-fields');
    var rows = [
      ['consecutiveDiff', status.debug.consecutiveDiff],
      ['outsideRoiDiff', status.debug.outsideRoiDiff],
      ['candidateArea', status.debug.candidateArea],
      ['stableAccumMs', status.debug.stableAccumMs],
      ['stabilityTargetMs', status.debug.stabilityTargetMs],
      ['emptyStableTicks', status.debug.emptyStableTicks],
      ['note', status.debug.note]
    ];
    fields.innerHTML = rows.map(function (r) {
      var v = r[1] === undefined || r[1] === null ? '—' : (typeof r[1] === 'number' ? r[1].toFixed(2) : r[1]);
      return '<div>' + r[0] + '</div><div>' + v + '</div>';
    }).join('');

    var log = $('debug-log');
    log.innerHTML = sm.history.slice(-40).reverse().map(function (h) {
      return '<div>' + h.t.slice(11, 19) + ' — ' + h.state + (h.note ? ' — ' + h.note : '') + '</div>';
    }).join('');
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
      }).catch(function (err) {
        alert('Could not start camera: ' + err.message);
        btn.disabled = false;
      });
    });

    $('btn-end-session').addEventListener('click', function () {
      stopDetectionLoop();
      sm.endSession();
      global.TC.Camera.stopCamera();
      teardownZoomControl();
      $('btn-start-session').disabled = false;
      $('btn-end-session').disabled = true;
      updateStatusUi();
    });

    sm.onCapture(function () { updateStatusUi(); });
    sm.onRoundComplete(function () { updateStatusUi(); });
  }

  function initReviewTab() {
    global.TC.Review.init($('review-root'));
    $('btn-refresh-review').addEventListener('click', function () { global.TC.Review.refresh(); });
    $('lightbox-close').addEventListener('click', function () { $('lightbox').classList.add('hidden'); });
  }

  var CONFIG_FIELD_ORDER = [
    'CHANGE_THRESHOLD', 'MIN_CHANGE_AREA', 'STABILITY_THRESHOLD', 'STABILITY_DURATION_MS',
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
    initTabs();
    initCaptureTab();
    initReviewTab();
    initConfigTab();
  });
})(window);
