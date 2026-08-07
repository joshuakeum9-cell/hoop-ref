import { Kalman2D, cosine, greedyAssign, clamp } from './math.js';

/* ByteTrack-style multi-person tracker.

   Three ideas, each earning its place:

   1. Two-stage association. High quality detections are matched first and
      allowed to claim tracks; only then do low quality detections get a
      chance at whatever is left. A partially occluded player produces a
      weak detection, and the previous design either trusted it equally
      (letting it steal a neighbour's identity) or dropped it (losing the
      player). Byte's insight is that a weak detection is excellent
      evidence that *someone* is there, just poor evidence of who.

   2. Motion via Kalman. Matching on predicted position rather than last
      position is what survives a crossing, because momentum separates two
      players whose centroids momentarily coincide.

   3. Appearance. Two players in different jerseys have different torso
      colour histograms. When motion is ambiguous, which is exactly the
      crossing case, colour breaks the tie. This is the single biggest
      contributor to not swapping IDs. */

const TENTATIVE = 'tentative', CONFIRMED = 'confirmed', LOST = 'lost';

let nextId = 1;
export function resetIds(){ nextId = 1; }

class Track {
  constructor(pose, t, appearance){
    this.id = nextId++;
    this.kf = new Kalman2D(600, 16);
    const c = pose.centroid();
    this.kf.init(c.x, c.y);
    this.state = TENTATIVE;
    this.hits = 1;
    this.age = 0;
    this.missed = 0;
    this.lastT = t;
    this.unit = pose.unit() || 120;
    this.appearance = appearance || null;
    this.kps = null;               // smoothed keypoint memory
    this.confidence = 0.5;
  }
  predict(dt){
    this.kf.predict(dt, 0);
    this.age++;
  }
  /* Appearance is blended slowly. A player who turns around, or walks
     through a shadow, should shift the template gradually rather than
     letting one odd frame overwrite their identity. */
  absorbAppearance(a){
    if (!a) return;
    if (!this.appearance){ this.appearance = a.slice(); return; }
    const A = this.appearance;
    let norm = 0;
    for (let i = 0; i < A.length; i++){
      A[i] = A[i] * 0.9 + a[i] * 0.1;
      norm += A[i] * A[i];
    }
    norm = Math.sqrt(norm) || 1;
    for (let i = 0; i < A.length; i++) A[i] /= norm;
  }
}

export class PoseTracker {
  constructor(cfg){
    this.cfg = cfg;
    this.tracks = [];
    this.lastT = 0;
    // Retired tracks kept for re-identification when someone walks back in.
    this.retired = [];
  }

  reset(){
    this.tracks.length = 0;
    this.retired.length = 0;
    this.lastT = 0;
    resetIds();
  }

  /* poses: array of Pose. appearances: parallel array of Float32Array or null.
     Returns the same poses with .id assigned. */
  update(poses, t, appearances){
    const dt = this.lastT ? clamp((t - this.lastT) / 1000, 0.001, 0.5) : 1 / 30;
    this.lastT = t;

    for (const tr of this.tracks) tr.predict(dt);

    // Detection quality: how much of the body we can actually see. This is
    // the "high vs low score" split that ByteTrack keys on.
    const quality = poses.map(p => {
      const core = p.quality(['left_shoulder','right_shoulder','left_hip','right_hip']);
      return p.centroid() ? core : 0;
    });
    const strong = [], weak = [];
    poses.forEach((p, i) => {
      if (!p.centroid()) return;
      (quality[i] >= 0.5 ? strong : weak).push(i);
    });

    const assigned = new Map();      // poseIndex -> track
    const usedTracks = new Set();

    const runStage = (indices, gateScale, useAppearance) => {
      const costs = [];
      for (let ti = 0; ti < this.tracks.length; ti++){
        const tr = this.tracks[ti];
        if (usedTracks.has(ti)) continue;
        for (const pi of indices){
          if (assigned.has(pi)) continue;
          const c = poses[pi].centroid();
          const cost = this._cost(tr, poses[pi], c, appearances && appearances[pi], useAppearance);
          if (cost !== null) costs.push({ a: ti, b: pi, cost });
        }
      }
      const gate = gateScale;
      for (const m of greedyAssign(costs, gate)){
        usedTracks.add(m.a);
        assigned.set(m.b, this.tracks[m.a]);
      }
    };

    // Stage 1: confident detections, appearance in play.
    runStage(strong, 1.0, true);
    // Stage 2: weak detections recover tracks that stage 1 left unmatched.
    // Gate is tighter because a weak detection is poor identity evidence,
    // so we only accept it when motion agrees closely.
    runStage(weak, 0.65, false);

    // Commit matches.
    for (const [pi, tr] of assigned){
      const pose = poses[pi];
      const c = pose.centroid();
      tr.kf.update(c.x, c.y);
      tr.missed = 0;
      tr.hits++;
      tr.lastT = t;
      tr.unit = pose.unit() || tr.unit;
      tr.confidence = quality[pi];
      if (appearances && appearances[pi]) tr.absorbAppearance(appearances[pi]);
      if (tr.state === TENTATIVE && tr.hits >= 3) tr.state = CONFIRMED;
      if (tr.state === LOST) tr.state = CONFIRMED;
      pose.id = tr.id;
      this._smooth(pose, tr);
    }

    // Unmatched tracks age out. Coasting happens inside the Kalman predict,
    // so a hidden player keeps moving along their last known trajectory and
    // their search gate widens as uncertainty grows.
    for (let i = 0; i < this.tracks.length; i++){
      const tr = this.tracks[i];
      if (usedTracks.has(i)) continue;
      tr.missed++;
      if (tr.state === CONFIRMED && tr.missed > 5) tr.state = LOST;
    }

    // Unmatched detections: try re-identification against retired tracks
    // before minting a new player. Someone who steps out of frame and comes
    // back should get their number back, not a new one.
    for (let pi = 0; pi < poses.length; pi++){
      if (assigned.has(pi) || !poses[pi].centroid()) continue;
      const app = appearances && appearances[pi];
      const revived = this._reidentify(poses[pi], app, t);
      if (revived){
        revived.state = CONFIRMED;
        revived.missed = 0;
        revived.hits++;
        revived.lastT = t;
        const c = poses[pi].centroid();
        revived.kf.init(c.x, c.y);
        revived.absorbAppearance(app);
        poses[pi].id = revived.id;
        this.tracks.push(revived);
        this.retired.splice(this.retired.indexOf(revived), 1);
        continue;
      }
      const tr = new Track(poses[pi], t, app);
      this.tracks.push(tr);
      poses[pi].id = tr.id;
    }

    // Retire tracks that have been gone too long.
    const keep = [];
    for (const tr of this.tracks){
      if (tr.missed > 45){                       // ~1.5s at 30fps
        if (tr.state !== TENTATIVE && tr.appearance){
          tr.retiredAt = t;
          this.retired.push(tr);
        }
      } else keep.push(tr);
    }
    this.tracks = keep;
    // Bound the re-identification pool in both size and age.
    this.retired = this.retired
      .filter(r => t - r.retiredAt < 60000)
      .slice(-12);

    return poses;
  }

  /* Combined motion and appearance cost, normalized so 1.0 is the gate.
     Returns null when the candidate is outside the motion gate entirely. */
  _cost(tr, pose, c, appearance, useAppearance){
    const sigma = tr.kf.posSigma;
    // Gate grows with both filter uncertainty and how long we have been
    // guessing, but never beyond a couple of body widths.
    const radius = Math.max(tr.unit * 1.5, 70) * clamp(1 + tr.missed * 0.3, 1, 2.6)
                 + Math.min(sigma, tr.unit * 2);
    const d = Math.hypot(c.x - tr.kf.x, c.y - tr.kf.y);
    if (d > radius) return null;
    const motion = d / radius;                        // 0 good, 1 at the gate

    let appCost = 0.5;
    if (useAppearance && appearance && tr.appearance){
      const sim = cosine(appearance, tr.appearance);  // 1 identical, 0 unrelated
      appCost = 1 - clamp(sim, 0, 1);
    }
    // Motion dominates; appearance breaks ties. Weighting appearance too
    // heavily makes same-jersey teammates interchangeable, which is worse
    // than the crossing problem it solves.
    return useAppearance ? motion * 0.65 + appCost * 0.35 : motion;
  }

  _reidentify(pose, appearance, t){
    if (!appearance || !this.retired.length) return null;
    let best = null, bestSim = 0;
    for (const r of this.retired){
      if (!r.appearance) continue;
      const sim = cosine(appearance, r.appearance);
      if (sim > bestSim){ bestSim = sim; best = r; }
    }
    // Deliberately strict. A wrong revival silently attributes one player's
    // dribble history to another, which is worse than an extra player number.
    return bestSim > 0.93 ? best : null;
  }

  /* Per-player keypoint smoothing. Identity is what makes this possible:
     without a stable id there is no previous frame to blend against. */
  _smooth(pose, tr){
    const prev = tr.kps;
    if (!prev){
      tr.kps = Object.create(null);
      for (const k of pose.keypoints){
        if (k.score >= pose.minScore) tr.kps[k.name] = { x: k.x, y: k.y };
      }
      return;
    }
    for (const k of pose.keypoints){
      if (k.score < pose.minScore) continue;
      const p = prev[k.name];
      if (p){
        k.x = p.x * 0.4 + k.x * 0.6;
        k.y = p.y * 0.4 + k.y * 0.6;
        p.x = k.x; p.y = k.y;
      } else {
        prev[k.name] = { x: k.x, y: k.y };
      }
    }
    pose.invalidate();
  }

  activeCount(){ return this.tracks.filter(t => t.state !== LOST).length; }
}
