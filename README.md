# Markdown Editor

macOS / Windows で動作するクロスプラットフォームMarkdownエディタ。
GitHub Flavored Markdown (GFM) と Mermaid記法をサポートし、
Preview / WYSIWYG / Edit の3モードを切り替えて利用できる。

要件の詳細は [docs/spec.md](docs/spec.md) を参照。

## 開発環境セットアップ

Python 3.10 以上と Node.js（フロントエンドのバンドルに使用）が必要。

```bash
python3 -m venv .venv
source .venv/bin/activate  # Windows: .venv\Scripts\activate
pip install -e .

npm install
npm run build   # frontend/ を web/vendor/editor-bundle.js にバンドル
```

## 起動

```bash
markdown-editor           # または: python -m markdown_editor.main
markdown-editor path/to/file.md   # ファイルを指定して起動
```

「ファイル > 開く...」（Cmd/Ctrl+O）でMarkdownファイルを開けます。

## 構成

```
frontend/            # esbuildでバンドルするESMソース
                     # (editor.js: CodeMirror 6 / wysiwyg.js: Milkdown)
src/markdown_editor/
├── main.py          # PySide6 アプリシェル（ウィンドウ・メニュー・ファイルI/O・保存管理）
└── web/             # QWebEngineView 内で動作するUI本体
    ├── index.html
    ├── app.js       # Markdownレンダリング・モード管理・Pythonブリッジ
    ├── styles.css   # GitHub風スタイル（ライト/ダーク対応）
    └── vendor/      # バンドル済みJSライブラリ
                     # (markdown-it, mermaid, highlight.js,
                     #  editor-bundle, wysiwyg-bundle)
```

## ライセンス

MIT
