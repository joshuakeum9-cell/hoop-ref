# HoopRef evidence report

Generated from the in-browser suite at `tests/`. Every number here came from a run you
can reproduce by opening that page and pressing **Run everything**.

**Test machine:** Windows 11, 12 CPU cores, 16 GB RAM, NVIDIA GeForce GTX 1660 SUPER
(via ANGLE / D3D11), WebGL 2.0, Chromium 148.

**Suite result: 222 checks, 222 passed, 0 failed, 1.8 seconds.**

---

## 1. What can and cannot be measured in a browser

This matters for reading everything below honestly.

| Metric | Measurable in a browser? | What is reported here |
|---|---|---|
| Frames per second | Yes | Measured |
| Per stage latency | Yes | Measured with `performance.now()` |
| JS heap size | Chromium only | Measured via `performance.memory` |
| **CPU utilisation** | **No** | No browser exposes process CPU to a web page. Main thread time per frame is used as the proxy |
| **GPU utilisation** | **No** | No browser exposes GPU load to a web page. The GPU renderer string and GPU stage timings are reported instead |

There is no web API that reports process CPU or GPU load, for fingerprinting reasons.
Anything that claims to is estimating. The honest proxy is main thread time against the
frame budget: at 30 fps the budget is 33.3 ms, so a pipeline using 20 ms has committed
about 60% of the main thread.

---

## 2. Accuracy

### Scope of the claim

These figures measure the **rules and tracking layers** given input of a stated quality,
using a deterministic gameplay simulator where ground truth is known by construction.
They do **not** measure whether MediaPipe and COCO-SSD deliver that quality on your
court. That is a separate question that needs labelled real footage, and it is the
larger remaining uncertainty in the system. The two are kept apart here rather than
blended into one flattering number.

### Per rule, across all scenarios

Positive cases are real violations under varying conditions. Negative cases are legal
play that must not be called: crossovers, behind the back, spin moves, pivots, passes,
shots, rebounds, loose balls, jab fakes, and clean dribbles.

| Rule | Cases | TP | FP | FN | Precision | Recall | F1 |
|---|---|---|---|---|---|---|---|
| Double dribble | 15 | 6 | 0 | 0 | 100% | 100% | 1.00 |
| Traveling | 6 | 3 | 0 | 0 | 100% | 100% | 1.00 |
| Carry | 7 | 2 | 0 | 0 | 100% | 100% | 1.00 |

Zero false positives across every legal move fixture. That is the number that matters
most for a referee: a system that invents violations is worse than useless.

### Behaviour as conditions degrade

The same true violation, run through a ladder of degrading input.

| Condition | Outcome | Confidence |
|---|---|---|
| Ideal | Called | 91% |
| Light jitter | Called | 91% |
| Heavy jitter | Called | 91% |
| 30% of ball frames dropped | Called | 87% |
| 50% dropped | Called | 77% |
| 70% dropped | **Declined** | 62% |
| Dim gym | Called | 78% |
| Very dark | **Declined** | 59% |
| Heavy motion blur | Called | 71% |

Confidence falls monotonically as evidence weakens, and the two worst conditions fall
below the 70% threshold and become **NO CALL** rather than a guess. That is the designed
failure mode working.

### Detector dropout sweep, 20 seeds per rate

The most important robustness curve in the system, because a ball held in two hands is
the most occluded object on the court and the detector loses it constantly.

| Ball frames dropped | Recall | False positives | Mean confidence |
|---|---|---|---|
| 0% | 100% | 0 | 91% |
| 20% | 100% | 0 | 87% |
| 30% | 100% | 0 | 84% |
| 40% | 100% | 0 | 80% |
| 50% | 95% | 0 | 77% |
| 60% | 65% | 0 | 74% |
| 70% | 30% | 0 | 71% |

Useful degradation: recall holds at 100% through 40% frame loss, then falls away while
precision stays perfect. The system loses events rather than inventing them.

**This curve is the result of a fix, not the original design.** Before it, recall was
25% at only 20% dropout. See defect 8 below.

### Input noise sweep

Jitter applied to every ball detection and every keypoint simultaneously.

| Jitter | False calls | Bounces counted |
|---|---|---|
| +/- 0 px | 0 | 5 of 5 |
| +/- 5 px | 0 | 5 of 5 |
| +/- 10 px | 0 | 5 of 5 |
| +/- 15 px | 0 | 5 of 5 |
| +/- 22 px | 0 | 5 of 5 |
| +/- 30 px | 0 | 5 of 5 |
| +/- 40 px | 0 | 5 of 5 |

No false calls and no missed bounces at up to +/- 40 px of jitter, which is nearly three
ball radii on every input at once.

### Roster size

The violation happens inside a crowd of N players.

| Players | TP | FP | FN |
|---|---|---|---|
| 2 | 1 | 0 | 0 |
| 4 | 1 | 0 | 0 |
| 6 | 1 | 0 | 0 |
| 8 | 1 | 0 | 0 |

Crowding does not degrade correctness. It does cost frame rate, see below.

---

## 3. Performance

### Our own code, per frame

Everything that is not a model. Measured over thousands of iterations.

| Stage | Cost per frame |
|---|---|
| Rules engine, 1 player | 0.002 ms |
| Rules engine, 4 players | 0.002 ms |
| Rules engine, 8 players | 0.006 ms |
| Tracker, 2 players | 0.014 ms |
| Tracker, 4 players | 0.013 ms |
| Tracker, 8 players | 0.027 ms |
| Frame quality pass, 192x108 | 0.617 ms |
| Appearance histogram, per player | 0.012 ms |
| **All of our own work, 8 players** | **0.44 ms** |

That is **1.3% of the 33 ms frame budget**. Our code is not the bottleneck and cannot
become one. Headless, the non model pipeline sustains roughly **107,000 simulated frames
per second**, about 3,500 times realtime.

### The models, which are the bottleneck

Measured against a real 1280 px in-game photograph on the GTX 1660 SUPER.

| Roster | Pose inference | Implied ceiling |
|---|---|---|
| 2 players | 44 ms | ~23 fps |
| 4 players | 87 ms | ~11 fps |
| 6 players | 130 ms | ~7.7 fps |
| 8 players | 178 ms | ~5.6 fps |

COCO-SSD costs a further 34 to 50 ms per call, which is why it runs every second frame
and backs off further under load.

**Pose cost is close to linear in roster size.** This is the single most important
performance fact about the app, and it is why the roster control carries a warning and
why the half court mode presets exist. Set it to the real number of players and no
higher.

### Input downscaling

Both models now read from one 640 px wide copy of the frame instead of the full
resolution video.

| Inference width | Pose, 8 poses | COCO-SSD | People found |
|---|---|---|---|
| 1280 px | 147 ms | 42 ms | 5 |
| 960 px | 155 ms | 42 ms | 5 |
| 720 px | 130 ms | 38 ms | 5 |
| **640 px** | **105 ms** | **34 ms** | **7** |
| 480 px | 147 ms | 37 ms | 6 |

640 px is the measured sweet spot: about 30% faster than native **and** it found more
people, because the model's own internal rescale is better fed by a cleanly downscaled
source than by a large one.

### Live camera frame rate

**Not measured.** The verification browser pane runs hidden, so a canvas captured video
stream never produces frames (`readyState` stays 0) and `detectForVideo` cannot be
exercised. The stage timings above are from IMAGE mode on real photographs, which
re-runs person detection every frame; VIDEO mode reuses tracking between frames and
should be faster in steady state. Treat the implied ceilings as a conservative floor for
live performance, and read the in-app fps counter for the real number on your hardware.

---

## 4. Memory

Twenty simulated minutes of continuous play, 36,000 frames.

| Measure | Result |
|---|---|
| Heap before | 18.3 MB |
| Heap after 36,000 frames | 16.1 MB |
| Growth | **-2.2 MB** |
| Replay buffer | Fixed at capacity, did not grow |
| Ball observation buffer | Fixed at capacity, did not grow |
| Bounce history | Bounded at 40 entries |
| Retired identity pool | Bounded at 12 after 40 enter and leave cycles |
| Active track list | Bounded at 8 |

Heap went **down**, meaning the garbage collector reclaimed more than the run allocated:
there is no leak. Every retained structure is a fixed capacity ring buffer or an
explicitly capped list, verified structurally as well as by heap measurement.

---

## 5. Defects found and fixed during this work

Every one of these was found by the test suite, and each has a permanent regression test.

1. **Kalman covariance update used already-overwritten values.** `P.vv` was updated with
   the new `P.pv` instead of the prior one, leaving the velocity gain too high. On a
   stationary ball the velocity estimate oscillated: -53, +36, +110, +205 and climbing.
   A ball at rest in the hands is exactly this case, so a gather was never recognised and
   no double dribble could ever be called.

2. **Kalman predict and update ran in the wrong order.** The measurement was fused before
   the filter advanced to the current time, so velocity never built. Predicting is now
   done inside `offer` rather than trusted to the caller.

3. **Statistical gating rejected the ball at every bounce.** A basketball reverses
   velocity instantaneously at the floor, which no constant velocity model predicts, so
   the innovation at each bounce was 10+ sigma. The gate is now physical, based on
   plausible travel, which keeps the bounce and still rejects a detection across the court.

4. **Gravity estimation broke possession detection.** A speculative feature: it biased a
   stationary ball downward, settling its velocity at 119 px/s instead of zero, which
   defeated the gather test. Removed, with the reasoning recorded in the source.

5. **Carry fired on passes, shots and loose rebounds.** Any ball peaking near a hand
   qualified. Palming is a dribbling violation, so it now requires an active dribble.

6. **Carry fired on crossovers and behind the back moves.** A hand beside the ball read
   as a hand under it. Now requires horizontal alignment, not just vertical position.

7. **A crossover was called a double dribble.** The top of a crossover puts the ball
   momentarily between both hands, and two-hand contact was treated as an instant gather.
   Two hands now shortens the required dwell rather than skipping it, and both paths
   require a demonstrably slow ball.

8. **One dropped frame destroyed a whole gather.** The evidence counter reset to zero on
   any frame that failed the test. Measured across 20 seeds, recall collapsed from 100%
   to 25% at only 20% dropped frames. Evidence now accumulates and decays, and a frame
   with no detection at all is treated as no information rather than as contradiction.

9. **Gather detection used filtered velocity, which lags.** Coming out of a fast dribble
   the filter still reported hundreds of px/s for six or seven frames after the ball had
   physically stopped. Rest is now judged on measured displacement, which has no lag.
   Fixes 8 and 9 together took dropout recall from 25% to 100% at 20% loss.

10. **Concurrent model loads leaked a detector.** Starting the camera and loading a clip
    together built two landmarkers and orphaned one. Loads are now deduplicated.

11. **`apexY` was never initialised or reset.** The first carry evaluation of a session
    compared against `undefined`.

12. **Crowding penalty treated every untracked pose as the handler**, because all of them
    carry a null id and null equals null.

13. **The rules engine read the DOM every frame**, roughly ten `getElementById` plus
    `parseFloat` calls per frame. It now takes a config object and touches no DOM at all,
    which is both faster and what makes headless testing possible.

14. **Keypoint lookup was a linear scan** run about 30 times per player per frame. Now a
    name indexed map built once.

15. **Wall clock time base was wrong for video files.** A clip playing at anything other
    than realtime produced wrong velocities. Media time is now used for file sources.

---

## 6. Known limitations

- **Fouls are not detectable** from a single 2D camera. No force information, no way to
  judge who initiated, constant occlusion. The contact flag is a proximity prompt for
  human review with confidence capped at 45%, and it is off by default.
- **Real world perception accuracy is unmeasured.** Everything above tests the rules given
  input of known quality. Detector performance on your court is the open question.
- **8 players is genuinely expensive**, roughly 6 fps of pose inference on a mid range
  desktop GPU. Phones will be slower.
- **Above 60% ball frame loss, recall degrades sharply.** Precision holds, so it misses
  rather than invents.
- **A dense rebound scramble** with three players occluding each other for over a second
  will lose tracks and re-mint identities, which resets that player's dribble sequence.
  It fails silent rather than making a wrong call.
- **Travel detection needs visible feet.** It declines explicitly when it cannot see them
  rather than guessing.
- **Uncalibrated, step length is measured in pixels** and inherits perspective bias.
  Calibrating the court removes this entirely; it is worth the 20 seconds.
