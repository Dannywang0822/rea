#!/usr/bin/env python3
"""Write Unity TextAsset bytes from a merged player data directory.

Local read only. Output names stay inside the destination directory.
"""

from __future__ import annotations

import os
import sys


def main() -> None:
    if len(sys.argv) != 3:
        sys.exit("usage: dump_textassets.py <data-directory> <output-directory>")
    data, output = sys.argv[1:3]
    os.makedirs(output, exist_ok=True)
    root = os.path.realpath(output)
    import UnityPy

    print(f"UNITYPY {getattr(UnityPy, '__version__', 'unknown')}", flush=True)
    environment = UnityPy.load(data)
    count = 0
    for obj in environment.objects:
        if obj.type.name != "TextAsset":
            continue
        asset = obj.read()
        script = asset.m_Script
        raw = (
            script.encode("utf-8", "surrogateescape")
            if isinstance(script, str)
            else bytes(script)
        )
        leaf = f"{asset.m_Name}__{obj.assets_file.name[:8]}_{obj.path_id}.txt"
        safe = leaf.replace("/", "_").replace("\\", "_").replace("\x00", "_")
        if safe in ("", ".", ".."):
            continue
        target = os.path.realpath(os.path.join(root, safe))
        if os.path.dirname(target) != root:
            continue
        with open(target, "wb") as handle:
            handle.write(raw)
        count += 1
    print(f"TEXTASSETS {count}", flush=True)


if __name__ == "__main__":
    main()
