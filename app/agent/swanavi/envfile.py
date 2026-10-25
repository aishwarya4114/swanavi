"""Load gitignored local environment files without printing secrets.

Values may be wrapped in a single pair of single or double quotes. The quotes
are not part of the token. Existing process environment variables win.
"""

from __future__ import annotations

import os
from pathlib import Path


def load_local_env() -> None:
    for candidate in _candidates():
        if candidate.is_file():
            _apply(candidate)
            return


def _candidates() -> list[Path]:
    here = Path(__file__).resolve()
    found = []
    for parent in here.parents:
        found.append(parent / "agentcore" / ".env.local")
        found.append(parent / ".env.local")
    return found


def _apply(path: Path) -> None:
    for raw in path.read_text().splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        if line.startswith("export "):
            line = line[len("export "):].strip()
        key, val = line.split("=", 1)
        key = key.strip()
        if not key or key in os.environ:
            continue
        os.environ[key] = _unquote(val.strip())


def _unquote(value: str) -> str:
    if len(value) >= 2 and value[0] == value[-1] and value[0] in "'\"":
        return value[1:-1]
    return value
