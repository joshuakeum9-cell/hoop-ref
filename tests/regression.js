import { suite } from './harness.js';
import { Sim, playerAt, crowdFrames, newTracker, DT } from './sim.js';

/* Regression suite.

   Every behaviour that was ever broken and then fixed gets a permanent test
   here, named after the bug. The refactor to modules rewrote all of this code,
   so these are the checks that prove the rewrite did not quietly undo earlier
   work. Each one maps to a real defect found during development. */

const HAND = 350, FLOOR = 620;

suite('regression: previously fixed defects', c => {

  // Bug: releasing from a gather back into a dribble was classified as a shot
  // by a speed test, which wiped possession one frame before the call.
  {
    const s = new Sim();
    s.dribble(() => [playerAt(400, {})], 2);
    s.gather(20);
    s.dribble(() => [playerAt(400, {})], 2);
    c.gte('gather to dribble is not mistaken for a shot', s.calls('double').length, 1);
  }

  // Bug: bounce detection required a velocity sign flip on adjacent frames,
  // but smoothing spreads a reversal over three, so zero bounces were found.
  {
    const s = new Sim();
    s.dribble(() => [playerAt(400, {})], 4);
    c.gte('reversal detection survives smoothing lag', s.engine.dribbleCount, 4);
  }

  // Bug: the carry check compared wrist to ball after the ball had already
  // fallen past the hand, so a genuine carry read as a false negative.
  {
    const s = new Sim();
    const p = () => [playerAt(400, { wristR: [424, HAND + 40] })];
    s.dribble(() => [playerAt(400, {})], 1);          // carry needs dribble context
    for (let i = 0; i < 9; i++){
      s.frame(p(), [420, FLOOR - (FLOOR - HAND) * (i / 8)]);
    }
    for (let i = 0; i < 8; i++) s.frame(p(), [420, HAND + i * 30]);
    c.gte('carry is detected at the apex, not after it', s.calls('carry').length, 1);
  }

  // Bug: a waist high jab fake counted as a dribble, which then became a
  // phantom double dribble.
  {
    const s = new Sim();
    for (let rep = 0; rep < 4; rep++){
      for (let i = 0; i < 5; i++) s.frame([playerAt(400, {})], [420, 350 + 55 * (i / 4)]);
      for (let i = 0; i < 5; i++) s.frame([playerAt(400, {})], [420, 405 - 55 * (i / 4)]);
    }
    c.eq('waist high fake counts zero dribbles', s.engine.dribbleCount, 0);
    c.eq('and produces no calls', s.calls().length, 0);
  }

  // Bug: pivoting on a planted foot was whistled as traveling.
  {
    const s = new Sim();
    // The gather must plant the same feet the pivot then uses, otherwise the
    // anchors are recorded from one stance and compared against another.
    const stance = (ar) => playerAt(400, {
      wristR: [427, HAND + 4], wristL: [413, HAND + 4],
      ankleL: [300, 580], ankleR: [ar, 580]
    });
    s.gather(12, 420, () => stance(360));
    for (let sw = 0; sw < 6; sw++){
      const ar = sw % 2 ? 360 : 460;
      for (let i = 0; i < 4; i++) s.frame([stance(ar)], [420, HAND]);
    }
    c.eq('pivoting on one foot is legal', s.calls('travel').length, 0);
    c.gte('but the steps were still counted', s.engine.heldSteps, 2);

    // ...and once the pivot foot leaves, it becomes a travel.
    for (let i = 0; i < 6; i++){
      s.frame([playerAt(400, {
        wristR: [427, HAND + 4], wristL: [413, HAND + 4],
        ankleL: [400, 580], ankleR: [470, 580]
      })], [420, HAND]);
    }
    c.gte('lifting the pivot foot converts to a travel', s.calls('travel').length, 1);
  }

  // Bug: standing still while holding the ball was called a travel.
  {
    const s = new Sim();
    s.gather(90);
    c.eq('standing with the ball is legal', s.calls('travel').length, 0);
  }

  // Bug: possession flickered between adjacent players every frame.
  {
    const s = new Sim();
    const a = () => playerAt(400, {});
    const b = () => playerAt(740, { wristL: [660, HAND], wristR: [820, HAND] });
    for (let i = 0; i < 12; i++) s.frame([a(), b()], [420, HAND]);
    const established = s.engine.handlerId;
    for (let i = 0; i < 14; i++) s.frame([a(), b()], [i % 2 ? 480 : 520, HAND]);
    c.eq('handler debounce survives proximity flicker', s.engine.handlerId, established);
  }

  // Bug: a false detection far across the court teleported the tracked ball.
  {
    const s = new Sim();
    s.dribble(() => [playerAt(400, {})], 1);
    const before = s.ball.x;
    s.ball.predictTo(s.t);
    const accepted = s.ball.offer([{ x: 1650, y: 110, r: 15, score: 0.99, colorOk: true }], s.t);
    c.ok('teleporting detection rejected', !accepted);
    c.lte('ball position unchanged', Math.abs(s.ball.x - before), 60);
  }

  // Bug: identities swapped when two players crossed paths.
  {
    const tk = newTracker();
    const frames = crowdFrames(2, 30, { cross: true });
    let t = 0, rows = [];
    for (const poses of frames){
      t += DT;
      tk.update(poses, t, poses.map(() => null));
      const sorted = poses.slice().sort((p, q) => p.centroid().y - q.centroid().y);
      rows.push(sorted.map(p => p.id).join('/'));
    }
    c.ok('identities survive a crossing', rows.every(r => r === rows[0]), rows[0]);
  }

  // Bug: a player hidden at the crossing point came back as a new person.
  {
    const tk = newTracker();
    const frames = crowdFrames(2, 30, { cross: true, occludeIdx: 1, occludeFrom: 12, occludeTo: 18 });
    let t = 0, rows = [];
    for (const poses of frames){
      t += DT;
      tk.update(poses, t, poses.map(() => null));
      const sorted = poses.slice().sort((p, q) => p.centroid().y - q.centroid().y);
      rows.push(sorted.map(p => p.id).join('/'));
    }
    c.eq('identity restored after full occlusion', rows[rows.length - 1], rows[0]);
  }

  // Bug: a pass to a teammate carried the passer's dribble history over, so
  // the receiver's first dribble was called a double dribble.
  {
    const s = new Sim();
    const a = () => playerAt(400, {});
    const b = () => playerAt(900, { wristL: [820, HAND], wristR: [980, HAND] });
    s.dribble(() => [a(), b()], 2);
    s.gather(14, 420, () => playerAt(400, { wristR: [427, HAND + 4], wristL: [413, HAND + 4] }));
    for (let i = 0; i <= 14; i++) s.frame([a(), b()], [420 + (900 - 420) * (i / 14), HAND - 30]);
    for (let cyc = 0; cyc < 2; cyc++){
      for (let i = 0; i < 9; i++) s.frame([a(), b()], [900, HAND + (FLOOR - HAND) * (i / 8)]);
      for (let i = 0; i < 9; i++) s.frame([a(), b()], [900, FLOOR - (FLOOR - HAND) * (i / 8)]);
    }
    c.eq('a pass clears the previous handler dribble state', s.calls('double').length, 0);
  }

  // Bug: rules could not be switched off.
  {
    const s = new Sim({ rules: { double: false, carry: true, travel: true, contact: false } });
    s.dribble(() => [playerAt(400, {})], 2);
    s.gather(20);
    s.dribble(() => [playerAt(400, {})], 2);
    c.eq('disabling a rule silences it', s.calls('double').length, 0);
  }

  // Bug (found during this audit): apex state was never initialized, so the
  // very first carry evaluation of a session compared against undefined.
  {
    const s = new Sim();
    c.eq('apex y starts at a sane value', s.engine.apexY, Infinity);
    c.eq('apex wrist starts null', s.engine.apexWristY, null);
    s.engine.resetSequence();
    c.eq('apex y resets to a sane value', s.engine.apexY, Infinity);
  }
});
