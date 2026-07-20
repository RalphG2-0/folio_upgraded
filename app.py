"""
FOLIO PDF Reader — Upgraded Flask App
Run:  python app.py
Then open http://localhost:5000
"""

import io
import re
import base64
import hashlib
import threading
import json
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor

from flask import Flask, render_template, request, jsonify, abort, make_response, send_file
import pypdfium2 as pdfium
from PIL import Image

# ── Config ───────────────────────────────────────────────────────────
UPLOAD_FOLDER  = Path(__file__).parent / "uploads"
UPLOAD_FOLDER.mkdir(exist_ok=True)
ALLOWED_EXT    = {".pdf"}
MAX_BATCH      = 6
JPEG_QUALITY   = 85
THUMB_QUALITY  = 70
RENDER_THREADS = 4
THUMB_SCALE    = 0.3    # scale for sidebar thumbnails

app = Flask(__name__)
app.config["MAX_CONTENT_LENGTH"] = 300 * 1024 * 1024   # 300 MB

# ── Thread pool ──────────────────────────────────────────────────────
_executor = ThreadPoolExecutor(max_workers=RENDER_THREADS)

# ── PDFium global lock ──────────────────────────────────────────────
# PDFium is NOT thread-safe — not even across separate document handles on
# different threads. Calling into it concurrently from more than one thread
# causes an access-violation crash that kills the whole process (this is
# what was making the server "shut down"). Per-thread handles do NOT fix
# this; pdfium itself requires that only one thread call into it at a time.
# See: https://pypdfium2.readthedocs.io/en/stable/python_api.html
# So: one shared lock guards every pdfium call, and one shared dict of
# document handles (no need for per-thread copies once we're serialized).
_pdfium_lock = threading.Lock()
_docs: dict = {}

def _get_doc(pdf_path: str) -> pdfium.PdfDocument:
    """Return the shared PdfDocument for pdf_path. Caller must hold _pdfium_lock."""
    if pdf_path not in _docs:
        _docs[pdf_path] = pdfium.PdfDocument(pdf_path)
    return _docs[pdf_path]

def _evict_doc(pdf_path: str):
    """Close and forget a document handle (e.g. before deleting the file)."""
    with _pdfium_lock:
        old = _docs.pop(pdf_path, None)
        if old:
            try:
                old.close()
            except Exception:
                pass

# ── PDF registry ─────────────────────────────────────────────────────
_registry: dict = {}

def _register_pdfs():
    _registry.clear()
    for f in sorted(UPLOAD_FOLDER.glob("*.pdf")):
        try:
            with _pdfium_lock:
                doc = _get_doc(str(f))
                # Extract basic metadata
                meta = {}
                try:
                    meta["title"]    = doc.get_metadata_value("Title") or ""
                    meta["author"]   = doc.get_metadata_value("Author") or ""
                    meta["subject"]  = doc.get_metadata_value("Subject") or ""
                    meta["creator"]  = doc.get_metadata_value("Creator") or ""
                except Exception:
                    pass
                page_count = len(doc)
            _registry[f.name] = {
                "path":       str(f),
                "page_count": page_count,
                "size":       f.stat().st_size,
                "meta":       meta,
            }
        except Exception:
            pass

_register_pdfs()

# ── Render helpers ───────────────────────────────────────────────────
def _render_jpeg(pdf_path: str, page_idx: int, scale: float, quality: int = None) -> bytes:
    if quality is None:
        quality = JPEG_QUALITY
    # All pdfium calls (doc/page access, rendering, bitmap conversion) must be
    # serialized — pdfium crashes the whole process if called from more than
    # one thread at once, even on different documents/pages.
    with _pdfium_lock:
        doc  = _get_doc(pdf_path)
        page = doc[page_idx]
        bm   = page.render(scale=scale, rotation=0)
        img  = bm.to_pil()
    # JPEG encoding below is pure Pillow (no pdfium calls) so it's fine to
    # let it run outside the lock, in parallel across threads.
    if img.mode in ("RGBA", "LA"):
        bg = Image.new("RGB", img.size, (255, 255, 255))
        bg.paste(img, mask=img.split()[-1])
        img = bg
    elif img.mode != "RGB":
        img = img.convert("RGB")
    buf = io.BytesIO()
    img.save(buf, format="JPEG", quality=quality, optimize=True, progressive=True)
    buf.seek(0)
    return buf.read()

def _render_b64(pdf_path: str, page_idx: int, scale: float) -> str:
    return base64.b64encode(_render_jpeg(pdf_path, page_idx, scale)).decode()

def _render_thumb_b64(pdf_path: str, page_idx: int) -> str:
    return base64.b64encode(
        _render_jpeg(pdf_path, page_idx, THUMB_SCALE, THUMB_QUALITY)
    ).decode()

def _etag(pdf_path: str, page_idx: int, scale: float) -> str:
    key = f"{pdf_path}:{page_idx}:{scale:.2f}"
    return hashlib.md5(key.encode()).hexdigest()

def _cached_response(data: dict, etag: str):
    if request.headers.get("If-None-Match") == etag:
        return "", 304
    resp = make_response(jsonify(data))
    resp.headers["ETag"]          = etag
    resp.headers["Cache-Control"] = "private, max-age=3600"
    return resp

# ── TOC / Outline helper ─────────────────────────────────────────────
def _extract_toc(doc: pdfium.PdfDocument) -> list:
    """Walk pypdfium2 bookmarks into a simple list."""
    toc = []
    try:
        def _walk(bookmark, depth=0):
            title = bookmark.get_title()
            dest  = bookmark.get_dest()
            page  = 0
            if dest is not None:
                try:
                    page = dest.get_index()
                except Exception:
                    page = 0
            toc.append({"title": title or "(untitled)", "page": page, "depth": depth})
            child = bookmark.get_first_child()
            while child:
                _walk(child, depth + 1)
                child = child.get_next_sibling()

        with _pdfium_lock:
            bm = doc.get_first_bookmark()
            while bm:
                _walk(bm)
                bm = bm.get_next_sibling()
    except Exception:
        pass
    return toc

# ── Text extraction helper ───────────────────────────────────────────
def _extract_page_text(pdf_path: str, page_idx: int) -> str:
    """Extract plain text from a single page."""
    try:
        with _pdfium_lock:
            doc  = _get_doc(pdf_path)
            page = doc[page_idx]
            textpage = page.get_textpage()
            text = textpage.get_text_range()
        return text or ""
    except Exception:
        return ""

# ── Routes ───────────────────────────────────────────────────────────

@app.route("/")
def index():
    return render_template("index.html")


@app.route("/api/files")
def api_files():
    return jsonify([
        {
            "name":   k,
            "pages":  v["page_count"],
            "size":   v["size"],
            "meta":   v["meta"],
        }
        for k, v in _registry.items()
    ])


@app.route("/api/upload", methods=["POST"])
def api_upload():
    uploaded = []
    for f in request.files.getlist("files"):
        if Path(f.filename).suffix.lower() not in ALLOWED_EXT:
            continue
        dest = UPLOAD_FOLDER / f.filename
        f.save(dest)
        uploaded.append(f.filename)
    _register_pdfs()
    return jsonify({"uploaded": uploaded, "files": [
        {"name": k, "pages": v["page_count"], "size": v["size"], "meta": v["meta"]}
        for k, v in _registry.items()
    ]})


@app.route("/api/delete/<filename>", methods=["DELETE"])
def api_delete(filename):
    info = _registry.get(filename)
    if info:
        _evict_doc(info["path"])
        Path(info["path"]).unlink(missing_ok=True)
    _register_pdfs()
    return jsonify({"ok": True})


@app.route("/api/download/<filename>")
def api_download(filename):
    info = _registry.get(filename)
    if not info:
        abort(404)
    return send_file(info["path"], as_attachment=True, download_name=filename)


@app.route("/api/page/<filename>/<int:page>")
def api_page(filename, page):
    if filename not in _registry:
        abort(404)
    info  = _registry[filename]
    if page < 0 or page >= info["page_count"]:
        abort(404)
    scale = max(0.3, min(float(request.args.get("scale", 1.5)), 5.0))
    etag  = _etag(info["path"], page, scale)
    if request.headers.get("If-None-Match") == etag:
        return "", 304
    b64  = _render_b64(info["path"], page, scale)
    data = {"page": page, "total": info["page_count"],
            "img": b64, "filename": filename, "fmt": "jpeg"}
    return _cached_response(data, etag)


@app.route("/api/batch/<filename>")
def api_batch(filename):
    if filename not in _registry:
        abort(404)
    info  = _registry[filename]
    start = int(request.args.get("start", 0))
    count = min(int(request.args.get("count", 3)), MAX_BATCH)
    scale = max(0.3, min(float(request.args.get("scale", 1.5)), 5.0))

    indices = list(range(start, min(start + count, info["page_count"])))
    if not indices:
        return jsonify({"filename": filename, "total": info["page_count"], "pages": []})

    futures = {
        i: _executor.submit(_render_b64, info["path"], i, scale)
        for i in indices
    }
    pages = []
    for i in indices:
        try:
            pages.append({"page": i, "img": futures[i].result(timeout=30)})
        except Exception as exc:
            app.logger.error(f"Render error page {i}: {exc}")

    return jsonify({
        "filename": filename,
        "total":    info["page_count"],
        "pages":    pages,
        "fmt":      "jpeg",
    })


@app.route("/api/prefetch/<filename>")
def api_prefetch(filename):
    if filename not in _registry:
        abort(404)
    info  = _registry[filename]
    start = int(request.args.get("start", 0))
    count = min(int(request.args.get("count", 4)), MAX_BATCH)
    scale = max(0.3, min(float(request.args.get("scale", 1.5)), 5.0))
    for i in range(start, min(start + count, info["page_count"])):
        _executor.submit(_render_b64, info["path"], i, scale)
    return "", 204


@app.route("/api/thumbnails/<filename>")
def api_thumbnails(filename):
    """Batch-render thumbnails for the strip panel."""
    if filename not in _registry:
        abort(404)
    info  = _registry[filename]
    start = int(request.args.get("start", 0))
    count = min(int(request.args.get("count", 10)), 20)
    indices = list(range(start, min(start + count, info["page_count"])))
    futures = {
        i: _executor.submit(_render_thumb_b64, info["path"], i)
        for i in indices
    }
    thumbs = []
    for i in indices:
        try:
            thumbs.append({"page": i, "img": futures[i].result(timeout=15)})
        except Exception:
            pass
    return jsonify({
        "filename": filename,
        "total":    info["page_count"],
        "thumbs":   thumbs,
    })


@app.route("/api/toc/<filename>")
def api_toc(filename):
    """Return table of contents / bookmarks."""
    if filename not in _registry:
        abort(404)
    info = _registry[filename]
    with _pdfium_lock:
        doc = _get_doc(info["path"])
    return jsonify({"toc": _extract_toc(doc)})


@app.route("/api/search/<filename>")
def api_search(filename):
    """Full-text search across all pages."""
    if filename not in _registry:
        abort(404)
    query = request.args.get("q", "").strip()
    if not query or len(query) < 2:
        return jsonify({"results": [], "query": query})

    info    = _registry[filename]
    results = []
    pattern = re.compile(re.escape(query), re.IGNORECASE)

    for page_idx in range(info["page_count"]):
        try:
            text = _extract_page_text(info["path"], page_idx)
            if not text:
                continue
            matches = list(pattern.finditer(text))
            if not matches:
                continue
            snippets = []
            for m in matches[:3]:   # up to 3 snippets per page
                start = max(0, m.start() - 60)
                end   = min(len(text), m.end() + 60)
                snippet = text[start:end].replace("\n", " ").strip()
                # highlight the match inside snippet
                snippets.append(snippet)
            results.append({
                "page":     page_idx,
                "count":    len(matches),
                "snippets": snippets,
            })
        except Exception:
            pass

    return jsonify({"results": results, "query": query, "total": len(results)})


@app.route("/api/info/<filename>")
def api_info(filename):
    """Return metadata + page count + TOC summary."""
    if filename not in _registry:
        abort(404)
    info = _registry[filename]
    with _pdfium_lock:
        doc = _get_doc(info["path"])
    toc  = _extract_toc(doc)
    return jsonify({
        "name":       filename,
        "pages":      info["page_count"],
        "size":       info["size"],
        "meta":       info["meta"],
        "toc_count":  len(toc),
    })


if __name__ == "__main__":
    print("\n🚀  FOLIO running at http://localhost:5000\n")
    app.run(debug=False, port=5000, threaded=True)
