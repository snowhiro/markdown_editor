/*
 * Markdownエディタ フロントエンド。
 * Markdown文字列を単一の情報源（Single Source of Truth）として保持し、
 * 各表示モードはそこから描画する。実装済み: Preview / Edit。
 *
 * Pythonブリッジとのプロトコル:
 *   JS→Python: bridge.ready()            初期化完了通知（Pythonはこれを受けて初期文書を送る）
 *              bridge.contentChanged(md) 編集内容の同期（保存・未保存管理用）
 *   Python→JS: bridge.fileOpened(path, content) 文書の差し替え（新規作成時は path="")
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
  if (state.mode === "preview") render();
});

// ---- Preview 描画 ----

const previewPane = document.getElementById("preview-pane");
const previewEl = document.getElementById("preview");
const editorPane = document.getElementById("editor-pane");
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

async function render() {
  const seq = ++renderSeq;
  previewEl.innerHTML = md.render(state.markdown);

  const nodes = previewEl.querySelectorAll("pre.mermaid");
  if (nodes.length === 0) return;
  try {
    await window.mermaid.run({ nodes });
  } catch (err) {
    if (seq === renderSeq) {
      console.warn("mermaid render error:", err);
    }
  }
  if (seq !== renderSeq) return;
  previewEl.querySelectorAll("pre.mermaid svg").forEach((svg, i) => {
    localizeSeqMarkerIds(svg, `preview-${seq}-${i}`);
  });
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
    },
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
      state.markdown = docText;
      if (bridge) bridge.contentChanged(docText);
    },
  });
}

// ---- モード切替 ----

function getScrollFraction(el) {
  const max = el.scrollHeight - el.clientHeight;
  return max > 0 ? el.scrollTop / max : 0;
}

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

  previewPane.hidden = mode !== "preview";
  editorPane.hidden = mode !== "edit";
  wysiwygPane.hidden = mode !== "wysiwyg";

  if (mode === "edit") {
    ensureEditor();
    if (editor.getDoc() !== state.markdown) {
      applyingExternal = true;
      editor.setDoc(state.markdown);
      applyingExternal = false;
    }
    editor.setScrollFraction(fraction);
    editor.focus();
  } else if (mode === "wysiwyg") {
    await ensureWysiwyg();
    // 他モードで編集された場合のみ反映する
    // （未編集での再設定はMilkdownの再シリアライズによる書式正規化を招くため避ける）
    if (wysiwygDoc !== state.markdown) {
      wysiwygDoc = state.markdown;
      wysiwyg.setMarkdown(state.markdown);
    }
    wysiwygPane.scrollTop =
      fraction * (wysiwygPane.scrollHeight - wysiwygPane.clientHeight);
  } else {
    render().then(() => {
      previewPane.scrollTop =
        fraction * (previewPane.scrollHeight - previewPane.clientHeight);
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
    // Python側が初期文書（CLI引数のファイル or ウェルカム文書）を送ってくる
    bridge.ready();
  });
} else {
  // ブラウザ単体で開いた場合（開発用）
  setDocument(null, SAMPLE_MARKDOWN);
}
