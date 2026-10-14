"""Stopwatch for the response's timing block (fetch and compute kept apart)."""
import time
from contextlib import contextmanager


class Timings:
    def __init__(self):
        self.ms = {}

    @contextmanager
    def part(self, name):
        t = time.perf_counter()
        try:
            yield
        finally:
            self.ms[name] = self.ms.get(name, 0.0) + (time.perf_counter() - t) * 1000.0

    def rounded(self):
        return {k: round(v, 1) for k, v in self.ms.items()}
