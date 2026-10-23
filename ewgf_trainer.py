"""
EWGF Practice - Tekken 8 Electric Wind God Fist execution practice tool.

Works the way the game does: a free-running 60 fps clock samples your keys
once per frame, and the EWGF input  f, n, d, df+2  is judged on those
frames, not on raw milliseconds.

  * 2 must land on the SAME game frame as df. Two presses 3 ms apart can
    still fail if a frame boundary falls between them, exactly like in game.
  * The clock's frame boundaries are not synced to you (the game's aren't
    either), so the same timing can pass or fail depending on phase.

Audio guide: plays the rhythm of an i13 / i14 / i15 / i16 EWGF on loop
(at real speed or slowed down) so you can learn it by ear, and plays soft
tones for your own f, d and df inputs so you can hear your rhythm.

Install:  pip install pynput numpy sounddevice
Run:      python ewgf_trainer.py

The keyboard listener is global, so you can keep this window on top while
the game has focus.
"""

import math
import os
import queue
import sys
import tempfile
import threading
import time
import tkinter as tk
import wave
from tkinter import ttk
from collections import deque
from dataclasses import dataclass, field
from typing import Optional

try:
    from pynput import keyboard
except ImportError:  # pragma: no cover - friendly message for first run
    raise SystemExit("pynput is not installed. Run:  pip install pynput")

try:
    import numpy as np
except ImportError:
    np = None

try:
    import sounddevice as sd
except Exception:  # missing, or no PortAudio
    sd = None

try:
    import winsound  # Windows only, fallback when sounddevice is missing
except ImportError:
    winsound = None


# ---------------------------------------------------------------------------
# CONFIG - key bindings (1P side, facing right)
# Use a single character ('d', 'i', ...) or a pynput key name
# ('space', 'up', 'down', 'left', 'right', 'shift', ...).
# ---------------------------------------------------------------------------
KEY_FORWARD = "d"
KEY_BACK = "a"
KEY_DOWN = "s"
KEY_UP = "space"
KEY_LP = "u"   # 1
KEY_RP = "i"   # 2
KEY_LK = "j"   # 3
KEY_RK = "k"   # 4

# Simultaneous opposite directions (SOCD), e.g. back+forward held together.
#   "neutral" -> both cancel out (Tekken 8 keyboard default)
#   "last"    -> most recently pressed direction wins
SOCD_HORIZONTAL = "neutral"
SOCD_VERTICAL = "neutral"

# ---------------------------------------------------------------------------
# CONFIG - game timing
# ---------------------------------------------------------------------------
FPS = 60
FRAME_MS = 1000.0 / FPS      # 16.67 ms
EWGF_BASE_STARTUP = 11       # i11 attack startup from the df+2 frame

# Command leniency. Bandai Namco does not publish these buffer windows, so
# they are estimates - tighten or loosen them to taste.
MAX_NEUTRAL_FRAMES = 8       # neutral longer than this breaks the motion
MAX_DOWN_FRAMES = 8          # d longer than this before df breaks the motion
WGF_LATE_WINDOW = 10         # 2 this many frames after df still gives WGF
FAIL_LOG_WINDOW = 10         # log a broken motion if 2 is pressed within N frames

# Frames are finalised this long after they end, so slightly delayed
# keyboard events still land in the right frame.
FRAME_GRACE_MS = 25

HISTORY_SIZE = 10
CHIME_MAX_SPEED = 15         # success chime on i15 or faster electrics
ALWAYS_ON_TOP = True

# ---------------------------------------------------------------------------
# CONFIG - audio
# ---------------------------------------------------------------------------
MASTER_VOLUME = 35           # 0-100, starting volume
INPUT_SOUNDS = True          # soft tones on your own f / d / df inputs
RESULT_SOUNDS = True         # chime on fast electrics, soft thud on drops

# Rhythm guide variants: (game frame, sound) with frame 0 = first f.
# The df tone means "press df and 2 together".
GUIDE_VARIANTS = {
    "i13   f, n, df+2": [(0, "f"), (2, "df")],
    "i14   f, n, d, df+2": [(0, "f"), (2, "d"), (3, "df")],
    "i15   f, n, d, d, df+2": [(0, "f"), (2, "d"), (4, "df")],
    "i16   f, n, d, d, d, df+2": [(0, "f"), (2, "d"), (5, "df")],
}
GUIDE_DEFAULT = "i14   f, n, d, df+2"
GUIDE_SPEEDS = {"Real speed": 1, "2x slower": 2, "4x slower": 4, "8x slower": 8}
GUIDE_LOOP_SECONDS = 1.0     # one repetition per second at real speed

# ---------------------------------------------------------------------------
# CONFIG - rhythm game
# ---------------------------------------------------------------------------
RHYTHM_SPEED_ORDER = [8, 4, 2, 1]   # slow-down factors, slowest first
RHYTHM_BPM = 110                    # count-in tempo
RHYTHM_COUNT_IN = 3                 # clicks before your f
RHYTHM_REST = 0.6                   # seconds between reps
RHYTHM_LEVEL_UP = 5                 # clean reps in a row -> next faster speed
RHYTHM_LEVEL_DOWN = 3               # misses in a row -> back to a slower speed
RHYTHM_PERFECT = 0.5                # max error (in stretched frames) per note for PERFECT
AUDIO_OFFSET_MS = 0                 # raise if your headset/speakers lag (e.g. Bluetooth)
RHYTHM_HISTORY = 8

ATTACKS = ("1", "2", "3", "4")


# ---------------------------------------------------------------------------
# Frame sampler: raw key events -> one input state per 60 fps frame
# ---------------------------------------------------------------------------
@dataclass(frozen=True)
class FrameInput:
    index: int
    dir: str                 # n, f, b, d, u, df, db, uf, ub
    pressed: frozenset       # buttons newly pressed during this frame
    active: frozenset        # buttons the game sees as held this frame
    events: tuple            # raw (kind, btn, t) events inside this frame


class FrameSampler:
    """Quantises key events onto a 60 fps grid, like the game's input poll.

    A button counts as held for a frame if it is held when the frame ends
    or was pressed at any point during it (so a sub-frame tap still
    registers for one frame). A button released during a frame is not held
    on that frame.
    """

    def __init__(self, t0: float, frame_ms: float = FRAME_MS):
        self.t0 = t0
        self.frame_ms = frame_ms  # stretched in the rhythm game's slow modes
        self.next_frame = 0
        self.events: deque = deque()
        self.held: set[str] = set()
        self.press_t: dict[str, float] = {}

    def feed(self, kind: str, btn: str, t: float):
        self.events.append((kind, btn, t))

    def advance(self, now: float) -> list[FrameInput]:
        out = []
        frame_s = self.frame_ms / 1000
        if self.events:
            self.events = deque(sorted(self.events, key=lambda e: e[2]))
        while self.t0 + (self.next_frame + 1) * frame_s <= now:
            end = self.t0 + (self.next_frame + 1) * frame_s
            evs = []
            while self.events and self.events[0][2] < end:
                evs.append(self.events.popleft())
            pressed = set()
            for kind, btn, t in evs:
                if kind == "press":
                    if btn not in self.held:
                        pressed.add(btn)
                        self.held.add(btn)
                        self.press_t[btn] = t
                else:
                    self.held.discard(btn)
            active = self.held | pressed
            out.append(FrameInput(self.next_frame, self._direction(active),
                                  frozenset(pressed), frozenset(active),
                                  tuple(evs)))
            self.next_frame += 1
        return out

    def _axis(self, active, pos, neg, mode) -> str:
        p, n = pos in active, neg in active
        if p and n:
            if mode == "last":
                return pos if self.press_t.get(pos, 0) >= self.press_t.get(neg, 0) else neg
            return ""
        return pos if p else (neg if n else "")

    def _direction(self, active) -> str:
        v = self._axis(active, "d", "u", SOCD_VERTICAL)
        h = self._axis(active, "f", "b", SOCD_HORIZONTAL)
        return (v + h) or "n"


# ---------------------------------------------------------------------------
# EWGF detector: frame states -> results
# ---------------------------------------------------------------------------
@dataclass
class Attempt:
    start: int
    frames: list
    f: int = 1
    n: int = 0
    d: int = 0
    df_frame: Optional[int] = None
    early2: Optional[int] = None


@dataclass
class Result:
    kind: str           # electric, wgf_late, early, fail, no_attack
    reason: str
    f_frames: int
    n_frames: int
    d_frames: int
    movement_frames: int
    total_speed: int
    jf_frames: Optional[int]     # 2 frame minus df frame (0 = same frame)
    raw: dict                    # raw ms: f, n, d, jf (None if unknown)
    timeline: list               # [(dir, pressed_set), ...] per frame
    shortcut: bool
    timestamp: float = field(default_factory=time.time)
    frames: list = field(default_factory=list)   # FrameInputs, for the input history

    @property
    def electric(self) -> bool:
        return self.kind == "electric"


IDLE, ST_F, ST_N, ST_D, ST_PEND = range(5)


class EWGFDetector:
    """Frame-by-frame state machine for  f, n, d, df+2  (or f, n, df+2)."""

    def __init__(self):
        self.state = IDLE
        self.a: Optional[Attempt] = None
        self.last_fail: Optional[tuple] = None  # (Result, frame index)

    def step(self, fr: FrameInput) -> list[Result]:
        out: list[Result] = []
        d = fr.dir
        p2 = "2" in fr.pressed

        if self.state == ST_PEND:
            a = self.a
            j = fr.index - a.df_frame
            if p2:
                a.frames.append(fr)
                out.append(self._result(
                    a, "wgf_late", f"2 pressed {j} frame{'s' if j > 1 else ''} after df", jf=j))
                self._reset()
                return out
            if j >= WGF_LATE_WINDOW or d not in ("df", "d"):
                out.append(self._result(a, "no_attack", "Crouch dash, no 2"))
                self._reset()
            else:
                a.frames.append(fr)
                return out

        if self.state == IDLE:
            if p2 and self.last_fail and fr.index - self.last_fail[1] <= FAIL_LOG_WINDOW:
                out.append(self.last_fail[0])
                self.last_fail = None
            if d == "f":
                self._start(fr)
            return out

        a = self.a
        a.frames.append(fr)
        if p2 and a.early2 is None:
            a.early2 = fr.index

        if self.state == ST_F:
            if d == "f":
                a.f += 1
            elif d == "n":
                self.state, a.n = ST_N, 1
            elif d in ("d", "df"):
                out += self._fail(fr, f"No neutral: f went straight to {d}")
            else:
                out += self._fail(fr, f"Stray input: f went to {d}")
        elif self.state == ST_N:
            if d == "n":
                a.n += 1
                if a.n > MAX_NEUTRAL_FRAMES:
                    out += self._fail(fr, f"Neutral held too long ({a.n}f)")
            elif d == "d":
                self.state, a.d = ST_D, 1
            elif d == "df":
                out += self._reach_df(fr)
            elif d == "f":
                self._start(fr)  # f, n, f = forward dash; start over
            else:
                out += self._fail(fr, f"Stray input: neutral went to {d}")
        elif self.state == ST_D:
            if d == "d":
                a.d += 1
                if a.d > MAX_DOWN_FRAMES:
                    out += self._fail(fr, f"Held d too long ({a.d}f) before df")
            elif d == "df":
                out += self._reach_df(fr)
            elif d == "n":
                out += self._fail(fr, "Let go of d before reaching df")
            elif d == "f":
                out += self._fail(fr, "Skipped df: d went straight to f")
            else:
                out += self._fail(fr, f"Slid to {d} instead of df")
        return out

    # -- internals ----------------------------------------------------------
    def _reset(self):
        self.state = IDLE
        self.a = None

    def _start(self, fr: FrameInput):
        self.a = Attempt(start=fr.index, frames=[fr])
        self.state = ST_F
        if "2" in fr.pressed:
            self.a.early2 = fr.index

    def _fail(self, fr: FrameInput, reason: str) -> list[Result]:
        a = self.a
        r = self._result(a, "fail", reason)
        self._reset()
        out = []
        if a.early2 is not None:
            out.append(r)  # 2 was pressed, so this was an attempt
            self.last_fail = None
        else:
            self.last_fail = (r, fr.index)  # log only if 2 follows soon
        if fr.dir == "f":
            self._start(fr)
        return out

    def _reach_df(self, fr: FrameInput) -> list[Result]:
        a = self.a
        a.df_frame = fr.index
        p2 = "2" in fr.pressed
        extra = sorted(fr.pressed & {"1", "3", "4"})
        if a.early2 is not None and a.early2 < fr.index:
            j = a.early2 - fr.index
            r = self._result(a, "early",
                             f"2 pressed {-j} frame{'s' if j < -1 else ''} before df", jf=j)
        elif p2 and extra:
            r = self._result(a, "fail", f"Extra button: df+2+{'+'.join(extra)}", jf=0)
        elif p2:
            r = self._result(a, "electric", "df and 2 on the same frame", jf=0)
        else:
            self.state = ST_PEND
            return []
        self._reset()
        return [r]

    @staticmethod
    def _raw_ms(a: Attempt) -> dict:
        evs = sorted((e for fr in a.frames for e in fr.events), key=lambda e: e[2])

        def first(pred, after=None):
            for kind, btn, t in evs:
                if (after is None or t > after) and pred(kind, btn):
                    return t
            return None

        t_fp = first(lambda k, b: k == "press" and b == "f")
        t_fr = first(lambda k, b: k == "release" and b == "f", t_fp) if t_fp else None
        t_ne = (first(lambda k, b: k == "press" and b in ("d", "f", "b", "u"), t_fr)
                if t_fr else None)
        t_df = None
        if a.df_frame is not None:
            for fr in a.frames:
                if fr.index == a.df_frame:
                    ts = [t for k, b, t in fr.events if k == "press" and b in ("f", "d")]
                    t_df = max(ts) if ts else None
        t_2 = first(lambda k, b: k == "press" and b == "2")

        def diff(x, y):
            return (y - x) * 1000 if x is not None and y is not None else None

        return {"f": diff(t_fp, t_fr), "n": diff(t_fr, t_ne),
                "d": diff(t_ne, t_df), "jf": diff(t_df, t_2)}

    def _result(self, a: Attempt, kind: str, reason: str,
                jf: Optional[int] = None) -> Result:
        mv = a.f + a.n + a.d
        return Result(kind, reason, a.f, a.n, a.d, mv, mv + EWGF_BASE_STARTUP,
                      jf, self._raw_ms(a),
                      [(fr.dir, fr.pressed) for fr in a.frames],
                      shortcut=(a.df_frame is not None and a.d == 0),
                      frames=list(a.frames))


# ---------------------------------------------------------------------------
# Audio: soft synthesized tones + a small low-latency mixer
# ---------------------------------------------------------------------------
SR = 48000


def _tone(freqs, dur, decay, amp, attack=0.004, partials=((1, 1.0), (2, 0.18), (3, 0.05))):
    """Mellow mallet-like tone: sine partials, soft attack, exponential decay.
    Higher partials fade faster, which keeps it warm instead of shrill."""
    t = np.arange(int(SR * dur)) / SR
    sig = np.zeros_like(t)
    for f in freqs:
        for k, w in partials:
            sig += w * np.sin(2 * np.pi * f * k * t) * np.exp(-t * k / decay)
    sig *= np.minimum(t / attack, 1.0)                    # no click on start
    fade = min(len(t), int(SR * 0.008))
    sig[-fade:] *= np.linspace(1, 0, fade)                # no click on end
    peak = np.max(np.abs(sig)) or 1.0
    return (sig / peak * amp).astype(np.float32)


def _sequence(notes, total):
    """Mix (start_seconds, samples) pairs into one buffer."""
    buf = np.zeros(int(SR * total), np.float32)
    for start, s in notes:
        i = int(SR * start)
        n = min(len(s), len(buf) - i)
        if n > 0:
            buf[i:i + n] += s[:n]
    return buf


def build_sounds() -> dict:
    bell = ((1, 1.0), (2, 0.12), (3.01, 0.04))
    c6, e6, g6, c7 = 1046.5, 1318.5, 1568.0, 2093.0
    return {
        "f": _tone([783.99], 0.10, 0.035, 0.50),          # G5
        "d": _tone([587.33], 0.10, 0.035, 0.50),          # D5
        "df": _tone([880.0, 1318.5], 0.16, 0.050, 0.55),  # A5 + E6, the "hit"
        "2": _tone([1174.7], 0.06, 0.020, 0.25),          # small D6 tick
        "electric": _sequence([(0.00, _tone([c6], 0.45, 0.16, 0.40, partials=bell)),
                               (0.07, _tone([e6], 0.40, 0.15, 0.36, partials=bell)),
                               (0.14, _tone([g6], 0.45, 0.18, 0.34, partials=bell))], 0.65),
        "electric_best": _sequence([(0.00, _tone([c6], 0.45, 0.16, 0.38, partials=bell)),
                                    (0.06, _tone([e6], 0.40, 0.15, 0.34, partials=bell)),
                                    (0.12, _tone([g6], 0.40, 0.16, 0.32, partials=bell)),
                                    (0.18, _tone([c7], 0.55, 0.22, 0.30, partials=bell))], 0.80),
        "drop": _tone([196.0, 246.9], 0.20, 0.060, 0.40, partials=((1, 1.0), (2, 0.1))),
        "great": _tone([e6], 0.40, 0.15, 0.34, partials=bell),
        # "press df+2 now" cue: bright two-note bell, unlike the input tones
        "electric_cue": _sequence([(0.000, _tone([1975.5, 2637.0], 0.30, 0.10, 0.45, partials=bell)),
                                   (0.012, _tone([3951.1], 0.20, 0.05, 0.12, partials=bell))], 0.32),
        # woodblock-style count-in clicks
        "click": _tone([1480.0], 0.05, 0.012, 0.32, partials=((1, 1.0), (2.76, 0.25))),
        "click_accent": _tone([1975.5], 0.06, 0.014, 0.40, partials=((1, 1.0), (2.76, 0.25))),
    }


def render_guide(events, slow: int, sounds: dict):
    """One loop of the rhythm guide, sample-accurate, ready to repeat."""
    frame_s = FRAME_MS / 1000 * slow
    last = max(fr for fr, _ in events)
    lead = 0.08
    total = max(GUIDE_LOOP_SECONDS * (1 if slow == 1 else 0),
                lead + last * frame_s + 0.7)
    return _sequence([(lead + fr * frame_s, sounds[name]) for fr, name in events], total)


class AudioEngine:
    """Mixes overlapping one-shot sounds and a looping guide track.

    Uses sounddevice (low latency, real mixing). Falls back to winsound,
    which can only play one sound at a time, or to silence."""

    def __init__(self, volume: int):
        self.lock = threading.Lock()
        self.voices: list = []
        self.loop = None
        self.loop_pos = 0
        self.gain = 0.0
        self.mode = None
        self.sounds = build_sounds() if np is not None else {}
        self._tmp = None
        self.set_volume(volume)
        if np is None:
            return
        if sd is not None:
            # WASAPI is ~20 ms on Windows vs ~90 ms for the default MME path
            for device in self._candidate_devices():
                try:
                    self.stream = sd.OutputStream(device=device, samplerate=SR, channels=1,
                                                  dtype="float32", latency="low",
                                                  callback=self._callback)
                    self.stream.start()
                    self.mode = "mixer"
                    return
                except Exception:
                    continue
        if winsound is not None:
            self._tmp = tempfile.mkdtemp(prefix="ewgf_")
            self.mode = "winsound"
            self._write_wavs()

    # volume slider is perceptual: gain = (v/100)^2
    def set_volume(self, v: int):
        self.gain = (max(0, min(100, v)) / 100.0) ** 2
        if self.mode == "winsound":
            self._write_wavs()

    def play(self, name: str):
        s = self.sounds.get(name)
        if s is None or self.gain == 0:
            return
        if self.mode == "mixer":
            with self.lock:
                self.voices.append([s, 0, None])
        elif self.mode == "winsound" and self.loop is None:
            winsound.PlaySound(os.path.join(self._tmp, name + ".wav"),
                               winsound.SND_FILENAME | winsound.SND_ASYNC | winsound.SND_NODEFAULT)

    @property
    def precise(self) -> bool:
        return self.mode == "mixer"

    def schedule(self, name: str, at: float):
        """Play a sound so it leaves the audio device at perf_counter time `at`.
        Sample-accurate with sounddevice; best-effort timer otherwise."""
        s = self.sounds.get(name)
        if s is None:
            return
        if self.mode == "mixer":
            # PortAudio's stream clock and perf_counter differ only by an offset
            st = at - time.perf_counter() + self.stream.time
            with self.lock:
                self.voices.append([s, 0, st])
        elif self.mode == "winsound":
            threading.Timer(max(0.0, at - time.perf_counter()),
                            lambda: self.play(name)).start()

    def cancel_scheduled(self):
        with self.lock:
            self.voices = [v for v in self.voices if v[2] is None]

    def start_loop(self, buf):
        with self.lock:
            self.loop = buf
            self.loop_pos = 0
        if self.mode == "winsound":
            path = os.path.join(self._tmp, "guide.wav")
            self._save(path, buf)
            winsound.PlaySound(path, winsound.SND_FILENAME | winsound.SND_ASYNC
                               | winsound.SND_LOOP | winsound.SND_NODEFAULT)

    def stop_loop(self):
        with self.lock:
            self.loop = None
        if self.mode == "winsound":
            winsound.PlaySound(None, 0)

    def close(self):
        if self.mode == "mixer":
            try:
                self.stream.stop()
                self.stream.close()
            except Exception:
                pass
        elif self.mode == "winsound":
            winsound.PlaySound(None, 0)

    @property
    def latency_ms(self) -> Optional[float]:
        if self.mode == "mixer":
            return (self.stream.latency or 0) * 1000
        return None

    # -- internals ----------------------------------------------------------
    @staticmethod
    def _candidate_devices():
        out = []
        try:
            for h in sd.query_hostapis():
                if "WASAPI" in h["name"] and h["default_output_device"] >= 0:
                    out.append(h["default_output_device"])
        except Exception:
            pass
        out.append(None)  # system default
        return out

    def _callback(self, outdata, frames, time_info, status):
        buf = np.zeros(frames, np.float32)
        dac = getattr(time_info, "outputBufferDacTime", 0) or 0
        if not dac:
            dac = self.stream.time + (self.stream.latency or 0)
        with self.lock:
            keep = []
            for v in self.voices:
                data, pos, start = v
                off = 0
                if start is not None:  # scheduled voice
                    off = int(round((start - dac) * SR))
                    if off >= frames:
                        keep.append(v)  # not due yet
                        continue
                    if off < 0:
                        pos, off = min(-off, len(data)), 0  # slightly late: skip in
                    v[2] = None
                chunk = data[pos:pos + frames - off]
                buf[off:off + len(chunk)] += chunk
                if pos + len(chunk) < len(data):
                    v[1] = pos + len(chunk)
                    keep.append(v)
            self.voices = keep
            if self.loop is not None:
                n = len(self.loop)
                idx = (self.loop_pos + np.arange(frames)) % n
                buf += self.loop[idx]
                self.loop_pos = (self.loop_pos + frames) % n
        buf *= self.gain
        np.clip(buf, -1.0, 1.0, out=buf)
        outdata[:, 0] = buf

    def _save(self, path, buf):
        data = (np.clip(buf * self.gain, -1, 1) * 32767).astype("<i2").tobytes()
        with wave.open(path, "wb") as w:
            w.setnchannels(1)
            w.setsampwidth(2)
            w.setframerate(SR)
            w.writeframes(data)

    def _write_wavs(self):
        if self._tmp:
            for name, s in self.sounds.items():
                self._save(os.path.join(self._tmp, name + ".wav"), s)


# ---------------------------------------------------------------------------
# Keyboard listener (pynput thread -> queue)
# ---------------------------------------------------------------------------
def key_id(key) -> Optional[str]:
    """Normalize a pynput key to a lowercase string id."""
    if isinstance(key, keyboard.KeyCode):
        vk = getattr(key, "vk", None)
        if vk is not None and (0x41 <= vk <= 0x5A or 0x30 <= vk <= 0x39):
            return chr(vk).lower()  # robust against Shift/Ctrl changing .char
        if key.char:
            return key.char.lower()
        return None
    return getattr(key, "name", None)


class InputListener:
    def __init__(self, bindings: dict[str, str], out_q: queue.Queue):
        self.bindings = {k.lower(): v for k, v in bindings.items()}
        self.q = out_q
        self.down: set[str] = set()
        self._lock = threading.Lock()
        # Called straight from the listener thread (lowest latency):
        # sound_cb(name) with name in f / d / df / 2. None = off.
        self.sound_cb = None
        self._last_df_t = 0.0
        self.listener = keyboard.Listener(on_press=self._on_press,
                                          on_release=self._on_release)
        self.listener.daemon = True

    def start(self):
        self.listener.start()

    def stop(self):
        self.listener.stop()

    def _on_press(self, key):
        t = time.perf_counter()
        btn = self.bindings.get(key_id(key))
        if btn is None:
            return
        with self._lock:
            if btn in self.down:  # OS key repeat
                return
            self.down.add(btn)
            down = set(self.down)
        self.q.put(("press", btn, t))
        cb = self.sound_cb
        if cb is None:
            return
        if btn in ("f", "d"):
            other = "d" if btn == "f" else "f"
            if other in down:
                self._last_df_t = t
                cb("df")
            else:
                cb(btn)
        elif btn == "2" and t - self._last_df_t > FRAME_MS / 1000:
            cb("2")  # 2 pressed together with df is covered by the df tone

    def _on_release(self, key):
        t = time.perf_counter()
        btn = self.bindings.get(key_id(key))
        if btn is None:
            return
        with self._lock:
            self.down.discard(btn)
        self.q.put(("release", btn, t))


# ---------------------------------------------------------------------------
# GUI
# ---------------------------------------------------------------------------
BG = "#121418"
PANEL = "#1b1e24"
CELL = "#2a2e36"
FG = "#e6e6e6"
MUTED = "#8a8f98"
GOLD = "#ffd24a"
GREEN = "#3ddc84"
YELLOW = "#f5e15b"
ORANGE = "#ff9f43"
RED = "#ff4d5e"
BLUE = "#4aa8ff"
PURPLE = "#a78bfa"

ARROWS = {"n": "•", "f": "→", "b": "←", "d": "↓", "u": "↑",
          "df": "↘", "db": "↙", "uf": "↗", "ub": "↖"}
DIR_COLORS = {"f": BLUE, "n": CELL, "d": PURPLE, "df": GREEN}
TIMELINE_CELLS = 14


def result_color(r: Result) -> str:
    if not r.electric:
        return RED
    if r.movement_frames <= 3:
        return GOLD
    if r.movement_frames <= 4:
        return GREEN
    if r.movement_frames <= 6:
        return YELLOW
    return ORANGE


def result_title(r: Result) -> str:
    if r.kind == "electric":
        return f"i{r.total_speed} Electric!"
    if r.kind == "wgf_late":
        return f"WGF  (2 late +{r.jf_frames}f)"
    if r.kind == "early":
        return f"Dropped  (2 early {r.jf_frames}f)"
    return "Dropped"


def fmt_ms(v: Optional[float]) -> str:
    return "-" if v is None else f"{v:.1f}"


class EWGFTrainerApp:
    def __init__(self, root: tk.Tk):
        self.root = root
        self.q: queue.Queue = queue.Queue()
        self.sampler = FrameSampler(time.perf_counter())
        self.detector = EWGFDetector()
        self.history: list[Result] = []
        self.total = 0
        self.electrics = 0
        self.best: Optional[int] = None
        self.speed_sum = 0

        root.title("EWGF Practice")
        try:  # works both from source and from the packaged .exe
            base = getattr(sys, "_MEIPASS", os.path.dirname(os.path.abspath(__file__)))
            root.iconbitmap(os.path.join(base, "ewgf_practice.ico"))
        except Exception:
            pass
        root.configure(bg=BG)
        root.geometry("860x1000")
        root.minsize(780, 940)
        self.topmost = tk.BooleanVar(value=ALWAYS_ON_TOP)
        self.input_sounds = tk.BooleanVar(value=INPUT_SOUNDS)
        self.result_sounds = tk.BooleanVar(value=RESULT_SOUNDS)
        self.volume = tk.IntVar(value=MASTER_VOLUME)
        self.guide_variant = tk.StringVar(value=GUIDE_DEFAULT)
        self.guide_speed = tk.StringVar(value="Real speed")
        self.guide_on = False
        self.audio_offset = tk.IntVar(value=AUDIO_OFFSET_MS)  # shared by both games
        root.attributes("-topmost", self.topmost.get())

        self.audio = AudioEngine(MASTER_VOLUME)

        # one window, three tabs
        style = ttk.Style(root)
        style.theme_use("clam")
        style.configure("TNotebook", background=BG, borderwidth=0, tabmargins=(16, 10, 16, 0))
        style.configure("TNotebook.Tab", background=PANEL, foreground=MUTED,
                        padding=(18, 8), borderwidth=0, font=("Segoe UI", 10, "bold"))
        style.map("TNotebook.Tab", background=[("selected", CELL)],
                  foreground=[("selected", FG)])
        self.tabs = ttk.Notebook(root)
        self.tabs.pack(fill="both", expand=True)
        self.tab_main = tk.Frame(self.tabs, bg=BG)
        self.tab_game = tk.Frame(self.tabs, bg=BG)
        self.tab_df = tk.Frame(self.tabs, bg=BG)
        self.tabs.add(self.tab_main, text="  EWGF Trainer  ")
        self.tabs.add(self.tab_game, text="  Rhythm Game  ")
        self.tabs.add(self.tab_df, text="  df+2 Trainer  ")
        self.tabs.bind("<<NotebookTabChanged>>", self._tab_changed)
        # clicking anywhere that isn't a number box gives the keys back
        root.bind("<Button-1>", self._click_away, add="+")

        self._build_ui()
        self.game = RhythmGame(self, self.tab_game)
        self.df_trainer = DFRhythmGame(self, self.tab_df)

        self.listener = InputListener({
            KEY_FORWARD: "f", KEY_BACK: "b", KEY_DOWN: "d", KEY_UP: "u",
            KEY_LP: "1", KEY_RP: "2", KEY_LK: "3", KEY_RK: "4"}, self.q)
        self._apply_input_sounds()
        self.listener.start()
        root.protocol("WM_DELETE_WINDOW", self._on_close)
        self._poll()

    # -- layout -------------------------------------------------------------
    def _current_tab(self):
        try:
            return self.tabs.nametowidget(self.tabs.select())
        except (tk.TclError, KeyError):
            return self.tab_main

    def _tab_changed(self, _=None):
        tab = self._current_tab()
        if tab is not self.tab_game and self.game.active:
            self.game.stop()
        if tab is not self.tab_df and self.df_trainer.running:
            self.df_trainer.stop()
        if tab is not self.tab_main:
            self.stop_guide()
        self.root.focus_set()

    def _click_away(self, event):
        if not isinstance(event.widget, (tk.Spinbox, tk.Entry)):
            try:
                self.root.focus_set()
            except tk.TclError:
                pass

    def _build_ui(self):
        r = self.tab_main
        font = "Segoe UI"

        header = tk.Frame(r, bg=BG)
        header.pack(fill="x", padx=16, pady=(14, 0))
        tk.Label(header, text="EWGF PRACTICE  ·  60 FPS", bg=BG, fg=MUTED,
                 font=(font, 10, "bold")).pack(side="left")
        tk.Label(header,
                 text=f"f={KEY_FORWARD.upper()}  d={KEY_DOWN.upper()}  2={KEY_RP.upper()}",
                 bg=BG, fg=MUTED, font=(font, 10)).pack(side="right")

        self.main_lbl = tk.Label(r, text="Ready", bg=BG, fg=FG,
                                 font=(font, 36, "bold"))
        self.main_lbl.pack(pady=(16, 0))
        self.sub_lbl = tk.Label(r, text="Input  f, n, d, df+2", bg=BG,
                                fg=MUTED, font=(font, 12))
        self.sub_lbl.pack(pady=(0, 10))

        # live input lamps
        lamps = tk.Frame(r, bg=BG)
        lamps.pack(pady=(0, 10))
        self.lamps = {}
        for btn, label in (("b", "←"), ("d", "↓"), ("u", "↑"), ("f", "→"),
                           ("1", "1"), ("2", "2"), ("3", "3"), ("4", "4")):
            lbl = tk.Label(lamps, text=label, width=3, bg=PANEL, fg=MUTED,
                           font=(font, 12, "bold"), pady=3)
            lbl.pack(side="left", padx=3)
            self.lamps[btn] = lbl

        # frame-by-frame timeline of the last attempt
        tk.Label(r, text="INPUT HISTORY  (1 column = 1 game frame, circles = your goal)", bg=BG,
                 fg=MUTED, anchor="w", font=(font, 9, "bold")
                 ).pack(fill="x", padx=16)
        self.timeline = tk.Canvas(r, height=196, bg=PANEL, highlightthickness=0)
        self.timeline.pack(fill="x", padx=16, pady=(2, 10))

        # breakdown table
        table = tk.Frame(r, bg=PANEL, padx=14, pady=10)
        table.pack(fill="x", padx=16)
        for col, (txt, anchor) in enumerate(
                (("Segment", "w"), ("raw ms", "e"), ("game frames", "e"))):
            tk.Label(table, text=txt, bg=PANEL, fg=MUTED, anchor=anchor,
                     font=(font, 10, "bold")).grid(row=0, column=col,
                                                   sticky="ew", pady=(0, 4))
        table.columnconfigure(0, weight=2)
        table.columnconfigure(1, weight=1)
        table.columnconfigure(2, weight=1)
        rows = [("f", "f  hold"), ("n", "n  neutral"), ("d", "d  hold"),
                ("mv", "Movement total"), ("jf", "Just frame (df → 2)")]
        self.cells = {}
        for i, (key, txt) in enumerate(rows, start=1):
            bold = key in ("mv", "jf")
            tk.Label(table, text=txt, bg=PANEL, fg=FG, anchor="w",
                     font=(font, 11, "bold" if bold else "normal")
                     ).grid(row=i, column=0, sticky="ew", pady=1)
            ms = tk.Label(table, text="-", bg=PANEL, fg=FG, anchor="e",
                          font=("Consolas", 11))
            ms.grid(row=i, column=1, sticky="ew")
            fr = tk.Label(table, text="-", bg=PANEL, fg=FG, anchor="e",
                          font=("Consolas", 11))
            fr.grid(row=i, column=2, sticky="ew")
            self.cells[key] = (ms, fr)

        self.stats_lbl = tk.Label(r, text="", bg=BG, fg=MUTED, font=(font, 10))
        self.stats_lbl.pack(fill="x", padx=16, pady=(10, 4))
        self._update_stats()

        tk.Label(r, text=f"LAST {HISTORY_SIZE} ATTEMPTS", bg=BG, fg=MUTED,
                 anchor="w", font=(font, 10, "bold")).pack(fill="x", padx=16)
        hist_frame = tk.Frame(r, bg=PANEL)
        hist_frame.pack(fill="both", expand=True, padx=16, pady=(4, 8))
        sb = tk.Scrollbar(hist_frame)
        sb.pack(side="right", fill="y")
        self.hist_box = tk.Listbox(
            hist_frame, bg=PANEL, fg=FG, font=("Consolas", 10), height=6,
            highlightthickness=0, borderwidth=0, activestyle="none",
            selectbackground=PANEL, yscrollcommand=sb.set)
        self.hist_box.pack(side="left", fill="both", expand=True, padx=6, pady=6)
        sb.config(command=self.hist_box.yview)

        # audio guide panel
        tk.Label(r, text="AUDIO TRAINER", bg=BG, fg=MUTED, anchor="w",
                 font=(font, 10, "bold")).pack(fill="x", padx=16)
        audio = tk.Frame(r, bg=PANEL, padx=12, pady=10)
        audio.pack(fill="x", padx=16, pady=(4, 8))

        def menu(parent, var, options, cmd, width):
            m = tk.OptionMenu(parent, var, *options, command=lambda _: cmd())
            m.config(bg=CELL, fg=FG, activebackground=CELL, activeforeground=FG,
                     relief="flat", highlightthickness=0, width=width, anchor="w",
                     font=(font, 10))
            m["menu"].config(bg=PANEL, fg=FG, activebackground=BLUE,
                             activeforeground="#0b0d10", font=(font, 10))
            return m

        row1 = tk.Frame(audio, bg=PANEL)
        row1.pack(fill="x")
        tk.Label(row1, text="Target", bg=PANEL, fg=MUTED,
                 font=(font, 10)).pack(side="left")
        menu(row1, self.guide_variant, list(GUIDE_VARIANTS), self._guide_changed,
             22).pack(side="left", padx=(6, 10))
        menu(row1, self.guide_speed, list(GUIDE_SPEEDS), self._guide_changed,
             9).pack(side="left")
        self.guide_btn = tk.Button(row1, text="▶  Play rhythm", command=self._toggle_guide,
                                   bg=BLUE, fg="#0b0d10", relief="flat", padx=10,
                                   activebackground=BLUE, font=(font, 10, "bold"))
        self.guide_btn.pack(side="right")
        if self.audio.mode is None:
            self.guide_btn.config(state="disabled", text="No audio")

        row0 = tk.Frame(audio, bg=PANEL)
        row0.pack(fill="x", pady=(8, 0))
        tk.Button(row0, text="🎵  Go to Rhythm Game", command=self._open_game,
                  bg=GOLD, fg="#0b0d10", relief="flat", padx=10,
                  activebackground=GOLD, font=(font, 10, "bold")).pack(side="left")
        tk.Label(row0, text="Reps start on your f - slowed down or real speed",
                 bg=PANEL, fg=MUTED, font=(font, 9)).pack(side="left", padx=8)

        row2 = tk.Frame(audio, bg=PANEL)
        row2.pack(fill="x", pady=(8, 0))
        for text, var, cmd in (("Input tones", self.input_sounds, self._apply_input_sounds),
                               ("Result sounds", self.result_sounds, None)):
            tk.Checkbutton(row2, text=text, variable=var, command=cmd, bg=PANEL,
                           fg=FG, selectcolor=BG, activebackground=PANEL,
                           activeforeground=FG).pack(side="left", padx=(0, 10))
        tk.Scale(row2, from_=0, to=100, orient="horizontal", variable=self.volume,
                 command=lambda v: self.audio.set_volume(int(float(v))),
                 showvalue=False, length=140, bg=PANEL, fg=FG, troughcolor=CELL,
                 highlightthickness=0, sliderrelief="flat").pack(side="right")
        tk.Label(row2, text="Volume", bg=PANEL, fg=MUTED,
                 font=(font, 10)).pack(side="right", padx=(0, 6))

        ctrl = tk.Frame(r, bg=BG)
        ctrl.pack(fill="x", padx=16, pady=(0, 12))
        tk.Checkbutton(ctrl, text="Always on top", variable=self.topmost,
                       command=lambda: self.root.attributes(
                           "-topmost", self.topmost.get()),
                       bg=BG, fg=FG, selectcolor=PANEL, activebackground=BG,
                       activeforeground=FG).pack(side="left")
        tk.Button(ctrl, text="Reset stats", command=self._reset,
                  bg=PANEL, fg=FG, relief="flat", activebackground=CELL,
                  activeforeground=FG, padx=10).pack(side="right")

    # -- event loop ---------------------------------------------------------
    def _poll(self):
        try:
            while True:
                kind, btn, t = self.q.get_nowait()
                self.sampler.feed(kind, btn, t)
                self.game.feed(kind, btn, t)
                self.df_trainer.feed(kind, btn, t)
                held = kind == "press"
                self.lamps[btn].config(bg=BLUE if held else PANEL,
                                       fg="#0b0d10" if held else MUTED)
        except queue.Empty:
            pass
        real_now = time.perf_counter()
        tab = self._current_tab()
        for fr in self.sampler.advance(real_now - FRAME_GRACE_MS / 1000):
            for res in self.detector.step(fr):
                # only the EWGF tab logs attempts; drills on other tabs aren't
                if tab is self.tab_main:
                    self._show(res)
        self.game.tick(real_now)
        self.df_trainer.tick(real_now)
        self.root.after(4, self._poll)

    # -- rendering ----------------------------------------------------------
    def _draw_timeline(self, r: Result):
        """Input history in the Rhythm Game's style: one column per real game
        frame, lanes for f / d / df+2, and a bottom row with what the game read."""
        c = self.timeline
        c.delete("all")
        W = max(c.winfo_width(), 400)
        frames = r.frames
        if not frames:
            return
        n = len(frames)
        target = GUIDE_VARIANTS.get(self.guide_variant.get(), [])
        span = max(n, max((fr for fr, _ in target), default=0) + 1)
        mmin, mmax = -1, span + 1                  # one empty column either side
        left, right = 70, 12
        colw = (W - left - right) / (mmax - mmin)
        frame_s = FRAME_MS / 1000
        f0 = frames[0].index

        def X(m):
            return left + (m - mmin) * colw

        top, bottom = 10, 150
        for m in range(mmin, mmax):
            c.create_rectangle(X(m), top, X(m + 1), bottom + 24, outline="#30343c",
                               fill=CELL if m % 2 == 0 else PANEL)
            c.create_text(X(m + 0.5), bottom + 36, text=str(m), fill=MUTED, font=("Consolas", 8))
        c.create_text(left - 8, bottom + 36, text="frame", anchor="e", fill=MUTED,
                      font=("Segoe UI", 8))
        lanes = {"f": (32, BLUE, "→ f"), "d": (72, PURPLE, "↓ d"), "df": (112, GREEN, "↘ df+2")}
        for key, (y, col, label) in lanes.items():
            c.create_text(8, y, text=label, anchor="w", fill=col, font=("Segoe UI", 10, "bold"))
        c.create_text(8, bottom + 12, text="game read", anchor="w", fill=MUTED,
                      font=("Segoe UI", 9, "bold"))

        # target notes for the selected goal (from the audio panel)
        for fr, name in target:
            if name == "f":
                continue
            y, col, _ = lanes["d" if name == "d" else "df"]
            c.create_oval(X(fr + 0.5) - 12, y - 12, X(fr + 0.5) + 12, y + 12, outline=col, width=2)

        # what the game saw each frame: hold bars, df frames, 2 presses
        for i, fr in enumerate(frames):
            for key in ("f", "d"):
                if key in fr.active:
                    y, col, _ = lanes[key]
                    c.create_rectangle(X(i), y - 5, X(i + 1), y + 5, fill=col, outline="")
            if fr.dir == "df":
                y = lanes["df"][0]
                c.create_rectangle(X(i) + 3, y - 9, X(i + 1) - 3, y + 9, fill=GREEN, outline="")
            if "2" in fr.pressed:
                y = lanes["df"][0]
                c.create_rectangle(X(i) + 1, y - 16, X(i + 1) - 1, y + 16, outline=GOLD, width=2)
                c.create_text(X(i + 0.5), y - 24, text="2", fill=GOLD, font=("Consolas", 11, "bold"))
            # exact moment of each press inside its frame
            start_t = self.sampler.t0 + fr.index * frame_s
            for kind, btn, t in fr.events:
                if kind == "press" and btn in ("f", "d"):
                    y = lanes[btn][0]
                    x = X(i + (t - start_t) / frame_s)
                    c.create_oval(x - 5, y - 5, x + 5, y + 5, fill=FG, outline="")
            # bottom row: the direction the game read on this frame
            d = fr.dir
            col = DIR_COLORS.get(d, RED)
            c.create_rectangle(X(i) + 1, bottom + 1, X(i + 1) - 1, bottom + 23, fill=col, outline="")
            c.create_text(X(i + 0.5), bottom + 12, text=ARROWS.get(d, d),
                          fill="#0b0d10" if d in ("f", "df", "d") else FG,
                          font=("Segoe UI", 11, "bold"))
        if not r.electric:  # outline the frame where it went wrong
            c.create_rectangle(X(n - 1), top, X(n), bottom + 24, outline=RED, width=2)

    def _show(self, r: Result):
        if r.kind == "no_attack":
            self.sub_lbl.config(text="Crouch dash detected - no 2 pressed")
            return

        color = result_color(r)
        self.main_lbl.config(text=result_title(r), fg=color)
        if r.electric:
            if r.movement_frames <= 4:
                sub = "Clean execution"
            elif r.movement_frames <= 6:
                sub = "Electric, but slow movement"
            else:
                sub = "Electric, very slow movement"
        else:
            sub = r.reason
        if r.shortcut:
            sub += "   (f, n, df shortcut)"
        target = self._target_speed()
        if r.electric:
            delta = r.total_speed - target
            sub += (f"   ·   target i{target}: "
                    + ("on target" if delta == 0 else
                       f"{delta} frame{'s' if abs(delta) > 1 else ''} "
                       f"{'slower' if delta > 0 else 'faster'}"))
        if r.kind != "electric" and r.raw["jf"] is not None and r.jf_frames not in (None, 0) \
                and abs(r.raw["jf"]) < FRAME_MS:
            sub += f"\nOnly {abs(r.raw['jf']):.1f} ms apart, but on different frames"
        self.sub_lbl.config(text=sub)
        self._draw_timeline(r)

        def put(key, ms, fr, fg=FG):
            self.cells[key][0].config(text=ms, fg=fg)
            self.cells[key][1].config(text=fr, fg=fg)

        put("f", fmt_ms(r.raw["f"]), str(r.f_frames))
        put("n", fmt_ms(r.raw["n"]), str(r.n_frames))
        put("d", fmt_ms(r.raw["d"]), str(r.d_frames))
        raw_mv = [r.raw[k] for k in ("f", "n", "d")]
        put("mv", fmt_ms(sum(raw_mv)) if None not in raw_mv else "-",
            str(r.movement_frames), color)
        if r.jf_frames is None:
            put("jf", "-", "-", RED)
        else:
            raw_jf = r.raw["jf"]
            jf_txt = ("same frame" if r.jf_frames == 0
                      else f"{r.jf_frames:+d} {'late' if r.jf_frames > 0 else 'early'}")
            put("jf", "-" if raw_jf is None else f"{raw_jf:+.1f}", jf_txt,
                GREEN if r.electric else RED)

        self.total += 1
        if r.electric:
            self.electrics += 1
            self.speed_sum += r.total_speed
            self.best = r.total_speed if self.best is None else min(self.best, r.total_speed)
        self.history.insert(0, r)
        del self.history[HISTORY_SIZE:]
        self._update_stats()
        self._render_history()

        if self.result_sounds.get():
            if r.electric and r.total_speed <= CHIME_MAX_SPEED:
                self.audio.play("electric_best" if r.total_speed <= 14 else "electric")
            elif not r.electric:
                self.audio.play("drop")

    def _render_history(self):
        self.hist_box.delete(0, "end")
        for i, r in enumerate(self.history):
            stamp = time.strftime("%H:%M:%S", time.localtime(r.timestamp))
            if r.electric:
                head = f"i{r.total_speed:<3d} ELECTRIC"
            elif r.kind == "wgf_late":
                head = "WGF  late    "
            elif r.kind == "early":
                head = "DROP 2 early "
            else:
                head = "DROP motion  "
            jf = "--" if r.jf_frames is None else f"{r.jf_frames:+d}f"
            line = (f"{stamp}  {head}  f{r.f_frames} n{r.n_frames} d{r.d_frames}"
                    f" = {r.movement_frames}f  jf {jf:>3}")
            if r.kind == "fail":
                line += f"  {r.reason}"
            self.hist_box.insert("end", line)
            self.hist_box.itemconfig(i, fg=result_color(r))

    def _update_stats(self):
        if self.total == 0:
            self.stats_lbl.config(text="Attempts 0   ·   Electric -   ·   Avg -   ·   Best -")
            return
        rate = 100.0 * self.electrics / self.total
        avg = f"i{self.speed_sum / self.electrics:.1f}" if self.electrics else "-"
        best = f"i{self.best}" if self.best else "-"
        l10 = sum(h.electric for h in self.history)
        self.stats_lbl.config(
            text=(f"Attempts {self.total}   ·   Electric {rate:.0f}%   ·   "
                  f"Last {len(self.history)}: {l10}/{len(self.history)}   ·   "
                  f"Avg {avg}   ·   Best {best}"))

    # -- audio trainer ------------------------------------------------------
    def _target_speed(self) -> int:
        events = GUIDE_VARIANTS[self.guide_variant.get()]
        return max(fr for fr, _ in events) + EWGF_BASE_STARTUP

    def _apply_input_sounds(self):
        self.listener.sound_cb = self.audio.play if self.input_sounds.get() else None

    def _guide_changed(self):
        if self.guide_on:
            self._start_guide()

    def _start_guide(self):
        events = GUIDE_VARIANTS[self.guide_variant.get()]
        slow = GUIDE_SPEEDS[self.guide_speed.get()]
        self.audio.start_loop(render_guide(events, slow, self.audio.sounds))
        self.guide_on = True
        self.guide_btn.config(text="■  Stop rhythm", bg=GOLD, activebackground=GOLD)

    def stop_guide(self):
        if self.guide_on:
            self.audio.stop_loop()
            self.guide_on = False
            self.guide_btn.config(text="▶  Play rhythm", bg=BLUE, activebackground=BLUE)

    def _toggle_guide(self):
        if self.guide_on:
            self.stop_guide()
        else:
            if self.game.active:
                self.game.stop()
            if self.df_trainer.running:
                self.df_trainer.stop()
            self._start_guide()

    def _open_game(self):
        self.tabs.select(self.tab_game)

    def _reset(self):
        self.history.clear()
        self.total = self.electrics = self.speed_sum = 0
        self.best = None
        self.hist_box.delete(0, "end")
        self.timeline.delete("all")
        self.main_lbl.config(text="Ready", fg=FG)
        self.sub_lbl.config(text="Input  f, n, d, df+2")
        for ms, fr in self.cells.values():
            ms.config(text="-", fg=FG)
            fr.config(text="-", fg=FG)
        self._update_stats()

    def _on_close(self):
        self.listener.stop()
        self.audio.close()
        if sys.platform == "win32":
            try:
                import ctypes
                ctypes.windll.winmm.timeEndPeriod(1)
            except Exception:
                pass
        self.root.destroy()


# ---------------------------------------------------------------------------
# Rhythm game: play the pattern on the beat, frames stretched by the speed
# ---------------------------------------------------------------------------
SPEED_LABELS = {v: k for k, v in GUIDE_SPEEDS.items()}


@dataclass
class RepJudgement:
    grade: str               # PERFECT, GREAT, MISS
    reason: str
    result: Optional[Result]
    start_ms: Optional[float]          # your f vs the beat
    errors: dict                       # note name -> error in real game frames
    jf: Optional[int]                  # 2 minus df, in real game frames (0 = together)
    jf_ms: Optional[float] = None
    math: str = ""                      # how the Electric speed was worked out


def real_grid_origin(T0: float, fms: float) -> float:
    """Start of real frame 0. Real 60 fps frames tile the stretched frames
    exactly, so stretched frame k = real frames k*slow .. k*slow+slow-1."""
    return T0 - 0.5 * fms


def plural(n: int, word: str = "frame") -> str:
    return f"{n} {word}{'' if n == 1 else 's'}"


def timing_summary(frames: int, goal: int, slow: int, rhythm_movement: Optional[int] = None) -> str:
    """Plain-language result. `frames` = real game frames from f to df+2,
    counted one per 16.67 ms frame, exactly like the game would."""
    diff = frames - goal
    when = "right on time" if diff == 0 else f"{plural(abs(diff))} {'late' if diff > 0 else 'early'}"
    line1 = f"f to df+2 took {plural(frames)}   (goal {goal})   -   {when}"
    line2 = f"Done this way in game, that's an i{frames + EWGF_BASE_STARTUP} Electric"
    if slow > 1:
        mv = rhythm_movement if rhythm_movement is not None else round(frames / slow)
        line2 += (f"     (you're at {slow}x slower - at full speed this rhythm "
                  f"is i{mv + EWGF_BASE_STARTUP})")
    return line1 + "\n" + line2


def slowed_timing(events, slow: int) -> str:
    """Where each input lands, in real game frames from your f, at this slow-down."""
    df_k = max(fr for fr, _ in events)
    d_k = next((fr for fr, n in events if n == "d"), None)

    def rng(a, b):  # stretched frames [a, b) -> real frames
        lo, hi = a * slow, b * slow - 1
        return f"{lo}" if lo == hi else f"{lo}-{hi}"

    parts = [f"f {rng(0, 1)}", f"n {rng(1, d_k or df_k)}"]
    if d_k:
        parts.append(f"d {rng(d_k, df_k)}")
    parts.append(f"df+2 on {df_k * slow}")
    text = "   ".join(parts) + f"   =  df+2 {df_k * slow} frames ({df_k * slow * FRAME_MS:.0f} ms) after f"
    if slow > 1:
        text += f"   ·   real game: {df_k} frames ({df_k * FRAME_MS:.0f} ms) = i{df_k + EWGF_BASE_STARTUP}"
    else:
        text += f"  =  i{df_k + EWGF_BASE_STARTUP}"
    return text


def judge_rep(raw, results, detector, T0, beat, fms, events, target, slow=1) -> RepJudgement:
    """raw = [(kind, btn, t, held_before)], fms = stretched frame in seconds.

    The f, n, d rhythm is judged on stretched frames, but df and 2 are always
    judged on REAL game frames: in game they're pressed together, and slowing
    the rhythm down doesn't make that window any wider."""
    real_f = FRAME_MS / 1000
    g0 = real_grid_origin(T0, fms)

    def real_idx(t):  # +1e-6: a press exactly on a frame line belongs to the frame starting there
        return math.floor((t - g0) / real_f + 1e-6)
    res = next((r for r in results if r.kind != "no_attack"), None)
    reason = ""
    if res is None:
        if detector.state == ST_PEND or any(r.kind == "no_attack" for r in results):
            reason = "Reached df but no 2"
        elif detector.state != IDLE:
            reason = "Motion not finished in time"
        elif detector.last_fail:
            res = detector.last_fail[0]
        else:
            reason = "No input"

    win = 0.5 * beat
    f_on = [t for k, b, t, hb in raw if k == "press" and b == "f"
            and "d" not in hb and abs(t - T0) <= win]
    t_f = f_on[0] if f_on else None

    def first(pred):
        return next((t for k, b, t, hb in raw if t_f is not None and t > t_f
                     and k == "press" and pred(b, hb)), None)

    t_d = first(lambda b, hb: b == "d" and "f" not in hb)
    t_df = first(lambda b, hb: (b == "f" and "d" in hb) or (b == "d" and "f" in hb))
    t_2 = first(lambda b, hb: b == "2")
    errors = {}
    if t_f is not None:
        for fr, name in events[1:]:
            actual = t_d if name == "d" else t_df
            errors[name] = (None if actual is None
                            else (real_idx(actual) - real_idx(t_f)) - fr * slow)
    jf = jf_ms = None
    if t_2 is not None and t_df is not None:
        jf = real_idx(t_2) - real_idx(t_df)
        jf_ms = (t_2 - t_df) * 1000
    start_ms = (t_f - T0) * 1000 if t_f is not None else None

    right_move = res is not None and res.electric and res.total_speed == target
    clean = right_move and jf == 0
    tight = (bool(errors) and all(e is not None and abs(e) <= RHYTHM_PERFECT * slow
                                  for e in errors.values()))
    if t_f is None and res is None and not reason:
        reason = "No f on the beat"
    if clean:
        grade = "PERFECT" if tight else "GREAT"
        reason = "Electric! df and 2 landed on the same frame"
    else:
        grade = "MISS"
        jf_miss = (res is not None and res.kind in ("wgf_late", "early")
                   and jf is not None and jf != 0)
        if right_move or jf_miss:
            side = "late" if jf > 0 else "early"
            reason = f"df and 2 were on different frames - 2 was {plural(abs(jf))} {side}"
        elif res is not None and res.electric and slow > 1:
            got = real_idx(t_df) - real_idx(t_f) if t_df is not None and t_f is not None else None
            reason = (f"Wrong rhythm: df+2 came {plural(got) if got is not None else '?'} after f, "
                      f"goal was {(target - EWGF_BASE_STARTUP) * slow}")
        elif res is not None and res.electric:
            reason = f"Came out i{res.total_speed}, target is i{target}"
        elif res is not None:
            reason = f"{result_title(res)}: {res.reason}"
        elif t_f is None and reason == "No input":
            reason = "No f on the beat"
    summary = ""
    if clean and t_f is not None and t_df is not None:
        summary = timing_summary(real_idx(t_df) - real_idx(t_f),
                                 (target - EWGF_BASE_STARTUP) * slow, slow, res.movement_frames)
    return RepJudgement(grade, reason, res, start_ms, errors, jf, jf_ms, summary)


@dataclass
class Rep:
    rep_start: float
    T0: float
    beat: float
    fms: float
    slow: int
    events: list
    target: int
    sampler: FrameSampler
    detector: EWGFDetector
    eval_t: float
    results: list = field(default_factory=list)
    raw: list = field(default_factory=list)
    segs: dict = field(default_factory=lambda: {"f": [], "d": []})
    marks: list = field(default_factory=list)   # ("df" | "2", t)
    judgement: Optional[RepJudgement] = None


GRADE_COLORS = {"PERFECT": GOLD, "GREAT": GREEN, "MISS": RED}


class RhythmGame:
    def __init__(self, app: "EWGFTrainerApp", parent: tk.Frame):
        self.app = app
        self.audio = app.audio
        self.active = False
        self.rep: Optional[Rep] = None
        self.prev: Optional[Rep] = None
        self.held: set[str] = set()
        self.history: list[tuple] = []
        self.stats = dict(reps=0, perfect=0, great=0, miss=0, combo=0, best_combo=0)
        self.streak = 0
        self.miss_streak = 0

        self.variant = tk.StringVar(value=app.guide_variant.get())
        self.speed = tk.StringVar(value=SPEED_LABELS[RHYTHM_SPEED_ORDER[0]])
        self.guide = tk.BooleanVar(value=True)
        self.auto = tk.BooleanVar(value=True)
        self.bpm = tk.IntVar(value=RHYTHM_BPM)
        self.offset = app.audio_offset

        self.win = parent  # a tab in the main window
        self._build_ui()
        self._draw_loop()

    # -- UI -----------------------------------------------------------------
    def _build_ui(self):
        w, font = self.win, "Segoe UI"

        def menu(parent, var, options, width):
            m = tk.OptionMenu(parent, var, *options)
            m.config(bg=CELL, fg=FG, activebackground=CELL, activeforeground=FG,
                     relief="flat", highlightthickness=0, width=width, anchor="w",
                     font=(font, 10))
            m["menu"].config(bg=PANEL, fg=FG, activebackground=BLUE,
                             activeforeground="#0b0d10", font=(font, 10))
            return m

        # numbers only: digits and a leading minus, nothing else gets typed
        numeric = (w.register(lambda s: s == "" or s == "-" or s.lstrip("-").isdigit()), "%P")

        def spin(parent, var, lo, hi, step=1):
            sb = tk.Spinbox(parent, from_=lo, to=hi, increment=step, textvariable=var,
                            width=5, bg=CELL, fg=FG, buttonbackground=CELL,
                            relief="flat", insertbackground=FG, font=(font, 10),
                            validate="key", validatecommand=numeric)

            def clamp():
                try:
                    v = int(sb.get())
                except ValueError:
                    v = lo if lo > 0 else 0
                var.set(max(lo, min(hi, v)))

            def commit(_=None):
                clamp()
                self.app.root.focus_set()  # hand the keyboard back to the game
                return "break"

            sb.bind("<Return>", commit)
            sb.bind("<KP_Enter>", commit)
            sb.bind("<Escape>", commit)
            sb.bind("<FocusOut>", lambda e: clamp())
            return sb

        def check(parent, text, var):
            return tk.Checkbutton(parent, text=text, variable=var, bg=PANEL, fg=FG,
                                  selectcolor=BG, activebackground=PANEL,
                                  activeforeground=FG, font=(font, 10))

        top = tk.Frame(w, bg=PANEL, padx=12, pady=10)
        top.pack(fill="x", padx=16, pady=(14, 0))
        r1 = tk.Frame(top, bg=PANEL)
        r1.pack(fill="x")
        tk.Label(r1, text="Target", bg=PANEL, fg=MUTED, font=(font, 10)).pack(side="left")
        menu(r1, self.variant, list(GUIDE_VARIANTS), 22).pack(side="left", padx=(6, 10))
        tk.Label(r1, text="Speed", bg=PANEL, fg=MUTED, font=(font, 10)).pack(side="left")
        menu(r1, self.speed, [SPEED_LABELS[s] for s in RHYTHM_SPEED_ORDER], 9
             ).pack(side="left", padx=(6, 10))
        self.start_btn = tk.Button(r1, text="▶  Start", command=self.toggle, bg=BLUE,
                                   fg="#0b0d10", relief="flat", padx=14,
                                   activebackground=BLUE, font=(font, 10, "bold"))
        self.start_btn.pack(side="right")
        if self.audio.mode is None:
            self.start_btn.config(state="disabled", text="No audio")

        r2 = tk.Frame(top, bg=PANEL)
        r2.pack(fill="x", pady=(8, 0))
        check(r2, "d tone", self.guide).pack(side="left")
        check(r2, "Auto speed-up", self.auto).pack(side="left", padx=(10, 0))
        tk.Label(r2, text="Audio offset ms", bg=PANEL, fg=MUTED,
                 font=(font, 10)).pack(side="left", padx=(16, 4))
        spin(r2, self.offset, -100, 300, 5).pack(side="left")

        tf = tk.Frame(w, bg=BG)
        tf.pack(fill="x", padx=16, pady=(8, 0))
        tk.Label(tf, text="TIMING AT THIS SPEED  (game frames from your f)", bg=BG, fg=MUTED,
                 font=(font, 9, "bold")).pack(anchor="w")
        self.timing_lbl = tk.Label(tf, text="", bg=BG, fg=FG, font=("Consolas", 10), anchor="w")
        self.timing_lbl.pack(anchor="w")
        self.variant.trace_add("write", lambda *_: self._update_timing())
        self.speed.trace_add("write", lambda *_: self._update_timing())
        self._update_timing()

        lat = self.audio.latency_ms
        tk.Label(w, text=("Audio latency %.0f ms (compensated for the beat)" % lat) if lat
                 else "Install sounddevice for sample-accurate beats", bg=BG, fg=MUTED,
                 font=(font, 9)).pack(anchor="e", padx=16)
        self.big = tk.Label(w, text="Press Start", bg=BG, fg=FG, font=(font, 40, "bold"))
        self.big.pack(pady=(14, 0))
        self.sub = tk.Label(w, text="Press Start, then press → whenever you're ready",
                            bg=BG, fg=MUTED, font=(font, 12))
        self.sub.pack()
        self.detail = tk.Label(w, text="", bg=BG, fg=MUTED, font=("Consolas", 11))
        self.detail.pack(pady=(2, 0))
        self.math_lbl = tk.Label(w, text="", bg=BG, fg=GOLD, font=("Segoe UI", 12, "bold"),
                                 justify="center")
        self.math_lbl.pack(pady=(2, 8))

        self.canvas = tk.Canvas(w, height=230, bg=PANEL, highlightthickness=0)
        self.canvas.pack(fill="x", padx=16)

        self.stats_lbl = tk.Label(w, text="", bg=BG, fg=MUTED, font=(font, 10))
        self.stats_lbl.pack(fill="x", padx=16, pady=(10, 4))
        self._update_stats()

        hist = tk.Frame(w, bg=PANEL)
        hist.pack(fill="both", expand=True, padx=16, pady=(0, 14))
        self.hist_box = tk.Listbox(hist, bg=PANEL, fg=FG, font=("Consolas", 10),
                                   highlightthickness=0, borderwidth=0,
                                   activestyle="none", selectbackground=PANEL, height=RHYTHM_HISTORY)
        self.hist_box.pack(fill="both", expand=True, padx=6, pady=6)

    def _release_focus(self):
        try:
            if isinstance(self.win.focus_get(), tk.Spinbox):
                self.app.root.focus_set()
        except (tk.TclError, KeyError):
            pass

    def _int(self, var, default):
        try:
            return int(var.get())
        except (tk.TclError, ValueError):
            return default

    def _speed(self) -> int:
        return GUIDE_SPEEDS[self.speed.get()]

    def _update_timing(self):
        try:
            self.timing_lbl.config(text=slowed_timing(GUIDE_VARIANTS[self.variant.get()],
                                                      self._speed()))
        except (KeyError, AttributeError):
            pass

    def _update_stats(self):
        s = self.stats
        acc = f"{100 * (s['perfect'] + s['great']) / s['reps']:.0f}%" if s["reps"] else "-"
        lvl = (f"{self.streak}/{RHYTHM_LEVEL_UP} clean to speed up"
               if self._speed() != RHYTHM_SPEED_ORDER[-1] else f"streak {self.streak}")
        self.stats_lbl.config(text=(
            f"{self.speed.get()}   ·   {lvl}   ·   Combo {s['combo']} (best {s['best_combo']})   ·   "
            f"Perfect {s['perfect']}  Great {s['great']}  Miss {s['miss']}   ·   Hit rate {acc}"))

    # -- control ------------------------------------------------------------
    def toggle(self):
        if self.active:
            self.stop()
        else:
            self.start()

    def start(self):
        self._release_focus()
        self.win.update_idletasks()  # let the box's value commit first
        self.app.stop_guide()
        self.active = True
        self.prev = None
        self.start_btn.config(text="■  Stop", bg=GOLD, activebackground=GOLD)
        self.big.config(text="Press →", fg=BLUE)
        self.sub.config(text="Press → whenever you're ready - the rep starts on your f", fg=MUTED)

    def stop(self):
        self.active = False
        self.rep = None
        self.audio.cancel_scheduled()
        self.start_btn.config(text="▶  Start", bg=BLUE, activebackground=BLUE)
        self.big.config(text="Paused", fg=FG)

    def _start_rep(self, t_f: float):
        """A rep starts the moment you press f: beep now, then the d tone and
        the Electric chime on the frames where they belong."""
        events = GUIDE_VARIANTS[self.variant.get()]
        slow = self._speed()
        fms = FRAME_MS * slow / 1000
        off = self._int(self.offset, 0) / 1000
        if not self.app.input_sounds.get():
            self.audio.play("f")          # input tones already beep on f otherwise
        for fr, name in events:
            if name == "d" and self.guide.get():
                self.audio.schedule("d", t_f + fr * fms - off)
            elif name == "df":
                self.audio.schedule("electric_cue", t_f + fr * fms - off)
        last = max(fr for fr, _ in events)
        # frame grid aligned so your f sits in the middle of frame 0
        sampler = FrameSampler(t_f - 2.5 * fms, frame_ms=fms * 1000)
        sampler.held = set(self.held) - {"f"}
        self.rep = Rep(t_f, t_f, max(0.2, fms), fms, slow, events, last + EWGF_BASE_STARTUP,
                       sampler, EWGFDetector(), eval_t=t_f + (last + 3) * fms + 0.25)

    # -- input --------------------------------------------------------------
    def feed(self, kind: str, btn: str, t: float):
        before = frozenset(self.held)
        if kind == "press":
            if btn in self.held:
                return
            self.held.add(btn)
        else:
            self.held.discard(btn)
        if (self.active and self.rep is None and kind == "press" and btn == "f"
                and "d" not in before):
            self._start_rep(t)
        rep = self.rep
        if rep is None:
            return
        if t < rep.sampler.t0:
            (rep.sampler.held.add if kind == "press" else rep.sampler.held.discard)(btn)
            return
        rep.sampler.feed(kind, btn, t)
        rep.raw.append((kind, btn, t, before))
        if btn in ("f", "d"):
            if kind == "press":
                rep.segs[btn].append([t, None])
                if ("d" if btn == "f" else "f") in before:
                    rep.marks.append(("df", t))
            elif rep.segs[btn] and rep.segs[btn][-1][1] is None:
                rep.segs[btn][-1][1] = t
        elif btn == "2" and kind == "press":
            rep.marks.append(("2", t))

    def tick(self, now: float):
        rep = self.rep
        if not self.active or rep is None:
            return
        for fr in rep.sampler.advance(now - FRAME_GRACE_MS / 1000):
            rep.results += rep.detector.step(fr)
        if now >= rep.eval_t + FRAME_GRACE_MS / 1000:
            self._evaluate(rep)
            self.prev = rep
            self.rep = None   # wait for your next f

    # -- judging ------------------------------------------------------------
    def _evaluate(self, rep: Rep):
        j = judge_rep(rep.raw, rep.results, rep.detector, rep.T0, rep.beat,
                      rep.fms, rep.events, rep.target, rep.slow)
        j.start_ms = None   # the rep starts on your f, so there's no beat to be early/late on
        rep.judgement = j
        s = self.stats
        s["reps"] += 1
        s[j.grade.lower()] += 1
        if j.grade == "MISS":
            s["combo"] = 0
            self.streak = 0
            self.miss_streak += 1
        else:
            s["combo"] += 1
            s["best_combo"] = max(s["best_combo"], s["combo"])
            self.streak += 1
            self.miss_streak = 0

        sound = {"PERFECT": "electric", "GREAT": "great", "MISS": "drop"}[j.grade]
        note = ""
        order = RHYTHM_SPEED_ORDER
        idx = order.index(rep.slow) if rep.slow in order else 0
        if self.auto.get() and self._speed() == rep.slow:
            if self.streak >= RHYTHM_LEVEL_UP and idx < len(order) - 1:
                self.speed.set(SPEED_LABELS[order[idx + 1]])
                self.streak = 0
                note = f"   ·   Speed up! Now {self.speed.get()}"
                sound = "electric_best"
            elif self.miss_streak >= RHYTHM_LEVEL_DOWN and idx > 0:
                self.speed.set(SPEED_LABELS[order[idx - 1]])
                self.miss_streak = 0
                self.streak = 0
                note = f"   ·   Slowing down to {self.speed.get()}"
        self.audio.play(sound)

        self.big.config(text=j.grade, fg=GRADE_COLORS[j.grade])
        self.sub.config(text=j.reason + note, fg=GRADE_COLORS[j.grade] if note else MUTED)
        self.detail.config(text=self._detail_text(j))
        self.math_lbl.config(text=j.math)
        self._update_stats()

        self.history.insert(0, (time.strftime("%H:%M:%S"), SPEED_LABELS[rep.slow],
                                rep.target, j))
        del self.history[RHYTHM_HISTORY:]
        self.hist_box.delete(0, "end")
        for i, (stamp, spd, target, hj) in enumerate(self.history):
            pat = f"i{target}" if GUIDE_SPEEDS[spd] == 1 else                 f"i{target}@{GUIDE_SPEEDS[spd]}x={(target - EWGF_BASE_STARTUP) * GUIDE_SPEEDS[spd]}f"
            self.hist_box.insert("end", f"{stamp}  {spd:<10} {pat:<12} {hj.grade:<8} "
                                        f"{self._detail_text(hj)}   {hj.reason}")
            self.hist_box.itemconfig(i, fg=GRADE_COLORS[hj.grade])

    @staticmethod
    def _detail_text(j: RepJudgement) -> str:
        def off(e):  # error in real frames -> words
            n = round(e)
            return "on time" if n == 0 else f"{plural(abs(n))} {'late' if n > 0 else 'early'}"

        if j.start_ms is None:
            parts = []
        else:
            ms = round(j.start_ms)
            parts = ["f on the beat" if abs(ms) < 10 else
                     f"f {abs(ms)} ms {'late' if ms > 0 else 'early'}"]
        for name, e in j.errors.items():
            parts.append(f"{name} " + ("missed" if e is None else off(e)))
        if j.jf is None:
            parts.append("no 2")
        elif j.jf == 0:
            parts.append("2 same frame as df ✓")
        else:
            parts.append(f"2 {plural(abs(j.jf))} {'late' if j.jf > 0 else 'early'} ✗")
        return "   ·   ".join(parts)

    # -- drawing ------------------------------------------------------------
    def _draw_loop(self):
        if not self.win.winfo_exists():
            return
        now = time.perf_counter()
        rep = self.rep
        if self.active and rep is not None and now < rep.eval_t:
            self.big.config(text="GO!", fg=BLUE)
        show = rep if rep is not None else self.prev
        self._draw(show, now)
        self.win.after(16, self._draw_loop)

    def _draw(self, rep: Optional[Rep], now: float):
        c = self.canvas
        c.delete("all")
        W = max(c.winfo_width(), 400)
        if rep is None:
            c.create_text(W / 2, 115, text="Press Start, then press → whenever you like. You hear a "
                          "beep on your f, the d tone,\nthen the Electric chime where df+2 should "
                          "land. Each column is one real game frame.", fill=MUTED,
                          font=("Segoe UI", 11), justify="center")
            return
        # Columns are REAL 60 fps game frames. At 4x slower one rhythm step
        # is 4 columns wide, so you can see which in-game frame each press hit.
        s = rep.slow
        real_f = FRAME_MS / 1000
        g0 = real_grid_origin(rep.T0, rep.fms)
        last = max(fr for fr, _ in rep.events)
        kmin, kmax = -2, last + 3                   # rhythm steps shown
        mmin, mmax = kmin * s, (kmax + 1) * s       # real frame range [mmin, mmax)
        left, right = 70, 12
        colw = (W - left - right) / (mmax - mmin)

        def X(m):
            return left + (m - mmin) * colw

        def R(t):  # time -> real frame coordinate
            return (t - g0) / real_f

        top, bottom = 14, 196
        for k in range(kmin, kmax + 1):             # rhythm-step blocks
            c.create_rectangle(X(k * s), top, X((k + 1) * s), bottom, outline="",
                               fill=CELL if k % 2 == 0 else PANEL)
        if s > 1:                                   # real-frame dividers
            for m in range(mmin, mmax):
                if m % s:
                    c.create_line(X(m), top, X(m), bottom, fill="#3a3f48")
        step = 1 if colw >= 18 else (s if s <= 4 else s // 2)
        for m in range(mmin, mmax):
            if m % step == 0:
                c.create_text(X(m + 0.5), bottom + 14, text=str(m), fill=MUTED,
                              font=("Consolas", 8 if colw < 18 else 9))
        c.create_text(left - 8, bottom + 14, text="game frame", anchor="e", fill=MUTED,
                      font=("Segoe UI", 8))
        lanes = {"f": (50, BLUE, "→ f"), "d": (105, PURPLE, "↓ d"), "df": (160, GREEN, "↘ df+2")}

        # in-game frames your df and 2 landed on (same column = Electric window)
        y = lanes["df"][0]
        for kind, t in rep.marks:
            m = int(R(t) // 1)
            if mmin <= m < mmax:
                col = GREEN if kind == "df" else GOLD
                c.create_rectangle(X(m) + 1, y - 22, X(m + 1) - 1, y + 22,
                                   outline=col, width=2)

        for key, (ly, col, label) in lanes.items():
            c.create_text(10, ly, text=label, anchor="w", fill=col, font=("Segoe UI", 10, "bold"))
            c.create_line(left, ly, W - right, ly, fill="#30343c")
        c.create_text(X(1.5 * s), 78, text="n", fill=MUTED, font=("Segoe UI", 10, "italic"))

        # target notes, centred in their rhythm step
        for fr, name in rep.events:
            ly, col, _ = lanes[name]
            x = X((fr + 0.5) * s)
            c.create_oval(x - 13, ly - 13, x + 13, ly + 13, outline=col, width=2)

        P = R
        lo, hi = mmin, mmax
        # your holds and presses
        for key in ("f", "d"):
            y, col, _ = lanes[key]
            for s, e in rep.segs[key]:
                a, b = P(s), P(e if e is not None else now)
                if b < lo or a > hi:
                    continue
                c.create_rectangle(X(max(a, lo)), y - 5, X(min(b, hi)), y + 5,
                                   fill=col, outline="")
                if lo <= a <= hi:
                    c.create_oval(X(a) - 6, y - 6, X(a) + 6, y + 6, fill=FG, outline="")
        y = lanes["df"][0]
        for kind, t in rep.marks:
            p = P(t)
            if not lo <= p <= hi:
                continue
            if kind == "df":
                c.create_polygon(X(p), y - 9, X(p) + 9, y, X(p), y + 9, X(p) - 9, y,
                                 fill=GREEN, outline="")
            else:
                c.create_text(X(p), y - 22, text="2", fill=GOLD, font=("Consolas", 12, "bold"))
                c.create_line(X(p), y - 14, X(p), y + 14, fill=GOLD, width=2)

        # playhead
        p = P(now)
        if rep.judgement is None and lo <= p <= hi:
            c.create_line(X(p), top, X(p), bottom, fill=GOLD, width=2)


# ---------------------------------------------------------------------------
# df+2 rhythm game: the f is played for you, you hit df+2 on the second cue.
# Starts with 1 game frame stretched to 10 frames; every clean hit shrinks
# the frame by one until you're at real speed (1 frame = 16.67 ms).
# ---------------------------------------------------------------------------
DF_START_LEVEL = 10          # 1 frame = this many real frames at the start
DF_HITS_PER_LEVEL = 1        # clean hits needed to drop one level
DF_LEVEL_DOWN = 3            # misses in a row before going back up a level
DF_BEAT_TOL_MS = 50          # strict mode only: how far off the cue df+2 may be
DF_RANGE_AFTER_S = 0.30      # df+2 is accepted from the f cue until this long after the 2nd cue
DF_BPM = 100
DF_GAPS = {"2 frames  (f, n, df+2)": 2, "3 frames  (f, n, d, df+2)": 3}
DF_HISTORY = 8


def ui_menu(parent, var, options, width, command=None):
    m = tk.OptionMenu(parent, var, *options,
                      command=(lambda _: command()) if command else None)
    m.config(bg=CELL, fg=FG, activebackground=CELL, activeforeground=FG, relief="flat",
             highlightthickness=0, width=width, anchor="w", font=("Segoe UI", 10))
    m["menu"].config(bg=PANEL, fg=FG, activebackground=BLUE, activeforeground="#0b0d10",
                     font=("Segoe UI", 10))
    return m


def ui_spin(parent, root, var, lo, hi, step=1):
    """Numbers-only spinbox that hands the keyboard back on Enter / Esc."""
    numeric = (parent.register(lambda s: s == "" or s == "-" or s.lstrip("-").isdigit()), "%P")
    sb = tk.Spinbox(parent, from_=lo, to=hi, increment=step, textvariable=var, width=5,
                    bg=CELL, fg=FG, buttonbackground=CELL, relief="flat",
                    insertbackground=FG, font=("Segoe UI", 10),
                    validate="key", validatecommand=numeric)

    def clamp():
        try:
            v = int(sb.get())
        except ValueError:
            v = lo if lo > 0 else 0
        var.set(max(lo, min(hi, v)))

    def commit(_=None):
        clamp()
        root.focus_set()
        return "break"

    for seq in ("<Return>", "<KP_Enter>", "<Escape>"):
        sb.bind(seq, commit)
    sb.bind("<FocusOut>", lambda e: clamp())
    return sb


@dataclass
class DFRep:
    rep_start: float
    T_f: float           # auto f cue
    T_hit: float         # df+2 cue
    beat: float
    level: int           # 1 frame = level real frames
    fms: float           # stretched frame, seconds
    gap: int
    win_start: float
    win_end: float
    eval_t: float
    strict: bool = False
    t_df: Optional[float] = None
    t_2: Optional[float] = None
    t_d: Optional[float] = None          # first d press in the window
    t_f: Optional[float] = None          # first f press in the window
    d_held_at_start: bool = False
    d_segs: list = field(default_factory=list)   # [press, release] for drawing
    df_held_before: bool = False
    start_checked: bool = False
    grade: Optional[str] = None
    judgement: Optional["DFJudgement"] = None


@dataclass
class DFJudgement:
    hit: bool
    reason: str
    df_frame: Optional[int]     # stretched frame df landed on (0 = the cue's frame)
    two_frame: Optional[int]
    df_vs_cue_ms: Optional[float]
    gap_ms: Optional[float]     # 2 minus df
    math: str = ""


def judge_df_rep(rep: DFRep) -> DFJudgement:
    g0 = rep.T_hit - 0.5 * rep.fms   # cue sits in the middle of stretched frame 0

    def idx(t):
        return math.floor((t - g0) / rep.fms + 1e-6)

    if rep.t_df is None and rep.df_held_before:
        return DFJudgement(False, "df was already held before the cue - let go of → first",
                           None, None if rep.t_2 is None else idx(rep.t_2), None, None)
    d_down = rep.t_d if rep.t_d is not None else (rep.win_start if rep.d_held_at_start else None)
    if rep.t_f is not None and (d_down is None or rep.t_f < d_down):
        why = ("f pressed before d - hold ↓ first, then press → + 2" if d_down is not None
               else "f pressed without d - hold ↓ first, then press → + 2")
        k2 = None if rep.t_2 is None else idx(rep.t_2)
        return DFJudgement(False, why, idx(rep.t_f), k2, (rep.t_f - rep.T_hit) * 1000,
                           None if rep.t_2 is None else (rep.t_2 - rep.t_f) * 1000)
    if rep.t_df is None and rep.t_2 is None:
        return DFJudgement(False, "No df+2 inside the green range", None, None, None, None)
    if rep.t_df is None:
        return DFJudgement(False, "Pressed 2 but never made df", None, idx(rep.t_2), None, None)
    kdf = idx(rep.t_df)
    cue_ms = (rep.t_df - rep.T_hit) * 1000
    if rep.t_2 is None:
        return DFJudgement(False, "Made df but never pressed 2", kdf, None, cue_ms, None)
    k2 = idx(rep.t_2)
    gap_ms = (rep.t_2 - rep.t_df) * 1000
    window = rep.fms * 1000
    if kdf != k2:
        side = "late" if k2 > kdf else "early"
        return DFJudgement(False, f"df and 2 were on different frames - 2 was {abs(gap_ms):.0f} ms {side}",
                           kdf, k2, cue_ms, gap_ms)
    side = "late" if cue_ms > 0 else "early"
    if rep.strict and abs(cue_ms) > max(window / 2, DF_BEAT_TOL_MS):
        return DFJudgement(False, f"Together, but {abs(cue_ms):.0f} ms {side} on the cue",
                           kdf, k2, cue_ms, gap_ms)
    where = "on the cue" if abs(cue_ms) <= window / 2 else f"{abs(cue_ms):.0f} ms {side} of the cue"
    # the auto f sits in stretched frame -gap, so movement = frames from there to df
    real_f = FRAME_MS / 1000

    def ridx(t):
        return math.floor((t - g0) / real_f + 1e-6)

    summary = timing_summary(ridx(rep.t_df) - ridx(rep.T_f), rep.gap * rep.level, rep.level,
                             kdf + rep.gap)
    return DFJudgement(True, "df and 2 landed on the same frame", kdf, k2, cue_ms, gap_ms, summary)


class DFRhythmGame:
    def __init__(self, app: "EWGFTrainerApp", parent: tk.Frame):
        self.app = app
        self.audio = app.audio
        self.win = parent
        self.running = False
        self.rep: Optional[DFRep] = None
        self.prev: Optional[DFRep] = None
        self.held: set[str] = set()
        self.level = DF_START_LEVEL
        self.best_level = DF_START_LEVEL + 1   # none reached yet
        self.hits_at_level = 0
        self.miss_streak = 0
        self.stats = dict(reps=0, hits=0, streak=0, best_streak=0)
        self.history: list[tuple] = []

        self.start_level = tk.IntVar(value=DF_START_LEVEL)
        self.gap = tk.StringVar(value=list(DF_GAPS)[0])
        self.bpm = tk.IntVar(value=DF_BPM)
        self.hits_needed = tk.IntVar(value=DF_HITS_PER_LEVEL)
        self.strict = tk.BooleanVar(value=False)
        self._build_ui()
        self._draw_loop()

    # -- UI -----------------------------------------------------------------
    def _build_ui(self):
        w, font, root = self.win, "Segoe UI", self.app.root
        top = tk.Frame(w, bg=PANEL, padx=12, pady=10)
        top.pack(fill="x", padx=16, pady=(14, 0))
        r1 = tk.Frame(top, bg=PANEL)
        r1.pack(fill="x")
        tk.Label(r1, text="Cue gap", bg=PANEL, fg=MUTED, font=(font, 10)).pack(side="left")
        ui_menu(r1, self.gap, list(DF_GAPS), 22).pack(side="left", padx=(6, 12))
        tk.Label(r1, text="Start level", bg=PANEL, fg=MUTED, font=(font, 10)).pack(side="left")
        ui_spin(r1, root, self.start_level, 1, 20).pack(side="left", padx=(6, 12))
        self.start_btn = tk.Button(r1, text="▶  Start", command=self.toggle, bg=BLUE,
                                   fg="#0b0d10", relief="flat", padx=14,
                                   activebackground=BLUE, font=(font, 10, "bold"))
        self.start_btn.pack(side="right")
        if self.audio.mode is None:
            self.start_btn.config(state="disabled", text="No audio")
        r2 = tk.Frame(top, bg=PANEL)
        r2.pack(fill="x", pady=(8, 0))
        tk.Label(r2, text="BPM", bg=PANEL, fg=MUTED, font=(font, 10)).pack(side="left")
        ui_spin(r2, root, self.bpm, 60, 200, 5).pack(side="left", padx=(6, 12))
        tk.Label(r2, text="Hits per level", bg=PANEL, fg=MUTED, font=(font, 10)).pack(side="left")
        ui_spin(r2, root, self.hits_needed, 1, 10).pack(side="left", padx=(6, 12))
        tk.Label(r2, text="Audio offset ms", bg=PANEL, fg=MUTED, font=(font, 10)).pack(side="left")
        ui_spin(r2, root, self.app.audio_offset, -100, 300, 5).pack(side="left", padx=(6, 12))
        tk.Checkbutton(r2, text="Must hit the cue", variable=self.strict, bg=PANEL, fg=FG,
                       selectcolor=BG, activebackground=PANEL, activeforeground=FG,
                       font=(font, 10)).pack(side="left")

        tk.Label(w, text=(f"Clicks count you in, the f plays by itself, then press df+2 on the "
                          f"second tone: hold ↓ ({KEY_DOWN.upper()}) first, then hit → ({KEY_FORWARD.upper()}) "
                          f"+ 2 ({KEY_RP.upper()}). ↓ must go down before →.  Anywhere in the green range "
                          f"counts as long as f and 2 share a frame."),
                 bg=BG, fg=MUTED, font=(font, 10), wraplength=780).pack(pady=(10, 0))

        # level ladder 10 .. 1
        self.ladder = tk.Canvas(w, height=58, bg=BG, highlightthickness=0)
        self.ladder.pack(fill="x", padx=16, pady=(8, 0))

        self.big = tk.Label(w, text="Press Start", bg=BG, fg=FG, font=(font, 36, "bold"))
        self.big.pack(pady=(6, 0))
        self.sub = tk.Label(w, text="", bg=BG, fg=MUTED, font=(font, 12))
        self.sub.pack()
        self.detail = tk.Label(w, text="", bg=BG, fg=MUTED, font=("Consolas", 11))
        self.detail.pack(pady=(2, 0))
        self.math_lbl = tk.Label(w, text="", bg=BG, fg=GOLD, font=("Segoe UI", 12, "bold"),
                                 justify="center")
        self.math_lbl.pack(pady=(2, 8))

        self.canvas = tk.Canvas(w, height=196, bg=PANEL, highlightthickness=0)
        self.canvas.pack(fill="x", padx=16)

        self.stats_lbl = tk.Label(w, text="", bg=BG, fg=MUTED, font=(font, 10))
        self.stats_lbl.pack(fill="x", padx=16, pady=(10, 4))
        hist = tk.Frame(w, bg=PANEL)
        hist.pack(fill="both", expand=True, padx=16, pady=(0, 14))
        self.hist_box = tk.Listbox(hist, bg=PANEL, fg=FG, font=("Consolas", 10), height=DF_HISTORY,
                                   highlightthickness=0, borderwidth=0, activestyle="none",
                                   selectbackground=PANEL)
        self.hist_box.pack(fill="both", expand=True, padx=6, pady=6)
        self._update_stats()

    def _int(self, var, default):
        try:
            return int(var.get())
        except (tk.TclError, ValueError):
            return default

    def _update_stats(self):
        s = self.stats
        rate = f"{100 * s['hits'] / s['reps']:.0f}%" if s["reps"] else "-"
        best = f"{self.best_level}" if self.best_level <= DF_START_LEVEL * 2 else "-"
        need = self._int(self.hits_needed, 1)
        self.stats_lbl.config(text=(
            f"Level {self.level}  (1 frame = {self.level} frames, {self.level * FRAME_MS:.0f} ms)   ·   "
            f"{self.hits_at_level}/{need} to next   ·   Best cleared {best}   ·   "
            f"Hits {s['hits']}/{s['reps']} ({rate})   ·   Streak {s['streak']} (best {s['best_streak']})"))

    # -- control ------------------------------------------------------------
    def toggle(self):
        if self.running:
            self.stop()
        else:
            self.start()

    def start(self):
        try:
            if isinstance(self.win.focus_get(), tk.Spinbox):
                self.app.root.focus_set()
        except (tk.TclError, KeyError):
            pass
        self.win.update_idletasks()
        self.app.stop_guide()
        self.level = self._int(self.start_level, DF_START_LEVEL)
        self.hits_at_level = self.miss_streak = 0
        self.running = True
        self.prev = None
        self.start_btn.config(text="■  Stop", bg=GOLD, activebackground=GOLD)
        self._update_stats()
        self._schedule_rep(time.perf_counter() + 0.4)

    def stop(self):
        self.running = False
        self.rep = None
        self.audio.cancel_scheduled()
        self.start_btn.config(text="▶  Start", bg=BLUE, activebackground=BLUE)
        self.big.config(text="Paused", fg=FG)

    def _schedule_rep(self, rep_start: float):
        beat = 60.0 / max(30, self._int(self.bpm, DF_BPM))
        gap = DF_GAPS.get(self.gap.get(), 2)
        fms = FRAME_MS * self.level / 1000
        T_f = rep_start + RHYTHM_COUNT_IN * beat
        T_hit = T_f + gap * fms
        off = self._int(self.app.audio_offset, 0) / 1000
        for i in range(RHYTHM_COUNT_IN):
            self.audio.schedule("click", rep_start + i * beat - off)
        self.audio.schedule("f", T_f - off)
        self.audio.schedule("df", T_hit - off)
        win_end = T_hit + max(DF_RANGE_AFTER_S, 2 * fms)
        self.rep = DFRep(rep_start, T_f, T_hit, beat, self.level, fms, gap,
                         win_start=T_f - 0.5 * fms, win_end=win_end, eval_t=win_end + 0.03,
                         strict=bool(self.strict.get()))

    # -- input --------------------------------------------------------------
    def feed(self, kind: str, btn: str, t: float):
        before = frozenset(self.held)
        if kind == "press":
            if btn in self.held:
                return
            self.held.add(btn)
        else:
            self.held.discard(btn)
            rep = self.rep
            if btn == "d" and rep is not None and rep.d_segs and rep.d_segs[-1][1] is None:
                rep.d_segs[-1][1] = t
            return
        rep = self.rep
        if not self.running or rep is None or not rep.win_start <= t <= rep.win_end:
            return
        if btn == "d":
            rep.d_segs.append([t, None])
            if rep.t_d is None:
                rep.t_d = t
        elif btn == "f" and rep.t_f is None:
            rep.t_f = t
        if btn in ("f", "d") and ("d" if btn == "f" else "f") in before:
            if rep.t_df is None:
                rep.t_df = t
        elif btn == "2" and rep.t_2 is None:
            rep.t_2 = t

    def tick(self, now: float):
        rep = self.rep
        if not self.running or rep is None:
            return
        if not rep.start_checked and now >= rep.win_start:
            rep.start_checked = True
            rep.df_held_before = {"f", "d"} <= self.held  # already sitting in df
            rep.d_held_at_start = "d" in self.held       # holding ↓ early is fine
            if rep.d_held_at_start:
                rep.d_segs.append([rep.win_start, None])
        if now >= rep.eval_t:
            self._evaluate(rep)
            self.prev = rep
            self._schedule_rep(now + RHYTHM_REST)

    # -- judging ------------------------------------------------------------
    def _evaluate(self, rep: DFRep):
        j = judge_df_rep(rep)
        rep.grade = "HIT" if j.hit else "MISS"
        rep.judgement = j
        s = self.stats
        s["reps"] += 1
        note, sound = "", "great" if j.hit else "drop"
        need = self._int(self.hits_needed, 1)
        if j.hit:
            s["hits"] += 1
            s["streak"] += 1
            s["best_streak"] = max(s["best_streak"], s["streak"])
            self.miss_streak = 0
            self.hits_at_level += 1
            self.best_level = min(self.best_level, self.level)
            if self.hits_at_level >= need:
                self.hits_at_level = 0
                if self.level > 1:
                    self.level -= 1
                    note = f"Level {self.level}: 1 frame = {self.level} frames ({self.level * FRAME_MS:.0f} ms)"
                    sound = "electric_best"
                else:
                    note = "Real speed - that's an in-game Electric window"
                    sound = "electric_best"
        else:
            s["streak"] = 0
            self.hits_at_level = 0
            self.miss_streak += 1
            if self.miss_streak >= DF_LEVEL_DOWN and self.level < self._int(self.start_level, DF_START_LEVEL):
                self.level += 1
                self.miss_streak = 0
                note = f"Back to level {self.level} ({self.level * FRAME_MS:.0f} ms frame)"
        self.audio.play(sound)

        self.big.config(text="HIT!" if j.hit else "MISS", fg=GOLD if j.hit else RED)
        self.sub.config(text=note or j.reason, fg=(GOLD if j.hit else RED) if note else MUTED)
        self.detail.config(text=self._detail(j, rep))
        self.math_lbl.config(text=j.math)
        self._update_stats()
        self.history.insert(0, (time.strftime("%H:%M:%S"), rep.level, j))
        del self.history[DF_HISTORY:]
        self.hist_box.delete(0, "end")
        for i, (stamp, lvl, hj) in enumerate(self.history):
            self.hist_box.insert("end", f"{stamp}  L{lvl:<2} ({lvl * FRAME_MS:3.0f}ms)  "
                                        f"{'HIT ' if hj.hit else 'MISS'}  {hj.reason}")
            self.hist_box.itemconfig(i, fg=GOLD if hj.hit else RED)

    @staticmethod
    def _detail(j: DFJudgement, rep: DFRep) -> str:
        parts = []
        if j.df_vs_cue_ms is not None:
            ms = round(j.df_vs_cue_ms)
            parts.append("df on the cue" if abs(ms) < 10 else
                         f"df {abs(ms)} ms {'late' if ms > 0 else 'early'}")
        if j.gap_ms is not None:
            ms = round(j.gap_ms)
            parts.append("2 at the same time as df" if abs(ms) < 1 else
                         f"2 {abs(ms)} ms {'after' if ms > 0 else 'before'} df")
        parts.append(f"frame size now {rep.fms * 1000:.0f} ms")
        return "   ·   ".join(parts)

    # -- drawing ------------------------------------------------------------
    def _draw_loop(self):
        if not self.win.winfo_exists():
            return
        now = time.perf_counter()
        rep = self.rep
        if self.running and rep is not None:
            if rep.rep_start <= now < rep.T_f:
                n = int((rep.T_f - now) / rep.beat) + 1
                self.big.config(text=str(min(n, RHYTHM_COUNT_IN)), fg=FG)
            elif rep.T_f <= now < rep.eval_t:
                self.big.config(text="df+2!", fg=BLUE)
        show = rep
        if self.prev is not None and (rep is None or now < rep.T_f - rep.beat):
            show = self.prev
        self._draw_ladder()
        self._draw(show, now)
        self.win.after(16, self._draw_loop)

    def _draw_ladder(self):
        c = self.ladder
        c.delete("all")
        W = max(c.winfo_width(), 400)
        top_level = max(self._int(self.start_level, DF_START_LEVEL), self.level)
        levels = list(range(top_level, 0, -1))
        bw = (W - 4) / len(levels)
        for i, lvl in enumerate(levels):
            x0 = 2 + i * bw
            cur = lvl == self.level
            done = lvl >= self.best_level
            fill = GOLD if cur else (GREEN if done else PANEL)
            c.create_rectangle(x0 + 2, 6, x0 + bw - 2, 36, fill=fill, outline="")
            c.create_text(x0 + bw / 2, 21, text=str(lvl), fill="#0b0d10" if (cur or done) else MUTED,
                          font=("Segoe UI", 11, "bold"))
            c.create_text(x0 + bw / 2, 47, text=f"{lvl * FRAME_MS:.0f}ms", fill=MUTED,
                          font=("Consolas", 8))

    def _draw(self, rep: Optional[DFRep], now: float):
        c = self.canvas
        c.delete("all")
        W = max(c.winfo_width(), 400)
        if rep is None:
            c.create_text(W / 2, 98, text="Press Start. Clicks, then the f tone, then hit df+2 "
                          "on the next tone.\nBlocks are stretched frames; thin lines are real "
                          "game frames.", fill=MUTED, font=("Segoe UI", 11), justify="center")
            return
        s, gap = rep.level, rep.gap
        real_f = FRAME_MS / 1000
        g0 = rep.T_hit - 0.5 * rep.fms           # start of stretched frame 0
        kmin = -gap - 1
        kmax = int((rep.win_end - g0) / rep.fms) + 1
        mmin, mmax = kmin * s, (kmax + 1) * s
        left, right = 70, 12
        colw = (W - left - right) / (mmax - mmin)

        def X(m):
            return left + (m - mmin) * colw

        def R(t):
            return (t - g0) / real_f

        top, bottom = 12, 168
        for k in range(kmin, kmax + 1):
            c.create_rectangle(X(k * s), top, X((k + 1) * s), bottom, outline="",
                               fill=CELL if k % 2 == 0 else PANEL)
            if k == 0:
                c.create_rectangle(X(0) + 1, top + 1, X(s) - 1, bottom - 1, outline=GREEN, width=2)
        # accepted range: df+2 on the same frame anywhere in here counts
        if not rep.strict:
            c.create_rectangle(X(R(rep.win_start)), top, X(R(rep.win_end)), top + 6,
                               fill=GREEN, outline="")
            c.create_rectangle(X(R(rep.win_start)), bottom - 6, X(R(rep.win_end)), bottom,
                               fill=GREEN, outline="")
        if s > 1 and colw >= 3:
            for m in range(mmin, mmax):
                if m % s:
                    c.create_line(X(m), top, X(m), bottom, fill="#3a3f48")
        n_lab = kmax - kmin + 1
        every = 1 if n_lab <= 16 else (2 if n_lab <= 32 else 5)
        for k in range(kmin, kmax + 1):
            if k == 0 or k % every == 0:
                c.create_text(X((k + 0.5) * s), bottom + 14, text=f"{k:+d}" if k else "cue",
                              fill=GREEN if k == 0 else MUTED, font=("Consolas", 9))
        lanes = {"cue": (30, MUTED, "f cue (auto)"), "d": (70, PURPLE, "↓ d"),
                 "f": (108, BLUE, "→ f"), "2": (146, GOLD, "2")}
        for key, (y, col, label) in lanes.items():
            c.create_text(8, y, text=label, anchor="w", fill=col, font=("Segoe UI", 9, "bold"))
        lo, hi = mmin, mmax

        def clipx(m):
            return X(max(lo, min(hi, m)))

        # cues: the auto f, then where your f and 2 should go
        xf = X(R(rep.T_f))
        c.create_oval(xf - 9, 21, xf + 9, 39, fill=BLUE, outline="")
        xh = X(R(rep.T_hit))
        for key in ("f", "2"):
            y = lanes[key][0]
            c.create_oval(xh - 11, y - 11, xh + 11, y + 11, outline=lanes[key][1], width=2)
        c.create_text(xh, 52, text="d down before here", fill=MUTED, font=("Segoe UI", 8))

        # d: hold bar + press dot (held from before the range shows as a bar from the edge)
        y = lanes["d"][0]
        for a, b in rep.d_segs:
            c.create_rectangle(clipx(R(a)), y - 4, clipx(R(b if b is not None else now)), y + 4,
                               fill=PURPLE, outline="")
        if rep.t_d is not None and lo <= R(rep.t_d) <= hi:
            x = X(R(rep.t_d))
            c.create_oval(x - 7, y - 7, x + 7, y + 7, fill=PURPLE, outline=FG)

        # f and 2 presses, boxed by the stretched frame each one landed in
        order_fail = rep.judgement is not None and rep.judgement.reason.startswith("f pressed")
        for key, t in (("f", rep.t_f), ("2", rep.t_2)):
            if t is None:
                continue
            m = R(t)
            if not lo <= m <= hi:
                continue
            y, col, _ = lanes[key]
            if key == "f" and order_fail:
                col = RED
            k = int(m // s)
            c.create_rectangle(X(k * s) + 2, y - 15, X((k + 1) * s) - 2, y + 15, outline=col, width=1)
            if key == "f":
                c.create_polygon(X(m), y - 9, X(m) + 9, y, X(m), y + 9, X(m) - 9, y,
                                 fill=col, outline="")
                if order_fail:
                    c.create_text(X(m), y - 20, text="before d!", fill=RED,
                                  font=("Segoe UI", 8, "bold"))
            else:
                c.create_line(X(m), y - 12, X(m), y + 12, fill=col, width=3)
        p = R(now)
        if rep.grade is None and lo <= p <= hi:
            c.create_line(X(p), top, X(p), bottom, fill=GOLD, width=2)



def main():
    if sys.platform == "win32":
        try:
            import ctypes
            # own taskbar entry + icon instead of grouping under python.exe
            ctypes.windll.shell32.SetCurrentProcessExplicitAppUserModelID("EWGFPractice.App")
            ctypes.windll.winmm.timeBeginPeriod(1)  # smoother 1 ms timers
            ctypes.windll.shcore.SetProcessDpiAwareness(1)
        except Exception:
            pass
    root = tk.Tk()
    EWGFTrainerApp(root)
    root.mainloop()


if __name__ == "__main__":
    main()
