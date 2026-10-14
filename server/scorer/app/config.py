"""Settings from config/default.yaml (or the file in COPYCAT_VISION_CONFIG)."""
import os
from functools import lru_cache
from pathlib import Path

import yaml

DEFAULT_PATH = Path(__file__).resolve().parent.parent / "config" / "default.yaml"


def load(path=None):
    path = Path(path or os.environ.get("COPYCAT_VISION_CONFIG") or DEFAULT_PATH)
    with open(path, encoding="utf-8") as f:
        return yaml.safe_load(f)


@lru_cache(maxsize=1)
def get():
    return load()
