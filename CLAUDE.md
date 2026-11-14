# Trailbook — notes for Claude

- **Git:** always work on `main` and commit directly to `main`. No feature branches, no PRs.
- Talk to the owner in Polish; code, comments, docs and UI strings are English (PL via translations).
- Target hardware: Home Assistant Yellow (Raspberry Pi CM4, aarch64). Every dependency must
  have prebuilt aarch64 wheels or be pure Python. No pandas/pyarrow/numpy-heavy stacks in
  the API process. Idle CPU ~0, idle RAM as small as possible.
- Spec: `docs/SPEC.md` — keep it in sync when decisions change.
- Local test data lives in `sample-data/<person>/` (git-ignored, contains personal data —
  never commit it, never copy file names or contents into code, tests or commit messages).
- Dev setup: `python -m venv .venv`, `.venv/Scripts/python -m pip install -e "backend[dev]"`.
  Tests: `cd backend && ../.venv/Scripts/python -m pytest`. Lint: `ruff check` + `ruff format`.
- The UI design comes from the owner; until then the frontend is a plain technical preview.
