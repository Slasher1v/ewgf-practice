// df+2 Trainer: the f is played for you, then you hit df+2 on the second
// tone. 1 frame starts stretched to 10 real frames; each hit shrinks it by one.

import {
  FRAME_MS, C, DF_START_LEVEL, DF_LEVEL_DOWN, DF_RANGE_AFTER_MS, DF_COUNT_IN, DF_REST_MS,
  DF_GAPS, DF_HISTORY, settings, keyName,
} from "./config.js";
import { judgeDfRep } from "./engine.js";
import { Painter } from "./draw.js";
import * as audio from "./audio.js";

const $ = (id) => document.getElementById(id);
const clock = () => new Date().toTimeString().slice(0, 8);
const num = (id, def, lo, hi) => {
  const v = parseInt($(id).value, 10);
  return Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : def;
};

export class DFTab {
  constructor(app) {
    this.app = app;
    this.running = false;
    this.rep = null;
    this.prev = null;
    this.held = new Set();
    this.level = DF_START_LEVEL;
    this.bestLevel = DF_START_LEVEL + 1;
    this.hitsAtLevel = 0;
    this.missStreak = 0;
    this.stats = { reps: 0, hits: 0, streak: 0, bestStreak: 0 };
    this.history = [];
    this.painter = new Painter($("d-grid"));
    this.ladderPainter = new Painter($("d-ladder"));

    for (const g of DF_GAPS) $("d-gap").add(new Option(g.label, g.gap));
    $("d-start").onclick = () => (this.running ? this.stop() : this.start());
    for (const [id, lo, hi, def] of [["d-level", 1, 20, 10], ["d-bpm", 60, 200, 100], ["d-hits", 1, 10, 1]]) {
      $(id).addEventListener("change", () => { $(id).value = num(id, def, lo, hi); this.updateStats(); });
    }
    this.updateHelp();
    this.updateStats();
  }

  updateHelp() {
    const k = settings.keys;
    const fwd = settings.sideSwap ? k.b : k.f;
    $("d-help").textContent = `Clicks count you in, the f plays by itself, then press df+2 on the second tone: `
      + `hold ↓ (${keyName(k.d)}) first, then hit → (${keyName(fwd)}) + 2 (${keyName(k[2])}). `
      + `↓ must go down before →. Anywhere in the green range counts as long as f and 2 share a frame.`;
  }

  startLevel() { return num("d-level", DF_START_LEVEL, 1, 20); }

  updateStats() {
    const s = this.stats;
    const rate = s.reps ? `${Math.round((100 * s.hits) / s.reps)}%` : "-";
    const best = this.bestLevel <= 40 ? String(this.bestLevel) : "-";
    const need = num("d-hits", 1, 1, 10);
    $("d-stats").textContent = `Level ${this.level}  (1 frame = ${this.level} frames, ${Math.round(this.level * FRAME_MS)} ms)   ·   `
      + `${this.hitsAtLevel}/${need} to next   ·   Best cleared ${best}   ·   `
      + `Hits ${s.hits}/${s.reps} (${rate})   ·   Streak ${s.streak} (best ${s.bestStreak})`;
  }

  setBig(t, color) { $("d-big").textContent = t; $("d-big").style.color = color; }
  setSub(t, color = C.MUTED) { $("d-sub").textContent = t; $("d-sub").style.color = color; }

  // -- control ------------------------------------------------------------
  start() {
    this.app.stopOthers("df");
    this.level = this.startLevel();
    this.hitsAtLevel = this.missStreak = 0;
    this.running = true;
    this.prev = null;
    $("d-start").textContent = "■ Stop";
    $("d-start").className = "btn gold right";
    this.updateStats();
    this.scheduleRep(performance.now() + 400);
  }

  stop() {
    if (!this.running) return;
    this.running = false;
    this.rep = null;
    audio.cancelScheduled();
    $("d-start").textContent = "▶ Start";
    $("d-start").className = "btn primary right";
    this.setBig("Paused", C.FG);
  }

  scheduleRep(repStart) {
    const beat = 60000 / num("d-bpm", 100, 60, 200);
    const gap = Number($("d-gap").value) || 2;
    const fms = FRAME_MS * this.level;
    const T_f = repStart + DF_COUNT_IN * beat;
    const T_hit = T_f + gap * fms;
    const off = settings.audioOffset || 0;
    for (let i = 0; i < DF_COUNT_IN; i++) audio.schedule("click", repStart + i * beat - off);
    audio.schedule("f", T_f - off);
    audio.schedule("df", T_hit - off);
    const winEnd = T_hit + Math.max(DF_RANGE_AFTER_MS, 2 * fms);
    this.rep = {
      repStart, T_f, T_hit, beat, level: this.level, fms, gap, winStart: T_f - 0.5 * fms, winEnd,
      evalT: winEnd + 30, strict: $("d-strict").checked, t_df: null, t_2: null, t_d: null, t_f: null,
      dHeldAtStart: false, dSegs: [], dfHeldBefore: false, startChecked: false, grade: null, judgement: null,
    };
  }

  // -- input --------------------------------------------------------------
  feed(kind, btn, t) {
    const before = new Set(this.held);
    if (kind === "press") {
      if (this.held.has(btn)) return;
      this.held.add(btn);
    } else {
      this.held.delete(btn);
      const rep = this.rep;
      if (btn === "d" && rep && rep.dSegs.length && rep.dSegs[rep.dSegs.length - 1][1] === null) rep.dSegs[rep.dSegs.length - 1][1] = t;
      return;
    }
    const rep = this.rep;
    if (!this.running || !rep || t < rep.winStart || t > rep.winEnd) return;
    if (btn === "d") {
      rep.dSegs.push([t, null]);
      if (rep.t_d === null) rep.t_d = t;
    } else if (btn === "f" && rep.t_f === null) rep.t_f = t;
    if ((btn === "f" || btn === "d") && before.has(btn === "f" ? "d" : "f")) {
      if (rep.t_df === null) rep.t_df = t;
    } else if (btn === "2" && rep.t_2 === null) rep.t_2 = t;
  }

  tick(now) {
    const rep = this.rep;
    if (!this.running || !rep) return;
    if (!rep.startChecked && now >= rep.winStart) {
      rep.startChecked = true;
      rep.dfHeldBefore = this.held.has("f") && this.held.has("d");
      rep.dHeldAtStart = this.held.has("d");
      if (rep.dHeldAtStart) rep.dSegs.push([rep.winStart, null]);
    }
    if (now >= rep.evalT) {
      this.evaluate(rep);
      this.prev = rep;
      this.scheduleRep(now + DF_REST_MS);
    }
  }

  // -- judging ------------------------------------------------------------
  evaluate(rep) {
    const j = judgeDfRep(rep);
    rep.grade = j.hit ? "HIT" : "MISS";
    rep.judgement = j;
    const s = this.stats;
    s.reps += 1;
    let note = "", sound = j.hit ? "great" : "drop";
    const need = num("d-hits", 1, 1, 10);
    if (j.hit) {
      s.hits += 1; s.streak += 1; s.bestStreak = Math.max(s.bestStreak, s.streak);
      this.missStreak = 0;
      this.hitsAtLevel += 1;
      this.bestLevel = Math.min(this.bestLevel, this.level);
      if (this.hitsAtLevel >= need) {
        this.hitsAtLevel = 0;
        sound = "electric_best";
        if (this.level > 1) {
          this.level -= 1;
          note = `Level ${this.level}: 1 frame = ${this.level} frames (${Math.round(this.level * FRAME_MS)} ms)`;
        } else note = "Real speed - that's an in-game Electric window";
      }
    } else {
      s.streak = 0;
      this.hitsAtLevel = 0;
      this.missStreak += 1;
      if (this.missStreak >= DF_LEVEL_DOWN && this.level < this.startLevel()) {
        this.level += 1;
        this.missStreak = 0;
        note = `Back to level ${this.level} (${Math.round(this.level * FRAME_MS)} ms frame)`;
      }
    }
    if (settings.resultSounds) audio.play(sound);

    this.setBig(j.hit ? "HIT!" : "MISS", j.hit ? C.GOLD : C.RED);
    this.setSub(note || j.reason, note ? (j.hit ? C.GOLD : C.RED) : C.MUTED);
    $("d-detail").textContent = DFTab.detail(j, rep);
    $("d-math").textContent = j.math ? j.math.join("\n") : "";
    this.updateStats();
    const lvl = rep.level;
    this.history.unshift({ line: `${clock()}  L${String(lvl).padEnd(2)} (${String(Math.round(lvl * FRAME_MS)).padStart(3)}ms)  ${j.hit ? "HIT " : "MISS"}  ${j.reason}`, hit: j.hit });
    this.history.length = Math.min(this.history.length, DF_HISTORY);
    $("d-log").replaceChildren(...this.history.map((h) => {
      const li = document.createElement("li");
      li.textContent = h.line;
      li.style.color = h.hit ? C.GOLD : C.RED;
      return li;
    }));
  }

  static detail(j, rep) {
    const parts = [];
    if (j.cueMs !== null) {
      const ms = Math.round(j.cueMs);
      parts.push(Math.abs(ms) < 10 ? "df on the cue" : `df ${Math.abs(ms)} ms ${ms > 0 ? "late" : "early"}`);
    }
    if (j.gapMs !== null) {
      const ms = Math.round(j.gapMs);
      parts.push(Math.abs(ms) < 1 ? "2 at the same time as df" : `2 ${Math.abs(ms)} ms ${ms > 0 ? "after" : "before"} df`);
    }
    parts.push(`frame size now ${Math.round(rep.fms)} ms`);
    return parts.join("   ·   ");
  }

  // -- drawing ------------------------------------------------------------
  draw(now) {
    const rep = this.rep;
    if (this.running && rep) {
      if (now >= rep.repStart && now < rep.T_f) {
        const n = Math.floor((rep.T_f - now) / rep.beat) + 1;
        this.setBig(String(Math.min(n, DF_COUNT_IN)), C.FG);
      } else if (now >= rep.T_f && now < rep.evalT) this.setBig("df+2!", C.BLUE);
    }
    let show = rep;
    if (this.prev && (!rep || now < rep.T_f - rep.beat)) show = this.prev;
    this.drawLadder();
    this.drawGrid(show, now);
  }

  drawLadder() {
    const p = this.ladderPainter.begin(null);
    const topLevel = Math.max(this.startLevel(), this.level);
    const levels = [];
    for (let l = topLevel; l >= 1; l--) levels.push(l);
    const bw = (p.W - 4) / levels.length;
    levels.forEach((lvl, i) => {
      const x0 = 2 + i * bw;
      const cur = lvl === this.level, done = lvl >= this.bestLevel;
      p.rect(x0 + 2, 6, x0 + bw - 2, 36, cur ? C.GOLD : done ? C.GREEN : C.PANEL);
      p.text(x0 + bw / 2, 21, String(lvl), { color: cur || done ? C.INK : C.MUTED, bold: true, size: 14 });
      p.text(x0 + bw / 2, 49, `${Math.round(lvl * FRAME_MS)}ms`, { color: C.MUTED, size: 10, mono: true });
    });
  }

  drawGrid(rep, now) {
    const p = this.painter.begin(C.PANEL);
    if (!rep) {
      p.message(["Press Start. Clicks, then the f tone, then hit df+2 on the next tone.",
        "Blocks are stretched frames; thin lines are real game frames."], C.MUTED);
      return;
    }
    const s = rep.level, gap = rep.gap;
    const g0 = rep.T_hit - 0.5 * rep.fms;
    const kmin = -gap - 1;
    const kmax = Math.floor((rep.winEnd - g0) / rep.fms) + 1;
    const mmin = kmin * s, mmax = (kmax + 1) * s;
    const left = 92, right = 12;
    const colw = (p.W - left - right) / (mmax - mmin);
    const X = (m) => left + (m - mmin) * colw;
    const R = (t) => (t - g0) / FRAME_MS;
    const top = 12, bottom = 170;
    for (let k = kmin; k <= kmax; k++) {
      p.rect(X(k * s), top, X((k + 1) * s), bottom, k % 2 === 0 ? C.CELL : C.PANEL);
      if (k === 0) p.box(X(0), top, X(s), bottom, C.GREEN, 2);
    }
    if (!rep.strict) {
      p.rect(X(R(rep.winStart)), top, X(R(rep.winEnd)), top + 6, C.GREEN);
      p.rect(X(R(rep.winStart)), bottom - 6, X(R(rep.winEnd)), bottom, C.GREEN);
    }
    if (s > 1 && colw >= 3) for (let m = mmin; m < mmax; m++) if (m % s) p.line(X(m), top, X(m), bottom, C.DIV);
    const nLab = kmax - kmin + 1;
    const every = nLab <= 16 ? 1 : nLab <= 32 ? 2 : 5;
    for (let k = kmin; k <= kmax; k++) {
      if (k === 0 || k % every === 0) {
        p.text(X((k + 0.5) * s), bottom + 15, k === 0 ? "cue" : (k > 0 ? "+" : "") + k,
          { color: k === 0 ? C.GREEN : C.MUTED, size: 10, mono: true });
      }
    }
    const lanes = { cue: [30, C.MUTED, "f cue (auto)"], d: [72, C.PURPLE, "↓ d"], f: [110, C.BLUE, "→ f"], 2: [148, C.GOLD, "2"] };
    for (const [y, col, label] of Object.values(lanes)) p.text(8, y, label, { color: col, bold: true, size: 12, align: "left" });
    const lo = mmin, hi = mmax;
    const clipx = (m) => X(Math.max(lo, Math.min(hi, m)));
    p.circle(X(R(rep.T_f)), 30, 9, { fill: C.BLUE });
    const xh = X(R(rep.T_hit));
    for (const key of ["f", "2"]) p.circle(xh, lanes[key][0], 11, { stroke: lanes[key][1] });
    p.text(xh, 52, "d down before here", { color: C.MUTED, size: 10 });

    const yd = lanes.d[0];
    for (const [a, b] of rep.dSegs) p.rect(clipx(R(a)), yd - 4, clipx(R(b === null ? now : b)), yd + 4, C.PURPLE);
    if (rep.t_d !== null && R(rep.t_d) >= lo && R(rep.t_d) <= hi) p.circle(X(R(rep.t_d)), yd, 7, { fill: C.PURPLE, stroke: C.FG, width: 1 });

    const orderFail = rep.judgement && rep.judgement.reason.startsWith("f pressed");
    for (const [key, t] of [["f", rep.t_f], ["2", rep.t_2]]) {
      if (t === null) continue;
      const m = R(t);
      if (m < lo || m > hi) continue;
      const y = lanes[key][0];
      const col = key === "f" && orderFail ? C.RED : lanes[key][1];
      const k = Math.floor(m / s);
      p.box(X(k * s) + 2, y - 15, X((k + 1) * s) - 2, y + 15, col, 1);
      if (key === "f") {
        p.diamond(X(m), y, 9, col);
        if (orderFail) p.text(X(m), y - 21, "before d!", { color: C.RED, bold: true, size: 10 });
      } else p.line(X(m), y - 12, X(m), y + 12, col, 3);
    }
    const ph = R(now);
    if (!rep.grade && ph >= lo && ph <= hi) p.line(X(ph), top, X(ph), bottom, C.GOLD, 2);
  }
}
