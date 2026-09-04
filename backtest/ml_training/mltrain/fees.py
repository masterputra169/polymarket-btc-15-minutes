"""Per-trade cost and payoff arithmetic for the P&L backtest.

Everything the backtest claims about profitability rests on these five lines of
maths, so they live apart from the simulation loop where they can be asserted
directly. A cost model that is wrong by a few tenths of a percent flips the sign
of the reported edge: the strategy trades ~1000 times on a 1890-row test set, so
each 0.1% of round-trip cost is ~1% of a $1000 bankroll.

Two conventions are baked in and worth stating out loud, because both differ
from how the live bot pays:

1. COST SHAPE. `round_trip_cost_fraction` is a FLAT fraction of `bet_size`,
   charged once per trade regardless of entry price. The live bot instead pays
   Polymarket's price-dependent fee (`polymarket_dynamic_fee_rate`, below),
   which is maximal at p=0.50 and vanishes at the extremes. The flat model is
   the more conservative of the two at every price under the script's 4.0%
   default, but it is not the same function — see that helper's docstring.
2. BET UNIT. `win_payoff`/`loss_amount` pay (1 - entry) * bet_size and charge
   entry * bet_size, which is the arithmetic of buying `bet_size` SHARES (cost
   entry * bet_size, settles at 1.0), not of deploying `bet_size` DOLLARS.

Pure functions: scalars in, scalars out, no state and no I/O. Numpy scalars pass
through with their dtype intact — the simulator feeds float32 prices out of the
feature matrix and the accumulated balance inherits that width, so these helpers
deliberately do not coerce to float and change the result.
"""

from __future__ import annotations

import numpy as np

# argparse defaults in backtestPnL.py, restated as named constants.
DEFAULT_SPREAD_PCT: float = 3.0
DEFAULT_SLIPPAGE_PCT: float = 1.0

# Polymarket prices outside this band are not tradeable size in the 15-min BTC
# books, so entries are bounded before any payoff is computed.
PRICE_FLOOR: float = 0.05
PRICE_CAP: float = 0.95

# Crypto-category dynamic fee coefficient (Mar 2026). See polymarket_dynamic_fee_rate.
DYNAMIC_FEE_COEFFICIENT: float = 0.072

Scalar = float | np.floating


def round_trip_cost_fraction(spread_pct: float, slippage_pct: float) -> float:
    """Round-trip transaction cost as a fraction of bet size.

    Half the spread is paid entering and half exiting, so the whole quoted
    spread plus the slippage is charged once per completed trade.

    Args:
        spread_pct: round-trip spread cost in percent (3.0 = 3%).
        slippage_pct: slippage cost in percent (1.0 = 1%).
    """
    return (spread_pct + slippage_pct) / 100.0


def per_trade_cost(txcost_frac: float, bet_size: float) -> float:
    """Dollar cost charged on every trade, win or lose."""
    return txcost_frac * bet_size


def entry_price(
    market_yes_price: Scalar, side: str, *, floor: float = PRICE_FLOOR, cap: float = PRICE_CAP
) -> Scalar:
    """Price paid for the chosen side, bounded to the tradeable band.

    Polymarket quotes the UP (YES) token; the DOWN token is its complement, so
    a DOWN entry costs 1 - the quoted price.

    Args:
        market_yes_price: quoted UP-token price for this market.
        side: 'UP' to buy the quoted token, anything else for its complement.
        floor / cap: tradeable price band; entries are clipped into it.
    """
    raw = market_yes_price if side == "UP" else (1 - market_yes_price)
    return np.clip(raw, floor, cap)


def net_edge(model_prob: Scalar, entry: Scalar, txcost_frac: float) -> Scalar:
    """Model probability minus what the market charges for it, after costs.

    Positive means the model thinks the token is underpriced by more than the
    round trip costs to take. This is the quantity compared against --min-edge.
    """
    return model_prob - entry - txcost_frac


def win_payoff(entry: Scalar, bet_size: float) -> Scalar:
    """Gross profit when the position settles in the money.

    Shares bought at `entry` settle at 1.0, so each returns (1 - entry).
    Excludes the transaction cost, which the caller charges separately.
    """
    return (1 - entry) * bet_size


def loss_amount(entry: Scalar, bet_size: float) -> Scalar:
    """Gross loss when the position settles worthless — the full premium paid."""
    return entry * bet_size


def polymarket_dynamic_fee_rate(
    price: Scalar, *, coefficient: float = DYNAMIC_FEE_COEFFICIENT
) -> Scalar:
    """Polymarket's price-dependent taker fee: 0.072 * p * (1 - p).

    REFERENCE ONLY — the simulator does NOT apply this. It is the fee the live
    bot actually pays (Crypto category, Mar 2026; see CLAUDE.md and
    bot/src/trading/clobClient.ts), peaking at 1.80% when p = 0.50 and falling
    to 0.34% at the p = 0.05 / 0.95 band edges. It is provided so the backtest's
    flat cost assumption can be checked against reality rather than trusted:
    at the script's 4.0% default the flat charge is conservative everywhere,
    but the two curves have opposite shapes, so a backtest run with a low
    --spread-pct can understate costs precisely where the bot trades most.

    Args:
        price: entry price of the token being bought.
        coefficient: category fee coefficient (0.072 for Crypto).
    """
    return coefficient * price * (1 - price)
