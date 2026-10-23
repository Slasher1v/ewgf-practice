// EWGF Trainer tab: free practice, every attempt judged on 60 fps frames.

import {
  FRAME_MS, FRAME_GRACE_MS, HISTORY_SIZE, CHIME_MAX_SPEED, C, L, ARROWS, DIR_COLORS,
  VARIANTS, SPEEDS, EWGF_BASE_STARTUP, settings, saveSettings, variantById, targetSpeed,
} from "./config.js?v=20261023195621";
import { FrameSampler, EWGFDetector, resultTitle } from "./engine.js?v=20261023195621";
import { Painter, renderChips } from "./draw.js?v=20261023195621";
import * as audio from "./audio.js?v=20261023195621";

const $ = (id) => document.getElementById(id);

export function resultColor(r) {
  if (r.kind !== "electric") return C.RED;
  if (r.movement <= 3) return C.GOLD;
  if (r.movement <= 4) return C.GREEN;
  if (r.movement <= 6) return C.YELLOW;
  return C.ORANGE;
}

const RATE_WINDOW = 50;
export const inputFrames = (mv) => `Input: ${mv} frame${mv === 1 ? "" : "s"}`;
const fmtMs = (v) => (v === null || v === undefined ? "-" : v.toFixed(1));
const clock = (ts) => new Date(ts).toTimeString().slice(0, 8);

export class TrainerTab {
  constructor(app) {
    this.app = app;
    this.sampler = new FrameSampler(performance.now());
    this.detector = new EWGFDetector();
    this.history = [];
    this.total = 0;
    this.electrics = 0;
    this.speedSum = 0;
    this.best = null;
    this.last = null;
    this.streak = 0;
    this.bestStreak = 0;
    this.recent = [];        // last 50 results (true = Electric) for the rate board
    this.guideOn = false;
    this.painter = new Painter($("t-hist"));

    const variant = $("t-variant");
    for (const v of VARIANTS) variant.add(new Option(v.label, v.id));
    variant.value = settings.variant;
    variant.onchange = () => {
      settings.variant = variant.value;
      saveSettings();
      if (this.guideOn) this.startGuide();
    };
    const speed = $("t-speed");
    for (const s of SPEEDS) speed.add(new Option(s.label, s.slow));
    speed.onchange = () => { if (this.guideOn) this.startGuide(); };

    $("t-guide").onclick = () => (this.guideOn ? this.stopGuide() : this.startGuide());
    $("t-reset").onclick = () => this.reset();
    this.updateStats();
  }

  // -- input / judging ----------------------------------------------------
  feed(kind, btn, t) { this.sampler.feed(kind, btn, t); }

  tick(now, active) {
    for (const fr of this.sampler.advance(now - FRAME_GRACE_MS)) {
      for (const res of this.detector.step(fr)) if (active) this.show(res);
    }
  }

  show(r) {
    if (r.kind === "no_attack") {
      $("t-sub").textContent = "Crouch dash detected - no 2 pressed";
      return;
    }
    const color = resultColor(r);
    $("t-title").textContent = resultTitle(r);
    // Total input time from f to df+2 - only meaningful once the motion was finished
    $("t-frames").textContent = r.kind === "fail" ? "" : inputFrames(r.movement);
    $("t-title").style.color = color;
    let sub;
    if (r.electric) sub = r.movement <= 4 ? "Clean" : r.movement <= 6 ? "A bit slow" : "Slow";
    else sub = r.reason;
    let more = r.shortcut ? "f, n, df shortcut" : "";
    const target = targetSpeed(variantById(settings.variant).events);
    if (r.electric) {
      const delta = r.speed - target;
      more += (more ? "   ·   " : "") + `target i${target}: ` + (delta === 0 ? "on target"
        : `${Math.abs(delta)} frame${Math.abs(delta) > 1 ? "s" : ""} ${delta > 0 ? "slower" : "faster"}`);
    }
    if (r.kind !== "electric" && r.raw.jf !== null && r.jf !== null && r.jf !== 0 && Math.abs(r.raw.jf) < FRAME_MS) {
      more += (more ? "   ·   " : "") + `only ${Math.abs(r.raw.jf).toFixed(1)} ms apart, but on different frames`;
    }
    $("t-sub").textContent = sub;
    $("t-more").textContent = more;

    const put = (key, ms, fr, fg = C.FG) => {
      $(`b-${key}-ms`).textContent = ms;
      $(`b-${key}-fr`).textContent = fr;
      $(`b-${key}-ms`).style.color = fg;
      $(`b-${key}-fr`).style.color = fg;
    };
    put("f", fmtMs(r.raw.f), String(r.fFrames));
    put("n", fmtMs(r.raw.n), String(r.nFrames));
    put("d", fmtMs(r.raw.d), String(r.dFrames));
    const rawMv = [r.raw.f, r.raw.n, r.raw.d];
    put("mv", rawMv.includes(null) ? "-" : fmtMs(rawMv.reduce((a, b) => a + b, 0)), String(r.movement), color);
    if (r.jf === null) put("jf", "-", "-", C.RED);
    else {
      const jfTxt = r.jf === 0 ? "same frame" : `${r.jf > 0 ? "+" : ""}${r.jf} ${r.jf > 0 ? "late" : "early"}`;
      put("jf", r.raw.jf === null ? "-" : (r.raw.jf >= 0 ? "+" : "") + r.raw.jf.toFixed(1), jfTxt, r.electric ? C.GREEN : C.RED);
    }

    this.total += 1;
    if (r.electric) {
      this.electrics += 1;
      this.speedSum += r.speed;
      this.best = this.best === null ? r.speed : Math.min(this.best, r.speed);
      this.streak += 1;
      this.bestStreak = Math.max(this.bestStreak, this.streak);
      this.app.report("ewgf_streak", this.streak);
      if (r.speed === 13) this.app.count("i13_count");
    } else this.streak = 0;
    this.recent.push(r.electric);
    if (this.recent.length > RATE_WINDOW) this.recent.shift();
    if (this.recent.length === RATE_WINDOW) this.app.report("ewgf_rate50", this.recent.filter(Boolean).length);
    this.history.unshift(r);
    this.history.length = Math.min(this.history.length, HISTORY_SIZE);
    this.last = r;
    this.updateStats();
    this.renderLog();

    if (settings.resultSounds) {
      if (r.electric && r.speed <= CHIME_MAX_SPEED) audio.play(r.speed <= 14 ? "electric_best" : "electric");
      else if (!r.electric) audio.play("drop");
    }
  }

  renderLog() {
    const ol = $("t-log");
    ol.replaceChildren(...this.history.map((r) => {
      let head;
      if (r.electric) head = `i${String(r.speed).padEnd(3)} ELECTRIC`;
      else if (r.kind === "wgf_late") head = "WGF  late    ";
      else if (r.kind === "early") head = "DROP 2 early ";
      else head = "DROP motion  ";
      const jf = r.jf === null ? "--" : `${r.jf >= 0 ? "+" : ""}${r.jf}f`;
      let line = `${clock(r.timestamp)}  ${head}  f${r.fFrames} n${r.nFrames} d${r.dFrames} = ${r.movement}f  jf ${jf.padStart(3)}`;
      if (r.kind === "fail") line += `  ${r.reason}`;
      const li = document.createElement("li");
      li.textContent = line;
      li.style.color = resultColor(r);
      return li;
    }));
  }

  updateStats() {
    const el = $("t-stats-full");
    const rateTxt = this.total ? `${Math.round((100 * this.electrics) / this.total)}%` : "-";
    renderChips($("t-stats"), [["Electric", rateTxt], ["Streak", String(this.streak)],
      ["Fastest input", this.best ? `${this.best - EWGF_BASE_STARTUP}f` : "-"]]);
    if (this.total === 0) { el.textContent = "Attempts 0   ·   Electric -   ·   Streak 0   ·   Avg -   ·   Best -"; return; }
    const rate = (100 * this.electrics) / this.total;
    const avg = this.electrics ? `i${(this.speedSum / this.electrics).toFixed(1)}` : "-";
    const best = this.best ? `i${this.best}` : "-";
    const l10 = this.history.filter((h) => h.electric).length;
    el.textContent = `Attempts ${this.total}   ·   Electric ${rate.toFixed(0)}%   ·   Last ${this.history.length}: ${l10}/${this.history.length}   ·   `
      + `Streak ${this.streak} (best ${this.bestStreak})   ·   Avg ${avg}   ·   Best ${best}`;
  }

  reset() {
    this.history = [];
    this.total = this.electrics = this.speedSum = 0;
    this.streak = this.bestStreak = 0;
    this.recent = [];
    this.best = null;
    this.last = null;
    $("t-title").textContent = "Ready";
    $("t-frames").textContent = "";
    $("t-title").style.color = C.FG;
    $("t-sub").textContent = "f, n, d, df+2";
    $("t-more").textContent = "";
    for (const k of ["f", "n", "d", "mv", "jf"]) {
      for (const s of ["ms", "fr"]) { $(`b-${k}-${s}`).textContent = "-"; $(`b-${k}-${s}`).style.color = C.FG; }
    }
    this.renderLog();
    this.updateStats();
  }

  // -- audio guide --------------------------------------------------------
  startGuide() {
    this.app.stopGames();
    audio.startLoop(variantById($("t-variant").value).events, Number($("t-speed").value));
    this.guideOn = true;
    $("t-guide").textContent = "Stop rhythm";
    $("t-guide").className = "btn gold";
  }

  stopGuide() {
    if (!this.guideOn) return;
    audio.stopLoop();
    this.guideOn = false;
    $("t-guide").textContent = "Play rhythm";
    $("t-guide").className = "btn primary";
  }

  // -- drawing ------------------------------------------------------------
  draw() {
    const p = this.painter.begin(C.PANEL);
    const r = this.last;
    if (!r || !r.frames.length) {
      p.message(["Your inputs show up here"], C.MUTED);
      return;
    }
    const frames = r.frames;
    const n = frames.length;
    const target = variantById(settings.variant).events;
    const span = Math.max(n, Math.max(...target.map((e) => e[0])) + 1);
    const mmin = -1, mmax = span + 1;
    const left = 78, right = 12;
    const colw = (p.W - left - right) / (mmax - mmin);
    const X = (m) => left + (m - mmin) * colw;
    const top = 10, bottom = 158;
    for (let m = mmin; m < mmax; m++) {
      p.rect(X(m), top, X(m + 1), bottom + 24, m % 2 === 0 ? C.CELL : C.PANEL);
      p.line(X(m), top, X(m), bottom + 24, C.LINE);
      p.text(X(m + 0.5), bottom + 36, String(m), { color: C.MUTED, size: 10, mono: true });
    }
    p.text(left - 8, bottom + 36, "frame", { color: C.MUTED, size: 10, align: "right" });
    const lanes = { f: [34, L.F, "→ f"], d: [76, L.D, "↓ d"], df: [118, L.DF, "↘ df+2"] };
    for (const [y, col, label] of Object.values(lanes)) p.text(8, y, label, { color: col, bold: true, size: 13, align: "left" });
    p.text(8, bottom + 12, "game read", { color: C.MUTED, bold: true, size: 11, align: "left" });

    for (const [fr, name] of target) {
      if (name === "f") continue;
      const [y, col] = lanes[name === "d" ? "d" : "df"];
      p.circle(X(fr + 0.5), y, 12, { stroke: col });
    }
    frames.forEach((fr, i) => {
      for (const key of ["f", "d"]) {
        if (fr.active.has(key)) { const [y, col] = lanes[key]; p.rect(X(i), y - 5, X(i + 1), y + 5, col); }
      }
      const ydf = lanes.df[0];
      if (fr.dir === "df") p.rect(X(i) + 3, ydf - 9, X(i + 1) - 3, ydf + 9, L.DF);
      if (fr.pressed.has("2")) {
        p.box(X(i) + 1, ydf - 16, X(i + 1) - 1, ydf + 16, L.TWO, 2);
        p.text(X(i + 0.5), ydf - 25, "2", { color: L.TWO, bold: true, size: 13, mono: true });
      }
      const startT = this.sampler.t0 + fr.index * FRAME_MS;
      for (const [kind, btn, t] of fr.events) {
        if (kind === "press" && (btn === "f" || btn === "d")) {
          p.circle(X(i + (t - startT) / FRAME_MS), lanes[btn][0], 5, { fill: C.FG });
        }
      }
      const col = DIR_COLORS[fr.dir] || C.RED;
      p.rect(X(i) + 1, bottom + 1, X(i + 1) - 1, bottom + 23, col);
      p.text(X(i + 0.5), bottom + 12, ARROWS[fr.dir] || fr.dir,
        { color: ["f", "d"].includes(fr.dir) ? C.INK : C.FG, bold: true, size: 14 });
    });
    if (!r.electric) p.box(X(n - 1), top, X(n), bottom + 24, C.RED, 2);
  }
}
