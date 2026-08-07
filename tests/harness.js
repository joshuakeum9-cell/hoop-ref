/* Minimal test harness. No dependencies, runs in the browser, reports to
   both the DOM and a machine readable object the runner can serialize. */

export const suites = [];

export function suite(name, fn){ suites.push({ name, fn, results: [] }); }

export class Ctx {
  constructor(suiteRec){ this.rec = suiteRec; }
  _push(name, pass, detail){
    this.rec.results.push({ name, pass, detail: detail === undefined ? '' : String(detail) });
    return pass;
  }
  ok(name, cond, detail){ return this._push(name, !!cond, detail); }
  eq(name, actual, expected, detail){
    const pass = actual === expected;
    return this._push(name, pass, detail !== undefined ? detail : ('got ' + fmt(actual) + ', want ' + fmt(expected)));
  }
  near(name, actual, expected, tol, detail){
    const pass = Math.abs(actual - expected) <= tol;
    return this._push(name, pass, detail !== undefined ? detail
      : ('got ' + fmt(actual) + ', want ' + fmt(expected) + ' +/- ' + tol));
  }
  gte(name, actual, min, detail){
    const pass = actual >= min;
    return this._push(name, pass, detail !== undefined ? detail : ('got ' + fmt(actual) + ', need >= ' + min));
  }
  lte(name, actual, max, detail){
    const pass = actual <= max;
    return this._push(name, pass, detail !== undefined ? detail : ('got ' + fmt(actual) + ', need <= ' + max));
  }
  info(name, detail){ this.rec.results.push({ name, pass: true, info: true, detail: String(detail) }); }
}

function fmt(v){
  if (typeof v === 'number') return Number.isInteger(v) ? String(v) : v.toFixed(3);
  return String(v);
}

export async function runAll(onProgress){
  const out = { suites: [], passed: 0, failed: 0, started: Date.now() };
  for (const s of suites){
    s.results.length = 0;
    const ctx = new Ctx(s);
    const t0 = performance.now();
    try {
      await s.fn(ctx);
    } catch (e){
      s.results.push({ name: 'suite threw', pass: false, detail: (e && e.stack) || String(e) });
    }
    s.ms = performance.now() - t0;
    for (const r of s.results){
      if (r.info) continue;
      if (r.pass) out.passed++; else out.failed++;
    }
    out.suites.push({ name: s.name, ms: s.ms, results: s.results.slice() });
    if (onProgress) onProgress(s);
  }
  out.ms = Date.now() - out.started;
  return out;
}
