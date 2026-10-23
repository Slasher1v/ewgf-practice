// Keyboard + controller input -> logical buttons (f b d u 1 2 3 4) with
// precise timestamps on the performance.now() clock.

import { settings } from "./config.js?v=20261023202411";

const subscribers = new Set();
export const onInput = (fn) => subscribers.add(fn);
const focusSubs = new Set();
export const onFocusChange = (fn) => focusSubs.add(fn);

// logical button -> set of sources holding it ("k:KeyD", "p0:12", ...)
const holders = new Map();
export const isDown = (btn) => (holders.get(btn)?.size ?? 0) > 0;
export const heldButtons = () => new Set([...holders.keys()].filter(isDown));

let capture = null; // rebinding: called with {type:"key", code} or {type:"pad", index}
export function captureNext(cb) { capture = cb; }
export function cancelCapture() { capture = null; }
export const capturing = () => capture !== null;

function sane(t) {
  const now = performance.now();
  return typeof t === "number" && t > now - 500 && t <= now + 1 ? t : now;
}

function emit(kind, btn, t) {
  for (const fn of subscribers) fn(kind, btn, t);
}

function hold(btn, source, t) {
  let s = holders.get(btn);
  if (!s) holders.set(btn, (s = new Set()));
  if (s.has(source)) return;
  const was = s.size > 0;
  s.add(source);
  if (!was) emit("press", btn, t);
}

function letGo(btn, source, t) {
  const s = holders.get(btn);
  if (!s || !s.has(source)) return;
  s.delete(source);
  if (s.size === 0) emit("release", btn, t);
}

export function releaseAll() {
  const t = performance.now();
  for (const [btn, s] of holders) {
    if (s.size) { s.clear(); emit("release", btn, t); }
  }
}

// 2P side: the physical "forward" key/direction becomes back.
const sideMap = (btn) => (settings.sideSwap ? ({ f: "b", b: "f" }[btn] || btn) : btn);

function btnForCode(code) {
  for (const [btn, c] of Object.entries(settings.keys)) if (c === code) return sideMap(btn);
  return null;
}

const isFormField = (el) => el && (el.tagName === "INPUT" || el.tagName === "SELECT" || el.tagName === "TEXTAREA");
// Username / password boxes: let the player type, game keys pause meanwhile.
const isTextEntry = (el) => el && el.tagName === "INPUT" && (el.type === "text" || el.type === "password");

window.addEventListener("keydown", (e) => {
  if (capture) {
    e.preventDefault();
    if (e.code !== "Escape") { const cb = capture; capture = null; cb({ type: "key", code: e.code }); }
    else { const cb = capture; capture = null; cb(null); }
    return;
  }
  if (isTextEntry(document.activeElement)) return;
  const btn = btnForCode(e.code);
  if (!btn) {
    if ((e.key === "Enter" || e.key === "Escape") && isFormField(document.activeElement)) document.activeElement.blur();
    return;
  }
  // Game keys always go to the game: never type into a settings box.
  e.preventDefault();
  if (isFormField(document.activeElement)) document.activeElement.blur();
  if (e.repeat) return;
  hold(btn, "k:" + e.code, sane(e.timeStamp));
}, true);

window.addEventListener("keyup", (e) => {
  const btn = btnForCode(e.code);
  if (!btn) return;
  if (!isTextEntry(document.activeElement)) e.preventDefault();
  letGo(btn, "k:" + e.code, sane(e.timeStamp));
}, true);

window.addEventListener("blur", () => {
  releaseAll();
  for (const fn of focusSubs) fn(false);
});
window.addEventListener("focus", () => { for (const fn of focusSubs) fn(true); });
// Starting to type into a text box lets go of anything held, so no key sticks.
window.addEventListener("focusin", (e) => { if (isTextEntry(e.target)) releaseAll(); });

// ---------------------------------------------------------------------------
// Controllers (standard mapping): d-pad or left stick for directions,
// face buttons for 1-4 (remappable in Settings).
// ---------------------------------------------------------------------------
const padPrev = new Map(); // pad index -> {buttons: bool[], logical: Set}
let padSeen = false;
export const controllerConnected = () => padSeen;

function pollPads() {
  const pads = navigator.getGamepads ? navigator.getGamepads() : [];
  for (const gp of pads) {
    if (!gp || !gp.connected) continue;
    padSeen = true;
    const t = sane(gp.timestamp);
    const prev = padPrev.get(gp.index) || { buttons: [], logical: new Set() };
    const pressedNow = gp.buttons.map((b) => b.pressed || b.value > 0.5);

    if (capture) {
      const i = pressedNow.findIndex((p, k) => p && !prev.buttons[k] && k < 12);
      if (i >= 0) { const cb = capture; capture = null; cb({ type: "pad", index: i }); }
    }

    const logical = new Set();
    const ax = gp.axes[0] ?? 0, ay = gp.axes[1] ?? 0;
    if (pressedNow[12] || ay < -0.5) logical.add("u");
    if (pressedNow[13] || ay > 0.5) logical.add("d");
    if (pressedNow[14] || ax < -0.5) logical.add(sideMap("b"));
    if (pressedNow[15] || ax > 0.5) logical.add(sideMap("f"));
    for (const [btn, idx] of Object.entries(settings.pad)) if (pressedNow[idx]) logical.add(btn);

    const src = "p" + gp.index;
    for (const b of logical) if (!prev.logical.has(b)) hold(b, src, t);
    for (const b of prev.logical) if (!logical.has(b)) letGo(b, src, t);
    padPrev.set(gp.index, { buttons: pressedNow, logical });
  }
}

window.addEventListener("gamepadconnected", () => { padSeen = true; });
setInterval(pollPads, 4);
