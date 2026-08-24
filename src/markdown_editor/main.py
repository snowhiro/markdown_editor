"""Markdownエディタ アプリシェル。

PySide6 + QWebEngineView 上で web/ 以下のHTML/JSアプリを動かす。
ファイルI/OやネイティブメニューはPython側が担当し、
QWebChannel経由でJS側とやり取りする。

文書内容はJS側が編集のたびに contentChanged で送ってくるため、
Python側は常に最新の内容を保持しており、保存・終了確認を同期的に行える。
改行コードはファイルごとに検出して保持し、内部処理はLFに正規化する。
"""

import base64
import html as html_module
import sys
import tempfile
from datetime import datetime
from pathlib import Path

from PySide6.QtCore import (
    QEvent,
    QEventLoop,
    QFileSystemWatcher,
    QModelIndex,
    QObject,
    Qt,
    QTimer,
    QUrl,
    Signal,
    Slot,
)
from PySide6.QtGui import QAction, QCloseEvent, QDesktopServices, QImage, QKeySequence
from PySide6.QtWebChannel import QWebChannel
from PySide6.QtWebEngineCore import QWebEnginePage, QWebEngineSettings
from PySide6.QtWebEngineWidgets import QWebEngineView
from PySide6.QtWidgets import (
    QApplication,
    QFileDialog,
    QFileSystemModel,
    QHBoxLayout,
    QInputDialog,
    QLabel,
    QLineEdit,
    QMainWindow,
    QMenu,
    QMessageBox,
    QSizePolicy,
    QSplitter,
    QToolButton,
    QTreeView,
    QVBoxLayout,
    QWidget,
)

if getattr(sys, "frozen", False):
    # PyInstallerでパッケージ化した場合、エントリポイントスクリプト（main.py）の
    # __file__ はパッケージ階層を保持せずバンドル直下に置かれるため、
    # __file__基準では web/ を見つけられない。sys._MEIPASS
    # （展開先ルート。packaging/markdown_editor.spec のdatasで
    # markdown_editor/web として同梱している）を基準に解決する。
    WEB_DIR = Path(sys._MEIPASS) / "markdown_editor" / "web"
else:
    WEB_DIR = Path(__file__).resolve().parent / "web"

# 外部更新の検知（spec.md 9.2）で、通知を出す前にイベントを合流させる待ち時間(ms)
WATCH_DEBOUNCE_MS = 200

WELCOME_MARKDOWN = """\
# Markdown Editor

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

```python
def hello(name: str) -> str:
    return f"Hello, {name}!"
```

## Mermaid

```mermaid
flowchart LR
    A[Markdown] --> B{モード}
    B --> C[Preview]
    B --> D[WYSIWYG]
    B --> E[Edit]
```
"""


class AppWebPage(QWebEnginePage):
    """JSコンソール出力の中継と、リンククリックによる意図しないページ内遷移の抑止を行う。

    リンク先の実際の振り分け（アプリ内で開く / OS既定のアプリで開く）はJS側の
    クリックハンドラが `bridge.handleLinkClick()` 経由で行う（spec.md 5.3）。
    ここでの抑止は、その経路を取り漏れた場合に備えた安全網であり、
    アプリ自身（index.html）へのナビゲーションは妨げない。
    """

    def javaScriptConsoleMessage(self, level, message, line_number, source_id):
        print(f"[js] {source_id}:{line_number}: {message}", file=sys.stderr)

    def acceptNavigationRequest(self, url, nav_type, is_main_frame):
        if (
            is_main_frame
            and nav_type == QWebEnginePage.NavigationType.NavigationTypeLinkClicked
        ):
            return False
        return super().acceptNavigationRequest(url, nav_type, is_main_frame)


class Bridge(QObject):
    """Python⇔JS間のブリッジ。JS側では `bridge` という名前で参照される。"""

    # 文書の差し替えをJSへ通知する (パス, 内容)。新規作成時はパスは空文字列
    fileOpened = Signal(str, str)
    # 同じ文書の再読み込みをJSへ通知する (パス, 内容)。
    # fileOpenedと違い、JS側は表示位置を維持する（spec.md 9.2.3）
    fileReloaded = Signal(str, str)
    # 保存等でファイルパスが変わったことをJSへ通知する（相対パス画像の解決に使用）
    pathChanged = Signal(str)
    # Editモードの分割プレビューの表示/非表示をJSへ通知する（spec.md 4.1）
    splitPreviewToggled = Signal(bool)

    def __init__(self, window: "MainWindow") -> None:
        super().__init__(window)
        self.window = window

    @Slot()
    def ready(self) -> None:
        self.window.on_web_ready()

    @Slot(str)
    def contentChanged(self, content: str) -> None:
        self.window.on_content_changed(content)

    @Slot(str)
    def modeChanged(self, mode: str) -> None:
        self.window.on_mode_changed(mode)

    @Slot(str)
    def exportBody(self, body: str) -> None:
        self.window.on_export_body(body)

    @Slot(str, result=str)
    def savePastedImage(self, data_b64: str) -> str:
        """貼り付け画像を保存し、文書からの相対パスを返す（失敗/中止時は空文字列）。"""
        return self.window.save_pasted_image(data_b64)

    @Slot(str)
    def handleLinkClick(self, href: str) -> None:
        """Preview/WYSIWYG内のリンククリックを振り分ける（spec.md 5.3）。"""
        self.window.handle_link_click(href)

    @Slot(str)
    def log(self, message: str) -> None:
        print(f"[web] {message}", file=sys.stderr)


class MainWindow(QMainWindow):
    def __init__(self, initial_path: Path | None = None) -> None:
        super().__init__()
        self.resize(1000, 750)

        self.current_path: Path | None = None
        self.current_content = WELCOME_MARKDOWN
        self.saved_content = WELCOME_MARKDOWN
        self.newline = "\n"
        self.initial_path = initial_path
        self.current_mode = "preview"

        # エクスポート処理の進行状態（(出力先Path, "html"|"pdf") / 作業用ビュー等）
        self._export_target: tuple[Path, str] | None = None
        self._export_view: QWebEngineView | None = None
        self._export_tmp: Path | None = None

        # ファイルツリー（spec.md 9.1）
        self.tree_root: Path | None = None
        self._tree_shown_pref = True

        # 外部での更新の検知（spec.md 9.2）
        # reload_state: None（通知なし） / "changed"（外部で変更） / "missing"（削除・リネーム）
        self.reload_state: str | None = None
        # ファイルが消えている間は、内容を失わないよう未保存として扱う（9.2.4）
        self._file_missing = False
        self.watcher = QFileSystemWatcher(self)
        self.watcher.fileChanged.connect(self._on_watched_change)
        self.watcher.directoryChanged.connect(self._on_watched_change)
        # 連続した書き込みを1回にまとめ、書き込み途中の内容を読まないための待ち
        self._watch_timer = QTimer(self)
        self._watch_timer.setSingleShot(True)
        self._watch_timer.setInterval(WATCH_DEBOUNCE_MS)
        self._watch_timer.timeout.connect(self._check_external_change)

        self.view = QWebEngineView(self)
        # JSコンソール出力をターミナルへ中継する（不具合調査用）
        self.view.setPage(AppWebPage(self.view))
        # 文書フォルダ基準の相対パス画像（file://）をfile://のページから
        # 読み込めるようにする（spec.md 5.2 相対パス画像の表示）
        self.view.page().settings().setAttribute(
            QWebEngineSettings.WebAttribute.LocalContentCanAccessFileUrls, True
        )

        central = QWidget(self)
        layout = QVBoxLayout(central)
        layout.setContentsMargins(0, 0, 0, 0)
        layout.setSpacing(0)
        self.search_bar = self._build_search_bar()
        # 素のQWidgetは既定で垂直方向もPreferred（伸縮可）のため、
        # QVBoxLayout内でQWebEngineViewと余剰スペースを取り合い、
        # 検索バーが不要に引き伸ばされてしまう。縦方向を固定して防ぐ。
        self.search_bar.setSizePolicy(
            QSizePolicy.Policy.Preferred, QSizePolicy.Policy.Fixed
        )
        self.search_bar.setVisible(False)
        layout.addWidget(self.search_bar)
        # 外部更新の通知バー（spec.md 9.2.2）。検索バーと同じ位置に置くことで
        # 3モードすべてで同じ見た目・挙動になり、モード切替の影響を受けない
        self.reload_bar = self._build_reload_bar()
        self.reload_bar.setSizePolicy(
            QSizePolicy.Policy.Preferred, QSizePolicy.Policy.Fixed
        )
        self.reload_bar.setVisible(False)
        layout.addWidget(self.reload_bar)
        layout.addWidget(self.view, 1)

        self.tree_view = self._build_tree_view()

        splitter = QSplitter(Qt.Orientation.Horizontal, self)
        splitter.addWidget(self.tree_view)
        splitter.addWidget(central)
        splitter.setStretchFactor(0, 0)
        splitter.setStretchFactor(1, 1)
        splitter.setSizes([220, 780])
        self.setCentralWidget(splitter)

        self.view.page().findTextFinished.connect(self._on_find_finished)

        self.bridge = Bridge(self)
        self.channel = QWebChannel(self)
        self.channel.registerObject("bridge", self.bridge)
        self.view.page().setWebChannel(self.channel)

        self._build_menu()
        self._update_title()

        self.view.load(QUrl.fromLocalFile(str(WEB_DIR / "index.html")))

    # ---- メニュー ----

    def _build_menu(self) -> None:
        file_menu = self.menuBar().addMenu("ファイル")

        new_action = QAction("新規", self)
        new_action.setShortcut(QKeySequence.StandardKey.New)
        new_action.triggered.connect(self.new_file)
        file_menu.addAction(new_action)

        open_action = QAction("開く...", self)
        open_action.setShortcut(QKeySequence.StandardKey.Open)
        open_action.triggered.connect(self.open_file)
        file_menu.addAction(open_action)

        open_folder_action = QAction("フォルダを開く...", self)
        open_folder_action.triggered.connect(self.open_folder)
        file_menu.addAction(open_folder_action)

        # 外部での更新の取り込み（spec.md 9.2.5）
        self.reload_action = QAction("再読み込み", self)
        self.reload_action.setShortcut(QKeySequence.StandardKey.Refresh)
        self.reload_action.triggered.connect(self.manual_reload)
        file_menu.addAction(self.reload_action)

        # Excel → Markdown 変換（spec.md 11章）
        self.import_excel_action = QAction("Excelから変換...", self)
        self.import_excel_action.triggered.connect(self.import_excel_dialog)
        file_menu.addAction(self.import_excel_action)

        file_menu.addSeparator()

        save_action = QAction("保存", self)
        save_action.setShortcut(QKeySequence.StandardKey.Save)
        save_action.triggered.connect(self.save)
        file_menu.addAction(save_action)

        save_as_action = QAction("名前を付けて保存...", self)
        save_as_action.setShortcut(QKeySequence.StandardKey.SaveAs)
        save_as_action.triggered.connect(self.save_as)
        file_menu.addAction(save_as_action)

        file_menu.addSeparator()

        export_html_action = QAction("HTMLとしてエクスポート...", self)
        export_html_action.triggered.connect(self.export_html_dialog)
        file_menu.addAction(export_html_action)

        export_pdf_action = QAction("PDFとしてエクスポート...", self)
        export_pdf_action.triggered.connect(self.export_pdf_dialog)
        file_menu.addAction(export_pdf_action)

        edit_menu = self.menuBar().addMenu("編集")

        self.search_action = QAction("検索...", self)
        self.search_action.setShortcut(QKeySequence.StandardKey.Find)
        self.search_action.triggered.connect(self.show_search)
        edit_menu.addAction(self.search_action)

        view_menu = self.menuBar().addMenu("表示")

        self.tree_toggle_action = QAction("ファイルツリー", self)
        self.tree_toggle_action.setCheckable(True)
        self.tree_toggle_action.setChecked(True)
        self.tree_toggle_action.setShortcut(QKeySequence("Ctrl+Shift+E"))
        self.tree_toggle_action.triggered.connect(self._on_tree_toggle)
        view_menu.addAction(self.tree_toggle_action)

        # Editモードの分割プレビュー（spec.md 4.1）。切替はJS側が担うため
        # チェック状態をそのままブリッジのシグナルへ流す。
        self.split_preview_action = QAction("プレビューを分割表示", self)
        self.split_preview_action.setCheckable(True)
        self.split_preview_action.setChecked(False)
        self.split_preview_action.setShortcut(QKeySequence("Ctrl+\\"))
        self.split_preview_action.setEnabled(False)  # Editモードでのみ有効
        self.split_preview_action.triggered.connect(self.bridge.splitPreviewToggled)
        view_menu.addAction(self.split_preview_action)

    # ---- 検索（Previewモード） ----

    def _build_search_bar(self) -> QWidget:
        bar = QWidget(self)
        bar.setAutoFillBackground(True)
        layout = QHBoxLayout(bar)
        layout.setContentsMargins(8, 4, 8, 4)
        layout.setSpacing(6)

        self.search_input = QLineEdit(bar)
        self.search_input.setPlaceholderText("検索")
        self.search_input.setClearButtonEnabled(True)
        self.search_input.textChanged.connect(self._on_search_text_changed)
        self.search_input.returnPressed.connect(self.find_next)
        self.search_input.installEventFilter(self)
        layout.addWidget(self.search_input, 1)

        self.search_count = QLabel("", bar)
        self.search_count.setMinimumWidth(48)
        self.search_count.setAlignment(Qt.AlignmentFlag.AlignCenter)
        layout.addWidget(self.search_count)

        prev_btn = QToolButton(bar)
        prev_btn.setText("↑")
        prev_btn.setToolTip("前のヒットへ (Shift+Enter)")
        prev_btn.clicked.connect(self.find_prev)
        layout.addWidget(prev_btn)

        next_btn = QToolButton(bar)
        next_btn.setText("↓")
        next_btn.setToolTip("次のヒットへ (Enter)")
        next_btn.clicked.connect(self.find_next)
        layout.addWidget(next_btn)

        close_btn = QToolButton(bar)
        close_btn.setText("✕")
        close_btn.setToolTip("検索を閉じる (Esc)")
        close_btn.clicked.connect(self.close_search)
        layout.addWidget(close_btn)

        return bar

    def eventFilter(self, obj: QObject, event: QEvent) -> bool:
        if obj is self.search_input and event.type() == QEvent.Type.KeyPress:
            if event.key() == Qt.Key.Key_Escape:
                self.close_search()
                return True
            if (
                event.key() in (Qt.Key.Key_Return, Qt.Key.Key_Enter)
                and event.modifiers() & Qt.KeyboardModifier.ShiftModifier
            ):
                self.find_prev()
                return True
        return super().eventFilter(obj, event)

    def show_search(self) -> None:
        if self.current_mode != "preview":
            return
        self.search_bar.setVisible(True)
        self.search_input.setFocus()
        self.search_input.selectAll()
        if self.search_input.text():
            self._find(self.search_input.text())

    def close_search(self) -> None:
        self.search_bar.setVisible(False)
        self.view.page().findText("")
        self.search_count.setText("")
        self.view.setFocus()

    def _find(self, text: str, backward: bool = False) -> None:
        flags = (
            QWebEnginePage.FindFlag.FindBackward
            if backward
            else QWebEnginePage.FindFlag(0)
        )
        self.view.page().findText(text, flags)
        if not text:
            self.search_count.setText("")

    def _on_search_text_changed(self, text: str) -> None:
        self._find(text)

    def find_next(self) -> None:
        self._find(self.search_input.text())

    def find_prev(self) -> None:
        self._find(self.search_input.text(), backward=True)

    def _on_find_finished(self, result) -> None:
        if not self.search_input.text():
            self.search_count.setText("")
            return
        total = result.numberOfMatches()
        active = result.activeMatch()
        self.search_count.setText(f"{active}/{total}" if total else "0件")

    def on_mode_changed(self, mode: str) -> None:
        self.current_mode = mode
        self.search_action.setEnabled(mode == "preview")
        # 分割プレビューはEditモード専用（spec.md 4.1）。チェック状態は
        # 保持したままにし、Editモードへ戻ったときに前回の状態を復元する。
        self.split_preview_action.setEnabled(mode == "edit")
        if mode != "preview" and self.search_bar.isVisible():
            self.close_search()

    # ---- ファイルツリー（spec.md 9.1） ----

    def _build_tree_view(self) -> QTreeView:
        self.fs_model = QFileSystemModel(self)
        self.fs_model.setNameFilters(["*.md", "*.markdown"])
        self.fs_model.setNameFilterDisables(False)  # フィルタ対象外のファイルは非表示にする

        tree = QTreeView(self)
        tree.setModel(self.fs_model)
        tree.setHeaderHidden(True)
        # ファイル名列以外（サイズ・種類・更新日時）は表示しない
        for col in range(1, self.fs_model.columnCount()):
            tree.setColumnHidden(col, True)
        tree.clicked.connect(self._on_tree_clicked)
        tree.setContextMenuPolicy(Qt.ContextMenuPolicy.CustomContextMenu)
        tree.customContextMenuRequested.connect(self._on_tree_context_menu)
        # ルート未確定の間は空表示にする（_update_tree_visibilityが可視性を制御）
        tree.setVisible(False)
        return tree

    def _update_tree_visibility(self) -> None:
        self.tree_view.setVisible(self._tree_shown_pref and self.tree_root is not None)

    def _on_tree_toggle(self, checked: bool) -> None:
        self._tree_shown_pref = checked
        self._update_tree_visibility()

    def _set_tree_root(self, folder: Path) -> None:
        folder = folder.expanduser().resolve()
        index = self.fs_model.setRootPath(str(folder))
        self.tree_view.setRootIndex(index)
        self.tree_root = folder
        self._update_tree_visibility()

    def _is_under_tree_root(self, path: Path) -> bool:
        if self.tree_root is None:
            return False
        try:
            path.relative_to(self.tree_root)
            return True
        except ValueError:
            return False

    def _maybe_update_tree_root(self, path: Path) -> None:
        if not self._is_under_tree_root(path):
            self._set_tree_root(path.parent)
        self._select_in_tree(path)

    def _select_in_tree(self, path: Path) -> None:
        index = self.fs_model.index(str(path))
        if index.isValid():
            self.tree_view.setCurrentIndex(index)
            self.tree_view.scrollTo(index)

    def open_folder(self) -> None:
        path_str = QFileDialog.getExistingDirectory(
            self,
            "フォルダを開く",
            str(self.tree_root or (self.current_path.parent if self.current_path else Path.home())),
        )
        if path_str:
            self._set_tree_root(Path(path_str))

    def _on_tree_clicked(self, index) -> None:
        if self.fs_model.isDir(index):
            return
        path = Path(self.fs_model.filePath(index)).resolve()
        if self.current_path is not None and path == self.current_path:
            return
        if not self._confirm_discard():
            # クリックでズレた選択状態を現在のファイルへ戻す
            if self.current_path is not None:
                self._select_in_tree(self.current_path)
            return
        self.load_path(path)

    def _on_tree_context_menu(self, pos) -> None:
        if self.tree_root is None:
            return
        index = self.tree_view.indexAt(pos)
        if index.isValid():
            entry = Path(self.fs_model.filePath(index))
            target_dir = entry if self.fs_model.isDir(index) else entry.parent
        else:
            target_dir = self.tree_root

        menu = QMenu(self)
        new_file_action = menu.addAction("新規Markdownファイル...")
        chosen = menu.exec(self.tree_view.viewport().mapToGlobal(pos))
        if chosen == new_file_action:
            self._create_new_markdown_file(target_dir)

    def _create_new_markdown_file(self, folder: Path) -> None:
        name, ok = QInputDialog.getText(self, "新規Markdownファイル", "ファイル名:", text="無題.md")
        if not ok or not name.strip():
            return
        name = name.strip()
        if not name.lower().endswith((".md", ".markdown")):
            name += ".md"
        target = folder / name
        if target.exists():
            QMessageBox.critical(self, "エラー", f"同名のファイルが既に存在します:\n{target}")
            return
        if not self._confirm_discard():
            return
        try:
            target.write_text("", encoding="utf-8")
        except OSError as e:
            QMessageBox.critical(self, "エラー", f"ファイルを作成できませんでした:\n{e}")
            return
        self.load_path(target)

    # ---- 外部での更新の検知と再読み込み（spec.md 9.2） ----

    def _build_reload_bar(self) -> QWidget:
        bar = QWidget(self)
        bar.setAutoFillBackground(True)
        layout = QHBoxLayout(bar)
        layout.setContentsMargins(8, 4, 8, 4)
        layout.setSpacing(6)

        self.reload_message = QLabel("", bar)
        layout.addWidget(self.reload_message, 1)

        self.reload_button = QToolButton(bar)
        self.reload_button.setText("再読み込み")
        self.reload_button.clicked.connect(self._on_reload_bar_clicked)
        layout.addWidget(self.reload_button)

        close_btn = QToolButton(bar)
        close_btn.setText("✕")
        close_btn.setToolTip("通知を閉じる")
        close_btn.clicked.connect(self._hide_reload_bar)
        layout.addWidget(close_btn)

        return bar

    def _hide_reload_bar(self) -> None:
        self.reload_state = None
        self.reload_bar.setVisible(False)

    def _show_reload_bar(self, state: str) -> None:
        self.reload_state = state
        if state == "missing":
            self.reload_message.setText(
                "このファイルが見つかりません（外部で削除・移動された可能性があります）。"
                "保存すると復活します。"
            )
            self.reload_button.setVisible(False)
        elif self.dirty:
            self.reload_message.setText(
                "このファイルは外部で変更されました。"
                "再読み込みすると編集中の内容は失われます。"
            )
            self.reload_button.setText("破棄して再読み込み")
            self.reload_button.setVisible(True)
        else:
            self.reload_message.setText("このファイルは外部で変更されました。")
            self.reload_button.setText("再読み込み")
            self.reload_button.setVisible(True)
        self.reload_bar.setVisible(True)

    def _watch_current_file(self) -> None:
        """監視対象を現在のファイルへ張り替える。

        ファイル本体だけでなく親フォルダも監視する。削除されるとファイルは
        監視対象から外れ、存在しないパスは登録できないため、再作成の検知は
        フォルダ側の通知に頼る必要がある。
        """
        for path in self.watcher.files() + self.watcher.directories():
            self.watcher.removePath(path)
        if self.current_path is None:
            return
        if self.current_path.exists():
            self.watcher.addPath(str(self.current_path))
        parent = self.current_path.parent
        if parent.is_dir():
            self.watcher.addPath(str(parent))

    def _on_watched_change(self, _path: str) -> None:
        # 連続する通知をまとめるため、都度タイマーを張り直す
        self._watch_timer.start()

    def _read_current_file(self) -> tuple[str, str] | None:
        """現在のファイルを読み、(内容, 改行コード) を返す。読めない場合はNone。"""
        if self.current_path is None:
            return None
        try:
            with self.current_path.open(encoding="utf-8", newline="") as f:
                raw = f.read()
        except (OSError, UnicodeDecodeError):
            return None
        return raw.replace("\r\n", "\n"), "\r\n" if "\r\n" in raw else "\n"

    def _check_external_change(self) -> None:
        """デバウンス後に、ディスク上の状態と比較して通知の要否を決める。"""
        if self.current_path is None:
            return

        if not self.current_path.exists():
            # 内容は保持したまま未保存扱いにする（spec.md 9.2.4）
            self._file_missing = True
            self._update_title()
            self._show_reload_bar("missing")
            return

        # 削除中に外れた監視を張り直す（再作成された場合を含む）
        if str(self.current_path) not in self.watcher.files():
            self.watcher.addPath(str(self.current_path))

        read = self._read_current_file()
        if read is None:
            # 一時的に読めない（書き込み中など）場合は次の通知を待つ
            return
        content, _newline = read

        if self._file_missing:
            # 消えていたファイルが戻ってきた
            self._file_missing = False
            self._update_title()

        if content == self.saved_content:
            # アプリ自身の保存や、内容を変えない更新は通知しない（spec.md 9.2.1）
            self._hide_reload_bar()
            return
        self._show_reload_bar("changed")

    def _on_reload_bar_clicked(self) -> None:
        # 未保存の内容を捨てることになるため、この経路だけ確認を挟む
        if self.dirty:
            answer = QMessageBox.warning(
                self,
                "再読み込みの確認",
                "編集中の内容を破棄して、ディスク上の内容を読み込みますか？",
                QMessageBox.StandardButton.Ok | QMessageBox.StandardButton.Cancel,
                QMessageBox.StandardButton.Cancel,
            )
            if answer != QMessageBox.StandardButton.Ok:
                return
        self.reload_file()

    def manual_reload(self) -> None:
        """ファイルメニュー「再読み込み」（F5）。検知の有無に関わらず読み直す。"""
        if self.current_path is None:
            return
        if not self.current_path.exists():
            QMessageBox.critical(
                self, "エラー", f"ファイルが見つかりません:\n{self.current_path}"
            )
            return
        if not self._confirm_discard():
            return
        self.reload_file()

    def reload_file(self) -> bool:
        """ディスク上の内容を、表示位置を維持したまま取り込む（spec.md 9.2.3）。"""
        read = self._read_current_file()
        if read is None:
            QMessageBox.critical(
                self, "エラー", f"ファイルを読み込めませんでした:\n{self.current_path}"
            )
            return False
        content, newline = read
        # 外部ツールが改行コードを変えている場合があるため再検出する
        self.newline = newline
        self.current_content = content
        self.saved_content = content
        self._file_missing = False
        self._hide_reload_bar()
        self.bridge.fileReloaded.emit(str(self.current_path), content)
        self._update_title()
        self.statusBar().showMessage("ファイルを再読み込みしました", 3000)
        return True

    # ---- Excelの取り込み（spec.md 11章） ----

    def import_excel_dialog(self) -> None:
        base = self.tree_root or (
            self.current_path.parent if self.current_path else Path.home()
        )
        path_str, _ = QFileDialog.getOpenFileName(
            self,
            "Excelファイルを選択",
            str(base),
            "Excel (*.xlsx *.xlsm);;すべてのファイル (*)",
        )
        if path_str:
            self.import_excel(Path(path_str))

    def import_excel(self, xlsx_path: Path) -> None:
        """Excelをシート単位のMarkdownへ変換し、出力先を開く（spec.md 11章）。"""
        # openpyxlは起動時には不要なため、ここで初めて読み込む
        try:
            from . import excel_import
        except ImportError as e:
            QMessageBox.critical(
                self, "エラー", f"Excelの読み込みに必要なライブラリがありません:\n{e}"
            )
            return

        xlsx_path = xlsx_path.expanduser().resolve()
        if xlsx_path.suffix.lower() not in excel_import.SUPPORTED_SUFFIXES:
            QMessageBox.critical(
                self,
                "非対応の形式",
                f"「{xlsx_path.name}」は変換できません。\n"
                "対応しているのは .xlsx / .xlsm のみです。",
            )
            return

        # 出力先はExcelと同一ディレクトリの「拡張子を除いたファイル名」フォルダ
        out_dir = xlsx_path.parent / xlsx_path.stem
        if out_dir.exists() and not out_dir.is_dir():
            QMessageBox.critical(
                self, "エラー", f"出力先と同名のファイルが既に存在します:\n{out_dir}"
            )
            return
        if out_dir.is_dir():
            answer = QMessageBox.question(
                self,
                "出力先の確認",
                f"フォルダが既に存在します。同名のMarkdownファイルを上書きしますか？\n\n{out_dir}",
                QMessageBox.StandardButton.Ok | QMessageBox.StandardButton.Cancel,
                QMessageBox.StandardButton.Cancel,
            )
            if answer != QMessageBox.StandardButton.Ok:
                return

        def on_progress(index: int, total: int, name: str) -> None:
            self.statusBar().showMessage(f"Excelを変換中... {index} / {total} シート（{name}）")
            # 変換中もステータスバーを更新する。ユーザー入力は処理しない
            # （変換の最中に別のファイル操作へ入られると状態が壊れるため）
            QApplication.processEvents(
                QEventLoop.ProcessEventsFlag.ExcludeUserInputEvents
            )

        QApplication.setOverrideCursor(Qt.CursorShape.WaitCursor)
        try:
            result = excel_import.convert_workbook(
                xlsx_path, out_dir, progress=on_progress
            )
        except Exception as e:
            QMessageBox.critical(
                self,
                "変換失敗",
                f"Excelファイルを読み込めませんでした:\n{type(e).__name__}: {e}",
            )
            return
        finally:
            QApplication.restoreOverrideCursor()
            self.statusBar().clearMessage()

        self._report_excel_result(xlsx_path, result)

    def _report_excel_result(self, xlsx_path: Path, result) -> None:
        """変換結果をまとめて報告し、出力先を開く（spec.md 11.7）。"""
        written = result.written
        lines = [
            f"変換元: {xlsx_path.name}",
            f"出力先: {result.out_dir}",
            "",
            f"成功 {len(written)}件 / 失敗 {len(result.failed)}件",
        ]
        empty = [s.sheet_name for s in result.sheets if s.skipped == "empty"]
        if empty:
            lines.append("内容が無いため出力しなかったシート: " + "、".join(empty))
        if result.missing_formula_sheets:
            lines.append(
                "計算値を取得できなかったセルがあるシート: "
                + "、".join(result.missing_formula_sheets)
            )
        if result.failed:
            lines.append("")
            lines.append("失敗したシート:")
            lines += [f"　・{s.sheet_name}: {s.error}" for s in result.failed]
        message = "\n".join(lines)

        if not written:
            QMessageBox.warning(
                self, "Excelの変換", message + "\n\n出力されたファイルはありません。"
            )
            return

        # 生成したフォルダをツリーのルートにしてから先頭シートのmdを開く。
        # 未保存の変更でキャンセルされた場合もツリーの表示は更新済みにする。
        self._set_tree_root(result.out_dir)
        if result.failed:
            QMessageBox.warning(self, "Excelの変換", message)
        else:
            QMessageBox.information(self, "Excelの変換", message)
        if self._confirm_discard():
            self.load_path(written[0])
        self.statusBar().showMessage(f"Excelを変換しました: {result.out_dir}", 5000)

    # ---- 状態管理 ----

    @property
    def dirty(self) -> bool:
        # ファイルが外部で削除された場合も、内容を失わないよう未保存とみなす
        # （保存すれば復活できる。spec.md 9.2.4）
        return self._file_missing or self.current_content != self.saved_content

    def _update_title(self) -> None:
        name = self.current_path.name if self.current_path else "無題"
        mark = "*" if self.dirty else ""
        self.setWindowTitle(f"{mark}{name} - Markdown Editor")
        # 再読み込みは保存済みファイルにしか意味がない（spec.md 9.2.5）
        self.reload_action.setEnabled(self.current_path is not None)

    def on_content_changed(self, content: str) -> None:
        self.current_content = content
        self._update_title()

    def on_web_ready(self) -> None:
        """JS側の初期化完了後に初期文書を送る。"""
        if self.initial_path is not None:
            self.load_path(self.initial_path)
            self.initial_path = None
        else:
            self.bridge.fileOpened.emit("", WELCOME_MARKDOWN)

    def _confirm_discard(self) -> bool:
        """未保存の変更がある場合に確認し、続行してよければTrueを返す。"""
        if not self.dirty:
            return True
        result = QMessageBox.warning(
            self,
            "未保存の変更",
            "保存されていない変更があります。保存しますか？",
            QMessageBox.StandardButton.Save
            | QMessageBox.StandardButton.Discard
            | QMessageBox.StandardButton.Cancel,
            QMessageBox.StandardButton.Save,
        )
        if result == QMessageBox.StandardButton.Save:
            return self.save()
        return result == QMessageBox.StandardButton.Discard

    # ---- ファイル操作 ----

    def new_file(self) -> None:
        if not self._confirm_discard():
            return
        if self.search_bar.isVisible():
            self.close_search()
        self.current_path = None
        self.current_content = ""
        self.saved_content = ""
        self.newline = "\n"
        self._file_missing = False
        self._hide_reload_bar()
        self._watch_current_file()
        self.tree_view.setCurrentIndex(QModelIndex())
        self.bridge.fileOpened.emit("", "")
        self._update_title()

    def open_file(self) -> None:
        if not self._confirm_discard():
            return
        path_str, _ = QFileDialog.getOpenFileName(
            self,
            "Markdownファイルを開く",
            str(self.current_path.parent if self.current_path else Path.home()),
            "Markdown (*.md *.markdown);;すべてのファイル (*)",
        )
        if not path_str:
            return
        self.load_path(Path(path_str))

    def load_path(self, path: Path) -> None:
        # CLI引数などで相対パスが渡された場合も、JS側の相対パス画像の解決や
        # 保存先の決定が正しく動くよう絶対パスに正規化する
        path = path.expanduser().resolve()
        try:
            # newline="" で改行変換を無効化し、元の改行コードを検出できるようにする
            with path.open(encoding="utf-8", newline="") as f:
                raw = f.read()
        except (OSError, UnicodeDecodeError) as e:
            QMessageBox.critical(self, "エラー", f"ファイルを開けませんでした:\n{e}")
            return
        if self.search_bar.isVisible():
            self.close_search()
        # 改行コードを検出して記憶し、内部ではLFに正規化する
        self.newline = "\r\n" if "\r\n" in raw else "\n"
        content = raw.replace("\r\n", "\n")
        self.current_path = path
        self.current_content = content
        self.saved_content = content
        # 前のファイルの通知が残らないようにしてから監視を張り替える（spec.md 9.2）
        self._file_missing = False
        self._hide_reload_bar()
        self._watch_current_file()
        self._maybe_update_tree_root(path)
        self.bridge.fileOpened.emit(str(path), content)
        self._update_title()

    def save(self) -> bool:
        if self.current_path is None:
            return self.save_as()
        return self._write_to(self.current_path)

    def save_as(self) -> bool:
        default = (
            str(self.current_path)
            if self.current_path
            else str(Path.home() / "無題.md")
        )
        path_str, _ = QFileDialog.getSaveFileName(
            self,
            "名前を付けて保存",
            default,
            "Markdown (*.md *.markdown);;すべてのファイル (*)",
        )
        if not path_str:
            return False
        return self._write_to(Path(path_str))

    def _write_to(self, path: Path) -> bool:
        path = path.expanduser().resolve()
        data = self.current_content
        if self.newline != "\n":
            data = data.replace("\n", self.newline)
        try:
            path.write_text(data, encoding="utf-8", newline="")
        except OSError as e:
            QMessageBox.critical(self, "エラー", f"保存に失敗しました:\n{e}")
            return False
        path_changed = self.current_path != path
        self.current_path = path
        self.saved_content = self.current_content
        # 保存でディスクとの差が解消されるため通知を閉じる（spec.md 9.2.1）。
        # 監視も張り替える（別名保存でパスが変わる／削除後の復活に対応する）
        self._file_missing = False
        self._hide_reload_bar()
        self._watch_current_file()
        self._update_title()
        if path_changed:
            self._maybe_update_tree_root(path)
            # 相対パス画像の解決基準が変わるためJSへ通知する
            self.bridge.pathChanged.emit(str(path))
        else:
            self._select_in_tree(path)
        return True

    # ---- クリップボード画像の貼り付け（spec.md 5.2） ----

    def save_pasted_image(self, data_b64: str) -> str:
        """Base64の画像データを文書と同階層のimage/へPNGで保存する。

        未保存の新規文書の場合は先に「名前を付けて保存」ダイアログを開き、
        キャンセルされたら貼り付け全体を中止する（空文字列を返す）。
        """
        if self.current_path is None:
            if not self.save_as():
                return ""
        try:
            raw = base64.b64decode(data_b64)
        except (ValueError, TypeError):
            return ""
        image = QImage()
        if not image.loadFromData(raw):
            return ""

        img_dir = self.current_path.parent / "image"
        try:
            img_dir.mkdir(parents=True, exist_ok=True)
        except OSError as e:
            QMessageBox.critical(self, "エラー", f"imageフォルダを作成できませんでした:\n{e}")
            return ""

        # タイムスタンプ名。同名衝突時は連番を付加する
        stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
        name = f"image-{stamp}.png"
        counter = 2
        while (img_dir / name).exists():
            name = f"image-{stamp}-{counter}.png"
            counter += 1

        # 形式によらずPNGに変換して保存する（spec: PNG固定）
        if not image.save(str(img_dir / name), "PNG"):
            QMessageBox.critical(self, "エラー", "画像の保存に失敗しました")
            return ""
        return f"image/{name}"

    # ---- リンクのクリック挙動（spec.md 5.3） ----

    def handle_link_click(self, href: str) -> None:
        """Preview/WYSIWYG内のリンククリックを振り分ける。

        相対/絶対パスの .md / .markdown は現在の文書フォルダを基準に解決して
        アプリ内で開き、それ以外（外部URL・その他のファイル）はOS既定の
        ブラウザ/アプリケーションへ委譲する。文書内アンカー（#のみ）はJS側で
        除外されるため、ここには渡ってこない。
        """
        url = QUrl(href)
        scheme = url.scheme().lower()
        if scheme and scheme != "file":
            # http / https / mailto 等の外部リンク
            QDesktopServices.openUrl(url)
            return

        raw_path = url.toLocalFile() if url.isLocalFile() else url.path()
        candidate = Path(raw_path)
        if not candidate.is_absolute():
            base = self.current_path.parent if self.current_path else Path.cwd()
            candidate = base / candidate
        try:
            target = candidate.resolve()
        except OSError:
            target = candidate

        if target.suffix.lower() in (".md", ".markdown"):
            if not self._confirm_discard():
                return
            self.load_path(target)
        else:
            QDesktopServices.openUrl(QUrl.fromLocalFile(str(target)))

    # ---- エクスポート（HTML/PDF: spec.md 7章） ----

    _EXPORT_ERROR_PREFIX = "\x00ERROR\x00"

    def _export_default_path(self, suffix: str) -> str:
        if self.current_path:
            return str(self.current_path.with_suffix(suffix))
        return str(Path.home() / f"無題{suffix}")

    def export_html_dialog(self) -> None:
        path_str, _ = QFileDialog.getSaveFileName(
            self,
            "HTMLとしてエクスポート",
            self._export_default_path(".html"),
            "HTML (*.html *.htm)",
        )
        if path_str:
            self._start_export(Path(path_str), "html")

    def export_pdf_dialog(self) -> None:
        path_str, _ = QFileDialog.getSaveFileName(
            self,
            "PDFとしてエクスポート",
            self._export_default_path(".pdf"),
            "PDF (*.pdf)",
        )
        if path_str:
            self._start_export(Path(path_str), "pdf")

    def _start_export(self, path: Path, kind: str) -> None:
        """JS側にレンダリング済み本文HTMLを要求する。結果はon_export_bodyへ届く。"""
        self._export_target = (path, kind)
        self.view.page().runJavaScript(
            "window.exportHtml()"
            ".then(b => bridge.exportBody(b))"
            ".catch(e => bridge.exportBody('\\u0000ERROR\\u0000' + (e && e.message || e)))"
        )

    def on_export_body(self, body: str) -> None:
        if self._export_target is None:
            return
        path, kind = self._export_target
        self._export_target = None
        if body.startswith(self._EXPORT_ERROR_PREFIX):
            QMessageBox.critical(
                self,
                "エクスポート失敗",
                f"レンダリングに失敗しました:\n{body[len(self._EXPORT_ERROR_PREFIX):]}",
            )
            return
        html = self._build_export_html(body)
        if kind == "html":
            try:
                path.write_text(html, encoding="utf-8")
            except OSError as e:
                QMessageBox.critical(self, "エクスポート失敗", f"書き込みに失敗しました:\n{e}")
                return
            self.statusBar().showMessage(f"HTMLをエクスポートしました: {path}", 5000)
        else:
            self._print_pdf(html, path)

    def _build_export_html(self, body: str) -> str:
        """本文HTMLをCSS埋め込みの自己完結な単一HTMLに組み立てる。"""
        styles = (WEB_DIR / "styles.css").read_text(encoding="utf-8")
        hl_light = (WEB_DIR / "vendor" / "highlight-github.min.css").read_text(
            encoding="utf-8"
        )
        hl_dark = (WEB_DIR / "vendor" / "highlight-github-dark.min.css").read_text(
            encoding="utf-8"
        )
        title = html_module.escape(
            self.current_path.stem if self.current_path else "無題"
        )
        return f"""<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{title}</title>
<style>{styles}</style>
<style media="(prefers-color-scheme: light)">{hl_light}</style>
<style media="(prefers-color-scheme: dark)">{hl_dark}</style>
<style>
/* エクスポート用: アプリのペインレイアウトに依存しない単体表示 */
body {{ margin: 0; }}
.markdown-body {{ max-width: 860px; margin: 0 auto; padding: 32px 24px; }}
</style>
</head>
<body>
<article class="markdown-body">
{body}
</article>
</body>
</html>
"""

    def _print_pdf(self, html: str, path: Path) -> None:
        """エクスポート用HTMLを非表示ページに読み込み、printToPdfでPDF化する。"""
        tmp = tempfile.NamedTemporaryFile(
            "w", suffix=".html", delete=False, encoding="utf-8"
        )
        tmp.write(html)
        tmp.close()
        self._export_tmp = Path(tmp.name)

        # 表示中のビューに影響を与えないよう専用のビューを使う（参照保持が必要）
        self._export_view = QWebEngineView()
        page = self._export_view.page()
        page.pdfPrintingFinished.connect(self._on_pdf_done)

        def on_loaded(ok: bool) -> None:
            if not ok:
                self._cleanup_pdf_export()
                QMessageBox.critical(
                    self, "エクスポート失敗", "PDF用ページの読み込みに失敗しました"
                )
                return
            # フォント読み込み等の描画安定を少し待ってから印刷する
            QTimer.singleShot(300, lambda: page.printToPdf(str(path)))

        page.loadFinished.connect(on_loaded)
        self._export_view.load(QUrl.fromLocalFile(str(self._export_tmp)))

    def _on_pdf_done(self, file_path: str, ok: bool) -> None:
        self._cleanup_pdf_export()
        if ok:
            self.statusBar().showMessage(f"PDFをエクスポートしました: {file_path}", 5000)
        else:
            QMessageBox.critical(self, "エクスポート失敗", "PDFの書き出しに失敗しました")

    def _cleanup_pdf_export(self) -> None:
        if self._export_tmp is not None:
            try:
                self._export_tmp.unlink()
            except OSError:
                pass
            self._export_tmp = None
        if self._export_view is not None:
            self._export_view.deleteLater()
            self._export_view = None

    # ---- 終了処理 ----

    def closeEvent(self, event: QCloseEvent) -> None:
        if self._confirm_discard():
            event.accept()
        else:
            event.ignore()


def main() -> int:
    app = QApplication(sys.argv)
    app.setApplicationName("Markdown Editor")

    args = [a for a in sys.argv[1:] if not a.startswith("-")]
    initial_path = Path(args[0]) if args else None

    window = MainWindow(initial_path)
    window.show()

    # 動作確認用: --smoke-test でページ読み込み後に自動終了する
    if "--smoke-test" in sys.argv:
        window.view.loadFinished.connect(lambda ok: app.exit(0 if ok else 1))

    return app.exec()


if __name__ == "__main__":
    sys.exit(main())
