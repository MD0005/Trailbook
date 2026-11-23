"""Trailbook — self-hosted training log."""

import os

try:  # written by the Windows build (windows/build.py), not in the repository
    from ._version import VERSION as _BUILT
except ImportError:
    _BUILT = None

# The add-on image sets its version, so the UI shows which update is running.
__version__ = os.environ.get("TRAILBOOK_VERSION") or _BUILT or "0.1.0"

# Bump when the importer starts producing different or additional data,
# so older activities can be reprocessed.
# v2: activity types; v3: more stream channels; v4: workout targets;
# v5: time in zones, metabolic calories; v6: devices; v7: stamina fields
IMPORTER_VERSION = 9
