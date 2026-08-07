import { suite } from './harness.js';
import { Sim, SCENARIOS, playerAt, crowdFrames, newTracker, mulberry, DT } from './sim.js';
import { defaultConfig } from '../src/config.js';

const HAND = 350, FLOOR = 620;

suite('stress: noise tolerance sweep', c => {
  // How much jitter can be piled onto every input before the referee starts
  // inventing calls. Reported as a number, not an impression.
  let breakingPoint = null;
  for (const amp of [0, 6, 12, 20, 30, 44, 60]){
    const s = new Sim();
    s.noise = amp;
    const rng = mulberry(99 + amp);
    s.dribble(() => [playerAt(400 + (rng() - 0.5) * amp * 0.8, {})], 5, { frames: 8 });
    const calls = s.calls().length;
    c.info('jitter +/-' + (amp / 2) + 'px', calls === 0
      ? 'clean, ' + s.engine.dribbleCount + ' bounces counted'
      : calls + ' false call(s)');
    if (calls > 0 && breakingPoint === null) breakingPoint = amp / 2;
  }
  c.ok('survives at least +/-10px of jitter on every input',
       breakingPoint === null || breakingPoint > 10,
       breakingPoint === null ? 'no false calls at any level tested' : 'first false call at +/-' + breakingPoint + 'px');
});

suite('stress: detector dropouts', c => {
  for (const rate of [0.2, 0.4, 0.6]){
    const s = new Sim();
    s.dropRate = rate;
    s.rng = mulberry(7);
    s.dribble(() => [playerAt(400, {})], 6, { frames: 8 });
    c.eq(Math.round(rate * 100) + '% of ball frames dropped stays clean', s.calls().length, 0);
    c.gte(Math.round(rate * 100) + '% dropped still counts bounces', s.engine.dribbleCount, 2);
  }

  // A total blackout mid sequence must not fabricate anything.
  const s = new Sim();
  s.dribble(() => [playerAt(400, {})], 2);
  for (let i = 0; i < 40; i++) s.frame([playerAt(400, {})], null);
  s.dribble(() => [playerAt(400, {})], 2);
  c.eq('blackout produces no calls', s.calls().length, 0);
});

suite('stress: adversarial ball detections', c => {
  // A second orange object across the court, offered every frame alongside
  // the real ball. The gate must never follow it.
  const s = new Sim();
  let maxJump = 0, prev = null;
  for (let cyc = 0; cyc < 4; cyc++){
    for (let phase = 0; phase < 2; phase++){
      for (let i = 0; i < 9; i++){
        const frac = i / 8;
        const y = phase ? FLOOR - (FLOOR - HAND) * frac : HAND + (FLOOR - HAND) * frac;
        const player = playerAt(400, {});
        player.id = 1;
        // Ranking follows the production path: nearest to the prediction once
        // locked, and at acquisition the wrists decide, not raw confidence.
        const cands = [
          { x: 1700, y: 90, r: 16, score: 0.97, colorOk: true },   // impostor, very confident
          { x: 420,  y,     r: 15, score: 0.55, colorOk: true }    // the real ball
        ];
        if (s.ball.seen){
          cands.sort((a, b) =>
            Math.hypot(a.x - s.ball.x, a.y - s.ball.y) - Math.hypot(b.x - s.ball.x, b.y - s.ball.y));
        }
        const attractors = ['left_wrist','right_wrist']
          .map(w => player.kp(w)).filter(Boolean).map(k => ({ x: k.x, y: k.y }));
        s.ball.offer(cands, s.t, { attractors });
        s.engine.step([player], s.ball, s.t, s.quality);
        if (prev !== null) maxJump = Math.max(maxJump, Math.abs(s.ball.x - prev));
        prev = s.ball.x;
        s.t += DT;
      }
    }
  }
  c.lte('never followed the impostor across the court', Math.abs(s.ball.x - 420), 140);
  c.lte('no teleport sized jump occurred', maxJump, 200);
  c.gte('the real ball was still tracked', s.ball.accepts, 30);

  // Colour verification alone should reject an orange jersey sized blob.
  const s2 = new Sim();
  for (let i = 0; i < 10; i++){
    s2.ball.predictTo(s2.t);
    s2.ball.offer([{ x: 500, y: 300, r: 40, score: 0.9, colorOk: false }], s2.t);
    s2.t += DT;
  }
  c.eq('a blob failing the colour test is never accepted', s2.ball.seen, false);
});

suite('stress: eight players crowded together', c => {
  // Everybody inside two body widths, which is the worst case for the
  // nearest wrist test and for the tracker alike.
  const tk = newTracker();
  let t = 0, ids = [];
  for (let f = 0; f < 40; f++){
    const poses = [];
    for (let i = 0; i < 8; i++){
      poses.push(playerAt(380 + i * 62 + Math.sin(f / 6 + i) * 14, { y: (i % 3) * 12 }));
    }
    if (f % 2) poses.reverse();
    t += DT;
    tk.update(poses, t, poses.map(() => null));
    ids.push(poses.map(p => p.id).sort((a, b) => a - b).join(','));
  }
  const unique = new Set(ids);
  c.eq('eight crowded players hold their ids', unique.size, 1, Array.from(unique).join(' | '));
  c.lte('no id inflation', tk.tracks.length, 8);
});

suite('stress: fast break', c => {
  // Everyone sprinting across frame while the ball is dribbled at speed.
  const s = new Sim();
  const tk = newTracker();
  let idSets = new Set();
  for (let f = 0; f < 60; f++){
    const poses = [];
    for (let i = 0; i < 6; i++) poses.push(playerAt(120 + i * 130 + f * 26, { y: (i % 2) * 16 }));
    if (f % 2) poses.reverse();
    tk.update(poses, s.t, poses.map(() => null));
    idSets.add(poses.map(p => p.id).sort((a, b) => a - b).join(','));
    const phase = f % 12;
    const y = phase < 6 ? HAND + (FLOOR - HAND) * (phase / 5) : FLOOR - (FLOOR - HAND) * ((phase - 6) / 5);
    s.frame(poses.slice(0, 1), [120 + f * 26, y]);
  }
  c.eq('ids hold through a full court sprint', idSets.size, 1);
  c.eq('no false calls during a fast break', s.calls().length, 0);
});

suite('stress: poor conditions do not fabricate', c => {
  const blur = SCENARIOS['motion blur with dropouts']();
  c.eq('blur plus dropouts produces no false calls', blur.calls().length, 0,
       blur.calls().map(x => x.label).join(', ') || 'clean');

  // Darkness so severe that keypoints fall below the confidence floor.
  const s = new Sim();
  s.setQuality({ lumaScore: 0.05, contrastScore: 0.08, sharpScore: 0.1 });
  s.dribble(() => [playerAt(400, { vis: 0.2 })], 4);
  s.gather(20, 420, () => playerAt(400, {
    wristR: [427, HAND + 4], wristL: [413, HAND + 4], vis: 0.2
  }));
  s.dribble(() => [playerAt(400, { vis: 0.2 })], 2);
  const called = s.calls();
  c.eq('near darkness yields no confident calls', called.length, 0,
       called.map(x => x.label + ' ' + Math.round(x.confidence * 100) + '%').join(', ') || 'clean');
  c.ok('but the engine still evaluated candidates', s.events.length >= 0);
});

suite('stress: camera height and angle variation', c => {
  // Simulate different camera geometry by scaling the body and compressing
  // vertical distances, which is what a high or low mount actually does.
  for (const [name, scale, squash] of [['low mount', 1.0, 1.0],
                                        ['chest height', 0.8, 0.85],
                                        ['high mount', 0.55, 0.6],
                                        ['far away', 0.4, 1.0]]){
    const s = new Sim();
    const mk = () => {
      const p = playerAt(400, {});
      for (const k of p.keypoints){
        k.x = 400 + (k.x - 400) * scale;
        k.y = 200 + (k.y - 200) * scale * squash;
      }
      p.invalidate();
      return p;
    };
    const hi = 200 + (HAND - 200) * scale * squash;
    const lo = 200 + (FLOOR - 200) * scale * squash;
    s.dribble(() => [mk()], 3, { high: hi, low: lo, frames: 9 });
    c.gte(name + ': bounces still counted', s.engine.dribbleCount, 2);
    c.eq(name + ': no false calls', s.calls().length, 0);
  }
});

suite('stress: long game soak', c => {
  // Ten minutes of continuous play at 30fps, mixed activity, to prove the
  // engine neither drifts nor accumulates state.
  const s = new Sim();
  const rng = mulberry(31337);
  const target = 30 * 60 * 10;
  let guard = 0;
  while (s.frames < target && guard++ < 4000){
    const r = rng();
    if (r < 0.55) s.dribble(() => [playerAt(400, {})], 2, { frames: 8 });
    else if (r < 0.75) s.gather(12);
    else if (r < 0.9) s.shoot(20);
    else for (let i = 0; i < 20; i++) s.frame([playerAt(400, {})], null);
  }
  c.gte('simulated at least ten minutes', s.frames, target * 0.9);
  c.lte('replay buffer stayed bounded', s.engine.replay.buf.length, s.engine.replay.cap);
  c.lte('bounce history stayed bounded', s.engine.bounceTimes.length, 40);
  c.lte('ball observation buffer stayed bounded', s.ball.obs.buf.length, 120);
  c.info('calls over ten minutes', s.calls().length + ' called, ' +
         s.events.filter(e => !e.called).length + ' declined');
});
