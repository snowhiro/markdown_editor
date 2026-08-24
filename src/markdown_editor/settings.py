"""アプリ設定の永続化（spec.md 12章）。

レジストリやOSの設定データベースは使わず、実行ファイルと同じ場所に置いた
JSONファイル1つで完結させる（USBメモリ等での持ち運びを想定し、マシンの
他の場所に痕跡を残さない）。

設定ファイルが壊れていてもアプリが起動できなくなることは避け、
その項目を既定値として扱って続行する。
"""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path
from typing import Any, Sequence

SETTINGS_FILENAME = "markdown-editor-settings.json"
SCHEMA_VERSION = 1


def settings_dir() -> Path:
    """設定ファイルを置くフォルダを返す（spec.md 12.3）。

    PyInstallerのonefileでは実行ファイルの隣に置く。ただしmacOSの .app では
    実行ファイルが `<App>.app/Contents/MacOS/` にあり、そこへ書くとコード署名が
    壊れる上にアプリの入れ替えで設定が消えるため、.app を含むフォルダを使う。

    展開先の一時ディレクトリ（`sys._MEIPASS`）は終了時に削除されるため使わない。
    """
    if getattr(sys, "frozen", False):
        exe = Path(sys.executable).resolve()
        parents = exe.parents
        # parents[2] が `<App>.app` なら parents[3] が .app を含むフォルダ
        if len(parents) >= 4 and parents[2].suffix == ".app":
            return parents[3]
        return exe.parent
    # 開発実行（PyInstaller未使用）ではリポジトリ直下に置く
    return Path(__file__).resolve().parents[2]


def settings_path() -> Path:
    return settings_dir() / SETTINGS_FILENAME


class Settings:
    """JSONファイルによる設定の読み書き。

    知らないキーは捨てずに保持して書き戻す。新しいバージョンのアプリが
    書いた設定を、古いバージョンで起動した際に失わないようにするため。
    """

    def __init__(self, path: Path | None = None) -> None:
        self.path = Path(path) if path is not None else settings_path()
        self._data: dict[str, Any] = {}
        # 一度でも保存に失敗したか（読み取り専用の場所に置かれた場合など）
        self.save_failed = False
        self.load()

    def load(self) -> None:
        try:
            raw = json.loads(self.path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            # ファイルが無い・壊れている場合は既定値で起動する
            raw = None
        self._data = raw if isinstance(raw, dict) else {}

    def get_str(
        self,
        section: str,
        key: str,
        default: str,
        allowed: Sequence[str] | None = None,
    ) -> str:
        """文字列設定を読む。型が違う・許可外の値なら既定値を返す。"""
        values = self._data.get(section)
        if not isinstance(values, dict):
            return default
        value = values.get(key)
        if not isinstance(value, str):
            return default
        if allowed is not None and value not in allowed:
            return default
        return value

    def set(self, section: str, key: str, value: Any) -> bool:
        """設定を書き換えて即座に保存する。保存できた場合にTrueを返す。"""
        values = self._data.get(section)
        if not isinstance(values, dict):
            values = {}
            self._data[section] = values
        if values.get(key) == value:
            return not self.save_failed  # 変化が無いので書き込まない
        values[key] = value
        return self.save()

    def save(self) -> bool:
        """一時ファイル経由で原子的に書き出す。

        書き込み途中で中断しても壊れたファイルが残らないようにする。
        失敗しても例外は投げず、呼び出し側が通知だけ行えるようにFalseを返す。
        """
        self._data["version"] = SCHEMA_VERSION
        # versionを先頭に置いて読みやすくする（知らないキーはそのまま書き戻す）
        ordered = {"version": SCHEMA_VERSION}
        ordered.update({k: v for k, v in self._data.items() if k != "version"})
        tmp = self.path.with_name(self.path.name + ".tmp")
        try:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            tmp.write_text(
                json.dumps(ordered, ensure_ascii=False, indent=2) + "\n",
                encoding="utf-8",
                newline="\n",
            )
            os.replace(tmp, self.path)
        except OSError:
            try:
                tmp.unlink()
            except OSError:
                pass
            self.save_failed = True
            return False
        return True
