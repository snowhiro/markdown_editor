"""リンクのクリック挙動（spec.md 5.3）のオフスクリーン検証。

1. handle_link_click（Python側の振り分けロジック）
   - 外部リンク → QDesktopServices.openUrl
   - 相対パスの.mdリンク → アプリ内で開く（load_path）。未保存確認を経由する
   - その他の相対パスファイル → QDesktopServices.openUrl（ローカルパス）
2. JS側のクリックハンドラ
   - Previewは単純クリックで発動、WYSIWYGはCmd/Ctrl+クリックのみ発動
   - 文書内アンカー（#のみ）は対象外

実行: QT_QPA_PLATFORM=offscreen .venv/bin/python tests/test_link_click.py
"""
import sys
import tempfile
from pathlib import Path

from PySide6.QtCore import QEventLoop, QTimer, QUrl
from PySide6.QtGui import QDesktopServices
from PySide6.QtWidgets import QApplication, QMessageBox
from markdown_editor.main import MainWindow

app = QApplication(sys.argv)

tmpdir = Path(tempfile.mkdtemp(prefix="md_link_test_"))
doc_a = tmpdir / "a.md"
doc_b = tmpdir / "sub" / "b.md"
doc_b.parent.mkdir()
other_file = tmpdir / "note.txt"
doc_a.write_text("# A\n", encoding="utf-8")
doc_b.write_text("# B\n", encoding="utf-8")
other_file.write_text("plain text\n", encoding="utf-8")

w = MainWindow()
w.show()


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


def wait(ms):
    loop = QEventLoop()
    QTimer.singleShot(ms, loop.quit)
    loop.exec()


opened_urls = []
_orig_open_url = QDesktopServices.openUrl
QDesktopServices.openUrl = staticmethod(lambda url: opened_urls.append(url.toString()))

w.load_path(doc_a)
assert w.current_path == doc_a.resolve()

# ---- 1. 外部リンク ----
opened_urls.clear()
w.handle_link_click("https://example.com/path?x=1")
assert opened_urls == ["https://example.com/path?x=1"], opened_urls
assert w.current_path == doc_a.resolve(), "external link must not change current file"
print("EXTERNAL LINK OK")

# mailto等、file以外のスキームも外部扱い
opened_urls.clear()
w.handle_link_click("mailto:test@example.com")
assert opened_urls == ["mailto:test@example.com"], opened_urls
print("MAILTO OK")

# ---- 2. 相対パスの.mdリンク → アプリ内で開く ----
opened_urls.clear()
w.handle_link_click("sub/b.md")
assert opened_urls == [], "must not delegate to OS"
assert w.current_path == doc_b.resolve(), w.current_path
print("RELATIVE MD LINK OPENS IN APP OK")

# 相対パスの基準は「リンクをクリックした時点の文書」のフォルダ
opened_urls.clear()
w.handle_link_click("../a.md")
assert w.current_path == doc_a.resolve(), w.current_path
print("RELATIVE PARENT MD LINK OK")

# ---- 3. その他の相対パスファイル → OS委譲 ----
opened_urls.clear()
w.handle_link_click("note.txt")
assert len(opened_urls) == 1 and opened_urls[0].endswith("note.txt"), opened_urls
assert w.current_path == doc_a.resolve(), "non-md link must not change current file"
print("OTHER FILE LINK DELEGATED TO OS OK")

# ---- 4. 未保存の変更がある場合、確認ダイアログでキャンセルすると開かない ----
w.on_content_changed(w.current_content + "\nedited")
assert w.dirty

_orig_warning = QMessageBox.warning
QMessageBox.warning = staticmethod(lambda *a, **k: QMessageBox.StandardButton.Cancel)
try:
    opened_urls.clear()
    before_path = w.current_path
    w.handle_link_click("sub/b.md")
    assert w.current_path == before_path, "cancel must keep the current file open"
finally:
    QMessageBox.warning = _orig_warning
w.current_content = w.saved_content
print("DISCARD CANCEL BLOCKS LINK NAVIGATION OK")

QDesktopServices.openUrl = _orig_open_url

# ---- 5. JS側のクリックハンドラ ----
results = []


def js(code, ms=1000):
    results.clear()
    w.view.page().runJavaScript(code, 0, lambda r: results.append(r))
    wait_until(lambda: bool(results), timeout_ms=ms)
    return results[-1] if results else None


assert wait_until(lambda: js("typeof bridge") == "object", timeout_ms=8000), "bridge not ready"

setup = """
window.__calls = [];
bridge.handleLinkClick = (href) => { window.__calls.push(href); };
'ok'
"""
js(setup)

# Preview: 単純クリックで発動する
js("""
document.getElementById('preview').innerHTML =
  '<a id="ext" href="https://example.com/">ext</a>' +
  '<a id="frag" href="#section">frag</a>';
'ok'
""")
js("""
document.getElementById('ext').dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
'ok'
""")
assert js("JSON.stringify(window.__calls)") == '["https://example.com/"]', js("JSON.stringify(window.__calls)")
print("PREVIEW PLAIN CLICK TRIGGERS OK")

js("window.__calls = []; 'ok'")
js("""
document.getElementById('frag').dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
'ok'
""")
assert js("JSON.stringify(window.__calls)") == "[]", "pure anchor link must be ignored"
print("PREVIEW ANCHOR-ONLY LINK IGNORED OK")

# WYSIWYG: 単純クリックでは発動せず、Cmd/Ctrl+クリックで発動する
js("""
document.querySelector('[data-mode="wysiwyg"]').click();
'ok'
""", ms=4000)
wait(1500)
js("""
document.getElementById('wysiwyg-root').innerHTML =
  '<a id="wlink" href="https://example.com/">link</a>';
window.__calls = [];
'ok'
""")
js("""
document.getElementById('wlink').dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
'ok'
""")
assert js("JSON.stringify(window.__calls)") == "[]", "plain click in WYSIWYG must not navigate"
print("WYSIWYG PLAIN CLICK IGNORED OK")

js("""
document.getElementById('wlink').dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, ctrlKey: true, metaKey: true }));
'ok'
""")
assert js("JSON.stringify(window.__calls)") == '["https://example.com/"]', js("JSON.stringify(window.__calls)")
print("WYSIWYG MODIFIER CLICK TRIGGERS OK")

print("ALL LINK CLICK TESTS PASSED")
