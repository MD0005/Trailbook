# Trailbook

Training log for FIT files: activity list, route map, statistics and charts. Opens from the
sidebar (Ingress).

## Data

- Database and imported files: the add-on's own storage (`/data`), included in HA backups of
  the add-on.
- Watched folder: choose it in Settings › General. Allowed: `/share`, `/media` (read only) and
  `/config` (this add-on's config folder), e.g. `/share/trailbook`.
- Exports: `/share/trailbook-exports`.

## Updates

A new version updates the database automatically on start. An older version cannot open a
database that a newer one has upgraded, so tick *Create backup* in the update dialog if you may
want to go back.
