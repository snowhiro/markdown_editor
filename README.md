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

「開発環境セットアップ」（`pip install -e .` と `npm run build`）を一度実行した後、
以下のいずれかのコマンドでアプリを起動できる。

```bash
# 仮想環境を有効化していない場合は先に実行
source .venv/bin/activate   # Windows: .venv\Scripts\activate

markdown-editor                    # コンソールスクリプト（pip install -e . で登録済み）
python -m markdown_editor.main     # 上と同じ内容をモジュール実行で起動する場合
markdown-editor path/to/file.md    # 起動時に指定したMarkdownファイルを開く
```

どちらのコマンドも同じアプリを起動する。`markdown-editor` コマンドが見つからない場合は、
`pip install -e .` を実行した仮想環境が有効化されているか確認する
（`which markdown-editor` で仮想環境内のパスが表示されれば正しく認識されている）。

起動直後はファイルパスを指定しなければウェルカム文書がPreviewモードで表示される。
そこから以下の方法でMarkdownファイルを開ける。

* メニューの「ファイル > 開く...」（ショートカット: Cmd/Ctrl+O）
* 起動時にコマンドライン引数でファイルパスを渡す（上記 `markdown-editor path/to/file.md`）

保存は「ファイル > 保存」（Cmd/Ctrl+S）、別名保存は「ファイル > 名前を付けて保存...」
（Cmd/Ctrl+Shift+S）から行う。未保存の変更があるとタイトルバーに `*` が表示され、
別のファイルを開く・アプリを終了する際に保存確認ダイアログが出る。

### ExcelファイルをMarkdownへ変換する

「ファイル > Excelから変換...」で `.xlsx` / `.xlsm` を指定すると、Excelと同じフォルダに
「拡張子を除いたファイル名」のフォルダが作られ、シートごとに `<シート名>.md` が出力される。
変換後はそのフォルダがファイルツリーのルートになり、先頭シートのmdが開く。

表かどうかはセルの**罫線**で判定する（2行×2列以上の罫線領域をGFMテーブルに、
それ以外の行は段落テキストに変換する）。表示形式・太字/斜体/取り消し線・
ハイパーリンク・セル内改行・結合セルに対応する。画像やグラフなどの描画オブジェクトは
変換対象外で、含まれていた場合はmdの末尾に注記が入る。詳細は
[docs/spec.md](docs/spec.md) の11章を参照。

### frontend/ を編集した場合

`frontend/editor.js`・`frontend/wysiwyg.js`・`frontend/diagram-editor.js` 等を変更した場合は、
アプリを再起動する前に `npm run build` を再実行して `src/markdown_editor/web/vendor/` の
バンドルを更新する必要がある（Pythonコード側の変更のみであれば再ビルド不要）。
変更を継続的に反映させたい場合は `npm run watch` でファイル変更を監視できる。

### うまく起動しない場合

* **WYSIWYG / Edit モードが真っ白、またはコンソールにモジュール読み込みエラーが出る**:
  `npm install && npm run build` が未実行、または失敗している可能性が高い。
  `src/markdown_editor/web/vendor/` に `editor-bundle.js` と `wysiwyg-bundle.js` が
  生成されているか確認する
* **`markdown-editor: command not found`**: 仮想環境が有効化されていないか、
  `pip install -e .` が未実行
* **`ModuleNotFoundError: No module named 'PySide6'`**: 仮想環境の外でPythonを実行している。
  `source .venv/bin/activate` を実行してから再度コマンドを実行する

## 配布用パッケージング（.app / .exe）

PyInstallerで、Python実行環境のインストールが不要な単体の配布物（macOS: `.app`、Windows: `.exe`）を生成できる。

```bash
pip install -e ".[build]"   # pyinstallerを導入（初回のみ）
npm run build               # フロントエンドのバンドルを最新化（未実行なら）

pyinstaller packaging/markdown_editor.spec --noconfirm
```

生成物は `dist/Markdown Editor.app`（macOS）に出力される。`--noconfirm` は既存の `build/` / `dist/` を確認なしで上書きする。

* specファイルは `src/markdown_editor/web/` 一式（`vendor/` の外部ライブラリ含む）を `markdown_editor/web` としてアプリ内に同梱する
* `frontend/` を変更した場合は、パッケージング前に必ず `npm run build` を実行してバンドルを更新すること
* ビルド後は `open "dist/Markdown Editor.app"` で起動確認できる

## 構成

```
frontend/            # esbuildでバンドルするESMソース
                     # (editor.js: CodeMirror 6 / wysiwyg.js: Milkdown)
src/markdown_editor/
├── main.py          # PySide6 アプリシェル（ウィンドウ・メニュー・ファイルI/O・保存管理）
├── excel_import.py  # Excel → Markdown 変換（openpyxl。Qt非依存）
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
