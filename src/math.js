/* Small numeric toolkit. No DOM, no globals, fully unit testable. */

export const clamp = (v, lo, hi) => v < lo ? lo : (v > hi ? hi : v);
export const lerp  = (a, b, t) => a + (b - a) * t;

export function median(arr){
  if (!arr.length) return 0;
  const s = Array.prototype.slice.call(arr).sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/* Fixed-capacity ring buffer. The replay system holds several seconds of
   per-frame state, so it must never grow without bound and must never
   allocate in the hot path once warm. */
export class Ring {
  constructor(capacity){
    this.cap = capacity;
    this.buf = new Array(capacity);
    this.n = 0;          // total pushes ever
  }
  push(v){ this.buf[this.n % this.cap] = v; this.n++; return v; }
  get length(){ return Math.min(this.n, this.cap); }
  /* 0 = oldest retained entry. */
  at(i){
    const len = this.length;
    if (i < 0 || i >= len) return undefined;
    const start = this.n <= this.cap ? 0 : this.n % this.cap;
    return this.buf[(start + i) % this.cap];
  }
  last(){ return this.n ? this.buf[(this.n - 1) % this.cap] : undefined; }
  clear(){ this.n = 0; this.buf.fill(undefined); }
  /* Entries with .t within [tFrom, tTo], oldest first. Allocates one array;
     only called when a violation is under review, not every frame. */
  between(tFrom, tTo){
    const out = [];
    for (let i = 0; i < this.length; i++){
      const e = this.at(i);
      if (e && e.t >= tFrom && e.t <= tTo) out.push(e);
    }
    return out;
  }
}

/* Solve A x = b by Gauss-Jordan with partial pivoting. n is small (8). */
export function solveLinear(A, b){
  const n = b.length;
  const M = A.map((row, i) => row.slice().concat([b[i]]));
  for (let col = 0; col < n; col++){
    let piv = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(M[r][col]) > Math.abs(M[piv][col])) piv = r;
    if (Math.abs(M[piv][col]) < 1e-12) return null;      // singular
    const tmp = M[col]; M[col] = M[piv]; M[piv] = tmp;
    const d = M[col][col];
    for (let c = col; c <= n; c++) M[col][c] /= d;
    for (let r = 0; r < n; r++){
      if (r === col) continue;
      const f = M[r][col];
      if (!f) continue;
      for (let c = col; c <= n; c++) M[r][c] -= f * M[col][c];
    }
  }
  return M.map(row => row[n]);
}

/* Homography mapping four image points to four world points.
   src and dst are [{x,y} x4]. Returns a 9-element row-major matrix.

   This is what turns pixel measurements into court measurements. A step
   counted in pixels is meaningless: the same stride is 200px near the
   camera and 40px at the far end, and a step straight toward the lens is
   nearly zero pixels. On the floor plane a step is always a step. */
export function solveHomography(src, dst){
  if (!src || !dst || src.length !== 4 || dst.length !== 4) return null;
  const A = [], b = [];
  for (let i = 0; i < 4; i++){
    const { x, y } = src[i], { x: X, y: Y } = dst[i];
    A.push([x, y, 1, 0, 0, 0, -x * X, -y * X]); b.push(X);
    A.push([0, 0, 0, x, y, 1, -x * Y, -y * Y]); b.push(Y);
  }
  const h = solveLinear(A, b);
  if (!h) return null;
  return [h[0], h[1], h[2], h[3], h[4], h[5], h[6], h[7], 1];
}

export function applyH(H, x, y){
  const d = H[6] * x + H[7] * y + H[8];
  if (Math.abs(d) < 1e-12) return null;
  return { x: (H[0] * x + H[1] * y + H[2]) / d, y: (H[3] * x + H[4] * y + H[5]) / d };
}

export function invertH(H){
  const [a,b,c,d,e,f,g,h,i] = H;
  const A =  (e*i - f*h), B = -(b*i - c*h), C =  (b*f - c*e);
  const D = -(d*i - f*g), E =  (a*i - c*g), F = -(a*f - c*d);
  const G =  (d*h - e*g), Hh= -(a*h - b*g), I =  (a*e - b*d);
  const det = a*A + b*D + c*G;
  if (Math.abs(det) < 1e-12) return null;
  return [A/det, B/det, C/det, D/det, E/det, F/det, G/det, Hh/det, I/det];
}

/* Constant-velocity Kalman filter with an optional known downward
   acceleration. Replaces the previous least-squares fit: the fit had no
   notion of uncertainty, so it treated a lone noisy detection exactly like
   a confident one, and it could not produce a principled prediction while
   the ball was unobserved. */
export class Kalman2D {
  /* q: process noise (px/s^2 of unmodelled accel). r: measurement noise (px). */
  constructor(q = 900, r = 9){
    this.q = q; this.r = r;
    this.reset();
  }
  reset(){
    this.x = 0; this.y = 0; this.vx = 0; this.vy = 0;
    // Covariance, block-diagonal per axis: [[pp, pv], [pv, vv]]
    this.px = { pp: 1e4, pv: 0, vv: 1e4 };
    this.py = { pp: 1e4, pv: 0, vv: 1e4 };
    this.initialized = false;
  }
  init(x, y){
    this.reset();
    this.x = x; this.y = y;
    this.px.pp = this.py.pp = 25;
    this.px.vv = this.py.vv = 1e4;
    this.initialized = true;
  }
  _predictAxis(P, dt){
    const { pp, pv, vv } = P;
    const q = this.q;
    // F = [[1, dt], [0, 1]]
    const npp = pp + 2 * dt * pv + dt * dt * vv + q * dt * dt * dt * dt / 4;
    const npv = pv + dt * vv + q * dt * dt * dt / 2;
    const nvv = vv + q * dt * dt;
    P.pp = npp; P.pv = npv; P.vv = nvv;
  }
  /* gravity in px/s^2, applied to the y axis only. */
  predict(dt, gravity = 0){
    if (!this.initialized || dt <= 0) return;
    this.x += this.vx * dt;
    this.y += this.vy * dt + 0.5 * gravity * dt * dt;
    this.vy += gravity * dt;
    this._predictAxis(this.px, dt);
    this._predictAxis(this.py, dt);
  }
  _updateAxis(P, pos, vel, z){
    const s = P.pp + this.r;
    const kp = P.pp / s, kv = P.pv / s;
    const innov = z - pos;
    const nPos = pos + kp * innov;
    const nVel = vel + kv * innov;
    /* Covariance update is P <- (I - K H) P. Every term on the right uses the
       PRIOR covariance, so the old values must be captured before any of them
       is overwritten. Feeding the already-updated pv into the vv line leaves
       vv too large, which keeps the velocity gain too high, and the velocity
       estimate then oscillates instead of settling: on a stationary ball it
       ran -53, +36, +110, +205 and kept climbing. */
    const ppOld = P.pp, pvOld = P.pv;
    P.pp = (1 - kp) * ppOld;
    P.pv = (1 - kp) * pvOld;
    P.vv = P.vv - kv * pvOld;
    if (P.vv < 1e-6) P.vv = 1e-6;
    return [nPos, nVel];
  }
  update(zx, zy){
    if (!this.initialized){ this.init(zx, zy); return; }
    const [nx, nvx] = this._updateAxis(this.px, this.x, this.vx, zx);
    const [ny, nvy] = this._updateAxis(this.py, this.y, this.vy, zy);
    this.x = nx; this.vx = nvx; this.y = ny; this.vy = nvy;
  }
  /* Normalized innovation distance, for gating. Unitless: how many sigma
     away a candidate measurement is, given current uncertainty. */
  gateDistance(zx, zy){
    if (!this.initialized) return 0;
    const sx = Math.sqrt(this.px.pp + this.r);
    const sy = Math.sqrt(this.py.pp + this.r);
    return Math.hypot((zx - this.x) / sx, (zy - this.y) / sy);
  }
  get speed(){ return Math.hypot(this.vx, this.vy); }
  /* Position uncertainty in pixels, used to widen search when unsure. */
  get posSigma(){ return Math.sqrt(Math.max(this.px.pp, this.py.pp)); }
}

/* Cosine similarity for appearance histograms. Both are assumed L2 normalized. */
export function cosine(a, b){
  if (!a || !b || a.length !== b.length) return 0;
  let d = 0;
  for (let i = 0; i < a.length; i++) d += a[i] * b[i];
  return d;
}

/* Rectangular assignment, greedy on globally sorted cost. Hungarian would be
   optimal but with at most 8 tracks the difference is not measurable, and
   greedy-on-sorted has no pathological cases at this size. */
export function greedyAssign(costs, maxCost){
  const pairs = [];
  for (const c of costs) if (c.cost <= maxCost) pairs.push(c);
  pairs.sort((a, b) => a.cost - b.cost);
  const usedA = new Set(), usedB = new Set(), out = [];
  for (const p of pairs){
    if (usedA.has(p.a) || usedB.has(p.b)) continue;
    usedA.add(p.a); usedB.add(p.b);
    out.push(p);
  }
  return out;
}
