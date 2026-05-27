/**
 * puzzle.js
 * - 盤面スナップ（ピース→正解位置）
 * - ピース同士スナップ（隣接ピースがグループ化）
 * - グループ一括ドラッグ
 */

import { saveState, clearState } from './storage.js';

const PIECE_SNAP  = 0.38; // 隣接ピース間スナップ閾値（38%）
const BOARD_SNAP  = 0.50; // 盤面スナップ閾値（50%）
const DELTAS = [[-1,0],[1,0],[0,-1],[0,1]];
const SAVE_DEBOUNCE = 500;

export class Puzzle {
  constructor({ canvas, image, cols, rows, elapsed = 0, savedPieces = null, savedVW = null, savedVH = null, onComplete, onUpdate }) {
    this.canvas   = canvas;
    this.ctx      = canvas.getContext('2d');
    this.image    = image;
    this.cols     = cols;
    this.rows     = rows;
    this.elapsed  = elapsed;
    this.onComplete = onComplete;
    this.onUpdate   = onUpdate;

    this.pieces       = [];
    this.nextGroupId  = 0;
    this.dragSet      = null;  // Set<piece> — 現在ドラッグ中のピース群
    this.dragPiece    = null;  // 掴んだピース
    this.dragOffX     = 0;
    this.dragOffY     = 0;
    this.activeTouchId = null;
    this.timerInterval  = null;
    this.saveTimer      = null;
    this.completed      = false;
    this._resizeTimer   = null;
    this.savedVW        = savedVW;
    this.savedVH        = savedVH;

    this._resize     = this._resize.bind(this);
    this._onTStart   = this._onTStart.bind(this);
    this._onTMove    = this._onTMove.bind(this);
    this._onTEnd     = this._onTEnd.bind(this);
    this._onMDown    = this._onMDown.bind(this);
    this._onMMove    = this._onMMove.bind(this);
    this._onMUp      = this._onMUp.bind(this);

    this._setupCanvas();
    this._initPieces(savedPieces);
    this._attachEvents();
    this._startTimer();
    this._render();
  }

  // ── Canvas ─────────────────────────────────────────────────────────────

  _setupCanvas() {
    this._resize();
    this._resizeDebounced = () => {
      clearTimeout(this._resizeTimer);
      this._resizeTimer = setTimeout(() => this._resize(), 150);
    };
    window.addEventListener('resize', this._resizeDebounced);
    window.addEventListener('orientationchange', this._resizeDebounced);
  }

  _resize() {
    const dpr  = window.devicePixelRatio || 1;
    const cont = this.canvas.parentElement;
    const w    = cont.clientWidth;
    const h    = cont.clientHeight;
    if (!w || !h) return;

    // 旧サイズを保持してスケール比を計算（初回は比率1.0）
    const oldW = this.vW || w;
    const oldH = this.vH || h;

    this.canvas.width  = w * dpr;
    this.canvas.height = h * dpr;
    this.canvas.style.width  = w + 'px';
    this.canvas.style.height = h + 'px';
    // setTransform で累積スケールを防ぐ（scale()の重ねがけ禁止）
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.vW = w;
    this.vH = h;

    this.pW = Math.floor(w * 0.85 / this.cols);
    this.pH = Math.floor(h * 0.85 / this.rows);
    this.gX = Math.floor((w - this.pW * this.cols) / 2);
    this.gY = Math.floor((h - this.pH * this.rows) / 2);

    if (this.pieces.length > 0) {
      const scaleX = w / oldW;
      const scaleY = h / oldH;
      for (const p of this.pieces) {
        if (p.placed) {
          p.x = this._cx(p);
          p.y = this._cy(p);
        } else {
          p.x = p.x * scaleX;
          p.y = p.y * scaleY;
        }
      }
      this._clampAllGroups();
      // pW/pHが変わったのでPath2Dキャッシュを無効化
      for (const p of this.pieces) delete p._path;
      this._render();
    }
  }

  // ── Pieces ─────────────────────────────────────────────────────────────

  _initPieces(saved) {
    if (saved) {
      this.pieces = saved.map(p => ({
        ...p,
        edges: p.edges || { top: 0, right: 0, bottom: 0, left: 0 },
      }));
      // 保存データにgroupIdがない古いデータへの対応
      let maxId = -1;
      for (const p of this.pieces) {
        if (p.groupId === undefined) p.groupId = ++maxId;
        else maxId = Math.max(maxId, p.groupId);
      }
      this.nextGroupId = maxId + 1;
      // resume時にcanvasサイズが変わっていればスケーリング（回転後の再開）
      const scaleX = (this.savedVW && this.savedVW !== this.vW) ? this.vW / this.savedVW : 1;
      const scaleY = (this.savedVH && this.savedVH !== this.vH) ? this.vH / this.savedVH : 1;
      for (const p of this.pieces) {
        if (p.placed) { p.x = this._cx(p); p.y = this._cy(p); }
        else { p.x = p.x * scaleX; p.y = p.y * scaleY; }
      }
      this._clampAllGroups();
      return;
    }

    const edgeGrid = this._generateEdges();
    const pieces = [];
    let id = 0;
    for (let r = 0; r < this.rows; r++) {
      for (let c = 0; c < this.cols; c++) {
        // 画面全体にランダム配置（グリッドエリアと重なってもOK）
        const x = Math.random() * Math.max(1, this.vW - this.pW);
        const y = Math.random() * Math.max(1, this.vH - this.pH);
        pieces.push({ c, r, x, y, groupId: id, placed: false, edges: edgeGrid[r][c] });
        id++;
      }
    }
    // 配列シャッフル（z-order 分散）
    for (let i = pieces.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [pieces[i], pieces[j]] = [pieces[j], pieces[i]];
    }
    this.pieces = pieces;
    this.nextGroupId = id;
  }

  // 正解座標
  _cx(p) { return this.gX + p.c * this.pW; }
  _cy(p) { return this.gY + p.r * this.pH; }

  _find(c, r) { return this.pieces.find(p => p.c === c && p.r === r); }

  _groupOf(gid) { return this.pieces.filter(p => p.groupId === gid); }

  // ── Drag ───────────────────────────────────────────────────────────────

  _hitTest(x, y) {
    for (let i = this.pieces.length - 1; i >= 0; i--) {
      const p = this.pieces[i];
      if (p.placed) continue;
      if (x >= p.x && x < p.x + this.pW && y >= p.y && y < p.y + this.pH) return p;
    }
    return null;
  }

  _startDrag(x, y) {
    const hit = this._hitTest(x, y);
    if (!hit) return false;

    const gid = hit.groupId;
    // ドラッググループを配列末尾へ（最前面描画）
    const rest  = this.pieces.filter(p => p.groupId !== gid || p.placed);
    const group = this.pieces.filter(p => p.groupId === gid && !p.placed);
    this.pieces = [...rest, ...group];

    this.dragSet   = new Set(group);
    this.dragPiece = this.pieces.find(p => p.c === hit.c && p.r === hit.r);
    this.dragOffX  = x - this.dragPiece.x;
    this.dragOffY  = y - this.dragPiece.y;
    return true;
  }

  _moveDrag(x, y) {
    if (!this.dragPiece) return;
    const nx = x - this.dragOffX;
    const ny = y - this.dragOffY;
    const dx = nx - this.dragPiece.x;
    const dy = ny - this.dragPiece.y;
    const { dx: cdx, dy: cdy } = this._clampGroupDelta([...this.dragSet], dx, dy);
    for (const p of this.dragSet) { p.x += cdx; p.y += cdy; }
  }

  _endDrag() {
    if (!this.dragPiece) return;
    const group = [...this.dragSet];
    this.dragSet   = null;
    this.dragPiece = null;

    // 優先1: ピース同士スナップ
    const snapped = this._tryPieceSnap(group);
    // 優先2: 盤面スナップ
    if (!snapped) this._tryBoardSnap(group);

    // 未配置グループを安全範囲に収める
    const nonPlaced = group.filter(p => !p.placed);
    if (nonPlaced.length > 0) this._clampGroupToSafe(nonPlaced);

    this._render();
    this._scheduleSave();
    if (this.onUpdate) this.onUpdate(this.elapsed);
    this._checkComplete();
  }

  // ── Bounds Clamp ───────────────────────────────────────────────────────

  // ドラッググループが安全範囲から完全に外れないようにデルタを制限する
  // VIS: 最低限見えていなければならないピクセル数
  // REF: 画面下部の「見本」ボタン確保領域（canvas座標）
  _clampGroupDelta(group, dx, dy) {
    const { pW, pH, vW, vH } = this;
    const VIS = 30;
    const REF = 60;
    let l = Infinity, t = Infinity, r = -Infinity, b = -Infinity;
    for (const p of group) {
      l = Math.min(l, p.x);   t = Math.min(t, p.y);
      r = Math.max(r, p.x + pW); b = Math.max(b, p.y + pH);
    }
    const nl = l + dx, nt = t + dy, nr = r + dx, nb = b + dy;
    let cdx = dx, cdy = dy;
    if (nr < VIS)                  cdx += VIS - nr;
    else if (nl > vW - VIS)        cdx -= nl - (vW - VIS);
    if (nb < VIS)                  cdy += VIS - nb;
    else if (nt > vH - REF - VIS)  cdy -= nt - (vH - REF - VIS);
    return { dx: cdx, dy: cdy };
  }

  _clampGroupToSafe(group) {
    const { dx, dy } = this._clampGroupDelta(group, 0, 0);
    if (dx !== 0 || dy !== 0) for (const p of group) { p.x += dx; p.y += dy; }
  }

  _clampAllGroups() {
    const groups = new Map();
    for (const p of this.pieces) {
      if (p.placed) continue;
      if (!groups.has(p.groupId)) groups.set(p.groupId, []);
      groups.get(p.groupId).push(p);
    }
    for (const group of groups.values()) this._clampGroupToSafe(group);
  }

  // ── Snap ───────────────────────────────────────────────────────────────

  _tryPieceSnap(group) {
    const { pW, pH } = this;
    const gids = new Set(group.map(p => p.groupId));
    let best = null, bestErr = Infinity;

    for (const PA of group) {
      for (const [dc, dr] of DELTAS) {
        const nc = PA.c + dc, nr = PA.r + dr;
        if (nc < 0 || nc >= this.cols || nr < 0 || nr >= this.rows) continue;
        const PB = this._find(nc, nr);
        if (!PB || gids.has(PB.groupId)) continue;

        const errX = Math.abs((PB.x - PA.x) - dc * pW);
        const errY = Math.abs((PB.y - PA.y) - dr * pH);
        if (errX < pW * PIECE_SNAP && errY < pH * PIECE_SNAP) {
          const err = errX + errY;
          if (err < bestErr) { bestErr = err; best = { PA, PB, dc, dr }; }
        }
      }
    }

    if (!best) return false;

    const { PA, PB, dc, dr } = best;
    const moveX = (PB.x - dc * pW) - PA.x;
    const moveY = (PB.y - dr * pH) - PA.y;
    for (const p of group) { p.x += moveX; p.y += moveY; }

    const pbGid = PB.groupId;
    const pbPlaced = this._groupOf(pbGid).some(p => p.placed);

    // グループをマージ（dragGroup → PBのグループに統合）
    for (const p of group) p.groupId = pbGid;

    if (pbPlaced) {
      // PB側が盤面配置済み → drag側も盤面に置く
      for (const p of group) {
        p.x = this._cx(p);
        p.y = this._cy(p);
        p.placed = true;
      }
    }

    return true;
  }

  _tryBoardSnap(group) {
    const { pW, pH } = this;
    for (const P of group) {
      if (Math.abs(P.x - this._cx(P)) < pW * BOARD_SNAP &&
          Math.abs(P.y - this._cy(P)) < pH * BOARD_SNAP) {
        for (const p of group) {
          p.x = this._cx(p);
          p.y = this._cy(p);
          p.placed = true;
        }
        return true;
      }
    }
    return false;
  }

  // ── Jigsaw shape ───────────────────────────────────────────────────────

  _generateEdges() {
    const { cols, rows } = this;
    // hEdge[r][c]: 下辺方向（1=タブが下方向, -1=ブランク）
    const hEdge = Array.from({ length: rows - 1 }, () =>
      Array.from({ length: cols },     () => (Math.random() < 0.5 ? 1 : -1))
    );
    // vEdge[r][c]: 右辺方向（1=タブが右方向, -1=ブランク）
    const vEdge = Array.from({ length: rows }, () =>
      Array.from({ length: cols - 1 }, () => (Math.random() < 0.5 ? 1 : -1))
    );
    return Array.from({ length: rows }, (_, r) =>
      Array.from({ length: cols }, (_, c) => ({
        top:    r === 0        ? 0 : -hEdge[r - 1][c],
        bottom: r === rows - 1 ? 0 :  hEdge[r][c],
        left:   c === 0        ? 0 : -vEdge[r][c - 1],
        right:  c === cols - 1 ? 0 :  vEdge[r][c],
      }))
    );
  }

  // Path2Dをローカル座標（原点0,0）でキャッシュ。pW/pHが変わった時のみ再生成。
  _getPiecePath(p) {
    if (!p._path || p._pathPW !== this.pW || p._pathPH !== this.pH) {
      const e = p.edges || { top: 0, right: 0, bottom: 0, left: 0 };
      const { pW, pH } = this;
      const path = new Path2D();
      path.moveTo(0, 0);
      this._edgePath(path, 0,  0,  pW, 0,  e.top,    0, -1);
      this._edgePath(path, pW, 0,  pW, pH, e.right,  1,  0);
      this._edgePath(path, pW, pH, 0,  pH, e.bottom, 0,  1);
      this._edgePath(path, 0,  pH, 0,  0,  e.left,  -1,  0);
      path.closePath();
      p._path = path;
      p._pathPW = pW;
      p._pathPH = pH;
    }
    return p._path;
  }

  _edgePath(path, x1, y1, x2, y2, type, perpX, perpY) {
    if (type === 0) { path.lineTo(x2, y2); return; }
    const dx = x2 - x1, dy = y2 - y1;
    const H  = Math.sqrt(dx*dx + dy*dy) * 0.30 * type;
    const tx = perpX * H, ty = perpY * H;
    const q  = (f, ox, oy) => [x1 + dx*f + ox, y1 + dy*f + oy];

    path.lineTo(...q(0.30, 0, 0));
    path.bezierCurveTo(
      ...q(0.30, tx*0.5, ty*0.5),
      ...q(0.40, tx,     ty    ),
      ...q(0.50, tx,     ty    )
    );
    path.bezierCurveTo(
      ...q(0.60, tx,     ty    ),
      ...q(0.70, tx*0.5, ty*0.5),
      ...q(0.70, 0, 0)
    );
    path.lineTo(x2, y2);
  }

  // ── Render ─────────────────────────────────────────────────────────────

  _render() {
    const { ctx, vW, vH, pW, pH, cols, rows } = this;
    ctx.clearRect(0, 0, vW, vH);

    // グリッドガイド
    ctx.save();
    ctx.strokeStyle = 'rgba(255,255,255,0.1)';
    ctx.lineWidth = 1;
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        ctx.strokeRect(this.gX + c * pW, this.gY + r * pH, pW, pH);
      }
    }
    ctx.restore();

    // 接合部ギャップ防止: グリッドエリアに薄くベース画像を描画
    // （CanvasクリップのAAで黒背景が漏れるのを防ぐ）
    ctx.save();
    ctx.globalAlpha = 0.15;
    ctx.drawImage(this.image, this.gX, this.gY, pW * cols, pH * rows);
    ctx.restore();

    // スナッププレビュー（ドラッグ中のみ）
    if (this.dragSet) this._drawSnapPreview();

    // 描画順: 配置済み → 浮遊 → ドラッグ中（最前面）
    for (const p of this.pieces) if (p.placed)  this._drawPiece(p, false);
    for (const p of this.pieces) if (!p.placed && (!this.dragSet || !this.dragSet.has(p))) this._drawPiece(p, false);
    if (this.dragSet) for (const p of this.dragSet) this._drawPiece(p, true);
  }

  _drawSnapPreview() {
    const group = [...this.dragSet];
    const gids  = new Set(group.map(p => p.groupId));
    const { pW, pH, ctx } = this;

    // ── ピース同士スナッププレビュー ──
    let bestSnap = null, bestErr = Infinity;
    for (const PA of group) {
      for (const [dc, dr] of DELTAS) {
        const PB = this._find(PA.c + dc, PA.r + dr);
        if (!PB || gids.has(PB.groupId)) continue;
        const errX = Math.abs((PB.x - PA.x) - dc * pW);
        const errY = Math.abs((PB.y - PA.y) - dr * pH);
        // プレビューは閾値を1.6倍（少し手前から表示）
        if (errX < pW * PIECE_SNAP * 1.6 && errY < pH * PIECE_SNAP * 1.6) {
          const err = errX + errY;
          if (err < bestErr) { bestErr = err; bestSnap = { PA, PB, dc, dr }; }
        }
      }
    }

    if (bestSnap) {
      const { PA, PB, dc, dr } = bestSnap;
      const moveX = (PB.x - dc * pW) - PA.x;
      const moveY = (PB.y - dr * pH) - PA.y;
      ctx.save();
      ctx.fillStyle   = 'rgba(100,210,255,0.18)';
      ctx.strokeStyle = 'rgba(100,210,255,0.85)';
      ctx.lineWidth   = 2;
      for (const p of group) {
        ctx.save();
        ctx.translate(p.x + moveX, p.y + moveY);
        const prev = this._getPiecePath(p);
        ctx.fill(prev);
        ctx.stroke(prev);
        ctx.restore();
      }
      ctx.restore();
      return;
    }

    // ── 盤面スナッププレビュー ──
    for (const P of group) {
      const cx = this._cx(P), cy = this._cy(P);
      if (Math.abs(P.x - cx) < pW * BOARD_SNAP && Math.abs(P.y - cy) < pH * BOARD_SNAP) {
        const moveX = cx - P.x, moveY = cy - P.y;
        ctx.save();
        ctx.fillStyle   = 'rgba(255,215,0,0.18)';
        ctx.strokeStyle = '#FFD700';
        ctx.lineWidth   = 2;
        for (const p of group) {
          ctx.save();
          ctx.translate(p.x + moveX, p.y + moveY);
          const prev = this._getPiecePath(p);
          ctx.fill(prev);
          ctx.stroke(prev);
          ctx.restore();
        }
        ctx.restore();
        return;
      }
    }
  }

  _drawPiece(p, isDragging) {
    const { ctx, image, pW, pH, cols, rows } = this;

    // ドラッグ中: clip外でドロップシャドウをfillトリックで描画
    // （clip後にshadowをクリアするため、このpassが唯一有効なシャドウ描画）
    if (isDragging) {
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.shadowColor   = 'rgba(0,0,0,0.60)';
      ctx.shadowBlur    = 24;
      ctx.shadowOffsetX = 5;
      ctx.shadowOffsetY = 8;
      ctx.fillStyle     = 'rgba(0,0,0,0.01)';
      ctx.fill(this._getPiecePath(p));
      ctx.restore();
    }

    ctx.save();

    if (isDragging) {
      // 1.03倍拡大でピースが"持ち上がって見える"（ピース中心基準）
      const cx = p.x + pW / 2, cy = p.y + pH / 2;
      ctx.translate(cx, cy);
      ctx.scale(1.03, 1.03);
      ctx.translate(-cx, -cy);
    } else if (!p.placed) {
      ctx.shadowColor   = 'rgba(0,0,0,0.3)';
      ctx.shadowBlur    = 6;
      ctx.shadowOffsetX = 2;
      ctx.shadowOffsetY = 2;
    }

    // translate→キャッシュパスでclip（毎フレームのPath2D生成を排除）
    ctx.translate(p.x, p.y);
    const path = this._getPiecePath(p);
    ctx.clip(path);

    ctx.shadowColor   = 'transparent';
    ctx.shadowBlur    = 0;
    ctx.shadowOffsetX = 0;
    ctx.shadowOffsetY = 0;

    const iW = image.width, iH = image.height;
    const cellW = iW / cols, cellH = iH / rows;
    const EXTRA_X = Math.max(0.36, 0.32 * pH / pW);
    const EXTRA_Y = Math.max(0.36, 0.32 * pW / pH);
    const srcL = Math.max(0, (p.c - EXTRA_X) * cellW);
    const srcT = Math.max(0, (p.r - EXTRA_Y) * cellH);
    const srcR = Math.min(iW, (p.c + 1 + EXTRA_X) * cellW);
    const srcB = Math.min(iH, (p.r + 1 + EXTRA_Y) * cellH);
    const scX  = pW / cellW;
    const scY  = pH / cellH;
    // ローカル座標系（translate済み）: destX = -c*pW + srcL*scX
    ctx.drawImage(
      image,
      srcL, srcT, srcR - srcL, srcB - srcT,
      -p.c * pW + srcL * scX,
      -p.r * pH + srcT * scY,
      (srcR - srcL) * scX,
      (srcB - srcT) * scY
    );

    // ドラッグ中: 白トーンで明るさを演出（clip内なのでピース形状に自動クリップ）
    if (isDragging) {
      ctx.fillStyle = 'rgba(255,255,255,0.10)';
      ctx.fillRect(0, 0, pW, pH);
    }

    ctx.restore();

    // 輪郭線（clip外で描画）: 暗い外枠+明るいハイライトの2重ストロークで形状を強調
    ctx.save();
    if (isDragging) {
      const cx = p.x + pW / 2, cy = p.y + pH / 2;
      ctx.translate(cx, cy);
      ctx.scale(1.03, 1.03);
      ctx.translate(-cx, -cy);
    }
    ctx.translate(p.x, p.y);
    if (isDragging) {
      ctx.strokeStyle = '#FFD700';
      ctx.lineWidth   = 2;
      ctx.stroke(path);
    } else if (p.placed) {
      ctx.strokeStyle = 'rgba(0,0,0,0.35)';
      ctx.lineWidth   = 1.5;
      ctx.stroke(path);
      ctx.strokeStyle = 'rgba(255,255,255,0.28)';
      ctx.lineWidth   = 0.8;
      ctx.stroke(path);
    } else {
      ctx.strokeStyle = 'rgba(0,0,0,0.55)';
      ctx.lineWidth   = 2.5;
      ctx.stroke(path);
      ctx.strokeStyle = 'rgba(255,255,255,0.70)';
      ctx.lineWidth   = 1;
      ctx.stroke(path);
    }
    ctx.restore();
  }

  // ── Events ─────────────────────────────────────────────────────────────

  _rect() { return this.canvas.getBoundingClientRect(); }

  _onTStart(e) {
    e.preventDefault();
    if (this.activeTouchId !== null) return;
    const t = e.changedTouches[0];
    this.activeTouchId = t.identifier;
    const r = this._rect();
    this._startDrag(t.clientX - r.left, t.clientY - r.top);
  }

  _onTMove(e) {
    e.preventDefault();
    const t = Array.from(e.changedTouches).find(t => t.identifier === this.activeTouchId);
    if (!t) return;
    const r = this._rect();
    this._moveDrag(t.clientX - r.left, t.clientY - r.top);
    this._scheduleRender();
  }

  _onTEnd(e) {
    e.preventDefault();
    const t = Array.from(e.changedTouches).find(t => t.identifier === this.activeTouchId);
    if (!t) return;
    this.activeTouchId = null;
    this._endDrag();
  }

  _onMDown(e) {
    e.preventDefault();
    const r = this._rect();
    this._startDrag(e.clientX - r.left, e.clientY - r.top);
  }

  _onMMove(e) {
    if (!this.dragPiece) return;
    const r = this._rect();
    this._moveDrag(e.clientX - r.left, e.clientY - r.top);
    this._scheduleRender();
  }

  _onMUp() { this._endDrag(); }

  // rAFでレンダリングをVsyncに同期し、過剰描画を防ぐ
  _scheduleRender() {
    if (this._rafId) return;
    this._rafId = requestAnimationFrame(() => {
      this._rafId = null;
      this._render();
    });
  }

  _attachEvents() {
    const c = this.canvas;
    c.addEventListener('touchstart',  this._onTStart, { passive: false });
    c.addEventListener('touchmove',   this._onTMove,  { passive: false });
    c.addEventListener('touchend',    this._onTEnd,   { passive: false });
    c.addEventListener('touchcancel', this._onTEnd,   { passive: false });
    c.addEventListener('mousedown',   this._onMDown);
    window.addEventListener('mousemove', this._onMMove);
    window.addEventListener('mouseup',   this._onMUp);
  }

  _detachEvents() {
    const c = this.canvas;
    c.removeEventListener('touchstart',  this._onTStart);
    c.removeEventListener('touchmove',   this._onTMove);
    c.removeEventListener('touchend',    this._onTEnd);
    c.removeEventListener('touchcancel', this._onTEnd);
    c.removeEventListener('mousedown',   this._onMDown);
    window.removeEventListener('mousemove', this._onMMove);
    window.removeEventListener('mouseup',   this._onMUp);
    window.removeEventListener('resize', this._resizeDebounced);
    window.removeEventListener('orientationchange', this._resizeDebounced);
    clearTimeout(this._resizeTimer);
  }

  // ── Timer / Save / Complete ────────────────────────────────────────────

  _startTimer() {
    this.timerInterval = setInterval(() => {
      this.elapsed++;
      if (this.onUpdate) this.onUpdate(this.elapsed);
    }, 1000);
  }

  _stopTimer() { clearInterval(this.timerInterval); }

  _scheduleSave() {
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this._save(), SAVE_DEBOUNCE);
  }

  async _save() {
    if (this.completed || !this._imageBlob) return;
    await saveState({
      imageBlob: this._imageBlob,
      pieces:    this.pieces.map(p => ({ ...p })),
      cols:      this.cols,
      rows:      this.rows,
      elapsed:   this.elapsed,
      vW:        this.vW,
      vH:        this.vH,
    });
  }

  setImageBlob(blob) { this._imageBlob = blob; }

  _checkComplete() {
    if (!this.pieces.every(p => p.placed)) return;
    this.completed = true;
    this._stopTimer();
    this._detachEvents();
    clearState();
    if (this.onComplete) this.onComplete(this.elapsed);
  }

  destroy() {
    this._stopTimer();
    this._detachEvents();
    clearTimeout(this.saveTimer);
    if (this._rafId) { cancelAnimationFrame(this._rafId); this._rafId = null; }
  }

  countPlaced() { return this.pieces.filter(p => p.placed).length; }
}

export function formatTime(sec) {
  const m = Math.floor(sec / 60).toString().padStart(2, '0');
  const s = (sec % 60).toString().padStart(2, '0');
  return `${m}:${s}`;
}
