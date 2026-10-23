# EWGF Practice

A free Tekken 8 **Electric Wind God Fist** trainer. Every input is judged on 60 fps game
frames, the same way the game reads it, so a 3 ms gap can still miss if it crosses a frame line.

**Play in your browser:** open the GitHub Pages link for this repo (Settings → Pages).
Works with a keyboard or a controller - nothing to install.

## Three modes

- **EWGF Trainer** - do f, n, d, df+2 and see your speed (i13, i14, i15...), why a drop
  happened, and a frame-by-frame input history of what you held and what the game read.
- **Rhythm Game** - press forward whenever you're ready; you hear a beep on your f, a tone
  where d goes and a chime where df+2 should land. Start slowed down 8x and it speeds up
  as you get reps clean. df and 2 always have to share a real game frame.
- **df+2 Trainer** - drills just the "df and 2 on the same frame" part. The frame starts
  stretched to 10 real frames and shrinks by one every hit, down to the real window.

## Controls

Default keyboard: forward **D**, back **A**, down **S**, up **Space**, 1-4 = **U I J K**.
Controllers: d-pad or left stick, face buttons for 1-4. Everything can be rebound in
**Settings**, and there's a 2P-side option.

The browser version only hears your keys while its tab is focused. The Windows desktop
version (below) listens globally, so it can run next to the actual game.

## Files

- `docs/` - the web version (plain HTML/CSS/JavaScript, no build step). GitHub Pages
  serves this folder.
- `ewgf_trainer.py` - the Windows desktop version (Python + Tkinter).
  Run with `pip install pynput numpy sounddevice` then `python ewgf_trainer.py`,
  or build `EWGF Practice.exe` with `build_exe.bat`.

Motion leniency windows (how long neutral or d may last) are estimates - Bandai Namco
doesn't publish them. The df+2 same-frame rule is exact. Not affiliated with Bandai Namco.
