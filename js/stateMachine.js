// Training Capture v0.1 — the three-dart round state machine.
//
// This is the heart of the tool (spec section 7). States are named
// explicitly and every transition is logged to `history` so the debug
// panel and the test plan can observe exactly what happened and why.
//
// Detection approach (spec section 14): pure frame-differencing against
// two references —
//   - `emptyBaseline`: the board with zero darts (set once per round-cycle,
//     refreshed every time the board is confirmed empty again).
//   - `workingBaseline`: the board as of the last confirmed dart state
//     (starts equal to emptyBaseline, then becomes "board + dart 1", then
//     "board + dart 1 + dart 2", etc. after each capture).
//
// A change is "armed" when a connected blob vs. `workingBaseline` exceeds
// MIN_CHANGE_AREA. Once that blob has been present and the whole frame has
// stopped moving (STABILITY_DURATION_MS of consecutive-frame stability),
// the frame is reclassified by comparing its TOTAL foreground area against
// `emptyBaseline`:
//   - near zero            -> darts were REMOVED (round finalises)
//   - grew vs. last commit -> a NEW dart was ADDED (capture + advance)
//   - anything else        -> ambiguous; re-baseline silently, no capture
// This total-vs-empty-area comparison is what tells "a new dart appeared"
// apart from "a dart was taken away" using the exact same raw signal
// (frame differencing), which is why no capture-vs-removal confusion
// happens without extra sensors.
(function (global) {
  'use strict';

  var Utils = null; // bound lazily in init() once TC.Utils exists

  var STATE = {
    IDLE: 'IDLE',
    INITIALISING: 'INITIALISING',
    EMPTY_BOARD_DETECTING: 'EMPTY_BOARD_DETECTING',
    READY_FOR_DART: function (n) { return 'READY_FOR_DART_' + n; },
    CHANGE_DETECTED: function (n) { return 'DART_' + n + '_CHANGE_DETECTED'; },
    WAITING_STABILITY: function (n) { return 'WAITING_FOR_DART_' + n + '_STABILITY'; },
    CAPTURED: function (n) { return 'DART_' + n + '_CAPTURED'; },
    ROUND_COMPLETE: 'ROUND_COMPLETE',
    WAITING_FOR_DART_REMOVAL: 'WAITING_FOR_DART_REMOVAL',
    BOARD_CLEARING: 'BOARD_CLEARING',
    EMPTY_BOARD_STABILISING: 'EMPTY_BOARD_STABILISING',
    CAMERA_MOVEMENT_PAUSED: 'CAMERA_MOVEMENT_PAUSED'
  };

  var MOVEMENT_SUSTAIN_TICKS = 3; // consecutive ticks of background change before we call it "camera moved", not a stray flicker

  function nowMs() { return performance.now(); }

  function StateMachine() {
    this.state = STATE.IDLE;
    this.session = null; // { session_id, started_at, config_snapshot }
    this.round = null;   // { round_id, round_number, dart_count, round_status, round_start_time }
    this.captureCount = 0;
    this.history = [];   // [{ t, state, note }]
    this.debug = {};      // live numbers for the debug overlay

    this._prevGray = null;
    this._emptyBaseline = null;
    this._workingBaseline = null;
    this._detW = 0; this._detH = 0;
    this._lastTick = 0;

    this._emptyStableTicks = 0;
    this._stableAccumMs = 0;
    this._lastConfirmedAreaVsEmpty = 0;
    this._cooldownUntil = 0;

    this._movementSustain = 0;
    this._cameraPaused = false;
    this._movementStableAccumMs = 0;
    this._pendingCameraMovementFlag = false;
    this._obstructed = false;
    this._obstructedSince = 0;
    this._candidateWeakTicks = 0;

    // AI-detection-mode tracking (js/aiDetector.js). Independent of the
    // background-diff candidate/obstruction state above, so switching
    // DETECTION_MODE mid-session can't leave either detector half-armed.
    this._aiState = 'NO_DART';        // NO_DART | POSSIBLE_DART | STABLE_DART | WAITING_FOR_NEXT_DART
    this._aiCandidate = null;         // { x, y } in detection-resolution space
    this._aiStableFrames = 0;
    this._aiConfirmedTips = [];       // [{x,y}] confirmed dart tips THIS ROUND, for the new-detection-must-be-separated check
    this._aiLatest = null;            // most recent completed inference: { confidence, xDet, yDet, xNative, yNative }
    this._aiTickInFlight = false;

    this._onCapture = null; // callback(captureRecord)
    this._onRoundComplete = null; // callback(roundRecord)
  }

  StateMachine.prototype._log = function (note) {
    this.history.push({ t: new Date().toISOString(), state: this.state, note: note || '' });
    if (this.history.length > 500) this.history.shift();
  };

  StateMachine.prototype._setState = function (s, note) {
    this.state = s;
    this._log(note);
  };

  StateMachine.prototype.onCapture = function (cb) { this._onCapture = cb; };
  StateMachine.prototype.onRoundComplete = function (cb) { this._onRoundComplete = cb; };

  // ---- session / round lifecycle ----

  StateMachine.prototype.startSession = function (sessionId) {
    this.session = {
      session_id: sessionId,
      started_at: new Date().toISOString(),
      ended_at: null,
      config_snapshot: JSON.parse(JSON.stringify(global.TC.Config.current))
    };
    this.round = null;
    this.captureCount = 0;
    this.history = [];
    this._prevGray = null;
    this._emptyBaseline = null;
    this._workingBaseline = null;
    this._emptyStableTicks = 0;
    this._stableAccumMs = 0;
    this._lastConfirmedAreaVsEmpty = 0;
    this._cooldownUntil = 0;
    this._movementSustain = 0;
    this._cameraPaused = false;
    this._obstructed = false;
    this._obstructedSince = 0;
    this._candidateWeakTicks = 0;
    this._aiState = 'NO_DART';
    this._aiCandidate = null;
    this._aiStableFrames = 0;
    this._aiConfirmedTips = [];
    this._aiLatest = null;
    this._aiTickInFlight = false;
    this._setState(STATE.INITIALISING, 'session ' + sessionId + ' started');
    global.TC.Storage.saveSession(this.session);
  };

  StateMachine.prototype.endSession = function () {
    if (!this.session) return;
    this.session.ended_at = new Date().toISOString();
    global.TC.Storage.saveSession(this.session);
    this._setState(STATE.IDLE, 'session ended');
    this.session = null;
    this.round = null;
  };

  StateMachine.prototype._startRound = function () {
    var roundNumber = (this.round ? this.round.round_number : 0) + 1;
    var roundId = this.session.session_id + '_round_' + Utils.pad4(roundNumber);
    this.round = {
      round_id: roundId,
      session_id: this.session.session_id,
      round_number: roundNumber,
      dart_count: 0,
      round_status: 'in_progress',
      round_start_time: new Date().toISOString(),
      round_end_time: null
    };
    this._dartIndex = 1;
    // Confirmed tips are scoped to a round -- a new round starts with a
    // genuinely empty board, so nothing should block dart 1 as "too close
    // to the previous dart" just because a previous round threw one at a
    // similar spot.
    this._aiConfirmedTips = [];
    this._aiCandidate = null;
    this._aiStableFrames = 0;
    this._aiState = 'NO_DART';
    global.TC.Storage.saveRound(this.round);
    this._setState(STATE.READY_FOR_DART(1), 'round ' + roundId + ' started');
  };

  StateMachine.prototype._finaliseRound = function (status) {
    if (!this.round) return;
    this.round.round_status = status; // 'complete' | 'incomplete'
    this.round.round_end_time = new Date().toISOString();
    global.TC.Storage.saveRound(this.round);
    if (this._onRoundComplete) this._onRoundComplete(this.round);
  };

  // ---- per-frame driver ----
  // `source` is the live <video>; sourceW/H are its native resolution.
  StateMachine.prototype.tick = function (source, sourceW, sourceH) {
    if (!Utils) Utils = global.TC.Utils;
    if (this.state === STATE.IDLE) return;

    var t = nowMs();
    var dt = this._lastTick ? (t - this._lastTick) : 0;
    this._lastTick = t;

    var cfg = global.TC.Config.current;
    var frame = Utils.grabDetectionFrame(source, sourceW, sourceH, cfg.DETECTION_WIDTH);
    var gray = frame.gray;
    this._detW = frame.width; this._detH = frame.height;

    if (!this._prevGray) {
      this._prevGray = gray;
      this.debug.note = 'warming up';
      return;
    }

    // Stability is scoped to the board ROI, not the whole camera frame.
    // Real darts play means the thrower's body/arm is constantly moving
    // near the oche between throws, well outside the board framing. When
    // this check covered the full frame, that unrelated movement kept
    // "stable" from ever becoming true between individual throws —
    // confirmed on a real recorded round where all 3 darts were already
    // visibly embedded in the board while the debug overlay still read
    // "Darts 0/3", because the never-locally-still whole-frame check had
    // merged the entire throwing sequence into a single long "unstable"
    // stretch instead of settling once per dart. Scoping to the ROI lets
    // the board itself settle independently of what's happening elsewhere
    // in frame.
    var roi = global.TC.Roi.ensureRoi(frame.width, frame.height);
    var consecutiveDiff = Utils.meanAbsDiff(gray, this._prevGray, frame.width, frame.height, roi);
    var frameStable = consecutiveDiff < cfg.STABILITY_THRESHOLD;
    this.debug.consecutiveDiff = consecutiveDiff;

    // ---- AI detector (js/aiDetector.js) ----
    // Inference is async (onnxruntime-web), so it runs as its own
    // fire-and-forget loop rather than being awaited every tick: kick off
    // a new inference call whenever the previous one has finished, and
    // let _runArmedAi() below always read whichever result is freshest.
    // This decouples inference latency from the detection-loop cadence
    // entirely, instead of stalling the tick loop on every frame.
    if (cfg.DETECTION_MODE !== 'background' && global.TC.AiDetector && global.TC.AiDetector.isReady() && !this._aiTickInFlight) {
      this._aiTickInFlight = true;
      var self = this;
      global.TC.AiDetector.detect(source, sourceW, sourceH, frame.width, frame.height).then(function (result) {
        self._aiLatest = result;
        self._aiTickInFlight = false;
      }).catch(function (err) {
        self._aiTickInFlight = false;
        self._log('AI inference failed: ' + err.message);
      });
    }
    if (cfg.DETECTION_MODE !== 'background') {
      this.debug.aiInputResolution = global.TC.AiDetector ? (global.TC.AiDetector.INPUT_W + 'x' + global.TC.AiDetector.INPUT_H) : '—';
      this.debug.aiNativeResolution = sourceW + 'x' + sourceH;
      this.debug.aiConfidenceThreshold = cfg.AI_CONFIDENCE_THRESHOLD;
      this.debug.aiState = this._aiState;
      this.debug.aiStableFrames = this._aiStableFrames;
      this.debug.aiPrevDartPositions = this._aiConfirmedTips.slice();
      if (this._aiLatest) {
        this.debug.aiTipX = this._aiLatest.xNative;
        this.debug.aiTipY = this._aiLatest.yNative;
        this.debug.aiTipXDet = this._aiLatest.xDet;
        this.debug.aiTipYDet = this._aiLatest.yDet;
        this.debug.aiConfidence = this._aiLatest.confidence;
      }
    }

    // ---- camera movement watchdog (spec section 17) ----
    // Runs against the background OUTSIDE the ROI, using whichever
    // baseline we already have, so a moved camera is caught regardless of
    // what state the round is in.
    var movementRef = this._workingBaseline || this._emptyBaseline;
    if (movementRef && this.state !== STATE.EMPTY_BOARD_DETECTING) {
      var outsideDiff = Utils.meanAbsDiffOutside(gray, movementRef, frame.width, frame.height, roi);
      this.debug.outsideRoiDiff = outsideDiff;
      if (!this._cameraPaused) {
        if (outsideDiff > cfg.CAMERA_MOVEMENT_THRESHOLD) {
          this._movementSustain++;
          if (this._movementSustain >= MOVEMENT_SUSTAIN_TICKS) {
            this._cameraPaused = true;
            this._movementStableAccumMs = 0;
            this._setState(STATE.CAMERA_MOVEMENT_PAUSED, 'camera movement detected (outsideDiff=' + outsideDiff.toFixed(1) + ')');
          }
        } else {
          this._movementSustain = 0;
        }
      }
    }

    if (this._cameraPaused) {
      if (frameStable) this._movementStableAccumMs += dt; else this._movementStableAccumMs = 0;
      this.debug.movementStableAccumMs = this._movementStableAccumMs;
      if (this._movementStableAccumMs >= cfg.STABILITY_DURATION_MS) {
        // Re-baseline the WORKING reference to the new camera framing so
        // dart-added detection keeps working immediately. The empty-board
        // reference is intentionally left as-is (best effort) and gets a
        // full refresh the next time the board is naturally confirmed
        // empty at a round boundary — see README "Known limitations".
        this._workingBaseline = gray.slice();
        this._pendingCameraMovementFlag = true;
        this._cameraPaused = false;
        this._movementSustain = 0;
        var resumeState = !this.round ? STATE.EMPTY_BOARD_DETECTING
          : (this._dartIndex > 3 ? STATE.WAITING_FOR_DART_REMOVAL : STATE.READY_FOR_DART(this._dartIndex));
        this._setState(resumeState, 'camera movement resolved, working baseline rebuilt');
      }
      this._prevGray = gray;
      return;
    }

    // ---- state dispatch ----
    if (this.state === STATE.INITIALISING || this.state === STATE.EMPTY_BOARD_DETECTING) {
      this._runEmptyDetecting(gray, frameStable, cfg);
    } else if (t < this._cooldownUntil) {
      this.debug.note = 'cooldown';
    } else if (this.round) {
      // _runArmed always runs: it owns empty-board/removal detection in
      // EVERY mode (the AI here only answers "has a new dart appeared",
      // never "has the board been cleared"), plus new-dart capture itself
      // when DETECTION_MODE is 'background'. In 'ai'/'combined' modes,
      // _runArmedAi separately owns the new-dart capture decision.
      this._runArmed(gray, frameStable, dt, cfg, roi);
      if (cfg.DETECTION_MODE !== 'background') {
        this._runArmedAi(gray, cfg);
      }
    }

    this._prevGray = gray;
  };

  StateMachine.prototype._runEmptyDetecting = function (gray, frameStable, cfg) {
    if (this.state === STATE.INITIALISING) this._setState(STATE.EMPTY_BOARD_DETECTING, 'establishing empty-board baseline');
    if (frameStable) {
      this._emptyStableTicks++;
    } else {
      this._emptyStableTicks = 0;
    }
    this.debug.emptyStableTicks = this._emptyStableTicks;
    if (this._emptyStableTicks >= cfg.EMPTY_BASELINE_STABLE_FRAMES) {
      this._emptyBaseline = gray.slice();
      this._workingBaseline = gray.slice();
      this._lastConfirmedAreaVsEmpty = 0;
      this._emptyStableTicks = 0;
      this._startRound();
    }
  };

  // Armed for dartIndex (1-3): watches for a growing blob vs. workingBaseline.
  // For dartIndex > 1 this doubles as removal-watching (spec section 13) —
  // the same raw signal, classified only once it settles.
  StateMachine.prototype._runArmed = function (gray, frameStable, dt, cfg, roi) {
    var n = this._dartIndex;
    var diffMask = Utils.closeMask(Utils.diffMask(gray, this._workingBaseline, this._detW, this._detH, cfg.CHANGE_THRESHOLD, roi), this._detW, this._detH);
    var totalChanged = Utils.countNonZero(diffMask);
    var roiArea = roi.w * roi.h;

    // Live, every-tick visibility into the two numbers that actually drive
    // detection/removal decisions — shown in the Debug overlay so
    // thresholds in the Config tab can be tuned against real numbers
    // instead of guessed blind. Cheap enough to run every tick at this
    // detection resolution.
    var liveVsEmptyMask = Utils.closeMask(Utils.diffMask(gray, this._emptyBaseline, this._detW, this._detH, cfg.CHANGE_THRESHOLD, roi), this._detW, this._detH);
    this.debug.areaVsEmpty = Utils.countNonZero(liveVsEmptyMask);
    this.debug.lastConfirmedAreaVsEmpty = this._lastConfirmedAreaVsEmpty;
    this.debug.emptyThreshold = Math.max(cfg.EMPTY_BOARD_MATCH_THRESHOLD, this._lastConfirmedAreaVsEmpty * 0.4);
    this.debug.totalChangedVsWorking = totalChanged;
    this.debug.minChangeArea = cfg.MIN_CHANGE_AREA;

    // Obstruction only means anything while the scene is still actively
    // moving — a hand/arm physically in frame, still being tracked frame-
    // to-frame as unstable. Once the frame goes STILL again, a large
    // total-changed area is no longer "a hand is blocking the board," it's
    // a legitimate settled result (e.g. 3 real darts removed at once can
    // easily change more of the board than a single dart would, by pure
    // pixel area). Gating this on frameStable too — not just the area
    // fraction — is what actually fixes it: previously this fired forever
    // on any large removal, since the hand having left was invisible to a
    // check that only ever looked at total area vs the old baseline.
    if (!frameStable && totalChanged > roiArea * cfg.OBSTRUCTION_FRACTION) {
      // Hand/arm reaching over the board — not a dart, don't arm/advance.
      // Logged on start/clear only (not every tick, which at 8Hz would
      // flood the 500-entry history) — this was previously completely
      // invisible in the exported log, which made a real failure mode
      // (rapid-fire throwing keeping this triggered for seconds at a
      // time, silently eating a dart) look like unexplained silence.
      if (!this._obstructed) {
        this._obstructed = true;
        this._obstructedSince = nowMs();
        this._log('obstruction started (totalChanged=' + totalChanged + ', ' + Math.round(100 * totalChanged / roiArea) + '% of ROI)');
      }
      this._candidate = null;
      this._stableAccumMs = 0;
      this.debug.note = 'obstructed';
      return;
    }
    if (this._obstructed) {
      this._obstructed = false;
      this._log('obstruction cleared after ' + Math.round(nowMs() - this._obstructedSince) + 'ms');
    }

    var largest = totalChanged > 0 ? Utils.largestComponent(diffMask, this._detW, this._detH) : null;

    // Hysteresis: arming a NEW candidate needs the full MIN_CHANGE_AREA
    // (a confident signal), but once armed, only needs to clear a lower
    // sustain bar to be considered "still the same candidate". Without
    // this, a real dart's own blob sitting right at/near MIN_CHANGE_AREA
    // (confirmed on real field data: candidates repeatedly arming at
    // 401-441px, i.e. barely above a 400px floor, then vanishing again
    // within one tick, ~125ms, for over 20 seconds straight without ever
    // surviving long enough to accumulate any stability) gets killed by
    // ordinary single-pixel noise flickering it a few pixels either side
    // of the floor, tick after tick, and never gets a chance to settle.
    var requiredArea = this._candidate ? cfg.MIN_CHANGE_AREA * cfg.CANDIDATE_SUSTAIN_RATIO : cfg.MIN_CHANGE_AREA;
    if (!largest || largest.area < requiredArea) {
      if (this._candidate) {
        this._candidateWeakTicks = (this._candidateWeakTicks || 0) + 1;
        if (this._candidateWeakTicks <= cfg.CANDIDATE_GRACE_TICKS) {
          // Brief dip — hold the candidate and pause (not reset) the
          // stability clock for this one tick, rather than discarding
          // everything and starting over.
          this.debug.note = 'watching (weak tick ' + this._candidateWeakTicks + '/' + cfg.CANDIDATE_GRACE_TICKS + ')';
          return;
        }
      }
      // Genuinely gone (no candidate was ever armed, or it stayed weak
      // for longer than the grace period).
      if (this._candidate) {
        this._log('candidate change vanished before stabilising — treated as noise');
      }
      this._candidate = null;
      this._stableAccumMs = 0;
      this._candidateWeakTicks = 0;
      this.debug.note = 'watching';
      return;
    }
    this._candidateWeakTicks = 0;

    var watchingRemovalOnly = n > 3; // all 3 darts already captured this round
    var changeDetectedState = watchingRemovalOnly ? STATE.WAITING_FOR_DART_REMOVAL : STATE.CHANGE_DETECTED(n);
    var stabilityState = watchingRemovalOnly ? STATE.WAITING_FOR_DART_REMOVAL : STATE.WAITING_STABILITY(n);

    if (!this._candidate) {
      this._candidate = largest;
      this._stableAccumMs = 0;
      this._setState(changeDetectedState, 'change detected (area=' + largest.area + ')');
    }

    if (frameStable) {
      this._stableAccumMs += dt;
      if (this.state !== stabilityState && this._stableAccumMs > 0) {
        this._setState(stabilityState, 'waiting for stability');
      }
    } else {
      this._stableAccumMs = 0;
    }
    this.debug.stableAccumMs = this._stableAccumMs;
    this.debug.stabilityTargetMs = cfg.STABILITY_DURATION_MS;
    this.debug.candidateArea = largest.area;

    if (this._stableAccumMs < cfg.STABILITY_DURATION_MS) return;

    // ---- settled: classify as ADDED / REMOVED / ambiguous ----
    var stableStabilityMs = this._stableAccumMs;
    var areaVsEmpty = this.debug.areaVsEmpty; // already computed live above this tick
    this._candidate = null;
    this._stableAccumMs = 0;

    // "Empty" is judged two ways, whichever is more lenient: the fixed
    // absolute floor from config, OR a substantial (60%) drop from
    // whatever the last confirmed dart-count actually measured on THIS
    // camera moments ago. The absolute floor alone is brittle in
    // practice — real sensor noise, tiny camera shake, and auto-exposure
    // drift over a session can easily keep a genuinely empty board's
    // diff-vs-original-baseline above a small fixed number, which was
    // silently swallowing every real removal into the "ambiguous, do
    // nothing" branch below instead of ever finalising the round.
    var emptyThreshold = Math.max(cfg.EMPTY_BOARD_MATCH_THRESHOLD, this._lastConfirmedAreaVsEmpty * 0.4);
    if (areaVsEmpty <= emptyThreshold) {
      this._confirmBoardEmpty(gray, cfg, 'confirmed empty (auto, areaVsEmpty=' + areaVsEmpty + ')');
      return;
    }

    if (!watchingRemovalOnly && areaVsEmpty > this._lastConfirmedAreaVsEmpty + cfg.MIN_CHANGE_AREA * 0.5) {
      if (cfg.DETECTION_MODE !== 'background') {
        // AI/combined mode: _runArmedAi (called separately from tick())
        // owns deciding whether this growth is a confirmed new dart. Drop
        // this background-diff candidate without re-baselining or
        // starting a cooldown -- re-baselining here would erase the very
        // pixel change the AI is trying to confirm before it's had enough
        // stable frames to do so.
        this._candidate = null;
        this._stableAccumMs = 0;
        this.debug.note = 'watching (AI mode owns new-dart capture)';
        return;
      }
      // Grew meaningfully -> new dart(s) added. At a realistic ~1s-between-
      // throws pace, STABILITY_DURATION_MS + COOLDOWN_MS alone already add
      // up to more than one throw's worth of time, so more than one dart
      // can easily land within a single settle window (confirmed on real
      // footage: all 3 darts were already embedded before the very first
      // settle event ever fired). Assuming exactly one new dart here would
      // silently strand the round at a lower dart_count than what's
      // physically on the board. Estimate the real count from two
      // independent signals and take the more conservative (smaller) one,
      // so a single noisy blob split by morphology doesn't inflate the
      // count on its own:
      //   - how much total foreground area grew vs. the last confirmed
      //     dart-count reading (each dart is worth roughly MIN_CHANGE_AREA)
      //   - how many separate dart-sized regions currently sit on the
      //     board at all (vs. the empty baseline)
      // This is a heuristic, not ground truth — closely-grouped darts (e.g.
      // three in the same triple) can still merge into one blob and read
      // as fewer darts than are really there. The saved image is flagged
      // with quality_flags in that case so it's visible during review.
      var growth = areaVsEmpty - this._lastConfirmedAreaVsEmpty;
      var areaBasedEstimate = Math.max(1, Math.round(growth / (cfg.MIN_CHANGE_AREA * 1.2)));
      var boardBlobs = Utils.allComponents(liveVsEmptyMask, this._detW, this._detH, cfg.MIN_CHANGE_AREA * cfg.CANDIDATE_SUSTAIN_RATIO);
      var blobBasedEstimate = Math.max(1, boardBlobs.length - (n - 1));
      var remainingDarts = 3 - (n - 1);
      var newDartsCount = Math.max(1, Math.min(remainingDarts, areaBasedEstimate, blobBasedEstimate));
      var bgConfidence = Math.max(0, Math.min(1, largest.area / (cfg.MIN_CHANGE_AREA * 4)));
      this._captureDart(n, gray, stableStabilityMs, cfg, newDartsCount, { confidence: bgConfidence, method: 'frame_diff_connected_component_v1' });
      return;
    }

    if (watchingRemovalOnly) {
      // All 3 darts already captured this round — a round is capped at 3
      // images (spec section 10/26), so any further growth here (a dart
      // being adjusted/re-seated rather than removed) is logged and
      // re-baselined, never captured as a 4th image.
      this._log('change while waiting for dart removal (areaVsEmpty=' + areaVsEmpty + ') — not a removal, re-baselined, no capture');
      this._workingBaseline = gray.slice();
      this._cooldownUntil = nowMs() + cfg.COOLDOWN_MS;
      return;
    }

    // Ambiguous (shrank but not to empty, or grew only marginally) — most
    // likely a partial adjustment or measurement noise near the threshold.
    // Re-baseline silently rather than guess; do not capture or advance.
    this._log('ambiguous change (areaVsEmpty=' + areaVsEmpty + ', lastConfirmed=' + this._lastConfirmedAreaVsEmpty + ') — re-baselined, no capture');
    this._workingBaseline = gray.slice();
    this._cooldownUntil = nowMs() + cfg.COOLDOWN_MS;
  };

  // Shared by automatic detection AND the manual "Darts Removed" button,
  // so both paths finalise a round identically rather than risking two
  // slightly different behaviours.
  StateMachine.prototype._confirmBoardEmpty = function (gray, cfg, note) {
    this._emptyBaseline = gray.slice();
    this._workingBaseline = gray.slice();
    this._lastConfirmedAreaVsEmpty = 0;
    this._candidate = null;
    this._stableAccumMs = 0;
    this._cooldownUntil = nowMs() + cfg.COOLDOWN_MS;
    if (this.round.dart_count === 0) {
      this._log('board settled back to empty with no dart confirmed — ignored, staying in round');
      this._setState(STATE.READY_FOR_DART(1), 'still waiting for dart 1');
      return;
    }
    this._setState(STATE.BOARD_CLEARING, note);
    this._setState(STATE.EMPTY_BOARD_STABILISING, 'confirmed empty');
    this._finaliseRound(this.round.dart_count >= 3 ? 'complete' : 'incomplete');
    this._startRound();
  };

  // Manual override for the "Darts Removed" button — lets the operator
  // confirm the board is empty right now when automatic detection hasn't
  // caught it (a known, still-being-tuned limitation). Takes a fresh
  // frame itself rather than trusting whatever the last tick saw, so it
  // reflects the board as it actually is at the moment the button is
  // pressed. No-op if there's no active round, or nothing to remove yet.
  StateMachine.prototype.manualDartsRemoved = function (source, sourceW, sourceH) {
    if (!Utils) Utils = global.TC.Utils;
    if (!this.round) { this._log('Darts Removed pressed with no active round — ignored'); return; }
    if (this.round.dart_count === 0) { this._log('Darts Removed pressed with dart_count=0 — nothing to remove, ignored'); return; }
    var cfg = global.TC.Config.current;
    var frame = Utils.grabDetectionFrame(source, sourceW, sourceH, cfg.DETECTION_WIDTH);
    this._detW = frame.width; this._detH = frame.height;
    this._prevGray = frame.gray;
    this._confirmBoardEmpty(frame.gray, cfg, 'confirmed empty (manual override — Darts Removed button, dart_count was ' + this.round.dart_count + ')');
  };

  // Small pixel-diff sanity check used only by 'combined' mode: is there
  // an actual local change vs. the working baseline near the AI's
  // predicted tip? Deliberately a low bar (AI_COMBINED_MIN_LOCAL_DIFF_AREA
  // is much smaller than MIN_CHANGE_AREA) -- this is a cross-check that
  // *something* really changed there, not a second independent detector.
  StateMachine.prototype._localDiffArea = function (gray, xDet, yDet, cfg) {
    var radius = 20;
    var rect = { x: Math.round(xDet - radius), y: Math.round(yDet - radius), w: radius * 2, h: radius * 2 };
    var mask = Utils.diffMask(gray, this._workingBaseline, this._detW, this._detH, cfg.CHANGE_THRESHOLD, rect);
    return Utils.countNonZero(mask);
  };

  // AI-driven new-dart detection (js/aiDetector.js), implementing:
  //   NO_DART -> POSSIBLE_DART -> STABLE_DART -> CAPTURED -> WAITING_FOR_NEXT_DART
  // Runs alongside _runArmed (called separately from tick()), which keeps
  // owning empty-board/removal detection in every mode -- this function
  // only ever decides "has a NEW dart appeared, and where."
  //
  // The model itself was trained to output exactly ONE tip per inference
  // call (see dartfeed_ai/dartfeed_ai/training/dataset.py) -- it was never
  // taught to enumerate multiple simultaneous darts. With 1 or 2 darts
  // already on the board, a single inference call might report an
  // existing dart's tip again rather than a genuinely new one. The
  // separation-from-previous-confirmed-tip check below is what tells
  // those apart, not the model counting darts itself.
  StateMachine.prototype._runArmedAi = function (gray, cfg) {
    var n = this._dartIndex;
    if (n > 3) return; // removal is _runArmed's job in every mode, not the AI's

    if (this._obstructed) {
      if (this._aiCandidate) this._log('AI candidate cleared — hand/arm obstruction detected');
      this._aiCandidate = null;
      this._aiStableFrames = 0;
      this._aiState = 'NO_DART';
      this.debug.aiMovementPx = null;
      return;
    }

    var reading = this._aiLatest;
    if (!reading || reading.confidence < cfg.AI_CONFIDENCE_THRESHOLD) {
      if (this._aiCandidate) this._log('AI candidate lost (confidence below ' + cfg.AI_CONFIDENCE_THRESHOLD + ')');
      this._aiCandidate = null;
      this._aiStableFrames = 0;
      this._aiState = 'NO_DART';
      this.debug.aiMovementPx = null;
      return;
    }

    // Requirement: a new detection must be sufficiently separated from
    // whatever was already confirmed this round, or it's almost certainly
    // the model re-reporting a dart that's already been captured, not a
    // new one -- the model has no other way to tell "new" from "existing".
    var minSeparation = cfg.AI_MIN_NEW_DART_SEPARATION_PX;
    var tooCloseToConfirmed = this._aiConfirmedTips.some(function (p) {
      return Math.hypot(reading.xDet - p.x, reading.yDet - p.y) < minSeparation;
    });
    if (tooCloseToConfirmed) {
      this._aiCandidate = null;
      this._aiStableFrames = 0;
      this._aiState = 'NO_DART';
      this.debug.aiMovementPx = null;
      this.debug.note = 'AI sees only a previously-confirmed dart';
      return;
    }

    var movement = this._aiCandidate ? Math.hypot(reading.xDet - this._aiCandidate.x, reading.yDet - this._aiCandidate.y) : null;
    this.debug.aiMovementPx = movement;

    if (!this._aiCandidate || movement > cfg.AI_STABILITY_MAX_MOVEMENT_PX) {
      // First confident reading, or the AI jumped to a clearly different
      // spot -- (re)start the stability count rather than average across
      // what might be two different darts.
      this._aiCandidate = { x: reading.xDet, y: reading.yDet };
      this._aiStableFrames = 1;
      this._aiState = 'POSSIBLE_DART';
      return;
    }

    this._aiCandidate.x = reading.xDet;
    this._aiCandidate.y = reading.yDet;
    this._aiStableFrames++;
    this._aiState = 'POSSIBLE_DART';

    if (this._aiStableFrames < cfg.AI_STABILITY_FRAMES) return;

    if (cfg.DETECTION_MODE === 'combined') {
      var localArea = this._localDiffArea(gray, reading.xDet, reading.yDet, cfg);
      this.debug.aiLocalDiffArea = localArea;
      if (localArea < cfg.AI_COMBINED_MIN_LOCAL_DIFF_AREA) {
        this._log('AI stable but no local pixel change at (' + Math.round(reading.xDet) + ',' + Math.round(reading.yDet) + ') — not capturing (combined-mode cross-check failed)');
        return; // keep counting -- don't discard the streak over one failed cross-check tick
      }
    }

    this._aiState = 'STABLE_DART';
    var confirmedTip = { x: this._aiCandidate.x, y: this._aiCandidate.y };
    this._aiConfirmedTips.push(confirmedTip);
    this._aiCandidate = null;
    this._aiStableFrames = 0;
    this._aiState = 'WAITING_FOR_NEXT_DART';

    var approxStabilityMs = cfg.AI_STABILITY_FRAMES * (1000 / (cfg.DETECTION_FPS || 8));
    this._captureDart(n, gray, approxStabilityMs, cfg, 1, {
      confidence: reading.confidence,
      method: 'ai_heatmap_v0.3',
      xNative: reading.xNative,
      yNative: reading.yNative
    });
  };

  // Manual "Force Capture" fallback (requirement: keep available in every
  // mode) -- captures the CURRENT frame as the next dart regardless of
  // what either detector currently thinks, for when both miss a real
  // dart. Shares _captureDart with every other path rather than writing
  // the image out separately.
  StateMachine.prototype.manualForceCapture = function (source, sourceW, sourceH) {
    if (!Utils) Utils = global.TC.Utils;
    if (!this.round) { this._log('Force Capture pressed with no active round — ignored'); return; }
    var n = this._dartIndex;
    if (n > 3) { this._log('Force Capture pressed with all 3 darts already captured — ignored (use Darts Removed instead)'); return; }
    var cfg = global.TC.Config.current;
    var frame = Utils.grabDetectionFrame(source, sourceW, sourceH, cfg.DETECTION_WIDTH);
    this._detW = frame.width; this._detH = frame.height;
    this._prevGray = frame.gray;

    var detectionInfo = { confidence: 1, method: 'manual_force_capture' };
    if (this._aiLatest) {
      detectionInfo.xNative = this._aiLatest.xNative;
      detectionInfo.yNative = this._aiLatest.yNative;
      this._aiConfirmedTips.push({ x: this._aiLatest.xDet, y: this._aiLatest.yDet });
    }
    this._aiCandidate = null;
    this._aiStableFrames = 0;
    this._aiState = 'NO_DART';
    this._captureDart(n, frame.gray, 0, cfg, 1, detectionInfo);
  };

  // `newDartsCount` — how many distinct new darts this single settle is
  // believed to represent (usually 1; can be 2 or 3 when throws land
  // faster than the detection+stability cycle can process them
  // individually — see the comment at the call site). The saved image and
  // round.dart_count both reflect the board's TRUE current state
  // (finalCount), even when that means jumping past an intermediate dart
  // number we never got a separate image for.
  //
  // `detectionInfo` — { confidence (0-1), method (string), xNative/yNative
  // (optional, native-resolution tip coordinate kept as provenance
  // metadata only -- never fed into scoring) }. One shared capture path
  // for every detector (background diff, AI, manual override) rather than
  // three slightly different ones.
  StateMachine.prototype._captureDart = function (n, gray, stabilityMs, cfg, newDartsCount, detectionInfo) {
    var self = this;
    newDartsCount = newDartsCount || 1;
    var finalCount = Math.min(3, (n - 1) + newDartsCount);
    this._setState(STATE.CAPTURED(finalCount), 'capturing dart ' + finalCount +
      (newDartsCount > 1 ? ' (' + newDartsCount + ' new darts detected in one settle — rapid throws)' : '') +
      ' [' + detectionInfo.method + ']');
    this._workingBaseline = gray.slice();
    var confidence = detectionInfo.confidence;
    var cameraMovementFlag = this._pendingCameraMovementFlag;
    this._pendingCameraMovementFlag = false;

    var snap;
    try {
      snap = global.TC.Camera.captureFrameSnapshot(); // synchronous — captures THIS instant's frame
    } catch (err) {
      this._log('capture failed: ' + err.message);
      return;
    }
    var Camera = global.TC.Camera;
    var fullBlobPromise = new Promise(function (resolve, reject) {
      snap.canvas.toBlob(function (b) { b ? resolve(b) : reject(new Error('toBlob failed')); }, 'image/jpeg', cfg.CAPTURE_JPEG_QUALITY);
    });
    var thumbBlobPromise = Camera.makeThumbnailFromSnapshot(snap.canvas, snap.width, snap.height, cfg.THUMBNAIL_WIDTH, 0.8);

    Promise.all([fullBlobPromise, thumbBlobPromise]).then(function (results) {
      var imageBlob = results[0], thumbBlob = results[1];
      var captureId = self.round.round_id + '_dart' + finalCount + '_' + Utils.randomHex(6);
      self.captureCount++;
      self.round.dart_count = finalCount;
      global.TC.Storage.saveRound(self.round);

      var qualityFlags = [];
      if (newDartsCount > 1) qualityFlags.push('multiple_new_darts_in_one_capture:' + newDartsCount);

      var record = {
        capture_id: captureId,
        session_id: self.session.session_id,
        round_id: self.round.round_id,
        dart_number: finalCount,
        round_status: 'in_progress',
        timestamp: new Date().toISOString(),
        image_width: snap.width,
        image_height: snap.height,
        stability_ms: Math.round(stabilityMs),
        detection_method: detectionInfo.method,
        detection_confidence: Number(confidence.toFixed(3)),
        ai_tip_x: detectionInfo.xNative != null ? Math.round(detectionInfo.xNative) : null,
        ai_tip_y: detectionInfo.yNative != null ? Math.round(detectionInfo.yNative) : null,
        camera_movement_detected: cameraMovementFlag,
        quality_flags: qualityFlags,
        dart_score: null,
        score_confidence: null,
        image_blob: imageBlob,
        thumbnail_blob: thumbBlob,
        mark: null // reviewer 'good' | 'bad' | null
      };
      return global.TC.Storage.saveCapture(record).then(function () {
        if (self._onCapture) self._onCapture(record);
      });
    }).catch(function (err) {
      self._log('capture failed: ' + err.message);
    });

    // Recompute lastConfirmedAreaVsEmpty from the frame we just committed as
    // the working baseline, against the empty baseline, so the next
    // comparison has an accurate "last known" figure.
    var roi = global.TC.Roi.ensureRoi(this._detW, this._detH);
    var vsEmptyMask = Utils.closeMask(Utils.diffMask(gray, this._emptyBaseline, this._detW, this._detH, cfg.CHANGE_THRESHOLD, roi), this._detW, this._detH);
    this._lastConfirmedAreaVsEmpty = Utils.countNonZero(vsEmptyMask);
    this._cooldownUntil = nowMs() + cfg.COOLDOWN_MS;

    if (finalCount >= 3) {
      this._setState(STATE.ROUND_COMPLETE, 'all 3 darts captured');
      this._setState(STATE.WAITING_FOR_DART_REMOVAL, 'waiting for darts to be removed');
      this._dartIndex = 4; // sentinel: armed only for removal, no more captures this round
    } else {
      this._dartIndex = finalCount + 1;
      this._setState(STATE.READY_FOR_DART(this._dartIndex), 'ready');
    }
  };

  StateMachine.prototype.getStatus = function () {
    return {
      state: this.state,
      session: this.session,
      round: this.round,
      captureCount: this.captureCount,
      debug: this.debug,
      cameraPaused: this._cameraPaused,
      roi: global.TC.Config.current.ROI
    };
  };

  global.TC = global.TC || {};
  global.TC.STATE = STATE;
  global.TC.StateMachine = StateMachine;
})(window);
