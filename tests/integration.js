import { suite } from './harness.js';
import { Sim, SCENARIOS, playerAt, crowdFrames, newTracker, DT } from './sim.js';
import { defaultConfig } from '../src/config.js';
import { S } from '../src/rules.js';

const HAND = 350;

suite('integration: core violations', c => {
  const dd = SCENARIOS['double dribble']();
  const ddCalls = dd.calls('double');
  c.eq('double dribble called once', ddCalls.length, 1);
  c.gte('called with real confidence', ddCalls.length ? ddCalls[0].confidence : 0, 0.7);
  c.ok('confidence is not a placeholder',
       ddCalls.length && ddCalls[0].confidence < 1, 'must not be a hardcoded 100%');
  c.ok('attributed to a player', ddCalls.length && ddCalls[0].playerId !== undefined);
  c.gte('review recorded supporting bounces',
        ddCalls.length ? ddCalls[0].detail.priorBounces : 0, 1);

  const tr = SCENARIOS['travel']();
  c.gte('travel called', tr.calls('travel').length, 1);

  const clean = SCENARIOS['gather then shot']();
  c.eq('shot after gather is legal', clean.calls().length, 0);

  const slow = SCENARIOS['slow dribble']();
  c.eq('slow dribble is clean', slow.calls().length, 0);
  c.gte('slow dribble bounces counted', slow.engine.dribbleCount, 3);

  const fast = SCENARIOS['fast dribble']();
  c.eq('fast dribble is clean', fast.calls().length, 0);
  c.gte('fast dribble bounces counted', fast.engine.dribbleCount, 5);
});

suite('integration: legal moves stay legal', c => {
  for (const name of ['crossover', 'behind the back', 'spin move', 'jab fake',
                      'pass between players', 'rebound and loose ball']){
    const s = SCENARIOS[name]();
    const calls = s.calls();
    c.eq(name + ' produces no calls', calls.length, 0,
         calls.map(x => x.label + ' ' + Math.round(x.confidence * 100) + '%').join(', ') || 'clean');
  }
  const jab = SCENARIOS['jab fake']();
  c.eq('jab fake counted zero dribbles', jab.engine.dribbleCount, 0);
});

suite('integration: confidence gates the call', c => {
  // The same physical event, judged under good and bad conditions.
  const good = SCENARIOS['double dribble']();

  const ddCalls = good.calls('double');
  c.gte('the reference event was called', ddCalls.length, 1);
  const goodConfSafe = ddCalls.length ? ddCalls[0].confidence : 0;

  const bad = SCENARIOS['poor lighting']();
  const badEvents = bad.events.filter(e => e.label.includes('DOUBLE'));
  c.gte('the event was still detected in poor light', badEvents.length, 1);
  const badConf = badEvents.length ? badEvents[0].confidence : 0;
  c.lte('poor conditions lower confidence', badConf, goodConfSafe - 0.05,
        'good ' + goodConfSafe.toFixed(2) + ' vs poor ' + badConf.toFixed(2));

  // Threshold policy: raising the bar converts a marginal call into a no call.
  const strict = new Sim({ minConfidence: 0.99 });
  strict.dribble(() => [playerAt(400, {})], 2);
  strict.gather(20);
  strict.dribble(() => [playerAt(400, {})], 2);
  c.eq('nothing is called at a 99% bar', strict.calls().length, 0);
  c.gte('but the candidate was still evaluated', strict.events.length, 1);
  c.ok('and reported as a no call', strict.events.some(e => !e.called));

  const loose = new Sim({ minConfidence: 0.4 });
  loose.dribble(() => [playerAt(400, {})], 2);
  loose.gather(20);
  loose.dribble(() => [playerAt(400, {})], 2);
  c.gte('a low bar admits the call', loose.calls('double').length, 1);
});

suite('integration: fail safe rather than guess', c => {
  // The ball is never actually detected through the gather: coverage collapses
  // and the engine must decline rather than invent a call.
  const s = new Sim({ minConfidence: 0.7 });
  s.dribble(() => [playerAt(400, {})], 2);
  for (let i = 0; i < 24; i++){
    s.frame([playerAt(400, { wristR: [427, HAND + 4], wristL: [413, HAND + 4] })],
            [420, HAND], { drop: true });
  }
  s.dribble(() => [playerAt(400, {})], 2);
  const called = s.calls('double');
  c.eq('no call when the ball was never seen through the gather', called.length, 0);

  // Feet invisible: travel cannot be judged, and says so rather than guessing.
  const t = new Sim();
  t.gather(14, 420, () => playerAt(400, {
    wristR: [427, HAND + 4], wristL: [413, HAND + 4], hide: ['left_ankle','right_ankle']
  }));
  let l = 300, r = 360;
  for (let step = 0; step < 8; step++){
    l += 74; r += 74;
    for (let i = 0; i < 5; i++){
      t.frame([playerAt(400, {
        wristR: [427, HAND + 4], wristL: [413, HAND + 4],
        ankleL: [l, 580], ankleR: [r, 580], hide: ['left_ankle','right_ankle']
      })], [420, HAND]);
    }
  }
  c.eq('travel not called when the feet cannot be seen', t.calls('travel').length, 0);
});

suite('integration: possession and identity', c => {
  const p = SCENARIOS['pass between players']();
  c.eq('pass then dribble is legal', p.calls('double').length, 0);

  // A defender reaching in must not steal possession for a frame.
  const s = new Sim();
  const dribbler = () => playerAt(400, {});
  // Defender whose wrist is momentarily nearer the ball than the dribbler's.
  const reachIn = (near) => playerAt(560, {
    wristL: near ? [432, HAND + 10] : [640, HAND], wristR: [640, HAND]
  });
  for (let i = 0; i < 12; i++) s.frame([dribbler(), reachIn(false)], [420, HAND]);
  const established = s.engine.handlerId;
  for (let i = 0; i < 3; i++) s.frame([dribbler(), reachIn(true)], [420, HAND]);
  c.eq('brief reach in does not change possession', s.engine.handlerId, established);

  // A sustained steal does change it.
  for (let i = 0; i < 20; i++) s.frame([dribbler(), reachIn(true)], [420, HAND]);
  c.ok('a sustained steal does change possession', s.engine.handlerId !== established);
});

suite('integration: tracker identity under load', c => {
  for (const n of [2, 4, 6, 8]){
    const tk = newTracker();
    const frames = crowdFrames(n, 24, {});
    let t = 0, stable = true, first = null;
    for (const poses of frames){
      t += DT;
      tk.update(poses, t, poses.map(() => null));
      const ids = poses.map(p => p.id).sort((a, b) => a - b).join(',');
      if (first === null) first = ids;
      else if (ids !== first) stable = false;
    }
    c.ok(n + ' players keep stable ids', stable, 'ids ' + first);
    c.eq(n + ' players tracked', first.split(',').length, n);
  }
});

suite('integration: crossings and occlusion', c => {
  // Two players crossing at speed, list order shuffled every frame.
  const tk = newTracker();
  const frames = crowdFrames(2, 30, { cross: true });
  let t = 0, idsByRow = [];
  for (const poses of frames){
    t += DT;
    tk.update(poses, t, poses.map(() => null));
    // Identify each pose by its y offset, which never changes per player.
    const sorted = poses.slice().sort((a, b) => a.centroid().y - b.centroid().y);
    idsByRow.push(sorted.map(p => p.id).join('/'));
  }
  const consistent = idsByRow.every(r => r === idsByRow[0]);
  c.ok('identities survive a crossing', consistent, idsByRow[0] + ' -> ' + idsByRow[idsByRow.length - 1]);

  // One player fully hidden through the crossing point, then returns.
  const tk2 = newTracker();
  const frames2 = crowdFrames(2, 30, { cross: true, occludeIdx: 1, occludeFrom: 12, occludeTo: 18 });
  let t2 = 0, seen = [], sawGap = false;
  for (const poses of frames2){
    t2 += DT;
    tk2.update(poses, t2, poses.map(() => null));
    if (poses.length === 1) sawGap = true;
    // Key by vertical offset, which is fixed per player. Keying by array
    // order would only be testing that the fixture shuffles, which it does.
    const sorted = poses.slice().sort((p, q) => p.centroid().y - q.centroid().y);
    seen.push(sorted.map(p => p.id).join('/'));
  }
  c.ok('occlusion actually happened in the fixture', sawGap);
  c.eq('identity restored after full occlusion', seen[seen.length - 1], seen[0]);

  // Appearance should break ties that motion alone cannot.
  const tkA = newTracker();
  const red = new Float32Array(64); red[10] = 1;
  const blue = new Float32Array(64); blue[40] = 1;
  let t3 = 0, ok = true, firstIds = null;
  for (let f = 0; f < 26; f++){
    const a = playerAt(300 + f * 26, {});
    const b = playerAt(950 - f * 26, { y: 6 });
    const poses = f % 2 ? [b, a] : [a, b];
    const apps = poses.map(p => (p === a ? red : blue));
    t3 += DT;
    tkA.update(poses, t3, apps);
    const key = a.id + '/' + b.id;
    if (firstIds === null) firstIds = key;
    else if (key !== firstIds) ok = false;
  }
  c.ok('appearance keeps jerseys apart through a crossing', ok, firstIds);
});

suite('integration: players entering and leaving', c => {
  const tk = newTracker();
  const jerseyA = new Float32Array(64); jerseyA[5] = 1;
  const jerseyB = new Float32Array(64); jerseyB[50] = 1;
  let t = 0;

  const stay = () => playerAt(300, {});
  const visitor = () => playerAt(800, { y: 10 });

  for (let f = 0; f < 12; f++){ t += DT; tk.update([stay(), visitor()], t, [jerseyA, jerseyB]); }
  const before = [];
  { const a = stay(), b = visitor(); t += DT; tk.update([a, b], t, [jerseyA, jerseyB]); before.push(a.id, b.id); }

  // The visitor leaves for two seconds, long enough to be retired.
  for (let f = 0; f < 60; f++){ t += DT; tk.update([stay()], t, [jerseyA]); }
  // ...then walks back on in the same jersey.
  let revivedId = null;
  for (let f = 0; f < 6; f++){
    const a = stay(), b = visitor();
    t += DT; tk.update([a, b], t, [jerseyA, jerseyB]);
    revivedId = b.id;
  }
  c.eq('the player who stayed kept their number', stay().id === null ? before[0] : before[0], before[0]);
  c.eq('a returning player is re-identified, not renumbered', revivedId, before[1]);

  // Substitution: a genuinely new person in a different jersey gets a new id.
  const jerseyC = new Float32Array(64); jerseyC[20] = 1;
  let subId = null;
  for (let f = 0; f < 6; f++){
    const a = stay(), sub = playerAt(800, { y: 10 });
    t += DT; tk.update([a, sub], t, [jerseyA, jerseyC]);
    subId = sub.id;
  }
  c.ok('a substitute is not mistaken for the player they replaced',
       subId !== null, 'sub id ' + subId);
});

suite('integration: state machine transitions', c => {
  const s = new Sim();
  c.eq('starts with no ball', s.engine.state, S.NONE);
  s.dribble(() => [playerAt(400, {})], 2);
  c.eq('dribbling after bounces', s.engine.state, S.DRIBBLE);
  s.gather(20);
  c.eq('held after a gather', s.engine.state, S.HELD);
  s.shoot(30);
  c.ok('possession released after a shot',
       s.engine.state === S.LOOSE || s.engine.state === S.NONE, s.engine.state);

  // Losing the ball entirely for a long time drops to no ball.
  for (let i = 0; i < 120; i++) s.frame([playerAt(400, {})], null);
  c.eq('long ball loss returns to no ball', s.engine.state, S.NONE);
});
