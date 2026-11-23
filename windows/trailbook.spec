# PyInstaller spec of the Windows app; run through windows/build.py.
# One folder (not one file): starts faster and antivirus programs flag it less often.
from pathlib import Path

ROOT = Path(SPECPATH).parent
SRC = ROOT / "backend" / "src" / "trailbook"

a = Analysis(
    [str(Path(SPECPATH) / "entry.py")],
    pathex=[str(ROOT / "backend" / "src")],
    datas=[
        (str(SRC / "static"), "trailbook/static"),
        (str(ROOT / "trailbook" / "icon.png"), "."),
    ],
    # imported lazily or by name (uvicorn picks its loop / protocol at run time)
    hiddenimports=[
        "trailbook.cli",
        "uvicorn.logging",
        "uvicorn.loops.auto",
        "uvicorn.protocols.http.auto",
        "uvicorn.protocols.http.h11_impl",
        "uvicorn.lifespan.on",
        "pystray._win32",
    ],
    excludes=["tkinter", "numpy", "pandas", "pytest"],
)
pyz = PYZ(a.pure)
exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name="Trailbook",
    icon=str(Path(SPECPATH) / "out" / "trailbook.ico"),
    console=False,  # no console window: the tray icon is the app
    version=str(Path(SPECPATH) / "out" / "version-info.txt"),
)
coll = COLLECT(exe, a.binaries, a.datas, name="Trailbook")
