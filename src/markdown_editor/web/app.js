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
}

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
