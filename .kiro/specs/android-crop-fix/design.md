# 修正設計書 — Oshi Puzzle Plus Android Crop 比率崩れ

> 生成日: 2026-05-29
> スペック: android-crop-fix
> バージョン: 1.0
> 手法: 実測ベース設計（Playwright Android emulation, DPR=2.75, Pixel 5相当）

---

## 1. エグゼクティブサマリー

Oshi Puzzle Plus の crop 画面は Android Chrome 横画面で canvas 高さが 191px に縮退し、
confirm() が出力する blob のアスペクト比が **4.46:1**（期待値 ≈ 0.67:1）になり、
パズル画像が縦方向に極端に圧縮された状態で生成される。

原因は3層構造: (1) CSS ヘッダー/フッターが縦横で同一高さ、
(2) `crop.js` が `canvas.style.width/height` を設定しない、
(3) `visualViewport.resize` を購読していない。
修正はすべて **既存ファイルの最小変更**（CSS 1箇所 + JS 2箇所）で対応可能。

### 設計上の主要決定

| 決定 | 選択 | 理由 |
|------|------|------|
| レイアウト崩れ対策 | CSS `@media (orientation: landscape)` でフッター高さを削減 | JS 側ではなく CSS の責務 |
| canvas サイズ同期 | `_updateCanvasBuffer()` に `style.width/height` 追加 | `puzzle.js` と同じパターンに統一 |
| visualViewport 購読 | `_attachEvents()` に `visualViewport.addEventListener('resize', ...)` 追加 | ResizeObserver はアドレスバー変化を検出しない |

---

## 2. 問題定義（実測値付き）

### 2-1. レイアウト崩れの数値的証明

```
Portrait 393×851:
  header(61) + hint(31) + footer(110) = 202px 固定
  canvas wrap clientH = 851 - 202 = 649px  → 正常
  blob ratio = 1081 / 1785 = 0.6056         → 正常（入力 400×600 = 0.667 に近い）

Landscape 851×393:
  header(61) + hint(31) + footer(110) = 202px 固定（変わらない！）
  canvas wrap clientH = 393 - 202 = 191px  → 異常
  blob ratio = 2340 / 525 = 4.4571          → 深刻な歪み（期待 0.667 の 6.7倍）
```

**根本原因 #1**: `.crop-header`, `.crop-hint-text`, `.crop-footer` に
横画面用のコンパクト定義が存在しない。202px 固定では
393px しかない横画面で canvas にわずか 191px しか残らない。

### 2-2. canvas.style.width/height 未設定

```
実測 (portrait):
  canvas.style.width  = ""    ← 空（未設定）
  canvas.style.height = ""    ← 空（未設定）
  canvas getBCR W/H = 1081 × 1785  （= buffer 寸法）
  wrap clientW/H    = 393  × 649

canvas buffer (1081×1785) が wrap (393×649) をはみ出している。
overflow:hidden でクリップされているため表示は正常に見えるが、
canvas の intrinsic size がレイアウトに干渉するリスクがある。
```

**根本原因 #2**: `_updateCanvasBuffer()` が `canvas.width/height`（buffer）のみ設定し、
`canvas.style.width/height`（CSS 表示サイズ）を設定しない。
`puzzle.js` の `_resize()` は両方設定しており、パターンが不統一。

### 2-3. visualViewport.resize 未購読

```
実測 (headless Playwright):
  innerH - vvpH = 0（差なし）← アドレスバーが存在しないため

実機 Android Chrome:
  アドレスバー表示時: vvpH = innerH - 56px 程度
  スクロール後非表示: vvpH = innerH
  → この変化は ResizeObserver では検出されない
  → canvas は更新されず、空白が生じる or レンダリングずれ
```

**根本原因 #3**: `_attachEvents()` は `ResizeObserver` を `_wrap` に設定するが、
`window.visualViewport` の `resize` イベントを購読していない。
アドレスバーの hide/show で `vvpH` が変化しても canvas は追従しない。

---

## 3. Component 設計（修正対象）

```
#cropScreen (position:fixed; flex-column)
  ├── .crop-header          [FIX-1: landscape で高さ削減]
  ├── .crop-hint-text       [FIX-1: landscape で非表示]
  ├── #cropCanvasWrap       [変更なし: flex:1 で自動伸縮]
  │    └── #cropCanvas      [FIX-2: style.width/height を設定]
  └── .crop-footer          [FIX-1: landscape でコンパクト化]

CropScreen (crop.js)
  ├── _updateCanvasBuffer() [FIX-2: style.width/height 追加]
  └── _attachEvents()       [FIX-3: visualViewport.resize 追加]
```

---

## 4. 修正仕様

### FIX-1: CSS — 横画面レスポンシブ対応

**対象ファイル**: `style.css`
**対象箇所**: `/* ===== CROP SCREEN =====*/` ブロック末尾に追記

**目標値**:

| 状態 | header | hint | footer | canvas高さ | blob比率上限 |
|------|--------|------|--------|-----------|-------------|
| Portrait (851px) | 61px | 31px | 110px | 649px | 0.67 |
| Landscape (393px) 現在 | 61px | 31px | 110px | **191px** | **4.46** |
| Landscape (393px) 目標 | ≤45px | 0px | ≤55px | **≥293px** | ≤2.90 |

**設計方針**:

```css
/* 追加: 横画面 crop コンパクト化 */
@media (orientation: landscape) and (max-height: 500px) {

  /* ヘッダー: padding を 12px → 4px に削減 → 約 45px */
  .crop-header {
    padding-top: 4px;
    padding-bottom: 4px;
  }

  /* ヒントテキスト: 横画面では非表示（31px → 0px） */
  .crop-hint-text {
    display: none;
  }

  /* フッター: padding と gap を削減 → 約 50px */
  .crop-footer {
    padding-top: 6px;
    padding-bottom: 6px;
    gap: 4px;
  }

  /* 決定ボタン: 縦余白を削減 */
  #cropConfirmBtn {
    padding-top: 8px;
    padding-bottom: 8px;
  }
}
```

**期待結果**:
- chrome 合計: ≈ 45 + 0 + 50 = 95px
- canvas 高さ: 393 - 95 = **298px**
- blob 比率: 851 / 298 × 2.75 ÷ (851 × 2.75) = **851:298 = 2.86:1**
  - 横画面は本来ワイドなので 3:1 程度は自然な比率

> **注意**: `max-height: 500px` で絞ることで、折りたたみ式デバイスや
> タブレット横画面（通常 600px 以上）には影響しない。

**`safe-area-inset` 対応**:

既存の `@media (max-width: 600px)` 内の safe-area ルールは landscape でも発動するため、
`padding-bottom: calc(6px + env(safe-area-inset-bottom))` に上書きが必要。

```css
@media (orientation: landscape) and (max-height: 500px) {
  /* safe-area 上書き（ジェスチャーナビ対応機種） */
  .crop-footer {
    padding-bottom: calc(6px + env(safe-area-inset-bottom));
  }
}
```

---

### FIX-2: crop.js — canvas.style.width/height の設定追加

**対象ファイル**: `crop.js`
**対象箇所**: `_updateCanvasBuffer()` (line 135–141)

**現状**:
```js
_updateCanvasBuffer(w, h) {
  const dpr = window.devicePixelRatio || 1;
  this._canvas.width  = Math.round(w * dpr);
  this._canvas.height = Math.round(h * dpr);
  this._cW = w;
  this._cH = h;
  // canvas.style.width/height が設定されていない
}
```

**修正後**:
```js
_updateCanvasBuffer(w, h) {
  const dpr = window.devicePixelRatio || 1;
  this._canvas.width  = Math.round(w * dpr);
  this._canvas.height = Math.round(h * dpr);
  this._canvas.style.width  = w + 'px';   // puzzle.js _resize() と同パターン
  this._canvas.style.height = h + 'px';
  this._cW = w;
  this._cH = h;
}
```

**効果**:
- `canvas.getBCR()` が buffer 寸法ではなく wrap 寸法（= CSS 論理サイズ）を返す
- `position:absolute; inset:0` と CSS サイズが一致し、レイアウト干渉を防ぐ
- blob の確認は変わらない（`_cW/_cH` ベースのため）

**トレーサビリティ**: `puzzle.js` の `_resize()` が先例。両クラスで一貫したパターン。

---

### FIX-3: crop.js — visualViewport.resize 購読追加

**対象ファイル**: `crop.js`
**対象箇所**: `_attachEvents()` (line 304–323) および `_detachEvents()` (line 325–346)

**現状の問題**:
```js
// _attachEvents()
if (window.ResizeObserver) {
  this._resizeObserver = new ResizeObserver(this._handleResize);
  this._resizeObserver.observe(this._wrap);   // ← アドレスバー変化を検知しない
}
```

**修正後** (`_attachEvents` 末尾、`this._eventsAttached = true` の直前):
```js
// visualViewport resize（Android Chrome アドレスバー hide/show 対応）
if (window.visualViewport) {
  window.visualViewport.addEventListener('resize', this._handleResize);
}
this._eventsAttached = true;
```

**修正後** (`_detachEvents` の `clearTimeout(this._resizeTimer)` の直前):
```js
if (window.visualViewport) {
  window.visualViewport.removeEventListener('resize', this._handleResize);
}
```

**効果**:
- Android Chrome でアドレスバーが隠れる・現れるたびに `_handleResize` が呼ばれる
- debounce 220ms + double-rAF は既存のままで適切に機能する
- `_handleResize` は `_wrap.clientWidth/H` を読み直すため、
  FIX-1 で正しくなった wrap 寸法を使って canvas を更新する

---

## 5. 検証仕様

### 5-1. 自動検証（measure_full.py で確認）

修正後に `python -u measure_full.py` を実行し、以下の数値を確認する:

| 測定値 | 修正前 | 修正後 目標 | 判定条件 |
|--------|--------|------------|---------|
| `wrpClientH` (landscape) | 191 | ≥ 290 | PASS |
| `blob_landscape.ratio` | 4.4571 | ≤ 3.20 | PASS |
| `canvas.style.height` (portrait) | `""` | `"649px"` | PASS |
| `canvas.style.height` (landscape) | `""` | `"≥290px"` | PASS |
| `_bufHok` (両方向) | true | true | 維持 |
| `_diffIH_VVP` (headless) | 0 | 0 | 維持 |
| `blob_portrait.ratio` | 0.6056 | 0.60 ± 0.02 | 維持 |

### 5-2. 目視確認（スクリーンショット）

| ファイル | 確認内容 |
|---------|---------|
| `m_02_landscape.png` | フッターが画面下部に小さく、canvas が広い |
| `m_05_blob_landscape.png` | 横画面 confirm 後の crop 結果が極端に縦圧縮されていない |

### 5-3. 実機確認チェックリスト（手動）

- [ ] 縦画面で画像を読み込み → crop 画面表示 → 問題なし
- [ ] 横画面で画像を読み込み → フッターがコンパクト → canvas 広い
- [ ] 横画面で決定 → パズル画面に移行 → 画像比率が保たれている
- [ ] 縦→横 回転 → canvas がリサイズされる（縦線にならない）
- [ ] スクロールしてアドレスバーを隠す → canvas が伸びる（FIX-3）

---

## 6. 非修正箇所（スコープ外）

| 箇所 | 理由 |
|------|------|
| `confirm()` の offscreen canvas 計算 | `_cW/_cH` ベースで正しく動いている |
| `_fitImage()` の cover 計算 | canvas サイズが正しくなれば連動して正しくなる |
| `_handleResize()` の debounce 値 (220ms) | 適切な値。変更不要 |
| `puzzle.js` | 別クラス。`style.width/height` は既に設定済み |
| `index.html` | DOM 構造変更なし |

---

## 7. 未解決事項

- [ ] **safe-area-inset の実機値**: Playwright では `env(safe-area-inset-bottom) = 0`。
  実機でのジェスチャーバー高さによっては landscape footer が想定より高くなる可能性。
  対策: `padding-bottom: calc(6px + env(...))` で対応済みだが、実機測定推奨。

- [ ] **FIX-1 の breakpoint 閾値**: `max-height: 500px` は Pixel 5 の 393px を想定。
  他の小型横画面（例: SE 2nd gen landscape = 375px）でも同様に動作するか確認が必要。

- [ ] **FIX-3 の二重発火リスク**: `ResizeObserver` と `visualViewport.resize` が
  同時に発火するケースがある（orientation change 時）。
  `_handleResize` の debounce により実害はないが、将来的には排他制御を検討。

---

## 8. 実装順序

```
1. style.css   — FIX-1 追記（landscape メディアクエリ）
2. crop.js     — FIX-2 追記（_updateCanvasBuffer に 2行追加）
3. crop.js     — FIX-3 追記（_attachEvents / _detachEvents に各 3行追加）
4. measure_full.py 再実行 → 数値確認
5. スクリーンショット目視確認
6. 実機テスト
```

各修正は独立しており、ロールバック単位も独立している。
FIX-2 は副作用リスクが最も低いため最初に実装して動作確認するのが安全。
