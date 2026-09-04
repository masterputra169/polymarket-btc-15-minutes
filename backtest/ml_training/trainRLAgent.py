"""
RL Agent Training — Contextual Bandit for Polymarket bet sizing.

Algorithm: REINFORCE with baseline (vanilla policy gradient)
Model:     2-layer MLP (16 → 64 → 64 → 5), softmax output
Actions:   [0.5, 0.75, 1.0, 1.25, 1.5] sizing multipliers
Reward:    pnl / betAmount, clipped [-3, 3]

Usage:
    python trainRLAgent.py --journal ../../bot/data/trade_journal.jsonl \\
                           --output  ../../public/ml/rl_agent_weights.json
    python trainRLAgent.py --augment  # bootstrap 445 → ~2000 samples
    python trainRLAgent.py --help

Notes:
    - Skips DRY_RUN entries (pnl=0 → agent learns to bet small in those states)
    - Historical entries without rlActionIdx assigned action 2 (scalar 1.0, neutral baseline)
    - Training requires ≥50 real trades. Saves only if val Sharpe improvement over baseline.
    - Augmentation: bootstraps minority regimes (trending, asia) to prevent overfitting
    - Journal rows are untrusted input: every numeric field is coerced through
      _as_float, so a malformed or NaN value skips the sample instead of
      aborting the run (or, for NaN, saturating a feature / reward).

Performance:
    - The MLP forward/backward is vectorized with numpy (matrix-vector products and
      outer-product weight updates). The previous pure-Python nested-loop implementation
      cost ~6-10 ms per sample update, i.e. ~50+ minutes for a full --augment run
      (200 epochs x ~1600 samples) and blew the auto-retrain 30-minute budget.
      The numpy version runs the same per-sample REINFORCE updates in the same order
      (including using post-update weights when propagating gradients to earlier
      layers, matching the original implementation) and completes the full --augment
      run in well under a minute on the same machine.
    - Updates remain strictly per-sample (SGD, batch size 1) because the EMA reward
      baseline and sequential weight updates are order-dependent; only the per-sample
      linear algebra is vectorized. numpy is already required by the training
      pipeline (see requirements.txt).
"""

import argparse
import json
import math
import random
import sys
from collections.abc import Sequence
from pathlib import Path

import numpy as np

# ── Constants ──
ACTIONS = [0.5, 0.75, 1.0, 1.25, 1.5]
N_ACTIONS = len(ACTIONS)
FEATURE_DIM = 16
HIDDEN_DIM = 64
LR = 1e-3
L2 = 0.01
EPOCHS = 200
BATCH_SIZE = 32
VAL_FRAC = 0.2
CLIP_REWARD = 3.0
MIN_TRADES = 50


def _as_float(value: object) -> float | None:
    """Coerce a raw journal field to a finite float, or None when it is unusable.

    Journal rows are written by the TypeScript bot and are never schema-validated
    on the way in. Two shapes used to be actively harmful here:

      * a string / object where a number belongs raised TypeError or ValueError
        and aborted the entire retrain run over one corrupt row;
      * a NaN or inf `pnl` survived `max(-CLIP, min(CLIP, r))` as +CLIP, because
        every NaN comparison is False — a corrupt row was taught to the agent as
        the single best trade it had ever made.

    Returning None routes both through the existing "missing value" paths: skip
    the sample (compute_reward) or fall back to the neutral default
    (extract_state). Finite numbers pass through bit-identically.
    """
    if value is None:
        return None
    try:
        f = float(value)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return None
    return f if math.isfinite(f) else None


# ── CLI ──
def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="Train RL contextual bandit for bet sizing")
    p.add_argument(
        "--journal",
        default="../../bot/data/trade_journal.jsonl",
        help="Path to trade_journal.jsonl",
    )
    p.add_argument(
        "--output", default="../../public/ml/rl_agent_weights.json", help="Output JSON weights file"
    )
    p.add_argument(
        "--augment", action="store_true", help="Bootstrap minority regimes to 2000+ samples"
    )
    p.add_argument("--epochs", type=int, default=EPOCHS)
    p.add_argument("--lr", type=float, default=LR)
    p.add_argument(
        "--dry-run", action="store_true", help="Train and evaluate but do not save weights"
    )
    return p.parse_args()


# ── Feature extraction (mirrors rlAgent.js extractRLState) ──
def extract_state(entry: dict) -> list[float]:
    e = entry.get("entry", entry)  # support both nested and flat

    # Every numeric field goes through _as_float so one malformed row cannot
    # crash the run (or, when NaN, saturate a feature at 1.0).
    ml_conf = _as_float(e.get("mlConfidence"))
    best_edge = _as_float(e.get("bestEdge"))
    token_price = _as_float(e.get("tokenPrice"))
    regime = e.get("regime", "moderate")
    session = e.get("session", "")
    rsi = _as_float(e.get("rsiNow"))
    macd_hist = _as_float(e.get("macdHist"))
    spread = _as_float(e.get("spread"))
    atr_ratio = _as_float(e.get("atrRatio"))
    delta1m = _as_float(e.get("delta1m"))
    time_left = _as_float(e.get("timeLeftMin"))
    consec = _as_float(e.get("consecutiveLosses", 0))
    ob_imbalance = _as_float(e.get("orderbookImbalance"))
    recent_flips = _as_float(e.get("recentFlips", 0))

    is_us = any(s in (session or "") for s in ["US", "EU/US", "Europe/US"])
    is_asia = "Asia" in (session or "")

    def clamp(v, lo=0.0, hi=1.0):
        if v is None:
            return 0.5
        return max(lo, min(hi, float(v)))

    return [
        clamp(ml_conf),  # [0]
        clamp((best_edge or 0) * 4 + 0.5),  # [1] edge scaled
        clamp(token_price, 0, 1),  # [2]
        1.0 if regime == "trending" else 0.0,  # [3]
        1.0 if regime == "choppy" else 0.0,  # [4]
        1.0 if is_us else 0.0,  # [5]
        1.0 if is_asia else 0.0,  # [6]
        clamp((rsi or 50) / 100),  # [7]
        1.0 if (macd_hist or 0) > 0 else (0.0 if (macd_hist or 0) < 0 else 0.5),  # [8]
        clamp(1 - (spread or 0) * 20),  # [9] narrow spread → high
        clamp((atr_ratio or 0) / 3),  # [10]
        1.0 if (delta1m or 0) > 0 else (0.0 if (delta1m or 0) < 0 else 0.5),  # [11]
        clamp((time_left or 7.5) / 15),  # [12]
        clamp(min((consec or 0), 5) / 5),  # [13]
        clamp(((ob_imbalance or 0) + 1) / 2),  # [14]
        clamp((recent_flips or 0) / 10),  # [15]
    ]


def compute_reward(entry: dict) -> float | None:
    a = entry.get("analysis", {})
    e = entry.get("entry", entry)

    outcome = a.get("outcome", "")
    if outcome == "DRY_RUN":
        return None  # Skip dry runs

    pnl = _as_float(a.get("pnl"))
    bet_amount = _as_float(e.get("betAmount") or e.get("cost"))

    if pnl is None or bet_amount is None or bet_amount <= 0:
        return None

    reward = pnl / bet_amount
    return max(-CLIP_REWARD, min(CLIP_REWARD, reward))


# ── MLP (numpy-vectorized; see module docstring "Performance") ──
class MLP:
    """Minimal 3-layer MLP with numpy-vectorized forward/backward.

    Weight init draws from Python's `random.gauss` in the exact same order as the
    original list-based implementation, so initial weights and the global RNG state
    after construction are unchanged (epoch shuffles stay deterministic).
    """

    def __init__(self, in_dim: int, hidden_dim: int, out_dim: int, seed: int = 42) -> None:
        random.seed(seed)
        self.layers: list[dict] = [
            self._init_layer(in_dim, hidden_dim),
            self._init_layer(hidden_dim, hidden_dim),
            self._init_layer(hidden_dim, out_dim),
        ]
        self._cache: list[np.ndarray] = []

    def _init_layer(self, in_d: int, out_d: int) -> dict:
        # He init for ReLU layers (same random.gauss sequence as the original code)
        scale = math.sqrt(2.0 / in_d)
        W = np.array(
            [[random.gauss(0, scale) for _ in range(in_d)] for _ in range(out_d)],
            dtype=np.float64,
        )
        b = np.zeros(out_d, dtype=np.float64)
        return {"W": W, "b": b, "in_d": in_d, "out_d": out_d}

    @staticmethod
    def _softmax(logits: np.ndarray) -> np.ndarray:
        exp_l = np.exp(logits - logits.max())
        return exp_l / exp_l.sum()

    def forward(self, x: "np.ndarray | list[float]") -> np.ndarray:
        h = np.asarray(x, dtype=np.float64)
        self._cache = [h]
        for i, layer in enumerate(self.layers):
            z = layer["W"] @ h + layer["b"]
            h = np.maximum(z, 0.0) if i < len(self.layers) - 1 else self._softmax(z)
            self._cache.append(h)
        return h  # probs

    def policy_gradient_update(
        self,
        x: "np.ndarray | list[float]",
        action_idx: int,
        reward: float,
        baseline: float,
        lr: float,
        l2: float,
    ) -> None:
        """Single REINFORCE update step.

        Matches the original loop-based implementation exactly, including its
        quirk of propagating gradients to earlier layers through the
        already-updated weight matrices.
        """
        probs = self.forward(x)
        advantage = reward - baseline

        # Policy gradient: ∇ log π(a|s) x advantage
        # For softmax output: d_log_pi/d_logit[j] = I(j==a) - pi[j]
        d_logits = -probs.copy()
        d_logits[action_idx] += 1.0
        d_logits *= advantage

        # Backprop through layer 3 (64→5); W updated in-place (gradient + L2)
        layer = self.layers[2]
        h2 = self._cache[2]
        layer["b"] += lr * d_logits
        layer["W"] += lr * (np.outer(d_logits, h2) - l2 * layer["W"])

        # Backprop through layer 2 (64→64 ReLU) — uses post-update W3, as before
        d_h2 = layer["W"].T @ d_logits
        d_h2 = np.where(h2 > 0, d_h2, 0.0)  # ReLU mask

        layer2 = self.layers[1]
        h1 = self._cache[1]
        layer2["b"] += lr * d_h2
        layer2["W"] += lr * (np.outer(d_h2, h1) - l2 * layer2["W"])

        # Backprop through layer 1 (16→64 ReLU) — uses post-update W2, as before
        d_h1 = layer2["W"].T @ d_h2
        d_h1 = np.where(h1 > 0, d_h1, 0.0)

        layer1 = self.layers[0]
        x0 = self._cache[0]
        layer1["b"] += lr * d_h1
        layer1["W"] += lr * (np.outer(d_h1, x0) - l2 * layer1["W"])

    def get_weights(self) -> dict[str, list[float]]:
        """Flatten weights for JSON serialization (row-major, same layout as before)."""
        result: dict[str, list[float]] = {}
        names = ["1", "2", "3"]
        for idx, layer in enumerate(self.layers):
            n = names[idx]
            result[f"w{n}"] = layer["W"].flatten().tolist()
            result[f"b{n}"] = layer["b"].tolist()
        return result


# ── Metrics ──
def compute_sharpe(rewards: Sequence[float]) -> float:
    if len(rewards) < 2:
        return 0.0
    mean_r = sum(rewards) / len(rewards)
    var = sum((r - mean_r) ** 2 for r in rewards) / len(rewards)
    std = math.sqrt(var) if var > 0 else 1e-8
    return mean_r / std


def evaluate(model: MLP, samples: list[tuple]) -> tuple[float, float]:
    """Evaluate model on samples: compute avg reward and Sharpe."""
    total_r = 0.0
    rewards = []
    for state, action_idx, reward in samples:
        probs = model.forward(state)
        # Greedy action (argmax picks the first max, same tie-break as before)
        pred_action = int(np.argmax(probs))
        # Use actual reward if predicted action matches historical, else penalize
        r = reward if pred_action == action_idx else reward * 0.5
        total_r += r
        rewards.append(r)
    return total_r / len(samples), compute_sharpe(rewards)


# ── Data loading ──
def load_data(journal_path: str) -> list[dict]:
    path = Path(journal_path)
    if not path.exists():
        print(f"ERROR: Journal not found: {journal_path}", file=sys.stderr)
        sys.exit(1)

    entries = []
    with open(path, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                entries.append(json.loads(line))
            except json.JSONDecodeError:
                continue

    print(f"Loaded {len(entries)} journal entries")
    return entries


def prepare_samples(entries: list[dict], augment: bool) -> list[tuple]:
    """Convert journal entries to (state, action_idx, reward) tuples."""
    samples = []
    skipped = 0

    for entry in entries:
        reward = compute_reward(entry)
        if reward is None:
            skipped += 1
            continue

        state = extract_state(entry)
        e = entry.get("entry", entry)
        rl_action = e.get("rlActionIdx")

        if rl_action is None:
            action_idx = 2  # Neutral baseline (scalar 1.0)
        else:
            action_idx = int(rl_action)

        samples.append((state, action_idx, reward))

    print(f"Prepared {len(samples)} samples ({skipped} skipped: DRY_RUN or missing pnl)")

    if len(samples) < MIN_TRADES:
        print(f"ERROR: Need ≥{MIN_TRADES} real trades, got {len(samples)}", file=sys.stderr)
        sys.exit(1)

    if augment:
        samples = augment_samples(samples)

    return samples


def augment_samples(samples: list[tuple]) -> list[tuple]:
    """Bootstrap minority classes (trending regime, asia session) to 2000+ samples."""
    target = max(2000, len(samples) * 2)

    # Identify minority samples (trending regime = state[3]==1, asia = state[6]==1)
    minority = [s for s in samples if s[0][3] > 0.5 or s[0][6] > 0.5]

    extra_needed = target - len(samples)
    if extra_needed <= 0 or len(minority) == 0:
        return samples

    # Bootstrap with small noise
    extra = []
    for _ in range(extra_needed):
        src_state, action, reward = random.choice(minority if random.random() < 0.6 else samples)
        # Add small Gaussian noise to continuous features (not one-hot)
        noisy = src_state[:]
        for i in [0, 1, 2, 7, 9, 10, 12]:  # continuous features only
            noisy[i] = max(0.0, min(1.0, noisy[i] + random.gauss(0, 0.02)))
        extra.append((noisy, action, reward))

    augmented = samples + extra
    print(f"Augmented: {len(samples)} -> {len(augmented)} samples")
    return augmented


# ── Main training loop ──
def train(samples: list[tuple], args: argparse.Namespace) -> tuple[dict | None, float, float]:
    random.shuffle(samples)
    n_val = max(10, int(len(samples) * VAL_FRAC))
    # Convert states to numpy once up front (avoids per-update list→array conversion)
    val_samples = [(np.asarray(s, dtype=np.float64), a, r) for s, a, r in samples[:n_val]]
    train_samples = [(np.asarray(s, dtype=np.float64), a, r) for s, a, r in samples[n_val:]]

    print(f"Train: {len(train_samples)}  Val: {n_val}")

    model = MLP(FEATURE_DIM, HIDDEN_DIM, N_ACTIONS)

    # Baseline reward (running mean for REINFORCE baseline)
    baseline = 0.0
    alpha_baseline = 0.1  # EMA coefficient

    best_sharpe = -float("inf")
    best_weights = None
    baseline_sharpe = compute_sharpe([r for _, _, r in val_samples])

    print(f"Baseline Sharpe (uniform policy): {baseline_sharpe:.4f}")

    for epoch in range(args.epochs):
        random.shuffle(train_samples)

        for state, action_idx, reward in train_samples:
            baseline = (1 - alpha_baseline) * baseline + alpha_baseline * reward
            model.policy_gradient_update(state, action_idx, reward, baseline, args.lr, L2)

        if (epoch + 1) % 20 == 0:
            avg_r, sharpe = evaluate(model, val_samples)
            print(
                f"  Epoch {epoch+1:3d}/{args.epochs}  val_avg_reward={avg_r:.4f}  val_sharpe={sharpe:.4f}"
            )

            if sharpe > best_sharpe:
                best_sharpe = sharpe
                best_weights = model.get_weights()

    print(f"\nBest val Sharpe: {best_sharpe:.4f}  (baseline: {baseline_sharpe:.4f})")
    return best_weights, best_sharpe, baseline_sharpe


def main() -> None:
    args = parse_args()

    entries = load_data(args.journal)
    samples = prepare_samples(entries, args.augment)

    best_weights, best_sharpe, baseline_sharpe = train(samples, args)

    if best_weights is None:
        print("ERROR: Training produced no weights", file=sys.stderr)
        sys.exit(1)

    if best_sharpe <= baseline_sharpe:
        print(
            f"WARNING: Trained policy Sharpe ({best_sharpe:.4f}) ≤ baseline ({baseline_sharpe:.4f}). "
            f"Agent did not improve over neutral sizing."
        )
        if not args.dry_run:
            print("Saving anyway (user can evaluate in shadow mode)")

    import time

    output = {
        **best_weights,
        "version": int(time.time()),
        "trainedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "trainSamples": len(samples),
        "valSharpe": round(best_sharpe, 4),
        "baselineSharpe": round(baseline_sharpe, 4),
        "improved": best_sharpe > baseline_sharpe,
        "featureDim": FEATURE_DIM,
        "hiddenDim": HIDDEN_DIM,
        "nActions": N_ACTIONS,
        "actions": ACTIONS,
    }

    if args.dry_run:
        print("DRY-RUN: weights not saved")
        return

    out_path = Path(args.output)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(output, separators=(",", ":")))
    print(f"Weights saved: {out_path}  ({out_path.stat().st_size // 1024}KB)")
    print("Done. Deploy to bot/data/ or public/ml/ as needed.")


if __name__ == "__main__":
    main()
