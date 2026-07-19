"""保存ロジック（CRLF維持・dirty管理）のオフスクリーン検証。

実行: QT_QPA_PLATFORM=offscreen .venv/bin/python tests/test_save_logic.py
"""
import sys
import tempfile
from pathlib import Path

from PySide6.QtWidgets import QApplication
from markdown_editor.main import MainWindow

app = QApplication(sys.argv)
w = MainWindow()

tmp = Path(tempfile.mkdtemp())

# 1. CRLFファイルを開く → 内部はLFに正規化される
crlf_file = tmp / "crlf.md"
crlf_file.write_bytes(b"# Title\r\n\r\nline1\r\nline2\r\n")
w.load_path(crlf_file)
assert w.newline == "\r\n", f"newline detect failed: {w.newline!r}"
assert "\r" not in w.current_content, "content not normalized to LF"
assert not w.dirty, "freshly opened file must not be dirty"

# 2. 編集をシミュレート → dirtyになりタイトルに*が付く
w.on_content_changed(w.current_content + "added\n")
assert w.dirty, "edit must set dirty"
assert w.windowTitle().startswith("*"), f"title missing *: {w.windowTitle()}"

# 3. 保存 → CRLFのまま書き出され、dirty解除
assert w._write_to(crlf_file), "save failed"
assert not w.dirty, "save must clear dirty"
raw = crlf_file.read_bytes()
assert b"added\r\n" in raw, f"CRLF not preserved: {raw!r}"
assert b"\n" not in raw.replace(b"\r\n", b""), "mixed newlines in output"

# 4. LFファイルはLFのまま
lf_file = tmp / "lf.md"
lf_file.write_bytes(b"# LF\nline\n")
w.load_path(lf_file)
assert w.newline == "\n"
w.on_content_changed(w.current_content + "x\n")
w._write_to(lf_file)
assert b"\r" not in lf_file.read_bytes(), "LF file gained CR"

# 5. 新規作成相当の状態リセット（ダイアログを避けて直接検証）
assert not w.dirty
w.new_file()
assert w.current_path is None
assert w.current_content == ""
assert w.windowTitle() == "無題 - Markdown Editor", w.windowTitle()

print("ALL SAVE LOGIC TESTS PASSED")
