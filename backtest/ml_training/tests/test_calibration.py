"""Unit tests for mltrain.calibration — Platt-on-logits and its revert rule.

Two things must hold for the exported A/B to be safe to ship:

  * a calibrator that HURTS ranking must be reverted to the identity. Platt on
    logits with A > 0 is monotone and cannot change AUC, so a real AUC drop
    means the OOF fit came back with the wrong sign — shipping it would invert
    the bot's confidence;
  * the final holdout metrics must be recomputed with the transform actually
    shipped, so the exported numbers and the deploy-gate test/holdout gaps
    describe one artifact rather than two.

The booster is stubbed: what matters is which margins get transformed and which
decision follows, not how the trees produced them.
"""

from __future__ import annotations

import numpy as np
import pytest

from mltrain.calibration import MIN_OOF_MARGINS, calibrate_platt

pytestmark = pytest.mark.unit


class _StubBooster:
    """Returns preset margins per DMatrix stand-in; probabilities are sigmoid."""

    def __init__(self, margins: dict[int, np.ndarray]) -> None:
        self._margins = margins

    def predict(self, dmatrix, output_margin: bool = False) -> np.ndarray:
        m = self._margins[id(dmatrix)]
        return m if output_margin else 1.0 / (1.0 + np.exp(-m))


def _ordered_margins(n: int = 200) -> np.ndarray:
    return np.linspace(-3.0, 3.0, n)


def _build(*, oof_sign: float, n_oof: int = 200, with_holdout: bool = True):
    """Wire a stub booster + OOF arrays whose correlation sign is controllable."""
    dtest, dholdout = object(), object()
    test_margins = _ordered_margins(120)
    holdout_margins = _ordered_margins(140)
    model = _StubBooster({id(dtest): test_margins, id(dholdout): holdout_margins})

    # Labels follow the margins (sign +1) or oppose them (sign -1), which flips
    # the sign of the fitted A.
    oof_margins = _ordered_margins(n_oof)
    oof_labels = ((oof_sign * oof_margins) > 0).astype(np.int32)

    y_test = (test_margins > 0).astype(np.int32)
    y_holdout = (holdout_margins > 0).astype(np.int32)
    y_prob = 1.0 / (1.0 + np.exp(-test_margins))

    return dict(
        model=model,
        oof_margins=oof_margins,
        oof_labels=oof_labels,
        dtest=dtest,
        y_test=y_test,
        y_prob=y_prob,
        dholdout=dholdout if with_holdout else None,
        y_holdout=y_holdout if with_holdout else None,
    )


def _run(**overrides):
    kw = _build(
        **{
            k: overrides.pop(k)
            for k in list(overrides)
            if k in ("oof_sign", "n_oof", "with_holdout")
        }
    )
    kw.update(overrides)
    model = kw.pop("model")
    return calibrate_platt(model, log=lambda *a, **k: None, **kw)


class TestFittedAndKept:
    def test_positive_fit_is_kept_and_shipped(self) -> None:
        result = _run(oof_sign=1.0)
        assert result.fitted is True and result.kept is True
        assert result.a > 0
        assert result.on_logits is True
        assert result.eval_label == "holdout"

    def test_shipped_probabilities_use_the_fitted_transform(self) -> None:
        result = _run(oof_sign=1.0)
        expected = 1.0 / (1.0 + np.exp(-(result.a * _ordered_margins(120) + result.b)))
        assert np.allclose(result.probabilities, expected)

    def test_holdout_metrics_are_recomputed_with_the_shipped_transform(self) -> None:
        result = _run(oof_sign=1.0)
        # Margins and labels agree perfectly, and A > 0 preserves the ordering.
        assert result.holdout_auc == pytest.approx(1.0)
        assert result.holdout_accuracy == pytest.approx(1.0)

    def test_decision_falls_back_to_test_without_a_holdout(self) -> None:
        result = _run(oof_sign=1.0, with_holdout=False)
        assert result.eval_label == "test"
        assert result.holdout_accuracy is None
        assert result.holdout_auc is None


class TestRevertRule:
    def test_sign_inverted_fit_is_reverted_to_identity(self) -> None:
        result = _run(oof_sign=-1.0)
        assert result.fitted is True and result.kept is False
        assert (result.a, result.b) == (1.0, 0.0)

    def test_reverted_run_ships_the_raw_probabilities(self) -> None:
        built = _build(oof_sign=-1.0)
        raw = built["y_prob"]
        model = built.pop("model")
        result = calibrate_platt(model, log=lambda *a, **k: None, **built)
        assert result.probabilities is raw

    def test_reverted_holdout_metrics_use_the_identity(self) -> None:
        result = _run(oof_sign=-1.0)
        # Identity A/B means sigmoid(raw margin) — the uncalibrated ranking.
        assert result.holdout_auc == pytest.approx(1.0)


class TestSkippedFit:
    def test_too_few_oof_margins_skips_the_fit(self) -> None:
        result = _run(oof_sign=1.0, n_oof=MIN_OOF_MARGINS)
        assert result.fitted is False and result.kept is False
        assert (result.a, result.b) == (1.0, 0.0)
        assert result.eval_label == "test", "no decision was taken"

    def test_skipped_fit_still_reports_final_holdout_metrics(self) -> None:
        result = _run(oof_sign=1.0, n_oof=MIN_OOF_MARGINS)
        assert result.holdout_auc == pytest.approx(1.0)

    def test_logs_the_skip_reason(self) -> None:
        lines: list[str] = []
        built = _build(oof_sign=1.0, n_oof=MIN_OOF_MARGINS)
        model = built.pop("model")
        calibrate_platt(model, log=lines.append, **built)
        assert any("skipping calibration" in line for line in lines)
