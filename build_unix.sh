#!/usr/bin/env bash
# Build FOLIO as a single executable (desktop app, no browser needed).
# Run this from inside the project folder, with your venv activated.
set -e

pip install -r requirements.txt

pyinstaller --onefile --windowed --name FOLIO \
  --add-data "templates:templates" \
  --add-data "static:static" \
  app.py

echo
echo "Done. Your app is at dist/FOLIO"
echo "Copy just that one file anywhere to run it — no Python install needed."
