"""設定の永続化（spec.md 12章）の検証。Qt非依存。

1. 置き場所の解決（開発実行 / Windows相当のexe / macOSの .app）
2. 既定値・破損ファイル・型違い・許可外の値からの復帰
3. 知らないキーを捨てずに書き戻す
4. 原子的な書き込み（一時ファイルを残さない）
5. 書き込めない場所でも例外を投げず、保存失敗として扱う

実行: .venv/bin/python tests/test_settings.py
"""
import json
import os
import shutil
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from markdown_editor import settings as settings_mod  # noqa: E402
from markdown_editor.settings import SETTINGS_FILENAME, Settings, settings_dir  # noqa: E402

# macOSでは /var が /private/var へのシンボリックリンクのため、
# settings_dir() 側の resolve() と比較できるよう先に解決しておく
tmpdir = Path(tempfile.mkdtemp(prefix="md_settings_test_")).resolve()

# ---- 1. 置き場所の解決（spec.md 12.3） ----
# 開発実行ではリポジトリ直下
repo_root = Path(settings_mod.__file__).resolve().parents[2]
assert settings_dir() == repo_root, settings_dir()
print("DEV DIR OK")


class FrozenAs:
    """frozen 実行を模して sys.frozen / sys.executable を差し替える。"""

    def __init__(self, executable: str) -> None:
        self.executable = executable

    def __enter__(self):
        self._had_frozen = hasattr(sys, "frozen")
        self._old_frozen = getattr(sys, "frozen", None)
        self._old_exe = sys.executable
        sys.frozen = True
        sys.executable = self.executable
        return self

    def __exit__(self, *exc):
        sys.executable = self._old_exe
        if self._had_frozen:
            sys.frozen = self._old_frozen
        else:
            del sys.frozen
        return False


# Windows / macOS単体バイナリ相当: 実行ファイルと同じフォルダ
with FrozenAs(str(tmpdir / "apps" / "Markdown Editor")):
    (tmpdir / "apps").mkdir(parents=True, exist_ok=True)
    assert settings_dir() == (tmpdir / "apps"), settings_dir()
print("FROZEN PLAIN EXE DIR OK")

# macOSの .app: Contents/MacOS ではなく .app を含むフォルダに置く
app_exe = tmpdir / "apps" / "Markdown Editor.app" / "Contents" / "MacOS" / "Markdown Editor"
app_exe.parent.mkdir(parents=True, exist_ok=True)
with FrozenAs(str(app_exe)):
    got = settings_dir()
assert got == (tmpdir / "apps"), f".appを含むフォルダを使うこと: {got}"
assert ".app" not in str(got), got
print("FROZEN MACOS APP DIR OK")

# ---- 2. 既定値と復帰 ----
path = tmpdir / SETTINGS_FILENAME

# ファイルが無い状態
s = Settings(path)
assert s.get_str("view", "contentWidth", "standard") == "standard"
assert not path.exists(), "読むだけでファイルを作らない"
print("MISSING FILE OK")

# 書き込みと読み直し
assert s.set("view", "contentWidth", "wide")
assert path.exists()
assert Settings(path).get_str("view", "contentWidth", "standard") == "wide"
data = json.loads(path.read_text(encoding="utf-8"))
assert data["version"] == 1, data
assert list(data)[0] == "version", "versionを先頭に置く"
print("ROUNDTRIP OK")

# 壊れたJSON → 既定値で起動できる
path.write_text("{壊れている", encoding="utf-8")
assert Settings(path).get_str("view", "contentWidth", "standard") == "standard"
print("CORRUPT FILE OK")

# トップレベルが辞書でない
path.write_text('["配列"]', encoding="utf-8")
assert Settings(path).get_str("view", "contentWidth", "standard") == "standard"
# セクションが辞書でない / 値が文字列でない
path.write_text('{"view": "文字列"}', encoding="utf-8")
assert Settings(path).get_str("view", "contentWidth", "standard") == "standard"
path.write_text('{"view": {"contentWidth": 123}}', encoding="utf-8")
assert Settings(path).get_str("view", "contentWidth", "standard") == "standard"
print("WRONG TYPES OK")

# 許可外の値 → 既定値
path.write_text('{"view": {"contentWidth": "huge"}}', encoding="utf-8")
got = Settings(path).get_str(
    "view", "contentWidth", "standard", allowed=("standard", "wide", "full")
)
assert got == "standard", got
print("DISALLOWED VALUE OK")

# ---- 3. 知らないキーを保持する ----
path.write_text(
    json.dumps({"version": 99, "view": {"contentWidth": "full", "未知": 1}, "future": {"a": 2}}),
    encoding="utf-8",
)
s = Settings(path)
assert s.set("view", "contentWidth", "wide")
data = json.loads(path.read_text(encoding="utf-8"))
assert data["future"] == {"a": 2}, data
assert data["view"]["未知"] == 1, data
assert data["view"]["contentWidth"] == "wide", data
print("UNKNOWN KEYS PRESERVED OK")

# ---- 4. 原子的な書き込み ----
assert not (tmpdir / (SETTINGS_FILENAME + ".tmp")).exists(), "一時ファイルを残さない"
# 値が変わらない場合は書き込まない
before = path.stat().st_mtime_ns
assert s.set("view", "contentWidth", "wide")
assert path.stat().st_mtime_ns == before, "同じ値なら書き直さない"
print("ATOMIC WRITE OK")

# ---- 5. 書き込めない場所 ----
ro = tmpdir / "readonly"
ro.mkdir()
os.chmod(ro, 0o500)
try:
    s2 = Settings(ro / "sub" / SETTINGS_FILENAME)
    assert s2.get_str("view", "contentWidth", "standard") == "standard"
    assert s2.set("view", "contentWidth", "full") is False, "保存できないことを返す"
    assert s2.save_failed
    # メモリ上では保持している（この起動中のみ有効）
    assert s2.get_str("view", "contentWidth", "standard") == "full"
    assert not (ro / "sub").exists(), "書けない場所に何も作らない"
finally:
    os.chmod(ro, 0o700)
print("READONLY LOCATION OK")

shutil.rmtree(tmpdir, ignore_errors=True)
print("ALL SETTINGS TESTS PASSED")
