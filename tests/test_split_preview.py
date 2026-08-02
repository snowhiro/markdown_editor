"""Editモードの分割プレビュー（spec.md 4.1）のオフスクリーン検証。

1. 表示メニューの項目がEditモードでのみ有効になる
2. 切替で編集ペインとプレビューペインが左右に並ぶ（ディバイダ含む）
3. 入力がデバウンス後にプレビューへ反映される
4. Mermaid図はソースが変わらなければ再描画せずキャッシュを再利用する
5. 編集側のスクロールにプレビューが追従する／プレビューを直接操作すると追従を止める
6. ディバイダのドラッグで幅比が変わる／最小幅を割ると分割を一時解除する
7. モードを往復しても設定が保持される

実行: QT_QPA_PLATFORM=offscreen .venv/bin/python tests/test_split_preview.py
"""
import json
import sys

from PySide6.QtCore import QEventLoop, QTimer
from PySide6.QtWidgets import QApplication
from markdown_editor.main import MainWindow

app = QApplication(sys.argv)

w = MainWindow()
w.resize(1200, 800)
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


def js(code, ms=4000):
    results.clear()
    w.view.page().runJavaScript(code, 0, lambda r: results.append(r))
    wait_until(lambda: bool(results), timeout_ms=ms)
    return results[-1] if results else None


def layout():
    return json.loads(
        js(
            """JSON.stringify({
  split: document.getElementById('content').classList.contains('split'),
  editorShown: !document.getElementById('editor-pane').hidden,
  previewShown: !document.getElementById('preview-pane').hidden,
  dividerShown: !document.getElementById('split-divider').hidden,
  editorLeft: document.getElementById('editor-pane').getBoundingClientRect().left,
  previewLeft: document.getElementById('preview-pane').getBoundingClientRect().left,
  editorWidth: document.getElementById('editor-pane').getBoundingClientRect().width,
  previewWidth: document.getElementById('preview-pane').getBoundingClientRect().width,
})"""
        )
    )


assert wait_until(lambda: js("typeof bridge") == "object"), "bridge not ready"

# ---- 1. メニュー項目の有効/無効 ----
assert not w.split_preview_action.isEnabled(), "must be disabled in preview mode"

js("document.querySelector('[data-mode=\"wysiwyg\"]').click(); 'ok'")
assert wait_until(lambda: w.current_mode == "wysiwyg")
assert not w.split_preview_action.isEnabled(), "must be disabled in wysiwyg mode"

js("document.querySelector('[data-mode=\"edit\"]').click(); 'ok'")
assert wait_until(lambda: w.current_mode == "edit")
assert w.split_preview_action.isEnabled(), "must be enabled in edit mode"
print("MENU ENABLE STATE OK")

# 分割OFFの間はEditのみが表示される
before = layout()
assert not before["split"] and not before["previewShown"], before
print("SPLIT OFF LAYOUT OK")

# ---- 2. 切替で左右に並ぶ ----
w.split_preview_action.trigger()  # OFF → ON
assert wait_until(lambda: layout()["split"], timeout_ms=4000), layout()
after = layout()
assert after["editorShown"] and after["previewShown"] and after["dividerShown"], after
assert after["editorLeft"] < after["previewLeft"], f"editor must be on the left: {after}"
assert abs(after["editorWidth"] - after["previewWidth"]) < 20, f"default ratio ~50:50: {after}"
print("SPLIT ON LAYOUT OK")

# ---- 3. 入力がデバウンス後に反映される ----
# 文書差し替え（ファイルを開く相当）
w.bridge.fileOpened.emit("", "# 見出しA\n\n本文テキスト\n")
assert wait_until(
    lambda: "見出しA" in (js("document.getElementById('preview').textContent") or ""),
    timeout_ms=4000,
), js("document.getElementById('preview').textContent")
print("PREVIEW REFLECTS DOCUMENT OK")

# エディタ側の編集（SourceEditorのonChange経路）でもデバウンス後に反映される。
# 右クリックメニューからのテーブル挿入（spec.md 5.1）を編集操作として利用する。
assert js("document.querySelectorAll('#preview table').length") == 0
js("""
(() => {
  const pane = document.getElementById('editor-pane');
  const r = pane.getBoundingClientRect();
  pane.dispatchEvent(new MouseEvent('contextmenu',
    { bubbles: true, cancelable: true, clientX: r.left + 40, clientY: r.top + 40 }));
  document.querySelectorAll('.app-context-menu .acm-item')[0]
    .dispatchEvent(new MouseEvent('click', { bubbles: true }));
  document.querySelector('.acm-submenu .tg-cell[data-r="2"][data-c="3"]')
    .dispatchEvent(new MouseEvent('click', { bubbles: true }));
  return 'ok';
})()
""")
# デバウンス（300ms）前は未反映であること
wait(120)
assert js("document.querySelectorAll('#preview table').length") == 0, (
    "must be debounced, not rendered per keystroke"
)
assert wait_until(
    lambda: js("document.querySelectorAll('#preview table').length") == 1,
    timeout_ms=4000,
), "edit must reach the preview after the debounce"
assert "| --- |" in w.current_content, "edit must reach the Python side too"
print("DEBOUNCED LIVE UPDATE OK")

# ---- 4. Mermaidキャッシュ ----
w.bridge.fileOpened.emit(
    "",
    "# 図\n\n```mermaid\nflowchart LR\n    A --> B\n```\n\n本文1\n",
)
assert wait_until(
    lambda: js("document.querySelectorAll('#preview pre.mermaid svg').length") == 1,
    timeout_ms=8000,
), "mermaid not rendered"
first_id = js("document.querySelector('#preview pre.mermaid svg').id")
assert first_id, "svg has no id"

# 図のソースを変えずに本文だけ変更 → 同じSVG（同一id）が再利用される
w.bridge.fileOpened.emit(
    "",
    "# 図\n\n```mermaid\nflowchart LR\n    A --> B\n```\n\n本文2（変更）\n",
)
assert wait_until(
    lambda: "本文2" in (js("document.getElementById('preview').textContent") or ""),
    timeout_ms=8000,
)
assert wait_until(
    lambda: js("document.querySelectorAll('#preview pre.mermaid svg').length") == 1,
    timeout_ms=8000,
)
second_id = js("document.querySelector('#preview pre.mermaid svg').id")
assert second_id == first_id, f"mermaid svg must be reused: {first_id} -> {second_id}"
print("MERMAID CACHE REUSE OK")

# 図のソースを変えると再描画される（別id）
w.bridge.fileOpened.emit(
    "",
    "# 図\n\n```mermaid\nflowchart LR\n    A --> C\n```\n\n本文2（変更）\n",
)
assert wait_until(
    lambda: js("document.querySelector('#preview pre.mermaid svg').id") != first_id,
    timeout_ms=8000,
), "changed mermaid source must be re-rendered"
print("MERMAID RERENDER ON CHANGE OK")

# ---- 5. スクロール追従 ----
long_doc = "# 長い文書\n\n" + "\n\n".join(f"段落{i}" for i in range(400))
w.bridge.fileOpened.emit("", long_doc)
assert wait_until(
    lambda: "段落399" in (js("document.getElementById('preview').textContent") or ""),
    timeout_ms=8000,
)
wait(500)

# 編集側を末尾までスクロール → プレビューも末尾付近へ追従する
js("""
(() => {
  const sc = document.querySelector('#editor-pane .cm-scroller');
  sc.scrollTop = sc.scrollHeight;
  return 'ok';
})()
""")
wait(400)
follow = json.loads(
    js(
        """(() => {
  const p = document.getElementById('preview-pane');
  const max = p.scrollHeight - p.clientHeight;
  return JSON.stringify({ fraction: max > 0 ? p.scrollTop / max : -1, max });
})()"""
    )
)
assert follow["max"] > 0, follow
assert follow["fraction"] > 0.8, f"preview must follow the editor scroll: {follow}"
print("SCROLL FOLLOW OK")

# プレビューを直接スクロールすると追従を停止する
js("""
(() => {
  const p = document.getElementById('preview-pane');
  p.scrollTop = 0;
  p.dispatchEvent(new Event('scroll'));
  return 'ok';
})()
""")
wait(300)
js("""
(() => {
  const sc = document.querySelector('#editor-pane .cm-scroller');
  sc.scrollTop = Math.floor(sc.scrollHeight / 2);
  return 'ok';
})()
""")
wait(400)
# 編集側の操作が再開したら追従を再開する仕様のため、ここでは追従が戻ることを確認する
resumed = json.loads(
    js(
        """(() => {
  const p = document.getElementById('preview-pane');
  const max = p.scrollHeight - p.clientHeight;
  return JSON.stringify({ fraction: max > 0 ? p.scrollTop / max : -1 });
})()"""
    )
)
assert resumed["fraction"] > 0.2, f"editor scroll must resume the follow: {resumed}"
print("SCROLL FOLLOW RESUME OK")

# ---- 6. ディバイダのドラッグ ----
ratio_before = layout()
dragged = js(
    """(() => {
  const divider = document.getElementById('split-divider');
  const content = document.getElementById('content');
  const rect = content.getBoundingClientRect();
  const x = rect.left + rect.width * 0.3;
  divider.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, pointerId: 1, clientX: rect.left + rect.width * 0.5 }));
  divider.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, pointerId: 1, clientX: x }));
  divider.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 1, clientX: x }));
  return document.getElementById('editor-pane').getBoundingClientRect().width;
})()"""
)
assert dragged < ratio_before["editorWidth"] - 50, (
    f"divider drag must shrink the editor pane: {ratio_before['editorWidth']} -> {dragged}"
)
print("DIVIDER DRAG OK")

# ---- 7. 最小幅を割ると分割を一時解除する ----
w.resize(400, 800)
wait(600)
js("window.dispatchEvent(new Event('resize')); 'ok'")
wait(300)
narrow = layout()
assert not narrow["split"] and not narrow["previewShown"], f"narrow window must collapse: {narrow}"
assert narrow["editorShown"], narrow
print("NARROW WINDOW COLLAPSE OK")

w.resize(1200, 800)
wait(600)
js("window.dispatchEvent(new Event('resize')); 'ok'")
assert wait_until(lambda: layout()["split"], timeout_ms=4000), layout()
print("WIDE WINDOW RESTORE OK")

# ---- 8. モード往復で設定が保持される ----
js("document.querySelector('[data-mode=\"preview\"]').click(); 'ok'")
assert wait_until(lambda: w.current_mode == "preview")
in_preview = layout()
assert not in_preview["split"] and in_preview["previewShown"], in_preview
assert not in_preview["editorShown"], in_preview
assert not w.split_preview_action.isEnabled(), "must be disabled outside edit mode"
assert w.split_preview_action.isChecked(), "preference must be kept"
print("PREVIEW MODE FALLBACK OK")

js("document.querySelector('[data-mode=\"edit\"]').click(); 'ok'")
assert wait_until(lambda: w.current_mode == "edit")
assert wait_until(lambda: layout()["split"], timeout_ms=4000), layout()
print("SPLIT RESTORED ON RETURN OK")

# OFFに戻すと単独表示になる
w.split_preview_action.trigger()  # ON → OFF
assert wait_until(lambda: not layout()["split"], timeout_ms=4000), layout()
off = layout()
assert off["editorShown"] and not off["previewShown"] and not off["dividerShown"], off
print("SPLIT OFF AGAIN OK")

print("ALL SPLIT PREVIEW TESTS PASSED")
