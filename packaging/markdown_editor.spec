# -*- mode: python ; coding: utf-8 -*-
"""PyInstaller spec: Markdown Editor の配布用アプリを生成する。

onefile（単一実行ファイル）でビルドする。

macOS: dist/Markdown Editor.app
Windows: dist/Markdown Editor.exe

実行:
    pyinstaller packaging/markdown_editor.spec
"""

import sys
from pathlib import Path

block_cipher = None

# このspecファイルはリポジトリ直下から `pyinstaller packaging/markdown_editor.spec`
# として実行される想定（PyInstallerはCWDを基準にパスを解決するため、
# __file__ ではなく os.getcwd() 相当のリポジトリ直下を起点にする）。
REPO_ROOT = Path.cwd()
WEB_DIR = REPO_ROOT / "src" / "markdown_editor" / "web"

a = Analysis(
    # main.py を直接指定すると `__main__` として実行され、パッケージ内の
    # 相対import（main.py の `from . import excel_import`）が失敗する。
    # packaging/entry.py 経由で markdown_editor パッケージとして読み込む。
    [str(REPO_ROOT / "packaging" / "entry.py")],
    pathex=[str(REPO_ROOT / "src")],
    binaries=[],
    # web/ 以下（HTML/JS/CSS/vendorライブラリ）をアプリ内へ同梱する。
    # main.py の WEB_DIR は実行ファイル基準の相対パスで探すため、
    # 展開後も markdown_editor/web に配置されるようにする。
    datas=[(str(WEB_DIR), "markdown_editor/web")],
    # openpyxl は main.py が実行時に遅延インポートするため明示的に含める
    # （Excel → Markdown 変換 / spec.md 11章）
    hiddenimports=["openpyxl"],
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[],
    noarchive=False,
    cipher=block_cipher,
)

pyz = PYZ(a.pure, a.zipped_data, cipher=block_cipher)

# onefile: バイナリ・データをすべてEXEへ取り込み、単一の実行ファイルを生成する。
# （実行時は一時ディレクトリへ展開され、main.py が sys._MEIPASS 基準で web/ を解決する）
exe = EXE(
    pyz,
    a.scripts,
    a.binaries,
    a.zipfiles,
    a.datas,
    [],
    exclude_binaries=False,
    name="Markdown Editor",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    upx_exclude=[],
    runtime_tmpdir=None,
    console=False,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
)

if sys.platform == "darwin":
    app = BUNDLE(
        exe,
        name="Markdown Editor.app",
        icon=None,
        bundle_identifier="com.example.markdowneditor",
        info_plist={
            "CFBundleName": "Markdown Editor",
            "CFBundleDisplayName": "Markdown Editor",
            "CFBundleShortVersionString": "0.1.0",
            "NSHighResolutionCapable": True,
            "CFBundleDocumentTypes": [
                {
                    "CFBundleTypeName": "Markdown Document",
                    "CFBundleTypeExtensions": ["md", "markdown"],
                    "CFBundleTypeRole": "Editor",
                }
            ],
        },
    )
