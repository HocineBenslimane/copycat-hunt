import os
from functools import lru_cache
from pathlib import Path

import yaml

DEFAULT_PATH = Path(__file__).resolve().parent.parent / "config" / "default.yaml"

def load(path=None):
    path = Path(path or os.environ.get("COPYCAT_VISION_CONFIG") or DEFAULT_PATH)
    with open(path, encoding="utf-8") as f:
        cfg = yaml.safe_load(f)
    w = os.environ.get("COPYCAT_COMPUTE_WORKERS")
    if w and w.isdigit() and 1 <= int(w) <= 16:
        cfg["limits"]["computeWorkers"] = int(w)
    return cfg

@lru_cache(maxsize=1)
def get():
    return load()
