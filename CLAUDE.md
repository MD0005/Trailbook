# Trailbook — notes for Claude

- **Git:** always work on `main` and commit directly to `main`. No feature branches, no PRs.
- **Add-on release:** a commit that should reach Home Assistant bumps `version` in
  `trailbook/config.yaml` (patch: `0.1.0` → `0.1.1`); CI builds the images only for a new
  version. Never edit a released migration — append a new one (`db.MIGRATIONS`).
- **Changelog:** every release adds a section `## <version>` on top of `trailbook/CHANGELOG.md`
  (Home Assistant shows it in the update dialog): `### Added` / `### Changed` / `### Fixed`
  (`### Docs` when needed), one short user-facing line per change, no internals. Older
  releases are not filled in.
- Talk to the owner in Polish; code, comments, docs and UI strings are English (PL via translations).
- Target hardware: Home Assistant Yellow (Raspberry Pi CM4, aarch64). Every dependency must
  have prebuilt aarch64 wheels or be pure Python. No pandas/pyarrow/numpy-heavy stacks in
  the API process. Idle CPU ~0, idle RAM as small as possible.
- Spec: `docs/SPEC.md` — keep it in sync when decisions change.
- Local test data lives in `sample-data/<person>/` (git-ignored, contains personal data —
  never commit it, never copy file names or contents into code, tests or commit messages).
- Dev setup: `python -m venv .venv`, `.venv/Scripts/python -m pip install -e "backend[dev]"`.
  Tests: `cd backend && ../.venv/Scripts/python -m pytest` (~10 s). The tests on the local
  `sample-data/` (marker `samples`) take minutes and run only with `--samples`: before a
  release or after importer changes. Lint: `ruff check` + `ruff format`.
- The UI design comes from the owner; until then the frontend is a plain technical preview.
- **Numbers in the UI: decimal comma, space between thousands** (`1 234,56 km`), everywhere —
  always format through `num()` in `preview.js`, never `toFixed()` for displayed values.
- UI rules (one button style, controls, maps, defaults) are in `docs/SPEC.md` › UI rules;
  charts in `docs/CHARTS.md`.
- How computed values work (formulas, weights, limits) goes into `docs/MANUAL.md`; keep it in
  sync when a calculation changes.
