"""Entry of Trailbook.exe (PyInstaller): the Windows app, or the CLI with arguments."""

from trailbook.desktop import main

if __name__ == "__main__":
    raise SystemExit(main())
