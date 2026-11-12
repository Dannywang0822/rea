#!/usr/bin/env python3
"""Extract a local zip, APK, or XAPK into a destination directory.

Refuses absolute entry names, parent segments, and symlink entries. Stops when
the declared uncompressed size exceeds the caller-supplied budget. This script
does not upload anything.
"""

from __future__ import annotations

import os
import sys
import zipfile
from pathlib import Path


def unsafe(name: str) -> str | None:
    normalized = name.replace("\\", "/")
    if normalized.startswith("/") or (len(normalized) >= 2 and normalized[1] == ":"):
        return normalized
    parts = [part for part in normalized.split("/") if part not in ("", ".")]
    if any(part == ".." for part in parts):
        return normalized
    return None


def main() -> None:
    if len(sys.argv) != 4:
        sys.exit(
            "usage: unpack_archive.py <archive> <destination> <uncompressed-budget-bytes>"
        )
    archive, destination, budget_text = sys.argv[1:4]
    budget = int(budget_text)
    root = Path(destination).resolve()
    root.mkdir(parents=True, exist_ok=True)
    total = 0
    with zipfile.ZipFile(archive) as package:
        for info in package.infolist():
            escaped = unsafe(info.filename)
            if escaped is not None:
                sys.exit(f"unsafe zip entry: {escaped}")
            unix_mode = (info.external_attr >> 16) & 0o170000
            if unix_mode == 0o120000:
                sys.exit(f"symlink zip entry refused: {info.filename}")
            total += info.file_size
            if total > budget:
                sys.exit(
                    f"uncompressed size exceeds budget of {budget} bytes"
                )
            parts = [
                part
                for part in info.filename.replace("\\", "/").split("/")
                if part not in ("", ".")
            ]
            target = root.joinpath(*parts).resolve() if parts else root
            if target != root and root not in target.parents:
                sys.exit(f"zip entry escapes destination: {info.filename}")
            if info.is_dir() or info.filename.endswith("/"):
                target.mkdir(parents=True, exist_ok=True)
                continue
            target.parent.mkdir(parents=True, exist_ok=True)
            remaining = info.file_size
            with package.open(info, "r") as source, target.open("wb") as output:
                while remaining > 0:
                    chunk = source.read(min(1024 * 1024, remaining))
                    if not chunk:
                        break
                    output.write(chunk)
                    remaining -= len(chunk)
    print(f"ok {total}")


if __name__ == "__main__":
    try:
        main()
    except zipfile.BadZipFile as cause:
        sys.exit(f"not a zip archive: {cause}")
