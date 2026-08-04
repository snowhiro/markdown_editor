"""PyInstaller用エントリポイント。

main.py を直接エントリスクリプトにすると `__main__` として実行され、
パッケージに属さないため `from . import excel_import` のような相対importが
「attempted relative import with no known parent package」で失敗する。
pyproject.toml の `markdown-editor` コマンドと同様に
`markdown_editor.main` としてimportしてから実行する。
"""

import sys

from markdown_editor.main import main

if __name__ == "__main__":
    sys.exit(main())
