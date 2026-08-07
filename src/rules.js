import { Ring, clamp } from './math.js';
import { scoreCall, margin, isolationScore, clarityScore } from './confidence.js';

/* The rules engine.

   Pure with respect to the DOM: it takes poses, a ball tracker, a config
   object and a scene quality reading, and returns events. That is what lets
   the whole thing run headlessly in the test suite at thousands of frames a
   second, and it removes roughly ten getElementById calls per frame from the
   render loop.

   Structure is deliberately two-phase:

     Phase 1, per frame: cheap detectors watch for the *possibility* of a
     violation and record everything into a replay ring buffer.

     Phase 2, on trigger: the candidate is reviewed against the buffer. The
     review asks whether the supporting evidence is actually present across
     the whole event window, not just in the single frame that fired. A
     candidate that cannot be corroborated becomes a NO CALL.

   This is the difference between a frame-by-frame heuristic and something
   that behaves like an official who watched the play. */

export const S = { NONE:'no ball', LOOSE:'loose', DRIBBLE:'dribbling', HELD:'held' };

export class RulesEngine {
  constructor(cfg, calibration){
    this.cfg = cfg;
    /* Optional. When present, foot travel is measured on the court plane in
       feet instead of in pixels, which removes the perspective bias entirely. */
    this.cal = calibration || null;
    this.replay = new Ring(Math.ceil(cfg.replaySeconds * 60));
    this.reset();
  }

  reset(){
    this.state = S.NONE;
    this.handlerId = null;
    this.candidateId = null;
    this.candidateFrames = 0;
    this.dribbleCount = 0;
    this.hadDribbleBeforeHold = false;
    this.gatherStartT = 0;
    this.holdStart = 0;
    this.nearFrames = 0;
    this.noHandlerFrames = 0;
    this.heldSteps = 0;
    this.feet = { left: null, right: null };
    this.anchors = null;
    this.armedDown = 0;
    this.armedUp = 0;
    this.fallLowY = -Infinity;
    this.apexY = Infinity;
    this.apexX = 0;
    this.apexWristY = null;
    this.apexWristX = null;
    this.apexDist = Infinity;
    this.apexUnit = 0;
    this.lastBounceT = 0;
    this.bounceTimes = [];
    this.cooldown = Object.create(null);
    this.replay.clear();
    this.stats = { candidates: 0, confirmed: 0, rejected: 0 };
  }

  resetSequence(reason){
    this.dribbleCount = 0;
    this.hadDribbleBeforeHold = false;
    this.heldSteps = 0;
    this.feet.left = this.feet.right = null;
    this.anchors = null;
    this.armedDown = this.armedUp = 0;
    this.fallLowY = -Infinity;
    this.apexY = Infinity;
    this.apexX = 0;
    this.apexWristY = null;
    this.apexWristX = null;
    this.apexDist = Infinity;
    this.gatherStartT = 0;
    this.bounceTimes.length = 0;
    this.state = reason || S.LOOSE;
  }

  _cool(rule, t, ms){
    if (this.cooldown[rule] && t - this.cooldown[rule] < ms) return true;
    this.cooldown[rule] = t;
    return false;
  }

  /* Possession. Whoever has a wrist nearest the ball is the candidate, but
     nearest alone is a false assumption: a defender reaching in is nearer
     than the dribbler for a frame or two. So the current handler gets a
     stickiness bonus, and a challenger must win by a clear margin for
     several consecutive frames before possession moves. */
  findHandler(poses, ball){
    if (!ball.seen) return null;
    let best = null, bestScore = Infinity;
    for (const p of poses){
      for (const w of ['left_wrist','right_wrist']){
        const k = p.kp(w);
        if (!k) continue;
        const d = Math.hypot(k.x - ball.x, k.y - ball.y);
        // Incumbency discount: the established handler is judged 25% closer
        // than they are, which absorbs a defender's momentary reach-in.
        const score = (p.id === this.handlerId) ? d * 0.75 : d;
        if (score < bestScore){
          bestScore = score;
          best = { pose: p, dist: d, wrist: k, side: w };
        }
      }
    }
    if (!best) return null;
    const u = best.pose.unit() || (ball.r * 4) || 120;
    return best.dist < u * 2.6 ? Object.assign(best, { unit: u }) : null;
  }

  /* One frame. Returns an array of events (may be empty).
     Each event: {type, label, confidence, detail, playerId, t, called:boolean} */
  step(poses, ball, t, quality){
    const cfg = this.cfg;
    const events = [];
    ball.predictTo(t);

    const handler = this.findHandler(poses, ball);
    const unit = handler ? handler.unit : (ball.r * 4 || 120);

    // Possession changes, debounced.
    if (handler){
      if (handler.pose.id !== this.handlerId){
        if (this.candidateId === handler.pose.id) this.candidateFrames++;
        else { this.candidateId = handler.pose.id; this.candidateFrames = 1; }
        if (this.candidateFrames >= cfg.handlerSwitchFrames){
          if (this.handlerId !== null) this.resetSequence(S.LOOSE);
          this.handlerId = handler.pose.id;
          this.candidateId = null; this.candidateFrames = 0;
        }
      } else { this.candidateId = null; this.candidateFrames = 0; }
    }

    // Record this frame before any early return, so review always has data.
    this._record(t, ball, handler, poses, quality);

    const grace = this.state === S.HELD ? cfg.heldGraceMs : cfg.looseGraceMs;
    if (!ball.seen || t - ball.lastRealT > grace){
      this.state = S.NONE;
      return events;
    }

    const vy = ball.vy;
    const speed = ball.speed;
    const bounceSpeed = cfg.bounceK * unit;

    /* Reversal arming. Smoothing and filtering spread a reversal across
       several frames, so the velocity is never strongly downward on the same
       frame it reads strongly upward. Arm on a fast fall, fire on the
       upward read inside a short window. */
    if (vy > bounceSpeed){
      if (!this.armedDown) this.fallLowY = -Infinity;
      this.armedDown = t;
    }
    if (this.armedDown && ball.y > this.fallLowY) this.fallLowY = ball.y;

    if (vy < -bounceSpeed){
      if (!this.armedUp){
        this.apexY = Infinity; this.apexWristY = null;
        this.apexDist = Infinity; this.apexUnit = unit;
      }
      this.armedUp = t;
    }
    if (this.armedUp && ball.y < this.apexY){
      this.apexY = ball.y;
      this.apexX = ball.x;
      this.apexWristY = handler ? handler.wrist.y : null;
      this.apexWristX = handler ? handler.wrist.x : null;
      this.apexDist = handler ? handler.dist : Infinity;
      this.apexUnit = unit;
    }

    const bounced = vy < -bounceSpeed * 0.35 &&
                    this.armedDown && t - this.armedDown < cfg.armMs &&
                    t - this.lastBounceT > cfg.minBounceGapMs &&
                    this._bounceLowEnough(handler);

    if (bounced){
      this.armedDown = 0;
      this.lastBounceT = t;
      this.dribbleCount++;
      this.bounceTimes.push(t);
      if (this.bounceTimes.length > 40) this.bounceTimes.shift();

      if (this.state === S.HELD && this.hadDribbleBeforeHold && cfg.rules.double){
        if (!this._cool('double', t, 2500)){
          const ev = this._reviewDoubleDribble(t, ball, handler, poses, quality, unit);
          if (ev) events.push(ev);
        }
        this.hadDribbleBeforeHold = false;
      }
      this.state = S.DRIBBLE;
      this.heldSteps = 0;
    }

    /* Apex: hand under the ball at the top of the dribble is palming.

       Only meaningful inside an active dribble. Without this gate the check
       fired on a pass in flight, on a loose rebound, and on a shot, any time
       a wrist happened to sit below the ball at its trajectory peak. Palming
       is a dribbling violation, so it requires a recent floor bounce. */
    const dribbling = this.dribbleCount > 0 && t - this.lastBounceT < 1200;
    const atApex = vy > bounceSpeed * 0.35 && this.armedUp && t - this.armedUp < cfg.armMs;
    if (atApex && dribbling && this.state === S.DRIBBLE && handler && cfg.rules.carry){
      this.armedUp = 0;
      /* Under, not beside. A crossover and a behind the back move both put
         the hand low and off to one side of the ball; palming puts it
         underneath. Requiring horizontal alignment separates the two, and it
         is what stopped both legal moves being called. */
      const under = this.apexWristY !== null &&
                    this.apexWristY > this.apexY + ball.r * 1.0;
      const aligned = this.apexWristX !== null &&
                      Math.abs(this.apexWristX - this.apexX) < ball.r * 1.2;
      const close = this.apexDist < ball.r * 3.2;
      if (under && aligned && close && !this._cool('carry', t, 2000)){
        const ev = this._reviewCarry(t, ball, handler, poses, quality, unit);
        if (ev) events.push(ev);
      }
    }

    // Gather.
    let twoHands = false;
    if (handler){
      let n = 0;
      for (const w of ['left_wrist','right_wrist']){
        const k = handler.pose.kp(w);
        if (k && Math.hypot(k.x - ball.x, k.y - ball.y) < ball.r * 3.5) n++;
      }
      twoHands = n === 2;
    }
    /* A gather requires the ball to actually be at rest in the hands.

       Two hands near the ball is not sufficient on its own: the top of a
       crossover and a behind the back move both put the ball momentarily
       between both hands while it is travelling fast. Treating that as an
       instant gather turned every crossover into a double dribble. Two hands
       now shortens the required dwell rather than skipping it, and both paths
       demand a slow ball. */
    /* At rest is judged on measured displacement first, filtered velocity
       only as a fallback. A ball held in the hands moves barely at all over a
       third of a second; a dribbled ball crosses most of the player's height
       in the same time. */
    const spread = ball.spread(320);
    const slow = spread !== null ? spread < unit * 0.6 : speed < unit * 0.9;
    const pinned = handler && handler.dist < ball.r * 2.6 && slow;
    const cradled = twoHands && slow;

    /* Gather evidence accumulates and decays; it is never wiped by one frame.

       This is the single highest impact correctness fix in the engine. A ball
       held in two hands is the most occluded object on the court, so the
       detector drops it constantly. The previous logic reset the counter to
       zero on any frame that failed the test, which meant one dropped frame
       destroyed the whole gather. Measured across 20 seeds, double dribble
       recall collapsed from 100% with a perfect detector to 25% at only 20%
       dropped frames, which is optimistic for real footage.

       Three states now, and the middle one is the point: evidence for,
       evidence against, and no evidence at all. A coasting ball supplies no
       new information about whether it is being held, so the accumulated
       evidence is left alone rather than treated as contradiction. */
    const coasting = ball.isCoasting(t);
    if (pinned || cradled) this.nearFrames = Math.min(this.nearFrames + 1, 40);
    else if (!coasting) this.nearFrames = Math.max(0, this.nearFrames - 1);

    if (this.nearFrames > 0){
      if (this.state !== S.HELD && this.nearFrames > 3){
        if (!this.holdStart) this.holdStart = t;
        const needed = cfg.holdSeconds * 1000 * (cradled ? 0.5 : 1);
        if (t - this.holdStart > needed){
          if (this.state === S.DRIBBLE || this.dribbleCount > 0) this.hadDribbleBeforeHold = true;
          this.state = S.HELD;
          this.gatherStartT = t;
          this.heldSteps = 0;
          this.feet.left = this.feet.right = null;
          this.anchors = { left: null, right: null };
        }
      }
    } else {
      this.holdStart = 0;
    }

    // A shot or pass ends the sequence. Measured by the ball leaving the
    // handler entirely, never by speed: pushing the ball back into a dribble
    // is fast too, and that is exactly the violation we are hunting.
    if (!handler) this.noHandlerFrames++; else this.noHandlerFrames = 0;
    if (this.state === S.HELD && this.noHandlerFrames > 8) this.resetSequence(S.LOOSE);

    // Steps while held.
    if (this.state === S.HELD && handler && cfg.rules.travel){
      this._countSteps(handler.pose, handler.unit, t);
      if (this.heldSteps > cfg.stepsAllowed &&
          this._pivotReleased(handler.pose, handler.unit) &&
          !this._cool('travel', t, 2500)){
        const ev = this._reviewTravel(t, ball, handler, poses, quality, unit);
        if (ev) events.push(ev);
        this.heldSteps = 0;
      }
    }

    if (cfg.rules.contact && handler && poses.length > 1){
      const ev = this._checkContact(poses, handler, t, quality);
      if (ev) events.push(ev);
    }

    return events;
  }

  _record(t, ball, handler, poses, quality){
    this.replay.push({
      t,
      bx: ball.x, by: ball.y, bvy: ball.vy, br: ball.r,
      real: ball.seen && !ball.isCoasting(t),
      state: this.state,
      handlerId: handler ? handler.pose.id : null,
      handlerDist: handler ? handler.dist : Infinity,
      unit: handler ? handler.unit : 0,
      people: poses.length,
      clarity: quality ? clarityScore(quality) : 0.7
    });
  }

  /* Review: was there really a dribble, then a gather, then another dribble?
     The instant trigger only knows about the bounce that just happened. The
     buffer knows whether the gather it followed was ever properly observed. */
  _reviewDoubleDribble(t, ball, handler, poses, quality, unit){
    this.stats.candidates++;
    const gatherT = this.gatherStartT || t - 500;
    const window = this.replay.between(gatherT - 1500, t);

    // Structural checks first. These are not confidence, they are whether the
    // event is coherent at all.
    const priorBounces = this.bounceTimes.filter(bt => bt < gatherT && bt > gatherT - 4000).length;
    const gatherFrames = window.filter(f => f.state === S.HELD).length;
    if (priorBounces < 1 || gatherFrames < 2){
      return this._noCall('DOUBLE DRIBBLE', t, handler,
        priorBounces < 1 ? 'no dribble observed before the gather'
                         : 'gather too brief to confirm');
    }

    const coverage = ball.coverage(gatherT - 800, t);
    const kpQ = handler ? handler.pose.quality(['left_wrist','right_wrist']) : 0.4;
    // Margin: a long, unambiguous gather is stronger evidence than a
    // borderline one that barely cleared the dwell threshold.
    const gatherMs = t - gatherT;
    const marg = margin(gatherMs, this.cfg.holdSeconds * 1000, 0.8);
    const stability = clamp(gatherFrames / 8, 0.2, 1);

    return this._finish('double', 'DOUBLE DRIBBLE', t, handler, {
      coverage,
      keypoints: kpQ,
      margin: marg,
      clarity: clarityScore(quality),
      isolation: isolationScore(poses, handler && handler.pose, unit),
      stability
    }, { priorBounces, gatherMs: Math.round(gatherMs), gatherFrames });
  }

  _reviewCarry(t, ball, handler, poses, quality, unit){
    this.stats.candidates++;
    const underBy = this.apexWristY - this.apexY;
    const coverage = ball.coverage(t - 600, t);
    // The apex geometry has to have been measured on real detections. If the
    // ball was coasting through the top of the dribble, we did not see it.
    const apexReal = this.replay.between(t - 400, t).filter(f => f.real).length;
    if (apexReal < 2){
      return this._noCall('CARRY', t, handler, 'ball not observed through the apex');
    }
    return this._finish('carry', 'CARRY', t, handler, {
      coverage,
      keypoints: handler.pose.quality([handler.side]),
      margin: margin(underBy, ball.r * 0.8, 0.7),
      clarity: clarityScore(quality),
      isolation: isolationScore(poses, handler.pose, unit),
      stability: clamp(apexReal / 5, 0.2, 1)
    }, { underByPx: Math.round(underBy), ballR: Math.round(ball.r) });
  }

  _reviewTravel(t, ball, handler, poses, quality, unit){
    this.stats.candidates++;
    const since = this.gatherStartT || t - 1200;
    const window = this.replay.between(since, t);
    const heldFrames = window.filter(f => f.state === S.HELD).length;
    if (heldFrames < 4){
      return this._noCall('TRAVEL', t, handler, 'possession too brief to judge steps');
    }
    // Ankle visibility is the crux: a step counted from a barely visible
    // ankle is a guess. This is scored honestly rather than assumed.
    const ankleQ = handler.pose.quality(['left_ankle','right_ankle']);
    if (ankleQ < 0.25){
      return this._noCall('TRAVEL', t, handler, 'feet not visible enough to count steps');
    }
    return this._finish('travel', 'TRAVEL', t, handler, {
      coverage: ball.coverage(since, t),
      keypoints: ankleQ,
      margin: margin(this.heldSteps, this.cfg.stepsAllowed, 0.5),
      clarity: clarityScore(quality),
      isolation: isolationScore(poses, handler.pose, unit),
      stability: clamp(heldFrames / 12, 0.2, 1)
    }, { steps: this.heldSteps, allowed: this.cfg.stepsAllowed });
  }

  _checkContact(poses, handler, t, quality){
    const hu = handler.unit;
    const torso = handler.pose.kp('left_hip') || handler.pose.kp('right_hip');
    if (!torso) return null;
    for (const p of poses){
      if (p.id === handler.pose.id) continue;
      for (const w of ['left_wrist','right_wrist','left_elbow','right_elbow']){
        const k = p.kp(w);
        if (!k) continue;
        if (Math.hypot(k.x - torso.x, k.y - torso.y) < hu * 0.55){
          if (this._cool('contact', t, 3000)) return null;
          // Deliberately capped low. This is a review prompt, not a foul call,
          // and its confidence must never suggest otherwise.
          const conf = Math.min(0.45, clarityScore(quality));
          return {
            type: 'contact', label: 'POSSIBLE CONTACT, REVIEW',
            confidence: conf, called: true, review: true,
            playerId: handler.pose.id, t, detail: { note: 'proximity only, not a foul judgement' }
          };
        }
      }
    }
    return null;
  }

  _finish(type, label, t, handler, factors, detail){
    const { score, detail: fd } = scoreCall(factors);
    const called = score >= this.cfg.minConfidence;
    if (called) this.stats.confirmed++; else this.stats.rejected++;
    return {
      type, label, t,
      confidence: score,
      called,
      playerId: handler ? handler.pose.id : null,
      factors: fd,
      detail: detail || {},
      reason: called ? null : 'confidence below threshold'
    };
  }

  _noCall(label, t, handler, reason){
    this.stats.candidates++;
    this.stats.rejected++;
    return {
      type: 'nocall', label, t,
      confidence: 0, called: false,
      playerId: handler ? handler.pose.id : null,
      factors: {}, detail: {}, reason
    };
  }

  /* A bounce only counts if the fall bottomed out low on the handler's body.
     Without this every jab fake reads as a dribble, and a phantom dribble
     becomes a phantom double dribble. */
  _bounceLowEnough(handler){
    if (!handler) return true;
    const knee = handler.pose.kp('left_knee') || handler.pose.kp('right_knee');
    const hip  = handler.pose.kp('left_hip')  || handler.pose.kp('right_hip');
    const floorLine = knee ? knee.y : (hip ? hip.y + handler.unit : null);
    return floorLine === null || this.fallLowY > floorLine;
  }

  /* Distance between two foot positions, and the threshold that counts as a
     stride. On a calibrated court both are in feet, which is perspective
     proof: a step straight toward the camera moves almost no pixels but a
     full stride of court. Uncalibrated, we fall back to pixels scaled by
     torso length, which is the best available proxy. */
  _footMetric(ax, ay, bx, by, unit){
    if (this.cal && this.cal.ready){
      const d = this.cal.floorDistance(ax, ay, bx, by);
      if (d !== null) return { d, stride: 1.15, pivot: 1.4 };   // feet
    }
    return { d: Math.hypot(ax - bx, ay - by), stride: unit * 0.42, pivot: unit * 0.5 };
  }

  _countSteps(pose, unit, t){
    for (const side of ['left','right']){
      const a = pose.kp(side + '_ankle');
      if (!a) continue;
      const f = this.feet[side];
      if (!f){
        this.feet[side] = { x: a.x, y: a.y, moved: false, t };
        if (this.anchors && !this.anchors[side]) this.anchors[side] = { x: a.x, y: a.y };
        continue;
      }
      const m = this._footMetric(a.x, a.y, f.x, f.y, unit);
      if (!f.moved && m.d > m.stride) f.moved = true;
      else if (f.moved && m.d > m.stride && t - f.t > 120){
        this.heldSteps++;
        this.feet[side] = { x: a.x, y: a.y, moved: false, t };
      }
    }
  }

  _pivotReleased(pose, unit){
    if (!this.anchors) return true;
    for (const side of ['left','right']){
      const an = this.anchors[side];
      const a = pose.kp(side + '_ankle');
      if (!an || !a) continue;
      const m = this._footMetric(a.x, a.y, an.x, an.y, unit);
      if (m.d < m.pivot) return false;
    }
    return true;
  }
}
