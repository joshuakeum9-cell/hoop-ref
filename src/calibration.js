import { solveHomography, applyH, invertH } from './math.js';

/* Court calibration.

   Without this, every distance the referee measures is in pixels, and pixels
   lie. The same stride is 200px near the camera and 40px at the far end, and
   a step taken straight toward the lens is almost zero pixels wide. That last
   case was a genuine false negative source: walk at the camera holding the
   ball and the old step counter saw nothing.

   Marking four points of a known rectangle on the floor gives a homography
   from image to court plane. After that a step is measured in feet, and a
   step is a step wherever it happens. */

export const COURT_PRESETS = {
  key: {
    label: 'The key (free throw lane)',
    hint: 'Click the four corners of the painted lane: baseline left, baseline right, free throw line right, free throw line left.',
    // Width across the lane, depth from baseline to free throw line.
    width: 16, depth: 19
  },
  halfcourt: {
    label: 'Half court',
    hint: 'Click the four corners of the half court: baseline left, baseline right, half court line right, half court line left.',
    width: 50, depth: 47
  },
  custom: {
    label: 'Custom rectangle',
    hint: 'Click four corners of any rectangle on the floor, clockwise from the corner nearest the left baseline, then enter its size.',
    width: 16, depth: 19
  }
};

export class Calibration {
  constructor(){
    this.H = null;         // image -> court feet
    this.Hinv = null;      // court feet -> image
    this.preset = 'key';
    this.width = COURT_PRESETS.key.width;
    this.depth = COURT_PRESETS.key.depth;
    this.points = null;    // the four clicked image points
    this.playerHeightFt = 6.0;
  }

  get ready(){ return !!this.H; }

  /* points: four image-space {x,y} in the order the preset hint describes. */
  setPoints(points, preset = 'key', width, depth){
    if (!points || points.length !== 4) return false;
    const p = COURT_PRESETS[preset] || COURT_PRESETS.key;
    this.preset = preset;
    this.width = width || p.width;
    this.depth = depth || p.depth;
    // Court frame: origin at baseline-left, x across, y away from baseline.
    const dst = [
      { x: 0,          y: 0 },
      { x: this.width, y: 0 },
      { x: this.width, y: this.depth },
      { x: 0,          y: this.depth }
    ];
    const H = solveHomography(points, dst);
    if (!H) return false;
    this.H = H;
    this.Hinv = invertH(H);
    this.points = points.map(q => ({ x: q.x, y: q.y }));
    return true;
  }

  clear(){ this.H = this.Hinv = this.points = null; }

  /* Image pixel to court feet. Null when uncalibrated. */
  toCourt(x, y){ return this.H ? applyH(this.H, x, y) : null; }
  toImage(fx, fy){ return this.Hinv ? applyH(this.Hinv, fx, fy) : null; }

  /* Distance in feet between two image points, assuming both are on the floor.
     This is the measurement that makes step counting perspective proof. */
  floorDistance(ax, ay, bx, by){
    const A = this.toCourt(ax, ay), B = this.toCourt(bx, by);
    if (!A || !B) return null;
    return Math.hypot(A.x - B.x, A.y - B.y);
  }

  /* Local scale: how many pixels one foot spans near this image point.
     Used to convert a player's real height into a vertical pixel scale. */
  pixelsPerFoot(x, y){
    if (!this.H) return null;
    const c = this.toCourt(x, y);
    if (!c) return null;
    const a = this.toImage(c.x, c.y);
    const b = this.toImage(c.x + 1, c.y);
    if (!a || !b) return null;
    const d = Math.hypot(a.x - b.x, a.y - b.y);
    return d > 0.5 ? d : null;
  }

  /* Generous bounds test. Used only to ignore people off the playing surface,
     so the margin is wide on purpose. */
  inBounds(x, y, marginFt = 6){
    const c = this.toCourt(x, y);
    if (!c) return true;
    return c.x > -marginFt && c.x < this.width + marginFt &&
           c.y > -marginFt && c.y < this.depth + marginFt;
  }

  toJSON(){
    return this.H ? {
      points: this.points, preset: this.preset,
      width: this.width, depth: this.depth,
      playerHeightFt: this.playerHeightFt
    } : null;
  }

  static fromJSON(j){
    const c = new Calibration();
    if (j && j.points){
      c.setPoints(j.points, j.preset, j.width, j.depth);
      if (j.playerHeightFt) c.playerHeightFt = j.playerHeightFt;
    }
    return c;
  }
}

const KEY = 'hoopref.calibration.v1';

export function saveCalibration(cal){
  try {
    const j = cal.toJSON();
    if (j) localStorage.setItem(KEY, JSON.stringify(j));
    else localStorage.removeItem(KEY);
  } catch (e) { /* private mode */ }
}

export function loadCalibration(){
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? Calibration.fromJSON(JSON.parse(raw)) : new Calibration();
  } catch (e) { return new Calibration(); }
}
