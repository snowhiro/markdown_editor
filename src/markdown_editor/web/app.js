/*
 * Markdownエディタ フロントエンド。
 * Markdown文字列を単一の情報源（Single Source of Truth）として保持し、
 * 各表示モードはそこから描画する。実装済み: Preview / Edit。
 *
 * Pythonブリッジとのプロトコル:
 *   JS→Python: bridge.ready()            初期化完了通知（Pythonはこれを受けて初期文書を送る）
 *              bridge.contentChanged(md) 編集内容の同期（保存・未保存管理用）
 *   Python→JS: bridge.fileOpened(path, content) 文書の差し替え（新規作成時は path="")
 *              bridge.splitPreviewToggled(on)   Editモードの分割プレビュー切替
 */

"use strict";

// ---- 状態 ----

const state = {
  markdown: "",
  filePath: null,
  mode: "preview",
};

let bridge = null;
let editor = null;
let wysiwyg = null;
// WYSIWYGエディタが現在保持している内容（不要なsetMarkdownによる再正規化を避ける）
let wysiwygDoc = null;
// Python側から文書を差し替える際、編集通知が跳ね返らないようにするためのフラグ
let applyingExternal = false;

// ---- markdown-it セットアップ ----

const md = window
  .markdownit({
    html: true,
    linkify: true,
    highlight: (code, lang) => {
      if (lang && window.hljs.getLanguage(lang)) {
        try {
          return window.hljs.highlight(code, { language: lang }).value;
        } catch (_) {
          /* フォールバックへ */
        }
      }
      return md.utils.escapeHtml(code);
    },
  })
  .use(window.markdownitTaskLists, { enabled: false });

// ```mermaid ブロックはコードではなくMermaid描画用の要素として出力する
const defaultFence = md.renderer.rules.fence;
md.renderer.rules.fence = (tokens, idx, options, env, self) => {
  const token = tokens[idx];
  if (token.info.trim() === "mermaid") {
    return `<pre class="mermaid">${md.utils.escapeHtml(token.content)}</pre>\n`;
  }
  return defaultFence(tokens, idx, options, env, self);
};

// ---- テーマ（OS設定に追従） ----

const prefersDark = window.matchMedia("(prefers-color-scheme: dark)");

function initMermaid() {
  window.mermaid.initialize({
    startOnLoad: false,
    theme: prefersDark.matches ? "dark" : "default",
  });
}

initMermaid();
prefersDark.addEventListener("change", () => {
  initMermaid();
  if (editor) editor.setDark(prefersDark.matches);
  // Mermaid図のSVGはテーマ配色を焼き込んでいるためキャッシュを捨てて再描画する
  mermaidCache.clear();
  if (state.mode === "preview" || splitActive) render();
});

// ---- Preview 描画 ----

const contentEl = document.getElementById("content");
const previewPane = document.getElementById("preview-pane");
const previewEl = document.getElementById("preview");
const editorPane = document.getElementById("editor-pane");
const dividerEl = document.getElementById("split-divider");
const wysiwygPane = document.getElementById("wysiwyg-pane");
const wysiwygRoot = document.getElementById("wysiwyg-root");
const filePathEl = document.getElementById("file-path");

let renderSeq = 0;

// Mermaidのシーケンス図は矢印先端のSVG marker要素を固定ID（arrowhead等）で
// 定義するため、Preview/WYSIWYG両ペインが同じ図を描画するとIDが衝突する。
// url(#id)参照は文書内で最初の同IDに解決されるので、その定義が非表示ペイン
// 内にあると矢印の先端が描画されない。ペイン固有の接頭辞でIDを一意化する。
const SEQ_MARKER_IDS = ["arrowhead", "crosshead", "filled-head", "sequencenumber"];

function localizeSeqMarkerIds(svgEl, prefix) {
  const renamed = new Map();
  for (const id of SEQ_MARKER_IDS) {
    for (const el of svgEl.querySelectorAll(`[id="${id}"]`)) {
      el.id = `${prefix}-${id}`;
      renamed.set(id, el.id);
    }
  }
  if (renamed.size === 0) return;
  for (const el of svgEl.querySelectorAll("[marker-end], [marker-start]")) {
    for (const attr of ["marker-end", "marker-start"]) {
      const value = el.getAttribute(attr);
      if (!value) continue;
      for (const [oldId, newId] of renamed) {
        if (value.includes(`#${oldId})`)) {
          el.setAttribute(attr, value.replace(`#${oldId})`, `#${newId})`));
        }
      }
    }
  }
}

// 文書内の相対パス（例: image/xxx.png）を文書フォルダ基準のfile:// URLへ
// 解決する（spec.md 5.2）。絶対URL・データURL等はそのまま返す。
// WYSIWYG側（wysiwyg-bundle）の画像NodeViewからも参照される。
function resolveDocResource(src) {
  if (!src || !state.filePath) return src;
  if (/^[a-z][a-z0-9+.-]*:/i.test(src) || src.startsWith("/")) return src;
  const dir = state.filePath.replace(/[\\/][^\\/]*$/, "");
  let base = dir.replace(/\\/g, "/");
  if (!base.startsWith("/")) base = "/" + base; // Windowsのドライブレター対応
  // 記述側で%エンコード済みのパスは二重エンコードを避ける
  return src.includes("%")
    ? `file://${encodeURI(base)}/${src}`
    : encodeURI(`file://${base}/${src}`);
}
window.resolveDocResource = resolveDocResource;

function resolvePreviewImages(root) {
  root.querySelectorAll("img").forEach((img) => {
    const src = img.getAttribute("src") || "";
    const resolved = resolveDocResource(src);
    if (resolved !== src) img.src = resolved;
  });
}

// ---- リンクのクリック挙動（spec.md 5.3） ----
// ページ内遷移はAppWebPage側でも抑止されるが、実際の振り分け（アプリ内で
// 開く/OS既定のアプリで開く）はこちらでhrefを判定してbridgeへ委譲する。
// 文書内アンカー（#のみ）は対象外とし、既定の動作（何もしない）に任せる。

function onLinkClick(e, { requireModifier }) {
  const a = e.target.closest("a[href]");
  if (!a) return;
  const href = a.getAttribute("href") || "";
  if (!href || href.startsWith("#")) return;
  // WYSIWYG（編集可能領域）ではリンクテキストの編集を妨げないよう、
  // 修飾キー付きクリックのみを遷移として扱う
  if (requireModifier && !(e.metaKey || e.ctrlKey)) return;
  e.preventDefault();
  if (bridge) bridge.handleLinkClick(href);
}

previewEl.addEventListener("click", (e) => onLinkClick(e, { requireModifier: false }));
wysiwygRoot.addEventListener("click", (e) => onLinkClick(e, { requireModifier: true }));

// Mermaid図の描画結果キャッシュ（図のソース文字列 → 描画済みSVGのHTML）。
// 分割プレビュー（spec.md 4.1）は入力のたびにPreviewを再描画するため、
// ソースが変わっていない図は再実行せずキャッシュを再利用する。
// テーマ変更時はSVGの配色が変わるためクリアする。
const mermaidCache = new Map();
let mermaidCacheSeq = 0;

async function renderMermaid(seq) {
  const nodes = Array.from(previewEl.querySelectorAll("pre.mermaid"));
  if (nodes.length === 0) {
    mermaidCache.clear();
    return;
  }

  // ソースはmermaid.runで上書きされるため、先に控えておく
  const sources = nodes.map((node) => node.textContent);
  const pending = [];
  nodes.forEach((node, i) => {
    const cached = mermaidCache.get(sources[i]);
    if (cached) {
      node.innerHTML = cached;
      node.setAttribute("data-processed", "true");
    } else {
      pending.push({ node, source: sources[i] });
    }
  });

  if (pending.length > 0) {
    try {
      await window.mermaid.run({ nodes: pending.map((p) => p.node) });
    } catch (err) {
      if (seq === renderSeq) console.warn("mermaid render error:", err);
    }
    if (seq !== renderSeq) return;
    for (const { node, source } of pending) {
      const svg = node.querySelector("svg");
      if (!svg) continue;
      // マーカーIDはソースごとに固有の接頭辞を与える。キャッシュ再利用時も
      // IDが変わらないため、再描画のたびに参照が壊れることはない。
      localizeSeqMarkerIds(svg, `mmd-${++mermaidCacheSeq}`);
      mermaidCache.set(source, node.innerHTML);
    }
  }

  // 文書から消えた図のキャッシュを破棄する
  const alive = new Set(sources);
  for (const key of mermaidCache.keys()) {
    if (!alive.has(key)) mermaidCache.delete(key);
  }
}

async function render() {
  const seq = ++renderSeq;
  previewEl.innerHTML = md.render(state.markdown);
  resolvePreviewImages(previewEl);
  await renderMermaid(seq);
}

// ---- クリップボード画像の貼り付け（spec.md 5.2） ----

// クリップボードから画像ファイルを取り出す。テキストを含む場合は
// テキスト貼り付けを優先するためnullを返す（画像のみのとき有効）。
function clipboardImageFile(dt) {
  if (!dt || !bridge) return null;
  if (dt.getData && dt.getData("text/plain")) return null;
  for (const item of dt.items ?? []) {
    if (item.kind === "file" && item.type.startsWith("image/")) {
      return item.getAsFile();
    }
  }
  return null;
}

// 画像ファイルをPython側へ渡して保存し、相対パスをコールバックで受け取る
function savePastedImage(file, onSaved) {
  const reader = new FileReader();
  reader.onload = () => {
    const b64 = String(reader.result).replace(/^data:[^,]*,/, "");
    bridge.savePastedImage(b64, (relPath) => {
      if (relPath) onSaved(relPath);
    });
  };
  reader.readAsDataURL(file);
}

// ---- エクスポート（HTML/PDF: spec.md 7章） ----

// 現在の文書をPreviewと同じ方法でレンダリングし、本文HTML（Mermaid図は
// SVG描画済み）を返す。CSS埋め込みとファイル書き出しはPython側が行う。
// 画面外の作業用要素で描画するため、表示中のモードには影響しない。
window.exportHtml = async () => {
  const holder = document.createElement("div");
  // display:noneではMermaidがサイズを測れないため、画面外に配置して描画する
  holder.style.position = "fixed";
  holder.style.left = "-99999px";
  holder.style.width = "800px";
  holder.className = "markdown-body";
  holder.innerHTML = md.render(state.markdown);
  document.body.appendChild(holder);
  try {
    const nodes = holder.querySelectorAll("pre.mermaid");
    if (nodes.length > 0) {
      try {
        await window.mermaid.run({ nodes });
      } catch (err) {
        console.warn("mermaid render error (export):", err);
      }
      const prefix = `export-${Date.now()}`;
      holder.querySelectorAll("pre.mermaid svg").forEach((svg, i) => {
        localizeSeqMarkerIds(svg, `${prefix}-${i}`);
      });
    }
    return holder.innerHTML;
  } finally {
    holder.remove();
  }
};

// ---- Edit モード ----

function ensureEditor() {
  if (editor) return;
  editor = new window.SourceEditor(editorPane, {
    doc: state.markdown,
    dark: prefersDark.matches,
    onChange: (docText) => {
      if (applyingExternal) return;
      state.markdown = docText;
      if (bridge) bridge.contentChanged(docText);
      scheduleSplitRender();
    },
    onPasteImage: (file) => {
      savePastedImage(file, (relPath) => {
        editor.insertText(`![](${relPath})`);
      });
    },
    imageFromClipboard: clipboardImageFile,
    onScroll: onEditorScroll,
  });
}

// ---- WYSIWYG モード ----

async function ensureWysiwyg() {
  if (wysiwyg) return;
  wysiwygDoc = state.markdown;
  wysiwyg = await window.WysiwygEditor.create(wysiwygRoot, {
    doc: state.markdown,
    dark: prefersDark.matches,
    onChange: (docText) => {
      wysiwygDoc = docText;
      // Milkdownはこちらからの setMarkdown に対しても非同期に変更を通知する。
      // WYSIWYGが非表示のときのこの通知を採用すると、その間に他モードで
      // 行われた編集を古い内容で巻き戻してしまうため無視する。
      if (state.mode !== "wysiwyg") return;
      state.markdown = docText;
      if (bridge) bridge.contentChanged(docText);
    },
    onPasteImage: (file) => {
      savePastedImage(file, (relPath) => {
        wysiwyg.insertImage(relPath);
      });
    },
    imageFromClipboard: clipboardImageFile,
  });
}

// ---- モード切替 ----

function getScrollFraction(el) {
  const max = el.scrollHeight - el.clientHeight;
  return max > 0 ? el.scrollTop / max : 0;
}

function setScrollFraction(el, fraction) {
  el.scrollTop = fraction * (el.scrollHeight - el.clientHeight);
}

// ---- 分割プレビュー（spec.md 4.1） ----

const MIN_PANE_WIDTH = 240; // 各ペインの最小幅(px)
const SPLIT_RENDER_DELAY = 300; // 入力停止から再描画までの待ち時間(ms)

// splitPreview: ユーザー設定（表示メニューのチェック状態）
// splitActive:  実際に分割表示しているか（Editモードかつ幅が足りる場合のみ真）
let splitPreview = false;
let splitActive = false;
let splitRatio = 0.5;
let splitRenderTimer = null;
// プレビュー側を直接スクロールしている間は編集側への追従を止める
let previewFollowsEditor = true;
let syncingPreviewScroll = false;

function splitFits() {
  return contentEl.clientWidth >= MIN_PANE_WIDTH * 2 + dividerWidth();
}

function dividerWidth() {
  return dividerEl.offsetWidth || 8;
}

// 現在のモード・設定・ウィンドウ幅から各ペインの表示状態を決める
function applyLayout() {
  splitActive = state.mode === "edit" && splitPreview && splitFits();

  contentEl.classList.toggle("split", splitActive);
  editorPane.hidden = state.mode !== "edit";
  wysiwygPane.hidden = state.mode !== "wysiwyg";
  previewPane.hidden = !(state.mode === "preview" || splitActive);
  dividerEl.hidden = !splitActive;

  if (splitActive) {
    clampSplitRatio();
    editorPane.style.flexBasis = `${splitRatio * 100}%`;
  } else {
    editorPane.style.flexBasis = "";
  }
}

// 両ペインが最小幅を確保できる範囲に幅比を丸める
function clampSplitRatio() {
  const width = contentEl.clientWidth - dividerWidth();
  if (width <= 0) return;
  const min = MIN_PANE_WIDTH / width;
  if (min >= 0.5) {
    splitRatio = 0.5;
    return;
  }
  splitRatio = Math.min(Math.max(splitRatio, min), 1 - min);
}

// 表示メニューからの切替（Python側 bridge.splitPreviewToggled が起点）
function setSplitPreview(on) {
  splitPreview = !!on;
  const wasActive = splitActive;
  applyLayout();
  if (splitActive && !wasActive) {
    previewFollowsEditor = true;
    renderSplitPreview();
    if (editor) editor.focus();
  }
}
window.setSplitPreview = setSplitPreview;

function scheduleSplitRender() {
  if (!splitActive) return;
  clearTimeout(splitRenderTimer);
  splitRenderTimer = setTimeout(renderSplitPreview, SPLIT_RENDER_DELAY);
}

// 再描画してもスクロール位置が先頭へ戻らないようにする。
// 編集側へ追従中は編集側の位置に合わせ、そうでなければ元の位置を復元する。
async function renderSplitPreview() {
  clearTimeout(splitRenderTimer);
  splitRenderTimer = null;
  if (!splitActive) return;
  const fraction = getScrollFraction(previewPane);
  await render();
  if (!splitActive) return;
  syncingPreviewScroll = true;
  setScrollFraction(
    previewPane,
    previewFollowsEditor && editor ? editor.getScrollFraction() : fraction
  );
  requestAnimationFrame(() => {
    syncingPreviewScroll = false;
  });
}

// 編集側のスクロールに合わせてプレビュー側を同じ比率へ移動する（一方向）
function onEditorScroll() {
  if (!splitActive || !editor) return;
  previewFollowsEditor = true;
  syncingPreviewScroll = true;
  setScrollFraction(previewPane, editor.getScrollFraction());
  requestAnimationFrame(() => {
    syncingPreviewScroll = false;
  });
}

previewPane.addEventListener(
  "scroll",
  () => {
    // プログラム側からの移動（追従）は利用者の操作とみなさない
    if (splitActive && !syncingPreviewScroll) previewFollowsEditor = false;
  },
  { passive: true }
);

// ディバイダのドラッグによる幅比の変更
dividerEl.addEventListener("pointerdown", (e) => {
  if (!splitActive) return;
  e.preventDefault();
  const rect = contentEl.getBoundingClientRect();
  dividerEl.setPointerCapture(e.pointerId);
  dividerEl.classList.add("dragging");
  document.body.classList.add("split-dragging");

  const onMove = (ev) => {
    splitRatio = (ev.clientX - rect.left) / (rect.width - dividerWidth());
    clampSplitRatio();
    editorPane.style.flexBasis = `${splitRatio * 100}%`;
  };
  const onUp = () => {
    dividerEl.removeEventListener("pointermove", onMove);
    dividerEl.removeEventListener("pointerup", onUp);
    dividerEl.removeEventListener("pointercancel", onUp);
    dividerEl.classList.remove("dragging");
    document.body.classList.remove("split-dragging");
  };
  dividerEl.addEventListener("pointermove", onMove);
  dividerEl.addEventListener("pointerup", onUp);
  dividerEl.addEventListener("pointercancel", onUp);
});

// ウィンドウ幅が最小幅を割った場合は分割を一時解除し、広がれば復帰する
window.addEventListener("resize", () => {
  const wasActive = splitActive;
  applyLayout();
  if (splitActive && !wasActive) renderSplitPreview();
});

async function switchMode(mode) {
  if (mode === state.mode) return;
  const prevMode = state.mode;
  state.mode = mode;

  document.querySelectorAll(".mode-tab").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.mode === mode);
  });

  // Python側へモード変更を通知する（検索機能のモード連動などに使用）
  if (bridge) bridge.modeChanged(mode);

  // 離れるペインのスクロール位置（比率）を引き継ぐ
  let fraction;
  if (prevMode === "edit" && editor) {
    fraction = editor.getScrollFraction();
  } else if (prevMode === "wysiwyg") {
    fraction = getScrollFraction(wysiwygPane);
  } else {
    fraction = getScrollFraction(previewPane);
  }

  // 分割プレビューから離れる場合、プレビューは既に描画済みのため
  // その表示位置を引き継げるよう先に控えておく（spec.md 4.1）
  const keepPreviewScroll = splitActive && mode === "preview";
  const previewFraction = keepPreviewScroll ? getScrollFraction(previewPane) : 0;

  if (mode === "edit") ensureEditor();
  applyLayout();

  if (mode === "edit") {
    if (editor.getDoc() !== state.markdown) {
      applyingExternal = true;
      editor.setDoc(state.markdown);
      applyingExternal = false;
    }
    editor.setScrollFraction(fraction);
    editor.focus();
    if (splitActive) {
      previewFollowsEditor = true;
      renderSplitPreview();
    }
  } else if (mode === "wysiwyg") {
    await ensureWysiwyg();
    // 初期化を待つ間にさらに別モードへ切り替わっていた場合は中断する。
    // 中断しないと、切替後のモードで行った編集を初期化前の内容で
    // 上書きしてしまう（Milkdownのバックグラウンド初期化との競合）。
    if (state.mode !== mode) return;
    // 他モードで編集された場合のみ反映する
    // （未編集での再設定はMilkdownの再シリアライズによる書式正規化を招くため避ける）
    if (wysiwygDoc !== state.markdown) {
      wysiwygDoc = state.markdown;
      wysiwyg.setMarkdown(state.markdown);
    }
    wysiwygPane.scrollTop =
      fraction * (wysiwygPane.scrollHeight - wysiwygPane.clientHeight);
  } else if (keepPreviewScroll) {
    // 分割表示中のプレビューをそのまま全面表示に切り替える（再描画不要）
    setScrollFraction(previewPane, previewFraction);
  } else {
    render().then(() => {
      setScrollFraction(previewPane, fraction);
    });
  }
}

document.querySelectorAll(".mode-tab").forEach((btn) => {
  btn.addEventListener("click", () => switchMode(btn.dataset.mode));
});

// ---- 右クリックメニュー（テーブル挿入: spec.md 5.1） ----

const TABLE_GRID_COLS = 10;
const TABLE_GRID_ROWS = 8;

// 全セル空のGFMテーブルを生成する（rowsはヘッダー行を含む。最低ヘッダー+データ1行）
function genTableMarkdown(rows, cols) {
  rows = Math.max(2, rows);
  const emptyRow = `|${"  |".repeat(cols)}`;
  const delim = `|${" --- |".repeat(cols)}`;
  const lines = [emptyRow, delim];
  for (let i = 0; i < rows - 1; i++) lines.push(emptyRow);
  return lines.join("\n");
}

let ctxMenuEl = null;
let ctxMenuCloser = null;

function closeContextMenu() {
  if (!ctxMenuEl) return;
  ctxMenuEl.remove();
  ctxMenuEl = null;
  document.removeEventListener("mousedown", ctxMenuCloser, true);
  document.removeEventListener("keydown", onContextMenuKeyDown, true);
}

function onContextMenuKeyDown(e) {
  if (e.key === "Escape") {
    e.stopPropagation();
    closeContextMenu();
  }
}

// 挿入するMermaid図の既定テンプレート（GUIエディタで開ける最小構成）
const FLOWCHART_TEMPLATE = 'flowchart TB\n    n1["新規ノード"]';
const SEQUENCE_TEMPLATE =
  "sequenceDiagram\n    participant p1 as 参加者1\n    participant p2 as 参加者2\n    p1->>p2: メッセージ";

// テーブルサイズ選択のグリッドピッカー（サブメニュー中身）を生成する
function buildTableGridPicker(onPick) {
  const panel = document.createElement("div");
  panel.className = "acm-submenu";

  const grid = document.createElement("div");
  grid.className = "tg-grid";
  grid.style.gridTemplateColumns = `repeat(${TABLE_GRID_COLS}, 1fr)`;
  const cells = [];
  for (let r = 1; r <= TABLE_GRID_ROWS; r++) {
    for (let c = 1; c <= TABLE_GRID_COLS; c++) {
      const cell = document.createElement("div");
      cell.className = "tg-cell";
      cell.dataset.r = r;
      cell.dataset.c = c;
      cells.push(cell);
      grid.appendChild(cell);
    }
  }
  panel.appendChild(grid);

  const label = document.createElement("div");
  label.className = "tg-label";
  label.textContent = "サイズを選択";
  panel.appendChild(label);

  const highlight = (hr, hc) => {
    for (const cell of cells) {
      cell.classList.toggle(
        "active",
        Number(cell.dataset.r) <= hr && Number(cell.dataset.c) <= hc
      );
    }
    label.textContent = hr > 0 ? `${hr}行×${hc}列` : "サイズを選択";
  };

  grid.addEventListener("mouseover", (e) => {
    const cell = e.target.closest(".tg-cell");
    if (cell) highlight(Number(cell.dataset.r), Number(cell.dataset.c));
  });
  grid.addEventListener("mouseleave", () => highlight(0, 0));
  grid.addEventListener("click", (e) => {
    const cell = e.target.closest(".tg-cell");
    if (!cell) return;
    onPick(Number(cell.dataset.r), Number(cell.dataset.c));
  });

  return panel;
}

function openInsertMenu(x, y, { onTable, onDiagram }) {
  closeContextMenu();

  const menu = document.createElement("div");
  menu.className = "app-context-menu";

  // テーブル（1階層奥のサブメニューでマス目を選択）
  const tableItem = document.createElement("button");
  tableItem.type = "button";
  tableItem.className = "acm-item";
  tableItem.textContent = "テーブル";
  const arrow = document.createElement("span");
  arrow.className = "acm-sub-arrow";
  arrow.textContent = "▸";
  tableItem.appendChild(arrow);
  menu.appendChild(tableItem);

  const submenu = buildTableGridPicker((rows, cols) => {
    closeContextMenu();
    onTable(rows, cols);
  });
  submenu.hidden = true;
  menu.appendChild(submenu);

  const showSubmenu = () => {
    submenu.hidden = false;
    const itemRect = tableItem.getBoundingClientRect();
    submenu.style.left = `${itemRect.right + 2}px`;
    submenu.style.top = `${itemRect.top - 4}px`;
    // 画面外にはみ出す場合は位置を補正する
    const rect = submenu.getBoundingClientRect();
    if (rect.right > window.innerWidth) {
      submenu.style.left = `${itemRect.left - rect.width - 2}px`;
    }
    if (rect.bottom > window.innerHeight) {
      submenu.style.top = `${window.innerHeight - rect.height - 4}px`;
    }
  };
  tableItem.addEventListener("mouseenter", showSubmenu);
  tableItem.addEventListener("click", showSubmenu);

  // Mermaid図（フローチャート / シーケンス図）
  for (const [labelText, source] of [
    ["フローチャート", FLOWCHART_TEMPLATE],
    ["シーケンス図", SEQUENCE_TEMPLATE],
  ]) {
    const item = document.createElement("button");
    item.type = "button";
    item.className = "acm-item";
    item.textContent = labelText;
    item.addEventListener("mouseenter", () => {
      submenu.hidden = true;
    });
    item.addEventListener("click", () => {
      closeContextMenu();
      onDiagram(source);
    });
    menu.appendChild(item);
  }

  menu.style.left = `${x}px`;
  menu.style.top = `${y}px`;
  document.body.appendChild(menu);
  ctxMenuEl = menu;

  // 画面外にはみ出す場合は位置を補正する
  const rect = menu.getBoundingClientRect();
  if (rect.right > window.innerWidth) menu.style.left = `${x - rect.width}px`;
  if (rect.bottom > window.innerHeight) menu.style.top = `${y - rect.height}px`;

  ctxMenuCloser = (ev) => {
    if (!menu.contains(ev.target)) closeContextMenu();
  };
  document.addEventListener("mousedown", ctxMenuCloser, true);
  document.addEventListener("keydown", onContextMenuKeyDown, true);
}

function onPaneContextMenu(e) {
  // GUI編集ダイアログ（.de-overlay）表示中はダイアログ側のメニューを優先する
  if (document.querySelector(".de-overlay")) return;
  e.preventDefault();
  const coords = { x: e.clientX, y: e.clientY };
  openInsertMenu(e.clientX, e.clientY, {
    onTable: (rows, cols) => {
      if (state.mode === "wysiwyg" && wysiwyg) {
        // rowsはヘッダー行を含む（1行選択時はヘッダー+データ1行を保証）
        wysiwyg.insertTable(Math.max(2, rows), cols);
      } else if (state.mode === "edit" && editor) {
        // カーソルを先頭セル内（"| "の直後）に置く
        editor.insertBlock(genTableMarkdown(rows, cols), coords, 2);
      }
    },
    onDiagram: (source) => {
      if (state.mode === "wysiwyg" && wysiwyg) {
        wysiwyg.insertDiagram(source);
      } else if (state.mode === "edit" && editor) {
        editor.insertBlock("```mermaid\n" + source + "\n```", coords, 0);
      }
    },
  });
}

wysiwygPane.addEventListener("contextmenu", onPaneContextMenu);
editorPane.addEventListener("contextmenu", onPaneContextMenu);

// ---- 文書の差し替え（ファイルオープン・新規作成） ----

function setDocument(path, content) {
  state.filePath = path || null;
  state.markdown = content;
  filePathEl.textContent = path || "";

  if (editor) {
    applyingExternal = true;
    editor.setDoc(content);
    applyingExternal = false;
  }
  if (wysiwyg) {
    wysiwygDoc = content;
    wysiwyg.setMarkdown(content);
  }
  if (state.mode === "preview") {
    render();
    previewPane.scrollTop = 0;
  } else if (state.mode === "edit" && editor) {
    editor.setScrollFraction(0);
    if (splitActive) {
      previewFollowsEditor = true;
      previewPane.scrollTop = 0;
      renderSplitPreview();
    }
  } else if (state.mode === "wysiwyg") {
    wysiwygPane.scrollTop = 0;
  }
}

// ---- 起動時のウェルカム表示（ブラウザ単体で開いた開発時用） ----

const SAMPLE_MARKDOWN = `# Markdown Editor

「ファイル > 開く...」（Cmd/Ctrl+O）でMarkdownファイルを開いてください。

## GFMサポート

- [x] 見出し・リスト・**強調** ・ ~~取り消し線~~
- [x] テーブル / タスクリスト
- [x] Editモード（ソース編集）
- [x] WYSIWYGモード

| モード | 状態 |
|---|---|
| Preview | ✅ 実装済み |
| Edit | ✅ 実装済み |
| WYSIWYG | ✅ 実装済み |

## コードハイライト

\`\`\`python
def hello(name: str) -> str:
    return f"Hello, {name}!"
\`\`\`

## Mermaid

\`\`\`mermaid
flowchart LR
    A[Markdown] --> B{モード}
    B --> C[Preview]
    B --> D[WYSIWYG]
    B --> E[Edit]
\`\`\`
`;

// ---- Python ブリッジ ----

if (typeof qt !== "undefined" && qt.webChannelTransport) {
  new QWebChannel(qt.webChannelTransport, (channel) => {
    bridge = channel.objects.bridge;
    bridge.fileOpened.connect((path, content) => setDocument(path, content));
    // 保存等でパスが変わったら相対パス画像の解決基準を更新する
    // 表示メニューからの分割プレビュー切替（spec.md 4.1）
    bridge.splitPreviewToggled.connect((on) => setSplitPreview(on));
    bridge.pathChanged.connect((path) => {
      state.filePath = path || null;
      filePathEl.textContent = path || "";
      if (state.mode === "preview") render();
    });
    // Python側が初期文書（CLI引数のファイル or ウェルカム文書）を送ってくる
    bridge.ready();
  });
} else {
  // ブラウザ単体で開いた場合（開発用）
  setDocument(null, SAMPLE_MARKDOWN);
}
