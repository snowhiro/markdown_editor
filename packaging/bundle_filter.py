"""配布物に同梱するファイルを絞り込む（spec.md 13.1）。

PyInstallerのQtフックは「QtWebEngineCoreが依存しているモジュール」を起点に
芋づる式に収集するため、本アプリが使わないQtモジュール・QMLモジュール・
各国語リソースまで大量に同梱される。ここでは実際の依存関係
（macOS: `otool -L` / Windows: PEインポートテーブル）で確認した必要分だけを残す。

specファイルから `keep()` を呼び出して `a.binaries` / `a.datas` をふるいにかける。
テストからも同じ関数を検証できるよう、PyInstallerに依存しないモジュールにしてある。

同梱物を減らしたことで動かなくなった場合は、対応する KEEP_* に名前を足す。
"""

from __future__ import annotations

import re
from pathlib import PurePosixPath

# QtWebEngineWidgetsから推移的にたどれるQtモジュール。
# macOSは17個（QtDBusを含む）、Windowsは16個で、QtSvgはSVG画像プラグイン用に足している。
KEEP_QT_LIBS = {
    "QtCore",
    "QtDBus",
    "QtGui",
    "QtNetwork",
    "QtOpenGL",
    "QtPositioning",
    "QtPrintSupport",
    "QtQml",
    "QtQmlMeta",
    "QtQmlModels",
    "QtQmlWorkerScript",
    "QtQuick",
    "QtQuickWidgets",
    "QtSvg",
    "QtWebChannel",
    "QtWebEngineCore",
    "QtWebEngineWidgets",
    "QtWidgets",
}

# Python側から使うバインディングのみ。C++ライブラリ本体（KEEP_QT_LIBS）とは別で、
# 例えばQtOpenGLは本体は必要だがバインディングは不要（macOSで21MB）。
KEEP_BINDINGS = {
    "QtCore",
    "QtGui",
    "QtNetwork",
    "QtPrintSupport",
    "QtWebChannel",
    "QtWebEngineCore",
    "QtWebEngineWidgets",
    "QtWidgets",
}

KEEP_PLUGIN_DIRS = {
    "generic",
    "iconengines",
    "imageformats",
    "networkinformation",
    "platforminputcontexts",
    "platforms",
    "platformthemes",
    "styles",
    "tls",
}

# 画像はChromium側がデコードするため、Qtウィジェット層で要るものだけ残す。
# qpdf（123KB）を残すとQtPdf（15MB）が丸ごと付いてくる。
KEEP_IMAGEFORMATS = {"qgif", "qico", "qjpeg", "qsvg"}

# QtWebEngineのUI文言（右クリックメニュー等）。日本語と英語で足りる。
KEEP_LOCALES = {"en-US", "ja"}

# macOSはフレームワーク、Windowsは Qt6*.dll という名前で入る
_RE_FRAMEWORK = re.compile(r"(?:^|/)Qt/lib/(Qt\w+)\.framework/")
_RE_QT_DLL = re.compile(r"(?:^|/)Qt6(\w+)\.dll$", re.IGNORECASE)
_RE_BINDING = re.compile(r"(?:^|/)PySide6/(Qt\w+)\.(?:abi3\.so|abi3\.dylib|pyd)$")
_RE_QM = re.compile(r"/translations/[\w@]+\.qm$")


def keep(dest: str) -> bool:
    """同梱物のパス（アーカイブ内の位置）を受け取り、残すならTrueを返す。"""
    d = dest.replace("\\", "/")

    # WebEngineのリソースはmacOSではフレームワーク配下に入るため、
    # Qtモジュールの判定より先に見る必要がある。
    if "qtwebengine_locales/" in d:
        return PurePosixPath(d).stem in KEEP_LOCALES
    if "devtools_resources" in d:
        return False
    # Windowsホイールのみが同梱するデバッグ用リソース（*.debug.pak / *.debug.bin）
    if ".debug." in PurePosixPath(d).name:
        return False
    # 本アプリはQTranslatorを使っていないため、Qt標準UIの翻訳は読み込まれない
    if _RE_QM.search(d):
        return False

    # WebEngineはQtQuickのC++側だけを使い、QMLモジュールは読み込まない
    if "/qml/" in d or d.startswith("qml/"):
        return False
    if "/metatypes/" in d:
        return False

    if "/plugins/" in d:
        tail = d.split("/plugins/", 1)[1]
        category = tail.split("/")[0]
        if category not in KEEP_PLUGIN_DIRS:
            return False
        if category == "imageformats":
            stem = PurePosixPath(tail).stem
            if stem.startswith("lib"):
                stem = stem[3:]
            return stem in KEEP_IMAGEFORMATS
        return True

    match = _RE_FRAMEWORK.search(d) or _RE_QT_DLL.search(d)
    if match:
        name = match.group(1)
        if not name.startswith("Qt"):
            name = "Qt" + name
        return name in KEEP_QT_LIBS

    match = _RE_BINDING.search(d)
    if match:
        return match.group(1) in KEEP_BINDINGS

    # opengl32sw.dll（ソフトウェア描画のフォールバック）やffmpeg一式は
    # 動作する環境を狭めたくないためここで残る（spec.md 13.1.5）
    return True


def filter_entries(entries):
    """(dest, src, typecode) のTOCエントリ列から、残すものだけを返す。"""
    return [entry for entry in entries if keep(entry[0])]
