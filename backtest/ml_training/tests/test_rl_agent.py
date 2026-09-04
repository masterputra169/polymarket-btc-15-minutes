"""Unit tests for trainRLAgent — the REINFORCE bet-sizing policy.

This trainer ships its weights straight to production as
`public/ml/rl_agent_weights.json`, where bot/src/engines/rlAgent.ts re-implements
the same forward pass in TypeScript and multiplies the chosen action into the
Kelly stake. Three things therefore have to be nailed down:

  * PARITY — the forward/backward pass was rewritten from pure-Python nested
    loops to numpy for a ~29x speedup. A silent arithmetic drift there would not
    fail anything; it would just train a subtly different policy. `TestNumpyParity`
    re-implements the documented loop version (including its quirk of
    back-propagating through the *already-updated* weight matrices) and pins the
    numpy version to it.
  * SERIALISATION — rlAgent.ts indexes the flattened arrays as
    `w1[j * FEATURE_DIM + i]`. Row-major order and array lengths are a contract,
    not an implementation detail.
  * INPUT HYGIENE — journal rows are untrusted JSONL written by the bot. One
    malformed row must skip a sample, not abort the nightly retrain.

Everything uses tiny synthetic inputs; the handful of tests that run real
training are marked `integration` and take well under a second each.
"""

from __future__ import annotations

import json
import math
import random
import sys
from pathlib import Path
from types import SimpleNamespace

import numpy as np
import pytest

import trainRLAgent as rl

pytestmark = pytest.mark.unit

REPO_ROOT = Path(__file__).resolve().parents[3]
PROD_WEIGHTS = REPO_ROOT / "public" / "ml" / "rl_agent_weights.json"

# Flattened lengths implied by the 16 -> 64 -> 64 -> 5 geometry rlAgent.ts asserts.
EXPECTED_LENGTHS = {"w1": 1024, "b1": 64, "w2": 4096, "b2": 64, "w3": 320, "b3": 5}


# ── Helpers ──


def _set_layer(model: rl.MLP, idx: int, W: list[list[float]], b: list[float]) -> None:
    """Overwrite one layer with hand-chosen weights, keeping the stored shapes."""
    model.layers[idx]["W"] = np.array(W, dtype=np.float64)
    model.layers[idx]["b"] = np.array(b, dtype=np.float64)


def _snapshot(model: rl.MLP) -> list[dict]:
    """Deep copy of the layer weights as plain Python lists (for the reference impl)."""
    return [
        {
            "W": [row[:] for row in layer["W"].tolist()],
            "b": layer["b"].tolist(),
            "in_d": layer["in_d"],
            "out_d": layer["out_d"],
        }
        for layer in model.layers
    ]


def _ref_forward(layers: list[dict], x: list[float]) -> tuple[list[float], list[list[float]]]:
    """Pure-Python forward pass — the pre-numpy implementation, kept as an oracle."""
    h = list(x)
    cache = [list(h)]
    last = len(layers) - 1
    for i, layer in enumerate(layers):
        z = []
        for o in range(layer["out_d"]):
            acc = layer["b"][o]
            for j in range(layer["in_d"]):
                acc += layer["W"][o][j] * h[j]
            z.append(acc)
        if i < last:
            h = [v if v > 0.0 else 0.0 for v in z]
        else:
            m = max(z)
            ex = [math.exp(v - m) for v in z]
            tot = sum(ex)
            h = [e / tot for e in ex]
        cache.append(list(h))
    return h, cache


def _ref_update(
    layers: list[dict],
    x: list[float],
    action_idx: int,
    reward: float,
    baseline: float,
    lr: float,
    l2: float,
) -> None:
    """Pure-Python REINFORCE step, mutating `layers` in place.

    Deliberately reproduces the original's ordering quirk: gradients flow to
    earlier layers through the weight matrices that were *just* updated.
    """
    probs, cache = _ref_forward(layers, x)
    advantage = reward - baseline
    n_out = len(probs)

    d_logits = [((1.0 if j == action_idx else 0.0) - probs[j]) * advantage for j in range(n_out)]

    l3, h2 = layers[2], cache[2]
    for o in range(n_out):
        l3["b"][o] += lr * d_logits[o]
        for j in range(len(h2)):
            l3["W"][o][j] += lr * (d_logits[o] * h2[j] - l2 * l3["W"][o][j])

    d_h2 = [sum(l3["W"][o][j] * d_logits[o] for o in range(n_out)) for j in range(len(h2))]
    d_h2 = [d_h2[j] if h2[j] > 0 else 0.0 for j in range(len(h2))]

    l2_layer, h1 = layers[1], cache[1]
    for o in range(len(d_h2)):
        l2_layer["b"][o] += lr * d_h2[o]
        for j in range(len(h1)):
            l2_layer["W"][o][j] += lr * (d_h2[o] * h1[j] - l2 * l2_layer["W"][o][j])

    d_h1 = [sum(l2_layer["W"][o][j] * d_h2[o] for o in range(len(d_h2))) for j in range(len(h1))]
    d_h1 = [d_h1[j] if h1[j] > 0 else 0.0 for j in range(len(h1))]

    l1, x0 = layers[0], cache[0]
    for o in range(len(d_h1)):
        l1["b"][o] += lr * d_h1[o]
        for j in range(len(x0)):
            l1["W"][o][j] += lr * (d_h1[o] * x0[j] - l2 * l1["W"][o][j])


def _journal_entry(
    *,
    pnl: float = 1.0,
    bet: float = 10.0,
    outcome: str = "WIN",
    action: int | None = 2,
    **feature_overrides: object,
) -> dict:
    """One well-formed nested journal row."""
    entry = {
        "mlConfidence": 0.7,
        "bestEdge": 0.05,
        "tokenPrice": 0.55,
        "regime": "moderate",
        "session": "US",
        "rsiNow": 55,
        "macdHist": 0.4,
        "spread": 0.01,
        "atrRatio": 1.2,
        "delta1m": 5.0,
        "timeLeftMin": 8.0,
        "consecutiveLosses": 0,
        "orderbookImbalance": 0.1,
        "recentFlips": 1,
        "betAmount": bet,
    }
    entry.update(feature_overrides)
    if action is not None:
        entry["rlActionIdx"] = action
    return {"entry": entry, "analysis": {"outcome": outcome, "pnl": pnl}}


def _synthetic_samples(n: int = 60, *, seed: int = 5) -> list[tuple]:
    """(state, action_idx, reward) tuples with enough spread to train on."""
    r = random.Random(seed)
    return [
        (
            [r.random() for _ in range(rl.FEATURE_DIM)],
            r.randrange(rl.N_ACTIONS),
            r.uniform(-rl.CLIP_REWARD, rl.CLIP_REWARD),
        )
        for _ in range(n)
    ]


# ── Forward pass ──


class TestMLPForward:
    def test_output_length_equals_the_action_count(self) -> None:
        # rlAgent.ts indexes probs[0..nActions-1]; a shape drift is a live crash.
        probs = rl.MLP(rl.FEATURE_DIM, rl.HIDDEN_DIM, rl.N_ACTIONS).forward([0.5] * rl.FEATURE_DIM)
        assert probs.shape == (rl.N_ACTIONS,)
        assert len(rl.ACTIONS) == rl.N_ACTIONS

    def test_hand_computed_forward_pass(self) -> None:
        """Exact arithmetic on a 2->2->2 net, computed by hand rather than golden-filed.

        x=[1,2]
          layer1 z=[1,-2] -> relu -> [1,0]
          layer2 z=[3, 0] -> relu -> [3,0]
          layer3 z=[3, 0] -> softmax
        """
        model = rl.MLP(2, 2, 2)
        _set_layer(model, 0, [[1.0, 0.0], [0.0, -1.0]], [0.0, 0.0])
        _set_layer(model, 1, [[2.0, 3.0], [-1.0, 0.0]], [1.0, 1.0])
        _set_layer(model, 2, [[1.0, 1.0], [0.0, 1.0]], [0.0, 0.0])

        probs = model.forward([1.0, 2.0])

        denom = math.exp(3.0) + math.exp(0.0)
        assert probs[0] == pytest.approx(math.exp(3.0) / denom, rel=1e-12)
        assert probs[1] == pytest.approx(math.exp(0.0) / denom, rel=1e-12)

    def test_relu_zeroes_negative_preactivations(self) -> None:
        # Same net: layer-1 unit 1 has z=-2. If ReLU leaked, the cache would show it.
        model = rl.MLP(2, 2, 2)
        _set_layer(model, 0, [[1.0, 0.0], [0.0, -1.0]], [0.0, 0.0])
        _set_layer(model, 1, [[2.0, 3.0], [-1.0, 0.0]], [1.0, 1.0])
        _set_layer(model, 2, [[1.0, 1.0], [0.0, 1.0]], [0.0, 0.0])

        model.forward([1.0, 2.0])

        assert model._cache[1].tolist() == [1.0, 0.0]
        assert model._cache[2].tolist() == [3.0, 0.0]
        assert np.all(model._cache[1] >= 0.0)

    def test_cache_holds_the_input_then_one_row_per_layer(self) -> None:
        model = rl.MLP(rl.FEATURE_DIM, rl.HIDDEN_DIM, rl.N_ACTIONS)
        model.forward([0.5] * rl.FEATURE_DIM)
        assert [len(h) for h in model._cache] == [16, 64, 64, 5]

    def test_accepts_lists_and_arrays_alike(self) -> None:
        # train() pre-converts states to arrays; evaluate() may still pass lists.
        model = rl.MLP(rl.FEATURE_DIM, rl.HIDDEN_DIM, rl.N_ACTIONS)
        state = [0.3] * rl.FEATURE_DIM
        assert np.allclose(model.forward(state), model.forward(np.asarray(state)))


class TestSoftmax:
    def test_is_a_valid_probability_distribution(self) -> None:
        probs = rl.MLP(rl.FEATURE_DIM, rl.HIDDEN_DIM, rl.N_ACTIONS).forward([0.9] * rl.FEATURE_DIM)
        assert np.all(probs >= 0.0)
        assert float(probs.sum()) == pytest.approx(1.0, abs=1e-12)

    def test_survives_logits_large_enough_to_overflow_exp(self) -> None:
        # The max-subtraction is the only thing standing between a saturated
        # hidden layer and exp() overflowing to inf -> nan probabilities.
        model = rl.MLP(2, 2, rl.N_ACTIONS)
        _set_layer(model, 2, [[0.0, 0.0]] * rl.N_ACTIONS, [1000.0, -1000.0, 0.0, 800.0, -800.0])
        probs = model.forward([1.0, 1.0])

        assert np.all(np.isfinite(probs))
        assert np.all(probs >= 0.0)
        assert float(probs.sum()) == pytest.approx(1.0, abs=1e-12)
        assert int(np.argmax(probs)) == 0

    def test_equal_logits_give_a_uniform_policy(self) -> None:
        model = rl.MLP(2, 2, rl.N_ACTIONS)
        _set_layer(model, 2, [[0.0, 0.0]] * rl.N_ACTIONS, [0.0] * rl.N_ACTIONS)
        probs = model.forward([1.0, 1.0])
        assert np.allclose(probs, 1.0 / rl.N_ACTIONS)

    @pytest.mark.parametrize("logits", [[0.0, 0.0], [-500.0, 500.0], [1e6, 1e6]])
    def test_static_softmax_is_always_normalised(self, logits: list[float]) -> None:
        out = rl.MLP._softmax(np.array(logits, dtype=np.float64))
        assert np.all(np.isfinite(out))
        assert float(out.sum()) == pytest.approx(1.0, abs=1e-12)


# ── Policy-gradient update ──


class TestPolicyGradientUpdate:
    @staticmethod
    def _tiny_model() -> rl.MLP:
        model = rl.MLP(2, 3, rl.N_ACTIONS, seed=11)
        _set_layer(model, 0, [[0.5, 0.5], [0.2, -0.1], [0.1, 0.3]], [0.1, 0.1, 0.1])
        _set_layer(model, 1, [[0.3, 0.1, 0.2]] * 3, [0.0, 0.0, 0.0])
        _set_layer(model, 2, [[0.2, 0.1, 0.3]] * rl.N_ACTIONS, [0.0] * rl.N_ACTIONS)
        return model

    def test_positive_reward_raises_the_chosen_action(self) -> None:
        # A trade that paid off must make that sizing more likely next time,
        # and (softmax being zero-sum) every other sizing less likely.
        model = self._tiny_model()
        x = [1.0, 1.0]
        before = model.forward(x).copy()

        model.policy_gradient_update(x, action_idx=3, reward=2.0, baseline=0.0, lr=0.01, l2=0.0)
        after = model.forward(x)

        assert after[3] > before[3]
        for j in range(rl.N_ACTIONS):
            if j != 3:
                assert after[j] < before[j]

    def test_negative_reward_lowers_the_chosen_action(self) -> None:
        model = self._tiny_model()
        x = [1.0, 1.0]
        before = model.forward(x).copy()

        model.policy_gradient_update(x, action_idx=3, reward=-2.0, baseline=0.0, lr=0.01, l2=0.0)
        after = model.forward(x)

        assert after[3] < before[3]
        for j in range(rl.N_ACTIONS):
            if j != 3:
                assert after[j] > before[j]

    def test_reward_below_baseline_is_punished_even_when_positive(self) -> None:
        # The whole point of the baseline: a +0.5 trade in a +2.0 regime is a
        # bad outcome and must push the action DOWN.
        model = self._tiny_model()
        x = [1.0, 1.0]
        before = model.forward(x).copy()

        model.policy_gradient_update(x, action_idx=1, reward=0.5, baseline=2.0, lr=0.01, l2=0.0)
        after = model.forward(x)

        assert after[1] < before[1]

    def test_on_baseline_reward_is_pure_l2_decay(self) -> None:
        # advantage == 0 => no policy signal at all: biases frozen, every weight
        # matrix multiplied by exactly (1 - lr*l2). This is the invariant that
        # makes the EMA baseline a variance reducer rather than a bias.
        model = self._tiny_model()
        lr, l2 = 0.01, 0.5
        w_before = [layer["W"].copy() for layer in model.layers]
        b_before = [layer["b"].copy() for layer in model.layers]

        model.policy_gradient_update(
            [1.0, 1.0], action_idx=2, reward=1.25, baseline=1.25, lr=lr, l2=l2
        )

        for layer, w0, b0 in zip(model.layers, w_before, b_before):
            assert np.allclose(layer["W"], w0 * (1.0 - lr * l2), rtol=0, atol=1e-15)
            assert np.array_equal(layer["b"], b0)

    def test_zero_learning_rate_is_a_no_op(self) -> None:
        model = self._tiny_model()
        w_before = [layer["W"].copy() for layer in model.layers]

        model.policy_gradient_update(
            [1.0, 1.0], action_idx=0, reward=3.0, baseline=-3.0, lr=0.0, l2=rl.L2
        )

        for layer, w0 in zip(model.layers, w_before):
            assert np.array_equal(layer["W"], w0)

    def test_dead_relu_units_receive_no_gradient(self) -> None:
        # A hidden unit clamped at 0 by ReLU must not be updated through its
        # incoming weights; leaking there would train on a path that is off.
        model = rl.MLP(2, 2, rl.N_ACTIONS, seed=3)
        _set_layer(model, 0, [[1.0, 0.0], [-5.0, -5.0]], [0.0, 0.0])  # unit 1 always dead
        _set_layer(model, 1, [[0.4, 0.4], [0.4, 0.4]], [0.5, 0.5])
        _set_layer(model, 2, [[0.2, 0.2]] * rl.N_ACTIONS, [0.0] * rl.N_ACTIONS)
        w1_before = model.layers[0]["W"].copy()

        model.policy_gradient_update(
            [1.0, 1.0], action_idx=1, reward=2.0, baseline=0.0, lr=0.05, l2=0.0
        )

        assert np.array_equal(model.layers[0]["W"][1], w1_before[1])  # dead row untouched
        assert not np.array_equal(model.layers[0]["W"][0], w1_before[0])


class TestBaselineEMA:
    """The reward baseline lives inline in train(); pin its documented form."""

    def test_train_uses_the_documented_ema_recurrence(self) -> None:
        import inspect

        src = inspect.getsource(rl.train)
        assert "alpha_baseline = 0.1" in src
        assert "baseline = (1 - alpha_baseline) * baseline + alpha_baseline * reward" in src

    def test_ema_converges_to_a_constant_reward_stream(self) -> None:
        # Same recurrence, run forward: after ~10x the horizon the baseline sits
        # on the reward, at which point updates become pure L2 decay (above).
        alpha, baseline, reward = 0.1, 0.0, 1.5
        for _ in range(100):
            baseline = (1 - alpha) * baseline + alpha * reward
        assert baseline == pytest.approx(reward, abs=1e-4)

    def test_ema_stays_inside_the_reward_clip_band(self) -> None:
        # A convex combination of clipped rewards can never escape the clip band,
        # so the advantage stays bounded and the updates cannot diverge.
        r = random.Random(9)
        baseline = 0.0
        for _ in range(500):
            reward = r.uniform(-rl.CLIP_REWARD, rl.CLIP_REWARD)
            baseline = 0.9 * baseline + 0.1 * reward
            assert -rl.CLIP_REWARD <= baseline <= rl.CLIP_REWARD


# ── numpy rewrite parity ──


class TestNumpyParity:
    """Locks the ~29x numpy rewrite to the pure-Python implementation it replaced."""

    def test_forward_matches_the_loop_implementation(self) -> None:
        model = rl.MLP(4, 6, 3, seed=17)
        ref_layers = _snapshot(model)
        x = [0.1, 0.9, -0.4, 0.6]

        got = model.forward(x)
        want, _ = _ref_forward(ref_layers, x)

        assert got == pytest.approx(want, rel=1e-12, abs=1e-15)

    def test_sequential_updates_match_the_loop_implementation(self) -> None:
        model = rl.MLP(4, 6, 3, seed=17)
        ref_layers = _snapshot(model)
        r = random.Random(23)
        baseline = 0.0

        for _ in range(30):
            x = [r.uniform(0.0, 1.0) for _ in range(4)]
            action = r.randrange(3)
            reward = r.uniform(-rl.CLIP_REWARD, rl.CLIP_REWARD)
            baseline = 0.9 * baseline + 0.1 * reward
            model.policy_gradient_update(x, action, reward, baseline, rl.LR, rl.L2)
            _ref_update(ref_layers, x, action, reward, baseline, rl.LR, rl.L2)

        for layer, ref in zip(model.layers, ref_layers):
            np.testing.assert_allclose(layer["W"], np.array(ref["W"]), rtol=1e-10, atol=1e-14)
            np.testing.assert_allclose(layer["b"], np.array(ref["b"]), rtol=1e-10, atol=1e-14)

    def test_backprop_uses_post_update_weights(self) -> None:
        """The rewrite kept a quirk: d_h2 is computed from the ALREADY-updated W3.

        A "cleaner" rewrite that snapshotted W3 first would still train, and
        would silently train a *different* policy, so the quirk is asserted
        with hand-computed numbers rather than left to a comment.

        Net: x=[1,1] -> h1=[1,1,2] -> h2=[1,1,2], W3 rows all [0.1,0.2,0.3].
        adv=6, probs uniform 0.2 => d_logits=[4.8,-1.2,-1.2,-1.2,-1.2] (sums to 0).
        With lr=0.5, W3 row0 becomes [2.5,2.6,5.1] and rows 1-4 [-0.5,-0.4,-0.9],
        so d_h2 = [14.4, 14.4, 28.8] and b2 = [7.2, 7.2, 14.4].
        Through the PRE-update W3 every row is identical, so d_h2 would collapse
        to W3[0][j] * sum(d_logits) = 0 and b2 would stay [0, 0, 0].
        """
        model = rl.MLP(2, 3, rl.N_ACTIONS, seed=29)
        _set_layer(model, 0, [[1.0, 0.0], [0.0, 1.0], [1.0, 1.0]], [0.0, 0.0, 0.0])
        _set_layer(model, 1, [[1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]], [0.0, 0.0, 0.0])
        _set_layer(model, 2, [[0.1, 0.2, 0.3]] * rl.N_ACTIONS, [0.0] * rl.N_ACTIONS)

        model.policy_gradient_update([1.0, 1.0], 0, reward=3.0, baseline=-3.0, lr=0.5, l2=0.0)

        assert model.layers[2]["W"][0].tolist() == pytest.approx([2.5, 2.6, 5.1])
        assert model.layers[2]["W"][1].tolist() == pytest.approx([-0.5, -0.4, -0.9])
        assert model.layers[1]["b"].tolist() == pytest.approx([7.2, 7.2, 14.4])


# ── Determinism ──


class TestDeterminism:
    def test_same_seed_gives_identical_initial_weights(self) -> None:
        a, b = rl.MLP(16, 64, 5, seed=42), rl.MLP(16, 64, 5, seed=42)
        for la, lb in zip(a.layers, b.layers):
            assert np.array_equal(la["W"], lb["W"])
            assert np.array_equal(la["b"], lb["b"])

    def test_different_seeds_give_different_initial_weights(self) -> None:
        a, b = rl.MLP(16, 64, 5, seed=42), rl.MLP(16, 64, 5, seed=43)
        assert not np.array_equal(a.layers[0]["W"], b.layers[0]["W"])

    def test_biases_start_at_zero(self) -> None:
        # He init applies to W only; non-zero bias init would break the parity
        # with the TypeScript loader, which trusts b to be trained-only.
        for layer in rl.MLP(16, 64, 5).layers:
            assert np.array_equal(layer["b"], np.zeros(layer["out_d"]))

    def test_he_init_scale_matches_the_fan_in(self) -> None:
        # std ~= sqrt(2/in_dim) keeps activations from vanishing across 3 layers.
        w = rl.MLP(32, 256, 5, seed=1).layers[0]["W"]
        assert float(w.std()) == pytest.approx(math.sqrt(2.0 / 32), rel=0.1)

    @pytest.mark.integration
    def test_training_is_reproducible_under_a_fixed_global_seed(self) -> None:
        """THE property that locks in the numpy rewrite: same seed, same weights."""
        samples = _synthetic_samples(60)
        args = SimpleNamespace(epochs=20, lr=rl.LR)

        random.seed(2024)
        first, sharpe_a, base_a = rl.train(list(samples), args)
        random.seed(2024)
        second, sharpe_b, base_b = rl.train(list(samples), args)

        assert first is not None
        assert first == second
        assert (sharpe_a, base_a) == (sharpe_b, base_b)

    @pytest.mark.integration
    def test_train_val_split_is_drawn_from_the_ambient_global_rng(self) -> None:
        """Documents a real reproducibility gap.

        MLP.__init__ seeds `random` to 42, but train() shuffles the train/val
        split BEFORE constructing the model, so the split (and therefore the
        shipped weights) depends on whatever state the global RNG happened to be
        in. A caller that does not seed first cannot reproduce a released model.
        """
        samples = _synthetic_samples(60)
        args = SimpleNamespace(epochs=20, lr=rl.LR)

        random.seed(1)
        first, _, _ = rl.train(list(samples), args)
        random.seed(2)
        second, _, _ = rl.train(list(samples), args)

        assert first != second


# ── Numerical safety ──


class TestNumericalSafety:
    @pytest.mark.integration
    def test_extreme_rewards_do_not_produce_nan_or_inf_weights(self) -> None:
        # Rewards pinned to both clip rails, alternating every sample: the
        # harshest legal signal the trainer can ever see.
        samples = [
            (
                [i / 60.0] * rl.FEATURE_DIM,
                i % rl.N_ACTIONS,
                rl.CLIP_REWARD if i % 2 else -rl.CLIP_REWARD,
            )
            for i in range(60)
        ]
        random.seed(7)
        weights, sharpe, baseline = rl.train(samples, SimpleNamespace(epochs=20, lr=rl.LR))

        assert weights is not None
        for key, values in weights.items():
            assert np.all(np.isfinite(values)), f"{key} went non-finite"
        assert math.isfinite(sharpe) and math.isfinite(baseline)

    @pytest.mark.integration
    def test_zero_variance_features_do_not_break_training(self) -> None:
        # Every state identical: gradients are perfectly collinear, which is the
        # classic way to blow up a hand-rolled SGD loop.
        state = [0.5] * rl.FEATURE_DIM
        samples = [(list(state), i % rl.N_ACTIONS, 1.0 if i % 3 else -1.0) for i in range(60)]
        random.seed(7)
        weights, _, _ = rl.train(samples, SimpleNamespace(epochs=20, lr=rl.LR))

        assert weights is not None
        for values in weights.values():
            assert np.all(np.isfinite(values))

    def test_all_zero_state_still_yields_a_valid_policy(self) -> None:
        probs = rl.MLP(rl.FEATURE_DIM, rl.HIDDEN_DIM, rl.N_ACTIONS).forward([0.0] * rl.FEATURE_DIM)
        assert np.all(np.isfinite(probs))
        assert float(probs.sum()) == pytest.approx(1.0, abs=1e-12)

    def test_repeated_updates_keep_probabilities_normalised(self) -> None:
        """Worst legal signal at the DEFAULT lr: max advantage, every step, same state.

        The default 1e-3 is the only thing keeping this bounded — there is no
        gradient clipping, so a hand-passed `--lr 0.05` overflows this same loop
        to NaN within ~300 steps. See the report.
        """
        model = rl.MLP(rl.FEATURE_DIM, rl.HIDDEN_DIM, rl.N_ACTIONS, seed=13)
        state = [0.5] * rl.FEATURE_DIM
        for i in range(300):
            model.policy_gradient_update(
                state,
                i % rl.N_ACTIONS,
                reward=rl.CLIP_REWARD,
                baseline=-rl.CLIP_REWARD,
                lr=rl.LR,
                l2=rl.L2,
            )
        probs = model.forward(state)
        assert np.all(np.isfinite(probs))
        assert np.all(probs >= 0.0)
        assert float(probs.sum()) == pytest.approx(1.0, abs=1e-12)


# ── Export schema ──


class TestExportSchema:
    def test_get_weights_has_exactly_the_six_arrays_production_reads(self) -> None:
        weights = rl.MLP(rl.FEATURE_DIM, rl.HIDDEN_DIM, rl.N_ACTIONS).get_weights()
        assert set(weights) == set(EXPECTED_LENGTHS)

    def test_flattened_lengths_match_the_layer_geometry(self) -> None:
        # rlAgent.ts throws "w1 shape mismatch" on a length drift, disabling the agent.
        weights = rl.MLP(rl.FEATURE_DIM, rl.HIDDEN_DIM, rl.N_ACTIONS).get_weights()
        assert {k: len(v) for k, v in weights.items()} == EXPECTED_LENGTHS

    def test_flatten_is_row_major_as_the_typescript_loader_assumes(self) -> None:
        # rlAgent.ts reads w1[j * FEATURE_DIM + i] as W[j][i].
        model = rl.MLP(rl.FEATURE_DIM, rl.HIDDEN_DIM, rl.N_ACTIONS, seed=99)
        w1 = model.get_weights()["w1"]
        W = model.layers[0]["W"]
        for j in (0, 1, 31, 63):
            for i in (0, 5, 15):
                assert w1[j * rl.FEATURE_DIM + i] == W[j][i]

    def test_exported_values_are_json_safe_floats(self) -> None:
        weights = rl.MLP(rl.FEATURE_DIM, rl.HIDDEN_DIM, rl.N_ACTIONS).get_weights()
        for values in weights.values():
            assert all(isinstance(v, float) for v in values)
        json.dumps(weights)  # numpy scalars would raise here

    def test_geometry_constants_agree_with_each_other(self) -> None:
        assert rl.N_ACTIONS == len(rl.ACTIONS) == 5
        assert EXPECTED_LENGTHS["w1"] == rl.FEATURE_DIM * rl.HIDDEN_DIM
        assert EXPECTED_LENGTHS["w2"] == rl.HIDDEN_DIM * rl.HIDDEN_DIM
        assert EXPECTED_LENGTHS["w3"] == rl.HIDDEN_DIM * rl.N_ACTIONS

    @pytest.mark.contract
    @pytest.mark.skipif(not PROD_WEIGHTS.exists(), reason="deployed weights not present")
    def test_deployed_weights_match_the_trainer_geometry(self) -> None:
        deployed = json.loads(PROD_WEIGHTS.read_text())
        for key, length in EXPECTED_LENGTHS.items():
            assert len(deployed[key]) == length, f"{key} length drifted"
        assert deployed["featureDim"] == rl.FEATURE_DIM
        assert deployed["hiddenDim"] == rl.HIDDEN_DIM
        assert deployed["nActions"] == rl.N_ACTIONS
        assert deployed["actions"] == rl.ACTIONS

    @pytest.mark.contract
    @pytest.mark.skipif(not PROD_WEIGHTS.exists(), reason="deployed weights not present")
    def test_deployed_weights_carry_the_full_metadata_block(self) -> None:
        # A dropped key here silently blanks the dashboard / autoRetrain gate.
        deployed = json.loads(PROD_WEIGHTS.read_text())
        expected = set(EXPECTED_LENGTHS) | {
            "version",
            "trainedAt",
            "trainSamples",
            "valSharpe",
            "baselineSharpe",
            "improved",
            "featureDim",
            "hiddenDim",
            "nActions",
            "actions",
        }
        assert set(deployed) == expected


# ── Metrics ──


class TestComputeSharpe:
    def test_fewer_than_two_rewards_is_zero(self) -> None:
        assert rl.compute_sharpe([]) == 0.0
        assert rl.compute_sharpe([1.5]) == 0.0

    def test_positive_mean_gives_positive_sharpe(self) -> None:
        assert rl.compute_sharpe([1.0, 2.0, 3.0]) > 0
        assert rl.compute_sharpe([-1.0, -2.0, -3.0]) < 0

    def test_scale_invariant_in_the_reward_unit(self) -> None:
        # Sharpe is mean/std, so doubling every reward must not move it.
        base = [0.4, -0.2, 1.1, 0.7]
        assert rl.compute_sharpe([2 * r for r in base]) == pytest.approx(rl.compute_sharpe(base))

    def test_uses_the_population_standard_deviation(self) -> None:
        rewards = [1.0, 2.0, 3.0, 4.0]
        mean = 2.5
        pop_std = math.sqrt(sum((r - mean) ** 2 for r in rewards) / len(rewards))
        assert rl.compute_sharpe(rewards) == pytest.approx(mean / pop_std)

    def test_zero_variance_explodes_through_the_epsilon_floor(self) -> None:
        """Known hazard, pinned so it cannot change unnoticed.

        With zero variance the std falls back to 1e-8, so a constant-reward
        validation set reports a Sharpe of ~5e7. train() selects `best_weights`
        by this number, so a degenerate val split makes the selection meaningless
        rather than obviously broken.
        """
        assert rl.compute_sharpe([0.5, 0.5, 0.5]) == pytest.approx(0.5 / 1e-8)


class TestEvaluate:
    def test_matching_greedy_action_keeps_the_full_reward(self) -> None:
        model = rl.MLP(2, 2, rl.N_ACTIONS, seed=3)
        _set_layer(model, 2, [[0.0, 0.0]] * rl.N_ACTIONS, [0.0, 0.0, 5.0, 0.0, 0.0])
        samples = [([1.0, 1.0], 2, 2.0), ([1.0, 1.0], 2, 1.0)]

        avg, _ = rl.evaluate(model, samples)

        assert avg == pytest.approx(1.5)

    def test_mismatched_greedy_action_is_halved(self) -> None:
        model = rl.MLP(2, 2, rl.N_ACTIONS, seed=3)
        _set_layer(model, 2, [[0.0, 0.0]] * rl.N_ACTIONS, [0.0, 0.0, 5.0, 0.0, 0.0])
        samples = [([1.0, 1.0], 0, 2.0), ([1.0, 1.0], 0, 1.0)]

        avg, _ = rl.evaluate(model, samples)

        assert avg == pytest.approx(0.75)


# ── Feature extraction ──


class TestExtractState:
    def test_returns_the_declared_feature_dimension(self) -> None:
        assert len(rl.extract_state(_journal_entry())) == rl.FEATURE_DIM

    def test_every_feature_is_bounded_to_the_unit_interval(self) -> None:
        # rlAgent.ts does no normalisation of its own; out-of-band values would
        # push the first hidden layer straight into saturation.
        wild = _journal_entry(
            mlConfidence=9.9,
            bestEdge=-4.0,
            tokenPrice=17.0,
            rsiNow=-500,
            spread=3.0,
            atrRatio=99.0,
            timeLeftMin=900.0,
            consecutiveLosses=50,
            orderbookImbalance=8.0,
            recentFlips=1000,
        )
        assert all(0.0 <= v <= 1.0 for v in rl.extract_state(wild))

    def test_missing_fields_fall_back_to_neutral_defaults(self) -> None:
        state = rl.extract_state({"entry": {}, "analysis": {}})
        assert len(state) == rl.FEATURE_DIM
        assert state[0] == 0.5  # unknown ML confidence -> neutral
        assert state[8] == 0.5  # unknown MACD histogram -> neither up nor down
        assert state[12] == 0.5  # unknown time left -> mid-window (7.5 / 15)

    def test_accepts_flat_entries_as_well_as_nested(self) -> None:
        nested = rl.extract_state(_journal_entry(mlConfidence=0.81))
        flat = rl.extract_state(
            {
                "mlConfidence": 0.81,
                "bestEdge": 0.05,
                "tokenPrice": 0.55,
                "regime": "moderate",
                "session": "US",
                "rsiNow": 55,
                "macdHist": 0.4,
                "spread": 0.01,
                "atrRatio": 1.2,
                "delta1m": 5.0,
                "timeLeftMin": 8.0,
                "consecutiveLosses": 0,
                "orderbookImbalance": 0.1,
                "recentFlips": 1,
            }
        )
        assert nested == flat

    @pytest.mark.parametrize("regime,idx", [("trending", 3), ("choppy", 4)])
    def test_regime_one_hots_are_exclusive(self, regime: str, idx: int) -> None:
        state = rl.extract_state(_journal_entry(regime=regime))
        assert state[idx] == 1.0
        assert state[7 - idx] == 0.0  # the other regime flag (3 <-> 4)

    @pytest.mark.parametrize(
        "session,us,asia",
        [
            ("US", 1.0, 0.0),
            ("EU/US Overlap", 1.0, 0.0),
            ("Asia", 0.0, 1.0),
            ("Europe", 0.0, 0.0),
            ("", 0.0, 0.0),
        ],
    )
    def test_session_flags(self, session: str, us: float, asia: float) -> None:
        state = rl.extract_state(_journal_entry(session=session))
        assert (state[5], state[6]) == (us, asia)

    @pytest.mark.parametrize("macd,expected", [(1.0, 1.0), (-1.0, 0.0), (0.0, 0.5), (None, 0.5)])
    def test_macd_sign_is_tri_state(self, macd: float | None, expected: float) -> None:
        assert rl.extract_state(_journal_entry(macdHist=macd))[8] == expected

    def test_none_session_does_not_crash(self) -> None:
        assert rl.extract_state(_journal_entry(session=None))[5] == 0.0

    def test_non_numeric_fields_degrade_to_neutral_instead_of_crashing(self) -> None:
        # Journal rows are untrusted JSONL: one bad field must not kill a retrain.
        state = rl.extract_state(
            _journal_entry(rsiNow="n/a", spread={"bad": 1}, atrRatio=[1], timeLeftMin="soon")
        )
        assert len(state) == rl.FEATURE_DIM
        assert all(0.0 <= v <= 1.0 for v in state)
        assert state[7] == 0.5

    def test_nan_features_become_neutral_not_saturated(self) -> None:
        # float('nan') used to survive max(0, min(1, nan)) as 1.0 — a corrupt
        # field read as maximum confidence.
        state = rl.extract_state(_journal_entry(mlConfidence=float("nan"), tokenPrice=float("inf")))
        assert state[0] == 0.5
        assert state[2] == 0.5


class TestComputeReward:
    def test_reward_is_pnl_over_stake(self) -> None:
        assert rl.compute_reward(_journal_entry(pnl=2.5, bet=10.0)) == pytest.approx(0.25)

    def test_dry_run_entries_are_skipped(self) -> None:
        assert rl.compute_reward(_journal_entry(outcome="DRY_RUN")) is None

    @pytest.mark.parametrize(
        "reward_pnl,expected", [(1000.0, rl.CLIP_REWARD), (-1000.0, -rl.CLIP_REWARD)]
    )
    def test_rewards_are_clipped_both_ways(self, reward_pnl: float, expected: float) -> None:
        # Unclipped, a single jackpot trade would dominate every gradient it touches.
        assert rl.compute_reward(_journal_entry(pnl=reward_pnl, bet=1.0)) == expected

    def test_missing_pnl_is_skipped(self) -> None:
        entry = _journal_entry()
        entry["analysis"].pop("pnl")
        assert rl.compute_reward(entry) is None

    @pytest.mark.parametrize("bet", [0.0, -5.0])
    def test_non_positive_stake_is_skipped(self, bet: float) -> None:
        entry = _journal_entry(bet=bet)
        assert rl.compute_reward(entry) is None

    def test_falls_back_from_bet_amount_to_cost(self) -> None:
        entry = _journal_entry(pnl=1.0)
        entry["entry"].pop("betAmount")
        entry["entry"]["cost"] = 4.0
        assert rl.compute_reward(entry) == pytest.approx(0.25)

    def test_non_numeric_stake_is_skipped_not_fatal(self) -> None:
        assert rl.compute_reward(_journal_entry(bet="n/a")) is None

    def test_nan_pnl_is_skipped_not_read_as_a_maximum_win(self) -> None:
        # max(-3, min(3, nan)) returns 3.0 because every NaN comparison is False,
        # so an unguarded NaN taught the agent its best-ever trade.
        entry = _journal_entry()
        entry["analysis"]["pnl"] = float("nan")
        assert rl.compute_reward(entry) is None

    def test_infinite_pnl_is_skipped(self) -> None:
        entry = _journal_entry()
        entry["analysis"]["pnl"] = float("inf")
        assert rl.compute_reward(entry) is None


class TestAsFloat:
    @pytest.mark.parametrize("value,expected", [(1, 1.0), (2.5, 2.5), ("3.5", 3.5), (True, 1.0)])
    def test_parses_finite_numbers(self, value: object, expected: float) -> None:
        assert rl._as_float(value) == expected

    @pytest.mark.parametrize(
        "value", [None, "n/a", {}, [], object(), float("nan"), float("inf"), float("-inf")]
    )
    def test_unusable_values_become_none(self, value: object) -> None:
        assert rl._as_float(value) is None


# ── Journal loading / sample preparation ──


class TestLoadData:
    def _write(self, tmp_path: Path, lines: list[str]) -> str:
        path = tmp_path / "trade_journal.jsonl"
        path.write_text("\n".join(lines), encoding="utf-8")
        return str(path)

    def test_reads_one_entry_per_line(self, tmp_path: Path) -> None:
        path = self._write(tmp_path, ['{"a": 1}', '{"a": 2}'])
        assert rl.load_data(path) == [{"a": 1}, {"a": 2}]

    def test_blank_and_whitespace_lines_are_skipped(self, tmp_path: Path) -> None:
        path = self._write(tmp_path, ['{"a": 1}', "", "   ", '{"a": 2}', ""])
        assert len(rl.load_data(path)) == 2

    def test_malformed_json_lines_are_skipped_not_fatal(self, tmp_path: Path) -> None:
        # A half-flushed final line is normal for an append-only JSONL journal.
        path = self._write(tmp_path, ['{"a": 1}', "not json at all", '{"a": 2}', '{"trunc'])
        assert rl.load_data(path) == [{"a": 1}, {"a": 2}]

    def test_empty_journal_yields_no_entries(self, tmp_path: Path) -> None:
        assert rl.load_data(self._write(tmp_path, [])) == []

    def test_missing_journal_exits_nonzero(self, tmp_path: Path) -> None:
        with pytest.raises(SystemExit) as excinfo:
            rl.load_data(str(tmp_path / "nope.jsonl"))
        assert excinfo.value.code == 1


class TestPrepareSamples:
    def test_builds_state_action_reward_triples(self) -> None:
        entries = [_journal_entry(action=1) for _ in range(rl.MIN_TRADES)]
        samples = rl.prepare_samples(entries, augment=False)

        assert len(samples) == rl.MIN_TRADES
        state, action, reward = samples[0]
        assert len(state) == rl.FEATURE_DIM
        assert action == 1
        assert reward == pytest.approx(0.1)

    def test_entries_without_an_action_default_to_the_neutral_scalar(self) -> None:
        # Historical rows predate the RL agent; index 2 is the 1.0x multiplier.
        entries = [_journal_entry(action=None) for _ in range(rl.MIN_TRADES)]
        samples = rl.prepare_samples(entries, augment=False)
        assert {a for _, a, _ in samples} == {2}
        assert rl.ACTIONS[2] == 1.0

    def test_dry_runs_are_dropped_before_the_minimum_trade_check(self) -> None:
        entries = [_journal_entry() for _ in range(rl.MIN_TRADES)] + [
            _journal_entry(outcome="DRY_RUN") for _ in range(20)
        ]
        assert len(rl.prepare_samples(entries, augment=False)) == rl.MIN_TRADES

    def test_too_few_real_trades_exits_nonzero(self) -> None:
        # Training on a handful of trades would ship a policy fitted to noise.
        entries = [_journal_entry() for _ in range(rl.MIN_TRADES - 1)]
        with pytest.raises(SystemExit) as excinfo:
            rl.prepare_samples(entries, augment=False)
        assert excinfo.value.code == 1

    def test_augment_flag_bootstraps_to_the_documented_size(self) -> None:
        # --augment exists because ~450 real trades overfit a 5k-parameter policy.
        entries = [
            _journal_entry(regime="trending" if i % 3 == 0 else "moderate")
            for i in range(rl.MIN_TRADES)
        ]
        assert len(rl.prepare_samples(entries, augment=True)) == 2000

    def test_malformed_rows_are_skipped_rather_than_crashing(self) -> None:
        entries: list[dict] = [_journal_entry() for _ in range(rl.MIN_TRADES)]
        entries += [
            {},  # nothing at all
            {"entry": {}, "analysis": {}},  # no pnl
            _journal_entry(bet="n/a"),  # unparseable stake
            _journal_entry(pnl=float("nan")),  # NaN payout
        ]
        assert len(rl.prepare_samples(entries, augment=False)) == rl.MIN_TRADES


class TestAugmentSamples:
    def test_bootstraps_to_the_documented_floor(self) -> None:
        samples = _synthetic_samples(60)
        for state, _, _ in samples[:20]:
            state[3] = 1.0  # trending -> minority class
        assert len(rl.augment_samples(samples)) == 2000

    def test_large_journals_double_instead_of_using_the_floor(self) -> None:
        samples = _synthetic_samples(1500)
        for state, _, _ in samples[:200]:
            state[6] = 1.0  # asia
        assert len(rl.augment_samples(samples)) == 3000

    def test_original_samples_are_preserved_as_a_prefix(self) -> None:
        samples = _synthetic_samples(60)
        for state, _, _ in samples[:20]:
            state[3] = 1.0
        originals = [(s[:], a, r) for s, a, r in samples]

        augmented = rl.augment_samples(samples)

        for (s0, a0, r0), (s1, a1, r1) in zip(originals, augmented[:60]):
            assert s0 == s1 and a0 == a1 and r0 == r1

    def test_synthetic_states_stay_in_the_unit_interval(self) -> None:
        samples = _synthetic_samples(60)
        for state, _, _ in samples[:20]:
            state[3] = 1.0
        for state, _, _ in rl.augment_samples(samples):
            assert len(state) == rl.FEATURE_DIM
            assert all(0.0 <= v <= 1.0 for v in state)

    def test_one_hot_features_are_never_jittered(self) -> None:
        # Noise on a categorical flag would invent regimes/sessions that
        # cannot occur at inference time.
        samples = _synthetic_samples(60)
        for state, _, _ in samples:
            state[3], state[4], state[5], state[6] = 1.0, 0.0, 1.0, 0.0
        for state, _, _ in rl.augment_samples(samples)[60:]:
            assert (state[3], state[4], state[5], state[6]) == (1.0, 0.0, 1.0, 0.0)

    def test_labels_are_copied_from_the_source_sample(self) -> None:
        samples = _synthetic_samples(60)
        for state, _, _ in samples[:20]:
            state[3] = 1.0
        known = {(a, r) for _, a, r in samples}
        for _, a, r in rl.augment_samples(samples)[60:]:
            assert (a, r) in known

    def test_no_minority_rows_means_no_augmentation(self) -> None:
        samples = _synthetic_samples(60)
        for state, _, _ in samples:
            state[3], state[6] = 0.0, 0.0
        assert rl.augment_samples(samples) is samples

    def test_source_states_are_not_mutated_by_the_noise_pass(self) -> None:
        samples = _synthetic_samples(60)
        for state, _, _ in samples[:20]:
            state[3] = 1.0
        before = [s[:] for s, _, _ in samples]

        rl.augment_samples(samples)

        assert [s[:] for s, _, _ in samples[:60]] == before

    def test_is_reproducible_under_a_fixed_global_seed(self) -> None:
        samples = _synthetic_samples(60)
        for state, _, _ in samples[:20]:
            state[3] = 1.0

        random.seed(31)
        first = rl.augment_samples([(s[:], a, r) for s, a, r in samples])
        random.seed(31)
        second = rl.augment_samples([(s[:], a, r) for s, a, r in samples])

        assert first == second


# ── CLI / end-to-end ──


class TestCli:
    def test_defaults_point_at_the_deploy_paths(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setattr(sys, "argv", ["trainRLAgent.py"])
        args = rl.parse_args()
        assert args.journal.endswith("trade_journal.jsonl")
        assert args.output.endswith("rl_agent_weights.json")
        assert args.augment is False
        assert args.dry_run is False
        assert (args.epochs, args.lr) == (rl.EPOCHS, rl.LR)

    def test_flags_are_parsed(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setattr(
            sys,
            "argv",
            [
                "trainRLAgent.py",
                "--augment",
                "--dry-run",
                "--epochs",
                "40",
                "--lr",
                "0.02",
                "--journal",
                "j.jsonl",
                "--output",
                "o.json",
            ],
        )
        args = rl.parse_args()
        assert (args.augment, args.dry_run, args.epochs, args.lr) == (True, True, 40, 0.02)
        assert (args.journal, args.output) == ("j.jsonl", "o.json")


@pytest.mark.integration
class TestEndToEnd:
    @staticmethod
    def _journal(tmp_path: Path, n: int = 60) -> Path:
        r = random.Random(3)
        rows = []
        for i in range(n):
            rows.append(
                json.dumps(
                    _journal_entry(
                        pnl=r.uniform(-4.0, 6.0),
                        bet=10.0,
                        action=i % rl.N_ACTIONS,
                        mlConfidence=r.random(),
                        regime="trending" if i % 4 == 0 else "moderate",
                        session="Asia" if i % 5 == 0 else "US",
                    )
                )
            )
        path = tmp_path / "trade_journal.jsonl"
        path.write_text("\n".join(rows), encoding="utf-8")
        return path

    def test_main_writes_a_file_with_the_production_key_set(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        journal = self._journal(tmp_path)
        out = tmp_path / "nested" / "rl_agent_weights.json"
        monkeypatch.setattr(
            sys,
            "argv",
            ["trainRLAgent.py", "--journal", str(journal), "--output", str(out), "--epochs", "20"],
        )
        random.seed(4)

        rl.main()

        written = json.loads(out.read_text())
        assert set(written) == set(EXPECTED_LENGTHS) | {
            "version",
            "trainedAt",
            "trainSamples",
            "valSharpe",
            "baselineSharpe",
            "improved",
            "featureDim",
            "hiddenDim",
            "nActions",
            "actions",
        }
        assert {k: len(written[k]) for k in EXPECTED_LENGTHS} == EXPECTED_LENGTHS
        assert written["trainSamples"] == 60
        assert written["improved"] is (written["valSharpe"] > written["baselineSharpe"])
        assert isinstance(written["version"], int)
        assert written["trainedAt"].endswith("Z")
        for key in EXPECTED_LENGTHS:
            assert np.all(np.isfinite(written[key]))

    def test_fewer_than_twenty_epochs_produces_no_weights_at_all(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """Documents a real trap: train() only snapshots weights every 20 epochs.

        `--epochs 19` (or any value below 20, and in general any value that is
        not a multiple of 20 loses its final epochs) never reaches the
        `(epoch + 1) % 20 == 0` checkpoint, so best_weights stays None and the
        run aborts after doing all the work. See the report.
        """
        journal = self._journal(tmp_path)
        out = tmp_path / "never_written.json"
        monkeypatch.setattr(
            sys,
            "argv",
            ["trainRLAgent.py", "--journal", str(journal), "--output", str(out), "--epochs", "5"],
        )
        random.seed(4)

        with pytest.raises(SystemExit) as excinfo:
            rl.main()

        assert excinfo.value.code == 1
        assert not out.exists()

    def test_dry_run_trains_but_writes_nothing(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        journal = self._journal(tmp_path)
        out = tmp_path / "should_not_exist.json"
        monkeypatch.setattr(
            sys,
            "argv",
            [
                "trainRLAgent.py",
                "--journal",
                str(journal),
                "--output",
                str(out),
                "--epochs",
                "20",
                "--dry-run",
            ],
        )
        random.seed(4)

        rl.main()

        assert not out.exists()
