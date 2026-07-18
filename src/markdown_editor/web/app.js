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

// ---- モード切替 ----

function getScrollFraction(el) {
  const max = el.scrollHeight - el.clientHeight;
  return max > 0 ? el.scrollTop / max : 0;
}

function switchMode(mode) {
  if (mode === state.mode || mode === "wysiwyg") return;
  const prevMode = state.mode;
  state.mode = mode;

  document.querySelectorAll(".mode-tab").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.mode === mode);
  });

  // 離れるペインのスクロール位置（比率）を引き継ぐ
  const fraction =
    prevMode === "edit" && editor
      ? editor.getScrollFraction()
      : getScrollFraction(previewPane);

  if (mode === "edit") {
    previewPane.hidden = true;
    editorPane.hidden = false;
    ensureEditor();
    if (editor.getDoc() !== state.markdown) {
      applyingExternal = true;
      editor.setDoc(state.markdown);
      applyingExternal = false;
    }
    editor.setScrollFraction(fraction);
    editor.focus();
  } else {
    editorPane.hidden = true;
    previewPane.hidden = false;
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
  if (state.mode === "preview") {
    render();
    previewPane.scrollTop = 0;
  } else if (editor) {
    editor.setScrollFraction(0);
  }
}

// ---- 起動時のウェルカム表示（ブラウザ単体で開いた開発時用） ----

const SAMPLE_MARKDOWN = `# Markdown Editor

「ファイル > 開く...」（Cmd/Ctrl+O）でMarkdownファイルを開いてください。

## GFMサポート

- [x] 見出し・リスト・**強調** ・ ~~取り消し線~~
- [x] テーブル / タスクリスト
- [x] Editモード（ソース編集）
- [ ] WYSIWYGモード（未実装）

| モード | 状態 |
|---|---|
| Preview | ✅ 実装済み |
| Edit | ✅ 実装済み |
| WYSIWYG | 🚧 未実装 |

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
