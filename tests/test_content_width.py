"""本文の表示幅（spec.md 4.2）のオフスクリーン検証。

1. 表示メニューに3段階の排他選択があり、既定は「標準」
2. 切替でPreview・WYSIWYG・分割プレビューの右ペインの幅が変わる
3. 「画面いっぱい」ではMermaid図が左寄せになる
4. 設定はアプリを起動し直しても復元され、不正な値は「標準」に戻る
5. HTMLエクスポートは設定を反映し、PDFは常に標準幅

実行: QT_QPA_PLATFORM=offscreen .venv/bin/python tests/test_content_width.py
"""
import json
import shutil
import sys
import tempfile
from pathlib import Path

from PySide6.QtCore import QEventLoop, QTimer
from PySide6.QtWidgets import QApplication
from markdown_editor import main as main_module
from markdown_editor.main import MainWindow
from markdown_editor.settings import SETTINGS_FILENAME, Settings

app = QApplication(sys.argv)

tmpdir = Path(tempfile.mkdtemp(prefix="md_width_test_"))
settings_file = tmpdir / SETTINGS_FILENAME

# 設定の保存先をテスト用の場所へ向ける（リポジトリを汚さない）
main_module.Settings = lambda: Settings(settings_file)

doc = tmpdir / "d.md"
doc.write_text(
    "# 見出し\n\n本文の段落です。\n\n```mermaid\nflowchart LR\n    A --> B\n```\n",
    encoding="utf-8",
)


def wait_until(predicate, timeout_ms=20000, interval_ms=50):
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


def make_window():
    w = MainWindow()
    w.resize(1600, 800)
    w.show()
    results = []

    def js(code, ms=8000):
        results.clear()
        w.view.page().runJavaScript(code, 0, lambda r: results.append(r))
        wait_until(lambda: bool(results), timeout_ms=ms)
        return results[-1] if results else None

    assert wait_until(lambda: js("typeof bridge") == "object"), "bridge not ready"
    return w, js


w, js = make_window()
w.load_path(doc)
assert wait_until(lambda: "見出し" in (js("document.getElementById('preview').textContent") or ""))
wait(400)

# ---- 1. メニュー ----
menu_bar = w.menuBar()
view_action = [a for a in menu_bar.actions() if a.text() == "表示"][0]
view_menu = view_action.menu()
width_action = [a for a in view_menu.actions() if a.text() == "本文の幅"][0]
width_menu = width_action.menu()
labels = [a.text() for a in width_menu.actions()]
assert labels == ["標準", "広め", "画面いっぱい"], labels
assert all(a.isCheckable() for a in width_menu.actions())
assert w.content_width_group.isExclusive()
assert w.content_width == "standard"
assert w.content_width_actions["standard"].isChecked()
print("MENU OK")


def preview_width():
    return js("Math.round(document.getElementById('preview').getBoundingClientRect().width)")


def body_class():
    return js("document.body.className")


# ---- 2. 切替で幅が変わる ----
assert body_class() == "width-standard", body_class()
assert preview_width() == 860, preview_width()

w.content_width_actions["wide"].trigger()
assert wait_until(lambda: body_class() == "width-wide", timeout_ms=4000), body_class()
assert preview_width() == 1100, preview_width()
print("WIDE OK")

w.content_width_actions["full"].trigger()
assert wait_until(lambda: body_class() == "width-full", timeout_ms=4000), body_class()
full_width = preview_width()
assert full_width > 1300, f"画面いっぱいにならない: {full_width}"
print("FULL OK")

# WYSIWYGモードにも同じ幅が適用される
js("document.querySelector('[data-mode=\"wysiwyg\"]').click(); 'ok'")
assert wait_until(lambda: w.current_mode == "wysiwyg")
wait(2000)
wy = js("Math.round(document.getElementById('wysiwyg-root').getBoundingClientRect().width)")
assert wy == full_width, f"WYSIWYGにも適用されること: {wy} != {full_width}"
w.set_content_width("standard")
assert wait_until(
    lambda: js("Math.round(document.getElementById('wysiwyg-root').getBoundingClientRect().width)") == 860,
    timeout_ms=4000,
)
print("WYSIWYG APPLIED OK")

# 分割プレビューの右ペインにも適用される
js("document.querySelector('[data-mode=\"edit\"]').click(); 'ok'")
assert wait_until(lambda: w.current_mode == "edit")
wait(500)
w.split_preview_action.trigger()
assert wait_until(
    lambda: js("document.getElementById('content').classList.contains('split')"),
    timeout_ms=4000,
)
wait(500)
pane = js("Math.round(document.getElementById('preview-pane').getBoundingClientRect().width)")
w.set_content_width("full")
assert wait_until(lambda: body_class() == "width-full", timeout_ms=4000)
wait(300)
split_full = preview_width()
assert abs(split_full - pane) <= 2, f"右ペインいっぱいに広がること: {split_full} vs {pane}"
print("SPLIT PANE APPLIED OK")

# ---- 3. 「画面いっぱい」ではMermaid図を左寄せにする ----
js("document.querySelector('[data-mode=\"preview\"]').click(); 'ok'")
assert wait_until(lambda: w.current_mode == "preview")
assert wait_until(
    lambda: js("document.querySelectorAll('#preview pre.mermaid svg').length") == 1,
    timeout_ms=10000,
)


def mermaid_justify():
    return js(
        "getComputedStyle(document.querySelector('#preview pre.mermaid')).justifyContent"
    )


assert mermaid_justify() == "flex-start", mermaid_justify()
w.set_content_width("standard")
assert wait_until(lambda: mermaid_justify() == "center", timeout_ms=4000), mermaid_justify()
w.set_content_width("wide")
assert wait_until(lambda: body_class() == "width-wide", timeout_ms=4000)
assert mermaid_justify() == "center", mermaid_justify()
print("MERMAID ALIGNMENT OK")

# ---- 5. エクスポート（幅の反映） ----
html = w._build_export_html("<p>本文</p>", "wide")
assert '<body class="width-wide">' in html, html[:400]
assert "max-width: 860px" not in html.split("</head>")[1], "本文幅はクラスで決める"
assert "body.width-wide .markdown-body { max-width: 1100px; }" in html, "styles.cssが埋め込まれること"
pdf_html = w._build_export_html("<p>本文</p>", main_module.PDF_CONTENT_WIDTH)
assert '<body class="width-standard">' in pdf_html, "PDFは常に標準幅"
print("EXPORT HTML OK")

# ---- 4. 永続化 ----
saved = json.loads(settings_file.read_text(encoding="utf-8"))
assert saved["view"]["contentWidth"] == "wide", saved
w.close()

w2, js2 = make_window()
assert w2.content_width == "wide", w2.content_width
assert w2.content_width_actions["wide"].isChecked()
assert wait_until(lambda: js2("document.body.className") == "width-wide", timeout_ms=6000), js2(
    "document.body.className"
)
print("PERSISTED ACROSS RESTART OK")
w2.close()

# 不正な値は「標準」に戻す
settings_file.write_text('{"version": 1, "view": {"contentWidth": "huge"}}', encoding="utf-8")
w3, js3 = make_window()
assert w3.content_width == "standard", w3.content_width
assert w3.content_width_actions["standard"].isChecked()
print("INVALID VALUE FALLS BACK OK")
w3.close()

shutil.rmtree(tmpdir, ignore_errors=True)
print("ALL CONTENT WIDTH TESTS PASSED")
