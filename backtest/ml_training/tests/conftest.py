"""Shared fixtures. Puts the package root on sys.path so `import mltrain` works
whether pytest is invoked from the repo root or from backtest/ml_training/."""

from __future__ import annotations

import sys
from pathlib import Path

import numpy as np
import pytest

PACKAGE_ROOT = Path(__file__).resolve().parents[1]
if str(PACKAGE_ROOT) not in sys.path:
    sys.path.insert(0, str(PACKAGE_ROOT))


@pytest.fixture
def rng() -> np.random.Generator:
    """Deterministic generator — tests must never depend on ambient randomness."""
    return np.random.default_rng(1234)


@pytest.fixture
def separable_dataset(rng: np.random.Generator) -> tuple[np.ndarray, np.ndarray, list[str]]:
    """Small learnable dataset: feature 0 carries the signal, the rest is noise."""
    n, k = 600, 4
    X = rng.normal(size=(n, k)).astype(np.float32)
    logits = 2.5 * X[:, 0]
    y = (rng.uniform(size=n) < 1.0 / (1.0 + np.exp(-logits))).astype(np.int32)
    return X, y, [f"f{i}" for i in range(k)]
