# EWGF Practice

A free Tekken 8 **Electric Wind God Fist** trainer. Every input is judged on 60 fps game
frames, the same way the game reads it, so a 3 ms gap can still miss if it crosses a frame line.

**▶ Play in your browser: https://slasher1v.github.io/ewgf-practice/**
Works with a keyboard or a controller - nothing to install.

**⬇ Windows desktop version: [download the latest release](https://github.com/Slasher1v/ewgf-practice/releases/latest)**
(unzip and run `EWGF Practice.exe` - it hears your keys even while Tekken is the active window).

## Three modes

- **EWGF Trainer** - do f, n, d, df+2 and see your speed (i13, i14, i15...), why a drop
  happened, and a frame-by-frame input history of what you held and what the game read.
- **Rhythm Game** - press forward whenever you're ready; you hear a beep on your f, a tone
  where d goes and a chime where df+2 should land. Start slowed down 8x and it speeds up
  as you get reps clean. df and 2 always have to share a real game frame.
- **df+2 Trainer** - drills just the "df and 2 on the same frame" part. The frame starts
  stretched to 10 real frames and shrinks by one every hit, down to the real window.

## Leaderboard

The browser version has an online **🏆 Leaderboard** tab. Players make an account with just a
username and password (no email), and their best runs are saved automatically on four boards:
Electric streak, Electric rate (best 50 in a row), Real-speed combo (Rhythm Game) and
Just-frame streak (df+2 at level 1). The desktop app doesn't submit scores.

Scores are sent from the player's own browser, so someone determined could fake one. The
database only lets each player raise their own best, and nobody can edit anyone else's.

### Turning it on (one time, about 5 minutes)

1. Make a free account at [supabase.com](https://supabase.com) and create a new project
   (any name and region; save the database password somewhere).
2. **SQL Editor -> New query**: paste everything from [`supabase/setup.sql`](supabase/setup.sql)
   and press **Run**.
3. **Authentication -> Sign In / Providers -> Email**: turn **off** "Confirm email" and save.
   (Usernames are turned into placeholder addresses that can't receive mail.)
4. **Project Settings -> API**: copy the **Project URL** and the **anon public** key into
   [`docs/js/supabase-config.js`](docs/js/supabase-config.js), then commit and push.

Until step 4 is done, the Leaderboard tab just says it isn't switched on yet and the site
works fully offline. To remove a player, delete them under **Authentication -> Users**
(their scores go with them).

## Controls

Default keyboard: forward **D**, back **A**, down **S**, up **Space**, 1-4 = **U I J K**.
Controllers: d-pad or left stick, face buttons for 1-4. Everything can be rebound in
**Settings**, and there's a 2P-side option.

The browser version only hears your keys while its tab is focused. The Windows desktop
version (below) listens globally, so it can run next to the actual game.

## Files

- `docs/` - the web version (plain HTML/CSS/JavaScript, no build step). GitHub Pages
  serves this folder.
- `supabase/setup.sql` - the leaderboard database (accounts, scores and the rules that
  protect them).
- `ewgf_trainer.py` - the Windows desktop version (Python + Tkinter).
  Run with `pip install pynput numpy sounddevice` then `python ewgf_trainer.py`,
  or build `EWGF Practice.exe` with `build_exe.bat`.

Motion leniency windows (how long neutral or d may last) are estimates - Bandai Namco
doesn't publish them. The df+2 same-frame rule is exact. Not affiliated with Bandai Namco.
