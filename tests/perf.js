import { suite } from './harness.js';
import { Sim, playerAt, crowdFrames, newTracker, DT } from './sim.js';
import { defaultConfig } from '../src/config.js';
import { BallTracker } from '../src/ball.js';
import { RulesEngine } from '../src/rules.js';
import { frameQuality, appearanceHistogram } from '../src/ball.js';

/* Performance and memory.

   A note on what a browser can and cannot measure, because the difference
   matters for reading these numbers honestly:

     FPS and latency        measurable, and measured here
     JS heap size           Chromium only, via performance.memory
     CPU utilisation        NOT exposed to JavaScript by any browser
     GPU utilisation        NOT exposed to JavaScript by any browser

   There is no API that reports process CPU or GPU load to a web page, for
   fingerprinting reasons. Anything claiming otherwise is estimating. So the
   honest proxy is main thread time per stage: if the frame budget at 30fps is
   33ms and the pipeline uses 20ms, the main thread is roughly 60% committed.
   That is what these benchmarks report, alongside the GPU renderer string so
   the hardware behind a result is at least identifiable. */

export const benchResults = { stages: {}, env: {}, memory: null, throughput: {} };

function bench(fn, iterations, warmup){
  for (let i = 0; i < (warmup || 5); i++) fn();
  const t0 = performance.now();
  for (let i = 0; i < iterations; i++) fn();
  const total = performance.now() - t0;
  return { total, per: total / iterations };
}

suite('performance: environment', c => {
  const env = benchResults.env;
  env.userAgent = navigator.userAgent;
  env.cores = navigator.hardwareConcurrency || 'unknown';
  env.memoryGB = navigator.deviceMemory || 'unknown';
  env.pixelRatio = window.devicePixelRatio;

  try {
    const cvs = document.createElement('canvas');
    const gl = cvs.getContext('webgl2') || cvs.getContext('webgl');
    if (gl){
      const dbg = gl.getExtension('WEBGL_debug_renderer_info');
      env.gpu = dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : 'masked by browser';
      env.glVersion = gl.getParameter(gl.VERSION);
    } else env.gpu = 'no webgl';
  } catch (e){ env.gpu = 'unavailable'; }

  env.heapApi = !!(performance && performance.memory);
  c.info('cpu cores reported', env.cores);
  c.info('gpu renderer', env.gpu);
  c.info('heap measurement available', env.heapApi ? 'yes, Chromium performance.memory' : 'no, not this browser');
  c.info('cpu and gpu utilisation', 'not exposed to JavaScript by any browser, main thread time used as the proxy');
  c.ok('environment captured', true);
});

suite('performance: per stage cost', c => {
  const cfg = defaultConfig();

  // Rules engine throughput, the part we fully control.
  for (const n of [1, 2, 4, 6, 8]){
    const engine = new RulesEngine(cfg);
    const ball = new BallTracker(cfg);
    const poses = [];
    for (let i = 0; i < n; i++) poses.push(playerAt(300 + i * 140, {}));
    let t = 0;
    const r = bench(() => {
      t += DT;
      ball.predictTo(t);
      ball.offer([{ x: 420, y: 400 + Math.sin(t / 100) * 200, r: 15, score: 0.8, colorOk: true }], t);
      engine.step(poses, ball, t, { lumaScore: 1, contrastScore: 1, sharpScore: 1 });
    }, 3000);
    benchResults.stages['rules ' + n + ' players'] = r.per;
    c.lte('rules engine with ' + n + ' players under 0.5ms/frame', r.per, 0.5,
          r.per.toFixed(4) + ' ms per frame');
  }

  // Tracker throughput, the other pure JS stage.
  for (const n of [2, 4, 8]){
    const tk = newTracker(cfg);
    const frames = crowdFrames(n, 60, {});
    let i = 0, t = 0;
    const r = bench(() => {
      t += DT;
      tk.update(frames[i++ % frames.length].map(p => p), t, null);
    }, 2000);
    benchResults.stages['tracker ' + n + ' players'] = r.per;
    c.lte('tracker with ' + n + ' players under 0.4ms/frame', r.per, 0.4,
          r.per.toFixed(4) + ' ms per frame');
  }

  // Pixel work: the frame quality pass and one appearance histogram.
  const W = 192, H = 108;
  const px = new Uint8ClampedArray(W * H * 4);
  for (let i = 0; i < px.length; i++) px[i] = (i * 37) & 255;
  const q = bench(() => frameQuality(px, W, H), 300);
  benchResults.stages['frame quality 192x108'] = q.per;
  c.lte('frame quality pass under 3ms', q.per, 3, q.per.toFixed(3) + ' ms');

  const a = bench(() => appearanceHistogram(px, W, H, { x0: 40, y0: 30, x1: 70, y1: 70 }), 2000);
  benchResults.stages['appearance histogram'] = a.per;
  c.lte('appearance histogram under 0.5ms', a.per, 0.5, a.per.toFixed(4) + ' ms');

  const jsTotal = benchResults.stages['rules 8 players'] +
                  benchResults.stages['tracker 8 players'] +
                  benchResults.stages['frame quality 192x108'] / 2 +
                  benchResults.stages['appearance histogram'] * 8;
  benchResults.stages['our js total, 8 players'] = jsTotal;
  c.lte('all of our own per frame work fits in 6ms at 8 players', jsTotal, 6,
        jsTotal.toFixed(3) + ' ms, leaving the rest of the 33ms budget to the models');
  c.info('frame budget at 30fps', '33.3 ms');
  c.info('our share of that budget', (jsTotal / 33.3 * 100).toFixed(1) + '%');
});

suite('performance: sustained throughput', c => {
  // How many simulated frames per second the whole non model pipeline can do.
  const s = new Sim();
  const t0 = performance.now();
  let frames = 0;
  while (performance.now() - t0 < 700){
    s.dribble(() => [playerAt(400, {}), playerAt(560, {}), playerAt(720, {})], 1, { frames: 8 });
    frames += 16;
  }
  const elapsed = performance.now() - t0;
  const fps = frames / (elapsed / 1000);
  benchResults.throughput.simulatedFps = fps;
  c.gte('pipeline sustains well above realtime headless', fps, 2000,
        Math.round(fps) + ' simulated frames per second');
  c.info('headroom versus 30fps', (fps / 30).toFixed(0) + 'x');
});

suite('performance: memory over a long game', c => {
  const hasHeap = !!(performance && performance.memory);
  const readHeap = () => hasHeap ? performance.memory.usedJSHeapSize : 0;

  const s = new Sim();
  // Warm up so lazily allocated structures exist before the first reading.
  for (let i = 0; i < 600; i++) s.frame([playerAt(400, {})], [420, 400]);

  const before = readHeap();
  const beforeReplay = s.engine.replay.buf.length;
  const beforeObs = s.ball.obs.buf.length;

  // Twenty simulated minutes of continuous play.
  const target = 30 * 60 * 20;
  let guard = 0;
  while (s.frames < target && guard++ < 200000){
    s.frame([playerAt(400 + (s.frames % 40), {}), playerAt(700, {})],
            (s.frames % 7) ? [420, 350 + (s.frames % 240)] : null);
  }
  const after = readHeap();

  c.gte('simulated twenty minutes of play', s.frames, target * 0.95);
  c.eq('replay buffer did not grow', s.engine.replay.buf.length, beforeReplay);
  c.eq('ball observation buffer did not grow', s.ball.obs.buf.length, beforeObs);
  c.lte('bounce history bounded', s.engine.bounceTimes.length, 40);
  c.lte('event list is the only unbounded structure and it is caller owned',
        s.engine.replay.cap, 600);

  if (hasHeap){
    const growthMB = (after - before) / 1048576;
    benchResults.memory = {
      beforeMB: before / 1048576, afterMB: after / 1048576,
      growthMB, frames: s.frames
    };
    c.info('heap before', (before / 1048576).toFixed(1) + ' MB');
    c.info('heap after ' + s.frames + ' frames', (after / 1048576).toFixed(1) + ' MB');
    // The simulator itself retains every event for scoring, so some growth is
    // expected and is the test fixture, not the engine.
    c.lte('heap growth over twenty minutes stays modest', growthMB, 60,
          growthMB.toFixed(1) + ' MB including the test fixture retaining all events');
  } else {
    c.info('heap measurement', 'unavailable in this browser, buffer bounds checked structurally instead');
  }

  // Tracker must not accumulate retired identities forever either.
  const tk = newTracker();
  let t = 0;
  for (let cycle = 0; cycle < 40; cycle++){
    for (let f = 0; f < 20; f++){
      t += DT;
      tk.update([playerAt(300 + cycle * 3, {})], t, [new Float32Array(64).fill(0.125)]);
    }
    for (let f = 0; f < 60; f++){ t += DT; tk.update([], t, []); }
  }
  c.lte('retired identity pool is bounded', tk.retired.length, 12,
        tk.retired.length + ' retained after 40 enter and leave cycles');
  c.lte('active track list is bounded', tk.tracks.length, 8);
});
