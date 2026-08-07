import { LANDMARKS } from './config.js';

/* A pose carries a name-indexed map alongside its keypoint array.
   The previous build looked keypoints up with Array.find on every access,
   which ran roughly 30 times per player per frame: at 8 players that is
   ~250 linear scans of a 13 element array every frame, purely to read
   values we already had. */
export class Pose {
  constructor(keypoints, minScore){
    this.keypoints = keypoints;
    this.minScore = minScore;
    this.id = null;
    this.map = Object.create(null);
    for (const k of keypoints) this.map[k.name] = k;
    this._unit = null;
    this._centroid = null;
  }
  /* Returns the keypoint only if it clears the confidence floor. */
  kp(name){
    const k = this.map[name];
    return (k && k.score >= this.minScore) ? k : null;
  }
  /* Raw access ignoring the floor, for quality metrics. */
  raw(name){ return this.map[name] || null; }

  invalidate(){ this._unit = null; this._centroid = null; }

  /* Torso length in pixels: the scale unit that makes thresholds work at any
     distance from the camera. Cached per frame. */
  unit(){
    if (this._unit !== null) return this._unit;
    const ls = this.kp('left_shoulder'), rs = this.kp('right_shoulder');
    const lh = this.kp('left_hip'), rh = this.kp('right_hip');
    let d = null;
    if (ls && rs && lh && rh){
      d = Math.hypot((ls.x + rs.x) / 2 - (lh.x + rh.x) / 2,
                     (ls.y + rs.y) / 2 - (lh.y + rh.y) / 2);
    } else {
      // Partial torso: one shoulder plus one hip still gives a usable scale.
      const s = ls || rs, h = lh || rh;
      if (s && h) d = Math.hypot(s.x - h.x, s.y - h.y);
    }
    this._unit = (d && d > 12) ? d : null;
    return this._unit;
  }

  centroid(){
    if (this._centroid !== null) return this._centroid;
    let sx = 0, sy = 0, n = 0;
    for (const nm of ['left_shoulder','right_shoulder','left_hip','right_hip']){
      const k = this.kp(nm);
      if (k){ sx += k.x; sy += k.y; n++; }
    }
    if (!n){
      for (const k of this.keypoints){
        if (k.score >= this.minScore){ sx += k.x; sy += k.y; n++; }
      }
    }
    this._centroid = n ? { x: sx / n, y: sy / n } : null;
    return this._centroid;
  }

  bbox(){
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const k of this.keypoints){
      if (k.score < this.minScore) continue;
      if (k.x < x0) x0 = k.x;
      if (k.y < y0) y0 = k.y;
      if (k.x > x1) x1 = k.x;
      if (k.y > y1) y1 = k.y;
    }
    if (x0 === Infinity) return null;
    return { x0, y0, x1, y1, w: x1 - x0, h: y1 - y0 };
  }

  /* Mean confidence of a named set, for call confidence scoring. */
  quality(names){
    let s = 0, n = 0;
    for (const nm of names){
      const k = this.raw(nm);
      if (k){ s += Math.min(k.score, 1); n++; }
    }
    return n ? s / n : 0;
  }
}

/* MediaPipe hands back 33 normalized landmarks per person. We keep the
   dozen that matter for basketball, convert to pixels, and drop anything
   too small to be a player on this court. */
export function toPoses(result, w, h, cfg){
  const out = [];
  const lists = (result && result.landmarks) || [];
  for (const lms of lists){
    if (!lms || lms.length < 29) continue;

    const sx = (lms[11].x + lms[12].x) / 2, sy = (lms[11].y + lms[12].y) / 2;
    const hx = (lms[23].x + lms[24].x) / 2, hy = (lms[23].y + lms[24].y) / 2;
    const torsoPx = Math.hypot((sx - hx) * w, (sy - hy) * h);
    // Size gate. Detection confidence runs low (0.15) so that small, blurred,
    // overlapping game bodies are found at all; this is what keeps the
    // spectators that setting lets in from entering the tracker.
    if (torsoPx / h < cfg.minTorsoFrac) continue;

    let maxVis = 0;
    for (const l of lms) if (l.visibility > maxVis) maxVis = l.visibility;
    const useVis = maxVis > 0.01;   // some builds leave visibility at zero

    const keypoints = [];
    for (const idx in LANDMARKS){
      const l = lms[idx];
      if (!l) continue;
      keypoints.push({
        name: LANDMARKS[idx],
        x: l.x * w,
        y: l.y * h,
        score: useVis ? l.visibility : 1
      });
    }
    out.push(new Pose(keypoints, cfg.minKeypointScore));
  }
  return out;
}

/* Build a Pose from plain {name,x,y,score} data. Used by the test suite and
   the gameplay simulator so they exercise the same object the app uses. */
export function makePose(keypoints, minScore = 0.3){
  return new Pose(keypoints.map(k => ({ score: 0.9, ...k })), minScore);
}
