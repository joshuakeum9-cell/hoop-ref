import { suite } from './harness.js';
import { Sim, SCENARIOS, playerAt, mulberry, DT } from './sim.js';

/* Accuracy measurement.

   Precision and recall against scripted ground truth. Each scenario declares
   what should happen; the engine calls the game blind; the two are matched
   within a tolerance window because a call legitimately lands a few frames
   after the act that caused it.

   Scope, stated plainly: this measures the RULES layer given tracking data of
   a known quality. It does not measure whether MediaPipe and COCO-SSD supply
   that quality on a real court, which is a separate question that needs
   labelled real footage to answer. The report keeps the two apart rather
   than blending them into one flattering number. */

export const accuracyResults = { perRule: {}, matrix: [], conditions: {} };

const HAND = 350, FLOOR = 620;

/* Build a batch of positive and negative cases per rule, then score. */
function batch(name, makers){
  const agg = { tp: 0, fp: 0, fn: 0, cases: 0 };
  const detail = [];
  for (const mk of makers){
    const s = mk.build();
    const sc = s.score(mk.type);
    agg.tp += sc.tp; agg.fp += sc.fp; agg.fn += sc.fn; agg.cases++;
    detail.push({
      case: mk.name, tp: sc.tp, fp: sc.fp, fn: sc.fn,
      calls: s.calls().map(x => x.label + ' ' + Math.round(x.confidence * 100) + '%')
    });
  }
  agg.precision = (agg.tp + agg.fp) ? agg.tp / (agg.tp + agg.fp) : 1;
  agg.recall = (agg.tp + agg.fn) ? agg.tp / (agg.tp + agg.fn) : 1;
  agg.f1 = (agg.precision + agg.recall) ? 2 * agg.precision * agg.recall / (agg.precision + agg.recall) : 0;
  accuracyResults.perRule[name] = { summary: agg, detail };
  return agg;
}

/* Positive cases: a real double dribble under varying conditions. */
function ddPositive(label, opts){
  return {
    name: label, type: 'double',
    build(){
      const s = new Sim(opts && opts.cfg);
      if (opts && opts.quality) s.setQuality(opts.quality);
      if (opts && opts.noise) s.noise = opts.noise;
      if (opts && opts.drop) s.dropRate = opts.drop;
      s.rng = mulberry(opts && opts.seed || 5);
      const vis = (opts && opts.vis) || 0.9;
      s.dribble(() => [playerAt(400, { vis })], 2);
      s.gather(20, 420, () => playerAt(400, {
        wristR: [427, HAND + 4], wristL: [413, HAND + 4], vis
      }));
      s.expect('double');
      s.dribble(() => [playerAt(400, { vis })], 2);
      return s;
    }
  };
}

/* Negative cases: legal play that must not be called. */
function legalCase(label, scenarioName){
  return { name: label, type: 'double', build: () => SCENARIOS[scenarioName]() };
}

suite('accuracy: double dribble', c => {
  const agg = batch('double dribble', [
    ddPositive('clean conditions'),
    ddPositive('light jitter', { noise: 8, seed: 11 }),
    ddPositive('heavy jitter', { noise: 18, seed: 12 }),
    ddPositive('30% ball dropouts', { drop: 0.3, seed: 13 }),
    ddPositive('50% ball dropouts', { drop: 0.5, seed: 14 }),
    ddPositive('dim gym', { quality: { lumaScore: 0.4, contrastScore: 0.45, sharpScore: 0.6 }, vis: 0.7 }),
    legalCase('crossover', 'crossover'),
    legalCase('behind the back', 'behind the back'),
    legalCase('spin move', 'spin move'),
    legalCase('gather then shot', 'gather then shot'),
    legalCase('pass between players', 'pass between players'),
    legalCase('rebound and loose ball', 'rebound and loose ball'),
    legalCase('jab fake', 'jab fake'),
    legalCase('slow dribble', 'slow dribble'),
    legalCase('fast dribble', 'fast dribble')
  ]);
  c.gte('double dribble precision', agg.precision, 0.9,
        (agg.precision * 100).toFixed(1) + '% (' + agg.fp + ' false positives)');
  c.gte('double dribble recall', agg.recall, 0.7,
        (agg.recall * 100).toFixed(1) + '% (' + agg.fn + ' missed)');
  c.info('double dribble F1', agg.f1.toFixed(3));
});

suite('accuracy: traveling', c => {
  const walkCase = (label, steps, opts) => ({
    name: label, type: 'travel',
    build(){
      const s = new Sim();
      if (opts && opts.quality) s.setQuality(opts.quality);
      s.gather(12, 420, () => playerAt(400, { wristR: [427, HAND + 4], wristL: [413, HAND + 4] }));
      if (steps > 2) s.expect('travel');
      let l = 300, r = 360;
      for (let step = 0; step < steps; step++){
        l += 74; r += 74;
        for (let i = 0; i < 5; i++){
          s.frame([playerAt(400, {
            wristR: [427, HAND + 4], wristL: [413, HAND + 4],
            ankleL: [l, 580], ankleR: [r, 580]
          })], [420, HAND]);
        }
      }
      return s;
    }
  });
  const pivotCase = {
    name: 'pivot only', type: 'travel',
    build: () => SCENARIOS['spin move']()
  };
  const standCase = {
    name: 'standing still', type: 'travel',
    build(){ const s = new Sim(); s.gather(90); return s; }
  };

  const agg = batch('traveling', [
    walkCase('walking 6 steps', 6),
    walkCase('walking 9 steps', 9),
    walkCase('jogging 12 steps', 12),
    walkCase('legal 2 steps', 2),
    pivotCase, standCase
  ]);
  c.gte('travel precision', agg.precision, 0.85,
        (agg.precision * 100).toFixed(1) + '% (' + agg.fp + ' false positives)');
  c.gte('travel recall', agg.recall, 0.7,
        (agg.recall * 100).toFixed(1) + '% (' + agg.fn + ' missed)');
  c.info('travel F1', agg.f1.toFixed(3));
});

suite('accuracy: carry', c => {
  /* A carry happens during a dribble, so the fixture has to be a real
     dribble: down to the floor, back up to the hand, with the wrist under
     the ball at the top. Testing an isolated rise was testing a pass. */
  const carryCase = (label, underPx) => ({
    name: label, type: 'carry',
    build(){
      const s = new Sim();
      const wristY = HAND + underPx;
      const p = () => [playerAt(400, { wristR: [424, wristY] })];
      s.dribble(() => [playerAt(400, {})], 1);          // establish the dribble
      if (underPx >= 30) s.expect('carry', s.t + 400);
      for (let i = 0; i < 9; i++){
        s.frame(p(), [420, FLOOR - (FLOOR - HAND) * (i / 8)]);
      }
      for (let i = 0; i < 8; i++) s.frame(p(), [420, HAND + i * 30]);
      return s;
    }
  });
  const cleanDribble = {
    name: 'hand on top, legal', type: 'carry',
    build(){
      const s = new Sim();
      s.dribble(() => [playerAt(400, { wristR: [424, HAND - 20] })], 4);
      return s;
    }
  };

  const agg = batch('carry', [
    carryCase('hand well under the ball', 44),
    carryCase('hand clearly under', 34),
    carryCase('hand level, legal', 0),
    carryCase('hand above, legal', -22),
    cleanDribble,
    { name: 'crossover', type: 'carry', build: () => SCENARIOS['crossover']() },
    { name: 'behind the back', type: 'carry', build: () => SCENARIOS['behind the back']() }
  ]);
  c.gte('carry precision', agg.precision, 0.8,
        (agg.precision * 100).toFixed(1) + '% (' + agg.fp + ' false positives)');
  c.gte('carry recall', agg.recall, 0.6,
        (agg.recall * 100).toFixed(1) + '% (' + agg.fn + ' missed)');
  c.info('carry F1', agg.f1.toFixed(3));
});

suite('accuracy: by condition', c => {
  // The same true violation across a ladder of degrading conditions, so the
  // report can state where the system stops being trustworthy.
  const conditions = [
    ['ideal',              { quality: { lumaScore: 1, contrastScore: 1, sharpScore: 1 } }],
    ['light jitter',       { noise: 8 }],
    ['heavy jitter',       { noise: 20 }],
    ['30% dropouts',       { drop: 0.3 }],
    ['50% dropouts',       { drop: 0.5 }],
    ['70% dropouts',       { drop: 0.7 }],
    ['dim',                { quality: { lumaScore: 0.4, contrastScore: 0.45, sharpScore: 0.6 }, vis: 0.7 }],
    ['very dark',          { quality: { lumaScore: 0.12, contrastScore: 0.15, sharpScore: 0.3 }, vis: 0.35 }],
    ['heavy motion blur',  { quality: { lumaScore: 0.8, contrastScore: 0.6, sharpScore: 0.12 }, noise: 14 }]
  ];
  for (const [name, opts] of conditions){
    const s = ddPositive(name, Object.assign({ seed: 21 }, opts)).build();
    const called = s.calls('double');
    const evaluated = s.events.filter(e => e.label.includes('DOUBLE'));
    const conf = evaluated.length ? evaluated[0].confidence : 0;
    accuracyResults.conditions[name] = {
      called: called.length > 0,
      confidence: conf,
      detected: evaluated.length > 0
    };
    c.info(name, called.length
      ? 'called at ' + Math.round(conf * 100) + '% confidence'
      : (evaluated.length ? 'declined, confidence ' + Math.round(conf * 100) + '%' : 'not detected'));
  }
  // The property that matters is monotonicity: worse input, lower confidence.
  const ideal = accuracyResults.conditions['ideal'].confidence;
  const dark = accuracyResults.conditions['very dark'].confidence;
  c.lte('confidence falls as conditions degrade', dark, ideal,
        'ideal ' + Math.round(ideal * 100) + '% vs very dark ' + Math.round(dark * 100) + '%');
  c.ok('the system declines rather than guessing in the dark',
       !accuracyResults.conditions['very dark'].called);
});

suite('accuracy: roster size does not degrade calls', c => {
  // The true violation happens in the middle of a crowd of N.
  for (const n of [2, 4, 6, 8]){
    const s = new Sim();
    const others = f => {
      const out = [];
      for (let i = 1; i < n; i++) out.push(playerAt(760 + i * 130, { y: (i % 2) * 14 }));
      return out;
    };
    s.dribble(f => [playerAt(400, {})].concat(others(f)), 2);
    s.gather(20, 420, () => playerAt(400, { wristR: [427, HAND + 4], wristL: [413, HAND + 4] }));
    s.expect('double');
    s.dribble(f => [playerAt(400, {})].concat(others(f)), 2);
    const sc = s.score('double');
    accuracyResults.matrix.push({ players: n, tp: sc.tp, fp: sc.fp, fn: sc.fn });
    c.eq(n + ' players: violation still called', sc.tp, 1);
    c.eq(n + ' players: no false positives', sc.fp, 0);
  }
});
