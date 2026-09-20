// Training Capture — configuration
// All tunable thresholds live here (spec section 25). Nothing else in the
// codebase should hardcode a magic detection number — read TC.Config instead.
(function (global) {
  'use strict';

  // TC_VERSION — single source of truth for the version shown in the app
  // header. Bump this with every meaningful change, same convention as
  // the main DartFeed app: PATCH for fixes/tuning, MINOR for real feature
  // additions.
  //   0.1.0 — initial release (3-dart round state machine, IndexedDB
  //           storage, full-resolution capture, ZIP export, debug overlay).
  //   0.2.0 — camera zoom control added. ROI drawing fixed for touch
  //           (was mouse-events-only, so it silently never worked on a
  //           phone). Requested 4:3 camera aspect ratio. Capture target
  //           reduced to 1920x2560 portrait, then enforced by software
  //           downscale after capture (getUserMedia's ideal width/height/
  //           aspectRatio are hints, not guarantees — iOS in particular
  //           was ignoring the portrait request and delivering its
  //           native ~4032x3024 sensor frame regardless). Empty-board/
  //           removal detection fixed to also accept a relative drop from
  //           the last confirmed dart-count reading, not just a fixed
  //           absolute threshold (real sensor noise/exposure drift could
  //           keep it from ever reading "empty" again). Obstruction check
  //           fixed so it can no longer get permanently stuck on a large
  //           but legitimate settled change (e.g. removing 3 darts at
  //           once could exceed the obstruction area fraction and be
  //           mistaken for a hand still on the board, forever). Added a
  //           morphological close step to stop a change blob's detected
  //           size from flickering tick-to-tick when two darts land
  //           close together. Debug overlay now shows the live numbers
  //           that actually drive detection/removal decisions.
  //   0.3.0 — added a manual "Darts Removed" button (shares the exact same
  //           finalise-round logic as automatic detection, so it's a true
  //           override, not a separate code path) for when automatic
  //           removal detection still misses it. Added "Export debug log"
  //           — downloads the full event history, live detection numbers,
  //           config, session/round, and camera info as JSON, so a
  //           detection problem can be diagnosed remotely from one file
  //           instead of a string of screenshots.
  //   0.4.0 — added "Record Clip": records the camera feed (via
  //           MediaRecorder on a canvas with a live status HUD burned in
  //           — state/round/dart-count/timestamp) to a downloadable video,
  //           paired with an auto-exported debug log covering the same
  //           start/end time window (matching filename stamp). Lets a
  //           detection problem be watched happening, not just read as
  //           numbers. Needs MediaRecorder + canvas.captureStream support
  //           (iOS Safari 14.3+, recent Chrome); shows a clear
  //           "not supported" note rather than failing silently otherwise.
  //   0.4.1 — fixed Record Clip only ever producing the debug log, never
  //           the video: it was triggering two separate downloads
  //           back-to-back, and iOS Safari only reliably allows one
  //           programmatic download per user gesture, silently dropping
  //           the first (the clip). Now bundles the clip and its log into
  //           a single zip so there's only one download to trigger.
  //   0.4.2 — CHANGE_THRESHOLD default raised 25 -> 45, confirmed by real
  //           field-test data (see the comment above the setting itself)
  //           rather than guessed. Cuts the false "noise floor" area from
  //           video compression on the board's own texture by ~47x.
  //   0.4.3 — the obstruction check (pauses detection while a hand/arm is
  //           over the board) never wrote to the event history at all —
  //           a real field test showed a completely silent 7-second gap
  //           in the exported log while a dart was visibly missed, and
  //           with no record of *why*. Now logs when an obstruction
  //           starts and clears (throttled to those two transitions, not
  //           every tick), so rapid-fire throwing repeatedly re-triggering
  //           it — the leading suspect for that missed dart — is visible
  //           in the next debug log instead of an unexplained gap.
  var TC_VERSION = '0.4.3';

  var STORAGE_KEY = 'trainingCapture.config.v1';

  var DEFAULTS = {
    // Per-pixel grayscale intensity difference (0-255) above which a pixel
    // counts as "changed" when diffing two frames. Raised from an earlier
    // default of 25 after real field-test data showed it was far too low
    // for this camera/board: video compression noise across the board's
    // own busy texture (sisal fibres, printed numbers, wire) was crossing
    // the threshold across a large fraction of the whole ROI, not just
    // where a dart actually was — confirmed directly by comparing a
    // debug-log export at 25 (lastConfirmedAreaVsEmpty ~44,000, i.e. ~76%
    // of the ROI, after a single dart) against one at 45
    // (lastConfirmedAreaVsEmpty ~928 for the same kind of throw) — a ~47x
    // reduction, isolating this one setting as the actual cause.
    CHANGE_THRESHOLD: 45,

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
    // ROI) below which the board counts as "empty again". This is a floor,
    // not the only check — stateMachine.js also treats a >=60% drop from
    // whatever the last confirmed dart count actually measured as "empty",
    // since real camera sensor noise/auto-exposure drift over a session
    // can otherwise keep this number from ever settling this low. Raised
    // from an earlier 300 default, which field-testing showed was too
    // tight for a real phone camera and silently prevented removal from
    // ever being detected.
    EMPTY_BOARD_MATCH_THRESHOLD: 600,

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
    THUMBNAIL_WIDTH: 320,

    // Caps the long edge of every saved master capture, in pixels.
    // getUserMedia's width/height/aspectRatio constraints are only
    // "ideal" hints — iOS Safari in particular commonly ignores a
    // requested portrait shape and hands back its native ~4032x3024
    // sensor frame regardless. This is enforced by downscaling in
    // software at capture time instead, so the saved file size is
    // predictable no matter what resolution the device actually
    // negotiates. Aspect ratio is always preserved (never force-cropped
    // or stretched to a specific shape).
    MAX_CAPTURE_LONG_EDGE: 2560
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
  TC.VERSION = TC_VERSION;
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
