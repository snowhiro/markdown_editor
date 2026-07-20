"""クリップボード画像貼り付け（spec.md 5.2）のオフスクリーン検証。

1. save_pasted_image: image/フォルダ作成・PNG保存・相対パス返却・同名衝突の連番
2. 相対パス画像のPreview表示: 文書フォルダ基準のfile:// URLへ解決され実際に読み込まれる

実行: QT_QPA_PLATFORM=offscreen .venv/bin/python tests/test_paste_image.py
"""
import base64
import sys
import tempfile
from pathlib import Path

from PySide6.QtCore import QBuffer, QEventLoop, QTimer
from PySide6.QtGui import QColor, QImage
from PySide6.QtWidgets import QApplication
from markdown_editor.main import MainWindow

app = QApplication(sys.argv)

tmpdir = Path(tempfile.mkdtemp(prefix="md_paste_test_"))


def make_png_b64(color: str, size: int = 8) -> bytes:
    img = QImage(size, size, QImage.Format.Format_RGB32)
    img.fill(QColor(color))
    buf = QBuffer()
    buf.open(QBuffer.OpenModeFlag.WriteOnly)
    img.save(buf, "PNG")
    return bytes(buf.data())


# 文書ファイルと参照画像を用意する（Preview表示検証用）
doc_path = tmpdir / "doc.md"
img_dir = tmpdir / "image"
img_dir.mkdir()
(img_dir / "pic.png").write_bytes(make_png_b64("red"))
doc_path.write_text("# 画像表示テスト\n\n![](image/pic.png)\n", encoding="utf-8")

w = MainWindow(initial_path=doc_path)
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


# ---- 1. save_pasted_image（Python側の保存処理） ----

# initial_pathはページ読み込み後のon_web_readyで適用されるため、
# current_pathが確定するまで待つ（未保存扱いだと保存ダイアログが開いてしまう）
assert wait_until(lambda: w.current_path is not None, timeout_ms=15000), (
    "document path was not applied (page load timeout)"
)

b64 = base64.b64encode(make_png_b64("blue")).decode()

rel1 = w.save_pasted_image(b64)
assert rel1.startswith("image/image-") and rel1.endswith(".png"), rel1
saved1 = doc_path.parent / rel1
assert saved1.exists(), "pasted image file must exist"
check = QImage()
assert check.load(str(saved1)), "saved file must be a loadable image"

# 同一秒内の連続貼り付け → 連番付きの別名になる
rel2 = w.save_pasted_image(b64)
assert rel2 != rel1, "second paste must get a unique name"
assert (doc_path.parent / rel2).exists()

# 不正データは空文字列（ファイルを作らない）
assert w.save_pasted_image("not-base64!!") == ""
assert w.save_pasted_image(base64.b64encode(b"not an image").decode()) == ""

print("SAVE PASTED IMAGE OK")

# ---- 2. Preview表示（相対パスがfile://へ解決され画像が読み込まれる） ----

results = []


def poll_img():
    results.clear()
    w.view.page().runJavaScript(
        "JSON.stringify((() => { const i = document.querySelector('#preview img');"
        " return i ? { src: i.src, w: i.naturalWidth } : null; })())",
        0,
        lambda r: results.append(r),
    )
    return wait_until(lambda: bool(results), timeout_ms=500)


elapsed = 0
ok = False
while elapsed <= 15000:
    if poll_img():
        import json

        raw = results[-1]
        r = json.loads(raw) if raw else None
        if r and r.get("src", "").startswith("file://") and r.get("w", 0) > 0:
            ok = True
            break
    elapsed += 500

assert ok, f"preview image not resolved/loaded: {results[-1] if results else None}"
print("PREVIEW IMAGE RESOLUTION OK")

print("ALL PASTE IMAGE TESTS PASSED")
