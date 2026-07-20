"""ファイルツリー（spec.md 9.1）のオフスクリーン検証。

- ルート未確定時は非表示、ファイルを開くと親フォルダが自動的にルートになる
- ルート配下の別ファイルを開いても不要にルートを切り替えない
- ルート外のファイルを開くとルートが切り替わる
- 「フォルダを開く...」相当のAPIで任意フォルダを明示的にルートにできる
- ツリーからのクリックでファイルを開く（isDir/同一ファイルの早期return含む）
- 新規Markdownファイル作成（同名衝突の拒否を含む）
- 表示/非表示トグル

実行: QT_QPA_PLATFORM=offscreen .venv/bin/python tests/test_file_tree.py
"""
import sys
import tempfile
from pathlib import Path

from PySide6.QtCore import QEventLoop, QTimer
from PySide6.QtWidgets import QApplication, QMessageBox
from markdown_editor.main import MainWindow

app = QApplication(sys.argv)

tmpdir = Path(tempfile.mkdtemp(prefix="md_tree_test_"))
sub = tmpdir / "sub"
sub.mkdir()
doc_a = tmpdir / "a.md"
doc_b = sub / "b.md"
doc_a.write_text("# A\n", encoding="utf-8")
doc_b.write_text("# B\n", encoding="utf-8")
other_dir = Path(tempfile.mkdtemp(prefix="md_tree_other_"))
doc_c = other_dir / "c.md"
doc_c.write_text("# C\n", encoding="utf-8")


def wait_until(predicate, timeout_ms=8000, interval_ms=50):
    loop = QEventLoop()
    elapsed = 0

    def tick():
        nonlocal elapsed
        if predicate() or elapsed >= timeout_ms:
            loop.quit()
            return
        elapsed += interval_ms
        QTimer.singleShot(interval_ms, tick)

    QTimer.singleShot(0, tick)
    loop.exec()
    return predicate()


w = MainWindow()
w.show()

# ---- 1. 初期状態: ルート未確定で非表示 ----
assert w.tree_root is None
assert not w.tree_view.isVisible()
print("INITIAL HIDDEN OK")

# ---- 2. ファイルを開く: 親フォルダが自動的にルートになり表示される ----
w.load_path(doc_a)
assert w.tree_root == tmpdir.resolve(), w.tree_root
assert w.tree_view.isVisible()
selected = Path(w.fs_model.filePath(w.tree_view.currentIndex()))
assert selected == doc_a.resolve(), selected
print("AUTO ROOT ON OPEN OK")

# ---- 3. ルート配下の別ファイル（サブフォルダ）: ルートは維持、選択のみ更新 ----
w.load_path(doc_b)
assert w.tree_root == tmpdir.resolve(), "root must stay the same for a file under it"
selected = Path(w.fs_model.filePath(w.tree_view.currentIndex()))
assert selected == doc_b.resolve()
print("ROOT KEPT FOR FILE UNDER ROOT OK")

# ---- 4. ルート外のファイル: ルートが切り替わる ----
w.load_path(doc_c)
assert w.tree_root == other_dir.resolve(), w.tree_root
print("ROOT SWITCHES FOR FILE OUTSIDE ROOT OK")

# ---- 5. フォルダを開く相当（_set_tree_root）で任意フォルダを明示指定 ----
w._set_tree_root(tmpdir)
assert w.tree_root == tmpdir.resolve()
assert w.tree_view.isVisible()
print("EXPLICIT SET ROOT OK")

# ---- 6. ツリークリックでファイルを開く ----
w.load_path(doc_a)  # a.md を選択中の状態に戻す
idx_b = w.fs_model.index(str(doc_b.resolve()))
assert idx_b.isValid()
w._on_tree_clicked(idx_b)
assert w.current_path == doc_b.resolve(), w.current_path
print("TREE CLICK OPENS FILE OK")

# ディレクトリのクリックは何もしない（isDirで早期return）
idx_sub = w.fs_model.index(str(sub.resolve()))
assert idx_sub.isValid() and w.fs_model.isDir(idx_sub)
before = w.current_path
w._on_tree_clicked(idx_sub)
assert w.current_path == before, "clicking a directory must not change current_path"
print("TREE CLICK ON DIR IS NOOP OK")

# 同一ファイルの再クリックは早期return（例外が出ないことを確認）
w._on_tree_clicked(idx_b)
assert w.current_path == before
print("TREE CLICK ON SAME FILE IS NOOP OK")

# ---- 7. 未保存の変更がある場合、確認ダイアログでキャンセルすると開かない ----
w.on_content_changed(w.current_content + "\nedited")
assert w.dirty

_orig_warning = QMessageBox.warning
QMessageBox.warning = staticmethod(lambda *a, **k: QMessageBox.StandardButton.Cancel)
try:
    idx_a = w.fs_model.index(str(doc_a.resolve()))
    before_path = w.current_path
    w._on_tree_clicked(idx_a)
    assert w.current_path == before_path, "cancel must keep the current file open"
finally:
    QMessageBox.warning = _orig_warning
print("DISCARD CANCEL BLOCKS TREE OPEN OK")

# 変更を破棄して次のテストへ進む
w.current_content = w.saved_content

# ---- 8. 新規Markdownファイル作成 ----
# QInputDialog.getText はモーダルダイアログでオフスクリーンでは応答が
# 得られずブロックするため、必ずモックしてから呼び出す
from PySide6.QtWidgets import QInputDialog

_orig_gettext = QInputDialog.getText
QInputDialog.getText = staticmethod(lambda *a, **k: ("新規ノート.md", True))
try:
    w._create_new_markdown_file(tmpdir)
finally:
    QInputDialog.getText = _orig_gettext

new_file = tmpdir / "新規ノート.md"
assert new_file.exists(), "new markdown file must be created"
assert w.current_path == new_file.resolve(), "new file must be opened"
print("CREATE NEW MARKDOWN FILE OK")

# 同名ファイルが既にある場合はエラーを表示し作成しない
QInputDialog.getText = staticmethod(lambda *a, **k: ("新規ノート.md", True))
_orig_critical = QMessageBox.critical
critical_calls = []
QMessageBox.critical = staticmethod(
    lambda *a, **k: critical_calls.append(a) or QMessageBox.StandardButton.Ok
)
try:
    before_mtime = new_file.stat().st_mtime
    w._create_new_markdown_file(tmpdir)
finally:
    QInputDialog.getText = _orig_gettext
    QMessageBox.critical = _orig_critical
assert len(critical_calls) == 1, "duplicate name must show an error dialog"
assert new_file.stat().st_mtime == before_mtime, "existing file must not be overwritten"
print("DUPLICATE NAME REJECTED OK")

# ---- 9. 表示/非表示トグル ----
w._on_tree_toggle(False)
assert not w.tree_view.isVisible()
w._on_tree_toggle(True)
assert w.tree_view.isVisible()
print("TOGGLE VISIBILITY OK")

print("ALL FILE TREE TESTS PASSED")
