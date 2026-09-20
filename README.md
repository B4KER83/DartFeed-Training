# DartFeed Training Capture

An isolated, standalone tool whose only job is collecting real-world
dartboard photos for future DartFeed AI training. It is **not** a scoring
system, does not touch production DartFeed code, and does not train or
modify any model.

**Current version:** see `TC_VERSION` at the top of `js/config.js` — the
version shown live in the app header is the single source of truth, kept
in sync with a running changelog comment right above it. This README is
updated when the picture changes meaningfully, but the changelog comment
is the authoritative, entry-by-entry history; don't duplicate it here.

**Live deployment:** `https://b4ker83.github.io/DartFeed-Training/` — a
public GitHub Pages site (real HTTPS, no local server/certificate dance
needed for on-device iPhone testing). See "How to run" below for how this
relates to local development.

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

**On an iPhone (or any device), the simplest path is the live deployment:**
open `https://b4ker83.github.io/DartFeed-Training/` in Safari. Real HTTPS
means camera access just works — no certificate install, no firewall
rule, no local server. This is the URL actually used for real-board
testing.

To deploy a local change to that site: copy the changed file(s) from this
`training_capture/` folder into a local clone of the `DartFeed-Training`
GitHub repo (same relative paths — `index.html` at the repo root,
`js/*.js` under `js/`, etc.), then `git add -A && git commit && git push`.
GitHub's CDN can serve a stale cached copy for a few minutes after a push
— if a fix doesn't seem to have landed, hard-refresh or wait before
assuming it didn't deploy.

**For local development** (no deployment, testing on the same machine),
this is a static site with no build step — but `getUserMedia` requires a
secure context, so it must be served over `http://localhost` (or HTTPS),
not opened as a `file://` URL:

```bash
python -m http.server 8790 --directory training_capture
```

Then open `http://localhost:8790/`. For local testing *from an iPhone*
specifically (rather than using the live deployment above), see "Testing
on an iPhone" below — plain HTTP over your LAN IP is not enough for
camera access, and this path needs a firewall rule plus a locally-trusted
certificate.

## Testing on an iPhone (local-network alternative to the live deployment)

If you specifically want to test a local change on your iPhone *before*
pushing it to the deployed site, two separate things have to be true:

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
  'environment' }`, with `width`/`height`/`aspectRatio` ideal set to
  1920x2560 (portrait, 3:4). **Field-confirmed: these are hints, not
  guarantees.** On the real iPhone rig this is actually tested on, the
  device ignores the requested portrait shape and delivers its own native
  landscape stream instead (observed: 2560x1920). Never assume the
  requested size was honoured — always read back the achieved resolution.
- Because of that, the target resolution is enforced **in software**
  instead: every capture is downscaled (never upscaled) so its long edge
  is capped at `MAX_CAPTURE_LONG_EDGE` (2560px by default, in
  `js/config.js`), aspect ratio always preserved exactly as the camera
  delivered it. This guarantees a predictable file size regardless of
  what resolution/orientation the device actually negotiates.
- The **achieved** resolution (never assumed) and measured FPS (via
  `requestVideoFrameCallback` where supported, else reported as `n/a`) are
  both shown live in the status card.
- Every capture is drawn from the live `<video>` element (then downscaled
  per the point above) — never from the separate, smaller detection-
  resolution frame used for change-detection. A thumbnail is generated
  from the *same* captured canvas snapshot (not re-read from the live
  video) purely for the review grid, so a fast subsequent throw can never
  contaminate the thumbnail with a later frame.
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
3. The raw per-pixel threshold diff mask is passed through a **3x3
   morphological close** (dilate then erode — added after a real field
   test showed a blob's detected size flickering wildly tick-to-tick,
   e.g. 400 → 7000 → 950px, for what was physically one settled scene:
   two darts landing close together produced a mask that flickered
   between "one connected blob" and "two separate pieces" from just a
   few noisy pixels at the boundary. Closing bridges that gap, the same
   fix production's OpenCV-based detector gets from its own morphological
   close/open, reimplemented in plain JS here).
4. A candidate change is armed when the largest 4-connected blob (found
   via iterative flood fill — no OpenCV needed) in that closed mask vs.
   `workingBaseline` exceeds `MIN_CHANGE_AREA`, inside the board ROI.
5. The candidate must then hold for `STABILITY_DURATION_MS` of
   *continuous, whole-frame* stability (mean abs diff between consecutive
   frames below `STABILITY_THRESHOLD`) before being trusted — this is what
   filters out the throwing arm, motion blur, and in-flight darts.
6. Once settled, the frame is reclassified by comparing its **total**
   foreground pixel area vs. `emptyBaseline` (not just the new blob) to
   the last confirmed value:
   - **at or below `emptyThreshold`** → darts were removed → round
     finalises (complete if 3 darts were captured, incomplete otherwise),
     baselines reset, next round starts immediately. `emptyThreshold` is
     `max(EMPTY_BOARD_MATCH_THRESHOLD, lastConfirmedAreaVsEmpty * 0.4)` —
     not just the fixed config floor. A fixed floor alone proved brittle
     in the field: real sensor noise and slow auto-exposure drift over a
     session can keep a genuinely empty board's diff-vs-original-baseline
     above a small fixed number indefinitely, which was silently
     swallowing real removals into the "ambiguous" branch below forever.
   - **grew meaningfully** → a new dart was added → capture, advance to
     the next dart index, `workingBaseline` becomes this frame.
   - **anything else** (marginal growth/shrink) → ambiguous; silently
     re-baseline `workingBaseline` to the current frame, no capture. This
     is what prevents duplicate captures — the *next* capture always
     requires a genuinely new, larger-than-last-confirmed foreground area,
     not just a timer.
7. A hand/arm reaching across the board is caught separately: if the
   total changed area vs. `workingBaseline` exceeds `OBSTRUCTION_FRACTION`
   of the ROI **while the frame is still actively moving**, that tick is
   treated as "obstructed" and ignored entirely (no candidate armed, no
   stability timer running) until the obstruction clears. The "still
   actively moving" qualifier was added after a field test: without it,
   a single large but *settled* legitimate change (e.g. removing all 3
   darts at once genuinely can exceed the obstruction area fraction, by
   pure pixel count) got mistaken for an ongoing obstruction and never
   re-evaluated — the round-removal logic never got a chance to run at
   all. Obstruction start/clear are each logged once (not every tick),
   specifically so a detection problem caused by rapid, repeated
   obstruction (e.g. throwing darts in fast succession, hand sweeping
   back through frame for the next one before the previous settles) shows
   up in an exported debug log instead of an unexplained silent gap.

Camera movement (spec section 17) is watched independently every tick by
diffing the region **outside** the ROI against the current baseline; 3
consecutive over-threshold ticks pause detection, and recovery re-baselines
`workingBaseline` once the scene re-settles, flagging
`camera_movement_detected: true` on the next capture. See Known
Limitations below for what this does *not* fully solve.

**On `CHANGE_THRESHOLD`** (default 45, raised from an initial guess of 25):
field-tested and confirmed, not tuned by feel. At 25, a single dart's
`lastConfirmedAreaVsEmpty` measured ~44,000px — roughly 76% of the entire
ROI — because iPhone video compression noise across the board's own busy
texture (sisal fibres, printed numbers, wire) was crossing the threshold
across most of the ROI, not just where the dart actually was. Raising it
to 45 dropped the same measurement to ~928px on a comparable throw, a
~47x reduction, isolating this one setting as the actual cause rather
than a deeper algorithm problem.

**Resolved (v0.5.0): rapid, continuous throwing (~1s between darts).**
Reviewing a recorded round side-by-side with its debug log showed the real
cause directly: all 3 darts were already visibly embedded in the board
while the debug overlay still read `Darts 0/3`. Two compounding bugs:

1. The stability check (drives the "has the scene stopped moving" timer)
   was computed over the *entire* camera frame, not just the board ROI. A
   player moving near the oche between throws kept the whole scene
   "unstable" for the full throwing sequence, merging all 3 darts into one
   settle event instead of one per dart. Now scoped to the ROI only, so
   the board can settle independently of what the player's body is doing
   elsewhere in frame.
2. Even at a single settle event, the code always assumed exactly one new
   dart had landed. Since `STABILITY_DURATION_MS` + `COOLDOWN_MS` alone
   already total more than a 1-second throw cadence, more than one dart
   landing within a single settle window is the *expected* case at a real
   playing pace, not a rare edge case. A settle event now counts distinct
   dart-sized regions on the board (two independent signals — total area
   grown, and connected-component count, taking the more conservative of
   the two) and advances `dart_count` by the real number found.

This is a heuristic, not perfect ground truth: darts landing very close
together (e.g. same triple) can still merge into one blob and under-count.
When more than one new dart is detected in a single capture, the record's
`quality_flags` includes `multiple_new_darts_in_one_capture:N` so it's
visible during review rather than failing silently. The manual **"Darts
Removed"** button (see State machine, below) remains as a stopgap for
whatever automatic detection still misses.

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

**Manual override:** a **"Darts Removed"** button on the Capture tab
(enabled once a session is running) calls the exact same finalise-round
logic automatic detection uses — it's a true override sharing one code
path (`_confirmBoardEmpty`), not a separate/divergent one — for when
automatic removal detection doesn't catch it. It grabs a fresh frame at
the moment it's pressed, so it reflects the board as it actually is right
then, not whatever the last detection tick happened to see.

## Diagnostics

Two tools exist specifically to debug a detection problem remotely,
without needing a back-and-forth of screenshots:

- **Export debug log** (in the Debug overlay panel) downloads a JSON file
  with the full event history (up to the last 500 transitions, not just
  the 40 shown on-screen), every live detection number
  (`candidateArea`/`areaVsEmpty`/`emptyThreshold`/etc.), the exact config
  in effect, camera/ROI info, and session/round state.
- **Record Clip** (Capture tab controls, enabled once a session is
  running) records the camera feed via `MediaRecorder` on a canvas with a
  live status HUD burned into every frame (state / round / dart count /
  captures / timestamp), so a detection problem can be *watched* happening
  rather than just read as numbers. On stop, it bundles the clip and a
  matching debug log (same start/end time window) into a single `.zip`
  and downloads that — **not** two separate files. This matters: it
  originally triggered two downloads back-to-back, and iOS Safari only
  reliably allows one programmatic download per user gesture, silently
  dropping the first (the clip) every time. Needs `MediaRecorder` +
  `canvas.captureStream` support (iOS Safari 14.3+, recent Chrome); shows
  a clear "not supported" note rather than failing silently otherwise.
  Note: the produced `.mp4` may not support seeking cleanly in every
  player (a known quirk of `MediaRecorder` output) — play it from the
  start rather than scrubbing if seeking misbehaves.

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

**Status: real on-device testing is underway** (not the sandbox-only
state this section originally described) — the tool is deployed and
being thrown at on the actual side-mounted iPhone rig, and multiple real
bugs have been found and fixed directly from field data rather than
guessed. This section reflects what's actually been confirmed so far, not
a completed formal run of the spec's Test Plan A–I.

**Confirmed working, from real sessions:**
- Registration/deployment loop (GitHub Pages, cache-busted verification),
  camera start, ROI drawing (touch), zoom, full 3-dart rounds capturing
  correctly with sane per-image confidence values.
- The `CHANGE_THRESHOLD` fix (see Detection method) — directly measured
  before/after on the same rig: `lastConfirmedAreaVsEmpty` after one dart
  dropped from ~44,000px (threshold 25) to ~928px (threshold 45).
- **Record Clip + Export debug log**, verified against a real recorded
  session: the HUD-overlaid clip correctly shows the live board state
  matching the exported log's timestamps.

**Confirmed NOT yet reliable:**
- **Dart removal detection** — improved by the relative-threshold and
  obstruction-gating fixes (see Detection method), but not yet fully
  trusted; the manual "Darts Removed" button exists as a stopgap.
- **Rapid-fire throwing** — at least one real case of a dart being missed
  entirely when thrown in quick succession after the previous one,
  currently under investigation (see the "Known open issue" note in
  Detection method above). Throwing with a brief, deliberate pause after
  each dart (hand fully out of frame, briefly still) is a reasonable
  workaround for data-collection sessions specifically while this is
  investigated, even though it wouldn't be acceptable for eventual live
  scoring.

**Still not tested at all:** the full formal Test Plan A–I (empty-board
false-positive rate over an extended idle period, lighting-change
robustness, several-consecutive-rounds duplicate-capture rate, camera-
movement mid-round recovery). Use the Debug overlay's live numbers
(`candidateArea`/`MIN_CHANGE_AREA`, `areaVsEmpty`/`emptyThreshold`) and
the Export debug log / Record Clip tools to keep tuning `js/config.js`'s
defaults from real data as this continues, rather than reasoning further
from first principles.

## Known limitations

- **Manual ROI only.** No automatic board localisation. A rectangle, not
  an oblique quadrilateral/ellipse, so a tightly-angled side-mount may
  include more background than ideal; widen the ROI conservatively rather
  than tightly if false positives from outside the board occur.
- **Camera-movement recovery is best-effort.** On detecting movement,
  `workingBaseline` is rebuilt immediately so dart-added detection keeps
  working, but `emptyBaseline` is left as-is until the next natural
  round-boundary (no homography/re-alignment) — a large mid-round camera
  shift could leave the "back to empty" comparison slightly miscalibrated
  until the next round starts fresh.
- **Overlay/video aspect-ratio assumption.** The ROI-drawing overlay
  assumes the camera stream is close to the CSS container's configured
  aspect ratio; since the camera's actual delivered orientation/aspect
  isn't fully within this app's control (see Camera, above), a device
  that delivers something markedly different could show letterbox
  misalignment between the drawn ROI and the actual video content.
- **Multi-dart-per-capture counting is a heuristic, not ground truth** —
  see Detection method's "Resolved (v0.5.0)" note. Darts landing very
  close together can still merge into one blob and under-count; flagged
  via `quality_flags` when it happens, not silent.
- **Recorded `.mp4` clips may not seek cleanly** in every video player —
  a `MediaRecorder` output quirk, not a bug specific to this tool; play
  from the start rather than scrubbing.
- **Single dart cap enforced but not "smart."** If a dart is nudged
  (not removed) after all 3 are captured, that's correctly logged and
  ignored rather than mis-captured as a 4th image, but it's also not fed
  back as useful signal.

## Recommended next improvements

1. Confirm the v0.5.0 rapid-throwing fix with a fresh Record Clip + debug
   log at a real ~1s-between-darts pace, and check the multi-dart
   component-counting heuristic's accuracy against real footage (does it
   ever under/over-count when darts land close together?).
2. Run the remainder of the formal Test Plan (A–I) — empty-board idle
   stability, lighting-change robustness, several-consecutive-rounds
   duplicate-capture rate — and keep tuning `js/config.js` from the
   Debug overlay's live numbers as that happens.
3. Replace the manual rectangular ROI with an oblique quadrilateral (or
   reuse the *idea* of the existing ring-ellipse detector, adapted
   standalone) for tighter background exclusion.
4. Proper camera-movement recovery via homography re-alignment instead of
   the current best-effort re-baseline, so `emptyBaseline` stays valid
   immediately after a shift rather than only at the next round boundary.
5. An in-browser tap-to-annotate tool (adapting the existing
   `dartfeed_ai/dartfeed_ai/tools/annotate.html` pattern, or building a
   lighter equivalent) that reads Training Capture's exported rounds
   directly and carries dart 1/2's coordinates forward automatically
   within a round — the main practical bottleneck once enough images
   exist is the manual annotation step, not collection itself.
6. Optional ground-truth capture UI (per-dart score entry, feeding the
   already-reserved `dart_score`/`score_confidence` fields) — explicitly
   out of scope for now.
7. A "session summary" export view (aggregate capture/duplicate/false-positive
   counts across a batch of sessions) once enough real usage data exists.
