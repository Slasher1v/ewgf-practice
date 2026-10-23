// Shared constants and user settings for EWGF Practice (web).
// All times in this app are milliseconds on the performance.now() clock.

export const FPS = 60;
export const FRAME_MS = 1000 / FPS;          // 16.67 ms
export const EWGF_BASE_STARTUP = 11;         // i11 from the df+2 frame

// Command leniency (estimates - Bandai Namco doesn't publish these).
export const MAX_NEUTRAL_FRAMES = 8;
export const MAX_DOWN_FRAMES = 8;
export const WGF_LATE_WINDOW = 10;
export const FAIL_LOG_WINDOW = 10;

// Frames are finalised this long after they end, so slightly late events
// still land in the right frame.
export const FRAME_GRACE_MS = 25;

export const HISTORY_SIZE = 10;
export const CHIME_MAX_SPEED = 15;

// Rhythm guide variants: [game frame, sound], frame 0 = your first f.
export const VARIANTS = [
  { id: "i13", label: "i13 - f, n, df+2", events: [[0, "f"], [2, "df"]] },
  { id: "i14", label: "i14 - f, n, d, df+2", events: [[0, "f"], [2, "d"], [3, "df"]] },
  { id: "i15", label: "i15 - f, n, d, d, df+2", events: [[0, "f"], [2, "d"], [4, "df"]] },
  { id: "i16", label: "i16 - f, n, d, d, d, df+2", events: [[0, "f"], [2, "d"], [5, "df"]] },
];
export const DEFAULT_VARIANT = "i14";
export const variantById = (id) => VARIANTS.find((v) => v.id === id) || VARIANTS[1];
export const targetSpeed = (events) => Math.max(...events.map((e) => e[0])) + EWGF_BASE_STARTUP;

export const SPEEDS = [
  { slow: 1, label: "Real speed" },
  { slow: 2, label: "2x slower" },
  { slow: 4, label: "4x slower" },
  { slow: 8, label: "8x slower" },
];
export const speedLabel = (s) => (SPEEDS.find((x) => x.slow === s) || SPEEDS[0]).label;
export const GUIDE_LOOP_MS = 1000;

// Rhythm game
export const RHYTHM_SPEED_ORDER = [8, 4, 2, 1];
export const RHYTHM_PERFECT = 0.5;
export const RHYTHM_HISTORY = 8;

// df+2 game
export const DF_START_LEVEL = 10;
export const DF_LEVEL_DOWN = 3;
export const DF_BEAT_TOL_MS = 50;
export const DF_RANGE_AFTER_MS = 300;
export const DF_COUNT_IN = 3;
export const DF_REST_MS = 600;
export const DF_GAPS = [
  { gap: 2, label: "2 frames (f, n, df+2)" },
  { gap: 3, label: "3 frames (f, n, d, df+2)" },
];
export const DF_HISTORY = 8;

export const ATTACKS = ["1", "2", "3", "4"];

// Colours: graphite / white / one electric-blue accent. The names are roles:
// GOLD = best result & highlights, GREEN = clean / target zones, YELLOW = okay,
// ORANGE = slow, RED = miss, BLUE = prompts, PURPLE = spare.
export const C = {
  BG: "#0c0c0e", PANEL: "#141417", CELL: "#1c1c20", LINE: "#27272c", DIV: "#303036",
  FG: "#f5f5f7", MUTED: "#8e8e96", INK: "#0c0c0e",
  GOLD: "#5e9bff", GREEN: "#f5f5f7", YELLOW: "#c9c9cf", ORANGE: "#8e8e96",
  RED: "#ff5a5f", BLUE: "#f5f5f7", PURPLE: "#8e8e96",
};
// Inputs are told apart by brightness, with blue for the df+2 moment:
// f white, d gray, df blue, 2 white outline, n dark gray.
export const L = { F: "#f5f5f7", D: "#8e8e96", DF: "#5e9bff", TWO: "#ffffff", N: "#2c2c32" };
export const ARROWS = { n: "•", f: "→", b: "←", d: "↓", u: "↑", df: "↘", db: "↙", uf: "↗", ub: "↖" };
export const DIR_COLORS = { f: L.F, n: L.N, d: L.D, df: L.DF };

// ---------------------------------------------------------------------------
// User settings, saved in this browser only.
// ---------------------------------------------------------------------------
export const DEFAULT_SETTINGS = {
  keys: { f: "KeyD", b: "KeyA", d: "KeyS", u: "Space", 1: "KeyU", 2: "KeyI", 3: "KeyJ", 4: "KeyK" },
  // Standard gamepad buttons (Tekken default): 1 = Square/X, 2 = Triangle/Y,
  // 3 = Cross/A, 4 = Circle/B
  pad: { 1: 2, 2: 3, 3: 0, 4: 1 },
  sideSwap: false,          // playing on the 2P side: forward is the left direction
  socdH: "neutral",         // left+right together: "neutral" or "last"
  socdV: "neutral",
  volume: 35,
  inputTones: true,
  resultSounds: true,
  audioOffset: 0,
  variant: DEFAULT_VARIANT,
  nerd: false,              // show ms breakdowns, logs and extra options
};

const STORE_KEY = "ewgf-practice-settings-v1";

function load() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return structuredClone(DEFAULT_SETTINGS);
    const s = JSON.parse(raw);
    return {
      ...structuredClone(DEFAULT_SETTINGS), ...s,
      keys: { ...DEFAULT_SETTINGS.keys, ...(s.keys || {}) },
      pad: { ...DEFAULT_SETTINGS.pad, ...(s.pad || {}) },
    };
  } catch {
    return structuredClone(DEFAULT_SETTINGS);
  }
}

export const settings = load();

export function saveSettings() {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(settings));
  } catch {
    /* private window etc. - settings just won't persist */
  }
}

export function resetSettings() {
  Object.assign(settings, structuredClone(DEFAULT_SETTINGS));
  saveSettings();
}

// Friendly name for a KeyboardEvent.code
export function keyName(code) {
  if (!code) return "-";
  if (code.startsWith("Key")) return code.slice(3);
  if (code.startsWith("Digit")) return code.slice(5);
  if (code.startsWith("Numpad")) return "Num " + code.slice(6);
  const map = {
    Space: "Space", ArrowUp: "↑", ArrowDown: "↓", ArrowLeft: "←", ArrowRight: "→",
    ShiftLeft: "L-Shift", ShiftRight: "R-Shift", ControlLeft: "L-Ctrl", ControlRight: "R-Ctrl",
    AltLeft: "L-Alt", AltRight: "R-Alt", Semicolon: ";", Quote: "'", Comma: ",", Period: ".",
    Slash: "/", BracketLeft: "[", BracketRight: "]", Backslash: "\\", Minus: "-", Equal: "=",
    Enter: "Enter", Tab: "Tab", Backquote: "`",
  };
  return map[code] || code;
}

export const PAD_NAMES = {
  0: "A / Cross", 1: "B / Circle", 2: "X / Square", 3: "Y / Triangle",
  4: "LB / L1", 5: "RB / R1", 6: "LT / L2", 7: "RT / R2",
  8: "Back / Share", 9: "Start / Options", 10: "L3", 11: "R3",
};
export const padName = (i) => PAD_NAMES[i] ?? `Button ${i}`;
