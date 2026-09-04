"""Unit tests for mltrain.polymarket_lookup — the real-label spine of the corpus.

This stage cannot fail loudly. generateTrainingData.mts drops any market whose
`prices` list is empty, so a tick quietly binned to the wrong market, a series
left unsorted, or a merge that forgets the markets fetchFreshMarkets.mts
discovered all show up as a smaller training set and a worse model — never as an
error. Every test here pins one of those silent failures:

  * `TestMergeExisting` is the important one. `test_never_drops_an_existing_entry`
    and `test_second_merge_is_a_no_op` are what stand between a rebuild from the
    static Feb-2026 scrape and losing ~13k markets of tick prices.
  * `TestIngestPriceHistory::test_running_twice_duplicates_the_series` documents
    that the ingest is NOT idempotent, which is why the entrypoint builds a fresh
    lookup every run rather than topping one up.
  * `TestScriptEndToEnd` pins the two file-level guarantees the pure functions
    cannot: a second identical run produces a byte-identical file, and an empty
    master CSV refuses to write rather than truncating the lookup to "{}".
"""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

import pytest

from mltrain.polymarket_lookup import (
    MARKET_WINDOW_SECS,
    build_market_lookup,
    ingest_price_history,
    merge_existing,
    slug_to_lookup_key,
    sort_price_series,
    summarise_lookup,
)

pytestmark = pytest.mark.unit

PACKAGE_ROOT = Path(__file__).resolve().parents[1]
SCRIPT = PACKAGE_ROOT / "preparePolymarketFeatures.py"

MASTER_HEADER = "slug_timestamp,resolved_label,spread,liquidity,volume"
PRICE_HEADER = "slug,token_side,timestamp_unix,price"


def _master_row(
    slug_ts: str = "1760704200",
    label: str = "1",
    spread: str = "0.02",
    liquidity: str = "1000",
    volume: str = "5000",
) -> dict[str, str]:
    return {
        "slug_timestamp": slug_ts,
        "resolved_label": label,
        "spread": spread,
        "liquidity": liquidity,
        "volume": volume,
    }


def _price_row(
    slug: str = "btc-updown-15m-1760704200",
    token_side: str = "up",
    timestamp_unix: str = "1760704260",
    price: str = "0.55",
) -> dict[str, str]:
    return {
        "slug": slug,
        "token_side": token_side,
        "timestamp_unix": timestamp_unix,
        "price": price,
    }


class TestSlugToLookupKey:
    def test_extracts_the_trailing_timestamp(self) -> None:
        assert slug_to_lookup_key("btc-updown-15m-1760704200") == "1760704200"

    def test_returns_none_without_a_dash(self) -> None:
        assert slug_to_lookup_key("nodashhere") is None

    def test_key_stays_a_string(self) -> None:
        # JSON object keys are strings; an int round-trip would split the lookup
        # into "1760704200" and 1760704200 buckets that never match.
        assert isinstance(slug_to_lookup_key("btc-updown-15m-1760704200"), str)

    def test_only_the_final_segment_is_taken(self) -> None:
        assert slug_to_lookup_key("a-b-c-d-999") == "999"


class TestBuildMarketLookup:
    def test_empty_input_yields_an_empty_lookup(self) -> None:
        assert build_market_lookup([]) == {}

    def test_parses_every_field(self) -> None:
        lookup = build_market_lookup([_master_row()])
        assert lookup["1760704200"] == {
            "label": 1,
            "spread": 0.02,
            "liquidity": 1000.0,
            "volume": 5000.0,
            "prices": [],
        }

    def test_blank_market_size_columns_default_to_zero(self) -> None:
        lookup = build_market_lookup([_master_row(spread="", liquidity="", volume="")])
        entry = lookup["1760704200"]
        assert entry["spread"] == 0.0
        assert entry["liquidity"] == 0.0
        assert entry["volume"] == 0.0

    def test_whitespace_around_the_key_is_stripped(self) -> None:
        lookup = build_market_lookup([_master_row(slug_ts="  1760704200  ")])
        assert "1760704200" in lookup

    def test_duplicate_timestamps_collapse_to_the_last_row(self) -> None:
        lookup = build_market_lookup([_master_row(label="1"), _master_row(label="0")])
        assert len(lookup) == 1
        assert lookup["1760704200"]["label"] == 0

    def test_prices_start_empty_and_are_not_shared_between_markets(self) -> None:
        lookup = build_market_lookup([_master_row(slug_ts="1"), _master_row(slug_ts="2")])
        lookup["1"]["prices"].append([0, 0.5])
        assert lookup["2"]["prices"] == []

    def test_a_malformed_label_raises_rather_than_skipping(self) -> None:
        # Deliberate and unchanged: the master CSV is machine-generated, so a bad
        # row means the scrape broke. Half a label set is worse than no run.
        with pytest.raises(ValueError):
            build_market_lookup([_master_row(label="")])

    def test_a_missing_column_raises(self) -> None:
        with pytest.raises(KeyError):
            build_market_lookup([{"slug_timestamp": "1"}])


class TestIngestPriceHistory:
    def test_empty_input_reports_all_zeros(self) -> None:
        lookup = build_market_lookup([_master_row()])
        stats = ingest_price_history(lookup, [], log=lambda _: None)
        assert (stats.rows_read, stats.matched, stats.skipped_side, stats.skipped_range) == (
            0,
            0,
            0,
            0,
        )
        assert lookup["1760704200"]["prices"] == []

    def test_stores_seconds_into_market_not_the_wall_clock(self) -> None:
        lookup = build_market_lookup([_master_row()])
        ingest_price_history(lookup, [_price_row(timestamp_unix="1760704260")], log=lambda _: None)
        assert lookup["1760704200"]["prices"] == [[60, 0.55]]

    def test_non_up_tokens_are_skipped_and_counted(self) -> None:
        lookup = build_market_lookup([_master_row()])
        stats = ingest_price_history(lookup, [_price_row(token_side="down")], log=lambda _: None)
        assert stats.skipped_side == 1
        assert stats.matched == 0
        assert lookup["1760704200"]["prices"] == []

    def test_token_side_matching_tolerates_case_and_padding(self) -> None:
        lookup = build_market_lookup([_master_row()])
        stats = ingest_price_history(lookup, [_price_row(token_side=" UP ")], log=lambda _: None)
        assert stats.matched == 1

    @pytest.mark.parametrize("secs", [0, 1, MARKET_WINDOW_SECS - 1, MARKET_WINDOW_SECS])
    def test_ticks_inside_the_window_are_kept(self, secs: int) -> None:
        lookup = build_market_lookup([_master_row()])
        stats = ingest_price_history(
            lookup, [_price_row(timestamp_unix=str(1760704200 + secs))], log=lambda _: None
        )
        assert stats.matched == 1
        assert lookup["1760704200"]["prices"] == [[secs, 0.55]]

    @pytest.mark.parametrize("secs", [-1, MARKET_WINDOW_SECS + 1, 100_000])
    def test_ticks_outside_the_window_are_dropped_and_counted(self, secs: int) -> None:
        lookup = build_market_lookup([_master_row()])
        stats = ingest_price_history(
            lookup, [_price_row(timestamp_unix=str(1760704200 + secs))], log=lambda _: None
        )
        assert stats.skipped_range == 1
        assert lookup["1760704200"]["prices"] == []

    def test_ticks_for_unknown_markets_are_dropped_without_creating_entries(self) -> None:
        lookup = build_market_lookup([_master_row()])
        stats = ingest_price_history(
            lookup, [_price_row(slug="btc-updown-15m-9999999999")], log=lambda _: None
        )
        assert list(lookup) == ["1760704200"]
        assert stats.matched == 0
        assert stats.rows_read == 1

    def test_unparseable_rows_are_skipped_not_raised(self) -> None:
        lookup = build_market_lookup([_master_row()])
        rows = [
            _price_row(price="n/a"),
            _price_row(timestamp_unix=""),
            _price_row(slug="nodash"),
            _price_row(),
        ]
        stats = ingest_price_history(lookup, rows, log=lambda _: None)
        assert stats.rows_read == 4
        assert stats.matched == 1

    def test_prices_are_rounded_to_the_configured_precision(self) -> None:
        lookup = build_market_lookup([_master_row()])
        ingest_price_history(lookup, [_price_row(price="0.1234567891")], log=lambda _: None)
        assert lookup["1760704200"]["prices"] == [[60, 0.123457]]

    def test_running_twice_duplicates_the_series(self) -> None:
        # NOT idempotent by design — the entrypoint always builds a fresh lookup.
        # Pinned so a future "incremental top-up" caller cannot appear silently.
        lookup = build_market_lookup([_master_row()])
        rows = [_price_row()]
        ingest_price_history(lookup, rows, log=lambda _: None)
        ingest_price_history(lookup, rows, log=lambda _: None)
        assert lookup["1760704200"]["prices"] == [[60, 0.55], [60, 0.55]]

    def test_progress_is_logged_on_the_configured_cadence(self) -> None:
        lookup = build_market_lookup([_master_row()])
        lines: list[str] = []
        ingest_price_history(
            lookup, [_price_row() for _ in range(6)], progress_every=2, log=lines.append
        )
        assert len(lines) == 3
        assert "rows processed" in lines[0]

    def test_a_missing_token_side_column_raises(self) -> None:
        lookup = build_market_lookup([_master_row()])
        with pytest.raises(KeyError):
            ingest_price_history(lookup, [{"slug": "btc-15m-1"}], log=lambda _: None)


class TestSortPriceSeries:
    def test_orders_ticks_by_seconds_into_market(self) -> None:
        lookup = {"a": {"prices": [[300, 0.6], [60, 0.5], [180, 0.55]]}}
        sort_price_series(lookup)
        assert lookup["a"]["prices"] == [[60, 0.5], [180, 0.55], [300, 0.6]]

    def test_counts_only_markets_that_have_ticks(self) -> None:
        lookup = {"a": {"prices": [[1, 0.5]]}, "b": {"prices": []}, "c": {"prices": [[2, 0.5]]}}
        assert sort_price_series(lookup) == 2

    def test_is_idempotent(self) -> None:
        lookup = {"a": {"prices": [[300, 0.6], [60, 0.5]]}}
        sort_price_series(lookup)
        snapshot = [list(tick) for tick in lookup["a"]["prices"]]
        assert sort_price_series(lookup) == 1
        assert lookup["a"]["prices"] == snapshot

    def test_empty_lookup_reports_zero(self) -> None:
        assert sort_price_series({}) == 0


class TestMergeExisting:
    def test_never_drops_an_existing_entry(self) -> None:
        # The whole point of --merge: markets fetchFreshMarkets.mts discovered
        # after the static scrape must survive a rebuild.
        lookup = {"1": {"label": 1, "prices": []}}
        existing = {"2": {"label": 0, "prices": [[0, 0.4]]}, "3": {"label": 1, "prices": []}}
        added = merge_existing(lookup, existing)
        assert added == 2
        assert set(lookup) == {"1", "2", "3"}
        for key in existing:
            assert lookup[key] == existing[key]

    def test_dataset_wins_a_tie_on_collision(self) -> None:
        # Equal-length series: keep the freshly-built entry so a rebuilt market
        # picks up the newer label.
        lookup = {"1": {"label": 1, "prices": [[0, 0.9]]}}
        added = merge_existing(lookup, {"1": {"label": 0, "prices": [[0, 0.4]]}})
        assert added == 0
        assert lookup["1"] == {"label": 1, "prices": [[0, 0.9]]}

    def test_richer_price_series_wins_on_collision(self) -> None:
        # The static scrape carries labels for markets it has no ticks for.
        # Letting it win unconditionally stripped prices from markets that had
        # them — on the real lookup that was 25,835 priced markets down to
        # 16,395, and generateTrainingData discards priceless rows silently.
        lookup = {"1": {"label": 1, "prices": []}}
        merge_existing(lookup, {"1": {"label": 1, "prices": [[0, 0.4], [60, 0.5]]}})
        assert lookup["1"]["prices"] == [[0, 0.4], [60, 0.5]]

    def test_thinner_price_series_never_replaces_a_richer_one(self) -> None:
        lookup = {"1": {"label": 1, "prices": [[0, 0.4], [60, 0.5], [120, 0.6]]}}
        merge_existing(lookup, {"1": {"label": 0, "prices": [[0, 0.9]]}})
        assert len(lookup["1"]["prices"]) == 3

    def test_second_merge_is_a_no_op(self) -> None:
        lookup = {"1": {"label": 1, "prices": []}}
        existing = {"2": {"label": 0, "prices": []}}
        assert merge_existing(lookup, existing) == 1
        snapshot = json.dumps(lookup, sort_keys=True)
        assert merge_existing(lookup, existing) == 0
        assert json.dumps(lookup, sort_keys=True) == snapshot

    def test_unknown_fields_on_merged_entries_survive(self) -> None:
        existing = {"2": {"label": 0, "prices": [], "sourced_by": "fetchFreshMarkets", "extra": 7}}
        lookup: dict[str, dict] = {}
        merge_existing(lookup, existing)
        assert lookup["2"]["sourced_by"] == "fetchFreshMarkets"
        assert lookup["2"]["extra"] == 7

    def test_empty_existing_adds_nothing(self) -> None:
        lookup = {"1": {"label": 1, "prices": []}}
        assert merge_existing(lookup, {}) == 0
        assert list(lookup) == ["1"]

    def test_merging_into_an_empty_lookup_keeps_everything(self) -> None:
        existing = {"1": {"label": 1, "prices": []}, "2": {"label": 0, "prices": []}}
        lookup: dict[str, dict] = {}
        assert merge_existing(lookup, existing) == 2
        assert lookup == existing


class TestSummariseLookup:
    def test_empty_lookup_does_not_divide_by_zero(self) -> None:
        summary = summarise_lookup({})
        assert (summary.n_markets, summary.n_up, summary.n_down) == (0, 0, 0)
        assert summary.avg_prices_per_market == 0.0

    def test_counts_the_label_balance(self) -> None:
        lookup = {
            "1": {"label": 1, "prices": []},
            "2": {"label": 1, "prices": []},
            "3": {"label": 0, "prices": []},
        }
        summary = summarise_lookup(lookup)
        assert (summary.n_markets, summary.n_up, summary.n_down) == (3, 2, 1)

    def test_average_tick_count_is_the_price_density_signal(self) -> None:
        # Near-zero means a label-only lookup, which trains on almost nothing.
        lookup = {
            "1": {"label": 1, "prices": [[0, 0.5], [60, 0.5]]},
            "2": {"label": 0, "prices": []},
        }
        assert summarise_lookup(lookup).avg_prices_per_market == 1.0

    def test_an_entry_without_a_label_raises(self) -> None:
        with pytest.raises(KeyError):
            summarise_lookup({"1": {"prices": []}})


class TestPipelineComposition:
    def test_build_ingest_sort_merge_summarise(self) -> None:
        lookup = build_market_lookup(
            [
                _master_row(slug_ts="1760704200", label="1"),
                _master_row(slug_ts="1760705100", label="0"),
            ]
        )
        ingest_price_history(
            lookup,
            [
                _price_row(slug="btc-updown-15m-1760704200", timestamp_unix="1760704500"),
                _price_row(slug="btc-updown-15m-1760704200", timestamp_unix="1760704260"),
                _price_row(slug="btc-updown-15m-1760705100", token_side="down"),
            ],
            log=lambda _: None,
        )
        assert sort_price_series(lookup) == 1
        assert lookup["1760704200"]["prices"] == [[60, 0.55], [300, 0.55]]

        merge_existing(lookup, {"1760706000": {"label": 1, "prices": [[0, 0.5]]}})
        summary = summarise_lookup(lookup)
        assert summary.n_markets == 3
        assert summary.n_up == 2
        assert summary.avg_prices_per_market == 1.0


def _write_dataset(
    data_dir: Path, master_rows: list[str], price_rows: list[str] | None = None
) -> None:
    data_dir.mkdir(parents=True, exist_ok=True)
    (data_dir / "02_btc15m_ml_ready.csv").write_text(
        "\n".join([MASTER_HEADER, *master_rows]) + "\n", encoding="utf-8"
    )
    (data_dir / "price_history.csv").write_text(
        "\n".join([PRICE_HEADER, *(price_rows or [])]) + "\n", encoding="utf-8"
    )


def _run_script(*argv: str, cwd: Path) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [sys.executable, str(SCRIPT), *argv],
        cwd=str(cwd),
        capture_output=True,
        text=True,
        check=False,
    )


@pytest.mark.integration
class TestScriptEndToEnd:
    """File-level guarantees the pure functions cannot make on their own."""

    def test_writes_a_lookup_and_is_byte_identical_on_a_rerun(self, tmp_path: Path) -> None:
        data_dir = tmp_path / "data"
        _write_dataset(
            data_dir,
            ["1760704200,1,0.02,1000,5000", "1760705100,0,0.03,900,4000"],
            [
                "btc-updown-15m-1760704200,up,1760704500,0.61",
                "btc-updown-15m-1760704200,up,1760704260,0.55",
                "btc-updown-15m-1760705100,down,1760705160,0.40",
            ],
        )
        out = tmp_path / "lookup.json"

        first = _run_script("--data-dir", str(data_dir), "--output", str(out), cwd=tmp_path)
        assert first.returncode == 0, first.stderr
        payload = out.read_bytes()

        second = _run_script("--data-dir", str(data_dir), "--output", str(out), cwd=tmp_path)
        assert second.returncode == 0, second.stderr
        assert out.read_bytes() == payload

        lookup = json.loads(payload)
        assert lookup["1760704200"]["prices"] == [[60, 0.55], [300, 0.61]]
        assert lookup["1760705100"]["prices"] == []
        assert lookup["1760705100"]["label"] == 0

    def test_merge_keeps_markets_absent_from_the_dataset(self, tmp_path: Path) -> None:
        data_dir = tmp_path / "data"
        _write_dataset(data_dir, ["1760704200,1,0.02,1000,5000"])
        existing = tmp_path / "existing.json"
        existing.write_text(
            json.dumps(
                {
                    "1760704200": {
                        "label": 0,
                        "spread": 0,
                        "liquidity": 0,
                        "volume": 0,
                        "prices": [],
                    },
                    "1799999999": {
                        "label": 1,
                        "spread": 0.01,
                        "liquidity": 5,
                        "volume": 9,
                        "prices": [[0, 0.5]],
                    },
                }
            ),
            encoding="utf-8",
        )
        out = tmp_path / "lookup.json"

        result = _run_script(
            "--data-dir",
            str(data_dir),
            "--output",
            str(out),
            "--merge",
            str(existing),
            cwd=tmp_path,
        )
        assert result.returncode == 0, result.stderr

        lookup = json.loads(out.read_text())
        assert set(lookup) == {"1760704200", "1799999999"}
        assert lookup["1760704200"]["label"] == 1  # dataset wins on collision
        assert lookup["1799999999"]["prices"] == [[0, 0.5]]  # carried over untouched

    def test_an_empty_master_csv_refuses_to_truncate_the_lookup(self, tmp_path: Path) -> None:
        # Was: wrote "{}" over the target, THEN died with ZeroDivisionError.
        data_dir = tmp_path / "data"
        _write_dataset(data_dir, [])
        out = tmp_path / "lookup.json"
        out.write_text('{"1760704200":{"label":1,"prices":[]}}', encoding="utf-8")

        result = _run_script("--data-dir", str(data_dir), "--output", str(out), cwd=tmp_path)
        assert result.returncode == 1
        assert "no market rows" in result.stdout
        assert "Traceback" not in result.stderr
        assert json.loads(out.read_text()) == {"1760704200": {"label": 1, "prices": []}}

    def test_a_missing_input_file_exits_one_before_writing(self, tmp_path: Path) -> None:
        out = tmp_path / "lookup.json"
        result = _run_script(
            "--data-dir", str(tmp_path / "nope"), "--output", str(out), cwd=tmp_path
        )
        assert result.returncode == 1
        assert "not found" in result.stdout
        assert not out.exists()
