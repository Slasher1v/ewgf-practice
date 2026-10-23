// Frame engine: a port of the desktop app's judging logic.
// Times are in ms. Works the way the game does: a 60 fps clock samples the
// buttons once per frame, and the EWGF is judged on those frames.

import {
  FRAME_MS, EWGF_BASE_STARTUP, MAX_NEUTRAL_FRAMES, MAX_DOWN_FRAMES, WGF_LATE_WINDOW,
  FAIL_LOG_WINDOW, RHYTHM_PERFECT, DF_BEAT_TOL_MS, settings,
} from "./config.js?v=20261023195230";

// ---------------------------------------------------------------------------
// Frame sampler: raw key events -> one input state per frame
// ---------------------------------------------------------------------------
// A button counts as held on a frame if it's held when the frame ends or was
// pressed at any point during it (a sub-frame tap still registers once).
export class FrameSampler {
  constructor(t0, frameMs = FRAME_MS) {
    this.t0 = t0;
    this.frameMs = frameMs;
    this.nextFrame = 0;
    this.events = [];
    this.held = new Set();
    this.pressT = {};
  }

  feed(kind, btn, t) {
    this.events.push([kind, btn, t]);
  }

  advance(now) {
    const out = [];
    if (this.events.length > 1) this.events.sort((a, b) => a[2] - b[2]);
    while (this.t0 + (this.nextFrame + 1) * this.frameMs <= now) {
      const end = this.t0 + (this.nextFrame + 1) * this.frameMs;
      const evs = [];
      while (this.events.length && this.events[0][2] < end) evs.push(this.events.shift());
      const pressed = new Set();
      for (const [kind, btn, t] of evs) {
        if (kind === "press") {
          if (!this.held.has(btn)) {
            pressed.add(btn);
            this.held.add(btn);
            this.pressT[btn] = t;
          }
        } else {
          this.held.delete(btn);
        }
      }
      const active = new Set([...this.held, ...pressed]);
      out.push({ index: this.nextFrame, dir: this._direction(active), pressed, active, events: evs });
      this.nextFrame += 1;
    }
    return out;
  }

  _axis(active, pos, neg, mode) {
    const p = active.has(pos), n = active.has(neg);
    if (p && n) {
      if (mode === "last") return (this.pressT[pos] ?? 0) >= (this.pressT[neg] ?? 0) ? pos : neg;
      return "";
    }
    return p ? pos : n ? neg : "";
  }

  _direction(active) {
    const v = this._axis(active, "d", "u", settings.socdV);
    const h = this._axis(active, "f", "b", settings.socdH);
    return v + h || "n";
  }
}

// ---------------------------------------------------------------------------
// EWGF detector: frame states -> results
// ---------------------------------------------------------------------------
export const IDLE = 0, ST_F = 1, ST_N = 2, ST_D = 3, ST_PEND = 4;

const s_ = (n) => (n === 1 ? "" : "s");

export class EWGFDetector {
  constructor() {
    this.state = IDLE;
    this.a = null;
    this.lastFail = null; // [result, frameIndex]
  }

  step(fr) {
    const out = [];
    const d = fr.dir;
    const p2 = fr.pressed.has("2");

    if (this.state === ST_PEND) {
      const a = this.a;
      const j = fr.index - a.dfFrame;
      if (p2) {
        a.frames.push(fr);
        out.push(this._result(a, "wgf_late", `2 pressed ${j} frame${s_(j)} after df`, j));
        this._reset();
        return out;
      }
      if (j >= WGF_LATE_WINDOW || (d !== "df" && d !== "d")) {
        out.push(this._result(a, "no_attack", "Crouch dash, no 2"));
        this._reset();
      } else {
        a.frames.push(fr);
        return out;
      }
    }

    if (this.state === IDLE) {
      if (p2 && this.lastFail && fr.index - this.lastFail[1] <= FAIL_LOG_WINDOW) {
        out.push(this.lastFail[0]);
        this.lastFail = null;
      }
      if (d === "f") this._start(fr);
      return out;
    }

    const a = this.a;
    a.frames.push(fr);
    if (p2 && a.early2 === null) a.early2 = fr.index;

    if (this.state === ST_F) {
      if (d === "f") a.f += 1;
      else if (d === "n") { this.state = ST_N; a.n = 1; }
      else if (d === "d" || d === "df") out.push(...this._fail(fr, `No neutral: f went straight to ${d}`));
      else out.push(...this._fail(fr, `Stray input: f went to ${d}`));
    } else if (this.state === ST_N) {
      if (d === "n") {
        a.n += 1;
        if (a.n > MAX_NEUTRAL_FRAMES) out.push(...this._fail(fr, `Neutral held too long (${a.n}f)`));
      } else if (d === "d") { this.state = ST_D; a.d = 1; }
      else if (d === "df") out.push(...this._reachDf(fr));
      else if (d === "f") this._start(fr); // f, n, f = forward dash; start over
      else out.push(...this._fail(fr, `Stray input: neutral went to ${d}`));
    } else if (this.state === ST_D) {
      if (d === "d") {
        a.d += 1;
        if (a.d > MAX_DOWN_FRAMES) out.push(...this._fail(fr, `Held d too long (${a.d}f) before df`));
      } else if (d === "df") out.push(...this._reachDf(fr));
      else if (d === "n") out.push(...this._fail(fr, "Let go of d before reaching df"));
      else if (d === "f") out.push(...this._fail(fr, "Skipped df: d went straight to f"));
      else out.push(...this._fail(fr, `Slid to ${d} instead of df`));
    }
    return out;
  }

  _reset() { this.state = IDLE; this.a = null; }

  _start(fr) {
    this.a = { start: fr.index, frames: [fr], f: 1, n: 0, d: 0, dfFrame: null, early2: null };
    this.state = ST_F;
    if (fr.pressed.has("2")) this.a.early2 = fr.index;
  }

  _fail(fr, reason) {
    const a = this.a;
    const r = this._result(a, "fail", reason);
    this._reset();
    const out = [];
    if (a.early2 !== null) {
      out.push(r); // 2 was pressed, so this was an attempt
      this.lastFail = null;
    } else {
      this.lastFail = [r, fr.index]; // log only if 2 follows soon
    }
    if (fr.dir === "f") this._start(fr);
    return out;
  }

  _reachDf(fr) {
    const a = this.a;
    a.dfFrame = fr.index;
    const p2 = fr.pressed.has("2");
    const extra = ["1", "3", "4"].filter((b) => fr.pressed.has(b));
    let r;
    if (a.early2 !== null && a.early2 < fr.index) {
      const j = a.early2 - fr.index;
      r = this._result(a, "early", `2 pressed ${-j} frame${s_(-j)} before df`, j);
    } else if (p2 && extra.length) {
      r = this._result(a, "fail", `Extra button: df+2+${extra.join("+")}`, 0);
    } else if (p2) {
      r = this._result(a, "electric", "df and 2 on the same frame", 0);
    } else {
      this.state = ST_PEND;
      return [];
    }
    this._reset();
    return [r];
  }

  static rawMs(a) {
    const evs = a.frames.flatMap((fr) => fr.events).sort((x, y) => x[2] - y[2]);
    const first = (pred, after = null) => {
      for (const [k, b, t] of evs) if ((after === null || t > after) && pred(k, b)) return t;
      return null;
    };
    const tFp = first((k, b) => k === "press" && b === "f");
    const tFr = tFp !== null ? first((k, b) => k === "release" && b === "f", tFp) : null;
    const tNe = tFr !== null ? first((k, b) => k === "press" && "dfbu".includes(b) && b.length === 1, tFr) : null;
    let tDf = null;
    if (a.dfFrame !== null) {
      const fr = a.frames.find((x) => x.index === a.dfFrame);
      if (fr) {
        const ts = fr.events.filter(([k, b]) => k === "press" && (b === "f" || b === "d")).map((e) => e[2]);
        tDf = ts.length ? Math.max(...ts) : null;
      }
    }
    const t2 = first((k, b) => k === "press" && b === "2");
    const diff = (x, y) => (x !== null && y !== null ? y - x : null);
    return { f: diff(tFp, tFr), n: diff(tFr, tNe), d: diff(tNe, tDf), jf: diff(tDf, t2) };
  }

  _result(a, kind, reason, jf = null) {
    const mv = a.f + a.n + a.d;
    return {
      kind, reason, fFrames: a.f, nFrames: a.n, dFrames: a.d, movement: mv,
      speed: mv + EWGF_BASE_STARTUP, jf, raw: EWGFDetector.rawMs(a),
      shortcut: a.dfFrame !== null && a.d === 0, frames: [...a.frames],
      timestamp: Date.now(), get electric() { return this.kind === "electric"; },
    };
  }
}

export function resultTitle(r) {
  if (r.kind === "electric") return `i${r.speed} Electric!`;
  if (r.kind === "wgf_late") return `WGF  (2 late +${r.jf}f)`;
  if (r.kind === "early") return `Dropped  (2 early ${r.jf}f)`;
  return "Dropped";
}

// ---------------------------------------------------------------------------
// Plain-language helpers
// ---------------------------------------------------------------------------
export const plural = (n, word = "frame") => `${n} ${word}${n === 1 ? "" : "s"}`;

// `frames` = real game frames from f to df+2, counted like the game does.
export function timingSummary(frames, goal, slow, rhythmMovement = null) {
  const diff = frames - goal;
  const when = diff === 0 ? "right on time" : `${plural(Math.abs(diff))} ${diff > 0 ? "late" : "early"}`;
  const line1 = `f to df+2 took ${plural(frames)}  (goal ${goal})  -  ${when}`;
  let line2 = `Done this way in game, that's an i${frames + EWGF_BASE_STARTUP} Electric`;
  if (slow > 1) {
    const mv = rhythmMovement ?? Math.round(frames / slow);
    line2 += `  (you're at ${slow}x slower - at full speed this rhythm is i${mv + EWGF_BASE_STARTUP})`;
  }
  return [line1, line2];
}

// Where each input lands at this slow-down, in real game frames from your f.
export function slowedTiming(events, slow) {
  const dfK = Math.max(...events.map((e) => e[0]));
  const dK = (events.find((e) => e[1] === "d") || [null])[0];
  const rng = (a, b) => {
    const lo = a * slow, hi = b * slow - 1;
    return lo === hi ? `${lo}` : `${lo}-${hi}`;
  };
  const parts = [`f ${rng(0, 1)}`, `n ${rng(1, dK || dfK)}`];
  if (dK) parts.push(`d ${rng(dK, dfK)}`);
  parts.push(`df+2 on ${dfK * slow}`);
  let text = parts.join("   ") + `   =  df+2 ${dfK * slow} frames (${Math.round(dfK * slow * FRAME_MS)} ms) after f`;
  if (slow > 1) text += `   ·   real game: ${dfK} frames (${Math.round(dfK * FRAME_MS)} ms) = i${dfK + EWGF_BASE_STARTUP}`;
  else text += `  =  i${dfK + EWGF_BASE_STARTUP}`;
  return text;
}

// ---------------------------------------------------------------------------
// Rhythm game judging
// ---------------------------------------------------------------------------
// The f, n, d rhythm is judged on stretched frames, but df and 2 always on
// REAL game frames: in game they're pressed together, at any practice speed.
export const realGridOrigin = (T0, fms) => T0 - 0.5 * fms;

export function judgeRep(raw, results, detector, T0, beat, fms, events, target, slow = 1) {
  const g0 = realGridOrigin(T0, fms);
  // +1e-6: a press exactly on a frame line belongs to the frame starting there
  const realIdx = (t) => Math.floor((t - g0) / FRAME_MS + 1e-6);
  let res = results.find((r) => r.kind !== "no_attack") || null;
  let reason = "";
  if (!res) {
    if (detector.state === ST_PEND || results.some((r) => r.kind === "no_attack")) reason = "Reached df but no 2";
    else if (detector.state !== IDLE) reason = "Motion not finished in time";
    else if (detector.lastFail) res = detector.lastFail[0];
    else reason = "No input";
  }

  const win = 0.5 * beat;
  const fOn = raw.filter(([k, b, t, hb]) => k === "press" && b === "f" && !hb.has("d") && Math.abs(t - T0) <= win);
  const tF = fOn.length ? fOn[0][2] : null;
  const first = (pred) => {
    if (tF === null) return null;
    const e = raw.find(([k, b, t, hb]) => t > tF && k === "press" && pred(b, hb));
    return e ? e[2] : null;
  };
  const tD = first((b, hb) => b === "d" && !hb.has("f"));
  const tDf = first((b, hb) => (b === "f" && hb.has("d")) || (b === "d" && hb.has("f")));
  const t2 = first((b) => b === "2");

  const errors = {};
  if (tF !== null) {
    for (const [fr, name] of events.slice(1)) {
      const actual = name === "d" ? tD : tDf;
      errors[name] = actual === null ? null : realIdx(actual) - realIdx(tF) - fr * slow;
    }
  }
  let jf = null, jfMs = null;
  if (t2 !== null && tDf !== null) {
    jf = realIdx(t2) - realIdx(tDf);
    jfMs = t2 - tDf;
  }
  const startMs = tF !== null ? tF - T0 : null;

  const rightMove = !!res && res.kind === "electric" && res.speed === target;
  const clean = rightMove && jf === 0;
  const errVals = Object.values(errors);
  const tight = errVals.length > 0 && errVals.every((e) => e !== null && Math.abs(e) <= RHYTHM_PERFECT * slow);
  if (tF === null && !res && !reason) reason = "No f";
  let grade;
  if (clean) {
    grade = tight ? "PERFECT" : "GREAT";
    reason = "Electric! df and 2 landed on the same frame";
  } else {
    grade = "MISS";
    const jfMiss = !!res && (res.kind === "wgf_late" || res.kind === "early") && jf !== null && jf !== 0;
    if (rightMove || jfMiss) {
      reason = `df and 2 were on different frames - 2 was ${plural(Math.abs(jf))} ${jf > 0 ? "late" : "early"}`;
    } else if (res && res.kind === "electric" && slow > 1) {
      const got = tDf !== null && tF !== null ? realIdx(tDf) - realIdx(tF) : null;
      reason = `Wrong rhythm: df+2 came ${got !== null ? plural(got) : "?"} after f, goal was ${(target - EWGF_BASE_STARTUP) * slow}`;
    } else if (res && res.kind === "electric") {
      reason = `Came out i${res.speed}, target is i${target}`;
    } else if (res) {
      reason = `${resultTitle(res)}: ${res.reason}`;
    }
  }
  let math = null;
  if (clean && tF !== null && tDf !== null) {
    math = timingSummary(realIdx(tDf) - realIdx(tF), (target - EWGF_BASE_STARTUP) * slow, slow, res.movement);
  }
  return { grade, reason, result: res, startMs, errors, jf, jfMs, math };
}

// ---------------------------------------------------------------------------
// df+2 game judging
// ---------------------------------------------------------------------------
export function judgeDfRep(rep) {
  const g0 = rep.T_hit - 0.5 * rep.fms; // cue sits in the middle of stretched frame 0
  const idx = (t) => Math.floor((t - g0) / rep.fms + 1e-6);
  const J = (hit, reason, dfFrame, twoFrame, cueMs, gapMs, math = null) =>
    ({ hit, reason, dfFrame, twoFrame, cueMs, gapMs, math });

  if (rep.t_df === null && rep.dfHeldBefore) {
    return J(false, "df was already held before the cue - let go of → first",
      null, rep.t_2 === null ? null : idx(rep.t_2), null, null);
  }
  const dDown = rep.t_d !== null ? rep.t_d : rep.dHeldAtStart ? rep.winStart : null;
  if (rep.t_f !== null && (dDown === null || rep.t_f < dDown)) {
    const why = dDown !== null ? "f pressed before d - hold ↓ first, then press → + 2"
      : "f pressed without d - hold ↓ first, then press → + 2";
    return J(false, why, idx(rep.t_f), rep.t_2 === null ? null : idx(rep.t_2), rep.t_f - rep.T_hit,
      rep.t_2 === null ? null : rep.t_2 - rep.t_f);
  }
  if (rep.t_df === null && rep.t_2 === null) return J(false, "No df+2 inside the purple range", null, null, null, null);
  if (rep.t_df === null) return J(false, "Pressed 2 but never made df", null, idx(rep.t_2), null, null);
  const kdf = idx(rep.t_df);
  const cueMs = rep.t_df - rep.T_hit;
  if (rep.t_2 === null) return J(false, "Made df but never pressed 2", kdf, null, cueMs, null);
  const k2 = idx(rep.t_2);
  const gapMs = rep.t_2 - rep.t_df;
  const window = rep.fms;
  if (kdf !== k2) {
    return J(false, `df and 2 were on different frames - 2 was ${Math.round(Math.abs(gapMs))} ms ${k2 > kdf ? "late" : "early"}`,
      kdf, k2, cueMs, gapMs);
  }
  const side = cueMs > 0 ? "late" : "early";
  if (rep.strict && Math.abs(cueMs) > Math.max(window / 2, DF_BEAT_TOL_MS)) {
    return J(false, `Together, but ${Math.round(Math.abs(cueMs))} ms ${side} on the cue`, kdf, k2, cueMs, gapMs);
  }
  const ridx = (t) => Math.floor((t - g0) / FRAME_MS + 1e-6);
  const math = timingSummary(ridx(rep.t_df) - ridx(rep.T_f), rep.gap * rep.level, rep.level, kdf + rep.gap);
  return J(true, "df and 2 landed on the same frame", kdf, k2, cueMs, gapMs, math);
}
