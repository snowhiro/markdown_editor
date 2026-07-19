"""Preview検索機能のオフスクリーン検証。

実ページを読み込み、findTextによる検索・件数表示・モード連動を確認する。
固定時間のsleepではなく実際の状態変化を待つことで、マシン速度に依存する
フラキーさを避ける。
実行: QT_QPA_PLATFORM=offscreen .venv/bin/python tests/test_search.py
"""
import sys

from PySide6.QtCore import QEventLoop, QTimer
from PySide6.QtWidgets import QApplication
from markdown_editor.main import MainWindow

app = QApplication(sys.argv)
w = MainWindow()
w.show()


def wait(ms):
    loop = QEventLoop()
    QTimer.singleShot(ms, loop.quit)
    loop.exec()


def wait_until(predicate, timeout_ms=8000, interval_ms=50):
    """predicateがTrueになるまでイベントループを回しながら待つ。

    固定sleepと違い、条件が満たされ次第すぐに戻るため速いマシンでは高速に、
    遅いマシンではタイムアウトまで粘り強く待つ。タイムアウトした場合は
    最後の状態のまま抜ける（呼び出し側のassertで失敗理由がわかるようにする）。
    """
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


results = []
w.view.page().findTextFinished.connect(
    lambda r: results.append((r.activeMatch(), r.numberOfMatches()))
)


def find_and_wait_for_matches(term, timeout_ms=10000, retry_interval_ms=300):
    """指定語で検索し、ヒットが見つかるまで再試行しながら待つ。

    Python側の状態（current_content等）はWebEngineでのページ読み込み・
    QWebChannel接続・JS側のPreview初回レンダリングより先に確定してしまう
    ため、「ページ読み込み待ち」を別途行うのではなく、実際にfindTextで
    ヒットが得られるまでこの検索自体をリトライする方が確実で速い。
    """
    elapsed = 0
    while elapsed <= timeout_ms:
        results.clear()
        w._find(term)
        if wait_until(lambda: bool(results), timeout_ms=retry_interval_ms):
            active, total = results[-1]
            if total > 0:
                return active, total
        elapsed += retry_interval_ms
    return results[-1] if results else (0, 0)


# 1. 検索バー表示
assert not w.search_bar.isVisible()
w.show_search()
assert w.search_bar.isVisible(), "search bar must be visible"

# 2. インクリメンタル検索（textChanged → findText）
# 検索語はUIのテキスト欄にも反映しておく（find_next等が入力値を使うため）
w.search_input.setText("Markdown")
active, total = find_and_wait_for_matches("Markdown")
assert total >= 1, f"expected matches, got {total}"
assert wait_until(lambda: w.search_count.text() == f"{active}/{total}"), (
    f"count label mismatch: {w.search_count.text()!r} vs {active}/{total}"
)

# 3. 次へ移動（activeMatchが変わる）
results.clear()
w.find_next()
assert wait_until(lambda: bool(results)), "findTextFinished not emitted after find_next"
active2, total2 = results[-1]
assert total2 == total, "total changed on find_next"
assert active2 != active or total == 1, "active match did not advance"

# 4. ヒットなしの表示
results.clear()
w.search_input.setText("zzz_no_such_term_zzz")
assert wait_until(lambda: w.search_count.text() == "0件"), (
    f"expected 0件, got {w.search_count.text()!r}"
)

# 5. モード切替で検索バーが閉じ、アクションが無効化される
w.on_mode_changed("edit")
assert not w.search_bar.isVisible(), "search bar must close on mode change"
assert not w.search_action.isEnabled(), "search action must be disabled"
w.on_mode_changed("preview")
assert w.search_action.isEnabled()

# 6. previewモード以外ではshow_searchが無視される
w.on_mode_changed("wysiwyg")
w.show_search()
assert not w.search_bar.isVisible(), "show_search must be ignored outside preview"
w.on_mode_changed("preview")

# 7. Escで閉じる（close_search経由の動作確認）
w.show_search()
results.clear()
w.search_input.setText("Editor")
wait_until(lambda: bool(results))
w.close_search()
assert not w.search_bar.isVisible()
assert w.search_count.text() == ""

print("ALL SEARCH TESTS PASSED")
