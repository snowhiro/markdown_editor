/*
 * WYSIWYGモード用エディタ（Milkdown）のバンドルエントリ。
 * esbuildでIIFEにバンドルし、window.WysiwygEditor としてapp.jsから利用する。
 * CSSのimportは wysiwyg-bundle.css として出力される。
 *
 * plugin-diagram のスキーマはソーステキストを出力するのみで描画は利用側の
 * 責務のため、mermaidでSVGに描画するNodeViewをここで提供する。
 * タスクリストのチェックボックスも同様にCSS描画＋クリックトグルを実装する。
 */

import "prosemirror-view/style/prosemirror.css";
import "prosemirror-tables/style/tables.css";
import "prosemirror-gapcursor/style/gapcursor.css";

import { Editor, defaultValueCtx, rootCtx } from "@milkdown/core";
import { commonmark } from "@milkdown/preset-commonmark";
import { gfm } from "@milkdown/preset-gfm";
import { listener, listenerCtx } from "@milkdown/plugin-listener";
import { history } from "@milkdown/plugin-history";
import { clipboard } from "@milkdown/plugin-clipboard";
import { diagram, diagramSchema, mermaidConfigCtx } from "@milkdown/plugin-diagram";
import { getMarkdown, replaceAll, $view, $prose } from "@milkdown/utils";
import { Plugin } from "@milkdown/prose/state";
import {
  addColumnAfter,
  addColumnBefore,
  addRowAfter,
  addRowBefore,
  deleteColumn,
  deleteRow,
  isInTable,
} from "@milkdown/prose/tables";
import mermaid from "mermaid";

// ---- Mermaid図のNodeView ----

let diagramCounter = 0;

function renderDiagram(dom, value) {
  const renderId = `diagram-render-${++diagramCounter}`;
  mermaid.render(renderId, value).then(
    ({ svg }) => {
      dom.innerHTML = svg;
    },
    (err) => {
      // 描画失敗時はソースとエラーを表示する（mermaidがbodyに残す要素も掃除）
      document.getElementById(renderId)?.remove();
      dom.innerHTML = "";
      const pre = document.createElement("pre");
      pre.className = "mermaid-error";
      pre.textContent = `${value}\n\n${err?.message ?? err}`;
      dom.appendChild(pre);
    }
  );
}

const diagramView = $view(diagramSchema.node, () => (initialNode) => {
  const dom = document.createElement("div");
  dom.dataset.type = "diagram";
  dom.className = "diagram";
  renderDiagram(dom, initialNode.attrs.value);
  return {
    dom,
    update: (node) => {
      if (node.type.name !== "diagram") return false;
      renderDiagram(dom, node.attrs.value);
      return true;
    },
    ignoreMutation: () => true,
  };
});

// ---- タスクリストのクリックトグル ----

const taskToggle = $prose(
  () =>
    new Plugin({
      props: {
        handleClickOn: (view, _pos, node, nodePos, event) => {
          if (node.type.name !== "list_item" || node.attrs.checked == null) {
            return false;
          }
          const target = event.target;
          const li =
            target instanceof Element
              ? target.closest('li[data-item-type="task"]')
              : null;
          if (!li) return false;
          // チェックボックス（liの左外側に描画）付近のクリックのみ反応する
          const rect = li.getBoundingClientRect();
          const offset = event.clientX - rect.left;
          if (offset > 4 || offset < -30) return false;
          view.dispatch(
            view.state.tr.setNodeAttribute(
              nodePos,
              "checked",
              !node.attrs.checked
            )
          );
          return true;
        },
      },
    })
);

// ---- テーブル操作ツールバー ----
// カーソルがテーブル内にあるとき、そのテーブルの上に行・列の追加/削除
// ボタンを表示する。

class TableToolbarView {
  constructor(view) {
    this.view = view;
    this.dom = document.createElement("div");
    this.dom.className = "table-toolbar";
    this.dom.hidden = true;

    const groups = [
      [
        "行",
        [
          ["＋上", "行を上に追加", addRowBefore],
          ["＋下", "行を下に追加", addRowAfter],
          ["✕", "行を削除", deleteRow],
        ],
      ],
      [
        "列",
        [
          ["＋左", "列を左に追加", addColumnBefore],
          ["＋右", "列を右に追加", addColumnAfter],
          ["✕", "列を削除", deleteColumn],
        ],
      ],
    ];

    groups.forEach(([label, buttons], i) => {
      if (i > 0) {
        const sep = document.createElement("span");
        sep.className = "tt-sep";
        this.dom.appendChild(sep);
      }
      const labelEl = document.createElement("span");
      labelEl.className = "tt-label";
      labelEl.textContent = label;
      this.dom.appendChild(labelEl);
      for (const [text, title, command] of buttons) {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.textContent = text;
        btn.title = title;
        // mousedownで実行することでエディタのフォーカス・選択を維持する
        btn.addEventListener("mousedown", (e) => {
          e.preventDefault();
          command(this.view.state, this.view.dispatch);
          this.view.focus();
        });
        this.dom.appendChild(btn);
      }
    });

    // .milkdown（position:relative）配下に置き、本文と一緒にスクロールさせる
    view.dom.parentElement.appendChild(this.dom);
    this.update();
  }

  update() {
    const { state } = this.view;
    if (!isInTable(state)) {
      this.dom.hidden = true;
      return;
    }
    let el = this.view.domAtPos(state.selection.from).node;
    if (el.nodeType === Node.TEXT_NODE) el = el.parentElement;
    const table = el.closest ? el.closest("table") : null;
    const parent = this.dom.parentElement;
    if (!table || !parent) {
      this.dom.hidden = true;
      return;
    }
    this.dom.hidden = false;
    const parentRect = parent.getBoundingClientRect();
    const tableRect = table.getBoundingClientRect();
    this.dom.style.top = `${
      tableRect.top - parentRect.top - this.dom.offsetHeight - 6
    }px`;
    this.dom.style.left = `${tableRect.left - parentRect.left}px`;
  }

  destroy() {
    this.dom.remove();
  }
}

const tableToolbar = $prose(
  () =>
    new Plugin({
      view: (editorView) => new TableToolbarView(editorView),
    })
);

// ---- エディタ本体 ----

class WysiwygEditor {
  static async create(parent, { doc = "", dark = false, onChange = null } = {}) {
    const instance = new WysiwygEditor();
    instance._onChange = onChange;
    instance._applying = false;

    instance.editor = await Editor.make()
      .config((ctx) => {
        ctx.set(rootCtx, parent);
        ctx.set(defaultValueCtx, doc);
        ctx.set(mermaidConfigCtx.key, {
          startOnLoad: false,
          theme: dark ? "dark" : "default",
        });
        ctx
          .get(listenerCtx)
          .markdownUpdated((_ctx, markdown, prevMarkdown) => {
            if (
              !instance._applying &&
              markdown !== prevMarkdown &&
              instance._onChange
            ) {
              instance._onChange(markdown);
            }
          });
      })
      .use(commonmark)
      .use(gfm)
      .use(listener)
      .use(history)
      .use(clipboard)
      .use(diagram)
      .use(diagramView)
      .use(taskToggle)
      .use(tableToolbar)
      .create();

    return instance;
  }

  getMarkdown() {
    return this.editor.action(getMarkdown());
  }

  setMarkdown(doc) {
    this._applying = true;
    try {
      this.editor.action(replaceAll(doc));
    } finally {
      this._applying = false;
    }
  }
}

window.WysiwygEditor = WysiwygEditor;
