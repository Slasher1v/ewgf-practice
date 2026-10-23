@echo off
rem Rebuilds "EWGF Practice.exe" from ewgf_trainer.py. Run after changing the code.
cd /d "%~dp0"
python -m pip install --quiet pyinstaller pynput numpy sounddevice
python -m PyInstaller --noconfirm --onefile --windowed --name "EWGF Practice" ^
  --icon ewgf_practice.ico --add-data "ewgf_practice.ico;." ^
  --hidden-import pynput.keyboard._win32 --hidden-import pynput.mouse._win32 ^
  --distpath . --workpath build --specpath build ewgf_trainer.py
echo.
echo Done: "EWGF Practice.exe"
pause
