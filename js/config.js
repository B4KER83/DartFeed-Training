// Training Capture v0.1 — configuration
// All tunable thresholds live here (spec section 25). Nothing else in the
// codebase should hardcode a magic detection number — read TC.Config instead.
(function (global) {
  'use strict';

  var STORAGE_KEY = 'trainingCapture.config.v1';

  var DEFAULTS = {
    // Per-pixel grayscale intensity difference (0-255) above which a pixel
    // counts as "changed" when diffing two frames.
    CHANGE_THRESHOLD: 25,

    // Minimum connected-component pixel area (at detection resolution) for
    // a change blob to be considered dart-sized rather than noise.
    MIN_CHANGE_AREA: 400,

    // Mean absolute per-pixel difference between two CONSECUTIVE frames
    // below which the scene is considered "not moving" (used for both the
    // empty-board baseline and post-throw stability waits).
    STABILITY_THRESHOLD: 6,

    // How long the scene must stay under STABILITY_THRESHOLD, continuously,
    // before a change is accepted as "settled" and captured.
    STABILITY_DURATION_MS: 500,

    // Dead time after a capture/round-transition before new changes are
    // armed again, so residual board vibration can't double-trigger.
    COOLDOWN_MS: 800,

    // Mean absolute difference OUTSIDE the board ROI (background/wall/
    // floor) that indicates the camera itself moved rather than something
    // happening on the board.
    CAMERA_MOVEMENT_THRESHOLD: 18,

    // Total foreground pixel area (vs. the empty-board baseline, inside the
    // ROI) below which the board counts as "empty again".
    EMPTY_BOARD_MATCH_THRESHOLD: 300,

    // Width (px) that frames are downscaled to for the detection pipeline.
    // Full-resolution frames are always used for the actual saved capture.
    DETECTION_WIDTH: 480,

    // Target rate (Hz) of the detection loop.
    DETECTION_FPS: 8,

    // Consecutive stable ticks required before accepting the very first
    // empty-board baseline at session/round start.
    EMPTY_BASELINE_STABLE_FRAMES: 5,

    // Manual board Region Of Interest, in detection-resolution pixel space:
    // { x, y, w, h }. Null until the user draws one (defaults to a centred
    // inset of the frame so the tool is usable before calibration).
    ROI: null,

    // Fraction of the ROI that changing at once means "something big is
    // blocking the board" (a hand/arm reaching in) rather than a dart.
    OBSTRUCTION_FRACTION: 0.35,

    // JPEG quality for saved master captures (0-1).
    CAPTURE_JPEG_QUALITY: 0.92,

    // Width (px) of generated review-UI thumbnails.
    THUMBNAIL_WIDTH: 320
  };

  function load() {
    var cfg = {};
    try {
      var raw = global.localStorage.getItem(STORAGE_KEY);
      if (raw) cfg = JSON.parse(raw);
    } catch (e) { /* ignore corrupt/unavailable storage, fall back to defaults */ }
    var merged = {};
    Object.keys(DEFAULTS).forEach(function (k) {
      merged[k] = (cfg && cfg[k] !== undefined) ? cfg[k] : DEFAULTS[k];
    });
    return merged;
  }

  function save(cfg) {
    try { global.localStorage.setItem(STORAGE_KEY, JSON.stringify(cfg)); } catch (e) { /* ignore */ }
  }

  var TC = global.TC = global.TC || {};
  TC.Config = {
    defaults: DEFAULTS,
    current: load(),
    set: function (key, value) {
      TC.Config.current[key] = value;
      save(TC.Config.current);
    },
    reset: function () {
      TC.Config.current = JSON.parse(JSON.stringify(DEFAULTS));
      save(TC.Config.current);
    },
    save: function () { save(TC.Config.current); }
  };
})(window);
