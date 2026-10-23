// Rhythm Game: each rep starts on your f. You hear a beep, the d tone and an
// Electric chime on the frames where they belong. Frames are stretched by the
// slow-down, but df and 2 are always judged on real game frames.

import {
  FRAME_MS, FRAME_GRACE_MS, EWGF_BASE_STARTUP, C, VARIANTS, RHYTHM_SPEED_ORDER, RHYTHM_LEVEL_UP,
  RHYTHM_LEVEL_DOWN, RHYTHM_HISTORY, settings, saveSettings, speedLabel, variantById,
} from "./config.js";
import { FrameSampler, EWGFDetector, judgeRep, realGridOrigin, slowedTiming, plural } from "./engine.js";
import { Painter } from "./draw.js";
import * as audio from "./audio.js";

const $ = (id) => document.getElementById(id);
const GRADE_COLORS = { PERFECT: C.GOLD, GREAT: C.GREEN, MISS: C.RED };
const clock = () => new Date().toTimeString().slice(0, 8);

export class RhythmTab {
  constructor(app) {
    this.app = app;
    this.active = false;
    this.rep = null;
    this.prev = null;
    this.held = new Set();
    this.history = [];
    this.stats = { reps: 0, perfect: 0, great: 0, miss: 0, combo: 0, bestCombo: 0 };
    this.streak = 0;
    this.missStreak = 0;
    this.realCombo = 0;      // combo counted only at Real speed (leaderboard)
    this.painter = new Painter($("r-grid"));

    const variant = $("r-variant");
    for (const v of VARIANTS) variant.add(new Option(v.label, v.id));
    variant.value = settings.variant;
    variant.onchange = () => { settings.variant = variant.value; saveSettings(); this.updateTiming(); };
    const speed = $("r-speed");
    for (const s of RHYTHM_SPEED_ORDER) speed.add(new Option(speedLabel(s), s));
    speed.onchange = () => { this.updateTiming(); this.updateStats(); };
    $("r-start").onclick = () => (this.active ? this.stop() : this.start());
    this.updateTiming();
    this.updateStats();
  }

  slow() { return Number($("r-speed").value); }
  events() { return variantById($("r-variant").value).events; }

  updateTiming() { $("r-timing").textContent = slowedTiming(this.events(), this.slow()); }

  updateStats() {
    const s = this.stats;
    const acc = s.reps ? `${Math.round((100 * (s.perfect + s.great)) / s.reps)}%` : "-";
    const lvl = this.slow() !== RHYTHM_SPEED_ORDER[RHYTHM_SPEED_ORDER.length - 1]
      ? `${this.streak}/${RHYTHM_LEVEL_UP} clean to speed up` : `streak ${this.streak}`;
    $("r-stats").textContent = `${speedLabel(this.slow())}   ·   ${lvl}   ·   Combo ${s.combo} (best ${s.bestCombo})   ·   `
      + `Perfect ${s.perfect}  Great ${s.great}  Miss ${s.miss}   ·   Hit rate ${acc}`;
  }

  // -- control ------------------------------------------------------------
  start() {
    this.app.stopOthers("rhythm");
    this.active = true;
    this.prev = null;
    this.realCombo = 0;
    $("r-start").textContent = "Stop";
    $("r-start").className = "btn gold right";
    this.setBig("Press →", C.BLUE);
    this.setSub("Press → whenever you're ready - the rep starts on your f");
  }

  stop() {
    if (!this.active) return;
    this.active = false;
    this.rep = null;
    audio.cancelScheduled();
    $("r-start").textContent = "Start";
    $("r-start").className = "btn primary right";
    this.setBig("Paused", C.FG);
  }

  setBig(t, color) { $("r-big").textContent = t; $("r-big").style.color = color; }
  setSub(t, color = C.MUTED) { $("r-sub").textContent = t; $("r-sub").style.color = color; }

  startRep(tF) {
    const events = this.events();
    const slow = this.slow();
    const fms = FRAME_MS * slow;
    const off = settings.audioOffset || 0;
    if (!settings.inputTones) audio.play("f"); // input tones already beep on f otherwise
    for (const [fr, name] of events) {
      if (name === "d" && $("r-dtone").checked) audio.schedule("d", tF + fr * fms - off);
      else if (name === "df") audio.schedule("electric_cue", tF + fr * fms - off);
    }
    const last = Math.max(...events.map((e) => e[0]));
    const sampler = new FrameSampler(tF - 2.5 * fms, fms);
    sampler.held = new Set([...this.held].filter((b) => b !== "f"));
    this.rep = {
      T0: tF, beat: Math.max(200, fms), fms, slow, events, target: last + EWGF_BASE_STARTUP,
      sampler, detector: new EWGFDetector(), evalT: tF + (last + 3) * fms + 250,
      results: [], raw: [], segs: { f: [], d: [] }, marks: [], judgement: null,
    };
    this.setBig("GO!", C.BLUE);
  }

  // -- input --------------------------------------------------------------
  feed(kind, btn, t) {
    const before = new Set(this.held);
    if (kind === "press") {
      if (this.held.has(btn)) return;
      this.held.add(btn);
    } else this.held.delete(btn);
    if (this.active && !this.rep && kind === "press" && btn === "f" && !before.has("d")) this.startRep(t);
    const rep = this.rep;
    if (!rep) return;
    if (t < rep.sampler.t0) {
      if (kind === "press") rep.sampler.held.add(btn); else rep.sampler.held.delete(btn);
      return;
    }
    rep.sampler.feed(kind, btn, t);
    rep.raw.push([kind, btn, t, before]);
    if (btn === "f" || btn === "d") {
      if (kind === "press") {
        rep.segs[btn].push([t, null]);
        if (before.has(btn === "f" ? "d" : "f")) rep.marks.push(["df", t]);
      } else {
        const s = rep.segs[btn];
        if (s.length && s[s.length - 1][1] === null) s[s.length - 1][1] = t;
      }
    } else if (btn === "2" && kind === "press") rep.marks.push(["2", t]);
  }

  tick(now) {
    const rep = this.rep;
    if (!this.active || !rep) return;
    for (const fr of rep.sampler.advance(now - FRAME_GRACE_MS)) rep.results.push(...rep.detector.step(fr));
    if (now >= rep.evalT + FRAME_GRACE_MS) {
      this.evaluate(rep);
      this.prev = rep;
      this.rep = null; // wait for the next f
    }
  }

  // -- judging ------------------------------------------------------------
  evaluate(rep) {
    const j = judgeRep(rep.raw, rep.results, rep.detector, rep.T0, rep.beat, rep.fms, rep.events, rep.target, rep.slow);
    j.startMs = null; // the rep starts on your f, so there's no beat to be early/late on
    rep.judgement = j;
    const s = this.stats;
    s.reps += 1;
    s[j.grade.toLowerCase()] += 1;
    if (j.grade === "MISS") { s.combo = 0; this.streak = 0; this.missStreak += 1; }
    else { s.combo += 1; s.bestCombo = Math.max(s.bestCombo, s.combo); this.streak += 1; this.missStreak = 0; }
    if (j.grade !== "MISS" && rep.slow === 1) {
      this.realCombo += 1;
      this.app.report("rhythm_combo", this.realCombo);
    } else this.realCombo = 0;

    let sound = { PERFECT: "electric", GREAT: "great", MISS: "drop" }[j.grade];
    let note = "";
    const order = RHYTHM_SPEED_ORDER;
    const idx = Math.max(0, order.indexOf(rep.slow));
    if ($("r-auto").checked && this.slow() === rep.slow) {
      if (this.streak >= RHYTHM_LEVEL_UP && idx < order.length - 1) {
        $("r-speed").value = order[idx + 1];
        this.streak = 0;
        note = `   ·   Speed up! Now ${speedLabel(order[idx + 1])}`;
        sound = "electric_best";
        this.updateTiming();
      } else if (this.missStreak >= RHYTHM_LEVEL_DOWN && idx > 0) {
        $("r-speed").value = order[idx - 1];
        this.missStreak = 0;
        this.streak = 0;
        note = `   ·   Slowing down to ${speedLabel(order[idx - 1])}`;
        this.updateTiming();
      }
    }
    if (settings.resultSounds) audio.play(sound);

    this.setBig(j.grade, GRADE_COLORS[j.grade]);
    this.setSub(j.reason + note, note ? GRADE_COLORS[j.grade] : C.MUTED);
    $("r-detail").textContent = RhythmTab.detailText(j);
    $("r-math").textContent = j.math ? j.math.join("\n") : "";
    this.updateStats();

    const tgt = rep.target, sl = rep.slow;
    const pat = sl === 1 ? `i${tgt}` : `i${tgt}@${sl}x=${(tgt - EWGF_BASE_STARTUP) * sl}f`;
    this.history.unshift({ line: `${clock()}  ${speedLabel(sl).padEnd(10)} ${pat.padEnd(12)} ${j.grade.padEnd(8)} ${RhythmTab.detailText(j)}   ${j.reason}`, grade: j.grade });
    this.history.length = Math.min(this.history.length, RHYTHM_HISTORY);
    $("r-log").replaceChildren(...this.history.map((h) => {
      const li = document.createElement("li");
      li.textContent = h.line;
      li.style.color = GRADE_COLORS[h.grade];
      return li;
    }));
  }

  static detailText(j) {
    const off = (e) => {
      const n = Math.round(e);
      return n === 0 ? "on time" : `${plural(Math.abs(n))} ${n > 0 ? "late" : "early"}`;
    };
    const parts = [];
    if (j.startMs !== null) {
      const ms = Math.round(j.startMs);
      parts.push(Math.abs(ms) < 10 ? "f on the beat" : `f ${Math.abs(ms)} ms ${ms > 0 ? "late" : "early"}`);
    }
    for (const [name, e] of Object.entries(j.errors)) parts.push(`${name} ${e === null ? "missed" : off(e)}`);
    if (j.jf === null) parts.push("no 2");
    else if (j.jf === 0) parts.push("2 same frame as df ✓");
    else parts.push(`2 ${plural(Math.abs(j.jf))} ${j.jf > 0 ? "late" : "early"} ✗`);
    return parts.join("   ·   ");
  }

  // -- drawing ------------------------------------------------------------
  draw(now) {
    const rep = this.rep || this.prev;
    const p = this.painter.begin(C.PANEL);
    if (!rep) {
      p.message(["Press Start, then press → whenever you like. You hear a beep on your f, the d tone,",
        "then the Electric chime where df+2 should land. Each column is one real game frame."], C.MUTED);
      return;
    }
    const s = rep.slow;
    const g0 = realGridOrigin(rep.T0, rep.fms);
    const last = Math.max(...rep.events.map((e) => e[0]));
    const kmin = -2, kmax = last + 3;
    const mmin = kmin * s, mmax = (kmax + 1) * s;
    const left = 78, right = 12;
    const colw = (p.W - left - right) / (mmax - mmin);
    const X = (m) => left + (m - mmin) * colw;
    const R = (t) => (t - g0) / FRAME_MS;
    const top = 14, bottom = 200;
    for (let k = kmin; k <= kmax; k++) p.rect(X(k * s), top, X((k + 1) * s), bottom, k % 2 === 0 ? C.CELL : C.PANEL);
    if (s > 1 && colw >= 3) for (let m = mmin; m < mmax; m++) if (m % s) p.line(X(m), top, X(m), bottom, C.DIV);
    const step = colw >= 18 ? 1 : s <= 4 ? s : s / 2;
    for (let m = mmin; m < mmax; m++) {
      if (m % step === 0) p.text(X(m + 0.5), bottom + 15, String(m), { color: C.MUTED, size: colw < 18 ? 9 : 10, mono: true });
    }
    p.text(left - 8, bottom + 15, "game frame", { color: C.MUTED, size: 10, align: "right" });
    const lanes = { f: [52, C.BLUE, "→ f"], d: [108, C.PURPLE, "↓ d"], df: [164, C.GREEN, "↘ df+2"] };
    const ydf = lanes.df[0];
    for (const [kind, t] of rep.marks) {
      const m = Math.floor(R(t));
      if (m >= mmin && m < mmax) p.box(X(m) + 1, ydf - 22, X(m + 1) - 1, ydf + 22, kind === "df" ? C.GREEN : C.GOLD, 2);
    }
    for (const [y, col, label] of Object.values(lanes)) {
      p.text(10, y, label, { color: col, bold: true, size: 13, align: "left" });
      p.line(left, y, p.W - right, y, C.LINE);
    }
    p.text(X(1.5 * s), 80, "n", { color: C.MUTED, italic: true, size: 13 });
    for (const [fr, name] of rep.events) {
      const [y, col] = lanes[name];
      p.circle(X((fr + 0.5) * s), y, 13, { stroke: col });
    }
    const lo = mmin, hi = mmax;
    for (const key of ["f", "d"]) {
      const [y, col] = lanes[key];
      for (const [a0, b0] of rep.segs[key]) {
        const a = R(a0), b = R(b0 === null ? now : b0);
        if (b < lo || a > hi) continue;
        p.rect(X(Math.max(a, lo)), y - 5, X(Math.min(b, hi)), y + 5, col);
        if (a >= lo && a <= hi) p.circle(X(a), y, 6, { fill: C.FG });
      }
    }
    for (const [kind, t] of rep.marks) {
      const m = R(t);
      if (m < lo || m > hi) continue;
      if (kind === "df") p.diamond(X(m), ydf, 9, C.GREEN);
      else {
        p.text(X(m), ydf - 30, "2", { color: C.GOLD, bold: true, size: 14, mono: true });
        p.line(X(m), ydf - 14, X(m), ydf + 14, C.GOLD, 2);
      }
    }
    const ph = R(now);
    if (!rep.judgement && ph >= lo && ph <= hi) p.line(X(ph), top, X(ph), bottom, C.GOLD, 2);
  }
}
