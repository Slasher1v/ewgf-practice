// Wires the three tabs, settings, sound and the main loop together.

import { FRAME_MS, settings, saveSettings, resetSettings, keyName, padName, ATTACKS } from "./config.js";
import * as audio from "./audio.js";
import * as input from "./input.js";
import { TrainerTab } from "./trainer.js";
import { RhythmTab } from "./rhythm.js";
import { DFTab } from "./dfgame.js";

const $ = (id) => document.getElementById(id);

let current = "trainer";
const app = {
  selectTab(name) {
    current = name;
    for (const b of document.querySelectorAll(".tab")) b.classList.toggle("active", b.dataset.tab === name);
    for (const s of document.querySelectorAll(".tabpage")) s.hidden = s.id !== `tab-${name}`;
    if (name !== "rhythm") rhythm.stop();
    if (name !== "df") df.stop();
    if (name !== "trainer") trainer.stopGuide();
  },
  // something new is starting: silence everything else
  stopOthers(who) {
    trainer.stopGuide();
    if (who !== "rhythm") rhythm.stop();
    if (who !== "df") df.stop();
  },
  stopGames() { rhythm.stop(); df.stop(); },
};

const trainer = new TrainerTab(app);
const rhythm = new RhythmTab(app);
const df = new DFTab(app);

for (const b of document.querySelectorAll(".tab")) b.onclick = () => app.selectTab(b.dataset.tab);

// ---------------------------------------------------------------------------
// Input -> all tabs, lamps and input tones
// ---------------------------------------------------------------------------
let lastDfT = -1e9;
input.onInput((kind, btn, t) => {
  trainer.feed(kind, btn, t);
  rhythm.feed(kind, btn, t);
  df.feed(kind, btn, t);
  const lamp = document.querySelector(`#lamps [data-btn="${btn}"]`);
  if (lamp) lamp.classList.toggle("on", kind === "press");
  if (kind !== "press" || !settings.inputTones) return;
  if (btn === "f" || btn === "d") {
    if (input.isDown(btn === "f" ? "d" : "f")) { lastDfT = t; audio.play("df"); }
    else audio.play(btn);
  } else if (btn === "2" && t - lastDfT > FRAME_MS) audio.play("2");
});

// ---------------------------------------------------------------------------
// Sound needs one click / key press before the browser allows it
// ---------------------------------------------------------------------------
function tryUnlock() {
  audio.unlock();
  setTimeout(refreshSoundState, 50);
}
function refreshSoundState() {
  $("banner-sound").hidden = audio.ready();
  const lat = audio.latencyMs();
  $("r-latency").textContent = audio.ready() && lat ? `Audio latency ${Math.round(lat)} ms (compensated for the cues)` : "";
}
window.addEventListener("pointerdown", tryUnlock, true);
window.addEventListener("keydown", tryUnlock, true);
$("banner-sound").onclick = tryUnlock;

// The page only hears keys while it's focused
input.onFocusChange((focused) => { $("banner-focus").hidden = focused; });
$("banner-focus").onclick = () => { $("banner-focus").hidden = true; window.focus(); };

if (matchMedia("(pointer: coarse)").matches && !matchMedia("(pointer: fine)").matches) {
  $("banner-mobile").hidden = false;
  window.addEventListener("gamepadconnected", () => { $("banner-mobile").hidden = true; });
}

// ---------------------------------------------------------------------------
// Settings dialog
// ---------------------------------------------------------------------------
const KEY_ROWS = [["f", "→ Forward"], ["b", "← Back"], ["d", "↓ Down"], ["u", "↑ Up"],
  ["1", "1 (LP)"], ["2", "2 (RP)"], ["3", "3 (LK)"], ["4", "4 (RK)"]];

function refreshKeyHint() {
  const k = settings.keys;
  const fwd = settings.sideSwap ? k.b : k.f;
  $("keyhint").textContent = `→ ${keyName(fwd)}   ↓ ${keyName(k.d)}   2 ${keyName(k[2])}`;
  df.updateHelp();
}

function bindRow(label, valueText, onClick) {
  const row = document.createElement("div");
  row.className = "bind";
  const span = document.createElement("span");
  span.textContent = label;
  const btn = document.createElement("button");
  btn.type = "button";
  btn.textContent = valueText;
  btn.onclick = () => onClick(btn);
  row.append(span, btn);
  return row;
}

function buildBindings() {
  $("s-keys").replaceChildren(...KEY_ROWS.map(([btn, label]) => bindRow(label, keyName(settings.keys[btn]), (el) => {
    el.textContent = "press…";
    el.classList.add("listening");
    input.captureNext((res) => {
      if (res && res.type === "key") {
        // a key can only do one thing: swap with whatever used it before
        for (const [other, code] of Object.entries(settings.keys)) {
          if (code === res.code && other !== btn) settings.keys[other] = settings.keys[btn];
        }
        settings.keys[btn] = res.code;
        saveSettings();
      }
      buildBindings();
      refreshKeyHint();
    });
  })));
  $("s-pad").replaceChildren(...ATTACKS.map((btn) => bindRow(`Button ${btn}`, padName(settings.pad[btn]), (el) => {
    el.textContent = "press…";
    el.classList.add("listening");
    input.captureNext((res) => {
      if (res && res.type === "pad") {
        for (const [other, idx] of Object.entries(settings.pad)) {
          if (idx === res.index && other !== btn) settings.pad[other] = settings.pad[btn];
        }
        settings.pad[btn] = res.index;
        saveSettings();
      }
      buildBindings();
    });
  })));
  $("s-pad-state").textContent = input.controllerConnected() ? "Controller detected ✓" : "No controller detected yet - press a button on it.";
}

function syncSettingsUI() {
  $("s-side").checked = settings.sideSwap;
  $("s-socd").value = settings.socdH;
  for (const id of ["s-volume", "t-volume"]) $(id).value = settings.volume;
  for (const id of ["s-tones", "t-tones"]) $(id).checked = settings.inputTones;
  for (const id of ["s-results", "t-results"]) $(id).checked = settings.resultSounds;
  $("s-offset").value = settings.audioOffset;
}

$("open-settings").onclick = () => { buildBindings(); syncSettingsUI(); $("settings").showModal(); };
$("settings").addEventListener("close", () => { input.cancelCapture(); saveSettings(); });
$("s-side").onchange = (e) => { input.releaseAll(); settings.sideSwap = e.target.checked; saveSettings(); refreshKeyHint(); };
$("s-socd").onchange = (e) => { settings.socdH = settings.socdV = e.target.value; saveSettings(); };
for (const id of ["s-volume", "t-volume"]) {
  $(id).oninput = (e) => { audio.setVolume(Number(e.target.value)); saveSettings(); syncSettingsUI(); };
}
for (const id of ["s-tones", "t-tones"]) $(id).onchange = (e) => { settings.inputTones = e.target.checked; saveSettings(); syncSettingsUI(); };
for (const id of ["s-results", "t-results"]) $(id).onchange = (e) => { settings.resultSounds = e.target.checked; saveSettings(); syncSettingsUI(); };
$("s-offset").onchange = (e) => {
  const v = parseInt(e.target.value, 10);
  settings.audioOffset = Number.isFinite(v) ? Math.max(-100, Math.min(300, v)) : 0;
  e.target.value = settings.audioOffset;
  saveSettings();
};
$("s-reset").onclick = () => { resetSettings(); audio.setVolume(settings.volume); buildBindings(); syncSettingsUI(); refreshKeyHint(); };

syncSettingsUI();
refreshKeyHint();

// ---------------------------------------------------------------------------
// Main loop: judge often, draw every display frame
// ---------------------------------------------------------------------------
setInterval(() => {
  const now = performance.now();
  trainer.tick(now, current === "trainer");
  rhythm.tick(now);
  df.tick(now);
}, 4);

function frame() {
  const now = performance.now();
  if (current === "trainer") trainer.draw();
  else if (current === "rhythm") rhythm.draw(now);
  else df.draw(now);
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

// for automated checks
window.__ewgf = { app, trainer, rhythm, df, input, audio, settings };
