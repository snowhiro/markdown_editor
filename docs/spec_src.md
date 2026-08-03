# ソースコード構成ドキュメント

本ドキュメントは `docs/spec.md`（要件仕様書）に対して、実装済みソースコードの
構成・役割・呼び出し関係を整理したもの。仕様の変更に追従して更新すること。

## 1. 全体構成

```
frontend/                       # esbuildでバンドルするESMソース
├── editor.js                   # Edit モード（CodeMirror 6） → vendor/editor-bundle.js
├── wysiwyg.js                  # WYSIWYG モード（Milkdown） → vendor/wysiwyg-bundle.js
└── diagram-editor.js           # Mermaid GUIエディタ（wysiwyg.jsから読み込まれ、
                                 #   wysiwyg-bundle.js に同梱される）

src/markdown_editor/
├── __init__.py
├── main.py                     # PySide6 アプリシェル（ウィンドウ・メニュー・
                                 #   ファイルI/O・ファイルツリー・エクスポート・貼り付け画像保存）
├── excel_import.py             # Excel → Markdown 変換（openpyxl / Qt非依存）
└── web/                        # QWebEngineView 内で動作するUI本体
    ├── index.html              # ペイン構造・スクリプト読み込み順を定義
    ├── app.js                  # Markdownレンダリング・モード管理・右クリックメニュー・
                                 #   Pythonブリッジ配線
    ├── styles.css              # 全モード共通スタイル（ライト/ダーク対応）
    └── vendor/                 # ビルド生成物 + 外部ライブラリ（そのまま同梱）
        ├── editor-bundle.js    # ← frontend/editor.js
        ├── wysiwyg-bundle.js   # ← frontend/wysiwyg.js + diagram-editor.js
        ├── wysiwyg-bundle.css
        ├── markdown-it.min.js / markdown-it-task-lists.min.js
        ├── highlight.min.js / highlight-github(-dark).min.css
        └── mermaid.min.js

tests/                          # オフスクリーンQt結合テスト（PySide6 + QT_QPA_PLATFORM=offscreen）
├── test_save_logic.py          # 新規/開く/保存/未保存確認・改行コード維持
├── test_search.py              # Previewモードの検索（インクリメンタル・前後移動・モード連動）
├── test_search_layout.py       # 検索バーの高さ（レイアウト崩れ検知）
├── test_paste_image.py         # クリップボード画像の保存・相対パス画像の表示解決
├── test_export.py              # HTML/PDFエクスポート
├── test_file_tree.py           # ファイルツリーのルート決定・クリック・新規作成・トグル
├── test_link_click.py          # リンククリックの振り分け（アプリ内 / OS委譲）
├── test_split_preview.py       # Editモードの分割プレビュー
├── test_excel_import.py        # Excel → Markdown 変換ロジック（Qt不要）
└── test_excel_menu.py          # Excel取り込みのメニュー・ダイアログ・出力先の反映
```

## 2. レイヤーと責務

| レイヤー          | 主なファイル                                           | 責務                                                                                       |
| ------------- | ------------------------------------------------ | ---------------------------------------------------------------------------------------- |
| Pythonアプリシェル  | `main.py`                                        | ウィンドウ／メニュー／ファイルI/O／ファイルツリー／エクスポート（PDF/HTML）／貼り付け画像の保存。`QWebChannel`で`bridge`オブジェクトをJSへ公開 |
| Web UI 基盤     | `web/index.html`, `web/app.js`, `web/styles.css` | 3モードのペイン切替、markdown-itによるPreviewレンダリング、右クリックメニュー、Pythonブリッジの受け口                          |
| Edit モード      | `frontend/editor.js`                             | CodeMirror 6ラッパー（`SourceEditor`）。ブロック挿入APIを提供                                            |
| WYSIWYG モード   | `frontend/wysiwyg.js`                            | Milkdownラッパー（`WysiwygEditor`）。画像・図・テーブルのNodeView、貼り付けハンドラ                                |
| Mermaid GUI編集 | `frontend/diagram-editor.js`                     | フローチャート/シーケンス図の専用編集ダイアログ（`DiagramEditorDialog` / `SequenceEditorDialog`）                 |
| Excel取り込み     | `excel_import.py`                                | openpyxl／zipによるExcelの読み取りとMarkdown生成。QtもUIも参照しないため単体でテスト可能                              |

## 3. 主要な型・クラス

### main.py

* `AppWebPage(QWebEnginePage)` — JSコンソール出力をstderrへ中継

* `Bridge(QObject)` — JS→Python: `ready` / `contentChanged` / `modeChanged` / `exportBody` / `savePastedImage` / `handleLinkClick` / `log`。Python→JS: `fileOpened` / `pathChanged` / `splitPreviewToggled`（Signal）

* `MainWindow(QMainWindow)` — 本体。役割ごとに以下のセクションに分かれる

  * メニュー構築（`_build_menu`）

  * 検索（`show_search` 他、Previewモードのみ）

  * ファイルツリー（`_build_tree_view` 他、spec.md 9.1）

  * ファイル操作（`new_file` / `open_file` / `load_path` / `save` / `save_as` / `_write_to`）

  * クリップボード画像保存（`save_pasted_image`、spec.md 5.2）

  * エクスポート（`export_html_dialog` / `export_pdf_dialog` / `_print_pdf`、spec.md 7章）

  * Excel取り込み（`import_excel_dialog` / `import_excel` / `_report_excel_result`、spec.md 11章）

### excel_import.py

Qt非依存の変換ロジック。`main.py` からは実行時に遅延インポートする（起動時のコストを避けるため）。

* `convert_workbook(xlsx_path, out_dir, progress)` — エントリポイント。`ConversionResult` を返す

* `sheet_to_markdown(ws, ...)` — シート1枚をMarkdown本文へ。空文字列は「空シート」を意味する

* `detect_tables(bordered)` — 罫線セルの集合 → テーブル領域の外接矩形リスト（spec.md 11.4）

* `format_value(value, number_format)` — Excelの表示形式を適用。丸めは `Decimal` の四捨五入でExcelに合わせる

* `cell_text(cell, in_table)` / `decorate(...)` — 文字装飾・リンク・改行・`|` のエスケープ（spec.md 11.5）

* `sanitize_sheet_name(name)` / `unique_file_names(names)` — ファイル名の正規化と重複回避（spec.md 11.2）

* `scan_drawing_objects(xlsx_path)` — 描画オブジェクトの検出。openpyxlは未対応図形を含む描画パートを
  画像・グラフごと読み捨てるため（spec.md 13.1）、xlsxのzipを直接読んで数える

### web/app.js

* `state` — `{ markdown, filePath, mode }`。Single Source of Truthをここに保持

* `render()` — Previewのレンダリング（markdown-it → 画像パス解決 → `renderMermaid()`）

* `renderMermaid()` — Mermaid図の描画。ソース文字列をキーにSVGをキャッシュし、変化していない図は再描画しない（分割プレビューの再描画コスト対策）

* `resolveDocResource()` — 文書フォルダ基準で相対パスを`file://`へ解決（`window`に公開しWYSIWYG側からも参照）

* `clipboardImageFile()` / `savePastedImage()` — 貼り付け画像の抽出とブリッジ経由保存

* `openInsertMenu()` — 右クリックメニュー（テーブルのグリッドピッカー／フローチャート／シーケンス図）

* `switchMode()` / `setDocument()` — モード切替と文書差し替えの中心ロジック

* `applyLayout()` / `setSplitPreview()` / `renderSplitPreview()` — Editモードの分割プレビュー（spec.md 4.1）。ペインの表示状態・幅比の決定、デバウンス再描画、編集→プレビューのスクロール連動

### frontend/editor.js

* `SourceEditor` — `getDoc` / `setDoc` / `insertBlock`（右クリックメニューからのブロック挿入）/ スクロール位置保持 / `onScroll`（分割プレビューのスクロール連動用の通知）

### frontend/wysiwyg.js

* `WysiwygEditor` — `getMarkdown` / `setMarkdown` / `insertTable` / `insertDiagram` / `insertImage`

* `diagramView` — Mermaidコードブロックを描画するNodeView（ダブルクリックでGUIエディタ起動）

* `imageView` — 相対パス画像をfile://へ解決して表示するNodeView

* `imagePaste` — 画像クリップボード貼り付けのProseMirrorプラグイン

* `TableToolbarView` — 表内カーソル時に行/列操作ボタンを表示

### frontend/diagram-editor.js

* `parseFlowchart` / `serialize` — フローチャート ⇔ モデルの相互変換

* `parseSequence` / `serializeSequence` — シーケンス図 ⇔ モデルの相互変換（GUI非対応構文は`reason`付きで拒否）

* `DiagramEditorDialog` — フローチャート編集モーダル

* `SequenceEditorDialog` — シーケンス図編集モーダル（参加者・メッセージ・Note、`over`範囲対応）

* `openDiagramEditor(source)` — 図種を判定して適切なダイアログを開く公開API

## 4. 処理フロー（フローチャート）

### 4.1 起動〜文書表示

```mermaid
flowchart TD
    Start(["起動"]) --> Main["main(): QApplicationとMainWindowを生成"]
    Main --> Load["view.load(index.html)"]
    Load --> Ready["app.js: QWebChannel接続 → bridge.ready()"]
    Ready --> OnWebReady["Bridge.ready() → MainWindow.on_web_ready()"]
    OnWebReady -->|"CLI引数のパスあり"| LoadPath["load_path(path)"]
    OnWebReady -->|"パスなし"| Welcome["fileOpened('', WELCOME_MARKDOWN)"]
    LoadPath --> Emit["fileOpened(path, content) をemit"]
    Emit --> SetDoc["app.js: setDocument() → state更新・各モードへ反映"]
    Welcome --> SetDoc
    SetDoc --> Render["現在モードのペインを描画"]
```

### 4.2 編集〜保存（Single Source of Truth同期）

```mermaid
flowchart TD
    Edit["ユーザーがEdit/WYSIWYGで編集"] --> OnChange["各エディタのonChangeコールバック"]
    OnChange --> StateUpdate["app.js: state.markdown を更新"]
    StateUpdate --> Notify["bridge.contentChanged(markdown)"]
    Notify --> PyChanged["MainWindow.on_content_changed()"]
    PyChanged --> Dirty["current_content更新 → dirty判定 → タイトルバー更新（*）"]
    Dirty --> SaveCmd{"保存 (Cmd/Ctrl+S)?"}
    SaveCmd -->|"はい"| WriteTo["_write_to(): 改行コード復元して書き込み"]
    WriteTo --> TreeSync["パス変更時: ファイルツリーのルート/選択を同期"]
    TreeSync --> PathChanged["bridge.pathChanged(path) → 相対パス画像の再解決"]
    SaveCmd -->|"いいえ"| Dirty
```

### 4.3 ファイルツリーからのナビゲーション（spec.md 9.1）

```mermaid
flowchart TD
    OpenAny["ファイルを開く（メニュー/CLI/ツリークリック/新規作成）"] --> Root{"現在のtree_root配下?"}
    Root -->|"いいえ / 未確定"| SetRoot["_set_tree_root(親フォルダ)"]
    Root -->|"はい"| Select["_select_in_tree(path)"]
    SetRoot --> Select
    Select --> Visible["_update_tree_visibility()"]

    ClickItem["ツリー項目をクリック"] --> IsDir{"フォルダ?"}
    IsDir -->|"はい"| NoopDir["何もしない"]
    IsDir -->|"いいえ"| SameCheck{"現在開いているファイルと同じ?"}
    SameCheck -->|"はい"| NoopSame["何もしない"]
    SameCheck -->|"いいえ"| Confirm{"未保存変更あり?"}
    Confirm -->|"あり→キャンセル"| Revert["選択を現在ファイルへ戻す"]
    Confirm -->|"なし/保存/破棄"| LoadPath2["load_path(path)"]
    LoadPath2 --> OpenAny

    RightClick["ツリーを右クリック"] --> Menu["「新規Markdownファイル...」"]
    Menu --> NameInput["ファイル名を入力"]
    NameInput --> Exists{"同名ファイルが存在?"}
    Exists -->|"はい"| ErrorDlg["エラーダイアログ"]
    Exists -->|"いいえ"| Confirm2{"未保存変更あり?"}
    Confirm2 -->|"キャンセル"| Abort["中止"]
    Confirm2 -->|"OK"| CreateFile["空ファイル作成 → load_path()"]
    CreateFile --> OpenAny
```

### 4.4 クリップボード画像の貼り付け（spec.md 5.2）

```mermaid
flowchart TD
    Paste["Cmd/Ctrl+V（WYSIWYG/Edit）"] --> Handler["各エディタのpasteハンドラが横取り"]
    Handler --> ClipCheck["clipboardImageFile(): テキストがあればテキスト優先"]
    ClipCheck -->|"画像のみ"| ToBase64["FileReaderでBase64化"]
    ClipCheck -->|"テキストあり"| DefaultPaste["既定の貼り付け処理へ委譲"]
    ToBase64 --> Bridge2["bridge.savePastedImage(base64)"]
    Bridge2 --> PySave["MainWindow.save_pasted_image()"]
    PySave --> PathCheck{"未保存の新規文書?"}
    PathCheck -->|"はい"| SaveAsDlg["名前を付けて保存ダイアログ"]
    SaveAsDlg -->|"キャンセル"| Abort2["空文字列を返し貼り付け中止"]
    SaveAsDlg -->|"保存"| MkDir["image/フォルダを作成"]
    PathCheck -->|"いいえ"| MkDir
    MkDir --> WritePng["PNGとしてタイムスタンプ名で保存（衝突時は連番）"]
    WritePng --> RelPath["相対パス image/xxx.png を返す"]
    RelPath --> Insert["各エディタが ![](image/xxx.png) を挿入"]
    Insert --> ResolveDisplay["表示時: resolveDocResource()でfile://へ解決して描画"]
```

### 4.5 Mermaid GUI編集（spec.md 6.1 / 6.2）

```mermaid
flowchart TD
    DblClick["WYSIWYGで図をダブルクリック"] --> OpenEditor["openDiagramEditor(source)"]
    OpenEditor --> Detect["mermaid.mermaidAPI.getDiagramFromText() で図種判定"]
    Detect -->|"flowchart"| ParseFlow["parseFlowchart(): モデルへ変換"]
    Detect -->|"sequence"| ParseSeq["parseSequence(): モデルへ変換"]
    Detect -->|"対応外"| Unsupported["非対応ダイアログ表示 → Editモードへ誘導"]
    ParseFlow -->|"対応外構文を検出"| Unsupported
    ParseSeq -->|"対応外構文を検出"| Unsupported
    ParseFlow -->|"OK"| DialogFlow["DiagramEditorDialogを開く"]
    ParseSeq -->|"OK"| DialogSeq["SequenceEditorDialogを開く"]
    DialogFlow --> Mutate["ノード/エッジ操作 → _mutate() → 再描画"]
    DialogSeq --> MutateSeq["参加者/メッセージ/Note操作 → _mutate() → 再描画"]
    Mutate --> SaveDiagram["保存 → serialize() でMermaidソース化"]
    MutateSeq --> SaveDiagram2["保存 → serializeSequence() でMermaidソース化"]
    SaveDiagram --> Replace["対象のmermaidコードブロックを置換"]
    SaveDiagram2 --> Replace
```

### 4.6 エクスポート（spec.md 7章）

```mermaid
flowchart TD
    Menu2["ファイル > HTML/PDFとしてエクスポート..."] --> Dialog["保存先ダイアログ"]
    Dialog --> StartExport["_start_export(path, kind)"]
    StartExport --> ExportHtml["JS: window.exportHtml() で画面外にPreview相当を描画"]
    ExportHtml --> Body["Mermaid図をSVG化した本文HTMLを返す"]
    Body --> OnExportBody["MainWindow.on_export_body()"]
    OnExportBody --> BuildHtml["_build_export_html(): styles.css等を埋め込み自己完結HTML化"]
    BuildHtml --> KindCheck{"kind"}
    KindCheck -->|"html"| WriteHtml["そのままファイルへ書き込み"]
    KindCheck -->|"pdf"| PrintPdf["一時HTMLを非表示QWebEngineViewへ読込 → printToPdf()"]
    WriteHtml --> Done["ステータスバーに完了表示"]
    PrintPdf --> Done
```

### 4.7 Editモードの分割プレビュー（spec.md 4.1）

```mermaid
flowchart TD
    Toggle["表示メニュー: プレビューを分割表示"] --> Signal["bridge.splitPreviewToggled(on)"]
    Signal --> SetSplit["setSplitPreview(on)"]
    SetSplit --> Apply["applyLayout(): Editモード かつ 幅が足りる場合のみ分割"]
    Apply --> Panes["#content に split クラス付与 → 左=編集 / 右=Preview"]
    Panes --> First["renderSplitPreview() で初回描画"]

    Type["Editモードで編集"] --> OnChange["SourceEditor onChange"]
    OnChange --> Sync["state.markdown更新 → bridge.contentChanged()"]
    OnChange --> Debounce["scheduleSplitRender(): 300msのデバウンス"]
    Debounce --> Rerender["renderSplitPreview()"]
    Rerender --> Render["render(): markdown-it → renderMermaid()"]
    Render --> Cache{"図のソースは前回と同じ?"}
    Cache -->|"同じ"| Reuse["キャッシュのSVGを再利用"]
    Cache -->|"異なる"| Run["mermaid.run() で再描画しキャッシュ更新"]
    Rerender --> Keep["スクロール位置を維持（追従中は編集側の比率に合わせる）"]

    Scroll["編集側をスクロール"] --> OnScroll["onEditorScroll()"]
    OnScroll --> Follow["プレビューを同じ比率へ移動"]
    ScrollPv["プレビューを直接スクロール"] --> Stop["追従を停止（編集側の操作再開で復帰）"]

    Resize["ウィンドウ幅の変更"] --> Fits{"両ペインが最小幅240pxを確保できる?"}
    Fits -->|"はい"| Apply
    Fits -->|"いいえ"| Collapse["分割を一時解除しEditのみ表示"]
```

### 4.8 Excel → Markdown 変換（spec.md 11章）

```mermaid
flowchart TD
    Menu["ファイル > Excelから変換..."] --> Pick["QFileDialog で .xlsx / .xlsm を選択"]
    Pick --> Suffix{"対応形式?"}
    Suffix -->|"いいえ"| Reject["非対応の形式としてエラー表示"]
    Suffix -->|"はい"| OutDir["出力先 = Excelと同階層の拡張子なしファイル名フォルダ"]
    OutDir --> Exists{"フォルダが既に存在?"}
    Exists -->|"はい"| Confirm{"上書き確認"}
    Confirm -->|"キャンセル"| Abort["何もしない"]
    Confirm -->|"OK"| Scan
    Exists -->|"いいえ"| Scan

    Scan["scan_drawing_objects(): zipを直読みして描画オブジェクトを数える"] --> Formula["_collect_formula_cells(): 数式セルの座標を控える"]
    Formula --> Load["load_workbook(data_only=True)"]
    Load --> Loop["可視シートを先頭から順に処理（進捗をステータスバーへ）"]

    Loop --> Border["罫線セルを収集（結合セルは範囲全体を占有扱い）"]
    Border --> Detect["detect_tables(): 4近傍の連結成分 → 外接矩形 → 重なりを統合 → 2行2列未満を除外"]
    Detect --> Emit["行順に出力: テーブル行はGFMテーブル / それ以外は段落"]
    Emit --> Cells["cell_text(): 表示形式・装飾・リンク・改行・エスケープ"]
    Cells --> Note{"描画オブジェクトあり?"}
    Note -->|"あり"| Append["末尾に注記行を追加"]
    Note -->|"なし"| Write
    Append --> Write["&lt;シート名&gt;.md を UTF-8 / LF で書き出し"]
    Write --> Loop

    Loop --> Report["成功/失敗/空シート/計算値欠落をまとめて報告"]
    Report --> Tree["_set_tree_root(出力先)"]
    Tree --> Open["_confirm_discard() を経て先頭シートのmdを開く"]
```

シート単位の失敗は捕捉して次のシートへ進むため、1枚が壊れていても残りは変換される。

## 5. ビルド・テスト

* フロントエンドのビルド: `npm run build`（`esbuild frontend/editor.js frontend/wysiwyg.js` → `web/vendor/*-bundle.js`）。`frontend/`配下を変更したら再実行が必要

* テスト: `QT_QPA_PLATFORM=offscreen .venv/bin/python tests/<name>.py`（PySide6のオフスクリーン実行、GUIを起動せずCIでも実行可能）
