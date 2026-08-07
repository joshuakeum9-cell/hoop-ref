import { suite } from './harness.js';
import { Ring, solveHomography, applyH, invertH, Kalman2D, cosine,
         greedyAssign, median, clamp, solveLinear } from '../src/math.js';
import { Calibration } from '../src/calibration.js';
import { scoreCall, margin, isolationScore } from '../src/confidence.js';
import { ballColorScore, appearanceHistogram, frameQuality, BallTracker } from '../src/ball.js';
import { defaultConfig, applyMode } from '../src/config.js';
import { makePose } from '../src/pose.js';
import { playerAt } from './sim.js';

suite('unit: ring buffer', c => {
  const r = new Ring(4);
  c.eq('empty length', r.length, 0);
  r.push({ t: 1 }); r.push({ t: 2 }); r.push({ t: 3 });
  c.eq('partial length', r.length, 3);
  c.eq('oldest first', r.at(0).t, 1);
  c.eq('last', r.last().t, 3);
  r.push({ t: 4 }); r.push({ t: 5 }); r.push({ t: 6 });
  c.eq('capped at capacity', r.length, 4);
  c.eq('oldest evicted', r.at(0).t, 3);
  c.eq('newest retained', r.at(3).t, 6);
  c.eq('between window', r.between(4, 6).length, 3);
  c.eq('out of range returns undefined', r.at(9), undefined);
  // The buffer is the memory safety story for long games: it must never grow.
  for (let i = 0; i < 10000; i++) r.push({ t: i });
  c.eq('bounded after 10k pushes', r.buf.length, 4);
  r.clear();
  c.eq('cleared', r.length, 0);
});

suite('unit: linear algebra', c => {
  const x = solveLinear([[2, 1], [1, 3]], [5, 10]);
  c.near('solves 2x2 a', x[0], 1, 1e-9);
  c.near('solves 2x2 b', x[1], 3, 1e-9);
  c.eq('singular returns null', solveLinear([[1, 2], [2, 4]], [1, 2]), null);
  c.eq('median odd', median([5, 1, 3]), 3);
  c.eq('median even', median([4, 1, 3, 2]), 2.5);
  c.eq('clamp', clamp(9, 0, 5), 5);
});

suite('unit: homography', c => {
  // A known perspective quad mapping to a 16 by 19 rectangle.
  const src = [{ x: 100, y: 500 }, { x: 540, y: 500 }, { x: 460, y: 300 }, { x: 180, y: 300 }];
  const H = solveHomography(src, [
    { x: 0, y: 0 }, { x: 16, y: 0 }, { x: 16, y: 19 }, { x: 0, y: 19 }
  ]);
  c.ok('solved', !!H);
  const a = applyH(H, 100, 500);
  c.near('corner 1 maps to origin x', a.x, 0, 1e-6);
  c.near('corner 1 maps to origin y', a.y, 0, 1e-6);
  const b = applyH(H, 540, 500);
  c.near('corner 2 maps to width', b.x, 16, 1e-6);
  const inv = invertH(H);
  const back = applyH(inv, 16, 19);
  c.near('inverse round trips x', back.x, 460, 1e-4);
  c.near('inverse round trips y', back.y, 300, 1e-4);
  c.eq('degenerate input rejected', solveHomography(
    [{x:0,y:0},{x:0,y:0},{x:0,y:0},{x:0,y:0}],
    [{x:0,y:0},{x:1,y:0},{x:1,y:1},{x:0,y:1}]), null);
});

suite('unit: calibration measures feet not pixels', c => {
  const cal = new Calibration();
  // Steep perspective: the far edge is much narrower on screen than the near.
  const ok = cal.setPoints([
    { x: 100, y: 560 }, { x: 620, y: 560 }, { x: 480, y: 300 }, { x: 240, y: 300 }
  ], 'key', 16, 19);
  c.ok('calibrated', ok && cal.ready);

  // Same real distance near the camera and far from it.
  const nearFt = cal.floorDistance(100, 560, 132.5, 560);   // 1 ft near edge
  const farFt  = cal.floorDistance(240, 300, 255, 300);     // 1 ft far edge
  c.near('near edge foot', nearFt, 1, 0.05);
  c.near('far edge foot', farFt, 1, 0.05);
  // The pixel distances differ hugely for the same real distance, which is
  // exactly the bias that broke step counting before calibration existed.
  c.gte('pixel scale differs by more than 1.8x across the court',
        (620 - 100) / (480 - 240), 1.8);

  const ppf = cal.pixelsPerFoot(360, 560);
  c.ok('pixels per foot near camera is larger', ppf > cal.pixelsPerFoot(360, 310));
  c.ok('in bounds inside', cal.inBounds(360, 450));
  c.ok('out of bounds far away', !cal.inBounds(360, -4000));

  const j = cal.toJSON();
  const round = Calibration.fromJSON(j);
  c.ok('serializes and restores', round.ready);
  c.near('restored measurement matches', round.floorDistance(100, 560, 132.5, 560), nearFt, 1e-6);
});

suite('unit: kalman filter', c => {
  const kf = new Kalman2D(500, 4);
  kf.init(0, 0);
  // Feed a constant velocity track and check it learns the velocity.
  for (let i = 1; i <= 20; i++){
    kf.predict(1 / 30, 0);
    kf.update(i * 10, 0);
  }
  c.near('learns vx of 300 px/s', kf.vx, 300, 45);
  c.near('tracks position', kf.x, 200, 12);

  // Gravity: a ball in free fall should have its downward velocity grow.
  const g = new Kalman2D(500, 4);
  g.init(0, 0);
  const before = g.vy;
  for (let i = 0; i < 10; i++) g.predict(1 / 30, 2000);
  c.gte('gravity accelerates vy', g.vy - before, 600);

  // Gating: a wildly distant measurement is many sigma away.
  const k2 = new Kalman2D(100, 4);
  k2.init(100, 100);
  for (let i = 0; i < 5; i++){ k2.predict(1 / 30, 0); k2.update(100, 100); }
  c.lte('nearby measurement is inside the gate', k2.gateDistance(104, 100), 6);
  c.gte('distant measurement is outside the gate', k2.gateDistance(900, 900), 6);
  c.ok('uninitialized filter is inert', new Kalman2D().gateDistance(5, 5) === 0);

  /* Stability on a stationary target. This is the property a wrong covariance
     update destroys: velocity must settle toward zero, not oscillate with a
     growing amplitude. A ball resting in a player's hands is exactly this
     case, and an oscillating estimate meant a gather was never recognised. */
  const st = new Kalman2D(20000, 9);
  st.init(400, 350);
  for (let i = 0; i < 6; i++){ st.predict(1 / 30, 0); st.update(400 + i * 30, 350); }
  const trail = [];
  for (let i = 0; i < 24; i++){ st.predict(1 / 30, 0); st.update(400, 350); trail.push(st.speed); }
  const settled = trail.slice(-8);
  c.lte('velocity settles on a stationary target', Math.max.apply(null, settled), 40,
        'final speeds ' + settled.map(v => Math.round(v)).join(', '));
  c.lte('and does not oscillate upward', settled[settled.length - 1], settled[0] + 5);
});

suite('unit: appearance and colour', c => {
  c.eq('cosine of identical vectors', cosine(new Float32Array([1, 0]), new Float32Array([1, 0])), 1);
  c.eq('cosine of orthogonal vectors', cosine(new Float32Array([1, 0]), new Float32Array([0, 1])), 0);
  c.eq('cosine of mismatched lengths', cosine(new Float32Array([1]), new Float32Array([1, 0])), 0);

  // Build a tiny image: an orange disc on a grey field.
  const W = 40, H = 40, px = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++){
    const i = (y * W + x) * 4;
    const inBall = Math.hypot(x - 20, y - 20) < 8;
    px[i]     = inBall ? 214 : 120;
    px[i + 1] = inBall ? 96  : 122;
    px[i + 2] = inBall ? 42  : 125;
    px[i + 3] = 255;
  }
  const ballish = ballColorScore(px, W, H, 20, 20, 8);
  const greyish = ballColorScore(px, W, H, 5, 5, 4);
  c.gte('orange disc scores high', ballish, 0.85);
  c.lte('grey region scores low', greyish, 0.1);
  c.eq('no pixels returns null', ballColorScore(null, W, H, 1, 1, 1), null);

  const hA = appearanceHistogram(px, W, H, { x0: 14, y0: 14, x1: 26, y1: 26 });
  const hB = appearanceHistogram(px, W, H, { x0: 0, y0: 0, x1: 9, y1: 9 });
  c.ok('histogram built', !!hA && hA.length === 64);
  c.lte('different regions are distinguishable', cosine(hA, hB), 0.85);
  c.near('histogram is L2 normalized', Math.sqrt(hA.reduce((s, v) => s + v * v, 0)), 1, 1e-4);

  const q = frameQuality(px, W, H);
  c.ok('quality reports luma', q.luma > 0 && q.luma < 1);
  c.ok('quality reports sharpness', q.sharpness >= 0);

  // A flat grey frame is the pathological blur case: no edges anywhere.
  const flat = new Uint8ClampedArray(W * H * 4).fill(120);
  const fq = frameQuality(flat, W, H);
  c.lte('flat frame reads as unsharp', fq.sharpScore, 0.1);
});

suite('unit: confidence model', c => {
  const strong = scoreCall({ coverage: 0.95, keypoints: 0.9, margin: 0.9,
                             clarity: 0.9, isolation: 0.9, stability: 0.9 });
  const weak = scoreCall({ coverage: 0.2, keypoints: 0.3, margin: 0.4,
                           clarity: 0.3, isolation: 0.4, stability: 0.3 });
  c.gte('strong evidence scores high', strong.score, 0.85);
  c.lte('weak evidence scores low', weak.score, 0.4);

  // The property that matters: one catastrophic factor must sink the score
  // even when everything else is perfect. An arithmetic mean would not.
  const blind = scoreCall({ coverage: 0.02, keypoints: 1, margin: 1,
                            clarity: 1, isolation: 1, stability: 1 });
  c.lte('never seeing the ball sinks an otherwise perfect call', blind.score, 0.45);

  c.near('margin at threshold is even', margin(10, 10), 0.5, 1e-6);
  c.gte('margin well past threshold', margin(30, 10), 0.9);
  c.lte('margin below threshold', margin(3, 10), 0.25);
  c.eq('margin with zero threshold is neutral', margin(5, 0), 0.5);

  const solo = [playerAt(400, {})];
  const crowd = [playerAt(400, {}), playerAt(460, {}), playerAt(520, {})];
  c.eq('alone is fully isolated', isolationScore(solo, solo[0], 120), 1);
  c.lte('crowded is penalised', isolationScore(crowd, crowd[0], 120), 0.75);
});

suite('unit: ball tracker gating', c => {
  const cfg = defaultConfig();
  const b = new BallTracker(cfg);
  let t = 0;
  const step = (x, y) => { t += 33; b.predictTo(t); return b.offer([{ x, y, r: 15, score: 0.8, colorOk: true }], t); };

  c.ok('first detection accepted', step(400, 300));
  for (let i = 1; i < 12; i++) step(400 + i * 12, 300);
  c.ok('tracking established', b.seen);

  t += 33; b.predictTo(t);
  const far = b.offer([{ x: 1800, y: 60, r: 15, score: 0.99, colorOk: true }], t);
  c.ok('teleporting detection rejected', !far);
  c.lte('position did not jump', Math.abs(b.x - 540), 260);

  t += 33; b.predictTo(t);
  const colored = b.offer([{ x: 560, y: 300, r: 15, score: 0.9, colorOk: false }], t);
  c.ok('wrong colour rejected even when well placed', !colored);

  // Coverage is the honest record of what was actually observed.
  const cov = b.coverage(0, t);
  c.ok('coverage between zero and one', cov > 0 && cov <= 1);

  const b2 = new BallTracker(cfg);
  let t2 = 0;
  for (let i = 0; i < 10; i++){ t2 += 33; b2.predictTo(t2); b2.offer([], t2); }
  c.eq('never seen stays unseen', b2.seen, false);
  c.eq('coverage of nothing is zero', b2.coverage(0, t2), 0);

  b.reset();
  c.eq('reset clears', b.seen, false);
});

suite('unit: pose helpers', c => {
  const p = playerAt(400, {});
  c.ok('keypoint lookup by name', !!p.kp('left_wrist'));
  c.eq('unknown keypoint is null', p.kp('tail'), null);
  c.near('torso unit is the shoulder to hip distance', p.unit(), 120, 2);
  const cen = p.centroid();
  c.near('centroid x', cen.x, 400, 2);
  const bb = p.bbox();
  c.ok('bbox spans the body', bb.h > 300);
  c.near('quality of visible joints', p.quality(['left_wrist','right_wrist']), 0.9, 0.01);

  // Low confidence joints must be invisible to the rules, but still present
  // for quality scoring, which is what lets a call be rejected for bad data.
  const hidden = playerAt(400, { hide: ['left_ankle','right_ankle'] });
  c.eq('hidden ankle not returned', hidden.kp('left_ankle'), null);
  c.lte('hidden ankle quality is low', hidden.quality(['left_ankle','right_ankle']), 0.1);

  const partial = makePose([
    { name: 'left_shoulder', x: 300, y: 200 },
    { name: 'left_hip', x: 305, y: 320 }
  ]);
  c.ok('partial torso still yields a scale', partial.unit() > 100);
});

suite('unit: assignment and config', c => {
  const m = greedyAssign([
    { a: 0, b: 0, cost: 0.9 }, { a: 0, b: 1, cost: 0.1 },
    { a: 1, b: 1, cost: 0.2 }, { a: 1, b: 0, cost: 0.5 }
  ], 1.0);
  c.eq('two pairs matched', m.length, 2);
  c.ok('cheapest pair won', m[0].a === 0 && m[0].b === 1);
  c.eq('gate excludes expensive pairs', greedyAssign([{ a: 0, b: 0, cost: 5 }], 1).length, 0);

  const cfg = applyMode(defaultConfig(), '3v3');
  c.eq('3v3 sets six players', cfg.players, 6);
  c.eq('unknown mode is ignored', applyMode(defaultConfig(), 'nope').players, 8);
});
