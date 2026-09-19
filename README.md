# DartFeed Training Capture v0.1

An isolated, standalone tool whose only job is collecting real-world
dartboard photos for future DartFeed AI training. It is **not** a scoring
system, does not touch production DartFeed code, and does not train or
modify any model.

Every visit to the board is treated as a 3-dart round. For each round the
tool captures up to three images: board+1 dart, board+2 darts, board+3
darts — deliberately including already-present darts in later frames,
since that's exactly the occluded/crowded-board condition the eventual
model needs to learn.

## Files created (all inside `training_capture/`)

```
training_capture/
  README.md              — this file
  index.html              — app shell (Capture / Review / Config tabs)
  css/style.css
  js/config.js            — all tunable thresholds (spec section 25), persisted to localStorage
  js/utils.js              — dependency-free frame-diff primitives (grayscale, blur, diff, connected components)
  js/camera.js             — getUserMedia, resolution/FPS reporting, full-res still capture
  js/roi.js                 — manual board ROI (click-drag rectangle)
  js/storage.js             — IndexedDB (sessions / rounds / captures, each independently retrievable)
  js/stateMachine.js        — the three-dart round state machine (the core of this tool)
  js/session.js             — session ID generation (YYYY-MM-DD_NNN)
  js/exporter.js            — ZIP export of the full dataset folder structure
  js/review.js              — session/round/dart browser UI
  js/main.js                — wires the UI to everything above
  serve-https.js            — optional local HTTPS dev server (Node, no deps) for on-device iPhone testing; see "Testing on an iPhone"
```

Nothing outside `training_capture/` was created, modified, or deleted.
Verified by SHA-256 hashing all 392 non-`training_capture` files before
starting and again at the end: **0 changed, 0 removed, 0 added.**

## How to run

This is a static site with no build step and no dependency on any part of
the existing DartFeed codebase — but `getUserMedia` requires a secure
context, so it must be served over `http://localhost` (or HTTPS), not
opened as a `file://` URL. From the project root:

```bash
python -m http.server 8790 --directory training_capture
```

Then open `http://localhost:8790/` on the same machine. For an iPhone,
see "Testing on an iPhone" below — plain HTTP over your LAN IP is not
enough for camera access.

## Testing on an iPhone

Two separate things have to be true before an iPhone can use this:

1. **Windows Firewall must allow the connection.** If your Wi-Fi network
   is categorized as "Public" (check with `Get-NetConnectionProfile`),
   Windows blocks unsolicited inbound connections by default — the phone's
   request never reaches the server. Allow the port yourself (this is a
   security-setting change, so run it yourself rather than have an
   assistant do it):
   ```bash
   New-NetFirewallRule -DisplayName "Training Capture Dev Server" -Direction Inbound -LocalPort 8790,8791 -Protocol TCP -Action Allow -Profile Any
   ```

2. **iOS Safari only grants camera access on a secure context** (`https://`
   or `http://localhost`) — a plain `http://<lan-ip>` will load the page
   but `Start Session` will fail to get the camera. Use `serve-https.js`
   with a locally-trusted certificate:
   ```bash
   # One-time setup on the PC (mkcert: https://github.com/FiloSottile/mkcert)
   mkcert -install                          # trusts the local CA on THIS PC
   mkcert -cert-file cert.pem -key-file key.pem <your-pc-lan-ip> localhost 127.0.0.1

   # Serve training_capture/ over HTTPS using that cert
   node training_capture/serve-https.js --cert cert.pem --key key.pem --port 8791
   ```
   Then, **on the iPhone**, install mkcert's root CA as a trusted profile
   *before* visiting the HTTPS URL — download `rootCA.pem` (found via
   `mkcert -CAROOT` on the PC) to the phone (e.g. AirDrop, email to
   yourself, or a temporary plain-HTTP file share), open it in Safari to
   install the profile (Settings → General → VPN & Device Management),
   then enable full trust for it under Settings → General → About →
   Certificate Trust Settings. Only then will
   `https://<your-pc-lan-ip>:8791` load without a security warning and
   allow camera access.

   The certificate/key files are machine-specific secrets — keep them
   outside this project directory (they are not needed to review or run
   the app's own code).

Workflow: **Config** tab to tune thresholds if needed → **Capture** tab →
optionally **Draw ROI** over the board area → **Start Session** (grants
camera, establishes the empty-board baseline, then starts round 1) →
throw darts → **Review** tab to browse/export.

## Camera

- Rear/environment-facing camera requested via `facingMode: { ideal:
  'environment' }`, with `width`/`height` ideal set to 1920x2560 (portrait,
  3:4) — a deliberately reduced target rather than the sensor's native max,
  chosen for smaller/faster exports while still ample resolution for a
  bounded scoring-area photo. The browser/device clamps to whatever it
  actually supports if this exact size isn't available.
- The **achieved** resolution (never assumed) and measured FPS (via
  `requestVideoFrameCallback` where supported, else reported as `n/a`) are
  both shown live in the status card.
- Every capture is drawn from the live `<video>` element at its full
  native `videoWidth`/`videoHeight` — never the downscaled detection frame
  — and saved as-is (JPEG, quality 0.92 by default, configurable). A
  separate, smaller thumbnail is generated from the *same* captured canvas
  snapshot (not re-read from the live video) purely for the review grid,
  so a fast subsequent throw can never contaminate the thumbnail with a
  later frame.
- A **zoom slider** appears in the Capture tab once a session starts, if
  the device/browser exposes `zoom` via `MediaTrackCapabilities` (this
  includes recent iOS Safari). Dragging it calls `applyConstraints` on the
  live video track directly — it only affects framing, not detection
  resolution or capture quality. If the device doesn't expose zoom
  capabilities, a "not supported" note is shown instead of a dead slider.

## Detection method

No OpenCV.js or any other vision library — pure Canvas2D + typed-array
JS, so the tool has no external library to fail to load and no version
drift risk. Adapted in spirit (not copied) from the frame-differencing
approach already proven in `dartfeed_ai/dartfeed_ai/index.html`'s
`DartFeedDartDetector`, reimplemented standalone here:

1. Each tick, the current video frame is downscaled to a working
   "detection resolution" (480px wide by default) and converted to a
   blurred grayscale buffer.
2. Two references are kept: **`emptyBaseline`** (the board with zero
   darts) and **`workingBaseline`** (the board as of the last *confirmed*
   dart count).
3. A candidate change is armed when a 4-connected blob (found via
   iterative flood fill — no OpenCV needed) vs. `workingBaseline` exceeds
   `MIN_CHANGE_AREA`, inside the board ROI.
4. The candidate must then hold for `STABILITY_DURATION_MS` of
   *continuous, whole-frame* stability (mean abs diff between consecutive
   frames below `STABILITY_THRESHOLD`) before being trusted — this is what
   filters out the throwing arm, motion blur, and in-flight darts.
5. Once settled, the frame is reclassified by comparing its **total**
   foreground pixel area vs. `emptyBaseline` (not just the new blob) to
   the last confirmed value:
   - **shrank to ~empty** → darts were removed → round finalises
     (complete if 3 darts were captured, incomplete otherwise), baselines
     reset, next round starts immediately.
   - **grew meaningfully** → a new dart was added → capture, advance to
     the next dart index, `workingBaseline` becomes this frame.
   - **anything else** (marginal growth/shrink) → ambiguous; silently
     re-baseline `workingBaseline` to the current frame, no capture. This
     is what prevents duplicate captures — the *next* capture always
     requires a genuinely new, larger-than-last-confirmed foreground area,
     not just a timer.
6. A hand/arm reaching across the board is caught separately: if the
   total changed area vs. `workingBaseline` exceeds `OBSTRUCTION_FRACTION`
   of the ROI, that tick is treated as "obstructed" and ignored entirely
   (no candidate armed, no stability timer running) until the obstruction
   clears.

Camera movement (spec section 17) is watched independently every tick by
diffing the region **outside** the ROI against the current baseline; 3
consecutive over-threshold ticks pause detection, and recovery re-baselines
`workingBaseline` once the scene re-settles, flagging
`camera_movement_detected: true` on the next capture. See Known
Limitations below for what this does *not* fully solve.

## State machine

Implemented explicitly in `js/stateMachine.js`, with every transition
logged (visible in the Debug overlay's event log). States, matching the
spec's list:

`IDLE → INITIALISING → EMPTY_BOARD_DETECTING → READY_FOR_DART_1 →
DART_1_CHANGE_DETECTED → WAITING_FOR_DART_1_STABILITY → DART_1_CAPTURED →
READY_FOR_DART_2 → ... → DART_3_CAPTURED → ROUND_COMPLETE →
WAITING_FOR_DART_REMOVAL → BOARD_CLEARING → EMPTY_BOARD_STABILISING →
READY_FOR_DART_1 (next round)`

Internally, `READY_FOR_DART_2`/`READY_FOR_DART_3` double as
removal-watching states (spec section 13) — the same raw signal, only
classified as "added" vs. "removed" once it settles — so a 1- or 2-dart
round that gets cleared early is detected the same way, and finalises as
`round_status: "incomplete"` with the correct `dart_count`. A round with
`dart_count === 0` (a hand passed through the ROI without leaving
anything) is treated as noise and does *not* churn the round number.

## Storage

IndexedDB (`TrainingCaptureDB`), three object stores — `sessions`,
`rounds`, `captures` (indexed by session/round) — never localStorage for
image bytes. Each capture record is independently retrievable and stores
the full-resolution master JPEG blob, a separate thumbnail blob, and all
metadata from spec section 22, plus the future ground-truth hooks
(`dart_score`, `score_confidence` — both `null` in v0.1) so no format
change will be needed when a scoring workflow is eventually added.

## Export format

The Review tab's **Export ZIP** button (JSZip, loaded from a CDN on
demand — same "load a heavy library only when needed" pattern the
existing DartFeed app uses for OpenCV.js) produces exactly the structure
requested:

```
training_session_<session_id>/
  session.json
  round_0001/
    dart_1.jpg
    dart_2.jpg
    dart_3.jpg
    metadata.json
  round_0002/
    ...
```

`metadata.json` per round carries every field from spec section 22 for
each dart present, keeping the same field names the existing
`dartfeed_ai/dartfeed_ai/dataset/annotations/SCHEMA.md` format expects
(`image_width`/`image_height` at native resolution, no invented tip
coordinates) so converting an exported round into that annotation format
later is a straightforward field mapping, not a rewrite.

## Test results

**Important caveat:** this development environment has no physical
dartboard, no iPhone, and no camera hardware — the browser sandbox
available here actively blocks `getUserMedia`. I could not physically run
the spec's Test Plan A–I (which requires a real board, real throws, and a
real side-mounted iPhone). What I *did* verify directly:

- The app loads with zero console errors, all three tabs (Capture /
  Review / Config) render and switch correctly.
- The Config tab lists all 13 threshold fields from `js/config.js` with
  their defaults, and Save/Reset work.
- The Review tab correctly shows "No sessions recorded yet." against an
  empty IndexedDB, via a real (not mocked) `getAllSessions()` call.
- `Start Session` correctly requests the rear camera, and when
  `getUserMedia` is denied/unavailable (as it is in this sandbox), the
  failure is caught, surfaced to the user via an alert with the real
  error message, and the button re-enables rather than leaving the UI
  stuck — confirmed via the browser console.
- Re-read the entire state machine, capture pipeline, and export logic by
  hand end-to-end (including fixing two real bugs found this way: a
  thumbnail that could have been re-sampled from a *later* live-video
  frame than its master image on a fast double-throw, and a display-name
  bug where the post-3rd-dart removal-watching phase would have shown
  invalid `DART_4_*` state names).

**Not yet verified against real throws:** the actual
`MIN_CHANGE_AREA`/`CHANGE_THRESHOLD`/`STABILITY_*`/`CAMERA_MOVEMENT_THRESHOLD`
default values, which were chosen by reasoning about the detection
resolution and typical dart-blob sizes (informed by the real figures in
`DartFeedDartDetector`'s own code comments — "500-1400+ px" for a dart
blob, but at that module's own different working resolution) rather than
measured on this exact setup. **Running the spec's Test Plan A–I on the
real side-mounted iPhone rig, and tuning thresholds from the Debug overlay
against real throws, is the necessary next step before trusting this for
bulk data collection.**

Rounds tested: 0 (no hardware available). Captures produced: 0. False
positives/negatives, duplicate-capture rate, and camera-movement behavior
under real conditions: unmeasured — please run the Test Plan on-device and
use the Debug overlay (state, timers, `outsideRoiDiff`, candidate area,
event log) to tune `js/config.js`'s defaults from there.

## Known limitations (v0.1)

- **Manual ROI only.** No automatic board localisation — spec explicitly
  allows this for v0.1. A rectangle, not an oblique quadrilateral/ellipse,
  so a tightly-angled side-mount may include more background than ideal;
  widen the ROI conservatively rather than tightly if false positives from
  outside the board occur.
- **Camera-movement recovery is best-effort.** On detecting movement,
  `workingBaseline` is rebuilt immediately so dart-added detection keeps
  working, but `emptyBaseline` is left as-is until the next natural
  round-boundary (no homography/re-alignment in v0.1) — a large mid-round
  camera shift could leave the "back to empty" comparison slightly
  miscalibrated until the next round starts fresh.
- **Overlay/video aspect-ratio assumption.** The ROI-drawing overlay
  assumes the camera stream is close to 4:3 (matching the CSS container);
  a device that only offers a markedly different aspect ratio could show
  minor letterbox misalignment between the drawn ROI and the actual video
  content.
- **Detection thresholds are reasoned, not yet field-tuned** — see Test
  Results above.
- **Single dart cap enforced but not "smart."** If a dart is nudged
  (not removed) after all 3 are captured, that's correctly logged and
  ignored rather than mis-captured as a 4th image, but it's also not fed
  back as useful signal.

## Recommended v0.2 improvements

1. Run the full Test Plan (A–I) on the real rig and tune
   `js/config.js` defaults from the Debug overlay's live numbers.
2. Replace the manual rectangular ROI with an oblique quadrilateral (or
   reuse the *idea* of the existing ring-ellipse detector, adapted
   standalone) for tighter background exclusion.
3. Proper camera-movement recovery via homography re-alignment instead of
   the current best-effort re-baseline, so `emptyBaseline` stays valid
   immediately after a shift rather than only at the next round boundary.
4. Optional ground-truth capture UI (per-dart score entry, feeding the
   already-reserved `dart_score`/`score_confidence` fields) — explicitly
   out of scope for v0.1 per spec.
5. A "session summary" export view (aggregate capture/duplicate/false-positive
   counts across a batch of sessions) once real usage data exists.
