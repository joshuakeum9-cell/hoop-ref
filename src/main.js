import { loadConfig, saveConfig, applyMode, MODES } from './config.js';
import { toPoses } from './pose.js';
import { PoseTracker } from './tracker.js';
import { BallTracker } from './ball.js';
import { RulesEngine, S } from './rules.js';
import { FrameSampler, ballCandidates } from './vision.js';
import { drawFrame, drawCalibration } from './render.js';
import { loadCalibration, saveCalibration, Calibration, COURT_PRESETS } from './calibration.js';
import { pct } from './confidence.js';

const $ = id => document.getElementById(id);

const cfg = loadConfig();
let cal = loadCalibration();

const video = $('video'), canvas = $('overlay');
const ctx = canvas.getContext('2d');

const sampler = new FrameSampler(192);
const tracker = new PoseTracker(cfg);
const ball = new BallTracker(cfg);
const engine = new RulesEngine(cfg, cal);

let landmarker = null, ballModel = null, vision = null;
let running = false, rafId = null, stream = null;
let modelBusy = false;            // guards every async model mutation
let loadPromise = null;           // dedupes concurrent load requests
let frame = 0, lastTs = -1;
let calibrating = false, calPoints = [];

/* Timebase. Wall clock is wrong for a video file: if the clip plays at half
   speed, or the tab throttles, every velocity derived from performance.now
   is wrong by that factor. Media time is the truth for a file source. */
let usingFile = false;
const now = () => (usingFile && !video.paused) ? video.currentTime * 1000 : performance.now();

/* ---------------- inference surface ----------------
   Both models read from one downscaled copy of the frame rather than from the
   full resolution video. Measured on a GTX 1660 SUPER against a 1280px frame
   with eight poses: 147ms of pose inference at native width against 105ms at
   640px, and COCO-SSD 42ms against 34ms. Roughly a 30% saving for no loss in
   people found. MediaPipe returns normalized landmarks so pose coordinates
   need no correction; COCO-SSD returns pixels, so those are scaled back into
   video space. */
const infCanvas = document.createElement('canvas');
const infCtx = infCanvas.getContext('2d', { alpha: false });
let infScale = 1;

function prepareInference(){
  const vw = video.videoWidth, vh = video.videoHeight;
  const target = cfg.inferenceWidth || 640;
  if (!vw) return null;
  if (vw <= target){ infScale = 1; return video; }
  const w = target, h = Math.round(vh * target / vw);
  if (infCanvas.width !== w){ infCanvas.width = w; infCanvas.height = h; }
  infCtx.drawImage(video, 0, 0, w, h);
  infScale = vw / w;
  return infCanvas;
}

/* ---------------- performance instrumentation ---------------- */
const perf = {
  fps: 0, frames: 0, lastT: performance.now(),
  pose: 0, ball: 0, rules: 0, draw: 0, sample: 0,
  ema(k, v){ this[k] = this[k] ? this[k] * 0.9 + v * 0.1 : v; }
};

/* ---------------- model lifecycle ---------------- */

async function ensureModels(){
  // Concurrent callers share one load. Previously two entry points could each
  // build a detector, leaking one of them permanently.
  if (loadPromise) return loadPromise;
  if (landmarker && ballModel) return Promise.resolve();
  loadPromise = (async () => {
    setStatus('loading models');
    setPlaceholder('Loading the referee', 'Downloading pose and ball models. The first run takes a few seconds, then they are cached.');
    const mod = await import('https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14');
    window.__mpPoseLandmarker = mod.PoseLandmarker;
    vision = await mod.FilesetResolver.forVisionTasks(
      'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm');
    setPlaceholder('Loading the referee', 'Loading body tracking.');
    landmarker = await buildLandmarker(cfg.players);
    setPlaceholder('Loading the referee', 'Loading ball detection.');
    ballModel = await cocoSsd.load({ base: 'lite_mobilenet_v2' });
    setStatus('ready');
  })();
  try { await loadPromise; } finally { loadPromise = null; }
}

async function buildLandmarker(numPoses){
  const PoseLandmarker = window.__mpPoseLandmarker;
  return PoseLandmarker.createFromOptions(vision, {
    baseOptions: {
      modelAssetPath: 'https://storage.googleapis.com/mediapipe-models/pose_landmarker/' +
                      'pose_landmarker_lite/float16/1/pose_landmarker_lite.task',
      delegate: 'GPU'
    },
    runningMode: 'VIDEO',
    numPoses,
    /* 0.15 rather than the usual 0.4. Measured against real game photos: at
       0.4 the detector found one person in a frame containing ten, because
       small, blurred, overlapping bodies all score low at detection time. The
       extra junk this admits is removed by the torso size gate in toPoses. */
    minPoseDetectionConfidence: 0.15,
    minPosePresenceConfidence: 0.15,
    minTrackingConfidence: 0.3
  });
}

async function setRoster(n){
  cfg.players = n;
  saveConfig(cfg);
  if (!landmarker || modelBusy) return;
  modelBusy = true;
  setStatus('resizing roster');
  try {
    const next = await buildLandmarker(n);
    const old = landmarker;
    landmarker = next;
    old.close();
    tracker.reset();
    engine.reset();
    setStatus('ready');
  } catch (e){
    setStatus('roster change failed');
  } finally {
    modelBusy = false;
  }
}

/* ---------------- main loop ---------------- */

async function loop(){
  if (!running) return;
  const t = now();
  const wall = performance.now();

  if (video.readyState >= 2 && video.videoWidth){
    if (canvas.width !== video.videoWidth){
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
    }

    const source = prepareInference() || video;

    // Pixel sampling: appearance, ball colour, scene quality. Every other
    // frame is plenty for all three and halves the getImageData cost.
    let t0 = performance.now();
    if (frame % 2 === 0) sampler.sample(source, t, video.videoWidth, video.videoHeight);
    perf.ema('sample', performance.now() - t0);

    let poses = [];
    if (!modelBusy && landmarker){
      t0 = performance.now();
      try {
        const ts = Math.max(lastTs + 1, Math.round(wall));
        lastTs = ts;
        const res = landmarker.detectForVideo(source, ts);
        // Landmarks come back normalized, so they scale straight into full
        // video space regardless of what the model was actually shown.
        poses = toPoses(res, video.videoWidth, video.videoHeight, cfg);
        const apps = poses.map(p => sampler.appearanceFor(p));
        tracker.update(poses, t, apps);
      } catch (e){ /* transient decode failure, skip this frame */ }
      perf.ema('pose', performance.now() - t0);
    }

    // Ball detection cadence adapts to headroom.
    const every = perf.fps && perf.fps < 18 ? 4 : (perf.fps && perf.fps < 26 ? 3 : 2);
    if (frame % every === 0 && ballModel){
      t0 = performance.now();
      try {
        // COCO-SSD reports pixels in whatever it was shown, so its boxes are
        // scaled back into video space before anything downstream sees them.
        const preds = await ballModel.detect(source, 10, cfg.ballConfidence);
        if (infScale !== 1){
          for (const p of preds){
            p.bbox = [p.bbox[0] * infScale, p.bbox[1] * infScale,
                      p.bbox[2] * infScale, p.bbox[3] * infScale];
          }
        }
        // Wrists are where a ball in play lives. They decide which candidate
        // wins at acquisition, when there is no motion history to gate on.
        const attractors = [];
        let reach = 320;
        for (const p of poses){
          for (const w of ['left_wrist','right_wrist']){
            const k = p.kp(w);
            if (k) attractors.push({ x: k.x, y: k.y });
          }
          const u = p.unit();
          if (u) reach = Math.max(reach, u * 3);
        }
        ball.offer(ballCandidates(preds, ball, sampler), t, { attractors, reach });
      } catch (e){ /* skip */ }
      perf.ema('ball', performance.now() - t0);
    }

    t0 = performance.now();
    const events = engine.step(poses, ball, t, sampler.quality);
    perf.ema('rules', performance.now() - t0);
    for (const ev of events) report(ev);

    t0 = performance.now();
    if (calibrating) drawCalibration(ctx, canvas, calPoints);
    else drawFrame(ctx, canvas, poses, ball, engine, cfg, cal, t);
    perf.ema('draw', performance.now() - t0);

    frame++;
  }

  perf.frames++;
  if (wall - perf.lastT > 500){
    perf.fps = perf.frames * 1000 / (wall - perf.lastT);
    perf.frames = 0; perf.lastT = wall;
    paintStats();
  }

  rafId = requestAnimationFrame(loop);
}

/* ---------------- output ---------------- */

const logEl = $('log');
let calloutTimer = null, audioCtx = null;

function report(ev){
  if (ev.type === 'nocall' || !ev.called){
    if (cfg.showNoCalls) addLog(ev, true);
    return;
  }
  showCallout(ev);
  addLog(ev, false);
  if (cfg.whistle) whistle();
}

function showCallout(ev){
  const el = $('callout');
  $('calloutText').textContent = ev.label;
  $('calloutConf').textContent = pct(ev.confidence) + '% confidence';
  el.className = 'callout show' + (ev.review ? ' review' : '');
  clearTimeout(calloutTimer);
  calloutTimer = setTimeout(() => { el.className = 'callout'; }, 2000);
}

function addLog(ev, isNoCall){
  const empty = logEl.querySelector('.empty');
  if (empty) empty.remove();
  const li = document.createElement('li');
  li.className = isNoCall ? 'nocall' : '';
  const clock = new Date().toLocaleTimeString([], { hour12: false, minute: '2-digit', second: '2-digit' });

  const time = document.createElement('span'); time.className = 't'; time.textContent = clock;
  const body = document.createElement('div'); body.className = 'body';
  const name = document.createElement('span');
  name.className = 'c ' + (isNoCall ? 'no' : ev.type);
  name.textContent = isNoCall ? ('NO CALL: ' + ev.label) : ev.label;
  body.appendChild(name);

  const meta = document.createElement('div'); meta.className = 'meta';
  if (isNoCall){
    meta.textContent = ev.reason + (ev.confidence ? ' (' + pct(ev.confidence) + '%)' : '');
  } else {
    meta.textContent = 'P' + (ev.playerId || '?') + ' · ' + pct(ev.confidence) + '% confidence';
  }
  body.appendChild(meta);

  if (!isNoCall && ev.confidence){
    const bar = document.createElement('div'); bar.className = 'bar';
    const fill = document.createElement('i');
    fill.style.width = pct(ev.confidence) + '%';
    fill.className = ev.confidence > 0.85 ? 'high' : (ev.confidence > 0.72 ? 'mid' : 'low');
    bar.appendChild(fill);
    body.appendChild(bar);
  }

  li.appendChild(time); li.appendChild(body);
  logEl.prepend(li);
  while (logEl.children.length > 80) logEl.removeChild(logEl.lastChild);
}

function whistle(){
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    const now2 = audioCtx.currentTime;
    const gain = audioCtx.createGain();
    gain.gain.setValueAtTime(0.0001, now2);
    gain.gain.exponentialRampToValueAtTime(0.22, now2 + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, now2 + 0.42);
    gain.connect(audioCtx.destination);
    [2450, 3150].forEach(f => {
      const o = audioCtx.createOscillator();
      o.type = 'sine'; o.frequency.setValueAtTime(f, now2);
      const lfo = audioCtx.createOscillator(), lg = audioCtx.createGain();
      lfo.frequency.setValueAtTime(28, now2); lg.gain.setValueAtTime(55, now2);
      lfo.connect(lg); lg.connect(o.frequency); lfo.start(now2); lfo.stop(now2 + 0.45);
      o.connect(gain); o.start(now2); o.stop(now2 + 0.45);
    });
  } catch (e) { /* blocked until a user gesture */ }
}

function paintStats(){
  $('fps').textContent = Math.round(perf.fps);
  $('sPoss').textContent = engine.state;
  $('sBall').textContent = !ball.seen ? 'not seen'
    : (ball.isCoasting(now()) ? 'predicted' : 'tracked');
  $('sPeople').textContent = tracker.activeCount();
  $('sHandler').textContent = engine.handlerId ? 'P' + engine.handlerId : 'none';
  $('sDribbles').textContent = engine.dribbleCount;
  $('sSteps').textContent = engine.heldSteps;
  $('latency').textContent =
    (perf.pose + perf.ball + perf.rules + perf.draw + perf.sample).toFixed(1) + ' ms';

  const q = sampler.quality;
  const warn = [];
  if (q){
    if (q.lumaScore < 0.35) warn.push('low light');
    if (q.sharpScore < 0.3) warn.push('motion blur');
    if (q.contrastScore < 0.3) warn.push('low contrast');
  }
  if (ball.seen && ball.isCoasting(now())) warn.push('ball predicted');
  if (!ball.seen) warn.push('no ball');
  const w = $('warnings');
  w.textContent = warn.length ? warn.join(' · ') : 'conditions good';
  w.className = 'warnings' + (warn.length ? ' bad' : '');
}

function setStatus(s){ $('modelState').textContent = s; }
function setPlaceholder(title, body){
  $('phTitle').textContent = title;
  $('phBody').textContent = body;
}
function resetPlaceholder(){
  setPlaceholder('Camera is off',
    'Start the camera, or load a video clip to test. Everything runs on your device and no video is uploaded.');
}

/* ---------------- sources ---------------- */

async function startCamera(){
  if (running || loadPromise) return;
  $('btnStart').disabled = true;
  try {
    await ensureModels();
    stream = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: 'environment' },
      audio: false
    });
    usingFile = false;
    video.srcObject = stream;
    video.removeAttribute('src');
    await video.play();
    begin();
  } catch (err){
    setStatus('error');
    resetPlaceholder();
    $('btnStart').disabled = false;
    alert('Could not start the camera.\n\n' + err.name + ': ' + err.message +
          '\n\nThe camera needs https or localhost. Opening the file directly from disk will not work.');
  }
}

async function startFile(file){
  if (loadPromise) return;
  $('btnFile').disabled = true;
  try {
    await ensureModels();
    stopStream();
    usingFile = true;
    video.srcObject = null;
    video.src = URL.createObjectURL(file);
    video.loop = true;
    await video.play();
    begin();
  } catch (err){
    alert('Could not play that file: ' + err.message);
    resetPlaceholder();
  } finally {
    $('btnFile').disabled = false;
  }
}

function begin(){
  $('placeholder').style.display = 'none';
  $('btnStop').disabled = false;
  $('btnStart').disabled = true;
  $('btnCalibrate').disabled = false;
  tracker.reset(); ball.reset(); engine.reset();
  frame = 0; lastTs = -1;
  running = true;
  loop();
}

function stopStream(){
  if (stream){ stream.getTracks().forEach(tr => tr.stop()); stream = null; }
}

function stopAll(){
  running = false;
  if (rafId) cancelAnimationFrame(rafId);
  rafId = null;
  stopStream();
  video.pause();
  video.srcObject = null;
  video.removeAttribute('src');
  video.load();
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  tracker.reset(); ball.reset(); engine.reset();
  calibrating = false;
  resetPlaceholder();
  $('placeholder').style.display = 'flex';
  $('btnStop').disabled = true;
  $('btnStart').disabled = false;
  $('btnCalibrate').disabled = true;
  paintStats();
}

/* ---------------- calibration ---------------- */

function beginCalibration(){
  if (!running) return;
  calibrating = true;
  calPoints = [];
  $('calPanel').hidden = false;
  const preset = COURT_PRESETS[$('calPreset').value];
  $('calHint').textContent = preset.hint;
  $('calStatus').textContent = 'Click corner 1 of 4';
}

function endCalibration(commit){
  if (commit && calPoints.length === 4){
    const presetKey = $('calPreset').value;
    const p = COURT_PRESETS[presetKey];
    const w = parseFloat($('calWidth').value) || p.width;
    const d = parseFloat($('calDepth').value) || p.depth;
    const next = new Calibration();
    if (next.setPoints(calPoints, presetKey, w, d)){
      cal = next;
      engine.cal = cal;
      saveCalibration(cal);
      $('calState').textContent = 'calibrated, ' + w + ' by ' + d + ' ft';
    }
  }
  calibrating = false;
  calPoints = [];
  $('calPanel').hidden = true;
}

canvas.addEventListener('click', e => {
  if (!calibrating || calPoints.length >= 4) return;
  const r = canvas.getBoundingClientRect();
  // Map the click through the letterboxed object-fit: contain layout.
  const scale = Math.min(r.width / canvas.width, r.height / canvas.height);
  const dw = canvas.width * scale, dh = canvas.height * scale;
  const ox = (r.width - dw) / 2, oy = (r.height - dh) / 2;
  const x = (e.clientX - r.left - ox) / scale;
  const y = (e.clientY - r.top - oy) / scale;
  if (x < 0 || y < 0 || x > canvas.width || y > canvas.height) return;
  calPoints.push({ x, y });
  $('calStatus').textContent = calPoints.length < 4
    ? ('Click corner ' + (calPoints.length + 1) + ' of 4')
    : 'Four corners set. Save or start over.';
  $('calSave').disabled = calPoints.length !== 4;
});

/* ---------------- wiring ---------------- */

function bindRange(id, outId, key, fmt, onChange){
  const el = $(id);
  el.value = cfg[key];
  const render = () => { $(outId).textContent = fmt(el.value); };
  el.addEventListener('input', () => {
    cfg[key] = parseFloat(el.value);
    render();
  });
  el.addEventListener('change', () => { saveConfig(cfg); if (onChange) onChange(cfg[key]); });
  render();
}

function bindCheck(id, path){
  const el = $(id);
  const [a, b] = path.split('.');
  el.checked = b ? cfg[a][b] : cfg[a];
  el.addEventListener('change', () => {
    if (b) cfg[a][b] = el.checked; else cfg[a] = el.checked;
    saveConfig(cfg);
  });
}

$('btnStart').addEventListener('click', startCamera);
$('btnStop').addEventListener('click', stopAll);
$('btnFile').addEventListener('click', () => $('fileInput').click());
$('fileInput').addEventListener('change', e => { if (e.target.files[0]) startFile(e.target.files[0]); });
$('btnFlip').addEventListener('click', () => $('stage').classList.toggle('mirror'));
$('btnClear').addEventListener('click', () => {
  logEl.innerHTML = '<li class="empty">No calls yet.</li>';
});
$('btnCalibrate').addEventListener('click', beginCalibration);
$('calSave').addEventListener('click', () => endCalibration(true));
$('calCancel').addEventListener('click', () => endCalibration(false));
$('calReset').addEventListener('click', () => {
  calPoints = [];
  $('calSave').disabled = true;
  $('calStatus').textContent = 'Click corner 1 of 4';
});
$('calClear').addEventListener('click', () => {
  cal = new Calibration();
  engine.cal = cal;
  saveCalibration(cal);
  $('calState').textContent = 'not calibrated';
});
$('calPreset').addEventListener('change', () => {
  const p = COURT_PRESETS[$('calPreset').value];
  $('calHint').textContent = p.hint;
  $('calWidth').value = p.width;
  $('calDepth').value = p.depth;
});

$('mode').value = cfg.mode;
$('mode').addEventListener('change', () => {
  applyMode(cfg, $('mode').value);
  saveConfig(cfg);
  $('kPlayers').value = cfg.players;
  $('vPlayers').textContent = cfg.players;
  setRoster(cfg.players);
});

bindRange('kPlayers', 'vPlayers', 'players', v => v, n => setRoster(parseInt(n, 10)));
bindRange('kConfidence', 'vConfidence', 'minConfidence', v => Math.round(v * 100) + '%');
bindRange('kBounce', 'vBounce', 'bounceK', v => parseFloat(v).toFixed(1));
bindRange('kHold', 'vHold', 'holdSeconds', v => parseFloat(v).toFixed(2) + ' s');
bindRange('kSteps', 'vSteps', 'stepsAllowed', v => v);
bindRange('kBallConf', 'vBallConf', 'ballConfidence', v => parseFloat(v).toFixed(2));

bindCheck('rDouble', 'rules.double');
bindCheck('rCarry', 'rules.carry');
bindCheck('rTravel', 'rules.travel');
bindCheck('rContact', 'rules.contact');
bindCheck('rWhistle', 'whistle');
bindCheck('rSkeleton', 'drawSkeleton');
bindCheck('rNoCalls', 'showNoCalls');
bindCheck('rDebug', 'drawDebug');

if (cal.ready) $('calState').textContent = 'calibrated, ' + cal.width + ' by ' + cal.depth + ' ft';
video.addEventListener('loadedmetadata', () => {
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
});
window.addEventListener('beforeunload', stopStream);
resetPlaceholder();
paintStats();

/* Exposed for the test runner and for debugging in the console. */
window.__hoopref = { cfg, cal, tracker, ball, engine, sampler, perf, S };
