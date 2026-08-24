"""配布物の絞り込みルール（spec.md 13.1）の検証。Qt非依存。

1. QtWebEngineWidgetsから推移的に必要なQtモジュールが残る
2. 使わないQtモジュール・バインディングが落ちる
3. QMLモジュール・metatypes・Qt標準UIの翻訳が落ちる
4. WebEngineのリソース（locales / devtools / debug版）の扱い
5. Qtプラグインのカテゴリと画像形式の選別
6. opengl32sw / ffmpeg は残す（spec.md 13.1.5でそのままとした）
7. Windows形式の区切り文字（\\）でも同じ判定になる

実行: .venv/bin/python tests/test_packaging_filter.py
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "packaging"))

from bundle_filter import filter_entries, keep  # noqa: E402

MAC = "PySide6/Qt/lib/{0}.framework/Versions/A/{0}"


def check(dest: str, expected: bool, label: str) -> None:
    actual = keep(dest)
    assert actual is expected, f"{label}: keep({dest!r}) -> {actual}"


# ---- 1. 必要なQtモジュールは残る ----
# QtWebEngineWidgets から otool -L / PEインポートで辿れる17個（Windowsは QtDBus 抜きの16個）
REQUIRED = [
    "QtCore", "QtDBus", "QtGui", "QtNetwork", "QtOpenGL", "QtPositioning",
    "QtPrintSupport", "QtQml", "QtQmlMeta", "QtQmlModels", "QtQmlWorkerScript",
    "QtQuick", "QtQuickWidgets", "QtWebChannel", "QtWebEngineCore",
    "QtWebEngineWidgets", "QtWidgets",
]
for name in REQUIRED:
    check(MAC.format(name), True, "必要なframework")
    check(f"PySide6/Qt6{name[2:]}.dll", True, "必要なDLL")
print("REQUIRED QT MODULES OK")

# ---- 2. 使わないQtモジュールは落ちる ----
UNUSED = [
    "QtCharts", "QtDataVisualization", "QtGraphs", "QtPdf", "QtQuick3D",
    "Qt3DRender", "QtShaderTools", "QtQuickControls2Imagine", "QtMultimedia",
    "QtLocation", "QtDesigner", "QtRemoteObjects", "QtQuickTemplates2",
]
for name in UNUSED:
    check(MAC.format(name), False, "不要なframework")
    check(f"PySide6/Qt6{name[2:]}.dll", False, "不要なDLL")

# imageformats/qpdf を残すと QtPdf（15MB）が付いてくるため、両方落ちていること
check("PySide6/Qt/plugins/imageformats/libqpdf.dylib", False, "qpdfプラグイン")
check("PySide6/plugins/imageformats/qpdf.dll", False, "qpdfプラグイン")
print("UNUSED QT MODULES OK")

# ---- 2b. バインディングはPython側から使うものだけ ----
for name in ["QtCore", "QtGui", "QtWidgets", "QtNetwork", "QtWebChannel",
             "QtWebEngineCore", "QtWebEngineWidgets", "QtPrintSupport"]:
    check(f"PySide6/{name}.abi3.so", True, "必要なバインディング")
    check(f"PySide6/{name}.pyd", True, "必要なバインディング")
# 本体は必要だがPythonからは使わないもの（QtOpenGLはmacOSで21MB）
for name in ["QtOpenGL", "QtQuick", "QtQml", "QtPositioning", "QtQuickWidgets",
             "QtDBus", "QtSvg", "QtPdf", "QtCharts"]:
    check(f"PySide6/{name}.abi3.so", False, "不要なバインディング")
    check(f"PySide6/{name}.pyd", False, "不要なバインディング")
print("BINDINGS OK")

# ---- 3. QML / metatypes / Qt標準UIの翻訳 ----
check("PySide6/Qt/qml/QtQuick/Controls/Basic/qmldir", False, "QMLモジュール")
check("PySide6/qml/QtQuick3D/plugins.qmltypes", False, "QMLモジュール")
check("PySide6/Qt/metatypes/qt6core_relwithdebinfo_metatypes.json", False, "metatypes")
check("PySide6/Qt/translations/qtbase_ja.qm", False, "Qt標準UIの翻訳")
check("PySide6/translations/qt_de.qm", False, "Qt標準UIの翻訳")
print("QML AND TRANSLATIONS OK")

# ---- 4. WebEngineのリソース ----
LOCALES_MAC = "PySide6/Qt/lib/QtWebEngineCore.framework/Versions/A/Resources/qtwebengine_locales/{}.pak"
LOCALES_WIN = "PySide6/translations/qtwebengine_locales/{}.pak"
for template in (LOCALES_MAC, LOCALES_WIN):
    check(template.format("ja"), True, "残す言語")
    check(template.format("en-US"), True, "残す言語")
    for other in ("de", "fr", "zh-CN", "ko", "pt-BR"):
        check(template.format(other), False, "落とす言語")

# 中核リソースは残す
check("PySide6/Qt/lib/QtWebEngineCore.framework/Versions/A/Resources/icudtl.dat", True, "icudtl")
check("PySide6/resources/icudtl.dat", True, "icudtl")
check("PySide6/resources/qtwebengine_resources.pak", True, "本体リソース")
check("PySide6/resources/v8_context_snapshot.bin", True, "V8スナップショット")

# DevTools専用とデバッグ版は落とす
check("PySide6/resources/qtwebengine_devtools_resources.pak", False, "DevTools")
check("PySide6/resources/qtwebengine_devtools_resources.debug.pak", False, "デバッグ版")
check("PySide6/resources/qtwebengine_resources.debug.pak", False, "デバッグ版")
check("PySide6/resources/v8_context_snapshot.debug.bin", False, "デバッグ版")
print("WEBENGINE RESOURCES OK")

# ---- 5. プラグイン ----
for path in [
    "PySide6/Qt/plugins/platforms/libqcocoa.dylib",
    "PySide6/plugins/platforms/qwindows.dll",
    "PySide6/plugins/styles/qmodernwindowsstyle.dll",
    "PySide6/Qt/plugins/tls/libqopensslbackend.dylib",
    "PySide6/Qt/plugins/iconengines/libqsvgicon.dylib",
]:
    check(path, True, "必要なプラグイン")
for path in [
    "PySide6/Qt/plugins/qmltooling/libqmldbg_debugger.dylib",
    "PySide6/Qt/plugins/position/libqtposition_positionpoll.dylib",
    "PySide6/plugins/sqldrivers/qsqlite.dll",
    "PySide6/plugins/multimedia/ffmpegmediaplugin.dll",
]:
    check(path, False, "不要なプラグイン")
for name in ("qjpeg", "qgif", "qico", "qsvg"):
    check(f"PySide6/Qt/plugins/imageformats/lib{name}.dylib", True, "残す画像形式")
    check(f"PySide6/plugins/imageformats/{name}.dll", True, "残す画像形式")
for name in ("qtiff", "qwebp", "qtga", "qwbmp", "qicns", "qmacheif"):
    check(f"PySide6/Qt/plugins/imageformats/lib{name}.dylib", False, "落とす画像形式")
print("PLUGINS OK")

# ---- 6. spec.md 13.1.5 で「そのまま残す」としたもの ----
for path in [
    "PySide6/opengl32sw.dll",
    "PySide6/avcodec-61.dll",
    "PySide6/avformat-61.dll",
    "PySide6/avutil-59.dll",
    "PySide6/swresample-5.dll",
    "PySide6/swscale-8.dll",
    "PySide6/Qt/lib/libavcodec.61.dylib",
]:
    check(path, True, "残すと決めたもの")
# アプリ自身のファイルとPythonランタイムも当然残る
for path in [
    "markdown_editor/web/index.html",
    "markdown_editor/web/vendor/mermaid.min.js",
    "Python.framework/Versions/3.14/Python",
    "python3.14/lib-dynload/_socket.cpython-314-darwin.so",
    "base_library.zip",
    "libcrypto.3.dylib",
    "PySide6/pyside6.abi3.dll",
]:
    check(path, True, "アプリ・ランタイム")
print("KEPT ON PURPOSE OK")

# ---- 7. Windows形式の区切り文字でも同じ判定 ----
pairs = [
    ("PySide6\\qml\\QtQuick\\qmldir", False),
    ("PySide6\\plugins\\imageformats\\qtiff.dll", False),
    ("PySide6\\plugins\\imageformats\\qjpeg.dll", True),
    ("PySide6\\translations\\qtwebengine_locales\\ja.pak", True),
    ("PySide6\\translations\\qtwebengine_locales\\fr.pak", False),
    ("PySide6\\Qt6Charts.dll", False),
    ("PySide6\\Qt6WebEngineCore.dll", True),
]
for dest, expected in pairs:
    check(dest, expected, "Windows形式のパス")
print("WINDOWS PATHS OK")

# ---- filter_entries はTOCの形（dest, src, typecode）をそのまま扱う ----
entries = [
    ("PySide6/Qt6WebEngineCore.dll", "/src/Qt6WebEngineCore.dll", "BINARY"),
    ("PySide6/Qt6Charts.dll", "/src/Qt6Charts.dll", "BINARY"),
    ("PySide6/qml/QtQuick/qmldir", "/src/qmldir", "DATA"),
    ("markdown_editor/web/app.js", "/src/app.js", "DATA"),
]
kept = filter_entries(entries)
assert [e[0] for e in kept] == [
    "PySide6/Qt6WebEngineCore.dll",
    "markdown_editor/web/app.js",
], kept
assert all(len(e) == 3 for e in kept)
print("FILTER ENTRIES OK")

print("ALL PACKAGING FILTER TESTS PASSED")
