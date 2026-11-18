# Built by CI from the repository root: docker build -f trailbook/Dockerfile .
ARG BUILD_FROM=ghcr.io/home-assistant/amd64-base-python:3.13-alpine3.24-2026.11.0
FROM ${BUILD_FROM}

ARG BUILD_ARCH=amd64
ARG BUILD_VERSION=dev

# Pure-Python dependencies only: nothing is compiled, also on aarch64.
COPY backend /tmp/backend
RUN pip install --no-cache-dir /tmp/backend && rm -rf /tmp/backend

# /data persists across updates (database, archive); /share, /media and /config are mapped.
ENV TRAILBOOK_DB=/data/trailbook.db \
    TRAILBOOK_ALLOWED_ROOTS=/share:/media:/config \
    TRAILBOOK_EXPORT_DIR=/share/trailbook-exports \
    TRAILBOOK_VERSION=${BUILD_VERSION} \
    PYTHONUNBUFFERED=1

LABEL io.hass.type="addon" io.hass.arch="${BUILD_ARCH}" io.hass.version="${BUILD_VERSION}"

# No s6 services: one process; `init: true` gives it a reaper for the job subprocesses.
# Reached only through Ingress (no published port).
ENTRYPOINT []
CMD ["trailbook", "serve", "--host", "0.0.0.0", "--port", "8099"]
