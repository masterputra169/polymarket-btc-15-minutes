"""Building polymarket_lookup.json — the real-label spine of the training corpus.

Every honest label in training_data.csv comes out of this file. generateTrainingData.mts
looks a market up by its slug timestamp and reads `label` (did BTC close up?),
`spread` / `liquidity` / `volume`, and `prices` (the UP-token tick series that
becomes the market features). A market whose `prices` list is empty contributes
NO training row at all — the simulation fallback was removed in Apr 2026 — so
losing a price series here shrinks the corpus without raising anything.

That asymmetry is the reason this stage is worth pinning with tests: its failure
mode is not a crash, it is a quietly smaller dataset. `merge_existing` is the
single thing standing between a rebuild from the static scrape in
polymarket_btc15m_data/ and the loss of every market discovered since by
fetchFreshMarkets.mts.

Parsed CSV rows in, plain dicts and frozen stat dataclasses out. Entries stay
dicts rather than dataclasses on purpose: merged entries come from an existing
JSON file that other producers wrote, and round-tripping them unmodified is the
whole point of a merge. The only side effect is the injected `log` callable,
which preparePolymarketFeatures.py wires to `print` so stdout keeps its shape.
"""

from __future__ import annotations

from collections.abc import Callable, Iterable, Mapping
from dataclasses import dataclass
from typing import Any

# One market is 15 minutes; a tick stamped outside [0, 900] belongs to a
# different market (or is a clock error) and is dropped rather than clamped.
MARKET_WINDOW_SECS: int = 900
# Tick prices are quoted in cents; 6 decimals is far past the tick size and
# keeps the JSON compact (the file is read whole by a Node process).
PRICE_DECIMALS: int = 6
# Progress cadence over the price CSV, which runs to millions of rows.
PROGRESS_EVERY: int = 500_000
# price_history.csv carries both sides of the book; only the UP token is stored,
# since the DOWN price is 1 - UP and the features are defined on UP.
UP_TOKEN_SIDE: str = "up"

# A lookup entry as generateTrainingData.mts consumes it. Kept as a dict so that
# entries merged in from an existing lookup survive untouched, including any
# fields this script does not know about.
MarketEntry = dict[str, Any]


@dataclass(frozen=True)
class PriceIngest:
    """Row accounting for the price-history pass.

    The four counters do not sum to `rows_read`: rows whose slug does not parse,
    whose market is absent from the lookup, or whose numeric fields do not
    convert are dropped without a counter. That is the script's long-standing
    behaviour and is preserved verbatim — `matched` is the only number the
    caller should trust as "ticks actually stored".
    """

    rows_read: int
    matched: int
    skipped_side: int
    skipped_range: int


@dataclass(frozen=True)
class LookupSummary:
    """Label balance and price density over a finished lookup.

    `avg_prices_per_market` is the honest health metric: a value near zero means
    the lookup is label-only, which downstream translates into a training corpus
    that silently drops almost every row.
    """

    n_markets: int
    n_up: int
    n_down: int
    avg_prices_per_market: float


def slug_to_lookup_key(slug: str) -> str | None:
    """Trailing timestamp of a `btc-updown-15m-<ts>` slug, or None.

    The suffix after the final dash is the lookup key verbatim — as a string,
    never an int, because JSON object keys are strings and a numeric round-trip
    would put `1760704200` and `"1760704200"` in different buckets.
    """
    parts = slug.rsplit("-", 1)
    if len(parts) != 2:
        return None
    return parts[1]


def build_market_lookup(rows: Iterable[Mapping[str, str]]) -> dict[str, MarketEntry]:
    """Turn master-CSV rows into keyed entries with empty price series.

    Every row is required to carry `slug_timestamp` and a parseable
    `resolved_label`; a row missing either raises rather than being skipped.
    That is deliberate and unchanged: the master CSV is machine-generated, so a
    malformed row means the scrape broke, and half a label set is worse than no
    run at all. The three market-size columns are optional and default to 0.0.

    Duplicate slug timestamps collapse — the last row wins — which matches the
    dict-assignment the script has always done.

    Args:
        rows: `csv.DictReader` over 02_btc15m_ml_ready.csv.
    """
    lookup: dict[str, MarketEntry] = {}
    for row in rows:
        slug_ts = row["slug_timestamp"].strip()
        lookup[slug_ts] = {
            "label": int(row["resolved_label"]),
            "spread": float(row["spread"]) if row["spread"] else 0.0,
            "liquidity": float(row["liquidity"]) if row["liquidity"] else 0.0,
            "volume": float(row["volume"]) if row["volume"] else 0.0,
            "prices": [],  # filled by ingest_price_history
        }
    return lookup


def ingest_price_history(
    lookup: dict[str, MarketEntry],
    rows: Iterable[Mapping[str, str]],
    *,
    window_secs: int = MARKET_WINDOW_SECS,
    price_decimals: int = PRICE_DECIMALS,
    progress_every: int = PROGRESS_EVERY,
    log: Callable[[str], None] = print,
) -> PriceIngest:
    """Append `[secs_into_market, up_price]` ticks onto the entries in `lookup`.

    MUTATES `lookup`: ticks are appended to each entry's existing `prices` list,
    so calling this twice with the same rows doubles the series. The script
    calls it once per run against a freshly built lookup.

    Rows are dropped — silently, by design — when the token is not UP, the slug
    has no dash, the market is not in `lookup`, the numeric fields do not parse,
    or the tick falls outside [0, `window_secs`]. Only the first and last of
    those are counted, matching the script's existing report line.

    Args:
        lookup: entries from `build_market_lookup`, mutated in place.
        rows: `csv.DictReader` over price_history.csv.
        window_secs: market duration; ticks outside [0, window] are out-of-range.
        price_decimals: rounding applied before storage, to keep the JSON small.
        progress_every: emit a progress line every N rows read.
        log: stdout sink; the script passes `print`.
    """
    rows_read = 0
    matched = 0
    skipped_side = 0
    skipped_range = 0

    for row in rows:
        rows_read += 1

        # Only UP token prices
        if row["token_side"].strip().lower() != UP_TOKEN_SIDE:
            skipped_side += 1
            continue

        slug_ts_str = slug_to_lookup_key(row["slug"].strip())
        if slug_ts_str is None or slug_ts_str not in lookup:
            continue

        try:
            slug_ts_int = int(slug_ts_str)
            obs_ts = int(row["timestamp_unix"])
            price = float(row["price"])
        except (ValueError, KeyError):
            continue

        # secs_into_market: how many seconds after market opened
        secs_into = obs_ts - slug_ts_int
        if secs_into < 0 or secs_into > window_secs:
            skipped_range += 1
            continue

        lookup[slug_ts_str]["prices"].append([secs_into, round(price, price_decimals)])
        matched += 1

        # Cadence quirk preserved: the counter advances on every row but the
        # check is only reached by rows that made it all the way to `matched`,
        # so a progress line appears only when the Nth row is itself a hit.
        if rows_read % progress_every == 0:
            log(f"   {rows_read:,} rows processed, {matched:,} matched...")

    return PriceIngest(
        rows_read=rows_read,
        matched=matched,
        skipped_side=skipped_side,
        skipped_range=skipped_range,
    )


def sort_price_series(lookup: Mapping[str, MarketEntry]) -> int:
    """Sort each market's ticks by seconds-into-market; count the ones that have any.

    MUTATES the lists inside `lookup`. CSV order is not guaranteed chronological
    and the browser-side feature code reads `prices` positionally, so an
    unsorted series would hand it a scrambled price path. Sorting is stable and
    idempotent: a second call changes nothing.
    """
    markets_with_prices = 0
    for entry in lookup.values():
        if entry["prices"]:
            entry["prices"].sort(key=lambda tick: tick[0])
            markets_with_prices += 1
    return markets_with_prices


def merge_existing(lookup: dict[str, MarketEntry], existing: Mapping[str, MarketEntry]) -> int:
    """Fold `existing` into `lookup`, keeping the richer price series; return entries added.

    MUTATES `lookup`. Markets only in `existing` — everything
    fetchFreshMarkets.mts has discovered since the static scrape — are carried
    over untouched, references and unknown fields included.

    On collision the entry with MORE price ticks wins. The static scrape holds
    labels for many markets it has no tick history for, so letting it win
    unconditionally silently stripped prices from markets that already had them:
    merging the real lookup on 2026-09-04 kept all 25,870 markets but dropped
    priced ones from 25,835 to 16,395, and generateTrainingData discards
    priceless rows without complaining. Ties keep the freshly-built entry, so a
    rebuilt market with an equal-length series still takes the newer labels.
    """
    merged_count = 0
    for key, val in existing.items():
        if key not in lookup:
            lookup[key] = val
            merged_count += 1
            continue
        if len(val.get("prices") or ()) > len(lookup[key].get("prices") or ()):
            lookup[key] = val
    return merged_count


def summarise_lookup(lookup: Mapping[str, MarketEntry]) -> LookupSummary:
    """Label balance and average tick count over the whole lookup.

    Every entry must carry `label` and `prices`; a merge source missing either
    raises here. Returns zeros for an empty lookup rather than dividing by it.
    """
    labels = [entry["label"] for entry in lookup.values()]
    up_count = sum(labels)
    total_prices = sum(len(entry["prices"]) for entry in lookup.values())
    return LookupSummary(
        n_markets=len(lookup),
        n_up=up_count,
        n_down=len(labels) - up_count,
        avg_prices_per_market=total_prices / max(len(lookup), 1),
    )
