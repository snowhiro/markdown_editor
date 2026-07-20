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

import { Editor, defaultValueCtx, rootCtx, editorViewCtx } from "@milkdown/core";
import { commonmark, imageSchema } from "@milkdown/preset-commonmark";
import { gfm } from "@milkdown/preset-gfm";
import { listener, listenerCtx } from "@milkdown/plugin-listener";
import { history } from "@milkdown/plugin-history";
import { clipboard } from "@milkdown/plugin-clipboard";
import { diagram, diagramSchema, mermaidConfigCtx } from "@milkdown/plugin-diagram";
import {
  tableSchema,
  tableRowSchema,
  tableHeaderRowSchema,
  tableCellSchema,
  tableHeaderSchema,
} from "@milkdown/preset-gfm";
import { getMarkdown, replaceAll, $view, $prose } from "@milkdown/utils";
import { Plugin, Selection } from "@milkdown/prose/state";
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

import { openDiagramEditor, localizeSeqMarkerIds } from "./diagram-editor.js";

// ---- Mermaid図のNodeView ----

let diagramCounter = 0;

function renderDiagram(dom, value) {
  const renderId = `diagram-render-${++diagramCounter}`;
  mermaid.render(renderId, value).then(
    ({ svg }) => {
      // marker IDの衝突対策（localizeSeqMarkerIds参照）
      dom.innerHTML = localizeSeqMarkerIds(svg, renderId);
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

const diagramView = $view(diagramSchema.node, () => (initialNode, view, getPos) => {
  const dom = document.createElement("div");
  dom.dataset.type = "diagram";
  dom.className = "diagram";
  dom.title = "ダブルクリックでGUI編集";

  let currentValue = initialNode.attrs.value;

  dom.addEventListener("dblclick", async (e) => {
    e.preventDefault();
    const result = await openDiagramEditor(currentValue);
    if (result != null && result !== currentValue) {
      const pos = getPos();
      if (typeof pos === "number") {
        view.dispatch(view.state.tr.setNodeAttribute(pos, "value", result));
      }
    }
  });

  renderDiagram(dom, currentValue);
  return {
    dom,
    update: (node) => {
      if (node.type.name !== "diagram") return false;
      currentValue = node.attrs.value;
      renderDiagram(dom, currentValue);
      return true;
    },
    ignoreMutation: () => true,
  };
});

// ---- 画像（相対パス解決とクリップボード貼り付け: spec.md 5.2） ----

// 相対パス画像を文書フォルダ基準で表示するためのNodeView。
// Markdown上のsrc（相対パス）は保持したまま、表示時のみ
// app.jsのresolveDocResourceでfile:// URLへ解決する。
const imageView = $view(imageSchema.node, () => (initialNode) => {
  const img = document.createElement("img");
  const apply = (node) => {
    const src = node.attrs.src || "";
    img.src = window.resolveDocResource ? window.resolveDocResource(src) : src;
    img.alt = node.attrs.alt || "";
    if (node.attrs.title) img.title = node.attrs.title;
  };
  apply(initialNode);
  return {
    dom: img,
    update: (node) => {
      if (node.type.name !== "image") return false;
      apply(node);
      return true;
    },
  };
});

// 画像貼り付けハンドラ（app.jsからWysiwygEditor.create時に注入される）
const pasteHandlers = { onPasteImage: null, imageFromClipboard: null };

const imagePaste = $prose(
  () =>
    new Plugin({
      props: {
        handlePaste: (_view, event) => {
          const { onPasteImage, imageFromClipboard } = pasteHandlers;
          if (!onPasteImage || !imageFromClipboard) return false;
          const file = imageFromClipboard(event.clipboardData);
          if (!file) return false; // 通常のテキスト貼り付けに任せる
          onPasteImage(file);
          return true; // 既定の貼り付け処理を抑止
        },
      },
    })
);

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

// 選択位置がテーブル内にある場合、そのテーブル直後の挿入位置を返す（それ以外はnull）。
// テーブル内でreplaceSelectionWithするとテーブルが分割されてしまうため、
// ブロック要素の挿入はテーブルの外へ逃がす。
function blockInsertPos(state) {
  const { $from } = state.selection;
  for (let d = $from.depth; d > 0; d--) {
    if ($from.node(d).type.name === "table") return $from.after(d);
  }
  return null;
}

// ---- エディタ本体 ----

class WysiwygEditor {
  static async create(
    parent,
    {
      doc = "",
      dark = false,
      onChange = null,
      onPasteImage = null,
      imageFromClipboard = null,
    } = {}
  ) {
    const instance = new WysiwygEditor();
    instance._onChange = onChange;
    instance._applying = false;
    pasteHandlers.onPasteImage = onPasteImage;
    pasteHandlers.imageFromClipboard = imageFromClipboard;

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
      .use(imageView)
      .use(imagePaste)
      .use(taskToggle)
      .use(tableToolbar)
      .create();

    return instance;
  }

  getMarkdown() {
    return this.editor.action(getMarkdown());
  }

  // カーソル位置に空のテーブルを挿入する（rowsはヘッダー行を含む）。
  // preset-gfmのinsertTableCommandはセルのalignmentがデフォルトの"left"になり
  // 区切り行が「:---」でシリアライズされるため、揃え指定なし（---）となるよう
  // alignment: null のセルで自前構築する。
  insertTable(rows, cols) {
    this.editor.action((ctx) => {
      const view = ctx.get(editorViewCtx);
      const { state } = view;
      const attrs = { alignment: null };
      const makeRow = (rowType, cellType) =>
        rowType.create(
          null,
          Array.from({ length: cols }, () => cellType.createAndFill(attrs))
        );
      const rowNodes = [
        makeRow(tableHeaderRowSchema.type(ctx), tableHeaderSchema.type(ctx)),
      ];
      for (let i = 0; i < rows - 1; i++) {
        rowNodes.push(makeRow(tableRowSchema.type(ctx), tableCellSchema.type(ctx)));
      }
      const table = tableSchema.type(ctx).create(null, rowNodes);
      const outsidePos = blockInsertPos(state);
      let tr;
      let cursorFrom;
      if (outsidePos != null) {
        tr = state.tr.insert(outsidePos, table);
        cursorFrom = outsidePos;
      } else {
        cursorFrom = state.selection.from;
        tr = state.tr.replaceSelectionWith(table);
      }
      // カーソルをテーブルの先頭セルへ移す
      const sel = Selection.findFrom(tr.doc.resolve(cursorFrom), 1, true);
      if (sel) tr.setSelection(sel);
      view.dispatch(tr.scrollIntoView());
      view.focus();
    });
  }

  // カーソル位置に画像（インラインノード）を挿入する
  insertImage(src, alt = "") {
    this.editor.action((ctx) => {
      const view = ctx.get(editorViewCtx);
      const node = imageSchema.type(ctx).create({ src, alt });
      view.dispatch(view.state.tr.replaceSelectionWith(node).scrollIntoView());
      view.focus();
    });
  }

  // カーソル位置にMermaid図ブロックを挿入する
  insertDiagram(source) {
    this.editor.action((ctx) => {
      const view = ctx.get(editorViewCtx);
      const { state } = view;
      const node = diagramSchema.type(ctx).create({ value: source });
      const outsidePos = blockInsertPos(state);
      const tr =
        outsidePos != null
          ? state.tr.insert(outsidePos, node)
          : state.tr.replaceSelectionWith(node);
      view.dispatch(tr.scrollIntoView());
      view.focus();
    });
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
