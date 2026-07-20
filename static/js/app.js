/* ================================================================
   FOLIO PDF READER — Upgraded JS
================================================================ */
'use strict';

// ── State ─────────────────────────────────────────────────────────
const state = {
  files:        [],
  activeIdx:    -1,
  zoom:         1.0,
  continuous:   true,
  twoPage:      false,
  showPageNums: true,
  darkMode:     true,
  rendered:     new Map(),
  currentPage:  0,
  pendingFetch: new Set(),
  searchOpen:   false,
  infoOpen:     false,
};

const BASE_SCALE   = 1.5;
const ZOOM_STEP    = 0.15;
const ZOOM_MIN     = 0.3;
const ZOOM_MAX     = 4.0;
const PREFETCH_AHD = 3;
const LAZY_MARGIN  = '600px';

// ── DOM ───────────────────────────────────────────────────────────
const $ = id => document.getElementById(id);
const sidebar         = $('sidebar');
const fileList        = $('fileList');
const pagesContainer  = $('pagesContainer');
const emptyState      = $('emptyState');
const docTitle        = $('docTitle');
const zoomLabel       = $('zoomLabel');
const pageInput       = $('pageInput');
const totalPagesEl    = $('totalPages');
const pageIndicator   = $('pageIndicator');
const viewerScroll    = $('viewerScroll');
const loadingOverlay  = $('loadingOverlay');
const loadingText     = $('loadingText');
const readProgressBar = $('readProgressBar');
const shortcutsPanel  = $('shortcutsPanel');
const searchBar       = $('searchBar');
const searchInput     = $('searchInput');
const searchCount     = $('searchCount');
const searchResults   = $('searchResults');
const tocList         = $('tocList');
const tocEmpty        = $('tocEmpty');
const thumbGrid       = $('thumbGrid');
const thumbLoading    = $('thumbLoading');
const infoPanel       = $('infoPanel');
const infoPanelBody   = $('infoPanelBody');

// ── Loading ───────────────────────────────────────────────────────
let _loadingCount = 0;
function showLoading(msg = 'Loading…') {
  _loadingCount++;
  loadingText.textContent = msg;
  loadingOverlay.classList.add('visible');
}
function hideLoading() {
  if (--_loadingCount <= 0) { _loadingCount = 0; loadingOverlay.classList.remove('visible'); }
}

function setZoomLabel(z) { zoomLabel.textContent = Math.round(z * 100) + '%'; }

// ── Rendered tracking ─────────────────────────────────────────────
function isRendered(fn, i)  { return state.rendered.get(fn)?.has(i) ?? false; }
function markRendered(fn, i){ if (!state.rendered.has(fn)) state.rendered.set(fn, new Set()); state.rendered.get(fn).add(i); }

// ── Sidebar tabs ──────────────────────────────────────────────────
document.querySelectorAll('.stab').forEach(btn => {
  btn.addEventListener('click', () => {
    const tab = btn.dataset.tab;
    document.querySelectorAll('.stab').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.stab-panel').forEach(p => p.classList.remove('active'));
    btn.classList.add('active');
    $(`panel-${tab}`).classList.add('active');
    if (tab === 'thumbs') loadThumbs();
    if (tab === 'toc')    loadToc();
  });
});

// ── File list ─────────────────────────────────────────────────────
function fmtSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024*1024) return (bytes/1024).toFixed(0) + ' KB';
  return (bytes/(1024*1024)).toFixed(1) + ' MB';
}

function renderFileList() {
  fileList.innerHTML = '';
  if (!state.files.length) {
    fileList.innerHTML = `<li style="padding:10px 14px;font-size:12px;color:var(--text3)">No PDFs yet</li>`;
    return;
  }
  state.files.forEach((f, i) => {
    const li = document.createElement('li');
    li.className = 'file-item' + (i === state.activeIdx ? ' active' : '');
    li.innerHTML = `
      <div class="file-icon">PDF</div>
      <div class="file-meta">
        <div class="file-name" title="${f.name}">${f.name}</div>
        <div class="file-info-row">
          <div class="file-pages">${f.pages}p</div>
          <div class="file-size">${fmtSize(f.size || 0)}</div>
        </div>
      </div>
      <button class="file-del" title="Remove">✕</button>`;
    li.querySelector('.file-del').addEventListener('click', e => { e.stopPropagation(); deleteFile(i); });
    li.addEventListener('click', e => { if (e.target.classList.contains('file-del')) return; openFile(i); });
    fileList.appendChild(li);
  });
}

async function fetchFiles() {
  const res = await fetch('/api/files');
  state.files = await res.json();
  renderFileList();
}

// ── Open file ─────────────────────────────────────────────────────
async function openFile(idx) {
  if (idx < 0 || idx >= state.files.length) return;
  state.activeIdx   = idx;
  state.currentPage = 0;

  const file = state.files[idx];
  docTitle.textContent     = file.name;
  pageInput.value          = 1;
  totalPagesEl.textContent = file.pages;
  pageIndicator.style.display = 'flex';
  $('downloadBtn').style.display = '';
  $('infoBtn').style.display = '';

  emptyState.style.display     = 'none';
  pagesContainer.style.display = 'flex';
  pagesContainer.innerHTML     = '';
  pagesContainer.className     = 'pages-container' + (state.twoPage ? ' two-page' : '');

  if (lazyObserver) { lazyObserver.disconnect(); lazyObserver = null; }
  state.pendingFetch.clear();

  // Reset continuous-scroll tracking: mark every file before this one as
  // "already appended" so checkContinuousScroll only looks forward.
  _appendedFiles.clear();
  _appendingFiles.clear();
  for (let i = 0; i <= idx; i++) _appendedFiles.add(state.files[i].name);

  renderFileList();

  // Reset thumb/TOC panels
  thumbGrid.innerHTML = '';
  tocList.innerHTML   = '';
  tocEmpty.style.display = 'flex';
  tocList.style.display  = 'none';
  _tocLoaded = null;
  _thumbsFile = null;

  showLoading('Rendering…');
  const firstBatch = Math.min(3, file.pages);
  await renderBatch(file.name, 0, firstBatch);
  viewerScroll.scrollTop = 0;
  hideLoading();
  updateProgress();

  if (file.pages > firstBatch) {
    insertPlaceholders(file.name, firstBatch, file.pages);
    setupLazyObserver();
  }
  prefetchAhead(file.name, firstBatch, PREFETCH_AHD);

  // If currently on thumbs tab, load them
  if ($('panel-thumbs').classList.contains('active')) loadThumbs();
  if ($('panel-toc').classList.contains('active'))    loadToc();
}

// ── Batch fetch ───────────────────────────────────────────────────
async function renderBatch(filename, start, count) {
  const scale = (BASE_SCALE * state.zoom).toFixed(2);
  const res   = await fetch(`/api/batch/${enc(filename)}?start=${start}&count=${count}&scale=${scale}`);
  const data  = await res.json();
  for (const p of data.pages) {
    if (isRendered(filename, p.page)) continue;
    markRendered(filename, p.page);
    appendPage(p.page, p.img, filename, data.total);
  }
}

function prefetchAhead(filename, start, count) {
  const scale = (BASE_SCALE * state.zoom).toFixed(2);
  fetch(`/api/prefetch/${enc(filename)}?start=${start}&count=${count}&scale=${scale}`).catch(() => {});
}

// ── Build page DOM ────────────────────────────────────────────────
// appendPage never inserts separators — callers do that explicitly before
// calling renderBatch, so separator position is always correct.
function appendPage(pageIdx, b64img, filename, total) {
  const wrap = document.createElement('div');
  wrap.className    = 'page-wrapper';
  wrap.dataset.page = pageIdx;
  wrap.dataset.file = filename;

  const img = document.createElement('img');
  img.className = 'page-img';
  img.src       = `data:image/jpeg;base64,${b64img}`;
  img.alt       = `Page ${pageIdx + 1}`;
  img.draggable = false;
  wrap.appendChild(img);

  if (state.showPageNums) {
    const badge       = document.createElement('div');
    badge.className   = 'page-badge';
    badge.textContent = `${pageIdx + 1} / ${total}`;
    wrap.appendChild(badge);
  }
  pagesContainer.appendChild(wrap);
}

function makeSeparator(filename) {
  const sep = document.createElement('div');
  sep.className = 'file-separator';
  sep.dataset.sep = filename;
  sep.innerHTML = `<span>${filename}</span>`;
  return sep;
}

function insertPlaceholders(filename, from, total) {
  const frag = document.createDocumentFragment();
  for (let i = from; i < total; i++) {
    const wrap = document.createElement('div');
    wrap.className    = 'page-wrapper';
    wrap.dataset.page = i;
    wrap.dataset.file = filename;
    wrap.dataset.lazy = '1';

    const ph = document.createElement('div');
    ph.className = 'page-placeholder';
    ph.innerHTML = '<div class="spinner-sm"></div>';
    wrap.appendChild(ph);

    if (state.showPageNums) {
      const badge       = document.createElement('div');
      badge.className   = 'page-badge';
      badge.textContent = `${i + 1} / ${total}`;
      wrap.appendChild(badge);
    }
    frag.appendChild(wrap);
  }
  pagesContainer.appendChild(frag);
}

// ── IntersectionObserver ──────────────────────────────────────────
let lazyObserver = null;

function setupLazyObserver() {
  if (lazyObserver) lazyObserver.disconnect();
  let pendingBatch = new Set();
  let batchTimer   = null;

  const flush = async () => {
    batchTimer = null;
    if (!pendingBatch.size) return;
    const toLoad = [...pendingBatch]
      .filter(idx => !isRendered(state.files[state.activeIdx]?.name, idx) && !state.pendingFetch.has(idx))
      .sort((a, b) => a - b);
    pendingBatch.clear();
    if (!toLoad.length) return;

    const filename = state.files[state.activeIdx]?.name;
    if (!filename) return;

    const groups = [];
    let g = [toLoad[0]];
    for (let k = 1; k < toLoad.length; k++) {
      if (toLoad[k] === toLoad[k-1] + 1 && g.length < 4) { g.push(toLoad[k]); }
      else { groups.push(g); g = [toLoad[k]]; }
    }
    groups.push(g);

    for (const group of groups) {
      group.forEach(i => state.pendingFetch.add(i));
      try {
        const scale = (BASE_SCALE * state.zoom).toFixed(2);
        const res   = await fetch(`/api/batch/${enc(filename)}?start=${group[0]}&count=${group.length}&scale=${scale}`);
        const data  = await res.json();
        for (const p of data.pages) {
          state.pendingFetch.delete(p.page);
          if (isRendered(filename, p.page)) continue;
          markRendered(filename, p.page);

          const wrap = pagesContainer.querySelector(`.page-wrapper[data-page="${p.page}"][data-file="${filename}"]`);
          if (!wrap || !wrap.dataset.lazy) continue;
          delete wrap.dataset.lazy;

          const img       = document.createElement('img');
          img.className   = 'page-img';
          img.src         = `data:image/jpeg;base64,${p.img}`;
          img.alt         = `Page ${p.page + 1}`;
          img.draggable   = false;
          img.style.opacity    = '0';
          img.style.transition = 'opacity 0.25s';
          img.onload = () => { img.style.opacity = '1'; };

          wrap.innerHTML = '';
          wrap.appendChild(img);
          if (state.showPageNums) {
            const badge       = document.createElement('div');
            badge.className   = 'page-badge';
            badge.textContent = `${p.page + 1} / ${data.total}`;
            wrap.appendChild(badge);
          }
          // Update thumb if visible
          updateThumbActive(p.page);
        }
        prefetchAhead(filename, group[group.length - 1] + 1, PREFETCH_AHD);
      } catch(e) {
        group.forEach(i => state.pendingFetch.delete(i));
      }
    }
  };

  lazyObserver = new IntersectionObserver(entries => {
    let changed = false;
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      const wrap = entry.target;
      if (!wrap.dataset.lazy) { lazyObserver.unobserve(wrap); continue; }
      const idx = parseInt(wrap.dataset.page);
      if (!pendingBatch.has(idx)) { pendingBatch.add(idx); changed = true; }
    }
    if (!changed) return;
    clearTimeout(batchTimer);
    batchTimer = setTimeout(flush, 50);
  }, { root: viewerScroll, rootMargin: LAZY_MARGIN });

  document.querySelectorAll('[data-lazy]').forEach(el => lazyObserver.observe(el));
}

// ── Scroll ────────────────────────────────────────────────────────
let _rafPending = false;
viewerScroll.addEventListener('scroll', () => {
  if (_rafPending) return;
  _rafPending = true;
  requestAnimationFrame(() => {
    _rafPending = false;
    updateProgress();
    updateCurrentPageIndicator();
    checkContinuousScroll();
  });
}, { passive: true });

// Files that have been appended in continuous mode (prevents re-triggering).
const _appendedFiles = new Set();

function checkContinuousScroll() {
  if (!state.continuous) return;
  const { scrollTop, scrollHeight, clientHeight } = viewerScroll;
  // Trigger 300px before the real bottom so the join feels seamless.
  if (scrollTop + clientHeight < scrollHeight - 300) return;

  // Find the next file that hasn't been appended yet.
  for (let i = 0; i < state.files.length; i++) {
    if (!_appendedFiles.has(state.files[i].name)) {
      // The first un-appended file is the next one to load.
      // Only load it if the previous one is already in the DOM.
      if (i === 0) break; // file 0 is always opened normally
      const prevName = state.files[i - 1].name;
      if (!_appendedFiles.has(prevName)) break; // previous not appended yet
      appendNextFile(i);
      break;
    }
  }
}

// Track in-flight appends by filename to prevent concurrent double-loads.
const _appendingFiles = new Set();

async function appendNextFile(idx) {
  if (idx >= state.files.length) return;
  const file = state.files[idx];
  if (_appendedFiles.has(file.name) || _appendingFiles.has(file.name)) return;

  _appendingFiles.add(file.name);

  // Add separator first so it's in the right position before any pages.
  pagesContainer.appendChild(makeSeparator(file.name));

  const firstBatch = Math.min(3, file.pages);
  await renderBatch(file.name, 0, firstBatch);

  // Insert placeholders for the rest WITHOUT recreating the lazy observer —
  // just observe the new placeholder elements directly.
  if (file.pages > firstBatch) {
    const frag = document.createDocumentFragment();
    for (let i = firstBatch; i < file.pages; i++) {
      const wrap = document.createElement('div');
      wrap.className    = 'page-wrapper';
      wrap.dataset.page = i;
      wrap.dataset.file = file.name;
      wrap.dataset.lazy = '1';

      const ph = document.createElement('div');
      ph.className = 'page-placeholder';
      ph.innerHTML = '<div class="spinner-sm"></div>';
      wrap.appendChild(ph);

      if (state.showPageNums) {
        const badge       = document.createElement('div');
        badge.className   = 'page-badge';
        badge.textContent = `${i + 1} / ${file.pages}`;
        wrap.appendChild(badge);
      }
      frag.appendChild(wrap);
    }
    pagesContainer.appendChild(frag);

    // Observe new placeholders on the existing observer — no teardown.
    if (lazyObserver) {
      pagesContainer
        .querySelectorAll(`[data-file="${file.name}"][data-lazy]`)
        .forEach(el => lazyObserver.observe(el));
    }
  }

  prefetchAhead(file.name, firstBatch, PREFETCH_AHD);

  // Update active file tracking.
  _appendedFiles.add(file.name);
  _appendingFiles.delete(file.name);
  state.activeIdx = idx;
  docTitle.textContent     = file.name;
  totalPagesEl.textContent = file.pages;
  renderFileList();
}

function updateProgress() {
  const { scrollTop, scrollHeight, clientHeight } = viewerScroll;
  const pct = scrollHeight <= clientHeight ? 100 : (scrollTop / (scrollHeight - clientHeight)) * 100;
  readProgressBar.style.width = pct.toFixed(1) + '%';
}

let _lastPageCheck = 0;
function updateCurrentPageIndicator() {
  const now = Date.now();
  if (now - _lastPageCheck < 100) return;
  _lastPageCheck = now;
  const center   = viewerScroll.scrollTop + viewerScroll.clientHeight * 0.35;
  const wrappers = pagesContainer.querySelectorAll('.page-wrapper[data-page]');
  let best = null, bestDist = Infinity;
  for (const w of wrappers) {
    const d = Math.abs(w.offsetTop - center);
    if (d < bestDist) { bestDist = d; best = w; }
  }
  if (best) {
    const p = parseInt(best.dataset.page) + 1;
    if (p !== state.currentPage) {
      state.currentPage = p;
      pageInput.value   = p;
      highlightThumb(parseInt(best.dataset.page));
    }
  }
}

// ── Jump to page ──────────────────────────────────────────────────
function jumpToPage(n) {
  const target = pagesContainer.querySelector(`.page-wrapper[data-page="${n - 1}"]`);
  if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
}
pageInput.addEventListener('change', () => {
  const file = state.files[state.activeIdx];
  if (!file) return;
  const n = Math.max(1, Math.min(parseInt(pageInput.value) || 1, file.pages));
  pageInput.value = n;
  jumpToPage(n);
});

// ── Zoom ──────────────────────────────────────────────────────────
let _zoomTimer      = null;
let _pendingZoom    = null;   // zoom level waiting to be rendered
let _renderAbort    = null;   // AbortController for the current in-flight rerender fetch

async function applyZoom(newZoom) {
  newZoom = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, Math.round(newZoom * 100) / 100));
  if (Math.abs(newZoom - (_pendingZoom ?? state.zoom)) < 0.01) return;

  _pendingZoom = newZoom;
  setZoomLabel(newZoom);

  // Instant CSS-scale preview — user sees size change without waiting for server.
  _applyCssScale(newZoom);

  // Cancel any previous debounce tick AND any in-flight fetch.
  clearTimeout(_zoomTimer);
  if (_renderAbort) { _renderAbort.abort(); _renderAbort = null; }

  _zoomTimer = setTimeout(() => doRerender(), 400);
}

/** Scale every rendered page-img with CSS transform (zero latency preview). */
function _applyCssScale(targetZoom) {
  const ratio = targetZoom / state.zoom;
  pagesContainer.querySelectorAll('.page-img').forEach(img => {
    img.style.transformOrigin = 'top center';
    img.style.transform       = `scale(${ratio})`;
    img.style.transition      = 'transform 0.15s ease';
  });
}

/** Reset any lingering CSS scale (called once real images are swapped in). */
function _clearCssScale() {
  pagesContainer.querySelectorAll('.page-img').forEach(img => {
    img.style.transform  = '';
    img.style.transition = '';
  });
}

async function doRerender() {
  const file = state.files[state.activeIdx];
  if (!file) return;

  // Commit the pending zoom; CSS preview already showed this value.
  state.zoom   = _pendingZoom ?? state.zoom;
  _pendingZoom = null;
  setZoomLabel(state.zoom);

  if (lazyObserver) { lazyObserver.disconnect(); lazyObserver = null; }
  state.pendingFetch.clear();
  state.rendered.delete(file.name);

  // Capture scroll position before any DOM changes.
  const scrollRatio = viewerScroll.scrollTop /
    Math.max(1, viewerScroll.scrollHeight - viewerScroll.clientHeight);

  // Create a fresh AbortController for this fetch. If applyZoom fires again
  // before this fetch completes, it will abort() this controller and the
  // next doRerender call will own a new one.
  const abort = new AbortController();
  _renderAbort = abort;

  const firstBatch = Math.min(4, file.pages);
  const scale      = (BASE_SCALE * state.zoom).toFixed(2);
  let batchData    = null;
  try {
    const res = await fetch(
      `/api/batch/${enc(file.name)}?start=0&count=${firstBatch}&scale=${scale}`,
      { signal: abort.signal }
    );
    batchData = await res.json();
  } catch (e) {
    // AbortError means a newer rerender already took over — just bail cleanly.
    _clearCssScale();
    return;
  }

  // If a newer rerender has already started, don't overwrite its work.
  if (abort.signal.aborted || _renderAbort !== abort) {
    _clearCssScale();
    return;
  }
  _renderAbort = null;

  // Wipe and rebuild in one synchronous block → single frame, no blank flash.
  pagesContainer.innerHTML = '';
  for (const p of batchData.pages) {
    markRendered(file.name, p.page);
    appendPage(p.page, p.img, file.name, batchData.total);
  }
  _clearCssScale();

  // Restore scroll proportionally.
  viewerScroll.scrollTop =
    scrollRatio * Math.max(0, viewerScroll.scrollHeight - viewerScroll.clientHeight);

  if (file.pages > firstBatch) {
    insertPlaceholders(file.name, firstBatch, file.pages);
    setupLazyObserver();
  }
  prefetchAhead(file.name, firstBatch, PREFETCH_AHD);
}

$('zoomIn').addEventListener('click',    () => applyZoom(state.zoom + ZOOM_STEP));
$('zoomOut').addEventListener('click',   () => applyZoom(state.zoom - ZOOM_STEP));
$('zoomLabel').addEventListener('click', () => { state.zoom = 0; applyZoom(1.0); });

viewerScroll.addEventListener('wheel', e => {
  if (!e.ctrlKey && !e.metaKey) return;
  e.preventDefault();
  applyZoom(state.zoom + (e.deltaY < 0 ? ZOOM_STEP : -ZOOM_STEP));
}, { passive: false });

// ── Fit modes ─────────────────────────────────────────────────────
$('fitWidth').addEventListener('click', () => {
  const img = pagesContainer.querySelector('.page-img');
  if (!img) return;
  // naturalWidth is rendered at (BASE_SCALE * state.zoom); work back to zoom units.
  const availableWidth = viewerScroll.clientWidth - 48;
  const newZoom = (availableWidth / img.naturalWidth) * state.zoom;
  applyZoom(newZoom);
});
$('fitPage').addEventListener('click', () => { state.zoom = 0; applyZoom(0.75); });

// ── Fullscreen ────────────────────────────────────────────────────
// The native Fullscreen API is unreliable in practice: iOS Safari doesn't
// support it on arbitrary elements at all (only <video>), and it silently
// fails if this page is embedded in an iframe without allow="fullscreen"
// or blocked by a Permissions-Policy. So: try the native API first, but
// always have a CSS-based fallback that works everywhere regardless.
$('fullscreenBtn').addEventListener('click', toggleFullscreen);

function _nativeFullscreenSupported() {
  const el = document.documentElement;
  return !!(el.requestFullscreen || el.webkitRequestFullscreen || el.msRequestFullscreen);
}

function _requestNativeFullscreen() {
  const el = document.documentElement;
  const req = el.requestFullscreen || el.webkitRequestFullscreen || el.msRequestFullscreen;
  return req.call(el);
}

function _exitNativeFullscreen() {
  const exit = document.exitFullscreen || document.webkitExitFullscreen || document.msExitFullscreen;
  return exit ? exit.call(document) : Promise.resolve();
}

function _isNativeFullscreen() {
  return !!(document.fullscreenElement || document.webkitFullscreenElement || document.msFullscreenElement);
}

function toggleFullscreen() {
  if (document.body.classList.contains('pseudo-fullscreen')) {
    document.body.classList.remove('pseudo-fullscreen');
    if (_isNativeFullscreen()) _exitNativeFullscreen().catch(() => {});
    $('fullscreenBtn').classList.remove('active');
    return;
  }
  if (_isNativeFullscreen()) {
    _exitNativeFullscreen().catch(() => {});
    return;
  }
  if (!_nativeFullscreenSupported()) {
    // e.g. iOS Safari — no native API available, use the CSS fallback directly.
    document.body.classList.add('pseudo-fullscreen');
    $('fullscreenBtn').classList.add('active');
    return;
  }
  _requestNativeFullscreen().catch(err => {
    console.warn('Fullscreen request failed, falling back to CSS fullscreen:', err);
    document.body.classList.add('pseudo-fullscreen');
    $('fullscreenBtn').classList.add('active');
  });
}

document.addEventListener('fullscreenchange', () => {
  const fs = !!document.fullscreenElement;
  $('fullscreenBtn').classList.toggle('active', fs || document.body.classList.contains('pseudo-fullscreen'));
});
document.addEventListener('webkitfullscreenchange', () => {
  const fs = !!document.webkitFullscreenElement;
  $('fullscreenBtn').classList.toggle('active', fs || document.body.classList.contains('pseudo-fullscreen'));
});
// Escape key exits the CSS fallback too (native fullscreen already handles Escape itself).
document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && document.body.classList.contains('pseudo-fullscreen')) {
    document.body.classList.remove('pseudo-fullscreen');
    $('fullscreenBtn').classList.remove('active');
  }
});

// ── Theme ─────────────────────────────────────────────────────────
function setTheme(dark) {
  state.darkMode = dark;
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  $('themeToggle').classList.toggle('active', dark);
}
$('themeToggle').addEventListener('click', () => setTheme(!state.darkMode));

// ── Option toggles ────────────────────────────────────────────────
function setupToggle(id, key, cb) {
  $(id).addEventListener('click', () => {
    state[key] = !state[key];
    $(id).classList.toggle('active', state[key]);
    cb && cb(state[key]);
  });
}
setupToggle('continuousToggle', 'continuous');
setupToggle('twoPageToggle', 'twoPage', v => { pagesContainer.classList.toggle('two-page', v); });
setupToggle('pageNumToggle', 'showPageNums', v => {
  document.querySelectorAll('.page-badge').forEach(b => b.style.display = v ? '' : 'none');
});

// ── Sidebar ───────────────────────────────────────────────────────
function toggleSidebar() {
  sidebar.classList.toggle('open');
  document.body.classList.toggle('sidebar-closed', !sidebar.classList.contains('open'));
}
$('sidebarToggle').addEventListener('click', toggleSidebar);
$('sidebarToggleTop').addEventListener('click', toggleSidebar);

// ── Prev / Next file ──────────────────────────────────────────────
$('prevFile').addEventListener('click', () => { if (state.activeIdx > 0) openFile(state.activeIdx - 1); });
$('nextFile').addEventListener('click', () => { if (state.activeIdx < state.files.length - 1) openFile(state.activeIdx + 1); });

// ── Upload ────────────────────────────────────────────────────────
async function uploadFiles(files) {
  if (!files.length) return;
  showLoading(`Uploading ${files.length} file(s)…`);
  const fd = new FormData();
  files.forEach(f => fd.append('files', f));
  const res  = await fetch('/api/upload', { method: 'POST', body: fd });
  const data = await res.json();
  state.files = data.files;
  renderFileList();
  hideLoading();
  if (data.uploaded.length > 0) {
    const idx = state.files.findIndex(f => f.name === data.uploaded[0]);
    if (idx >= 0) openFile(idx);
  }
}
$('fileInput').addEventListener('change', e => uploadFiles([...e.target.files]));
$('uploadZone').addEventListener('click', () => $('fileInput').click());
$('emptyUploadBtn').addEventListener('click', () => $('fileInput').click());

const uploadZone = $('uploadZone');
uploadZone.addEventListener('dragenter', e => { e.preventDefault(); uploadZone.classList.add('dragover'); });
uploadZone.addEventListener('dragleave', () => uploadZone.classList.remove('dragover'));
uploadZone.addEventListener('dragover',  e => e.preventDefault());
uploadZone.addEventListener('drop', e => {
  e.preventDefault(); uploadZone.classList.remove('dragover');
  uploadFiles([...e.dataTransfer.files].filter(f => f.name.endsWith('.pdf')));
});
document.body.addEventListener('dragover', e => e.preventDefault());
document.body.addEventListener('drop', e => {
  e.preventDefault();
  const fs = [...e.dataTransfer.files].filter(f => f.name.endsWith('.pdf'));
  if (fs.length) uploadFiles(fs);
});

// ── Delete file ───────────────────────────────────────────────────
async function deleteFile(idx) {
  if (!confirm(`Remove "${state.files[idx].name}"?`)) return;
  await fetch(`/api/delete/${enc(state.files[idx].name)}`, { method: 'DELETE' });
  if (state.activeIdx === idx) {
    state.activeIdx = -1;
    pagesContainer.innerHTML = '';
    pagesContainer.style.display = 'none';
    emptyState.style.display = '';
    docTitle.textContent = 'No document open';
    pageIndicator.style.display = 'none';
    $('downloadBtn').style.display = 'none';
    $('infoBtn').style.display    = 'none';
  } else if (state.activeIdx > idx) state.activeIdx--;
  await fetchFiles();
  renderFileList();
}

// ── Download ──────────────────────────────────────────────────────
$('downloadBtn').addEventListener('click', () => {
  const file = state.files[state.activeIdx];
  if (!file) return;
  const a  = document.createElement('a');
  a.href   = `/api/download/${enc(file.name)}`;
  a.download = file.name;
  a.click();
});

// ── TOC ───────────────────────────────────────────────────────────
let _tocLoaded = null;
async function loadToc() {
  const file = state.files[state.activeIdx];
  if (!file) return;
  if (_tocLoaded === file.name) return;  // already loaded
  _tocLoaded = file.name;

  try {
    const res  = await fetch(`/api/toc/${enc(file.name)}`);
    const data = await res.json();
    const toc  = data.toc || [];
    tocList.innerHTML = '';
    if (!toc.length) {
      tocEmpty.style.display = 'flex';
      tocList.style.display  = 'none';
    } else {
      tocEmpty.style.display = 'none';
      tocList.style.display  = 'block';
      toc.forEach(item => {
        const li  = document.createElement('li');
        li.className = `toc-item d${Math.min(item.depth, 3)}`;
        li.innerHTML = `<span class="toc-page">${item.page + 1}</span>${escHtml(item.title)}`;
        li.addEventListener('click', () => jumpToPage(item.page + 1));
        tocList.appendChild(li);
      });
    }
  } catch(e) {
    tocEmpty.style.display = 'flex';
    tocList.style.display  = 'none';
  }
}

// ── Thumbnails ────────────────────────────────────────────────────
let _thumbsFile  = null;
let _thumbsLoaded = 0;

async function loadThumbs() {
  const file = state.files[state.activeIdx];
  if (!file) return;
  if (_thumbsFile === file.name) return;  // same file, already loaded
  _thumbsFile   = file.name;
  _thumbsLoaded = 0;
  thumbGrid.innerHTML = '';

  // Load 10 at a time
  await loadThumbBatch(file.name, 0, Math.min(20, file.pages));
}

async function loadThumbBatch(filename, start, count) {
  thumbLoading.classList.add('visible');
  try {
    const res  = await fetch(`/api/thumbnails/${enc(filename)}?start=${start}&count=${count}`);
    const data = await res.json();
    for (const t of data.thumbs) {
      const item = document.createElement('div');
      item.className    = 'thumb-item';
      item.dataset.page = t.page;
      if (t.page === state.currentPage - 1) item.classList.add('active');
      item.innerHTML = `<img src="data:image/jpeg;base64,${t.img}" loading="lazy">
                        <div class="thumb-num">${t.page + 1}</div>`;
      item.addEventListener('click', () => jumpToPage(t.page + 1));
      thumbGrid.appendChild(item);
      _thumbsLoaded++;
    }
    // Load remaining in background if many pages
    const file = state.files[state.activeIdx];
    if (file && _thumbsLoaded < file.pages) {
      thumbLoading.classList.add('visible');
      loadThumbBatch(filename, _thumbsLoaded, Math.min(20, file.pages - _thumbsLoaded));
      return;
    }
  } catch(e) {}
  thumbLoading.classList.remove('visible');
}

function highlightThumb(pageIdx) {
  thumbGrid.querySelectorAll('.thumb-item').forEach(el => {
    el.classList.toggle('active', parseInt(el.dataset.page) === pageIdx);
    if (parseInt(el.dataset.page) === pageIdx) {
      el.scrollIntoView({ block: 'nearest' });
    }
  });
}
function updateThumbActive(pageIdx) {
  const item = thumbGrid.querySelector(`.thumb-item[data-page="${pageIdx}"]`);
  if (item) item.classList.add('active');
}

// ── Document Info ─────────────────────────────────────────────────
function toggleInfo() {
  state.infoOpen = !state.infoOpen;
  infoPanel.classList.toggle('visible', state.infoOpen);
  if (state.infoOpen) loadInfo();
}

async function loadInfo() {
  const file = state.files[state.activeIdx];
  if (!file) return;
  try {
    const res  = await fetch(`/api/info/${enc(file.name)}`);
    const data = await res.json();
    infoPanelBody.innerHTML = '';
    const rows = [
      ['Filename', file.name],
      ['Pages', data.pages],
      ['Size', fmtSize(data.size || 0)],
      ['Title', data.meta?.title || '—'],
      ['Author', data.meta?.author || '—'],
      ['Subject', data.meta?.subject || '—'],
      ['Creator', data.meta?.creator || '—'],
      ['Bookmarks', data.toc_count || 0],
    ];
    rows.forEach(([label, val]) => {
      const row = document.createElement('div');
      row.className = 'info-row';
      row.innerHTML = `<div class="info-label">${label}</div><div class="info-value">${escHtml(String(val))}</div>`;
      infoPanelBody.appendChild(row);
    });
  } catch(e) {}
}

$('infoBtn').addEventListener('click', toggleInfo);
$('infoClose').addEventListener('click', () => { state.infoOpen = false; infoPanel.classList.remove('visible'); });

// ── Search ────────────────────────────────────────────────────────
let _searchTimer = null;
let _lastSearchQuery = '';

function openSearch() {
  state.searchOpen = true;
  searchBar.classList.add('visible');
  document.body.classList.add('search-open');
  searchInput.focus();
}
function closeSearch() {
  state.searchOpen = false;
  searchBar.classList.remove('visible');
  document.body.classList.remove('search-open');
  searchInput.value    = '';
  searchResults.innerHTML = '';
  searchCount.textContent = '';
  _lastSearchQuery = '';
}

$('searchToggleBtn').addEventListener('click', () => {
  if (state.searchOpen) closeSearch(); else openSearch();
});
$('searchClose').addEventListener('click', closeSearch);

searchInput.addEventListener('input', () => {
  clearTimeout(_searchTimer);
  _searchTimer = setTimeout(doSearch, 350);
});

async function doSearch() {
  const q = searchInput.value.trim();
  if (q === _lastSearchQuery) return;
  _lastSearchQuery = q;
  const file = state.files[state.activeIdx];
  if (!file || q.length < 2) {
    searchResults.innerHTML = '';
    searchCount.textContent = '';
    return;
  }
  searchCount.textContent = '…';
  try {
    const res  = await fetch(`/api/search/${enc(file.name)}?q=${enc(q)}`);
    const data = await res.json();

    if (!data.results.length) {
      searchCount.textContent   = 'No results';
      searchResults.innerHTML   = `<div class="search-empty">No matches found for "<strong>${escHtml(q)}</strong>"</div>`;
      return;
    }
    const total = data.results.reduce((s, r) => s + r.count, 0);
    searchCount.textContent = `${total} match${total !== 1 ? 'es' : ''} on ${data.results.length} page${data.results.length !== 1 ? 's' : ''}`;
    searchResults.innerHTML = '';
    data.results.forEach(r => {
      const item = document.createElement('div');
      item.className = 'search-result-item';
      const snippet = r.snippets[0] || '';
      const highlighted = snippet.replace(new RegExp(escRe(q), 'gi'), m => `<mark>${escHtml(m)}</mark>`);
      item.innerHTML = `<div class="sr-page">p.${r.page + 1}</div>
        <div class="sr-body">
          <div class="sr-snippet">${highlighted}</div>
          <div class="sr-count">${r.count} occurrence${r.count !== 1 ? 's' : ''}</div>
        </div>`;
      item.addEventListener('click', () => jumpToPage(r.page + 1));
      searchResults.appendChild(item);
    });
  } catch(e) {
    searchCount.textContent = 'Error';
  }
}

// ── Autoscroll ────────────────────────────────────────────────────
const asWidget     = $('autoscrollWidget');
const asToggleBtn  = $('asToggle');
const asSpeedInput = $('asSpeedInput');
const asPlayIcon   = asToggleBtn.querySelector('.as-icon-play');
const asPauseIcon  = asToggleBtn.querySelector('.as-icon-pause');

const asState = {
  visible:  false,
  playing:  false,
  speed:    80,      // px/s
  rafId:    null,
  lastTime: null,
};

// Clamp and read speed from the input.
function asReadSpeed() {
  const v = parseFloat(asSpeedInput.value);
  if (!isNaN(v) && v >= 10 && v <= 2000) asState.speed = v;
  else asSpeedInput.value = asState.speed;
}

function asShow() {
  asState.visible = true;
  asWidget.classList.add('visible');
  $('autoscrollBtn').classList.add('active');
}
function asHide() {
  asPause();
  asState.visible = false;
  asWidget.classList.remove('visible');
  $('autoscrollBtn').classList.remove('active');
}
function asToggleVisible() {
  if (asState.visible) asHide(); else asShow();
}

function asPlay() {
  asReadSpeed();
  asState.playing  = true;
  asState.lastTime = null;
  asToggleBtn.classList.add('playing');
  asPlayIcon.style.display  = 'none';
  asPauseIcon.style.display = '';
  asState.rafId = requestAnimationFrame(asTick);
}
function asPause() {
  asState.playing = false;
  asToggleBtn.classList.remove('playing');
  asPlayIcon.style.display  = '';
  asPauseIcon.style.display = 'none';
  if (asState.rafId) { cancelAnimationFrame(asState.rafId); asState.rafId = null; }
}
function asTogglePlay() {
  if (asState.playing) asPause(); else asPlay();
}

// rAF loop — advances scroll by (speed * dt) pixels each frame.
// Pauses automatically when the user reaches the very bottom.
function asTick(timestamp) {
  if (!asState.playing) return;
  if (asState.lastTime === null) asState.lastTime = timestamp;
  const dt = (timestamp - asState.lastTime) / 1000;   // seconds
  asState.lastTime = timestamp;

  const { scrollTop, scrollHeight, clientHeight } = viewerScroll;
  if (scrollTop + clientHeight >= scrollHeight - 2) {
    // Reached the bottom — pause rather than silently loop.
    asPause();
    return;
  }

  viewerScroll.scrollTop += asState.speed * dt;
  asState.rafId = requestAnimationFrame(asTick);
}

// Pause when the user manually scrolls (they've taken back control).
let _asUserScrolling = false;
viewerScroll.addEventListener('scroll', () => {
  // Only treat as user scroll if we're not the one driving it.
  if (asState.playing && !_asUserScrolling) {
    // We can't perfectly distinguish programmatic from user scroll,
    // so we pause on any scroll event that fires outside our rAF tick.
    // The rAF tick sets _asUserScrolling = false after its own scroll.
  }
}, { passive: true });

// Step buttons
const SPEED_STEP = 10;
$('asSlower').addEventListener('click', () => {
  asState.speed = Math.max(10, asState.speed - SPEED_STEP);
  asSpeedInput.value = asState.speed;
  if (asState.playing) { asPause(); asPlay(); }
});
$('asFaster').addEventListener('click', () => {
  asState.speed = Math.min(2000, asState.speed + SPEED_STEP);
  asSpeedInput.value = asState.speed;
  if (asState.playing) { asPause(); asPlay(); }
});

// Commit speed on input change or blur
asSpeedInput.addEventListener('change', () => {
  asReadSpeed();
  asSpeedInput.value = asState.speed;
  if (asState.playing) { asPause(); asPlay(); }
});
asSpeedInput.addEventListener('blur', () => {
  asReadSpeed();
  asSpeedInput.value = asState.speed;
});

asToggleBtn.addEventListener('click', asTogglePlay);
$('asClose').addEventListener('click', asHide);
$('autoscrollBtn').addEventListener('click', asToggleVisible);

// ── Keyboard shortcuts ────────────────────────────────────────────
$('helpBtn').addEventListener('click', () => shortcutsPanel.classList.toggle('visible'));
$('closeShortcuts').addEventListener('click', () => shortcutsPanel.classList.remove('visible'));

document.addEventListener('keydown', e => {
  // If typing in search or speed input, only handle Escape
  if (e.target === searchInput || e.target === asSpeedInput) {
    if (e.key === 'Escape') { closeSearch(); asPause(); }
    return;
  }
  if (document.activeElement.tagName === 'INPUT') return;
  switch (e.key) {
    case '+': case '=': applyZoom(state.zoom + ZOOM_STEP); break;
    case '-':           applyZoom(state.zoom - ZOOM_STEP); break;
    case '0':           state.zoom = 0; applyZoom(1.0);   break;
    case 'w': case 'W': $('fitWidth').click();             break;
    case 'p': case 'P': $('fitPage').click();              break;
    case 'f': case 'F': toggleFullscreen();                break;
    case 's': case 'S': toggleSidebar();                   break;
    case 'i': case 'I': if (state.activeIdx >= 0) toggleInfo(); break;
    case 'a': case 'A': asToggleVisible();                 break;
    case ' ':
      e.preventDefault();
      if (asState.visible) asTogglePlay();
      break;
    case '[':
      $('asSlower').click(); break;
    case ']':
      $('asFaster').click(); break;
    case 'ArrowLeft':
      if (!e.altKey && state.activeIdx > 0) openFile(state.activeIdx - 1); break;
    case 'ArrowRight':
      if (!e.altKey && state.activeIdx < state.files.length-1) openFile(state.activeIdx+1); break;
    case 'd': case 'D': setTheme(!state.darkMode);         break;
    case '?':           shortcutsPanel.classList.toggle('visible'); break;
    case 'Escape':
      shortcutsPanel.classList.remove('visible');
      if (asState.visible)  asHide();
      if (state.infoOpen)   { state.infoOpen = false; infoPanel.classList.remove('visible'); }
      if (state.searchOpen) closeSearch();
      break;
  }
  if ((e.ctrlKey || e.metaKey) && e.key === 'f') {
    e.preventDefault();
    if (state.activeIdx >= 0) { openSearch(); }
  }
});

// ── Helpers ───────────────────────────────────────────────────────
const enc    = s => encodeURIComponent(s);
const escHtml = s => String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
const escRe   = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// ── Init ──────────────────────────────────────────────────────────
(async () => {
  setZoomLabel(state.zoom);
  await fetchFiles();
  if (state.files.length) openFile(0);
})();
