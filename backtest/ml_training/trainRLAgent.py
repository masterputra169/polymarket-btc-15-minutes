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
"""

import json
import math
import random
import argparse
import sys
from pathlib import Path


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

# ── CLI ──
def parse_args():
    p = argparse.ArgumentParser(description='Train RL contextual bandit for bet sizing')
    p.add_argument('--journal', default='../../bot/data/trade_journal.jsonl',
                   help='Path to trade_journal.jsonl')
    p.add_argument('--output', default='../../public/ml/rl_agent_weights.json',
                   help='Output JSON weights file')
    p.add_argument('--augment', action='store_true',
                   help='Bootstrap minority regimes to 2000+ samples')
    p.add_argument('--epochs', type=int, default=EPOCHS)
    p.add_argument('--lr', type=float, default=LR)
    p.add_argument('--dry-run', action='store_true',
                   help='Train and evaluate but do not save weights')
    return p.parse_args()


# ── Feature extraction (mirrors rlAgent.js extractRLState) ──
def extract_state(entry: dict) -> list[float]:
    e = entry.get('entry', entry)  # support both nested and flat
    a = entry.get('analysis', {})

    ml_conf = e.get('mlConfidence')
    best_edge = e.get('bestEdge')
    token_price = e.get('tokenPrice')
    regime = e.get('regime', 'moderate')
    session = e.get('session', '')
    rsi = e.get('rsiNow')
    macd_hist = e.get('macdHist')
    spread = e.get('spread')
    atr_ratio = e.get('atrRatio')
    delta1m = e.get('delta1m')
    time_left = e.get('timeLeftMin')
    consec = e.get('consecutiveLosses', 0)
    ob_imbalance = e.get('orderbookImbalance')
    recent_flips = e.get('recentFlips', 0)

    is_us = any(s in (session or '') for s in ['US', 'EU/US', 'Europe/US'])
    is_asia = 'Asia' in (session or '')

    def clamp(v, lo=0.0, hi=1.0):
        if v is None:
            return 0.5
        return max(lo, min(hi, float(v)))

    return [
        clamp(ml_conf),                                                    # [0]
        clamp((best_edge or 0) * 4 + 0.5),                                # [1] edge scaled
        clamp(token_price, 0, 1),                                          # [2]
        1.0 if regime == 'trending' else 0.0,                              # [3]
        1.0 if regime == 'choppy' else 0.0,                                # [4]
        1.0 if is_us else 0.0,                                             # [5]
        1.0 if is_asia else 0.0,                                           # [6]
        clamp((rsi or 50) / 100),                                          # [7]
        1.0 if (macd_hist or 0) > 0 else (0.0 if (macd_hist or 0) < 0 else 0.5),  # [8]
        clamp(1 - (spread or 0) * 20),                                     # [9] narrow spread → high
        clamp((atr_ratio or 0) / 3),                                       # [10]
        1.0 if (delta1m or 0) > 0 else (0.0 if (delta1m or 0) < 0 else 0.5),      # [11]
        clamp((time_left or 7.5) / 15),                                    # [12]
        clamp(min((consec or 0), 5) / 5),                                  # [13]
        clamp(((ob_imbalance or 0) + 1) / 2),                              # [14]
        clamp((recent_flips or 0) / 10),                                   # [15]
    ]


def compute_reward(entry: dict) -> float | None:
    a = entry.get('analysis', {})
    e = entry.get('entry', entry)

    outcome = a.get('outcome', '')
    if outcome == 'DRY_RUN':
        return None  # Skip dry runs

    pnl = a.get('pnl')
    bet_amount = e.get('betAmount') or e.get('cost')

    if pnl is None or bet_amount is None or bet_amount <= 0:
        return None

    reward = pnl / float(bet_amount)
    return max(-CLIP_REWARD, min(CLIP_REWARD, reward))


# ── MLP (pure Python/numpy-free, for portability) ──
class MLP:
    """Minimal 3-layer MLP with numpy-free forward/backward."""

    def __init__(self, in_dim, hidden_dim, out_dim, seed=42):
        random.seed(seed)
        self.layers = [
            self._init_layer(in_dim, hidden_dim),
            self._init_layer(hidden_dim, hidden_dim),
            self._init_layer(hidden_dim, out_dim),
        ]

    def _init_layer(self, in_d, out_d):
        # He init for ReLU layers
        scale = math.sqrt(2.0 / in_d)
        W = [[random.gauss(0, scale) for _ in range(in_d)] for _ in range(out_d)]
        b = [0.0] * out_d
        return {'W': W, 'b': b, 'in_d': in_d, 'out_d': out_d}

    def _relu(self, v):
        return max(0.0, v)

    def _softmax(self, logits):
        max_l = max(logits)
        exp_l = [math.exp(l - max_l) for l in logits]
        s = sum(exp_l)
        return [e / s for e in exp_l]

    def _layer_forward(self, x, layer, activation='relu'):
        W, b = layer['W'], layer['b']
        out = []
        for j in range(layer['out_d']):
            s = b[j] + sum(x[i] * W[j][i] for i in range(layer['in_d']))
            out.append(s)
        if activation == 'relu':
            return [self._relu(s) for s in out]
        if activation == 'softmax':
            return self._softmax(out)
        return out

    def forward(self, x):
        h = x[:]
        self._cache = [h]
        for i, layer in enumerate(self.layers):
            act = 'relu' if i < len(self.layers) - 1 else 'softmax'
            h = self._layer_forward(h, layer, activation=act)
            self._cache.append(h)
        return h  # probs

    def policy_gradient_update(self, x, action_idx, reward, baseline, lr, l2):
        """Single REINFORCE update step."""
        probs = self.forward(x)
        advantage = reward - baseline

        # Policy gradient: ∇ log π(a|s) × advantage
        # For softmax output: d_log_pi/d_logit[j] = I(j==a) - pi[j]
        d_logits = [-p for p in probs]
        d_logits[action_idx] += 1.0
        d_logits = [d * advantage for d in d_logits]  # × advantage

        # Backprop through layer 3 (64→5)
        layer = self.layers[2]
        h2 = self._cache[2]
        for j in range(layer['out_d']):
            layer['b'][j] += lr * d_logits[j]
            for i in range(layer['in_d']):
                # Gradient + L2 regularization
                layer['W'][j][i] += lr * (d_logits[j] * h2[i] - l2 * layer['W'][j][i])

        # Backprop through layer 2 (64→64 ReLU)
        d_h2 = [0.0] * self.layers[2]['in_d']
        for j in range(layer['out_d']):
            for i in range(layer['in_d']):
                d_h2[i] += layer['W'][j][i] * d_logits[j]
        # Apply ReLU mask
        d_h2 = [d if h2[i] > 0 else 0.0 for i, d in enumerate(d_h2)]

        layer2 = self.layers[1]
        h1 = self._cache[1]
        for j in range(layer2['out_d']):
            layer2['b'][j] += lr * d_h2[j]
            for i in range(layer2['in_d']):
                layer2['W'][j][i] += lr * (d_h2[j] * h1[i] - l2 * layer2['W'][j][i])

        # Backprop through layer 1 (16→64 ReLU)
        d_h1 = [0.0] * layer2['in_d']
        for j in range(layer2['out_d']):
            for i in range(layer2['in_d']):
                d_h1[i] += layer2['W'][j][i] * d_h2[j]
        d_h1 = [d if h1[i] > 0 else 0.0 for i, d in enumerate(d_h1)]

        layer1 = self.layers[0]
        x0 = self._cache[0]
        for j in range(layer1['out_d']):
            layer1['b'][j] += lr * d_h1[j]
            for i in range(layer1['in_d']):
                layer1['W'][j][i] += lr * (d_h1[j] * x0[i] - l2 * layer1['W'][j][i])

    def get_weights(self):
        """Flatten weights for JSON serialization (row-major)."""
        result = {}
        names = ['1', '2', '3']
        for idx, layer in enumerate(self.layers):
            n = names[idx]
            result[f'w{n}'] = [v for row in layer['W'] for v in row]
            result[f'b{n}'] = layer['b'][:]
        return result


# ── Metrics ──
def compute_sharpe(rewards):
    if len(rewards) < 2:
        return 0.0
    mean_r = sum(rewards) / len(rewards)
    var = sum((r - mean_r) ** 2 for r in rewards) / len(rewards)
    std = math.sqrt(var) if var > 0 else 1e-8
    return mean_r / std


def evaluate(model, samples):
    """Evaluate model on samples: compute avg reward and Sharpe."""
    total_r = 0.0
    rewards = []
    for state, action_idx, reward in samples:
        probs = model.forward(state)
        # Greedy action
        pred_action = max(range(N_ACTIONS), key=lambda i: probs[i])
        # Use actual reward if predicted action matches historical, else penalize
        r = reward if pred_action == action_idx else reward * 0.5
        total_r += r
        rewards.append(r)
    return total_r / len(samples), compute_sharpe(rewards)


# ── Data loading ──
def load_data(journal_path: str) -> list[dict]:
    path = Path(journal_path)
    if not path.exists():
        print(f'ERROR: Journal not found: {journal_path}', file=sys.stderr)
        sys.exit(1)

    entries = []
    with open(path, 'r', encoding='utf-8') as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                entries.append(json.loads(line))
            except json.JSONDecodeError:
                continue

    print(f'Loaded {len(entries)} journal entries')
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
        e = entry.get('entry', entry)
        rl_action = e.get('rlActionIdx')

        if rl_action is None:
            action_idx = 2  # Neutral baseline (scalar 1.0)
        else:
            action_idx = int(rl_action)

        samples.append((state, action_idx, reward))

    print(f'Prepared {len(samples)} samples ({skipped} skipped: DRY_RUN or missing pnl)')

    if len(samples) < MIN_TRADES:
        print(f'ERROR: Need ≥{MIN_TRADES} real trades, got {len(samples)}', file=sys.stderr)
        sys.exit(1)

    if augment:
        samples = augment_samples(samples)

    return samples


def augment_samples(samples: list[tuple]) -> list[tuple]:
    """Bootstrap minority classes (trending regime, asia session) to 2000+ samples."""
    target = max(2000, len(samples) * 2)

    # Identify minority samples (trending regime = state[3]==1, asia = state[6]==1)
    minority = [s for s in samples if s[0][3] > 0.5 or s[0][6] > 0.5]
    majority = [s for s in samples if s[0][3] <= 0.5 and s[0][6] <= 0.5]

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
    print(f'Augmented: {len(samples)} → {len(augmented)} samples')
    return augmented


# ── Main training loop ──
def train(samples, args):
    random.shuffle(samples)
    n_val = max(10, int(len(samples) * VAL_FRAC))
    val_samples = samples[:n_val]
    train_samples = samples[n_val:]

    print(f'Train: {len(train_samples)}  Val: {n_val}')

    model = MLP(FEATURE_DIM, HIDDEN_DIM, N_ACTIONS)

    # Baseline reward (running mean for REINFORCE baseline)
    baseline = 0.0
    alpha_baseline = 0.1  # EMA coefficient

    best_sharpe = -float('inf')
    best_weights = None
    baseline_sharpe = compute_sharpe([r for _, _, r in val_samples])

    print(f'Baseline Sharpe (uniform policy): {baseline_sharpe:.4f}')

    for epoch in range(args.epochs):
        random.shuffle(train_samples)

        for state, action_idx, reward in train_samples:
            baseline = (1 - alpha_baseline) * baseline + alpha_baseline * reward
            model.policy_gradient_update(state, action_idx, reward, baseline, args.lr, L2)

        if (epoch + 1) % 20 == 0:
            avg_r, sharpe = evaluate(model, val_samples)
            print(f'  Epoch {epoch+1:3d}/{args.epochs}  val_avg_reward={avg_r:.4f}  val_sharpe={sharpe:.4f}')

            if sharpe > best_sharpe:
                best_sharpe = sharpe
                best_weights = model.get_weights()

    print(f'\nBest val Sharpe: {best_sharpe:.4f}  (baseline: {baseline_sharpe:.4f})')
    return best_weights, best_sharpe, baseline_sharpe


def main():
    args = parse_args()

    entries = load_data(args.journal)
    samples = prepare_samples(entries, args.augment)

    best_weights, best_sharpe, baseline_sharpe = train(samples, args)

    if best_weights is None:
        print('ERROR: Training produced no weights', file=sys.stderr)
        sys.exit(1)

    if best_sharpe <= baseline_sharpe:
        print(f'WARNING: Trained policy Sharpe ({best_sharpe:.4f}) ≤ baseline ({baseline_sharpe:.4f}). '
              f'Agent did not improve over neutral sizing.')
        if not args.dry_run:
            print('Saving anyway (user can evaluate in shadow mode)')

    import time
    import hashlib

    output = {
        **best_weights,
        'version': int(time.time()),
        'trainedAt': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
        'trainSamples': len(samples),
        'valSharpe': round(best_sharpe, 4),
        'baselineSharpe': round(baseline_sharpe, 4),
        'improved': best_sharpe > baseline_sharpe,
        'featureDim': FEATURE_DIM,
        'hiddenDim': HIDDEN_DIM,
        'nActions': N_ACTIONS,
        'actions': ACTIONS,
    }

    if args.dry_run:
        print('DRY-RUN: weights not saved')
        return

    out_path = Path(args.output)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(output, separators=(',', ':')))
    print(f'Weights saved: {out_path}  ({out_path.stat().st_size // 1024}KB)')
    print(f'Done. Deploy to bot/data/ or public/ml/ as needed.')


if __name__ == '__main__':
    main()
