EWGF PRACTICE
Tekken 8 Electric Wind God Fist trainer (Windows)
=================================================

HOW TO START
  Double-click "EWGF Practice.exe". Nothing to install.
  It can take a few seconds to open the first time.

  If Windows shows "Windows protected your PC", click "More info" and then
  "Run anyway". This happens with most small home-made programs.


DEFAULT KEYS (keyboard, player 1 side)
  Forward (f)  = D        Back = A
  Down (d)     = S        Up   = Space
  1 = U    2 = I    3 = J    4 = K

  The app listens to your keyboard even when the game window is in front,
  so you can keep it open next to Tekken. It only reacts to the keys above.


THE THREE TABS

  EWGF Trainer
    Do the EWGF the normal way: f, n, d, df+2. Every attempt is judged on
    60 fps game frames, the same way the game reads it, and shows:
      - your speed (i14, i15...) or why it dropped
      - an input history: one column per game frame, showing what you held
        and what the game read
      - your last 10 attempts and success rate
    The Audio Trainer panel at the bottom plays the rhythm of an i13-i16
    EWGF (real speed or slowed down) so you can learn it by ear.

  Rhythm Game
    Press Start, then press forward whenever you're ready. You hear a beep
    on your f, a tone where d goes, and a chime where df+2 should land.
    Start slowed down (8x) - after 5 clean reps it speeds up automatically,
    all the way to real speed. df and 2 always have to land on the same
    real game frame, even when slowed down.

  df+2 Trainer
    Drills only the "df and 2 on the same frame" part. The f is played for
    you; hold down first, then press forward + 2 on the second tone.
    It starts easy (1 frame stretched to 10 frames) and every hit makes the
    window one step smaller, until you're at the real 1-frame window.
    Down must be pressed before forward or it counts as a miss.


SOUND
  Volume slider and on/off switches are in the Audio Trainer panel.
  If you use Bluetooth headphones, raise "Audio offset ms" until the tones
  feel in time.


FOR TINKERERS (optional)
  ewgf_trainer.py is the source code. Key bindings, timing windows and
  sounds are settings at the top of that file.
  To run it from source:   pip install pynput numpy sounddevice
                           python ewgf_trainer.py
  After changing the code, double-click build_exe.bat to rebuild the .exe
  (needs Python installed).
