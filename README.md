# Trailbook

Self-hosted training log for Home Assistant. Drop FIT files into a folder and Trailbook
turns them into statistics, a map of every route you have ever done and detailed
per-activity charts — all running on your own HA box, including small ARM boards
like the Home Assistant Yellow.

> **Status:** early development. Nothing to install yet.
> See the [specification](docs/SPEC.md) for the plan.

## Planned features

- Automatic import of FIT files (from HA automations, Garmin exports or by hand),
  with duplicate detection and sleep/monitoring files skipped.
- Multiple people — one subfolder per person.
- Map of all routes with a heatmap effect.
- Statistics per sport, week, month and year.
- Fitness / fatigue / form, training load, power and pace curves.
- Per-activity charts: heart rate, pace, power, cadence, elevation, laps.
- Light on resources: near-zero CPU when idle.
- One-click export to a ZIP (database, settings and all FIT files) to move to a new device.
- English and Polish UI.

## Folder layout

```
/share/trailbook/
├── alice/   ← each subfolder is one person
└── bob/
```

## License

[MIT](LICENSE).
