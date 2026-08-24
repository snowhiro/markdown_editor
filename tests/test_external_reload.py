"""外部での更新の検知と再読み込み（spec.md 9.2）のオフスクリーン検証。

1. 外部での書き換えを検知して通知バーを出す／自動リロードはしない（9.2.1）
2. アプリ自身の保存では通知しない（9.2.1）
3. ［再読み込み］でディスクの内容を取り込む（9.2.2）
4. 未保存の変更があるときは文言が変わり、確認ダイアログを経由する（9.2.2）
5. 再読み込みでスクロール位置・Editのカーソル位置を維持する（9.2.3）
6. 削除されたら内容を保持して未保存扱いにし、再作成で監視を再開する（9.2.4）
7. ［閉じる］で消え、さらに更新されれば再表示する（9.2.2）
8. メニューの「再読み込み」（F5）でいつでも読み直せる（9.2.5）
9. 改行コードを再検出する（9.2.3）

外部からの更新は別プロセス（subprocess）で行い、実際のエディタと同じ条件にする。

実行: QT_QPA_PLATFORM=offscreen .venv/bin/python tests/test_external_reload.py
"""
import json
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

from PySide6.QtCore import QEventLoop, QTimer
from PySide6.QtGui import QKeySequence
from PySide6.QtWidgets import QApplication, QMessageBox
from markdown_editor.main import MainWindow

app = QApplication(sys.argv)

tmpdir = Path(tempfile.mkdtemp(prefix="md_reload_test_"))
doc = tmpdir / "doc.md"
LONG_DOC = "# 見出し\n\n" + "\n\n".join(f"段落{i}" for i in range(300)) + "\n"
doc.write_text(LONG_DOC, encoding="utf-8")

w = MainWindow()
w.resize(1100, 800)
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


results = []


def js(code, ms=5000):
    results.clear()
    w.view.page().runJavaScript(code, 0, lambda r: results.append(r))
    wait_until(lambda: bool(results), timeout_ms=ms)
    return results[-1] if results else None


def external(script: str) -> None:
    """別プロセスからファイルを操作する（外部エディタ相当）。"""
    subprocess.run(["sh", "-c", script], cwd=tmpdir, check=True)


assert wait_until(lambda: js("typeof bridge") == "object"), "bridge not ready"

w.load_path(doc)
assert wait_until(lambda: "段落299" in (js("document.getElementById('preview').textContent") or ""))
assert not w.reload_bar.isVisible(), "開いた直後は通知バーを出さない"
assert w.reload_action.isEnabled()
print("SETUP OK")

# ---- 1. 外部での書き換えを検知する（自動リロードはしない） ----
external("printf '# 外部で書き換えた\\n\\n新しい本文\\n' > doc.md")
assert wait_until(lambda: w.reload_bar.isVisible(), timeout_ms=4000), "通知バーが出ていない"
assert w.reload_state == "changed", w.reload_state
assert "外部で変更されました" in w.reload_message.text(), w.reload_message.text()
assert w.reload_button.isVisible() and w.reload_button.text() == "再読み込み"
# 自動では取り込まない
assert w.current_content == LONG_DOC, "自動リロードしてはいけない"
assert "段落299" in (js("document.getElementById('preview').textContent") or "")
print("DETECT WITHOUT AUTO RELOAD OK")

# ---- 3. ［再読み込み］で取り込む ----
w.reload_button.click()
assert wait_until(lambda: "外部で書き換えた" in w.current_content, timeout_ms=4000), w.current_content
assert not w.reload_bar.isVisible(), "取り込んだら通知バーを閉じる"
assert not w.dirty, "再読み込み後は保存済み状態"
assert wait_until(
    lambda: "外部で書き換えた" in (js("document.getElementById('preview').textContent") or "")
), "プレビューにも反映される"
print("RELOAD OK")

# ---- 2. アプリ自身の保存では通知しない ----
w.on_content_changed(w.current_content + "\n自分で編集\n")
assert w.dirty
assert w.save()
wait(1200)  # デバウンス（200ms）を十分に超える待ち
assert not w.reload_bar.isVisible(), "自分の保存で通知を出してはいけない"
assert not w.dirty
print("SELF SAVE NOT NOTIFIED OK")

# 内容を変えない外部からの更新（touch相当の書き戻し）でも通知しない
external(f"cat doc.md > t.tmp && mv t.tmp doc.md")
wait(1200)
assert not w.reload_bar.isVisible(), "内容が同じなら通知しない"
print("SAME CONTENT NOT NOTIFIED OK")

# ---- 5. 位置の維持（Preview: スクロール比率） ----
doc.write_text(LONG_DOC, encoding="utf-8")
w.load_path(doc)
assert wait_until(lambda: "段落299" in (js("document.getElementById('preview').textContent") or ""))
wait(400)
js("""(() => {
  const p = document.getElementById('preview-pane');
  p.scrollTop = Math.floor((p.scrollHeight - p.clientHeight) * 0.6);
  return 'ok';
})()""")
wait(300)


def preview_fraction():
    return js("""(() => {
      const p = document.getElementById('preview-pane');
      const max = p.scrollHeight - p.clientHeight;
      return max > 0 ? p.scrollTop / max : -1;
    })()""")


before_fraction = preview_fraction()
assert before_fraction > 0.5, before_fraction
# 末尾だけを書き換える（文書の長さはほぼ変わらない）
external("printf '\\n追記された段落\\n' >> doc.md")
assert wait_until(lambda: w.reload_bar.isVisible(), timeout_ms=4000)
w.reload_button.click()
assert wait_until(lambda: "追記された段落" in w.current_content, timeout_ms=4000)
wait(600)
after_fraction = preview_fraction()
assert abs(after_fraction - before_fraction) < 0.05, (
    f"スクロール位置を維持できていない: {before_fraction} -> {after_fraction}"
)
print("PREVIEW SCROLL PRESERVED OK")

# ---- 5. 位置の維持（Edit: カーソル位置＋スクロール） ----
js("document.querySelector('[data-mode=\"edit\"]').click(); 'ok'")
assert wait_until(lambda: w.current_mode == "edit")
wait(800)


def edit_state():
    """カーソル行（.cm-activeLine）とスクロール比率を観測する。

    カーソル位置はCodeMirrorが付ける .cm-activeLine から読む。
    SourceEditorのインスタンスはアプリ外へ公開されていないため、
    描画結果から確認できるこの経路を使う。
    """
    return json.loads(
        js(
            """(() => {
  const sc = document.querySelector('#editor-pane .cm-scroller');
  const max = sc.scrollHeight - sc.clientHeight;
  const active = document.querySelector('#editor-pane .cm-activeLine');
  return JSON.stringify({
    fraction: max > 0 ? sc.scrollTop / max : -1,
    line: active ? active.textContent : null,
  });
})()"""
        )
    )


# カーソルキーで文書の中ほどへ移動する（キーマップ経由の実際の操作と同じ経路）。
# 座標クリックは表示範囲の再構築と噛み合わず狙った行に乗らないため使わない。
# ↓の連打はカーソルを画面内へスクロールさせるので、スクロール位置も一緒に動く。
js("""(() => {
  const c = document.querySelector('#editor-pane .cm-content');
  c.focus();
  for (let i = 0; i < 120; i++) {
    c.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }));
  }
  return 'ok';
})()""")
wait(500)
# 段落間の空行に止まっていた場合は、内容で比較できるよう1行進める
if not (edit_state()["line"] or "").strip():
    js("""(() => {
  const c = document.querySelector('#editor-pane .cm-content');
  c.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }));
  return 'ok';
})()""")
    wait(300)
before_edit = edit_state()
assert before_edit["fraction"] > 0.3, before_edit
assert before_edit["line"] and before_edit["line"].startswith("段落"), before_edit

# 末尾に追記する（前半の行番号は変わらないためカーソル行は同じ内容のまま）
external("printf '\\n最後に足した行\\n' >> doc.md")
assert wait_until(lambda: w.reload_bar.isVisible(), timeout_ms=4000)
w.reload_button.click()
assert wait_until(lambda: "最後に足した行" in w.current_content, timeout_ms=4000)
wait(600)
after_edit = edit_state()
assert after_edit["line"] == before_edit["line"], (
    f"カーソル位置を維持できていない: {before_edit['line']} -> {after_edit['line']}"
)
assert abs(after_edit["fraction"] - before_edit["fraction"]) < 0.06, (
    f"Editのスクロール位置を維持できていない: {before_edit} -> {after_edit}"
)
print("EDIT CURSOR AND SCROLL PRESERVED OK")

js("document.querySelector('[data-mode=\"preview\"]').click(); 'ok'")
assert wait_until(lambda: w.current_mode == "preview")

# ---- 4. 未保存の変更があるとき ----
w.on_content_changed(w.current_content + "\n編集中の内容\n")
assert w.dirty
external("printf '# さらに外部で変更\\n' > doc.md")
assert wait_until(lambda: w.reload_bar.isVisible(), timeout_ms=4000)
assert "失われます" in w.reload_message.text(), w.reload_message.text()
assert w.reload_button.text() == "破棄して再読み込み", w.reload_button.text()

_orig_warning = QMessageBox.warning
QMessageBox.warning = staticmethod(lambda *a, **k: QMessageBox.StandardButton.Cancel)
try:
    w.reload_button.click()
    assert "編集中の内容" in w.current_content, "キャンセル時は編集内容を保持する"
    assert w.reload_bar.isVisible(), "キャンセルしても通知は残す"
finally:
    QMessageBox.warning = _orig_warning
print("DIRTY CANCEL KEEPS EDITS OK")

QMessageBox.warning = staticmethod(lambda *a, **k: QMessageBox.StandardButton.Ok)
try:
    w.reload_button.click()
    assert wait_until(lambda: "さらに外部で変更" in w.current_content, timeout_ms=4000)
    assert "編集中の内容" not in w.current_content
    assert not w.dirty
finally:
    QMessageBox.warning = _orig_warning
print("DIRTY DISCARD RELOAD OK")

# ---- 7. ［閉じる］で消え、再更新で再表示 ----
external("printf '# 1回目\\n' > doc.md")
assert wait_until(lambda: w.reload_bar.isVisible(), timeout_ms=4000)
w._hide_reload_bar()
assert not w.reload_bar.isVisible() and w.reload_state is None
external("printf '# 2回目\\n' > doc.md")
assert wait_until(lambda: w.reload_bar.isVisible(), timeout_ms=4000), "再度更新されたら再表示する"
w.reload_button.click()
assert wait_until(lambda: "2回目" in w.current_content, timeout_ms=4000)
print("DISMISS AND REAPPEAR OK")

# ---- 6. 削除されたとき ----
kept = w.current_content
external("rm doc.md")
assert wait_until(lambda: w.reload_state == "missing", timeout_ms=4000), w.reload_state
assert w.reload_bar.isVisible()
assert not w.reload_button.isVisible(), "見つからない場合は再読み込みを提示しない"
assert w.current_content == kept, "内容は保持する"
assert w.dirty, "未保存扱いにする"
assert w.windowTitle().startswith("*"), w.windowTitle()
assert w.current_path is not None, "パスは保持する"
print("DELETE KEEPS CONTENT OK")

# 保存すれば復活する
assert w.save()
assert doc.exists() and doc.read_text(encoding="utf-8") == kept
assert not w.dirty and not w.reload_bar.isVisible()
print("SAVE RESTORES FILE OK")

# 削除→再作成でも監視を再開する
external("rm doc.md")
assert wait_until(lambda: w.reload_state == "missing", timeout_ms=4000)
external("printf '# 復活しました\\n' > doc.md")
assert wait_until(lambda: w.reload_state == "changed", timeout_ms=4000), w.reload_state
w._hide_reload_bar()
external("printf '# さらに更新\\n' > doc.md")
assert wait_until(lambda: w.reload_bar.isVisible(), timeout_ms=4000), "再作成後も検知できる"
print("WATCH RESUMED AFTER RECREATE OK")

# ---- 8. メニューからの再読み込み（F5） ----
assert w.reload_action.shortcut() == QKeySequence("F5"), w.reload_action.shortcut().toString()
external("printf '# F5で読み直す\\n' > doc.md")
wait(600)
w._hide_reload_bar()
w.manual_reload()
assert "F5で読み直す" in w.current_content, w.current_content
print("MANUAL RELOAD OK")

# ---- 9. 改行コードの再検出 ----
assert w.newline == "\n"
external("printf '# CRLF\\r\\n\\r\\n本文\\r\\n' > doc.md")
assert wait_until(lambda: w.reload_bar.isVisible(), timeout_ms=4000)
w.reload_button.click()
assert wait_until(lambda: "CRLF" in w.current_content, timeout_ms=4000)
assert w.newline == "\r\n", repr(w.newline)
assert "\r" not in w.current_content, "内部表現はLFに正規化する"
print("NEWLINE REDETECTED OK")

# 新規文書では再読み込みを無効にする
w.new_file()
assert not w.reload_action.isEnabled()
assert not w.reload_bar.isVisible()
print("NEW FILE DISABLES RELOAD OK")

shutil.rmtree(tmpdir, ignore_errors=True)
print("ALL EXTERNAL RELOAD TESTS PASSED")
