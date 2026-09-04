"""Meta-labeling: the take/skip dataset built from the bot's own trade journal.

López de Prado's meta-labeling (Advances in Financial Machine Learning, ch. 3)
leaves the primary model completely alone and asks a narrower question of a much
simpler secondary model: GIVEN that the primary signal already fired and picked
a side, is THIS particular bet one worth taking? Direction stays with the
primary ensemble; the meta-labeler only ever votes take/skip (or size). That
asymmetry is why it is worth evaluating: a null result costs nothing, because
"no useful secondary signal" simply means the bot keeps taking every primary
signal, which is exactly what it does today.

This module owns the DATA half of that question — which journal rows carry a
real label, how a decision-time context becomes a fixed-order feature vector,
and where the train/test boundary may honestly be drawn. `mltrain.meta_eval`
owns the model and the metrics.

Why this is written defensively: the training set is a few hundred resolved
bets, not the tens of thousands of rows the primary model sees. At that size an
unpurged boundary or a shuffled split will manufacture a beautiful AUC out of
pure noise. So rows are ordered by DECISION time, the split embargoes rows after
the boundary the way `mltrain.cv` does, and a 15-minute market whose slug
straddles the boundary is purged from the test side entirely.

Pure logic: journal dicts in, frozen dataclasses out. The only side effect is
the injected `log` callable, which trainMetaLabeler.py wires to `print`.
"""

from __future__ import annotations

import json
import math
from collections.abc import Callable, Iterable, Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path

import numpy as np

# --- Row eligibility -------------------------------------------------------
#
# DRY_RUN rows never had capital at risk (they dominate the journal ~2:1) and
# REJECTED rows never became a position at all, so neither carries a real
# take/skip label. Everything else did open a position and did resolve, so it
# belongs in the population a take/skip model would have had to judge —
# including CUT_LOSS, which is where the expensive mistakes live. Dropping
# CUT_LOSS would quietly delete the worst outcomes and flatter the base rate.
DEFAULT_ELIGIBLE_OUTCOMES: tuple[str, ...] = (
    "WIN",
    "LOSS",
    "CUT_LOSS",
    "PARTIAL_CUT",
    "UNWIND",
)
# Settlement-only population: excludes positions closed early by the cut-loss
# policy, whose outcome is confounded by that policy rather than by the signal.
SETTLED_ELIGIBLE_OUTCOMES: tuple[str, ...] = ("WIN", "LOSS")
WIN_OUTCOME = "WIN"

# --- Feature encoding ------------------------------------------------------
#
# One-hot levels drop a reference category (EARLY / Asia) so the intercept
# absorbs it; an unseen level lands on the all-zero reference, which is the safe
# default for a linear model.
PHASE_LEVELS: tuple[str, ...] = ("MID", "LATE", "VERY_LATE")
SESSION_LEVELS: tuple[str, ...] = ("Europe", "US", "EU/US Overlap", "Off-hours")
# The primary signal's own confidence ladder, as an ordinal. Non-ladder labels
# (LIMIT*, PREMARKET) get rank 0 and are flagged by their own binary features.
CONFIDENCE_RANKS: dict[str, float] = {
    "LOW": 0.25,
    "MEDIUM": 0.50,
    "HIGH": 0.75,
    "VERY_HIGH": 1.00,
}

# Constant (not data-derived) fill values for optional journal fields. Constants
# rather than a train-set median on purpose: a median computed from the data
# would have to be recomputed per split to stay leak-free, and would then differ
# between the exported model and every evaluation fold.
NEUTRAL_TOKEN_PRICE = 0.5
NEUTRAL_TIME_LEFT_MIN = 7.5
NEUTRAL_COST = 0.0
NEUTRAL_SIZE = 0.0
NEUTRAL_ML_PROB_WIN = 0.5
NEUTRAL_BEST_EDGE = 0.0
NEUTRAL_SPREAD = 0.01

FEATURE_NAMES: tuple[str, ...] = (
    "token_price",
    "time_left_min",
    "cost",
    "size",
    "side_is_up",
    "phase_mid",
    "phase_late",
    "phase_very_late",
    "session_europe",
    "session_us",
    "session_eu_us_overlap",
    "session_off_hours",
    "confidence_rank",
    "confidence_is_limit",
    "confidence_is_premarket",
    "ml_prob_win",
    "best_edge",
    "spread",
    "signal_fields_missing",
    "ptb_edge_bps",
)

# --- Evaluation defaults ---------------------------------------------------
DEFAULT_TEST_SIZE = 0.25
# Rows, not minutes. A journal row's label resolves up to ~15 minutes after its
# decision, so the first few test decisions were taken while training-row
# outcomes were still open. Same idea as the embargo in mltrain.cv.
DEFAULT_EMBARGO = 5


def _as_float(value: object) -> float | None:
    """Coerce an untrusted journal field to a finite float, else None.

    Journal rows are written by the TypeScript bot and are never schema-checked
    on the way in, so a string, a nested object or a NaN can appear where a
    number belongs. Returning None routes all of those through the same
    "missing" path as an absent key instead of poisoning a feature.
    """
    if value is None or isinstance(value, bool):
        return None
    try:
        f = float(value)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return None
    return f if math.isfinite(f) else None


@dataclass(frozen=True)
class JournalLoad:
    """Parsed journal lines plus the counts needed to explain what was dropped."""

    rows: tuple[dict, ...]
    n_lines: int
    n_malformed: int


def load_journal_rows(path: str | Path, *, log: Callable[[str], None] = print) -> JournalLoad:
    """Read trade_journal.jsonl, skipping blank and unparseable lines.

    A single corrupt line must never abort the run: the journal is appended to
    by a live bot, so a truncated final line is normal rather than exceptional.
    """
    p = Path(path)
    if not p.exists():
        raise FileNotFoundError(f"Journal not found: {p}")

    rows: list[dict] = []
    n_lines = 0
    n_malformed = 0
    with p.open(encoding="utf-8") as handle:
        for raw in handle:
            line = raw.strip()
            if not line:
                continue
            n_lines += 1
            try:
                parsed = json.loads(line)
            except json.JSONDecodeError:
                n_malformed += 1
                continue
            if not isinstance(parsed, dict):
                n_malformed += 1
                continue
            rows.append(parsed)

    log(f"   Journal: {n_lines:,} lines, {len(rows):,} parsed, {n_malformed:,} malformed")
    return JournalLoad(rows=tuple(rows), n_lines=n_lines, n_malformed=n_malformed)


def build_feature_vector(entry: Mapping[str, object]) -> list[float]:
    """Encode one journal `entry` block as the fixed-order feature vector.

    Every value used here is knowable at decision time — nothing from the exit
    or analysis block ever reaches this function, which is the property that
    keeps the meta-label honest.
    """
    side_is_up = 1.0 if str(entry.get("side") or "").upper() == "UP" else 0.0

    token_price = _as_float(entry.get("tokenPrice"))
    time_left = _as_float(entry.get("timeLeftMin"))
    cost = _as_float(entry.get("cost"))
    size = _as_float(entry.get("size"))
    spread = _as_float(entry.get("spread"))
    best_edge = _as_float(entry.get("bestEdge"))
    ml_prob_up = _as_float(entry.get("mlProbUp"))
    btc_price = _as_float(entry.get("btcPrice"))
    price_to_beat = _as_float(entry.get("priceToBeat"))

    phase = str(entry.get("phase") or "").upper()
    session = str(entry.get("session") or "")
    confidence = str(entry.get("confidence") or "").upper()

    # mlProbUp is P(market resolves UP); a DOWN bet wins with the complement.
    # Re-orienting onto the side actually bought makes this "the primary model's
    # probability that THIS bet wins", which is the quantity a meta-labeler
    # should be allowed to disagree with.
    if ml_prob_up is None:
        ml_prob_win = NEUTRAL_ML_PROB_WIN
        signal_missing = 1.0
    else:
        ml_prob_win = ml_prob_up if side_is_up else 1.0 - ml_prob_up
        signal_missing = 0.0

    # How far BTC already sat past the strike at entry, in basis points, signed
    # so that positive always means "currently winning".
    if btc_price is None or price_to_beat is None or price_to_beat == 0.0:
        ptb_edge_bps = 0.0
    else:
        raw_bps = (btc_price - price_to_beat) / price_to_beat * 10_000.0
        ptb_edge_bps = raw_bps if side_is_up else -raw_bps

    return [
        token_price if token_price is not None else NEUTRAL_TOKEN_PRICE,
        time_left if time_left is not None else NEUTRAL_TIME_LEFT_MIN,
        cost if cost is not None else NEUTRAL_COST,
        size if size is not None else NEUTRAL_SIZE,
        side_is_up,
        *(1.0 if phase == level else 0.0 for level in PHASE_LEVELS),
        *(1.0 if session == level else 0.0 for level in SESSION_LEVELS),
        CONFIDENCE_RANKS.get(confidence, 0.0),
        1.0 if confidence.startswith("LIMIT") else 0.0,
        1.0 if confidence == "PREMARKET" else 0.0,
        ml_prob_win,
        best_edge if best_edge is not None else NEUTRAL_BEST_EDGE,
        spread if spread is not None else NEUTRAL_SPREAD,
        signal_missing,
        ptb_edge_bps,
    ]


@dataclass(frozen=True)
class MetaLabelDataset:
    """Decision-time features, take/skip labels, and the ordering that proves it.

    Rows are sorted by `entered_at` (decision time), so `X[:k]` really is "the
    past". `slugs` is carried alongside so the split can purge a 15-minute
    market that has rows on both sides of the boundary.
    """

    X: np.ndarray
    y: np.ndarray
    entered_at: np.ndarray
    slugs: tuple[str, ...]
    feature_names: tuple[str, ...]
    n_skipped_ineligible: int
    n_skipped_no_timestamp: int

    @property
    def n_rows(self) -> int:
        """Number of eligible trades."""
        return int(self.X.shape[0])

    @property
    def n_win(self) -> int:
        """Number of eligible trades that settled as WIN."""
        return int(self.y.sum())

    @property
    def base_rate(self) -> float:
        """Fraction of eligible trades that won — the always-take benchmark."""
        return float(self.y.mean()) if self.n_rows else 0.0


def build_dataset(
    rows: Iterable[Mapping[str, object]],
    *,
    eligible_outcomes: Sequence[str] = DEFAULT_ELIGIBLE_OUTCOMES,
    log: Callable[[str], None] = print,
) -> MetaLabelDataset:
    """Turn parsed journal rows into the meta-label dataset.

    Args:
        rows: parsed journal dicts (see `load_journal_rows`).
        eligible_outcomes: outcomes that represent a real, resolved position.
            DRY_RUN and REJECTED are excluded by construction.
        log: stdout sink; the entrypoint passes `print`.
    """
    eligible = set(eligible_outcomes)
    features: list[list[float]] = []
    labels: list[int] = []
    timestamps: list[float] = []
    slugs: list[str] = []
    n_ineligible = 0
    n_no_timestamp = 0

    for row in rows:
        entry = row.get("entry")
        analysis = row.get("analysis")
        if not isinstance(entry, Mapping) or not isinstance(analysis, Mapping):
            n_ineligible += 1
            continue

        outcome = analysis.get("outcome")
        if not isinstance(outcome, str) or outcome not in eligible:
            n_ineligible += 1
            continue

        entered_at = _as_float(entry.get("enteredAt"))
        if entered_at is None:
            entered_at = _as_float(row.get("_ts"))
        if entered_at is None:
            n_no_timestamp += 1
            continue

        features.append(build_feature_vector(entry))
        labels.append(1 if outcome == WIN_OUTCOME else 0)
        timestamps.append(entered_at)
        slugs.append(str(entry.get("marketSlug") or ""))

    if not features:
        raise ValueError("No eligible journal rows — nothing to meta-label")

    X = np.asarray(features, dtype=np.float64)
    y = np.asarray(labels, dtype=np.int64)
    ts = np.asarray(timestamps, dtype=np.float64)
    # Stable sort keeps same-millisecond rows in journal order.
    order = np.argsort(ts, kind="stable")

    dataset = MetaLabelDataset(
        X=X[order],
        y=y[order],
        entered_at=ts[order],
        slugs=tuple(slugs[i] for i in order),
        feature_names=FEATURE_NAMES,
        n_skipped_ineligible=n_ineligible,
        n_skipped_no_timestamp=n_no_timestamp,
    )
    log(
        f"   Dataset: {dataset.n_rows:,} eligible trades "
        f"({dataset.n_win:,} wins, base rate {dataset.base_rate * 100:.2f}%) | "
        f"skipped {n_ineligible:,} ineligible, {n_no_timestamp:,} undated"
    )
    return dataset


@dataclass(frozen=True)
class TemporalIndexSplit:
    """Row indices for one chronological train/test boundary.

    `n_embargoed` rows are dropped immediately after the boundary; `n_purged`
    test rows are dropped because their market slug also appears in train, which
    would let the model score a market whose outcome it had already been told.
    """

    train_idx: np.ndarray
    test_idx: np.ndarray
    boundary: int
    n_embargoed: int
    n_purged: int


def temporal_index_split(
    entered_at: np.ndarray,
    slugs: Sequence[str],
    *,
    test_size: float = DEFAULT_TEST_SIZE,
    embargo: int = DEFAULT_EMBARGO,
    train_end: int | None = None,
    test_end: int | None = None,
) -> TemporalIndexSplit:
    """Split chronologically, embargo the boundary, purge straddling markets.

    Args:
        entered_at: decision timestamps; must be non-decreasing.
        slugs: per-row market slug, positionally aligned with `entered_at`.
        test_size: tail fraction reserved for test (ignored when `train_end` is
            given explicitly, which is how walk-forward folds are expressed).
        embargo: rows dropped immediately after the boundary.
        train_end: explicit boundary index; overrides `test_size`.
        test_end: explicit end of the test block; defaults to the last row.
    """
    ts = np.asarray(entered_at, dtype=np.float64)
    n = len(ts)
    if len(slugs) != n:
        raise ValueError(f"slugs/timestamps length mismatch: {len(slugs)} vs {n}")
    if n and not np.all(np.diff(ts) >= 0):
        raise ValueError("entered_at is not non-decreasing — the split would not be temporal")
    if embargo < 0:
        raise ValueError(f"embargo must be >= 0, got {embargo}")

    boundary = int(n * (1 - test_size)) if train_end is None else int(train_end)
    boundary = max(0, min(boundary, n))
    stop = n if test_end is None else max(0, min(int(test_end), n))

    train_idx = np.arange(0, boundary, dtype=np.int64)
    raw_test_start = min(boundary + embargo, stop)
    raw_test = np.arange(raw_test_start, stop, dtype=np.int64)
    n_embargoed = max(0, min(boundary + embargo, stop) - boundary)

    train_slugs = {slugs[i] for i in train_idx.tolist() if slugs[i]}
    if raw_test.size:
        keep = np.array(
            [not (slugs[i] and slugs[i] in train_slugs) for i in raw_test.tolist()],
            dtype=bool,
        )
        test_idx = raw_test[keep]
    else:
        test_idx = raw_test

    return TemporalIndexSplit(
        train_idx=train_idx,
        test_idx=test_idx,
        boundary=boundary,
        n_embargoed=n_embargoed,
        n_purged=int(raw_test.size - test_idx.size),
    )
