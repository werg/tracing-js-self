#!/usr/bin/env python3
"""Direct V8 release package command; verify the complete adjacent driver before execution."""
from __future__ import annotations

import hashlib
import importlib.util
from pathlib import Path

IMPLEMENTATION_SHA256 = "fe571363f55b2be739c61c939e45263e0b876ca346d0c7e06ad325a47dedf20c"
_path = Path(__file__).with_name("semantic_release_v8.py")
with _path.open("rb") as _stream:
    _source = _stream.read(1024 * 1024 + 1)
if len(_source) > 1024 * 1024 or hashlib.sha256(_source).hexdigest() != IMPLEMENTATION_SHA256:
    raise ValueError("Pinned direct V8 release implementation changed")
_spec = importlib.util.spec_from_file_location("direct_v8_release", _path)
_driver = importlib.util.module_from_spec(_spec)
exec(compile(_source, str(_path), "exec", dont_inherit=True), _driver.__dict__)  # noqa: S102 - execute only the bounded, independently pinned source bytes

if __name__ == "__main__":
    raise SystemExit(_driver.main("package"))
