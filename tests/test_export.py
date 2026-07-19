"""HTML/PDFエクスポート機能のオフスクリーン検証。

ウェルカム文書（Mermaid図・コードブロック・テーブルを含む）を
HTMLとPDFへエクスポートし、出力ファイルの内容を確認する。

ページ読み込み・QWebChannel接続の完了はPython側から直接観測できないため、
検索テストと同様に、実際のエクスポート操作自体を成功するまでリトライする。

実行: QT_QPA_PLATFORM=offscreen .venv/bin/python tests/test_export.py
"""
import sys
import tempfile
from pathlib import Path

from PySide6.QtCore import QEventLoop, QTimer
from PySide6.QtWidgets import QApplication
from markdown_editor.main import MainWindow

app = QApplication(sys.argv)
w = MainWindow()
w.show()

tmpdir = Path(tempfile.mkdtemp(prefix="md_export_test_"))
html_path = tmpdir / "out.html"
pdf_path = tmpdir / "out.pdf"


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


def export_and_wait(path, kind, done, timeout_ms=30000, retry_interval_ms=1000):
    """エクスポートを開始し、完了するまで操作自体をリトライしながら待つ。"""
    elapsed = 0
    while elapsed <= timeout_ms:
        w._start_export(path, kind)
        if wait_until(done, timeout_ms=retry_interval_ms):
            return True
        elapsed += retry_interval_ms
    return done()


# 1. HTMLエクスポート
ok = export_and_wait(html_path, "html", lambda: html_path.exists())
assert ok, "HTML export did not produce a file"
html = html_path.read_text(encoding="utf-8")
assert "<!DOCTYPE html>" in html, "exported HTML must be a full document"
assert 'class="markdown-body"' in html, "markdown-body wrapper missing"
assert "<svg" in html, "mermaid diagram must be exported as rendered SVG"
assert "hljs" in html, "code highlight markup missing"
assert "<style>" in html, "CSS must be inlined"
assert "<table>" in html, "table content missing"
print("HTML EXPORT OK")

# 2. PDFエクスポート（printToPdf完了まで待つ）
ok = export_and_wait(
    pdf_path,
    "pdf",
    lambda: pdf_path.exists() and pdf_path.stat().st_size > 1000,
    timeout_ms=60000,
    retry_interval_ms=5000,
)
assert ok, "PDF export did not produce a file"
with pdf_path.open("rb") as f:
    head = f.read(5)
assert head == b"%PDF-", f"not a PDF file: {head!r}"
print("PDF EXPORT OK")

print("ALL EXPORT TESTS PASSED")
