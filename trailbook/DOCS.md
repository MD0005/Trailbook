# Trailbook

Training log built around Garmin Connect: your whole activity history and every new
activity as maps, charts and statistics. Strava exports and FIT/GPX/TCX files can bring in
older history. Opens from the sidebar (Ingress).

## Data

- Database and imported files: the app's own storage (`/data`), included in HA backups of
  the app.
- Watched folder: choose it in Settings › Data. Allowed: `/share`, `/media` (read only) and
  `/config` (this app's config folder), e.g. `/share/trailbook`.
- Exports: `/share/trailbook-exports`.

## Updates

A new version updates the database automatically on start. An older version cannot open a
database that a newer one has upgraded, so tick *Create backup* in the update dialog if you may
want to go back.
