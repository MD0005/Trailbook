"""Build the Windows app: Trailbook.exe (PyInstaller) and its installer (Inno Setup).

    python windows/build.py            # exe + installer (needs ISCC.exe of Inno Setup 6)
    python windows/build.py --no-installer

Run from the repository root with `backend[desktop]` installed. The version comes from
trailbook/config.yaml, the same one Home Assistant gets. Output: windows/out/.
"""

from __future__ import annotations

import argparse
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
OUT = HERE / "out"
VERSION_PY = ROOT / "backend" / "src" / "trailbook" / "_version.py"


def version() -> str:
    text = (ROOT / "trailbook" / "config.yaml").read_text(encoding="utf-8")
    return re.search(r'^version:\s*"([^"]+)"', text, re.M).group(1)


def icon() -> None:
    from PIL import Image

    img = Image.open(ROOT / "trailbook" / "icon.png").convert("RGBA")
    sizes = [(s, s) for s in (16, 24, 32, 48, 64, 128, 256)]
    img.save(OUT / "trailbook.ico", sizes=sizes)


def version_info(v: str) -> None:
    nums = ", ".join((v.split(".") + ["0"] * 4)[:4])
    (OUT / "version-info.txt").write_text(
        f"""VSVersionInfo(
  ffi=FixedFileInfo(filevers=({nums}), prodvers=({nums})),
  kids=[
    StringFileInfo([StringTable('040904B0', [
      StringStruct('CompanyName', 'Trailbook'),
      StringStruct('FileDescription', 'Trailbook'),
      StringStruct('FileVersion', '{v}'),
      StringStruct('ProductName', 'Trailbook'),
      StringStruct('ProductVersion', '{v}')])]),
    VarFileInfo([VarStruct('Translation', [1033, 1200])])
  ]
)
""",
        encoding="utf-8",
    )


def iscc() -> str | None:
    found = shutil.which("ISCC") or shutil.which("iscc")
    if found:
        return found
    for base in (os.environ.get("ProgramFiles(x86)"), os.environ.get("ProgramFiles")):
        if base and (Path(base) / "Inno Setup 6" / "ISCC.exe").is_file():
            return str(Path(base) / "Inno Setup 6" / "ISCC.exe")
    return None


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--no-installer", action="store_true")
    args = parser.parse_args()

    v = version()
    OUT.mkdir(exist_ok=True)
    VERSION_PY.write_text(f'VERSION = "{v}"\n', encoding="utf-8")
    try:
        icon()
        version_info(v)
        subprocess.run(
            [
                sys.executable, "-m", "PyInstaller", str(HERE / "trailbook.spec"), "--noconfirm",
                "--distpath", str(OUT / "dist"), "--workpath", str(OUT / "work"),
            ],
            check=True,
        )  # fmt: skip
    finally:
        VERSION_PY.unlink(missing_ok=True)
    print(f"Built {OUT / 'dist' / 'Trailbook' / 'Trailbook.exe'} ({v})")

    if args.no_installer:
        return 0
    compiler = iscc()
    if not compiler:
        print("Inno Setup 6 (ISCC.exe) not found: no installer.", file=sys.stderr)
        return 1
    subprocess.run(
        [compiler, f"/DAppVersion={v}", f"/O{OUT}", str(HERE / "trailbook.iss")], check=True
    )
    print(f"Built {OUT / f'Trailbook-Setup-{v}.exe'}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
