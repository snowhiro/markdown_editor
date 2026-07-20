/*
 * Editモード用エディタ（CodeMirror 6）のバンドルエントリ。
 * esbuildでIIFEにバンドルし、window.SourceEditor としてapp.jsから利用する。
 */

import { basicSetup } from "codemirror";
import { EditorView, keymap } from "@codemirror/view";
import { Compartment, EditorState } from "@codemirror/state";
import { indentWithTab } from "@codemirror/commands";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { languages } from "@codemirror/language-data";
import { oneDark } from "@codemirror/theme-one-dark";

class SourceEditor {
  constructor(
    parent,
    {
      doc = "",
      dark = false,
      onChange = null,
      onPasteImage = null,
      imageFromClipboard = null,
    } = {}
  ) {
    this._themeCompartment = new Compartment();
    this.view = new EditorView({
      parent,
      state: EditorState.create({
        doc,
        extensions: [
          basicSetup,
          keymap.of([indentWithTab]),
          markdown({ base: markdownLanguage, codeLanguages: languages }),
          EditorView.lineWrapping,
          this._themeCompartment.of(dark ? oneDark : []),
          // クリップボードが画像のみの場合は貼り付けを横取りして
          // 画像保存＋リンク挿入を行う（spec.md 5.2）
          EditorView.domEventHandlers({
            paste: (event) => {
              if (!onPasteImage || !imageFromClipboard) return false;
              const file = imageFromClipboard(event.clipboardData);
              if (!file) return false; // 通常のテキスト貼り付けに任せる
              event.preventDefault();
              onPasteImage(file);
              return true;
            },
          }),
          EditorView.updateListener.of((update) => {
            if (update.docChanged && onChange) {
              onChange(update.state.doc.toString());
            }
          }),
        ],
      }),
    });
  }

  getDoc() {
    return this.view.state.doc.toString();
  }

  setDoc(doc) {
    this.view.dispatch({
      changes: { from: 0, to: this.view.state.doc.length, insert: doc },
    });
  }

  setDark(dark) {
    this.view.dispatch({
      effects: this._themeCompartment.reconfigure(dark ? oneDark : []),
    });
  }

  focus() {
    this.view.focus();
  }

  // カーソル位置（選択範囲を置換）にインラインテキストを挿入する
  insertText(text) {
    const { from, to } = this.view.state.selection.main;
    this.view.dispatch({
      changes: { from, to, insert: text },
      selection: { anchor: from + text.length },
      scrollIntoView: true,
    });
    this.view.focus();
  }

  // テキストをブロックとして挿入する。coords（クリック座標）があれば
  // その位置へカーソルを移してから、現在行の後ろに前後空行を確保して挿入する。
  // cursorOffsetは挿入テキスト先頭からのカーソル配置位置。
  insertBlock(text, coords = null, cursorOffset = 0) {
    const view = this.view;
    if (coords) {
      const pos = view.posAtCoords(coords);
      if (pos != null) view.dispatch({ selection: { anchor: pos } });
    }
    const state = view.state;
    const line = state.doc.lineAt(state.selection.main.head);
    const prefix = line.text.trim() === "" ? "" : "\n\n";
    // 直後が空行ならそのまま区切りとして使い、空行の二重化を避ける
    let suffix = "\n";
    if (line.number < state.doc.lines) {
      const next = state.doc.line(line.number + 1);
      suffix = next.text.trim() === "" ? "" : "\n";
    }
    const insertPos = line.to;
    view.dispatch({
      changes: { from: insertPos, insert: prefix + text + suffix },
      selection: { anchor: insertPos + prefix.length + cursorOffset },
      scrollIntoView: true,
    });
    view.focus();
  }

  getScrollFraction() {
    const el = this.view.scrollDOM;
    const max = el.scrollHeight - el.clientHeight;
    return max > 0 ? el.scrollTop / max : 0;
  }

  setScrollFraction(fraction) {
    const el = this.view.scrollDOM;
    el.scrollTop = fraction * (el.scrollHeight - el.clientHeight);
  }
}

window.SourceEditor = SourceEditor;
