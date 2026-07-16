/**
 * crop.js
 * ベストショット調整UI
 * - touch drag / pinch zoom / mouse drag / wheel zoom
 * - ResizeObserver + debounce(220ms) + double-rAF でリサイズ暴走防止
 * - _render() はレイアウト読み取りを行わず描画のみ（thrashing防止）
 * - imageBlob 確定後に onConfirm(blob) を呼ぶ前段UI
 */

const DEBOUNCE_MS = 220;

export class CropScreen {
  constructor({ canvas, wrap, qualityWarn = null, onConfirm, onBack }) {
    this._canvas      = canvas;
    this._wrap        = wrap;
    this._qualityWarn = qualityWarn;
    this._onConfirm   = onConfirm;
    this._onBack      = onBack;

    this._img = null;
    this._x = 0; this._y = 0;
    this._scale = 1; this._minScale = 1; this._origScale = 1;
    this._cW = 0; this._cH = 0;

    this._dragging = false;
    this._dragX0 = 0; this._dragY0 = 0;
    this._imgX0  = 0; this._imgY0  = 0;

    this._pinching    = false;
    this._pinchD0     = 0; this._pinchScale0 = 0;
    this._pinchMidX   = 0; this._pinchMidY   = 0;
    this._pinchImgX0  = 0; this._pinchImgY0  = 0;

    this._rafId          = null;
    this._resizeTimer    = null;
    this._resizeObserver = null;
    this._eventsAttached = false;

    this._onTStart     = this._onTStart.bind(this);
    this._onTMove      = this._onTMove.bind(this);
    this._onTEnd       = this._onTEnd.bind(this);
    this._onMDown      = this._onMDown.bind(this);
    this._onMMove      = this._onMMove.bind(this);
    this._onMUp        = this._onMUp.bind(this);
    this._onWheel      = this._onWheel.bind(this);
    this._handleResize = this._handleResize.bind(this);

    // [DEBUG] ─────────────────────────────────────────────────────────────
    this._dbg = {
      lastInitCanvas:   null,
      lastHandleResize: null,
      lastRender:       null,
      initCount:        0,
      resizeCount:      0,
      renderCount:      0,
    };
    // ─────────────────────────────────────────────────────────────────────
  }

  // ── Public API ───────────────────────────────────────────────────────────

  open(fileBlob) {
    this._detachEvents();
    this._img = null;

    const url = URL.createObjectURL(fileBlob);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      this._img = img;
      this._initCanvas();
    };
    img.onerror = () => URL.revokeObjectURL(url);
    img.src = url;
  }

  // 画面枠を画像座標系に変換し、画像と枠の交差部分だけを元画像の解像度で切り出す。
  // 黒帯（contain時の余白）は出力に含まれない。画像座標系で処理するため
  // 画面の向き（縦横）に依存せず、旧・横画面portrait再マッピングは不要になった。
  confirm() {
    if (!this._img) return;
    this._detachEvents();
    const img = this._img;
    const sx = Math.max(0, -this._x / this._scale);
    const sy = Math.max(0, -this._y / this._scale);
    const ex = Math.min(img.width,  (this._cW - this._x) / this._scale);
    const ey = Math.min(img.height, (this._cH - this._y) / this._scale);
    const sw = ex - sx, sh = ey - sy;
    if (sw <= 0 || sh <= 0) return;
    // 元画像の解像度で出力（引き伸ばしなし）。長辺2048px上限は confirmWhole と同じ
    const scale = Math.min(1, 2048 / Math.max(sw, sh));
    const off = document.createElement('canvas');
    off.width  = Math.max(1, Math.round(sw * scale));
    off.height = Math.max(1, Math.round(sh * scale));
    const ctx = off.getContext('2d');
    ctx.drawImage(img, sx, sy, sw, sh, 0, 0, off.width, off.height);
    off.toBlob(blob => this._onConfirm(blob), 'image/jpeg', 0.92);
  }

  // 写真全体をそのまま使う（トリミングなし・長辺2048px上限に縮小のみ）
  confirmWhole() {
    if (!this._img) return;
    this._detachEvents();
    const img = this._img;
    const scale = Math.min(1, 2048 / Math.max(img.width, img.height));
    const off = document.createElement('canvas');
    off.width  = Math.round(img.width  * scale);
    off.height = Math.round(img.height * scale);
    const ctx = off.getContext('2d');
    ctx.drawImage(img, 0, 0, off.width, off.height);
    off.toBlob(blob => this._onConfirm(blob), 'image/jpeg', 0.92);
  }

  back() {
    this._detachEvents();
    this._onBack();
  }

  destroy() {
    this._detachEvents();
    this._img = null;
  }

  // [DEBUG] ─────────────────────────────────────────────────────────────
  getDebugInfo() {
    return {
      cW: this._cW,             cH: this._cH,
      scale: this._scale,       minScale: this._minScale,
      origScale: this._origScale,
      x: this._x,               y: this._y,
      canvasPxW: this._canvas.width,   canvasPxH: this._canvas.height,
      canvasStyleW: this._canvas.style.width,
      canvasStyleH: this._canvas.style.height,
      wrapClientW: this._wrap.clientWidth,
      wrapClientH: this._wrap.clientHeight,
      imgNatW: this._img?.naturalWidth  ?? null,
      imgNatH: this._img?.naturalHeight ?? null,
      ...this._dbg,
    };
  }
  // ─────────────────────────────────────────────────────────────────────

  // ── Init / Fit ───────────────────────────────────────────────────────────

  _initCanvas() {
    this._dbg.lastInitCanvas = Date.now(); this._dbg.initCount++; // [DEBUG]
    const w = this._wrap.clientWidth;
    const h = this._wrap.clientHeight;
    if (!w || !h) { requestAnimationFrame(() => this._initCanvas()); return; }
    this._updateCanvasBuffer(w, h);
    this._fitImage();
    this._attachEvents();
    this._scheduleRender();
  }

  _updateCanvasBuffer(w, h) {
    const dpr = window.devicePixelRatio || 1;
    this._canvas.width  = Math.round(w * dpr);
    this._canvas.height = Math.round(h * dpr);
    this._canvas.style.width  = w + 'px';
    this._canvas.style.height = h + 'px';
    this._cW = w;
    this._cH = h;
  }

  // contain fit: 画像全体が枠内に収まる状態を初期値かつ最小ズームにする
  // （cover だと最初から画像が切れて見え「はみ出ている？」と不安にさせるため）
  // 決定時は黒帯を含めず画像と枠の交差部分だけを切り出す → 初期状態のまま決定＝写真全体
  _fitImage() {
    const { _img: img, _cW: w, _cH: h } = this;
    this._origScale  = Math.min(w / img.width, h / img.height);
    this._minScale   = this._origScale;
    this._scale      = this._origScale;
    // 画質警告の基準は「枠を埋めるズーム量」（従来のcover基準を維持）
    this._coverScale = Math.max(w / img.width, h / img.height);
    this._x = (w - img.width  * this._scale) / 2;
    this._y = (h - img.height * this._scale) / 2;
  }

  // 画像がcanvasより大きい軸はクランプ、小さい軸は中央固定（黒帯を維持）
  _clamp() {
    const iW = this._img.width  * this._scale;
    const iH = this._img.height * this._scale;
    this._x = iW >= this._cW
      ? Math.min(0, Math.max(this._x, this._cW - iW))
      : (this._cW - iW) / 2;
    this._y = iH >= this._cH
      ? Math.min(0, Math.max(this._y, this._cH - iH))
      : (this._cH - iH) / 2;
  }

  _applyZoom(ns, px, py) {
    ns = Math.max(this._minScale, ns);
    const ratio = ns / this._scale;
    this._x = px - ratio * (px - this._x);
    this._y = py - ratio * (py - this._y);
    this._scale = ns;
    this._clamp();
  }

  // ── Render ──────────────────────────────────────────────────────────────

  _scheduleRender() {
    if (this._rafId) return;
    this._rafId = requestAnimationFrame(() => {
      this._rafId = null;
      this._render();
    });
  }

  _render() {
    if (!this._img) return;
    this._dbg.lastRender = Date.now(); this._dbg.renderCount++; // [DEBUG]
    const dpr = window.devicePixelRatio || 1;
    const ctx = this._canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, this._cW, this._cH);
    ctx.save();
    ctx.translate(this._x, this._y);
    ctx.scale(this._scale, this._scale);
    ctx.drawImage(this._img, 0, 0);
    ctx.restore();
    if (this._qualityWarn) {
      // contain基準ではなくcover基準（枠を埋めるズーム量）で判定（従来と同じ感覚を維持）
      const base = this._coverScale || this._origScale;
      this._qualityWarn.classList.toggle('hidden', this._scale <= base * 2.8);
    }
  }

  // ── Resize ──────────────────────────────────────────────────────────────

  // debounce(220ms) + double-rAF: orientationchange後の多重発火とlayout安定待ちを両立
  // ユーザーの調整（ズーム・位置）はリセットせず、視点中心と相対ズーム率を保存→復元する
  // （Androidアドレスバー出没のわずかなresizeで調整が消えるのを防ぐ）
  _handleResize() {
    clearTimeout(this._resizeTimer);
    this._resizeTimer = setTimeout(() => {
      requestAnimationFrame(() => requestAnimationFrame(() => {
        if (!this._img) return;
        this._dbg.lastHandleResize = Date.now(); this._dbg.resizeCount++; // [DEBUG]
        const w = this._wrap.clientWidth;
        const h = this._wrap.clientHeight;
        if (!w || !h) return;
        // 変更前の視点状態を保存（画像座標系での画面中心 + fit基準の相対ズーム率）
        const hadView = this._cW > 0 && this._cH > 0 && this._scale > 0;
        const viewCX  = hadView ? (this._cW / 2 - this._x) / this._scale : 0;
        const viewCY  = hadView ? (this._cH / 2 - this._y) / this._scale : 0;
        const relZoom = hadView ? this._scale / this._origScale : 1;
        this._updateCanvasBuffer(w, h);
        this._fitImage(); // origScale/minScale を新寸法で再計算
        if (hadView) {
          // 相対ズームと視点中心を新寸法で復元（confirm()の再マッピングと同じ数学）
          this._scale = this._origScale * relZoom;
          this._x = w / 2 - viewCX * this._scale;
          this._y = h / 2 - viewCY * this._scale;
          this._clamp();
        }
        this._scheduleRender();
      }));
    }, DEBOUNCE_MS);
  }

  // ── Touch ────────────────────────────────────────────────────────────────

  _pdist(t1, t2) {
    const dx = t1.clientX - t2.clientX, dy = t1.clientY - t2.clientY;
    return Math.sqrt(dx * dx + dy * dy);
  }

  _onTStart(e) {
    e.preventDefault();
    const ts = e.touches;
    if (ts.length === 1) {
      this._pinching = false;
      this._dragging = true;
      this._dragX0 = ts[0].clientX; this._dragY0 = ts[0].clientY;
      this._imgX0  = this._x;       this._imgY0  = this._y;
    } else if (ts.length >= 2) {
      this._dragging = false;
      this._pinching = true;
      this._pinchD0     = this._pdist(ts[0], ts[1]);
      this._pinchScale0 = this._scale;
      const r = this._canvas.getBoundingClientRect();
      this._pinchMidX  = (ts[0].clientX + ts[1].clientX) / 2 - r.left;
      this._pinchMidY  = (ts[0].clientY + ts[1].clientY) / 2 - r.top;
      this._pinchImgX0 = this._x;
      this._pinchImgY0 = this._y;
    }
  }

  _onTMove(e) {
    e.preventDefault();
    const ts = e.touches;
    if (ts.length >= 2 && this._pinching) {
      const d     = this._pdist(ts[0], ts[1]);
      const ns    = Math.max(this._minScale, this._pinchScale0 * d / this._pinchD0);
      const ratio = ns / this._pinchScale0;
      this._x     = this._pinchMidX - ratio * (this._pinchMidX - this._pinchImgX0);
      this._y     = this._pinchMidY - ratio * (this._pinchMidY - this._pinchImgY0);
      this._scale = ns;
      this._clamp();
    } else if (ts.length === 1 && this._dragging) {
      this._x = this._imgX0 + ts[0].clientX - this._dragX0;
      this._y = this._imgY0 + ts[0].clientY - this._dragY0;
      this._clamp();
    }
    this._scheduleRender();
  }

  _onTEnd(e) {
    e.preventDefault();
    if (e.touches.length === 0) {
      this._dragging = false;
      this._pinching = false;
    } else if (e.touches.length === 1) {
      this._pinching = false;
      this._dragging = true;
      this._dragX0 = e.touches[0].clientX; this._dragY0 = e.touches[0].clientY;
      this._imgX0  = this._x;              this._imgY0  = this._y;
    }
  }

  // ── Mouse ────────────────────────────────────────────────────────────────

  _onMDown(e) {
    this._dragging = true;
    this._dragX0 = e.clientX; this._dragY0 = e.clientY;
    this._imgX0  = this._x;   this._imgY0  = this._y;
  }

  _onMMove(e) {
    if (!this._dragging) return;
    this._x = this._imgX0 + e.clientX - this._dragX0;
    this._y = this._imgY0 + e.clientY - this._dragY0;
    this._clamp();
    this._scheduleRender();
  }

  _onMUp() { this._dragging = false; }

  _onWheel(e) {
    e.preventDefault();
    const r = this._canvas.getBoundingClientRect();
    this._applyZoom(this._scale * (e.deltaY < 0 ? 1.12 : 0.89), e.clientX - r.left, e.clientY - r.top);
    this._scheduleRender();
  }

  // ── Events ──────────────────────────────────────────────────────────────

  _attachEvents() {
    if (this._eventsAttached) return;
    const c = this._canvas;
    c.addEventListener('touchstart',  this._onTStart, { passive: false });
    c.addEventListener('touchmove',   this._onTMove,  { passive: false });
    c.addEventListener('touchend',    this._onTEnd,   { passive: false });
    c.addEventListener('touchcancel', this._onTEnd,   { passive: false });
    c.addEventListener('mousedown',   this._onMDown);
    window.addEventListener('mousemove', this._onMMove);
    window.addEventListener('mouseup',   this._onMUp);
    c.addEventListener('wheel', this._onWheel, { passive: false });
    if (window.ResizeObserver) {
      this._resizeObserver = new ResizeObserver(this._handleResize);
      this._resizeObserver.observe(this._wrap);
    } else {
      window.addEventListener('resize',            this._handleResize);
      window.addEventListener('orientationchange', this._handleResize);
    }
    if (window.visualViewport) {
      window.visualViewport.addEventListener('resize', this._handleResize);
    }
    this._eventsAttached = true;
  }

  _detachEvents() {
    if (!this._eventsAttached) return;
    const c = this._canvas;
    c.removeEventListener('touchstart',  this._onTStart);
    c.removeEventListener('touchmove',   this._onTMove);
    c.removeEventListener('touchend',    this._onTEnd);
    c.removeEventListener('touchcancel', this._onTEnd);
    c.removeEventListener('mousedown',   this._onMDown);
    window.removeEventListener('mousemove', this._onMMove);
    window.removeEventListener('mouseup',   this._onMUp);
    c.removeEventListener('wheel', this._onWheel);
    if (this._resizeObserver) {
      this._resizeObserver.disconnect();
      this._resizeObserver = null;
    } else {
      window.removeEventListener('resize',            this._handleResize);
      window.removeEventListener('orientationchange', this._handleResize);
    }
    if (window.visualViewport) {
      window.visualViewport.removeEventListener('resize', this._handleResize);
    }
    clearTimeout(this._resizeTimer);
    if (this._rafId) { cancelAnimationFrame(this._rafId); this._rafId = null; }
    this._eventsAttached = false;
  }
}
