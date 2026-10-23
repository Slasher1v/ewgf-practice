// Soft synthesized tones (same recipes as the desktop app) on the Web Audio
// clock. Browsers only allow sound after the first click or key press, so
// call unlock() from a user gesture.

import { FRAME_MS, GUIDE_LOOP_MS, settings } from "./config.js?v=20261023214640";

let ctx = null;
let master = null;
let buffers = {};
let scheduled = [];   // [source, when] so a stop can cancel them
let loopSrc = null;

function tone(sr, freqs, dur, decay, amp, partials = [[1, 1.0], [2, 0.18], [3, 0.05]], attack = 0.004) {
  const n = Math.floor(sr * dur);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    let v = 0;
    for (const f of freqs) for (const [k, w] of partials) v += w * Math.sin(2 * Math.PI * f * k * t) * Math.exp((-t * k) / decay);
    out[i] = v * Math.min(t / attack, 1);
  }
  const fade = Math.min(n, Math.floor(sr * 0.008));
  for (let i = 0; i < fade; i++) out[n - fade + i] *= 1 - i / fade;
  let peak = 0;
  for (const v of out) peak = Math.max(peak, Math.abs(v));
  const g = amp / (peak || 1);
  for (let i = 0; i < n; i++) out[i] *= g;
  return out;
}

function sequence(sr, notes, total) {
  const out = new Float32Array(Math.floor(sr * total));
  for (const [start, s] of notes) {
    const i0 = Math.floor(sr * start);
    for (let i = 0; i < s.length && i0 + i < out.length; i++) out[i0 + i] += s[i];
  }
  return out;
}

function buildSamples(sr) {
  const bell = [[1, 1.0], [2, 0.12], [3.01, 0.04]];
  const [c6, e6, g6, c7] = [1046.5, 1318.5, 1568.0, 2093.0];
  return {
    f: tone(sr, [783.99], 0.10, 0.035, 0.50),
    d: tone(sr, [587.33], 0.10, 0.035, 0.50),
    df: tone(sr, [880.0, 1318.5], 0.16, 0.050, 0.55),
    2: tone(sr, [1174.7], 0.06, 0.020, 0.25),
    electric: sequence(sr, [[0.00, tone(sr, [c6], 0.45, 0.16, 0.40, bell)],
      [0.07, tone(sr, [e6], 0.40, 0.15, 0.36, bell)],
      [0.14, tone(sr, [g6], 0.45, 0.18, 0.34, bell)]], 0.65),
    electric_best: sequence(sr, [[0.00, tone(sr, [c6], 0.45, 0.16, 0.38, bell)],
      [0.06, tone(sr, [e6], 0.40, 0.15, 0.34, bell)],
      [0.12, tone(sr, [g6], 0.40, 0.16, 0.32, bell)],
      [0.18, tone(sr, [c7], 0.55, 0.22, 0.30, bell)]], 0.80),
    drop: tone(sr, [196.0, 246.9], 0.20, 0.060, 0.40, [[1, 1.0], [2, 0.1]]),
    great: tone(sr, [e6], 0.40, 0.15, 0.34, bell),
    electric_cue: sequence(sr, [[0.000, tone(sr, [1975.5, 2637.0], 0.30, 0.10, 0.45, bell)],
      [0.012, tone(sr, [3951.1], 0.20, 0.05, 0.12, bell)]], 0.32),
    click: tone(sr, [1480.0], 0.05, 0.012, 0.32, [[1, 1.0], [2.76, 0.25]]),
    click_accent: tone(sr, [1975.5], 0.06, 0.014, 0.40, [[1, 1.0], [2.76, 0.25]]),
  };
}

let samples = {};

function toBuffer(data) {
  const b = ctx.createBuffer(1, data.length, ctx.sampleRate);
  b.copyToChannel(data, 0);
  return b;
}

export function unlock() {
  if (!ctx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return false;
    ctx = new AC({ latencyHint: "interactive" });
    master = ctx.createGain();
    master.connect(ctx.destination);
    samples = buildSamples(ctx.sampleRate);
    for (const [k, v] of Object.entries(samples)) buffers[k] = toBuffer(v);
    setVolume(settings.volume);
  }
  if (ctx.state === "suspended") ctx.resume();
  return true;
}

export const ready = () => !!ctx && ctx.state === "running";

export function setVolume(v) {
  settings.volume = v;
  if (master) master.gain.value = (Math.max(0, Math.min(100, v)) / 100) ** 2;
}

export function latencyMs() {
  if (!ctx) return null;
  return ((ctx.outputLatency || 0) + (ctx.baseLatency || 0)) * 1000;
}

// perf.now() time -> audio clock time, so a sound is HEARD at `atMs`.
function toCtxTime(atMs) {
  if (ctx.getOutputTimestamp) {
    const ts = ctx.getOutputTimestamp();
    if (ts.performanceTime > 0) return ts.contextTime + (atMs - ts.performanceTime) / 1000;
  }
  return ctx.currentTime + (atMs - performance.now()) / 1000 - (ctx.outputLatency || ctx.baseLatency || 0);
}

function start(name, when) {
  const buf = buffers[name];
  if (!buf) return null;
  const src = ctx.createBufferSource();
  src.buffer = buf;
  src.connect(master);
  const now = ctx.currentTime;
  if (when <= now) src.start(0, Math.min(now - when, buf.duration)); // slightly late: skip in
  else src.start(when);
  return src;
}

export function play(name) {
  if (!ready()) return;
  start(name, 0);
}

export function schedule(name, atMs) {
  if (!ready()) return;
  const when = toCtxTime(atMs);
  const src = start(name, when);
  if (src) {
    scheduled.push(src);
    src.onended = () => { scheduled = scheduled.filter((s) => s !== src); };
  }
}

export function cancelScheduled() {
  const now = ctx ? ctx.currentTime : 0;
  for (const s of scheduled) {
    try { s.stop(now); } catch { /* already done */ }
  }
  scheduled = [];
}

// Looping rhythm guide for the Audio Trainer panel
export function startLoop(events, slow) {
  stopLoop();
  if (!ready()) return;
  const frameS = (FRAME_MS / 1000) * slow;
  const last = Math.max(...events.map((e) => e[0]));
  const lead = 0.08;
  const total = Math.max(slow === 1 ? GUIDE_LOOP_MS / 1000 : 0, lead + last * frameS + 0.7);
  const data = sequence(ctx.sampleRate, events.map(([fr, name]) => [lead + fr * frameS, samples[name]]), total);
  loopSrc = ctx.createBufferSource();
  loopSrc.buffer = toBuffer(data);
  loopSrc.loop = true;
  loopSrc.connect(master);
  loopSrc.start();
}

export function stopLoop() {
  if (loopSrc) {
    try { loopSrc.stop(); } catch { /* fine */ }
    loopSrc = null;
  }
}
