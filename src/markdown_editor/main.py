"""Markdownエディタ アプリシェル。

PySide6 + QWebEngineView 上で web/ 以下のHTML/JSアプリを動かす。
ファイルI/OやネイティブメニューはPython側が担当し、
QWebChannel経由でJS側とやり取りする。

文書内容はJS側が編集のたびに contentChanged で送ってくるため、
Python側は常に最新の内容を保持しており、保存・終了確認を同期的に行える。
改行コードはファイルごとに検出して保持し、内部処理はLFに正規化する。
"""

import sys
from pathlib import Path

from PySide6.QtCore import QEvent, QObject, Qt, QUrl, Signal, Slot
from PySide6.QtGui import QAction, QCloseEvent, QKeySequence
from PySide6.QtWebChannel import QWebChannel
from PySide6.QtWebEngineCore import QWebEnginePage
from PySide6.QtWebEngineWidgets import QWebEngineView
from PySide6.QtWidgets import (
    QApplication,
    QFileDialog,
    QHBoxLayout,
    QLabel,
    QLineEdit,
    QMainWindow,
    QMessageBox,
    QSizePolicy,
    QToolButton,
    QVBoxLayout,
    QWidget,
)

WEB_DIR = Path(__file__).resolve().parent / "web"

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


class Bridge(QObject):
    """Python⇔JS間のブリッジ。JS側では `bridge` という名前で参照される。"""

    # 文書の差し替えをJSへ通知する (パス, 内容)。新規作成時はパスは空文字列
    fileOpened = Signal(str, str)

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

        self.view = QWebEngineView(self)

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
        layout.addWidget(self.view, 1)
        self.setCentralWidget(central)

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

        file_menu.addSeparator()

        save_action = QAction("保存", self)
        save_action.setShortcut(QKeySequence.StandardKey.Save)
        save_action.triggered.connect(self.save)
        file_menu.addAction(save_action)

        save_as_action = QAction("名前を付けて保存...", self)
        save_as_action.setShortcut(QKeySequence.StandardKey.SaveAs)
        save_as_action.triggered.connect(self.save_as)
        file_menu.addAction(save_as_action)

        edit_menu = self.menuBar().addMenu("編集")

        self.search_action = QAction("検索...", self)
        self.search_action.setShortcut(QKeySequence.StandardKey.Find)
        self.search_action.triggered.connect(self.show_search)
        edit_menu.addAction(self.search_action)

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
        if mode != "preview" and self.search_bar.isVisible():
            self.close_search()

    # ---- 状態管理 ----

    @property
    def dirty(self) -> bool:
        return self.current_content != self.saved_content

    def _update_title(self) -> None:
        name = self.current_path.name if self.current_path else "無題"
        mark = "*" if self.dirty else ""
        self.setWindowTitle(f"{mark}{name} - Markdown Editor")

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
        data = self.current_content
        if self.newline != "\n":
            data = data.replace("\n", self.newline)
        try:
            path.write_text(data, encoding="utf-8", newline="")
        except OSError as e:
            QMessageBox.critical(self, "エラー", f"保存に失敗しました:\n{e}")
            return False
        self.current_path = path
        self.saved_content = self.current_content
        self._update_title()
        return True

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
