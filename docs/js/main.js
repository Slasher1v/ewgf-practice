// Wires the three tabs, settings, sound and the main loop together.

import { FRAME_MS, settings, saveSettings, resetSettings, keyName, padName, ATTACKS } from "./config.js?v=20261023214640";
import * as audio from "./audio.js?v=20261023214640";
import * as input from "./input.js?v=20261023214640";
import { TrainerTab } from "./trainer.js?v=20261023214640";
import { RhythmTab } from "./rhythm.js?v=20261023214640";
import { DFTab } from "./dfgame.js?v=20261023214640";
import * as lb from "./leaderboard.js?v=20261023214640";

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
    if (name === "board") board.show();
  },
  // something new is starting: silence everything else
  stopOthers(who) {
    trainer.stopGuide();
    if (who !== "rhythm") rhythm.stop();
    if (who !== "df") df.stop();
  },
  stopGames() { rhythm.stop(); df.stop(); },
  report(id, value) { lb.report(id, value); },
  count(id) { lb.add(id, 1); },
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
  $("s-volume").value = settings.volume;
  $("s-tones").checked = settings.inputTones;
  $("s-results").checked = settings.resultSounds;
  $("s-offset").value = settings.audioOffset;
}

$("open-settings").onclick = () => { buildBindings(); syncSettingsUI(); $("settings").showModal(); };
$("settings").addEventListener("close", () => { input.cancelCapture(); saveSettings(); });
$("s-side").onchange = (e) => { input.releaseAll(); settings.sideSwap = e.target.checked; saveSettings(); refreshKeyHint(); };
$("s-socd").onchange = (e) => { settings.socdH = settings.socdV = e.target.value; saveSettings(); };
$("s-volume").oninput = (e) => { audio.setVolume(Number(e.target.value)); saveSettings(); };
$("s-tones").onchange = (e) => { settings.inputTones = e.target.checked; saveSettings(); };
$("s-results").onchange = (e) => { settings.resultSounds = e.target.checked; saveSettings(); };
$("s-offset").onchange = (e) => {
  const v = parseInt(e.target.value, 10);
  settings.audioOffset = Number.isFinite(v) ? Math.max(-100, Math.min(300, v)) : 0;
  e.target.value = settings.audioOffset;
  saveSettings();
};
$("s-reset").onclick = () => { resetSettings(); audio.setVolume(settings.volume); buildBindings(); syncSettingsUI(); refreshKeyHint(); };

syncSettingsUI();
refreshKeyHint();

// Nerd mode: ms breakdowns, logs and extra options
function applyNerd() {
  document.body.classList.toggle("nerd-on", settings.nerd);
  $("nerd-toggle").setAttribute("aria-pressed", String(settings.nerd));
}
$("nerd-toggle").onclick = () => { settings.nerd = !settings.nerd; saveSettings(); applyNerd(); };
applyNerd();

// ---------------------------------------------------------------------------
// Leaderboard tab
// ---------------------------------------------------------------------------
const fmtWhen = (iso) => {
  const d = new Date(iso);
  const days = Math.floor((Date.now() - d.getTime()) / 86400000);
  if (days < 1) return "today";
  if (days < 2) return "yesterday";
  if (days < 30) return `${days} days ago`;
  return d.toLocaleDateString();
};

const board = {
  current: lb.BOARDS[0].id,
  busy: false,
  loadedAt: 0,

  setup() {
    $("lb-off").hidden = lb.configured();
    $("lb-on").hidden = !lb.configured();
    $("open-account").hidden = !lb.configured();
    if (!lb.configured()) return;
    $("lb-boards").replaceChildren(...lb.BOARDS.map((b) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.dataset.board = b.id;
      const t = document.createElement("b");
      t.textContent = b.title;
      const sub = document.createElement("span");
      sub.textContent = b.tab;
      btn.append(t, sub);
      btn.onclick = () => { this.current = b.id; this.load(); };
      return btn;
    }));
    $("lb-form").onsubmit = (e) => { e.preventDefault(); this.auth("in"); };
    $("lb-signup").onclick = () => this.auth("up");
    $("lb-signout").onclick = async () => { await lb.signOut().catch(() => {}); this.msg(""); };
    $("lb-refresh").onclick = () => this.load();
    $("open-account").onclick = () => app.selectTab("board");
    lb.onChange(() => this.renderAccount());
    this.renderAccount();
    lb.init();
  },

  msg(text, ok = false) {
    $("lb-msg").textContent = text;
    $("lb-msg").classList.toggle("ok", ok);
  },

  async auth(kind) {
    if (this.busy) return;
    this.busy = true;
    for (const id of ["lb-signin", "lb-signup"]) $(id).disabled = true;
    this.msg(kind === "up" ? "Creating your account…" : "Signing in…", true);
    try {
      if (kind === "up") await lb.signUp($("lb-user").value, $("lb-pass").value);
      else await lb.signIn($("lb-user").value, $("lb-pass").value);
      $("lb-pass").value = "";
      document.activeElement?.blur();
      this.msg(kind === "up" ? "Account created - your best runs will now be saved." : "Signed in.", true);
      this.load();
    } catch (e) {
      this.msg(e.message);
    } finally {
      this.busy = false;
      for (const id of ["lb-signin", "lb-signup"]) $(id).disabled = false;
    }
  },

  renderAccount() {
    const u = lb.currentUser();
    $("lb-form").hidden = Boolean(u);
    $("lb-hint").hidden = Boolean(u);
    $("lb-me").hidden = !u;
    $("open-account").textContent = u ? u.username : "Sign in";
    if (u) {
      $("lb-name").textContent = u.username;
      const bests = lb.BOARDS.filter((b) => lb.myBest(b.id) !== null).map((b) => `${b.title} ${b.fmt(lb.myBest(b.id))}`);
      $("lb-mybests").textContent = bests.length ? bests.join(" · ") : "No scores yet";
    }
    // a new personal best may have changed the table
    if (current === "board" && Date.now() - this.loadedAt > 2000) this.load();
  },

  show() { if (lb.configured()) this.load(); },

  async load() {
    if (!lb.configured()) return;
    const b = lb.boardById(this.current);
    for (const el of $("lb-boards").children) el.classList.toggle("active", el.dataset.board === b.id);
    $("lb-how").textContent = b.how;
    this.loadedAt = Date.now();
    const rowsEl = $("lb-rows");
    const cell = (text, cls) => {
      const td = document.createElement("td");
      td.textContent = text;
      if (cls) td.className = cls;
      return td;
    };
    try {
      const rows = await lb.top(b.id);
      if (this.current !== b.id) return;
      const me = lb.currentUser();
      if (!rows.length) {
        const tr = document.createElement("tr");
        const td = cell("No scores yet - be the first!", "empty");
        td.colSpan = 4;
        tr.append(td);
        rowsEl.replaceChildren(tr);
        return;
      }
      rowsEl.replaceChildren(...rows.map((r, i) => {
        const tr = document.createElement("tr");
        if (me && r.userId === me.id) tr.classList.add("me");
        if (i === 0) tr.classList.add("top1");
        tr.append(cell(String(i + 1)), cell(r.username), cell(`${b.fmt(r.value)} ${b.unit}`), cell(fmtWhen(r.at), "nerd-cell"));
        return tr;
      }));
    } catch (e) {
      const tr = document.createElement("tr");
      const td = cell(e.message, "empty");
      td.colSpan = 4;
      tr.append(td);
      rowsEl.replaceChildren(tr);
    }
  },
};
board.setup();

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
  else if (current === "df") df.draw(now);
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

// for automated checks
window.__ewgf = { app, trainer, rhythm, df, input, audio, settings, lb, board };
