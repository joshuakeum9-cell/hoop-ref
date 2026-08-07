import { clamp } from './math.js';

/* Confidence scoring.

   Every call carries a number, and the number has to mean something. The
   model here is a weighted geometric mean of independent evidence factors.
   Geometric rather than arithmetic on purpose: a referee who saw the whole
   move clearly except that the ball was never actually detected should not
   be 70% sure because everything else was fine. One factor near zero must
   drag the whole thing down, and with a product it does.

   Factors, all normalized to 0..1:
     coverage   how much of the event window was backed by real detections
     keypoints  confidence of the specific joints the rule depended on
     margin     how far past threshold the triggering signal was
     clarity    scene quality: light, contrast, focus
     isolation  freedom from crowding, since an occluded handler is a guess
     stability  how settled possession was through the event */

const WEIGHTS = {
  coverage:  0.28,
  keypoints: 0.20,
  margin:    0.22,
  clarity:   0.12,
  isolation: 0.10,
  stability: 0.08
};

export function scoreCall(factors){
  let logSum = 0, wSum = 0;
  const detail = {};
  for (const k in WEIGHTS){
    const w = WEIGHTS[k];
    // Floor at 0.02 so a single zero factor yields a very low score rather
    // than exactly zero, which would hide how the rest of the evidence looked.
    const v = clamp(factors[k] === undefined ? 0.6 : factors[k], 0.02, 1);
    detail[k] = v;
    logSum += w * Math.log(v);
    wSum += w;
  }
  const score = Math.exp(logSum / wSum);
  return { score: clamp(score, 0, 1), detail };
}

/* Signal margin: how decisively a measurement passed its threshold.
   At the threshold exactly this is 0.5, well past it approaches 1, and
   below it falls away fast. Ratio based so it is scale free. */
export function margin(value, threshold, softness = 0.6){
  if (threshold <= 0) return 0.5;
  const ratio = value / threshold;
  return clamp(1 / (1 + Math.exp(-(ratio - 1) / softness)), 0, 1);
}

/* Crowding penalty. Counts other players whose torso sits within a couple of
   body widths of the handler, since that is when limbs get confused and the
   nearest-wrist test becomes unreliable. */
export function isolationScore(poses, handlerPose, unit){
  if (!handlerPose || !poses || poses.length < 2) return 1;
  const c = handlerPose.centroid();
  if (!c) return 0.7;
  let near = 0;
  for (const p of poses){
    // Object identity first. Comparing ids alone silently treats every
    // untracked pose as the handler, because they all carry a null id.
    if (p === handlerPose) continue;
    if (p.id != null && p.id === handlerPose.id) continue;
    const o = p.centroid();
    if (!o) continue;
    const d = Math.hypot(o.x - c.x, o.y - c.y);
    if (d < unit * 2.2) near++;
  }
  return clamp(1 - near * 0.28, 0.15, 1);
}

export function clarityScore(q){
  if (!q) return 0.7;
  // The worst of the three dominates: a sharp image in the dark is still
  // unreadable, and so is a bright blurry one.
  return clamp(Math.min(
    q.lumaScore === undefined ? 0.7 : q.lumaScore,
    q.contrastScore === undefined ? 0.7 : q.contrastScore,
    q.sharpScore === undefined ? 0.7 : q.sharpScore
  ), 0.05, 1);
}

export function pct(score){ return Math.round(score * 100); }
