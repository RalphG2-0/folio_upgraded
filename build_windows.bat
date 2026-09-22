@echo off
REM Build FOLIO as a single Windows .exe (desktop app, no browser needed).
REM Run this from inside the project folder, with your venv activated.

pip install -r requirements.txt

pyinstaller --onefile --windowed --name FOLIO ^
  --add-data "templates;templates" ^
  --add-data "static;static" ^
  app.py

echo.
echo Done. Your app is at dist\FOLIO.exe
echo Copy just that one file anywhere to run it - no Python install needed.
pause
