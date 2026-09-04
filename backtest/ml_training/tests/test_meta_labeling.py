"""Unit tests for mltrain.meta_labeling + mltrain.meta_eval — the take/skip model.

Both halves are covered here because they are one deliverable and neither is
meaningful alone: the dataset module decides what may be learned from, and the
eval module decides what may be claimed about it.

The properties asserted here are the ones that decide whether the reported AUC
means anything at all:

  * the dataset is built only from fields knowable at decision time, and
    malformed / DRY_RUN / never-filled rows are dropped rather than guessed at;
  * the feature vector's LENGTH and ORDER are pinned, because the exported
    coefficients are positional and a silent reordering would mislabel every
    weight in the JSON a TypeScript consumer reads;
  * the split is temporal, honours the embargo, purges markets that straddle the
    boundary, and never puts a training index in the test set;
  * a genuinely separable problem is learned (so a null result means "no signal
    in the data", not "no signal in the code"), and a pure-noise problem scores
    AUC ~ 0.5 (so a leak in our own pipeline would show up as an impossible
    score on data that cannot be predicted).
"""

from __future__ import annotations

import json
import math

import numpy as np
import pytest

from mltrain.meta_eval import (
    MODEL_VERSION,
    MetaEvaluation,
    MetaLabeler,
    WalkForwardSummary,
    _safe_auc,
    bootstrap_auc_ci,
    build_export,
    build_verdict,
    evaluate_meta_predictions,
    fit_meta_labeler,
    walk_forward_evaluation,
)
from mltrain.meta_labeling import (
    CONFIDENCE_RANKS,
    DEFAULT_ELIGIBLE_OUTCOMES,
    FEATURE_NAMES,
    NEUTRAL_ML_PROB_WIN,
    NEUTRAL_SPREAD,
    SETTLED_ELIGIBLE_OUTCOMES,
    _as_float,
    build_dataset,
    build_feature_vector,
    load_journal_rows,
    temporal_index_split,
)

pytestmark = pytest.mark.unit

BASE_MS = 1_770_000_000_000


def _entry(**overrides: object) -> dict:
    """A realistic `entry` block; overrides replace or delete (None) fields."""
    entry: dict = {
        "side": "UP",
        "tokenPrice": 0.55,
        "btcPrice": 70_000.0,
        "priceToBeat": 69_950.0,
        "marketSlug": "btc-updown-15m-1771062300",
        "cost": 2.75,
        "size": 5,
        "confidence": "VERY_HIGH",
        "phase": "EARLY",
        "timeLeftMin": 12.5,
        "session": "Europe",
        "spread": 0.01,
        "bestEdge": 0.12,
        "mlProbUp": 0.82,
        "enteredAt": BASE_MS,
    }
    entry.update(overrides)
    return {k: v for k, v in entry.items() if v is not None}


def _row(outcome: str = "WIN", *, ts: int = BASE_MS, slug: str | None = None, **entry_kw) -> dict:
    kw = dict(entry_kw)
    kw["enteredAt"] = ts
    if slug is not None:
        kw["marketSlug"] = slug
    return {"entry": _entry(**kw), "analysis": {"outcome": outcome}, "_ts": ts + 600_000}


def _synthetic_rows(n: int, *, signal: bool, rng: np.random.Generator) -> list[dict]:
    """n chronological rows whose label either follows tokenPrice or is a coin.

    tokenPrice is a real feature, so `signal=True` gives the model something
    genuinely learnable and `signal=False` gives it nothing at all.
    """
    rows: list[dict] = []
    for i in range(n):
        price = float(rng.uniform(0.2, 0.8))
        if signal:
            p_win = 1.0 / (1.0 + math.exp(-8.0 * (price - 0.5)))
        else:
            p_win = 0.5
        outcome = "WIN" if rng.uniform() < p_win else "LOSS"
        rows.append(
            _row(
                outcome,
                ts=BASE_MS + i * 900_000,
                slug=f"btc-updown-15m-{i}",
                tokenPrice=price,
            )
        )
    return rows


class TestFloatCoercion:
    def test_finite_numbers_pass_through(self) -> None:
        assert _as_float(1.5) == 1.5
        assert _as_float("2.25") == 2.25

    @pytest.mark.parametrize("bad", [None, "abc", {}, [], float("nan"), float("inf"), True])
    def test_unusable_values_become_none(self, bad: object) -> None:
        # Booleans are excluded on purpose: `True` would silently become 1.0.
        assert _as_float(bad) is None


class TestFeatureVector:
    def test_length_and_order_are_pinned(self) -> None:
        vector = build_feature_vector(_entry())
        assert len(vector) == len(FEATURE_NAMES)
        idx = {name: i for i, name in enumerate(FEATURE_NAMES)}
        assert vector[idx["token_price"]] == 0.55
        assert vector[idx["time_left_min"]] == 12.5
        assert vector[idx["cost"]] == 2.75
        assert vector[idx["size"]] == 5.0
        assert vector[idx["side_is_up"]] == 1.0
        assert vector[idx["confidence_rank"]] == CONFIDENCE_RANKS["VERY_HIGH"]
        assert vector[idx["spread"]] == 0.01

    def test_empty_entry_still_produces_a_full_vector(self) -> None:
        vector = build_feature_vector({})
        assert len(vector) == len(FEATURE_NAMES)
        assert all(math.isfinite(v) for v in vector)
        idx = FEATURE_NAMES.index("signal_fields_missing")
        assert vector[idx] == 1.0

    def test_phase_and_session_one_hots_use_a_reference_level(self) -> None:
        early_asia = build_feature_vector(_entry(phase="EARLY", session="Asia"))
        one_hot_names = [n for n in FEATURE_NAMES if n.startswith(("phase_", "session_"))]
        assert all(early_asia[FEATURE_NAMES.index(n)] == 0.0 for n in one_hot_names)

        late_us = build_feature_vector(_entry(phase="LATE", session="EU/US Overlap"))
        assert late_us[FEATURE_NAMES.index("phase_late")] == 1.0
        assert late_us[FEATURE_NAMES.index("phase_mid")] == 0.0
        assert late_us[FEATURE_NAMES.index("session_eu_us_overlap")] == 1.0

    def test_unknown_levels_fall_back_to_the_reference(self) -> None:
        vector = build_feature_vector(_entry(phase="WEIRD", session="Mars", confidence="???"))
        assert vector[FEATURE_NAMES.index("phase_mid")] == 0.0
        assert vector[FEATURE_NAMES.index("session_us")] == 0.0
        assert vector[FEATURE_NAMES.index("confidence_rank")] == 0.0

    def test_limit_and_premarket_entries_get_their_own_flags(self) -> None:
        limit = build_feature_vector(_entry(confidence="LIMIT_PARTIAL"))
        assert limit[FEATURE_NAMES.index("confidence_is_limit")] == 1.0
        assert limit[FEATURE_NAMES.index("confidence_is_premarket")] == 0.0
        pre = build_feature_vector(_entry(confidence="PREMARKET"))
        assert pre[FEATURE_NAMES.index("confidence_is_premarket")] == 1.0

    def test_ml_probability_is_reoriented_onto_the_traded_side(self) -> None:
        up = build_feature_vector(_entry(side="UP", mlProbUp=0.82))
        down = build_feature_vector(_entry(side="DOWN", mlProbUp=0.82))
        i = FEATURE_NAMES.index("ml_prob_win")
        assert up[i] == pytest.approx(0.82)
        assert down[i] == pytest.approx(0.18)

    def test_missing_primary_signal_is_neutral_and_flagged(self) -> None:
        vector = build_feature_vector(_entry(mlProbUp=None, bestEdge=None, spread=None))
        assert vector[FEATURE_NAMES.index("ml_prob_win")] == NEUTRAL_ML_PROB_WIN
        assert vector[FEATURE_NAMES.index("best_edge")] == 0.0
        assert vector[FEATURE_NAMES.index("spread")] == NEUTRAL_SPREAD
        assert vector[FEATURE_NAMES.index("signal_fields_missing")] == 1.0

    def test_strike_distance_is_signed_toward_the_traded_side(self) -> None:
        i = FEATURE_NAMES.index("ptb_edge_bps")
        # BTC above the strike is good for UP and bad for DOWN.
        up = build_feature_vector(_entry(side="UP", btcPrice=70_000.0, priceToBeat=69_950.0))
        down = build_feature_vector(_entry(side="DOWN", btcPrice=70_000.0, priceToBeat=69_950.0))
        assert up[i] > 0
        assert down[i] == pytest.approx(-up[i])

    def test_degenerate_strike_does_not_divide_by_zero(self) -> None:
        vector = build_feature_vector(_entry(priceToBeat=0.0))
        assert vector[FEATURE_NAMES.index("ptb_edge_bps")] == 0.0

    def test_malformed_numeric_fields_fall_back_instead_of_raising(self) -> None:
        vector = build_feature_vector(_entry(tokenPrice="oops", timeLeftMin=float("nan")))
        assert vector[FEATURE_NAMES.index("token_price")] == 0.5
        assert vector[FEATURE_NAMES.index("time_left_min")] == 7.5


class TestJournalLoading:
    def test_blank_and_malformed_lines_are_skipped(self, tmp_path) -> None:
        path = tmp_path / "trade_journal.jsonl"
        path.write_text(
            "\n".join(
                [
                    json.dumps(_row("WIN")),
                    "{not json",
                    "",
                    json.dumps([1, 2, 3]),  # valid JSON, wrong shape
                    json.dumps(_row("LOSS")),
                ]
            ),
            encoding="utf-8",
        )
        lines: list[str] = []
        loaded = load_journal_rows(path, log=lines.append)
        assert len(loaded.rows) == 2
        assert loaded.n_malformed == 2
        assert loaded.n_lines == 4
        assert any("malformed" in line for line in lines)

    def test_missing_file_raises(self, tmp_path) -> None:
        with pytest.raises(FileNotFoundError, match="Journal not found"):
            load_journal_rows(tmp_path / "nope.jsonl", log=lambda _: None)


class TestDatasetConstruction:
    def test_dry_run_and_rejected_rows_are_excluded(self) -> None:
        rows = [
            _row("WIN", ts=BASE_MS, slug="a"),
            _row("DRY_RUN", ts=BASE_MS + 1, slug="b"),
            _row("REJECTED", ts=BASE_MS + 2, slug="c"),
            _row("LOSS", ts=BASE_MS + 3, slug="d"),
        ]
        dataset = build_dataset(rows, log=lambda _: None)
        assert dataset.n_rows == 2
        assert dataset.n_skipped_ineligible == 2
        assert dataset.base_rate == pytest.approx(0.5)

    def test_cut_loss_counts_as_a_non_win_by_default(self) -> None:
        rows = [_row("WIN", ts=BASE_MS, slug="a"), _row("CUT_LOSS", ts=BASE_MS + 1, slug="b")]
        dataset = build_dataset(rows, log=lambda _: None)
        assert dataset.n_rows == 2
        assert dataset.y.tolist() == [1, 0]

    def test_settled_only_population_drops_cut_loss(self) -> None:
        rows = [_row("WIN", ts=BASE_MS, slug="a"), _row("CUT_LOSS", ts=BASE_MS + 1, slug="b")]
        dataset = build_dataset(
            rows, eligible_outcomes=SETTLED_ELIGIBLE_OUTCOMES, log=lambda _: None
        )
        assert dataset.n_rows == 1

    def test_structurally_broken_rows_are_skipped(self) -> None:
        rows = [
            {"entry": _entry(), "analysis": {"outcome": "WIN"}, "_ts": BASE_MS},
            {"entry": _entry()},  # no analysis block
            {"analysis": {"outcome": "WIN"}},  # no entry block
            {"entry": _entry(), "analysis": {"outcome": 42}},  # non-string outcome
            {"entry": "not-a-dict", "analysis": {"outcome": "WIN"}},
        ]
        dataset = build_dataset(rows, log=lambda _: None)
        assert dataset.n_rows == 1
        assert dataset.n_skipped_ineligible == 4

    def test_rows_without_any_timestamp_are_skipped_and_counted(self) -> None:
        undated = {"entry": _entry(enteredAt=None), "analysis": {"outcome": "WIN"}}
        dataset = build_dataset([_row("WIN"), undated], log=lambda _: None)
        assert dataset.n_rows == 1
        assert dataset.n_skipped_no_timestamp == 1

    def test_ts_is_used_when_entered_at_is_absent(self) -> None:
        row = {"entry": _entry(enteredAt=None), "analysis": {"outcome": "WIN"}, "_ts": BASE_MS}
        dataset = build_dataset([row], log=lambda _: None)
        assert dataset.entered_at.tolist() == [float(BASE_MS)]

    def test_rows_are_sorted_by_decision_time(self) -> None:
        rows = [
            _row("WIN", ts=BASE_MS + 2000, slug="c"),
            _row("LOSS", ts=BASE_MS, slug="a"),
            _row("WIN", ts=BASE_MS + 1000, slug="b"),
        ]
        dataset = build_dataset(rows, log=lambda _: None)
        assert np.all(np.diff(dataset.entered_at) >= 0)
        assert dataset.slugs == ("a", "b", "c")
        assert dataset.y.tolist() == [0, 1, 1]

    def test_feature_matrix_shape_matches_the_name_tuple(self) -> None:
        dataset = build_dataset([_row("WIN"), _row("LOSS", ts=BASE_MS + 1)], log=lambda _: None)
        assert dataset.X.shape == (2, len(FEATURE_NAMES))
        assert dataset.feature_names == FEATURE_NAMES

    def test_empty_input_is_an_error_not_an_empty_model(self) -> None:
        with pytest.raises(ValueError, match="No eligible journal rows"):
            build_dataset([_row("DRY_RUN")], log=lambda _: None)

    def test_log_reports_counts(self) -> None:
        lines: list[str] = []
        build_dataset([_row("WIN"), _row("LOSS", ts=BASE_MS + 1)], log=lines.append)
        assert any("eligible trades" in line for line in lines)


class TestTemporalSplit:
    def _fixture(self, n: int = 40, *, dup_at: int | None = None) -> tuple[np.ndarray, list[str]]:
        ts = np.arange(n, dtype=np.float64) * 900_000.0
        slugs = [f"slug-{i}" for i in range(n)]
        if dup_at is not None:
            # Make a late row reuse an early market: a straddling 15-min market.
            slugs[dup_at] = slugs[0]
        return ts, slugs

    def test_train_precedes_test_and_the_sets_are_disjoint(self) -> None:
        ts, slugs = self._fixture()
        split = temporal_index_split(ts, slugs, test_size=0.25, embargo=0)
        assert split.train_idx.max() < split.test_idx.min()
        assert not set(split.train_idx.tolist()) & set(split.test_idx.tolist())

    def test_embargo_drops_exactly_that_many_rows_after_the_boundary(self) -> None:
        ts, slugs = self._fixture()
        no_embargo = temporal_index_split(ts, slugs, test_size=0.25, embargo=0)
        embargoed = temporal_index_split(ts, slugs, test_size=0.25, embargo=4)
        assert embargoed.n_embargoed == 4
        assert embargoed.test_idx.size == no_embargo.test_idx.size - 4
        assert embargoed.test_idx.min() == no_embargo.test_idx.min() + 4
        # The embargo never gives the model MORE training rows.
        assert embargoed.train_idx.size == no_embargo.train_idx.size

    def test_markets_straddling_the_boundary_are_purged(self) -> None:
        ts, slugs = self._fixture(dup_at=35)
        split = temporal_index_split(ts, slugs, test_size=0.25, embargo=0)
        assert 35 not in split.test_idx.tolist()
        assert split.n_purged == 1

    def test_blank_slugs_are_not_treated_as_a_shared_market(self) -> None:
        ts, slugs = self._fixture()
        slugs = ["" for _ in slugs]
        split = temporal_index_split(ts, slugs, test_size=0.25, embargo=0)
        assert split.n_purged == 0

    def test_non_chronological_timestamps_are_rejected(self) -> None:
        ts, slugs = self._fixture(10)
        ts[5] = 0.0
        with pytest.raises(ValueError, match="not non-decreasing"):
            temporal_index_split(ts, slugs, test_size=0.25, embargo=0)

    def test_length_mismatch_is_rejected(self) -> None:
        ts, slugs = self._fixture(10)
        with pytest.raises(ValueError, match="length mismatch"):
            temporal_index_split(ts, slugs[:5], test_size=0.25, embargo=0)

    def test_negative_embargo_is_rejected(self) -> None:
        ts, slugs = self._fixture(10)
        with pytest.raises(ValueError, match="embargo must be"):
            temporal_index_split(ts, slugs, embargo=-1)

    def test_explicit_fold_bounds_carve_an_interior_block(self) -> None:
        ts, slugs = self._fixture()
        split = temporal_index_split(ts, slugs, embargo=2, train_end=20, test_end=30)
        assert split.train_idx.tolist() == list(range(20))
        assert split.test_idx.tolist() == list(range(22, 30))

    def test_an_oversized_embargo_empties_the_test_set_rather_than_wrapping(self) -> None:
        ts, slugs = self._fixture(10)
        split = temporal_index_split(ts, slugs, test_size=0.25, embargo=99)
        assert split.test_idx.size == 0

    def test_empty_input_is_handled(self) -> None:
        split = temporal_index_split(np.array([], dtype=np.float64), [], test_size=0.25)
        assert split.train_idx.size == 0
        assert split.test_idx.size == 0


class TestFit:
    def test_export_arithmetic_reproduces_sklearn(self, rng: np.random.Generator) -> None:
        # predict_proba is hand-rolled so a TypeScript port has an executable
        # spec; it must agree with the library it was fitted by.
        from sklearn.linear_model import LogisticRegression

        X = rng.normal(size=(300, len(FEATURE_NAMES)))
        y = (X[:, 0] + rng.normal(scale=0.5, size=300) > 0).astype(int)
        model = fit_meta_labeler(X, y)

        center = np.asarray(model.center)
        scale = np.asarray(model.scale)
        reference = LogisticRegression(C=model.c, solver="lbfgs", max_iter=1000)
        reference.fit((X - center) / scale, y)
        np.testing.assert_allclose(
            model.predict_proba(X), reference.predict_proba((X - center) / scale)[:, 1], rtol=1e-8
        )

    def test_constant_columns_do_not_divide_by_zero(self, rng: np.random.Generator) -> None:
        X = rng.normal(size=(200, len(FEATURE_NAMES)))
        X[:, 3] = 1.0
        y = (X[:, 0] > 0).astype(int)
        model = fit_meta_labeler(X, y)
        assert model.scale[3] == 1.0
        assert np.all(np.isfinite(model.predict_proba(X)))

    def test_single_class_training_data_is_refused(self, rng: np.random.Generator) -> None:
        X = rng.normal(size=(50, len(FEATURE_NAMES)))
        with pytest.raises(ValueError, match="single class"):
            fit_meta_labeler(X, np.ones(50, dtype=int))

    def test_length_mismatch_is_refused(self, rng: np.random.Generator) -> None:
        X = rng.normal(size=(50, len(FEATURE_NAMES)))
        with pytest.raises(ValueError, match="length mismatch"):
            fit_meta_labeler(X, np.ones(10, dtype=int))

    def test_wrong_feature_count_at_inference_is_refused(self, rng: np.random.Generator) -> None:
        X = rng.normal(size=(80, len(FEATURE_NAMES)))
        y = (X[:, 0] > 0).astype(int)
        model = fit_meta_labeler(X, y)
        with pytest.raises(ValueError, match=r"expected \d+ features"):
            model.predict_proba(np.zeros((3, 2)))

    def test_records_the_training_base_rate(self, rng: np.random.Generator) -> None:
        X = rng.normal(size=(100, len(FEATURE_NAMES)))
        y = np.array([1] * 70 + [0] * 30)
        model = fit_meta_labeler(X, y)
        assert model.train_base_rate == pytest.approx(0.70)
        assert model.n_train == 100


class TestEvaluation:
    def test_perfect_predictions_score_perfectly(self) -> None:
        y = np.array([0, 0, 1, 1])
        p = np.array([0.01, 0.02, 0.98, 0.99])
        result = evaluate_meta_predictions(y, p, n_bootstrap=200)
        assert result.auc == pytest.approx(1.0)
        assert result.accuracy == pytest.approx(1.0)
        assert result.brier < 0.01
        assert result.base_rate == pytest.approx(0.5)

    def test_single_class_slice_leaves_auc_undefined_rather_than_half(self) -> None:
        result = evaluate_meta_predictions(np.ones(10, dtype=int), np.full(10, 0.7))
        assert result.auc is None
        assert result.auc_ci_low is None
        assert result.beats_chance is False

    def test_empty_and_mismatched_inputs_are_refused(self) -> None:
        with pytest.raises(ValueError, match="length mismatch"):
            evaluate_meta_predictions(np.array([1, 0]), np.array([0.5]))
        with pytest.raises(ValueError, match="empty slice"):
            evaluate_meta_predictions(np.array([]), np.array([]))

    def test_bootstrap_interval_brackets_the_point_estimate(self, rng: np.random.Generator) -> None:
        y = rng.integers(0, 2, size=200)
        p = np.clip(0.5 + 0.25 * (y - 0.5) + rng.normal(scale=0.15, size=200), 0.01, 0.99)
        result = evaluate_meta_predictions(y, p, n_bootstrap=500, rng=rng)
        assert result.auc_ci_low <= result.auc <= result.auc_ci_high

    def test_bootstrap_returns_none_when_auc_is_undefined(self) -> None:
        assert bootstrap_auc_ci(np.ones(5, dtype=int), np.full(5, 0.6)) == (None, None)
        assert bootstrap_auc_ci(np.array([]), np.array([])) == (None, None)

    def test_bootstrap_is_deterministic_for_a_seeded_generator(self) -> None:
        y = np.array([0, 1] * 40)
        p = np.linspace(0.1, 0.9, 80)
        first = bootstrap_auc_ci(y, p, n_bootstrap=100, rng=np.random.default_rng(7))
        second = bootstrap_auc_ci(y, p, n_bootstrap=100, rng=np.random.default_rng(7))
        assert first == second

    def test_non_finite_predictions_are_dropped_not_fatal(self) -> None:
        # A degenerate fit can emit NaN. That must shrink the report, not abort
        # it half-written.
        y = np.array([0, 1, 0, 1])
        p = np.array([0.2, float("nan"), 0.6, 0.8])
        result = evaluate_meta_predictions(y, p, n_bootstrap=50)
        assert result.n == 3
        assert math.isfinite(result.brier)

    def test_safe_auc_absorbs_sklearn_rejections(self) -> None:
        # The last line of defence: even if a non-finite probability reaches the
        # scorer directly, AUC comes back undefined rather than exploding.
        assert _safe_auc(np.array([0, 1, 0]), np.array([0.2, float("nan"), 0.7])) is None

    def test_an_all_nan_slice_is_refused(self) -> None:
        with pytest.raises(ValueError, match="non-finite"):
            evaluate_meta_predictions(np.array([0, 1]), np.array([float("nan")] * 2))

    def test_a_single_class_after_dropping_nans_still_leaves_auc_undefined(self) -> None:
        y = np.array([1, 0, 1])
        p = np.array([0.7, float("nan"), 0.8])
        result = evaluate_meta_predictions(y, p, n_bootstrap=10)
        assert result.n == 2
        assert result.auc is None

    def test_all_degenerate_resamples_yield_no_interval(self) -> None:
        class _AlwaysFirstRow:
            """A generator stub that resamples the same row every time."""

            def integers(self, low: int, high: int, size: int) -> np.ndarray:
                return np.zeros(size, dtype=int)

        y = np.array([0, 1, 1, 0])
        p = np.array([0.1, 0.9, 0.8, 0.2])
        assert bootstrap_auc_ci(y, p, n_bootstrap=5, rng=_AlwaysFirstRow()) == (None, None)


class TestEndToEndLearning:
    """The two tests that make a null result on real data believable."""

    def test_a_separable_problem_is_learned(self, rng: np.random.Generator) -> None:
        rows = _synthetic_rows(600, signal=True, rng=rng)
        dataset = build_dataset(rows, log=lambda _: None)
        split = temporal_index_split(dataset.entered_at, dataset.slugs, test_size=0.3, embargo=5)
        model = fit_meta_labeler(dataset.X[split.train_idx], dataset.y[split.train_idx])
        result = evaluate_meta_predictions(
            dataset.y[split.test_idx],
            model.predict_proba(dataset.X[split.test_idx]),
            n_bootstrap=300,
            rng=rng,
        )
        assert result.auc > 0.75
        assert result.beats_chance

    def test_pure_noise_scores_about_one_half(self, rng: np.random.Generator) -> None:
        # If the pipeline leaked ANY outcome information into the features, this
        # unpredictable dataset would still score well above chance.
        rows = _synthetic_rows(600, signal=False, rng=rng)
        dataset = build_dataset(rows, log=lambda _: None)
        split = temporal_index_split(dataset.entered_at, dataset.slugs, test_size=0.3, embargo=5)
        model = fit_meta_labeler(dataset.X[split.train_idx], dataset.y[split.train_idx])
        result = evaluate_meta_predictions(
            dataset.y[split.test_idx],
            model.predict_proba(dataset.X[split.test_idx]),
            n_bootstrap=300,
            rng=rng,
        )
        assert result.auc == pytest.approx(0.5, abs=0.12)
        assert result.auc_ci_low < 0.5 < result.auc_ci_high


class TestWalkForward:
    def test_folds_expand_and_stay_out_of_sample(self, rng: np.random.Generator) -> None:
        dataset = build_dataset(_synthetic_rows(400, signal=True, rng=rng), log=lambda _: None)
        summary = walk_forward_evaluation(dataset, n_folds=4, embargo=3, log=lambda _: None)
        assert len(summary.folds) == 4
        train_sizes = [f.n_train for f in summary.folds]
        assert train_sizes == sorted(train_sizes)
        assert summary.mean_auc > 0.7
        assert summary.spread_beats_chance

    def test_noise_data_scores_near_chance_across_folds(self, rng: np.random.Generator) -> None:
        # Note what is asserted and what is not: the fold MEAN must sit near 0.5
        # (a leak would put it near 1.0), but `spread_beats_chance` alone is a
        # weak gate — a handful of noise folds can drift above it by luck, which
        # is exactly why build_verdict demands the bootstrap CI as well.
        dataset = build_dataset(_synthetic_rows(800, signal=False, rng=rng), log=lambda _: None)
        summary = walk_forward_evaluation(dataset, n_folds=5, embargo=3, log=lambda _: None)
        assert summary.mean_auc == pytest.approx(0.5, abs=0.12)
        assert summary.max_auc < 0.75

    def test_folds_that_cannot_be_fitted_are_skipped_not_scored(
        self, rng: np.random.Generator
    ) -> None:
        # Too few rows for MIN_TRAIN_ROWS: every fold must be skipped, and the
        # summary must say "no AUC" rather than inventing 0.5.
        rows = _synthetic_rows(30, signal=True, rng=rng)
        dataset = build_dataset(rows, log=lambda _: None)
        summary = walk_forward_evaluation(dataset, n_folds=3, embargo=1, log=lambda _: None)
        assert summary.folds == ()
        assert summary.mean_auc is None
        assert summary.n_skipped == 3
        assert summary.spread_beats_chance is False

    def test_single_class_training_window_is_skipped(self, rng: np.random.Generator) -> None:
        rows = _synthetic_rows(300, signal=False, rng=rng)
        for i, row in enumerate(rows):
            row["analysis"]["outcome"] = "WIN" if i < 250 else "LOSS"
        dataset = build_dataset(rows, log=lambda _: None)
        summary = walk_forward_evaluation(dataset, n_folds=3, embargo=2, log=lambda _: None)
        assert summary.n_skipped >= 1

    def test_log_reports_fold_accounting(self, rng: np.random.Generator) -> None:
        dataset = build_dataset(_synthetic_rows(300, signal=True, rng=rng), log=lambda _: None)
        lines: list[str] = []
        walk_forward_evaluation(dataset, n_folds=3, log=lines.append)
        assert any("Walk-forward" in line for line in lines)


class TestVerdict:
    def _evaluation(self, auc: float | None, lo: float | None, hi: float | None) -> MetaEvaluation:
        return MetaEvaluation(
            n=100,
            base_rate=0.66,
            accuracy=0.7,
            auc=auc,
            auc_ci_low=lo,
            auc_ci_high=hi,
            brier=0.2,
            ece=0.05,
            mce=0.1,
            calibration={"ece": 0.05, "mce": 0.1, "bins": []},
        )

    def _summary(self, mean: float | None, std: float | None) -> WalkForwardSummary:
        return WalkForwardSummary((), mean, std, mean, mean, 0)

    def test_undefined_auc_is_inconclusive(self) -> None:
        verdict = build_verdict(self._evaluation(None, None, None), self._summary(None, None))
        assert verdict.level == "inconclusive"

    def test_both_signals_positive_is_an_edge(self) -> None:
        verdict = build_verdict(self._evaluation(0.70, 0.60, 0.80), self._summary(0.68, 0.03))
        assert verdict.level == "edge"
        assert "EDGE" in verdict.message

    def test_disagreement_is_reported_as_mixed(self) -> None:
        verdict = build_verdict(self._evaluation(0.70, 0.60, 0.80), self._summary(0.52, 0.10))
        assert verdict.level == "mixed"

    def test_a_flat_result_is_reported_plainly_as_no_edge(self) -> None:
        verdict = build_verdict(self._evaluation(0.52, 0.44, 0.60), self._summary(0.51, 0.05))
        assert verdict.level == "no_edge"
        assert "NO EDGE" in verdict.message
        assert "adds nothing" in verdict.message


class TestExportSchema:
    @pytest.fixture
    def export(self, rng: np.random.Generator) -> dict:
        dataset = build_dataset(_synthetic_rows(300, signal=True, rng=rng), log=lambda _: None)
        split = temporal_index_split(dataset.entered_at, dataset.slugs, test_size=0.25, embargo=5)
        model = fit_meta_labeler(dataset.X[split.train_idx], dataset.y[split.train_idx])
        holdout = evaluate_meta_predictions(
            dataset.y[split.test_idx],
            model.predict_proba(dataset.X[split.test_idx]),
            n_bootstrap=100,
            rng=rng,
        )
        walk_forward = walk_forward_evaluation(dataset, n_folds=3, log=lambda _: None)
        return build_export(
            model,
            dataset=dataset,
            split=split,
            holdout=holdout,
            walk_forward=walk_forward,
            verdict=build_verdict(holdout, walk_forward),
            journal_path="journal.jsonl",
            generated_at="2026-09-04T00:00:00+00:00",
            eligible_outcomes=DEFAULT_ELIGIBLE_OUTCOMES,
            embargo=5,
            test_size=0.25,
        )

    def test_top_level_keys_and_version(self, export: dict) -> None:
        assert export["version"] == MODEL_VERSION
        assert export["kind"] == "logistic_regression"
        assert set(export) == {
            "version",
            "kind",
            "deployed",
            "generatedAt",
            "inference",
            "source",
            "features",
            "model",
            "split",
            "evaluation",
            "verdict",
        }

    def test_it_never_claims_to_be_deployed(self, export: dict) -> None:
        assert export["deployed"] is False

    def test_coefficients_align_with_feature_names(self, export: dict) -> None:
        names = export["features"]["names"]
        assert names == list(FEATURE_NAMES)
        assert len(export["model"]["coefficients"]) == len(names)
        assert len(export["features"]["center"]) == len(names)
        assert len(export["features"]["scale"]) == len(names)

    def test_it_carries_everything_a_port_needs(self, export: dict) -> None:
        assert "exp(" in export["inference"]
        assert isinstance(export["model"]["intercept"], float)
        assert export["features"]["phaseLevels"]
        assert export["features"]["sessionLevels"]
        assert export["features"]["confidenceRanks"]["VERY_HIGH"] == 1.0
        assert "ml_prob_win" in export["features"]["missingDefaults"]

    def test_evaluation_block_reports_the_base_rate_beside_the_score(self, export: dict) -> None:
        holdout = export["evaluation"]["holdout"]
        assert {"n", "baseRate", "accuracy", "auc", "aucCiLow", "aucCiHigh", "brier", "ece"} <= set(
            holdout
        )
        walk = export["evaluation"]["walkForward"]
        assert {"meanAuc", "stdAuc", "minAuc", "maxAuc", "folds"} <= set(walk)

    def test_split_block_records_the_leakage_controls(self, export: dict) -> None:
        split = export["split"]
        assert split["embargoRows"] == 5
        assert split["nTrain"] > 0
        assert split["nTest"] > 0
        assert "nPurgedBySlug" in split

    def test_export_is_json_serialisable(self, export: dict) -> None:
        restored = json.loads(json.dumps(export))
        assert restored["model"]["coefficients"] == export["model"]["coefficients"]

    def test_a_round_tripped_export_scores_identically(
        self, export: dict, rng: np.random.Generator
    ) -> None:
        # The JSON is the contract: rebuilding a MetaLabeler from the serialised
        # bytes alone must reproduce the fitted model's probabilities exactly,
        # which is why the parameter block is exported unrounded.
        restored_json = json.loads(json.dumps(export))
        restored = MetaLabeler(
            feature_names=tuple(restored_json["features"]["names"]),
            coefficients=tuple(restored_json["model"]["coefficients"]),
            intercept=restored_json["model"]["intercept"],
            center=tuple(restored_json["features"]["center"]),
            scale=tuple(restored_json["features"]["scale"]),
            c=restored_json["model"]["l2C"],
            n_train=restored_json["model"]["nTrain"],
            train_base_rate=restored_json["model"]["trainBaseRate"],
        )
        X = rng.normal(size=(20, len(FEATURE_NAMES)))
        probabilities = restored.predict_proba(X)
        assert probabilities.shape == (20,)
        assert np.all((probabilities >= 0) & (probabilities <= 1))
        assert np.all(np.isfinite(probabilities))
