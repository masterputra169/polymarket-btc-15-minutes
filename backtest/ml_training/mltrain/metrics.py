"""Metric, calibration-quality and rounding helpers.

Pure functions: no global state, no I/O. Used by the trainer to build the
exported `metrics` block (Brier, ECE/MCE, confidence buckets) that the
deploy gates in bot/src/autoRetrain.ts read by name.
"""

from __future__ import annotations

import math

import numpy as np
from sklearn.metrics import accuracy_score


def safe_round(value: float | int | None, digits: int = 4) -> float | None:
    if value is None:
        return None
    try:
        v = float(value)
    except (TypeError, ValueError):
        return None
    if not np.isfinite(v):
        return None
    return round(v, digits)


def calibration_summary(
    y_true: np.ndarray, y_prob: np.ndarray, bins: int = 10
) -> dict[str, object]:
    """Expected calibration error for probability-of-UP predictions."""
    y_true = np.asarray(y_true)
    y_prob = np.asarray(y_prob)
    nan_mask = np.isnan(y_prob)
    if np.any(nan_mask):
        print(f"   [WARN] calibration_summary: dropping {int(nan_mask.sum())} NaN probabilities")
        y_true = y_true[~nan_mask]
        y_prob = y_prob[~nan_mask]
    edges = np.linspace(0.0, 1.0, bins + 1)
    total = max(1, len(y_prob))
    rows = []
    ece = 0.0
    mce = 0.0

    for i in range(bins):
        lo = float(edges[i])
        hi = float(edges[i + 1])
        if i == bins - 1:
            mask = (y_prob >= lo) & (y_prob <= hi)
        else:
            mask = (y_prob >= lo) & (y_prob < hi)

        count = int(mask.sum())
        if count == 0:
            rows.append(
                {
                    "min_prob": round(lo, 2),
                    "max_prob": round(hi, 2),
                    "count": 0,
                    "coverage_pct": 0.0,
                    "avg_predicted": None,
                    "observed_rate": None,
                    "gap": None,
                }
            )
            continue

        avg_pred = float(y_prob[mask].mean())
        observed = float(y_true[mask].mean())
        gap = abs(avg_pred - observed)
        ece += (count / total) * gap
        mce = max(mce, gap)
        rows.append(
            {
                "min_prob": round(lo, 2),
                "max_prob": round(hi, 2),
                "count": count,
                "coverage_pct": round(count / total * 100, 2),
                "avg_predicted": round(avg_pred, 4),
                "observed_rate": round(observed, 4),
                "gap": round(gap, 4),
            }
        )

    return {
        "ece": float(ece),
        "mce": float(mce),
        "bins": rows,
    }


def confidence_bucket_summary(y_true: np.ndarray, y_prob: np.ndarray) -> list[dict[str, object]]:
    """Accuracy broken down by prediction-confidence bucket.

    Confidence is max(p, 1-p) of the probability-of-UP prediction, bucketed
    into [0.50, 0.55), ..., [0.80, 0.90), [0.90, 1.00] (upper bucket inclusive).
    Returns one dict per bucket with: min_confidence, max_confidence, count,
    coverage_pct, and accuracy (None when the bucket is empty).
    """
    y_true = np.asarray(y_true)
    y_prob = np.asarray(y_prob)
    nan_mask = np.isnan(y_prob)
    if np.any(nan_mask):
        print(
            f"   [WARN] confidence_bucket_summary: dropping {int(nan_mask.sum())} NaN probabilities"
        )
        y_true = y_true[~nan_mask]
        y_prob = y_prob[~nan_mask]
    y_pred = y_prob >= 0.5
    confidence = np.maximum(y_prob, 1 - y_prob)
    total = max(1, len(y_prob))
    buckets = [
        (0.50, 0.55),
        (0.55, 0.60),
        (0.60, 0.65),
        (0.65, 0.70),
        (0.70, 0.75),
        (0.75, 0.80),
        (0.80, 0.90),
        (0.90, 1.01),
    ]
    rows = []

    for lo, hi in buckets:
        if hi >= 1.0:
            mask = (confidence >= lo) & (confidence <= 1.0)
        else:
            mask = (confidence >= lo) & (confidence < hi)
        count = int(mask.sum())
        acc = accuracy_score(y_true[mask], y_pred[mask]) if count > 0 else None
        rows.append(
            {
                "min_confidence": round(lo, 2),
                "max_confidence": round(min(hi, 1.0), 2),
                "count": count,
                "coverage_pct": round(count / total * 100, 2),
                "accuracy": safe_round(acc),
            }
        )

    return rows


def market_skill(
    y_true: np.ndarray, model_prob: np.ndarray, market_prob: np.ndarray
) -> dict[str, float | int | None]:
    """Score the model against the Polymarket price at the same instant.

    Skill = 1 - model_loss / market_loss. Positive means the model predicts the
    resolution better than the market already does; zero means it adds
    nothing; negative means betting on its disagreements with the market loses.

    Accuracy and AUC cannot answer that question. The model deployed on
    2026-09-05 reported 78% / AUC 0.87, while the market price at the moment
    each row described scored better (Brier 0.143 vs 0.147).

    Rows whose market price is missing (NaN, or <= 0 / >= 1, which no live
    quote is) are dropped rather than scored as a coin flip.
    """
    y = np.asarray(y_true, dtype=float)
    p = np.asarray(model_prob, dtype=float)
    m = np.asarray(market_prob, dtype=float)
    ok = np.isfinite(m) & (m > 0.0) & (m < 1.0) & np.isfinite(p)
    n = int(ok.sum())
    if n == 0:
        return {
            "n": 0,
            "model_brier": None,
            "market_brier": None,
            "brier_skill_vs_market": None,
            "model_logloss": None,
            "market_logloss": None,
            "logloss_skill_vs_market": None,
        }
    y, p, m = y[ok], p[ok], m[ok]
    eps = 1e-6

    def logloss(q: np.ndarray) -> float:
        q = np.clip(q, eps, 1 - eps)
        return float(-np.mean(y * np.log(q) + (1 - y) * np.log(1 - q)))

    model_brier = float(np.mean((p - y) ** 2))
    market_brier = float(np.mean((m - y) ** 2))
    model_ll, market_ll = logloss(p), logloss(m)
    return {
        "n": n,
        "model_brier": model_brier,
        "market_brier": market_brier,
        "brier_skill_vs_market": 1.0 - model_brier / market_brier if market_brier > 0 else None,
        "model_logloss": model_ll,
        "market_logloss": market_ll,
        "logloss_skill_vs_market": 1.0 - model_ll / market_ll if market_ll > 0 else None,
    }


def _norm_cdf(x: float) -> float:
    return 0.5 * (1.0 + math.erf(x / math.sqrt(2.0)))


def _inv_norm_approx(p: float) -> float:
    """Acklam-free binary search inverse standard normal CDF (accurate to 1e-8)."""
    lo, hi = -8.0, 8.0
    for _ in range(60):
        mid = 0.5 * (lo + hi)
        if _norm_cdf(mid) < p:
            lo = mid
        else:
            hi = mid
    return 0.5 * (lo + hi)


def deflated_sharpe_ratio(
    returns: np.ndarray,
    n_trials: int = 1,
) -> dict[str, float | int | None]:
    """Deflated Sharpe Ratio (Bailey & Lopez de Prado 2014; ML4T Ch.7).

    Corrects observed trade/period Sharpe ratio for sample size, skewness,
    excess kurtosis, and multiple-testing selection bias across `n_trials`.
    Returns `dsr` in [0, 1]: probability that true Sharpe exceeds expected max noise Sharpe.
    """
    r = np.asarray(returns, dtype=float)
    r = r[np.isfinite(r)]
    n = len(r)
    if n < 3:
        return {"n": n, "sharpe": None, "sr_benchmark": None, "dsr": None}
    std = float(np.std(r, ddof=1))
    if std <= 1e-12:
        return {"n": n, "sharpe": None, "sr_benchmark": None, "dsr": None}
    mean = float(np.mean(r))
    sr = mean / std
    z = (r - mean) / std
    skew = float(np.mean(z**3))
    kurt = float(np.mean(z**4))

    trials = max(1, int(n_trials))
    if trials == 1:
        sr_bench = 0.0
    else:
        euler_gamma = 0.5772156649015329
        sr_std = math.sqrt(1.0 / max(1, n - 1))
        z1 = _inv_norm_approx(1.0 - 1.0 / trials)
        z2 = _inv_norm_approx(1.0 - 1.0 / (trials * math.e))
        sr_bench = sr_std * ((1.0 - euler_gamma) * z1 + euler_gamma * z2)

    denom_var = max(1e-12, 1.0 - skew * sr + 0.25 * (kurt - 1.0) * (sr**2))
    z_stat = (sr - sr_bench) * math.sqrt(n - 1) / math.sqrt(denom_var)
    return {
        "n": n,
        "sharpe": round(sr, 4),
        "sr_benchmark": round(sr_bench, 4),
        "dsr": round(_norm_cdf(z_stat), 4),
    }


def benjamini_hochberg(
    p_values: np.ndarray | list[float], alpha: float = 0.05
) -> dict[str, list[float] | list[bool]]:
    """Benjamini-Hochberg FDR q-values and rejection mask across multiple tested rules."""
    p = np.asarray(p_values, dtype=float)
    m = len(p)
    if m == 0:
        return {"q_values": [], "rejected": []}
    order = np.argsort(p)
    sorted_p = p[order]
    q_sorted = np.empty(m, dtype=float)
    running_min = 1.0
    for i in range(m - 1, -1, -1):
        val = float(sorted_p[i]) * m / (i + 1)
        running_min = min(running_min, val)
        q_sorted[i] = min(1.0, max(0.0, running_min))
    q_values = np.empty(m, dtype=float)
    q_values[order] = q_sorted
    return {
        "q_values": [round(float(v), 6) for v in q_values],
        "rejected": [bool(v <= alpha) for v in q_values],
    }


def conformal_binary_summary(
    y_true: np.ndarray,
    y_prob: np.ndarray,
    alpha: float = 0.15,
    cal_fraction: float = 0.5,
) -> dict[str, float | int | None]:
    """Chronological split-conformal evaluation for binary probability models (ML4T Ch.12)."""
    y = np.asarray(y_true, dtype=int)
    p = np.asarray(y_prob, dtype=float)
    ok = np.isfinite(p)
    y, p = y[ok], p[ok]
    n = len(y)
    split = int(n * cal_fraction)
    if split < 10 or (n - split) < 10:
        return {
            "n_cal": split,
            "n_eval": max(0, n - split),
            "q_hat": None,
            "empirical_coverage": None,
            "singleton_rate": None,
            "singleton_accuracy": None,
            "ambiguous_rate": None,
            "ambiguous_accuracy": None,
        }
    y_cal, p_cal = y[:split], p[:split]
    y_ev, p_ev = y[split:], p[split:]
    cal_scores = np.sort(1.0 - np.where(y_cal == 1, p_cal, 1.0 - p_cal))
    q_idx = min(len(cal_scores) - 1, max(0, math.ceil((len(cal_scores) + 1) * (1.0 - alpha)) - 1))
    q_hat = float(cal_scores[q_idx])

    in_up = (1.0 - p_ev) <= q_hat
    in_dn = p_ev <= q_hat
    covered = np.where(y_ev == 1, in_up, in_dn)
    singleton = in_up ^ in_dn
    ambiguous = in_up & in_dn
    pred_ok = (p_ev >= 0.5).astype(int) == y_ev

    return {
        "n_cal": len(y_cal),
        "n_eval": len(y_ev),
        "q_hat": round(q_hat, 4),
        "empirical_coverage": round(float(np.mean(covered)), 4),
        "singleton_rate": round(float(np.mean(singleton)), 4),
        "singleton_accuracy": (
            round(float(np.mean(pred_ok[singleton])), 4) if np.any(singleton) else None
        ),
        "ambiguous_rate": round(float(np.mean(ambiguous)), 4),
        "ambiguous_accuracy": (
            round(float(np.mean(pred_ok[ambiguous])), 4) if np.any(ambiguous) else None
        ),
    }


def conformal_risk_control(
    y_true: np.ndarray,
    y_prob: np.ndarray,
    target_loss_rate: float = 0.32,
    cal_fraction: float = 0.5,
) -> dict[str, float | int | None]:
    """Conformal Risk Control (MAPIE / Angelopoulos et al. 2024) for trade selection.

    Finds the lowest side-probability threshold `lambda_hat` on the chronological
    calibration split whose finite-sample upper loss bound `(losses + 1) / (n + 1)`
    is `<= target_loss_rate`, then evaluates coverage and win rate on the holdout split.
    """
    y = np.asarray(y_true, dtype=int)
    p = np.asarray(y_prob, dtype=float)
    ok = np.isfinite(p)
    y, p = y[ok], p[ok]
    n = len(y)
    split = int(n * cal_fraction)
    if split < 10 or (n - split) < 10:
        return {
            "lambda_hat": None,
            "cal_selected": 0,
            "eval_selected": 0,
            "eval_coverage": None,
            "eval_loss_rate": None,
            "eval_win_rate": None,
        }

    side_prob = np.maximum(p, 1.0 - p)
    pred_ok = ((p >= 0.5).astype(int) == y).astype(float)
    sp_cal, ok_cal = side_prob[:split], pred_ok[:split]
    sp_ev, ok_ev = side_prob[split:], pred_ok[split:]

    lambda_hat: float | None = None
    cal_selected = 0
    for lam in np.linspace(0.50, 0.95, 46):
        mask = sp_cal >= lam
        k = int(mask.sum())
        if k < 5:
            continue
        losses = float(np.sum(1.0 - ok_cal[mask]))
        if (losses + 1.0) / (k + 1.0) <= target_loss_rate:
            lambda_hat = round(float(lam), 4)
            cal_selected = k
            break

    if lambda_hat is None:
        return {
            "lambda_hat": None,
            "cal_selected": 0,
            "eval_selected": 0,
            "eval_coverage": 0.0,
            "eval_loss_rate": None,
            "eval_win_rate": None,
        }

    ev_mask = sp_ev >= lambda_hat
    ev_n = int(ev_mask.sum())
    ev_wr = float(np.mean(ok_ev[ev_mask])) if ev_n > 0 else None
    return {
        "lambda_hat": lambda_hat,
        "cal_selected": cal_selected,
        "eval_selected": ev_n,
        "eval_coverage": round(ev_n / len(sp_ev), 4),
        "eval_loss_rate": round(1.0 - ev_wr, 4) if ev_wr is not None else None,
        "eval_win_rate": round(ev_wr, 4) if ev_wr is not None else None,
    }


def fit_garch11_mle(returns: np.ndarray) -> dict[str, float | int | None]:
    """Variance-targeted Gaussian quasi-MLE GARCH(1,1) fitter (bashtage/arch pattern).

    Fits `sigma_t^2 = omega + alpha * r_{t-1}^2 + beta * sigma_{t-1}^2` using
    coarse grid + coordinate refinement under stationarity `alpha + beta <= 0.995`
    with zero external solver dependencies.
    """
    r = np.asarray(returns, dtype=float)
    r = r[np.isfinite(r)]
    n = len(r)
    if n < 30:
        return {
            "n": n,
            "omega": None,
            "alpha": None,
            "beta": None,
            "persistence": None,
            "unconditional_vol": None,
            "log_likelihood": None,
        }
    rc = r - float(np.mean(r))
    var_r = float(np.var(rc))
    if var_r <= 1e-18:
        return {
            "n": n,
            "omega": None,
            "alpha": None,
            "beta": None,
            "persistence": None,
            "unconditional_vol": None,
            "log_likelihood": None,
        }
    r2 = rc * rc

    def neg_ll(alpha: float, beta: float) -> float:
        if alpha <= 1e-4 or beta <= 1e-4 or (alpha + beta) >= 0.995:
            return float("inf")
        omega = var_r * (1.0 - alpha - beta)
        h = var_r
        ll = 0.0
        for i in range(1, n):
            h = omega + alpha * r2[i - 1] + beta * h
            if h <= 1e-18:
                return float("inf")
            ll += math.log(h) + r2[i] / h
        return 0.5 * ll

    best_a, best_b = 0.08, 0.88
    best_loss = neg_ll(best_a, best_b)
    for a in (0.03, 0.06, 0.10, 0.15, 0.22):
        for b in (0.70, 0.80, 0.86, 0.90, 0.94):
            if a + b >= 0.995:
                continue
            loss = neg_ll(a, b)
            if loss < best_loss:
                best_loss, best_a, best_b = loss, a, b

    for step in (0.02, 0.005, 0.001):
        improved = True
        while improved:
            improved = False
            for da, db in ((-step, 0.0), (step, 0.0), (0.0, -step), (0.0, step)):
                ca, cb = best_a + da, best_b + db
                loss = neg_ll(ca, cb)
                if loss + 1e-9 < best_loss:
                    best_loss, best_a, best_b = loss, ca, cb
                    improved = True

    omega = var_r * (1.0 - best_a - best_b)
    return {
        "n": n,
        "omega": float(f"{omega:.6e}"),
        "alpha": round(best_a, 4),
        "beta": round(best_b, 4),
        "persistence": round(best_a + best_b, 4),
        "unconditional_vol": round(math.sqrt(var_r), 6),
        "log_likelihood": round(-best_loss - 0.5 * (n - 1) * math.log(2.0 * math.pi), 2),
    }
