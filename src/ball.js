import { Kalman2D, Ring, clamp } from './math.js';

/* Ball tracking.

   The ball is the weakest link in the whole system and always will be with a
   general purpose detector: it is small, it moves fast, it blurs, and it
   spends much of its life hidden behind a hand or a body. Four defences:

   1. A Kalman filter, so the ball has a principled position and velocity
      between detections rather than a frozen last-known point.
   2. Statistical gating on the filter innovation, so a detection that cannot
      be the ball is rejected instead of teleporting the track.
   3. Colour verification, so an orange jersey blob is not accepted as a ball.
   4. An explicit observation record, so downstream confidence scoring can ask
      "how much of this event did we actually see?" rather than assuming. */

export class BallTracker {
  constructor(cfg){
    this.cfg = cfg;
    /* High process noise on purpose. A dribbled ball is not a smooth constant
       velocity target: it reverses hard twice a second. Keeping the filter
       appropriately unsure lets it adopt a new velocity within two or three
       frames of a bounce, which is what the reversal detector needs. */
    /* High process noise and low measurement noise, both on purpose. A
       dribbled ball is not a smooth constant velocity target: it reverses
       hard twice a second, and a constant velocity model overshoots the floor
       by a large margin at every bounce. Keeping the filter unsure of its own
       prediction and trusting the detector lets it adopt the new velocity
       within a frame or two, which is what the reversal detector needs to
       fire on time rather than half a cycle late. */
    this.kf = new Kalman2D(20000, 5);
    this.r = 0;
    this.seen = false;
    this.lastRealT = 0;      // last accepted detection
    this.lastPredT = 0;
    this.missStreak = 0;
    this.obs = new Ring(120); // {t, real:boolean}
    this.gravity = 0;        // px/s^2, estimated during free flight
    this._gravSamples = [];
    this.rejects = 0;
    this.accepts = 0;
  }

  reset(){
    this.kf.reset();
    this.r = 0; this.seen = false;
    this.lastRealT = 0; this.lastPredT = 0;
    this.missStreak = 0;
    this.obs.clear();
    this.gravity = 0;
    this._gravSamples.length = 0;
    this.rejects = 0; this.accepts = 0;
  }

  get x(){ return this.kf.x; }
  get y(){ return this.kf.y; }
  get vx(){ return this.kf.vx; }
  get vy(){ return this.kf.vy; }
  get speed(){ return this.kf.speed; }

  /* Advance the filter to time t. Always call once per frame, before reading
     position, whether or not a detection arrived. */
  predictTo(t){
    if (!this.seen) return;
    const dt = (t - this.lastPredT) / 1000;
    if (dt <= 0) return;
    if (dt > 1.5){ this.lastPredT = t; return; }   // stale, do not extrapolate
    this.kf.predict(dt, this.gravity);

    /* Unmeasured coasting decays toward rest.

       Extrapolating a ball at 1000 px/s through a long detection gap sends
       the estimate flying off across the frame. That matters most in the
       single most occluded situation there is, a ball gathered in two hands,
       where the detector loses it for many frames in a row: the predicted
       ball drifted away from the hand, the gather was never recognised, and
       the double dribble that followed could not be called. Decaying toward
       rest keeps the estimate near the last place we actually saw it, which
       is the better guess once the motion evidence is stale. */
    const unmeasured = t - this.lastRealT;
    if (unmeasured > 200){
      const decay = Math.exp(-dt / 0.35);
      this.kf.vx *= decay;
      this.kf.vy *= decay;
    }
    this.lastPredT = t;
  }

  /* Offer a detection. Returns true if accepted.
     candidates: [{x,y,r,score,colorOk}] sorted by caller preference.
     opts.attractors: points the ball is likely to be near, in practice the
     players' wrists. Used only at acquisition time, see _acquire.

     Predicting here rather than relying on the caller is deliberate: a Kalman
     filter is only correct as predict then update, and making that ordering
     the caller's responsibility is a bug waiting to happen. predictTo is
     idempotent, so calling it again later in the frame costs nothing. */
  offer(cands, t, opts){
    this.predictTo(t);
    if (!cands || !cands.length){
      this.missStreak++;
      this.obs.push({ t, real: false });
      if (this.missStreak > 30) this.seen = false;
      return false;
    }

    let chosen = null;
    if (!this.seen){
      chosen = this._acquire(cands, opts);
    } else {
      /* The gate has to be physical, not statistical.

         A bounce is a genuine velocity discontinuity: the ball is falling at
         1100 px/s one frame and rising the next. No constant velocity filter
         predicts that, so the innovation at every single bounce is ten sigma
         or more. Gating on sigma therefore rejected the ball at exactly the
         moment the whole system depends on seeing it, and the filter would
         then lose lock entirely. Gating on plausible travel keeps the bounce
         and still rejects anything across the court. */
      const dt = Math.max(0.001, (t - this.lastRealT) / 1000);
      const allow = Math.max(this.r * 8, 110)
                  + (this.kf.speed + 900) * dt * 1.3
                  + Math.min(this.kf.posSigma, 80);
      for (const c of cands){
        if (c.colorOk === false) continue;           // fails the orange test
        const d = Math.hypot(c.x - this.kf.x, c.y - this.kf.y);
        // A basketball does not change apparent size abruptly.
        const sizeOk = this.r < 4 || (c.r < this.r * 2.6 && c.r > this.r * 0.35);
        if (d <= allow && sizeOk){ chosen = c; break; }
      }
    }

    if (!chosen){
      this.rejects++;
      this.missStreak++;
      this.obs.push({ t, real: false });
      /* Recovery. If we keep rejecting everything, the filter is the thing
         that is wrong, not the world. Drop the lock and re-acquire rather
         than staying confidently lost for the rest of the game. */
      if (this.missStreak > 20) this.seen = false;
      return false;
    }

    if (!this.seen){
      this.kf.init(chosen.x, chosen.y);
      this.r = chosen.r;
      this.seen = true;
      this.lastPredT = t;
    } else {
      this.kf.update(chosen.x, chosen.y);
      this.r = this.r * 0.7 + chosen.r * 0.3;
    }
    this.accepts++;
    this.missStreak = 0;
    this.lastRealT = t;
    this.obs.push({ t, real: true, x: chosen.x, y: chosen.y });
    return true;
  }

  /* Acquisition is the one moment with no physics to lean on, and therefore
     the moment a confident impostor can capture the track for good. Highest
     confidence is the wrong rule: a large orange jersey blob scores higher
     than a small blurred basketball. A ball in play is near somebody's hands,
     so when wrist positions are available they decide, and raw score is only
     the fallback. */
  _acquire(cands, opts){
    const viable = cands.filter(c => c.colorOk !== false);
    if (!viable.length) return null;
    const attractors = opts && opts.attractors;
    if (attractors && attractors.length){
      const reach = (opts && opts.reach) || 320;
      let best = null, bestD = Infinity;
      for (const c of viable){
        for (const a of attractors){
          const d = Math.hypot(c.x - a.x, c.y - a.y);
          if (d < bestD){ bestD = d; best = c; }
        }
      }
      if (best && bestD <= reach) return best;
    }
    return viable.reduce((a, b) => (b.score > a.score ? b : a), viable[0]);
  }

  /* Gravity is deliberately left at zero.

     An earlier version estimated downward acceleration from the observed
     velocity and fed it into the prediction step. It was a speculative
     addition and it actively broke possession detection: a ball resting in a
     player's hands is not in free flight, so the gravity term pushed its
     velocity estimate down every frame while the measurement pulled it back,
     settling at a steady 119 px/s instead of zero. The gather test requires a
     slow ball, so a gather was never recognised and no double dribble could
     ever be called. The process noise already absorbs real acceleration, so
     the term bought nothing and cost the headline feature. The field stays so
     a calibrated, flight-gated version can be reinstated deliberately. */

  /* Fraction of the window that was backed by a real detection rather than
     prediction. This is the honest answer to "did we actually see this?", and
     it feeds every confidence score. */
  coverage(tFrom, tTo){
    let real = 0, total = 0;
    for (let i = 0; i < this.obs.length; i++){
      const o = this.obs.at(i);
      if (!o || o.t < tFrom || o.t > tTo) continue;
      total++;
      if (o.real) real++;
    }
    return total ? real / total : 0;
  }

  /* True when the current position is a guess rather than an observation. */
  isCoasting(t){ return this.seen && (t - this.lastRealT) > 60; }

  /* How far the ball actually moved across recent real detections, in pixels.
     Null when there is not enough observed data to say.

     This exists because filtered velocity lags. Coming out of a fast dribble
     the filter still reports several hundred px/s for six or seven frames
     after the ball has physically come to rest in the hands, and a gather
     test built on filtered velocity therefore burns most of its window
     waiting for the estimate to catch up. Measured spread has no lag: if the
     ball has not moved, it has not moved. */
  spread(windowMs){
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity, n = 0;
    const newest = this.lastRealT;
    for (let i = this.obs.length - 1; i >= 0; i--){
      const o = this.obs.at(i);
      if (!o || !o.real || o.x === undefined) continue;
      if (newest - o.t > windowMs) break;
      if (o.x < minX) minX = o.x;
      if (o.x > maxX) maxX = o.x;
      if (o.y < minY) minY = o.y;
      if (o.y > maxY) maxY = o.y;
      n++;
    }
    return n >= 3 ? Math.hypot(maxX - minX, maxY - minY) : null;
  }
}

/* Colour verification.

   COCO-SSD's 'sports ball' class fires on plenty of round things, and in a
   gym the most common false positive is a person: a head, a shoulder, an
   orange jersey. A basketball is strongly and consistently orange-brown. We
   sample the detection region from a downscaled frame and ask whether enough
   of it sits in that hue band. This is cheap and rejects most impostors.

   Returns a score 0..1, or null when pixels are unavailable. */
export function ballColorScore(pixels, W, H, cx, cy, r){
  if (!pixels) return null;
  const x0 = Math.max(0, Math.round(cx - r)), x1 = Math.min(W - 1, Math.round(cx + r));
  const y0 = Math.max(0, Math.round(cy - r)), y1 = Math.min(H - 1, Math.round(cy + r));
  if (x1 <= x0 || y1 <= y0) return null;
  let hit = 0, total = 0;
  const r2 = r * r;
  for (let y = y0; y <= y1; y++){
    for (let x = x0; x <= x1; x++){
      const dx = x - cx, dy = y - cy;
      if (dx * dx + dy * dy > r2) continue;
      const i = (y * W + x) * 4;
      const R = pixels[i], G = pixels[i + 1], B = pixels[i + 2];
      total++;
      const max = Math.max(R, G, B), min = Math.min(R, G, B);
      if (max < 40) continue;                         // too dark to judge
      const sat = (max - min) / max;
      // Basketball: red channel dominant, green in the middle, blue lowest.
      if (R === max && R > B * 1.35 && G >= B && sat > 0.25) hit++;
    }
  }
  return total > 8 ? hit / total : null;
}

/* Torso colour histogram for player appearance. 4x4x4 RGB bins, L2 normalized. */
export function appearanceHistogram(pixels, W, H, box){
  if (!pixels || !box) return null;
  const x0 = Math.max(0, Math.round(box.x0)), x1 = Math.min(W - 1, Math.round(box.x1));
  const y0 = Math.max(0, Math.round(box.y0)), y1 = Math.min(H - 1, Math.round(box.y1));
  if (x1 <= x0 || y1 <= y0) return null;
  const hist = new Float32Array(64);
  let n = 0;
  for (let y = y0; y <= y1; y++){
    for (let x = x0; x <= x1; x++){
      const i = (y * W + x) * 4;
      const R = pixels[i] >> 6, G = pixels[i + 1] >> 6, B = pixels[i + 2] >> 6;
      hist[(R << 4) | (G << 2) | B]++;
      n++;
    }
  }
  if (n < 12) return null;
  let norm = 0;
  for (let i = 0; i < 64; i++) norm += hist[i] * hist[i];
  norm = Math.sqrt(norm) || 1;
  for (let i = 0; i < 64; i++) hist[i] /= norm;
  return hist;
}

/* Scene quality from a downscaled frame: how dark, how flat, how blurred.
   These drive both the user facing warnings and the confidence penalties,
   so a call made in a dim gym is correctly reported as less certain. */
export function frameQuality(pixels, W, H){
  if (!pixels) return { luma: 0.5, contrast: 0.5, sharpness: 0.5, ok: true };
  let sum = 0, sum2 = 0, n = 0;
  const lum = new Float32Array(W * H);
  for (let i = 0, p = 0; i < pixels.length; i += 4, p++){
    const l = (pixels[i] * 0.299 + pixels[i + 1] * 0.587 + pixels[i + 2] * 0.114) / 255;
    lum[p] = l; sum += l; sum2 += l * l; n++;
  }
  const mean = sum / n;
  const variance = Math.max(0, sum2 / n - mean * mean);

  // Laplacian variance: the standard cheap sharpness proxy. Low means blur.
  let lsum = 0, lsum2 = 0, ln = 0;
  for (let y = 1; y < H - 1; y++){
    for (let x = 1; x < W - 1; x++){
      const p = y * W + x;
      const v = 4 * lum[p] - lum[p - 1] - lum[p + 1] - lum[p - W] - lum[p + W];
      lsum += v; lsum2 += v * v; ln++;
    }
  }
  const lmean = ln ? lsum / ln : 0;
  const lvar = ln ? Math.max(0, lsum2 / ln - lmean * lmean) : 0;

  return {
    luma: mean,
    contrast: Math.sqrt(variance),
    sharpness: lvar,
    // Normalized 0..1 usability scores.
    lumaScore: clamp((mean - 0.06) / 0.22, 0, 1),
    contrastScore: clamp(Math.sqrt(variance) / 0.16, 0, 1),
    sharpScore: clamp(lvar / 0.0016, 0, 1)
  };
}
