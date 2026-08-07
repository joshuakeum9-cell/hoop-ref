import { makePose } from '../src/pose.js';
import { defaultConfig } from '../src/config.js';
import { BallTracker } from '../src/ball.js';
import { RulesEngine } from '../src/rules.js';
import { PoseTracker, resetIds } from '../src/tracker.js';

/* Synthetic gameplay simulator.

   This is the measurement instrument for accuracy. It generates physically
   plausible player and ball motion where the ground truth is known by
   construction, injects the failure modes that real footage suffers from,
   and lets the engine call the game. Comparing calls against the script
   gives real precision and recall numbers instead of impressions.

   What it does prove: the rules layer behaves correctly given tracking data
   of a stated quality. What it cannot prove: that MediaPipe and COCO-SSD
   deliver that quality on your gym floor. Those are separate questions and
   the report keeps them separate. */

export const DT = 1000 / 30;
const FLOOR = 620, HAND = 350, UNIT = 120;

/* A player rendered as keypoints. x is the hip centre, all else hangs off it. */
export function playerAt(x, opts){
  const o = Object.assign({
    wristR: null, wristL: null, ankleL: null, ankleR: null,
    y: 0, vis: 0.9, hide: null
  }, opts || {});
  const k = (name, kx, ky, score) => ({ name, x: kx, y: ky + o.y, score: score === undefined ? o.vis : score });
  const kps = [
    k('nose',            x,        150),
    k('left_shoulder',   x - 40,   200),
    k('right_shoulder',  x + 40,   200),
    k('left_elbow',      x - 62,   270),
    k('right_elbow',     x + 62,   270),
    k('left_hip',        x - 30,   320),
    k('right_hip',       x + 30,   320),
    k('left_knee',       x - 32,   450),
    k('right_knee',      x + 32,   450),
    k('left_wrist',  o.wristL ? o.wristL[0] : x - 80, o.wristL ? o.wristL[1] : HAND),
    k('right_wrist', o.wristR ? o.wristR[0] : x + 80, o.wristR ? o.wristR[1] : HAND),
    k('left_ankle',  o.ankleL ? o.ankleL[0] : x - 30, o.ankleL ? o.ankleL[1] : 580),
    k('right_ankle', o.ankleR ? o.ankleR[0] : x + 30, o.ankleR ? o.ankleR[1] : 580)
  ];
  if (o.hide) for (const kp of kps) if (o.hide.includes(kp.name)) kp.score = 0.05;
  return makePose(kps, 0.3);
}

/* A run of the engine over a scripted sequence.
   Handles noise, dropouts, occlusion and lighting as first class knobs so
   every difficult condition in the brief is reproducible. */
export class Sim {
  constructor(overrides){
    this.cfg = Object.assign(defaultConfig(), overrides || {});
    this.cfg.rules = Object.assign(defaultConfig().rules, (overrides && overrides.rules) || {});
    this.ball = new BallTracker(this.cfg);
    this.engine = new RulesEngine(this.cfg);
    this.t = 100000;
    this.events = [];
    this.truth = [];
    this.quality = { lumaScore: 1, contrastScore: 1, sharpScore: 1 };
    this.rng = mulberry(12345);
    this.noise = 0;
    this.dropRate = 0;
    this.frames = 0;
  }

  setQuality(q){ this.quality = Object.assign({ lumaScore:1, contrastScore:1, sharpScore:1 }, q); }
  expect(type, at){ this.truth.push({ type, t: at === undefined ? this.t : at }); }

  /* One frame. ballPos null means the ball is not detected this frame.

     Fixtures rebuild their poses every frame, so ids are assigned by position
     in the array. Real runs get ids from the tracker instead. Without ids the
     possession logic cannot tell two players apart, which is the whole point
     of it. */
  frame(poses, ballPos, opts){
    const o = opts || {};
    for (let i = 0; i < poses.length; i++){
      if (poses[i].id == null) poses[i].id = i + 1;
    }
    const attractors = [];
    for (const p of poses){
      for (const w of ['left_wrist','right_wrist']){
        const k = p.kp(w);
        if (k) attractors.push({ x: k.x, y: k.y });
      }
    }
    const drop = o.drop !== undefined ? o.drop : (this.rng() < this.dropRate);
    if (ballPos && !drop){
      const n = this.noise;
      this.ball.offer([{
        x: ballPos[0] + (this.rng() - 0.5) * n,
        y: ballPos[1] + (this.rng() - 0.5) * n,
        r: ballPos[2] || 15,
        score: 0.7, colorOk: true
      }], this.t, { attractors });
    } else {
      this.ball.offer([], this.t, { attractors });
    }
    const evs = this.engine.step(poses, this.ball, this.t, this.quality);
    for (const e of evs) this.events.push(e);
    this.t += DT;
    this.frames++;
    return evs;
  }

  /* One complete dribble cycle: hand to floor and back. */
  dribble(poseFn, cycles, opts){
    const o = Object.assign({ frames: 9, low: FLOOR, high: HAND, x: 420 }, opts || {});
    for (let c = 0; c < (cycles || 1); c++){
      for (let i = 0; i < o.frames; i++){
        const y = o.high + (o.low - o.high) * (i / (o.frames - 1));
        this.frame(poseFn(i, 'down'), [o.x, y]);
      }
      for (let i = 0; i < o.frames; i++){
        const y = o.low - (o.low - o.high) * (i / (o.frames - 1));
        this.frame(poseFn(i, 'up'), [o.x, y]);
      }
    }
  }

  /* Ball pinned in both hands. */
  gather(frames, x, poseFn){
    const bx = x === undefined ? 420 : x;
    for (let i = 0; i < (frames || 20); i++){
      const p = poseFn ? poseFn(i) : playerAt(bx - 20, {
        wristR: [bx + 7, HAND + 4], wristL: [bx - 7, HAND + 4]
      });
      this.frame([p], [bx, HAND]);
    }
  }

  /* Ball leaves toward the rim. */
  shoot(frames, x, poseFn){
    const bx = x === undefined ? 420 : x;
    for (let i = 0; i < (frames || 26); i++){
      const p = poseFn ? poseFn(i) : playerAt(bx - 20, {});
      this.frame([p], [bx + i * 24, HAND - i * 11]);
    }
  }

  calls(type){
    return this.events.filter(e => e.called && (!type || e.type === type));
  }
  noCalls(type){
    return this.events.filter(e => !e.called && (!type || e.label.toLowerCase().includes(type)));
  }
  /* Precision and recall against the declared ground truth, matched within
     a tolerance window since a call lands a few frames after the act. */
  score(type, toleranceMs){
    const tol = toleranceMs || 1500;
    const want = this.truth.filter(x => x.type === type);
    const got = this.calls(type);
    const usedG = new Set(), usedW = new Set();
    let tp = 0;
    want.forEach((w, wi) => {
      for (let gi = 0; gi < got.length; gi++){
        if (usedG.has(gi)) continue;
        if (Math.abs(got[gi].t - w.t) <= tol){ usedG.add(gi); usedW.add(wi); tp++; return; }
      }
    });
    const fp = got.length - tp;
    const fn = want.length - tp;
    return {
      tp, fp, fn,
      precision: (tp + fp) ? tp / (tp + fp) : 1,
      recall: (tp + fn) ? tp / (tp + fn) : 1
    };
  }
}

/* Deterministic PRNG so every run of the suite is reproducible. */
export function mulberry(seed){
  let a = seed >>> 0;
  return function(){
    a |= 0; a = a + 0x6D2B79F5 | 0;
    let tt = Math.imul(a ^ a >>> 15, 1 | a);
    tt = tt + Math.imul(tt ^ tt >>> 7, 61 | tt) ^ tt;
    return ((tt ^ tt >>> 14) >>> 0) / 4294967296;
  };
}

/* Named scenarios. Each returns a Sim that has already run, with truth
   declared, so tests and the accuracy report share one definition. */
export const SCENARIOS = {

  'slow dribble': () => {
    const s = new Sim();
    s.dribble(() => [playerAt(400, {})], 4, { frames: 14 });
    return s;
  },

  'fast dribble': () => {
    const s = new Sim();
    s.dribble(() => [playerAt(400, {})], 6, { frames: 6 });
    return s;
  },

  'double dribble': () => {
    const s = new Sim();
    s.dribble(() => [playerAt(400, {})], 2);
    s.gather(20);
    s.expect('double');
    s.dribble(() => [playerAt(400, {})], 2);
    return s;
  },

  'gather then shot': () => {
    const s = new Sim();
    s.dribble(() => [playerAt(400, {})], 2);
    s.gather(20);
    s.shoot(26);
    return s;
  },

  'crossover': () => {
    // Ball alternates sides between bounces, hands swap. Legal.
    const s = new Sim();
    for (let c = 0; c < 4; c++){
      const x = c % 2 ? 340 : 480;
      s.dribble(() => [playerAt(400, { wristR: [x + 30, HAND], wristL: [x - 30, HAND] })],
                1, { x });
    }
    return s;
  },

  'behind the back': () => {
    // Ball passes behind the hips between bounces. Legal, and the hand is
    // beside the ball rather than under it.
    const s = new Sim();
    for (let c = 0; c < 3; c++){
      const x = c % 2 ? 350 : 470;
      s.dribble((i, phase) => [playerAt(400, {
        wristR: [x + 34, HAND + (phase === 'up' ? 6 : 0)],
        wristL: [x - 34, HAND]
      })], 1, { x });
    }
    return s;
  },

  'spin move': () => {
    // Held ball, one foot pinned as the pivot, body rotating. Legal.
    // The gather must plant the same feet the spin then pivots on, otherwise
    // the anchors are recorded from a different stance than they are judged against.
    const s = new Sim();
    const stance = (swing) => playerAt(400, {
      wristR: [427, HAND + 4], wristL: [413, HAND + 4],
      ankleL: [300, 580], ankleR: [swing, 580]
    });
    s.dribble(() => [playerAt(400, {})], 1);
    s.gather(12, 420, () => stance(360));
    for (let step = 0; step < 8; step++){
      const swing = 360 + (step % 2 ? 0 : 96);
      for (let i = 0; i < 4; i++) s.frame([stance(swing)], [420, HAND]);
    }
    return s;
  },

  'travel': () => {
    const s = new Sim();
    s.gather(12);
    s.expect('travel');
    let l = 300, r = 360;
    for (let step = 0; step < 9; step++){
      l += 74; r += 74;
      for (let i = 0; i < 5; i++){
        s.frame([playerAt(400, {
          wristR: [427, HAND + 4], wristL: [413, HAND + 4],
          ankleL: [l, 580], ankleR: [r, 580]
        })], [420, HAND]);
      }
    }
    return s;
  },

  'jab fake': () => {
    // Waist high ball movement. Not a dribble, must not become one.
    const s = new Sim();
    for (let rep = 0; rep < 4; rep++){
      for (let i = 0; i < 5; i++) s.frame([playerAt(400, {})], [420, 350 + 55 * (i / 4)]);
      for (let i = 0; i < 5; i++) s.frame([playerAt(400, {})], [420, 405 - 55 * (i / 4)]);
    }
    return s;
  },

  'pass between players': () => {
    const s = new Sim();
    const a = () => playerAt(400, {});
    const b = () => playerAt(900, { wristR: [980, HAND], wristL: [820, HAND] });
    s.dribble(() => [a(), b()], 2);
    s.gather(14, 420, () => playerAt(400, { wristR: [427, HAND + 4], wristL: [413, HAND + 4] }));
    // Ball travels across to the second player.
    for (let i = 0; i <= 14; i++){
      s.frame([a(), b()], [420 + (900 - 420) * (i / 14), HAND - 30]);
    }
    // Second player dribbles: legal, they never dribbled before.
    for (let c = 0; c < 2; c++){
      for (let i = 0; i < 9; i++){
        const y = HAND + (FLOOR - HAND) * (i / 8);
        s.frame([a(), b()], [900, y]);
      }
      for (let i = 0; i < 9; i++){
        const y = FLOOR - (FLOOR - HAND) * (i / 8);
        s.frame([a(), b()], [900, y]);
      }
    }
    return s;
  },

  'rebound and loose ball': () => {
    // Ball bounces free with nobody near it, then a player collects it.
    const s = new Sim();
    const crowd = () => [playerAt(300, {}), playerAt(560, {}), playerAt(820, {})];
    for (let i = 0; i < 12; i++) s.frame(crowd(), [500 + i * 18, 200 + i * 30]);
    for (let i = 0; i < 10; i++) s.frame(crowd(), [716 + i * 16, 620 - i * 34]);
    for (let i = 0; i < 14; i++){
      s.frame([playerAt(820, { wristR: [880, HAND], wristL: [780, HAND] })], [860, HAND]);
    }
    return s;
  },

  'poor lighting': () => {
    const s = new Sim();
    s.setQuality({ lumaScore: 0.18, contrastScore: 0.22, sharpScore: 0.3 });
    s.noise = 14;
    s.dribble(() => [playerAt(400, { vis: 0.45 })], 2);
    s.gather(20, 420, () => playerAt(400, {
      wristR: [427, HAND + 4], wristL: [413, HAND + 4], vis: 0.45
    }));
    s.expect('double');
    s.dribble(() => [playerAt(400, { vis: 0.45 })], 2);
    return s;
  },

  'motion blur with dropouts': () => {
    const s = new Sim();
    s.setQuality({ lumaScore: 0.8, contrastScore: 0.7, sharpScore: 0.22 });
    s.dropRate = 0.35;
    s.noise = 10;
    s.dribble(() => [playerAt(400, {})], 3, { frames: 7 });
    return s;
  }
};

/* Multi player scenes for tracker tests. n players walking, optionally
   crossing, optionally occluded. */
export function crowdFrames(n, frames, opts){
  const o = Object.assign({ cross: false, occludeIdx: -1, occludeFrom: 0, occludeTo: 0 }, opts || {});
  const out = [];
  for (let f = 0; f < frames; f++){
    const poses = [];
    for (let i = 0; i < n; i++){
      const dir = (o.cross && i % 2) ? -1 : 1;
      const base = o.cross ? (i % 2 ? 1200 - i * 40 : 200 + i * 40) : 200 + i * 150;
      const x = base + dir * f * 22;
      if (i === o.occludeIdx && f >= o.occludeFrom && f <= o.occludeTo) continue;
      poses.push(playerAt(x, { y: (i % 2) * 18 }));
    }
    // Shuffle so list order can never be what preserves identity.
    if (f % 2) poses.reverse();
    out.push(poses);
  }
  return out;
}

export function newTracker(cfg){
  resetIds();
  return new PoseTracker(cfg || defaultConfig());
}
