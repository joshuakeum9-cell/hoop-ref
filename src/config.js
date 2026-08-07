/* Single source of truth for every tunable. The rules engine receives this
   object as an argument and never touches the DOM, which is what makes it
   testable headlessly and keeps ~10 getElementById calls out of the hot path. */

export const LANDMARKS = {
  0:'nose',
  11:'left_shoulder', 12:'right_shoulder',
  13:'left_elbow',    14:'right_elbow',
  15:'left_wrist',    16:'right_wrist',
  23:'left_hip',      24:'right_hip',
  25:'left_knee',     26:'right_knee',
  27:'left_ankle',    28:'right_ankle'
};

export const SKELETON = [
  ['left_shoulder','right_shoulder'],['left_shoulder','left_elbow'],['left_elbow','left_wrist'],
  ['right_shoulder','right_elbow'],['right_elbow','right_wrist'],['left_shoulder','left_hip'],
  ['right_shoulder','right_hip'],['left_hip','right_hip'],['left_hip','left_knee'],
  ['left_knee','left_ankle'],['right_hip','right_knee'],['right_knee','right_ankle']
];

export function defaultConfig(){
  return {
    // Roster
    players: 8,
    mode: '4v4',

    // Rules on or off
    rules: { double: true, carry: true, travel: true, contact: false },

    // Decision policy
    minConfidence: 0.70,     // below this a candidate becomes NO CALL
    showNoCalls: true,       // log rejected candidates so the user sees the near miss

    // Detection thresholds, all scaled by player torso length unless noted
    bounceK: 2.0,            // px/s per torso unit for a fall to arm a bounce
    holdSeconds: 0.35,       // dwell before a gather counts as possession
    stepsAllowed: 2,         // legal steps while held
    ballConfidence: 0.30,    // COCO-SSD score floor

    // Timing constants
    armMs: 260,              // window between arming and firing a reversal
    minBounceGapMs: 180,     // debounce for consecutive bounces
    handlerSwitchFrames: 4,  // frames a new handler must hold before possession moves
    heldGraceMs: 2600,       // ball may be unseen this long while held
    looseGraceMs: 1200,      // ...and this long otherwise
    replaySeconds: 8,        // ring buffer depth for review

    // Quality gates
    minKeypointScore: 0.3,
    minTorsoFrac: 0.04,      // torso as fraction of frame height, drops spectators

    // Performance
    targetFps: 30,
    adaptiveQuality: true,
    inferenceWidth: 0,       // 0 = native; otherwise downscale before inference

    // Output
    whistle: true,
    drawSkeleton: true,
    drawDebug: false
  };
}

/* Half-court presets. These change more than the roster number: fewer bodies
   means less crowding, so possession can switch faster without flickering. */
export const MODES = {
  '3v3': { players: 6, handlerSwitchFrames: 4 },
  '4v4': { players: 8, handlerSwitchFrames: 5 },
  '1v1': { players: 2, handlerSwitchFrames: 3 },
  '2v2': { players: 4, handlerSwitchFrames: 3 }
};

export function applyMode(cfg, mode){
  const m = MODES[mode];
  if (!m) return cfg;
  cfg.mode = mode;
  cfg.players = m.players;
  cfg.handlerSwitchFrames = m.handlerSwitchFrames;
  return cfg;
}

const STORE_KEY = 'hoopref.config.v2';

export function saveConfig(cfg){
  try { localStorage.setItem(STORE_KEY, JSON.stringify(cfg)); } catch (e) { /* private mode */ }
}

export function loadConfig(){
  const base = defaultConfig();
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return base;
    const saved = JSON.parse(raw);
    // Merge shallowly, then patch nested objects, so a config saved by an
    // older build never removes keys this build depends on.
    const out = Object.assign(base, saved);
    out.rules = Object.assign(defaultConfig().rules, saved.rules || {});
    return out;
  } catch (e) { return base; }
}
