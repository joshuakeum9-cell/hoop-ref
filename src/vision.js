import { appearanceHistogram, ballColorScore, frameQuality } from './ball.js';

/* One downscaled copy of the frame, shared by everything that needs pixels:
   player appearance histograms, ball colour verification, and scene quality.
   Reading pixels is the expensive part, so it happens exactly once per
   sampled frame rather than once per consumer. */

export class FrameSampler {
  constructor(width = 192){
    this.w = width;
    this.h = Math.round(width * 9 / 16);
    this.canvas = typeof OffscreenCanvas !== 'undefined'
      ? new OffscreenCanvas(this.w, this.h)
      : Object.assign(document.createElement('canvas'), { width: this.w, height: this.h });
    this.ctx = this.canvas.getContext('2d', { willReadFrequently: true });
    this.pixels = null;
    this.srcW = 0; this.srcH = 0;
    this.quality = null;
    this.lastT = 0;
  }

  /* Resize the sampling canvas to match the source aspect ratio, so that
     normalized coordinates map cleanly in both directions. */
  _fit(srcW, srcH){
    if (srcW === this.srcW && srcH === this.srcH) return;
    this.srcW = srcW; this.srcH = srcH;
    this.h = Math.max(2, Math.round(this.w * srcH / srcW));
    this.canvas.width = this.w;
    this.canvas.height = this.h;
  }

  /* source may be the video element or an already downscaled canvas. srcW and
     srcH are always the true video dimensions, because every coordinate that
     arrives here from poses and ball candidates lives in video space. */
  sample(source, t, srcW, srcH){
    const w = srcW || source.videoWidth, h = srcH || source.videoHeight;
    if (!source || !w) return false;
    this._fit(w, h);
    try {
      this.ctx.drawImage(source, 0, 0, this.w, this.h);
      this.pixels = this.ctx.getImageData(0, 0, this.w, this.h).data;
      this.quality = frameQuality(this.pixels, this.w, this.h);
      this.lastT = t;
      return true;
    } catch (e){
      // A tainted canvas (cross origin video) makes pixels unavailable.
      // Everything downstream degrades rather than failing.
      this.pixels = null;
      this.quality = null;
      return false;
    }
  }

  _scaleX(x){ return x * this.w / this.srcW; }
  _scaleY(y){ return y * this.h / this.srcH; }

  /* Torso region histogram for a pose, in source pixel coordinates. */
  appearanceFor(pose){
    if (!this.pixels) return null;
    const ls = pose.kp('left_shoulder'), rs = pose.kp('right_shoulder');
    const lh = pose.kp('left_hip'), rh = pose.kp('right_hip');
    if (!ls || !rs || !lh || !rh) return null;
    const xs = [ls.x, rs.x, lh.x, rh.x], ys = [ls.y, rs.y, lh.y, rh.y];
    // Inset slightly so the sample is jersey, not background beyond the arms.
    const x0 = this._scaleX(Math.min.apply(null, xs)), x1 = this._scaleX(Math.max.apply(null, xs));
    const y0 = this._scaleY(Math.min.apply(null, ys)), y1 = this._scaleY(Math.max.apply(null, ys));
    const ix = (x1 - x0) * 0.18, iy = (y1 - y0) * 0.12;
    return appearanceHistogram(this.pixels, this.w, this.h,
      { x0: x0 + ix, y0: y0 + iy, x1: x1 - ix, y1: y1 - iy });
  }

  /* Colour plausibility of a ball candidate, in source pixel coordinates. */
  ballScore(cx, cy, r){
    if (!this.pixels) return null;
    return ballColorScore(this.pixels, this.w, this.h,
      this._scaleX(cx), this._scaleY(cy), Math.max(1.5, this._scaleX(r)));
  }
}

/* Turn COCO-SSD output into ranked ball candidates.
   Ranking rule: once we have a lock, nearness to the predicted position beats
   raw confidence, because confidence is exactly what a large orange jersey
   blob has in abundance. */
export function ballCandidates(preds, ball, sampler, minColor = 0.35){
  const out = [];
  for (const p of preds){
    if (p.class !== 'sports ball') continue;
    const [bx, by, bw, bh] = p.bbox;
    const c = {
      x: bx + bw / 2, y: by + bh / 2,
      r: (bw + bh) / 4,
      score: p.score,
      colorOk: true, color: null
    };
    if (sampler){
      const cs = sampler.ballScore(c.x, c.y, c.r);
      if (cs !== null){
        c.color = cs;
        c.colorOk = cs >= minColor;
      }
    }
    out.push(c);
  }
  if (ball && ball.seen){
    out.sort((a, b) =>
      Math.hypot(a.x - ball.x, a.y - ball.y) - Math.hypot(b.x - ball.x, b.y - ball.y));
  } else {
    out.sort((a, b) => b.score - a.score);
  }
  return out;
}
