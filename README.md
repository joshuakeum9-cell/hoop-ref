# HoopRef

A browser-based basketball referee prototype. It turns on your camera, tracks the
players' bodies and the ball, and calls **double dribble**, **carry**, and
**traveling** in real time. Everything runs on your device — no video is uploaded
anywhere, and there is no server or API key.

Single file, no build step: `index.html`.

## Put it on GitHub Pages

1. Make a new repo on GitHub, e.g. `hoop-ref`.
2. Upload `index.html` to the root of the repo (drag and drop works).
3. In the repo, go to **Settings → Pages**.
4. Under **Source**, pick **Deploy from a branch**, branch `main`, folder `/ (root)`. Save.
5. Wait a minute, then open `https://YOUR-USERNAME.github.io/hoop-ref/`.

The camera only works over **https** or on **localhost**. GitHub Pages is https, so
it works there. Double-clicking `index.html` on your desktop will *not* work — the
browser blocks camera access on `file://`.

To run it locally instead:

```bash
python -m http.server 8123 --directory hoop-ref
```

Then open `http://localhost:8123`.

## How to actually get good calls

Camera placement matters more than any setting in the app.

- **Fix the camera.** Tripod, chair, or windowsill. A handheld camera breaks the step
  counter, because the app cannot tell your movement from the player's.
- **Side-on, waist height, 6–15 feet away.** The whole body and the floor need to be in frame.
- **Bright, even light.** Backlight turns the player into a silhouette and the tracking dies.
- **Up to 8 players** (4v4 half court). Set **Players on court** to the real number —
  every extra slot costs frame rate. For a full-court 4v4, mount the camera high enough
  that all eight stay in frame; players walking out of frame and back get a new ID,
  which resets any dribble sequence they were in.

Test with a video clip first — the **Load a video clip** button runs the whole pipeline
on a file, which is much easier to iterate on than running around with a ball.

## What each rule actually does

| Call | How it is detected | How much to trust it |
|---|---|---|
| **Double dribble** | Counts floor bounces, watches for the ball being gathered into the hands, then flags a new bounce after that gather. A bounce only counts if the ball actually dipped below knee height, so jab fakes and pump fakes do not ring up phantom dribbles. | Good. This is a clean signal and the app gets it right most of the time. |
| **Carry / palming** | At the top of the dribble, checks whether the wrist was *below* the ball's center at the exact apex — the hand being under the ball. | Rough. Catches obvious carries, misses subtle ones. |
| **Traveling** | Counts foot plants while the ball is held, using ankle movement scaled to torso length. Pivot-aware: as long as one foot stays planted where the ball was gathered, the other foot can move freely — only when both feet leave their spots do excess steps become a travel. | Rough. Very sensitive to camera shake and to the feet being visible. |
| **Possible contact** | Flags when another player's hand or elbow enters the ball handler's torso area. | Off by default, and it should stay off unless you want review prompts. It is not a foul detector. |

### Accuracy engineering (why it doesn't cry wolf)

The naive version of this app calls a violation every few seconds. The current engine
gets its false-positive rate down with six mechanisms, each covered by stress tests:

- **Physics gate on ball detections.** A detection far from where the ball could have
  plausibly moved — an orange jersey, a bald head, a second ball on the sideline — is
  rejected instead of teleporting the tracked ball.
- **Least-squares velocity.** Ball velocity comes from a regression over the last ~170ms
  of raw detections, not a two-point difference, so one bad detection cannot fake a bounce.
  In stress tests the engine stays call-clean with ±15px of jitter on every input.
- **Coasting through dropouts.** When the detector loses the ball (motion blur does this
  constantly), the ball coasts on its last velocity for up to 400ms instead of freezing,
  and a held ball gets a 2.6s occlusion grace before possession state is wiped.
- **Knee-height bounce gate.** A dribble's bounce must bottom out below the knees.
- **Pivot-foot logic.** Spinning on a planted pivot foot is legal, not a travel.
- **Handler debounce.** With 8 players packed in a half court, the nearest-wrist pick
  flickers between neighbors; possession only changes after 4 consecutive frames, so a
  brush past the ball is not a change of possession.

### Tuning

- **Bounce sensitivity** — raise it if the app calls phantom dribbles, lower it if it
  misses real ones. This is the setting you will actually adjust.
- **Gather hold time** — how long the ball must sit in the hand to count as picking up
  the dribble. Lower it to call double dribbles more aggressively.
- **Steps allowed while held** — 2 is the real rule. Raise it to cut down on false travels.
- **Ball confidence** — lower it if the ball is not being picked up at all, raise it if
  random round objects get tracked.

## Tests

Open `test.html` (same folder, same server) and hit **Run tests**. It drives the rule
engine with synthetic ball and pose data — 21 checks covering the rules, the identity
tracker, and adversarial scenarios: jitter on every input, false detections across the
court, detector dropouts mid-fall, pivot moves, handler flicker between adjacent
players, players crossing paths at speed, and a player fully occluded at the crossing
point who reappears on the far side.

Multi-person detection is tuned against real in-game photos, not just synthetic data:
at MediaPipe's default detection confidence (0.4), a real game frame with ten players
yielded ONE detected person — game bodies are small, blurred, and overlapping, and they
all score low. At 0.15 the same frames yield 4-6. The junk that low threshold lets in
(spectators, tiny background figures) is removed by a size gate: a pose whose torso is
under ~4% of frame height is not on this court.

## The honest limits

This is a computer vision toy, not an officiating system.

- **Fouls cannot be detected this way.** Contact between players, from a single 2D camera,
  with no force information and constant occlusion, is an unsolved problem. The "possible
  contact" flag is a proximity trigger for human review and nothing more.
- **Ball tracking is the weak link.** The detector is a general-purpose object model with a
  `sports ball` class. It loses the ball on fast dribbles, motion blur, and when the ball is
  hidden behind the body.
- **Everything assumes a fixed camera.** Pan or shake and the step counter becomes noise.
- **It has no idea what the game situation is.** No shot clock, no possession arrow, no
  inbounds, no dead ball. It reacts to motion in the frame.

Use it for drills and self-review. Do not use it to settle an argument in a real game.

## What is under the hood

- [MediaPipe Pose Landmarker](https://ai.google.dev/edge/mediapipe/solutions/vision/pose_landmarker)
  (`tasks-vision`, GPU delegate) — 33 body landmarks per person, up to 8 people.
- A small custom tracker on top of it. MediaPipe returns people as an unordered,
  unlabeled list, so the app matches each frame's bodies to the previous frame's — by
  *predicted* position (last position plus learned per-frame velocity), which is what
  keeps identities straight when two players cross paths. A hidden player's track coasts
  along their momentum with a growing search radius, so someone screened off mid-cross is
  recognized when they reappear on the far side. Identity is what lets the rules tell a
  pass (legal) from picking up your own dribble and starting again (double dribble).
- [COCO-SSD](https://github.com/tensorflow/tfjs-models/tree/master/coco-ssd) —
  the `sports ball` class, for ball position, on TensorFlow.js / WebGL.

All three load from a CDN at runtime, so the page needs an internet connection the first
time. After that the browser caches the weights.

Thresholds are scaled by the player's torso length rather than raw pixels, so the rules
behave roughly the same whether the player is near the camera or far from it.
