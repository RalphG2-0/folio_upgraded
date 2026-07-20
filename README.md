# FOLIO — PDF Reader (Upgraded)

A fast, beautiful local PDF reader that runs in your browser.

## New in this version

- 🔍 **Full-text search** — search across all pages with highlighted snippets (Ctrl+F)
- 📑 **Table of Contents** — sidebar panel shows PDF bookmarks/outline
- 🖼️ **Page thumbnails** — visual grid of all pages for quick navigation
- ℹ️ **Document info panel** — metadata: title, author, page count, file size (I key)
- ⬇️ **Download button** — download the active PDF directly from the toolbar
- ⛶ **Fullscreen mode** — distraction-free reading (F key)
- 📦 **File size display** — shown in the library alongside page count
- 🆕 **S key** — toggle sidebar from keyboard
- 🆕 **P key** — fit page zoom mode

## Features
- Open and read multiple PDFs
- Continuous scroll — auto-flows to next file
- Zoom in/out (Ctrl+Scroll or toolbar buttons), 30%–400%
- Dark / Light mode toggle
- Drag-and-drop upload to sidebar
- Two-page spread view
- Lazy page rendering with background prefetch
- Reading progress bar
- Page indicator with jump-to-page input
- Parallel server-side rendering with JPEG compression and ETag caching

## Setup

```bash
pip install -r requirements.txt
python app.py
```

Then open **http://localhost:5000**

## Keyboard Shortcuts
| Key | Action |
|-----|--------|
| `+` / `-` | Zoom in / out |
| `0` | Reset zoom |
| `W` | Fit width |
| `P` | Fit page |
| `F` | Toggle fullscreen |
| `S` | Toggle sidebar |
| `Ctrl+F` | Search in document |
| `I` | Document info |
| `←` / `→` | Previous / next file |
| `D` | Toggle dark/light mode |
| `?` | Keyboard shortcut reference |
| `Esc` | Close panels |
