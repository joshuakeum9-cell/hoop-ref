# HoopRef

A browser based basketball referee. It watches through your camera, tracks up to eight
players and the ball, and calls **double dribble**, **carry**, and **traveling** in real
time with a confidence score on every call. Everything runs on your device. No video is
uploaded, there is no server, and there is no API key.

**Live: https://joshuakeum9-cell.github.io/hoop-ref/**

- [Test suite and benchmarks](https://joshuakeum9-cell.github.io/hoop-ref/tests/) (222 checks)
- [Evidence report](REPORT.md): accuracy, precision, recall, latency, memory

## Put it on GitHub Pages

1. Create a repo and upload the whole folder, keeping `src/` and `tests/` intact.
2. Settings, then Pages, then deploy from `main`, folder `/ (root)`.
3. Open `https://YOUR-USERNAME.github.io/YOUR-REPO/`.

The camera needs **https** or **localhost**. GitHub Pages is https, so it works there.
Opening `index.html` straight off your disk will not work, because browsers block camera
access on `file://`.

To run locally:

```bash
python -m http.server 8123 --directory hoop-ref
```

## Getting good calls

Camera placement matters more than any setting in the app.

- **Fix the camera.** Tripod, chair, windowsill. Handheld breaks step counting, because
  the app cannot separate your movement from the players'.
- **Side on, waist height, 6 to 15 feet back.** Whole bodies and the floor in frame.
- **Bright, even light.** Backlight turns players into silhouettes and tracking dies.
- **Set the roster to the real number of players.** This is the biggest performance
  control in the app: pose inference cost is close to linear in roster size, measured at
  about 23 fps for 2 players and about 6 fps for 8 on a desktop GPU.
- **Calibrate the court.** Twenty seconds, and it removes perspective bias from step
  counting entirely.

Test with a clip first. **Load a video clip** runs the whole pipeline on a file, which is
far easier to iterate on than running around with a ball.

## Court calibration

Click the four corners of a known rectangle on the floor, usually the painted lane, and
the app solves a homography from image to court plane.

This is not cosmetic. Uncalibrated, every distance is measured in pixels, and pixels lie:
the same stride is 200 px near the camera and 40 px at the far end, and a step taken
straight toward the lens is almost zero pixels wide. That last case was a real false
negative source. On the court plane a step is always a step.

Calibration is saved in your browser and survives reloads.

## Confidence, and refusing to guess

Every call carries a number, and the number means something. It is a weighted geometric
mean of six independent evidence factors:

| Factor | What it asks |
|---|---|
| Coverage | How much of the event was backed by real detections rather than prediction |
| Keypoints | Confidence of the specific joints the rule depended on |
| Margin | How decisively the triggering signal passed its threshold |
| Clarity | Scene light, contrast and focus |
| Isolation | Freedom from crowding, since an occluded handler is a guess |
| Stability | How settled possession was through the event |

Geometric rather than arithmetic on purpose. A referee who saw the whole move clearly
except that the ball was never actually detected should not be 70% sure because
everything else was fine. One factor near zero drags the whole score down, and with a
product it does.

Below the confidence threshold, the app shows **NO CALL** with the reason instead of
guessing. Turn on "show no calls in the log" to see the near misses and why each was
rejected. Measured behaviour: in near darkness and above 70% ball frame loss, it declines
rather than calling.

## Architecture

```
src/
  math.js          geometry, homography, Kalman filter, ring buffer
  config.js        every tunable, mode presets, persistence
  pose.js          landmark conversion, name indexed keypoints, size gate
  tracker.js       ByteTrack style identity tracking with appearance
  ball.js          Kalman ball tracking, physics gating, colour verification
  vision.js        one shared downscaled frame for all pixel work
  rules.js         possession state machine, violations, replay review
  confidence.js    evidence scoring
  calibration.js   court homography
  render.js        overlay drawing
  main.js          model lifecycle, main loop, UI wiring
tests/
  sim.js           gameplay simulator with ground truth
  unit.js integration.js stress.js regression.js accuracy.js perf.js
```

The rules engine touches no DOM. It takes poses, a ball tracker, a config object and a
scene quality reading, and returns events. That is what lets the whole thing run headless
in the test suite at roughly 107,000 simulated frames per second, and it keeps about ten
`getElementById` calls per frame out of the render loop.

### Identity tracking

MediaPipe returns an unordered, unlabelled list of people whose order changes every
frame. The rules need identity: telling a pass from a double dribble depends entirely on
knowing whether the ball changed hands. So the tracker is ByteTrack shaped:

- **Two stage association.** Confident detections match first and claim tracks; weak ones
  then recover whatever is left. A partially occluded player produces a weak detection,
  which is excellent evidence that someone is there and poor evidence of who.
- **Kalman motion.** Matching on predicted position rather than last position is what
  survives a crossing, because momentum separates two players whose centroids momentarily
  coincide.
- **Appearance.** Torso colour histograms break ties that motion cannot, which is exactly
  the crossing case. This is the single biggest contributor to not swapping IDs.
- **Re-identification.** A player who leaves the frame and returns gets their number back
  rather than a new one.

### Replay review

The engine keeps eight seconds of per frame state. When a rule triggers, the candidate is
re-examined against that buffer before anything is called: was there really a dribble,
then a gather, then another dribble, and was enough of it actually observed? A candidate
that cannot be corroborated becomes a no call. This is the difference between a frame by
frame heuristic and something that behaves like an official who watched the play.

## Tests

Open [`tests/`](tests/) and press **Run everything**. 222 checks in under two seconds, no
camera and no models needed.

- **unit** maths, homography, Kalman, confidence, colour, pose helpers
- **integration** rules end to end, possession, identity under load
- **stress** noise sweeps, dropouts, adversarial detections, crowding, fast breaks, soak
- **regression** every defect ever fixed, named after the bug
- **accuracy** precision and recall against scripted ground truth
- **performance** stage latency, throughput, memory over 20 simulated minutes

Full results in [REPORT.md](REPORT.md).

## The honest limits

- **Fouls cannot be detected this way.** Contact between players from a single 2D camera,
  with no force information and constant occlusion, is an unsolved problem. The contact
  flag is a proximity prompt for human review, capped at 45% confidence, off by default.
- **Accuracy figures cover the rules layer** given input of a known quality. Whether
  MediaPipe and COCO-SSD deliver that quality on your court is a separate question that
  needs labelled real footage. It is the largest remaining uncertainty.
- **Eight players is expensive**, roughly 6 fps of pose inference on a mid range desktop
  GPU. Phones will be slower. Use the smallest roster that fits your game.
- **A dense rebound scramble** will lose tracks and re-mint identities. It fails silent
  rather than making a wrong call.
- **It has no idea what the game situation is.** No shot clock, no possession arrow, no
  inbounds, no dead ball.

Use it for drills and review. Do not use it to settle an argument in a real game.

## What is under the hood

- [MediaPipe Pose Landmarker](https://ai.google.dev/edge/mediapipe/solutions/vision/pose_landmarker),
  lite model, up to 8 people. Detection confidence is set to 0.15 rather than the usual
  0.4: measured against real in-game photographs, 0.4 found one person in a frame
  containing ten, because small, blurred, overlapping bodies all score low. The junk that
  lower threshold admits is removed by a torso size gate.
- [COCO-SSD](https://github.com/tensorflow/tfjs-models/tree/master/coco-ssd) for the
  `sports ball` class, with colour verification on top to reject orange jerseys.
- TensorFlow.js on WebGL.

Both load from a CDN on first run and are cached afterwards.
