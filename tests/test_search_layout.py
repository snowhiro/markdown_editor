"""検索バーの高さが適切（引き伸ばされていない）ことを検証する。

実行: QT_QPA_PLATFORM=offscreen .venv/bin/python tests/test_search_layout.py
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


wait(3000)

w.show_search()
wait(300)
app.processEvents()

bar_h = w.search_bar.height()
win_h = w.height()
print(f"search_bar height: {bar_h}, window height: {win_h}, ratio: {bar_h / win_h:.3f}")

assert bar_h < 60, f"search bar too tall: {bar_h}px"
assert bar_h / win_h < 0.1, f"search bar takes too much of the window: {bar_h / win_h:.2%}"
assert w.view.height() > win_h * 0.8, f"view squeezed: {w.view.height()}px"

print("SEARCH BAR LAYOUT TEST PASSED")
