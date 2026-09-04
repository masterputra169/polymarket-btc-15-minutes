"""Fitting the meta-labeler, and refusing to flatter it afterwards.

The model itself is deliberately boring — an L2 logistic regression on twenty
standardised features, at scikit-learn's default regularisation, never tuned
against the number it is judged by. Everything interesting here is the
evaluation, because with a few hundred rows the difference between an edge and a
coin is entirely a question of how the score was measured.

So the AUC is never reported alone. It comes with a percentile bootstrap
interval (is this 0.55 distinguishable from 0.5 at all?) and with a walk-forward
spread across expanding-window refits (does it survive being asked again?), and
`build_verdict` turns those two into one sentence that is allowed to say "no".
A null result reported plainly is the correct outcome for a dataset this small,
and far more useful than a flattering number.

`MetaLabeler.predict_proba` re-implements inference from the exported
coefficients rather than delegating to sklearn, so it doubles as the executable
spec for the TypeScript port the JSON is shaped for.

Pure logic: arrays and frozen dataclasses in, frozen dataclasses and plain dicts
out. No file I/O; the entrypoint owns stdout and decides where the JSON lands.
"""

from __future__ import annotations

from collections.abc import Callable, Sequence
from dataclasses import dataclass

import numpy as np
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import accuracy_score, brier_score_loss, roc_auc_score

from mltrain.meta_labeling import (
    CONFIDENCE_RANKS,
    DEFAULT_EMBARGO,
    FEATURE_NAMES,
    NEUTRAL_BEST_EDGE,
    NEUTRAL_COST,
    NEUTRAL_ML_PROB_WIN,
    NEUTRAL_SIZE,
    NEUTRAL_SPREAD,
    NEUTRAL_TIME_LEFT_MIN,
    NEUTRAL_TOKEN_PRICE,
    PHASE_LEVELS,
    SESSION_LEVELS,
    MetaLabelDataset,
    TemporalIndexSplit,
    temporal_index_split,
)
from mltrain.metrics import calibration_summary, safe_round

# --- Fit defaults ----------------------------------------------------------
# scikit-learn's own default. Chosen a priori and deliberately NOT tuned: with a
# few hundred training rows, sweeping C against the held-out AUC is precisely
# how one invents an edge that does not exist.
DEFAULT_C = 1.0
DEFAULT_MAX_ITER = 1000
# A column whose std is below abs(mean) * RTOL + ATOL is treated as constant.
CONSTANT_COLUMN_RTOL = 1e-9
CONSTANT_COLUMN_ATOL = 1e-12

# --- Evaluation defaults ---------------------------------------------------
DEFAULT_N_BOOTSTRAP = 2000
DEFAULT_CI = 0.95
DEFAULT_WALK_FORWARD_FOLDS = 5
DEFAULT_MIN_TRAIN_FRAC = 0.5
MIN_TRAIN_ROWS = 50

MODEL_VERSION = "meta-labeler-v1"
INFERENCE_FORMULA = (
    "p = 1 / (1 + exp(-(intercept + sum(coefficients[i] * (x[i] - center[i]) / scale[i]))))"
)


@dataclass(frozen=True)
class MetaLabeler:
    """A fitted logistic meta-labeler, carrying its own standardisation.

    Inference is reimplemented here rather than delegated to sklearn on purpose:
    this is the same arithmetic a TypeScript consumer would run from the
    exported JSON, so `predict_proba` doubles as the executable spec for that
    port (and the tests pin it against sklearn's own output).
    """

    feature_names: tuple[str, ...]
    coefficients: tuple[float, ...]
    intercept: float
    center: tuple[float, ...]
    scale: tuple[float, ...]
    c: float
    n_train: int
    train_base_rate: float

    def decision_function(self, X: np.ndarray) -> np.ndarray:
        """Log-odds of WIN: intercept + coefficients . ((x - center) / scale)."""
        Xa = np.atleast_2d(np.asarray(X, dtype=np.float64))
        if Xa.shape[1] != len(self.feature_names):
            raise ValueError(f"expected {len(self.feature_names)} features, got {Xa.shape[1]}")
        z = (Xa - np.asarray(self.center)) / np.asarray(self.scale)
        return z @ np.asarray(self.coefficients) + self.intercept

    def predict_proba(self, X: np.ndarray) -> np.ndarray:
        """P(WIN) for each row."""
        return 1.0 / (1.0 + np.exp(-self.decision_function(X)))


def fit_meta_labeler(
    X_train: np.ndarray,
    y_train: np.ndarray,
    *,
    feature_names: Sequence[str] = FEATURE_NAMES,
    c: float = DEFAULT_C,
    max_iter: int = DEFAULT_MAX_ITER,
    seed: int = 42,
) -> MetaLabeler:
    """Fit an L2 logistic regression on standardised features.

    No class weighting: the reported probabilities are meant to be calibrated
    against the real base rate, and `class_weight="balanced"` would trade that
    calibration away for a prettier accuracy number.
    """
    X = np.asarray(X_train, dtype=np.float64)
    y = np.asarray(y_train, dtype=np.int64)
    if X.shape[0] != y.shape[0]:
        raise ValueError(f"X/y length mismatch: {X.shape[0]} vs {y.shape[0]}")
    if len(np.unique(y)) < 2:
        raise ValueError("training labels contain a single class — cannot fit a classifier")

    center = X.mean(axis=0)
    raw_scale = X.std(axis=0)
    # A constant column would divide by zero; leaving it at scale 1 turns it into
    # a zero-variance input that the L2 penalty simply shrinks to nothing. The
    # tolerance is relative because a constant like spread=0.01 does not produce
    # a std of exactly 0 in floating point — it produces ~1e-18, which would
    # otherwise be used as a divisor and blow every prediction up to inf/NaN.
    tolerance = np.abs(center) * CONSTANT_COLUMN_RTOL + CONSTANT_COLUMN_ATOL
    scale = np.where(raw_scale > tolerance, raw_scale, 1.0)
    Z = (X - center) / scale

    # `penalty` is left at its default (L2) rather than passed explicitly: newer
    # scikit-learn deprecates the keyword, and the default has always been L2.
    model = LogisticRegression(
        C=c,
        solver="lbfgs",
        max_iter=max_iter,
        random_state=seed,
    )
    model.fit(Z, y)

    return MetaLabeler(
        feature_names=tuple(feature_names),
        coefficients=tuple(float(v) for v in model.coef_[0]),
        intercept=float(model.intercept_[0]),
        center=tuple(float(v) for v in center),
        scale=tuple(float(v) for v in scale),
        c=float(c),
        n_train=int(X.shape[0]),
        train_base_rate=float(y.mean()),
    )


def _safe_auc(y_true: np.ndarray, y_prob: np.ndarray) -> float | None:
    """ROC-AUC, or None when the slice has a single class (undefined, not 0.5)."""
    if len(np.unique(y_true)) < 2:
        return None
    try:
        return float(roc_auc_score(y_true, y_prob))
    except ValueError:
        return None


def bootstrap_auc_ci(
    y_true: np.ndarray,
    y_prob: np.ndarray,
    *,
    n_bootstrap: int = DEFAULT_N_BOOTSTRAP,
    ci: float = DEFAULT_CI,
    rng: np.random.Generator | None = None,
) -> tuple[float | None, float | None]:
    """Percentile bootstrap interval for AUC on a small held-out slice.

    With a few hundred rows the point estimate alone is close to meaningless —
    this is the number that says whether an AUC of 0.55 is an edge or a coin.
    """
    y_true = np.asarray(y_true)
    y_prob = np.asarray(y_prob)
    if len(y_true) == 0 or _safe_auc(y_true, y_prob) is None:
        return None, None

    generator = rng if rng is not None else np.random.default_rng(42)
    n = len(y_true)
    scores: list[float] = []
    for _ in range(max(1, n_bootstrap)):
        idx = generator.integers(0, n, size=n)
        auc = _safe_auc(y_true[idx], y_prob[idx])
        if auc is not None:
            scores.append(auc)

    if not scores:
        return None, None
    lo_pct = (1.0 - ci) / 2.0 * 100.0
    hi_pct = (1.0 + ci) / 2.0 * 100.0
    return float(np.percentile(scores, lo_pct)), float(np.percentile(scores, hi_pct))


@dataclass(frozen=True)
class MetaEvaluation:
    """Held-out metrics for one fitted meta-labeler."""

    n: int
    base_rate: float
    accuracy: float
    auc: float | None
    auc_ci_low: float | None
    auc_ci_high: float | None
    brier: float
    ece: float
    mce: float
    calibration: dict[str, object]

    @property
    def beats_chance(self) -> bool:
        """True only when the whole bootstrap interval sits above 0.5."""
        return self.auc_ci_low is not None and self.auc_ci_low > 0.5


def evaluate_meta_predictions(
    y_true: np.ndarray,
    y_prob: np.ndarray,
    *,
    bins: int = 10,
    n_bootstrap: int = DEFAULT_N_BOOTSTRAP,
    ci: float = DEFAULT_CI,
    rng: np.random.Generator | None = None,
) -> MetaEvaluation:
    """Accuracy, AUC (+ bootstrap CI), Brier and calibration on held-out rows.

    NaN probabilities are dropped, matching `mltrain.metrics.calibration_summary`
    — a degenerate fit must produce a smaller honest report, not a traceback in
    the middle of one.
    """
    y_true = np.asarray(y_true)
    y_prob = np.asarray(y_prob, dtype=np.float64)
    if len(y_true) != len(y_prob):
        raise ValueError(f"y_true/y_prob length mismatch: {len(y_true)} vs {len(y_prob)}")
    if len(y_true) == 0:
        raise ValueError("cannot evaluate an empty slice")

    finite = np.isfinite(y_prob)
    if not finite.all():
        y_true = y_true[finite]
        y_prob = y_prob[finite]
    if len(y_true) == 0:
        raise ValueError("every prediction was non-finite — nothing to evaluate")

    calibration = calibration_summary(y_true, y_prob, bins=bins)
    auc = _safe_auc(y_true, y_prob)
    lo, hi = bootstrap_auc_ci(y_true, y_prob, n_bootstrap=n_bootstrap, ci=ci, rng=rng)

    return MetaEvaluation(
        n=len(y_true),
        base_rate=float(np.mean(y_true)),
        accuracy=float(accuracy_score(y_true, (y_prob >= 0.5).astype(int))),
        auc=auc,
        auc_ci_low=lo,
        auc_ci_high=hi,
        brier=float(brier_score_loss(y_true, y_prob)),
        ece=float(calibration["ece"]),
        mce=float(calibration["mce"]),
        calibration=calibration,
    )


@dataclass(frozen=True)
class WalkForwardFold:
    """One expanding-window fold: what it trained on and what it scored."""

    fold: int
    n_train: int
    n_test: int
    base_rate: float
    accuracy: float
    auc: float | None


@dataclass(frozen=True)
class WalkForwardSummary:
    """The spread of fold AUCs — the answer to "is that lift repeatable?"."""

    folds: tuple[WalkForwardFold, ...]
    mean_auc: float | None
    std_auc: float | None
    min_auc: float | None
    max_auc: float | None
    n_skipped: int

    @property
    def spread_beats_chance(self) -> bool:
        """True when even mean minus one standard deviation clears 0.5."""
        if self.mean_auc is None or self.std_auc is None:
            return False
        return (self.mean_auc - self.std_auc) > 0.5


def walk_forward_evaluation(
    dataset: MetaLabelDataset,
    *,
    n_folds: int = DEFAULT_WALK_FORWARD_FOLDS,
    min_train_frac: float = DEFAULT_MIN_TRAIN_FRAC,
    embargo: int = DEFAULT_EMBARGO,
    c: float = DEFAULT_C,
    max_iter: int = DEFAULT_MAX_ITER,
    seed: int = 42,
    min_train_rows: int = MIN_TRAIN_ROWS,
    log: Callable[[str], None] = print,
) -> WalkForwardSummary:
    """Refit on an expanding window and score the next block, `n_folds` times.

    Each fold is a fresh model: nothing from a later fold ever informs an
    earlier one, and every fold re-applies the same embargo and slug purge as
    the headline split. Folds that cannot be fitted or scored (single-class
    train or test slice, or an empty block) are skipped and counted rather than
    scored as 0.5, which would quietly drag the spread toward "no signal".
    """
    n = dataset.n_rows
    start = int(n * min_train_frac)
    block = max(1, (n - start) // max(1, n_folds))
    folds: list[WalkForwardFold] = []
    n_skipped = 0

    for k in range(n_folds):
        train_end = start + k * block
        test_end = n if k == n_folds - 1 else train_end + block
        if train_end < min_train_rows or test_end <= train_end:
            n_skipped += 1
            continue

        split = temporal_index_split(
            dataset.entered_at,
            dataset.slugs,
            embargo=embargo,
            train_end=train_end,
            test_end=test_end,
        )
        y_tr = dataset.y[split.train_idx]
        if split.test_idx.size == 0 or len(np.unique(y_tr)) < 2:
            n_skipped += 1
            continue

        y_te = dataset.y[split.test_idx]
        model = fit_meta_labeler(
            dataset.X[split.train_idx],
            y_tr,
            feature_names=dataset.feature_names,
            c=c,
            max_iter=max_iter,
            seed=seed,
        )
        prob = model.predict_proba(dataset.X[split.test_idx])
        folds.append(
            WalkForwardFold(
                fold=k,
                n_train=int(split.train_idx.size),
                n_test=int(split.test_idx.size),
                base_rate=float(y_te.mean()),
                accuracy=float(accuracy_score(y_te, (prob >= 0.5).astype(int))),
                auc=_safe_auc(y_te, prob),
            )
        )

    scored = [f.auc for f in folds if f.auc is not None]
    log(f"   Walk-forward: {len(folds)} folds fitted, {n_skipped} skipped, {len(scored)} scored")

    if not scored:
        return WalkForwardSummary(tuple(folds), None, None, None, None, n_skipped)
    return WalkForwardSummary(
        folds=tuple(folds),
        mean_auc=float(np.mean(scored)),
        std_auc=float(np.std(scored)),
        min_auc=float(np.min(scored)),
        max_auc=float(np.max(scored)),
        n_skipped=n_skipped,
    )


@dataclass(frozen=True)
class Verdict:
    """The plain-English answer, with a machine-readable level beside it."""

    level: str
    message: str


def build_verdict(holdout: MetaEvaluation, walk_forward: WalkForwardSummary) -> Verdict:
    """State plainly whether the meta-labeler beat chance. Null results allowed.

    A null result reported honestly is the correct outcome for a few-hundred-row
    dataset; this function exists so that nobody has to eyeball three numbers
    and talk themselves into an edge.
    """
    if holdout.auc is None:
        return Verdict(
            "inconclusive",
            "INCONCLUSIVE: the held-out slice has a single class, so AUC is undefined.",
        )

    holdout_ok = holdout.beats_chance
    walk_ok = walk_forward.spread_beats_chance

    if holdout_ok and walk_ok:
        return Verdict(
            "edge",
            f"EDGE: held-out AUC {holdout.auc:.4f} with the whole bootstrap interval above 0.5, "
            f"and the walk-forward spread (mean {walk_forward.mean_auc:.4f}) clears it too. "
            "Small, but not obviously noise.",
        )
    if holdout_ok or walk_ok:
        wf = walk_forward.mean_auc if walk_forward.mean_auc is not None else float("nan")
        return Verdict(
            "mixed",
            f"MIXED: held-out AUC {holdout.auc:.4f} and walk-forward mean AUC {wf:.4f} disagree "
            "about whether chance has been beaten. Treat as no edge until more data settles it.",
        )
    lo = holdout.auc_ci_low if holdout.auc_ci_low is not None else float("nan")
    hi = holdout.auc_ci_high if holdout.auc_ci_high is not None else float("nan")
    return Verdict(
        "no_edge",
        f"NO EDGE: held-out AUC {holdout.auc:.4f} (95% CI {lo:.4f}-{hi:.4f}) is not "
        "distinguishable from 0.5. The meta-labeler adds nothing over trusting every "
        "primary signal.",
    )


def build_export(
    model: MetaLabeler,
    *,
    dataset: MetaLabelDataset,
    split: TemporalIndexSplit,
    holdout: MetaEvaluation,
    walk_forward: WalkForwardSummary,
    verdict: Verdict,
    journal_path: str,
    generated_at: str,
    eligible_outcomes: Sequence[str],
    embargo: int,
    test_size: float,
) -> dict[str, object]:
    """Assemble the JSON a TypeScript consumer could later score rows with.

    Deliberately self-contained: names, coefficients, intercept AND the
    standardisation constants, plus the exact inference formula, so a port never
    has to guess what preprocessing the coefficients assume. `deployed` is false
    and stays false — whether this ever goes live is the user's call, not the
    trainer's.
    """
    return {
        "version": MODEL_VERSION,
        "kind": "logistic_regression",
        "deployed": False,
        "generatedAt": generated_at,
        "inference": INFERENCE_FORMULA,
        "source": {
            "journal": journal_path,
            "eligibleOutcomes": list(eligible_outcomes),
            "rows": dataset.n_rows,
            "wins": dataset.n_win,
            "baseRate": safe_round(dataset.base_rate),
            "skippedIneligible": dataset.n_skipped_ineligible,
            "skippedUndated": dataset.n_skipped_no_timestamp,
            "firstTradeMs": float(dataset.entered_at[0]),
            "lastTradeMs": float(dataset.entered_at[-1]),
        },
        "features": {
            "names": list(model.feature_names),
            # Model parameters are NOT rounded: unlike the human-facing metrics
            # below, these are the arithmetic a port must reproduce exactly, and
            # a rounded scale of 0.000000 would divide by zero.
            "center": [float(v) for v in model.center],
            "scale": [float(v) for v in model.scale],
            "phaseLevels": list(PHASE_LEVELS),
            "sessionLevels": list(SESSION_LEVELS),
            "confidenceRanks": dict(CONFIDENCE_RANKS),
            "missingDefaults": {
                "token_price": NEUTRAL_TOKEN_PRICE,
                "time_left_min": NEUTRAL_TIME_LEFT_MIN,
                "cost": NEUTRAL_COST,
                "size": NEUTRAL_SIZE,
                "ml_prob_win": NEUTRAL_ML_PROB_WIN,
                "best_edge": NEUTRAL_BEST_EDGE,
                "spread": NEUTRAL_SPREAD,
            },
        },
        "model": {
            "intercept": float(model.intercept),
            "coefficients": [float(v) for v in model.coefficients],
            "l2C": model.c,
            "nTrain": model.n_train,
            "trainBaseRate": safe_round(model.train_base_rate),
        },
        "split": {
            "testSize": test_size,
            "embargoRows": embargo,
            "boundaryIdx": split.boundary,
            "nTrain": int(split.train_idx.size),
            "nTest": int(split.test_idx.size),
            "nEmbargoed": split.n_embargoed,
            "nPurgedBySlug": split.n_purged,
        },
        "evaluation": {
            "holdout": {
                "n": holdout.n,
                "baseRate": safe_round(holdout.base_rate),
                "accuracy": safe_round(holdout.accuracy),
                "auc": safe_round(holdout.auc),
                "aucCiLow": safe_round(holdout.auc_ci_low),
                "aucCiHigh": safe_round(holdout.auc_ci_high),
                "brier": safe_round(holdout.brier),
                "ece": safe_round(holdout.ece),
                "mce": safe_round(holdout.mce),
                "calibrationBins": holdout.calibration["bins"],
            },
            "walkForward": {
                "meanAuc": safe_round(walk_forward.mean_auc),
                "stdAuc": safe_round(walk_forward.std_auc),
                "minAuc": safe_round(walk_forward.min_auc),
                "maxAuc": safe_round(walk_forward.max_auc),
                "nSkipped": walk_forward.n_skipped,
                "folds": [
                    {
                        "fold": f.fold,
                        "nTrain": f.n_train,
                        "nTest": f.n_test,
                        "baseRate": safe_round(f.base_rate),
                        "accuracy": safe_round(f.accuracy),
                        "auc": safe_round(f.auc),
                    }
                    for f in walk_forward.folds
                ],
            },
        },
        "verdict": {"level": verdict.level, "message": verdict.message},
    }
