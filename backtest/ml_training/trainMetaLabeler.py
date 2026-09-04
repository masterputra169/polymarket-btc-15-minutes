#!/usr/bin/env python3
"""
=== Meta-Labeler Training (ML4T / López de Prado recommendation #3) ===

Fits a small L2 logistic regression that scores the PRIMARY signal's own trades:
given that the bot already decided to bet, was this bet worth taking? The
primary XGBoost/LightGBM ensemble is untouched — this is a strictly secondary
take/skip model, evaluated on the bot's trade journal.

Usage:
  python trainMetaLabeler.py
  python trainMetaLabeler.py --journal ../../bot/data/trade_journal.jsonl
  python trainMetaLabeler.py --settled-only --test-size 0.3 --embargo 10
  python trainMetaLabeler.py --output ./output/meta_labeler.json

This is an EVALUATION deliverable. It writes one JSON file to --output and
nothing else: no deploy to public/ml/, no bot wiring. Whether the meta-labeler
ever goes live is the user's decision, and the printed verdict is meant to
inform it — including, quite possibly, "it does not work".

This file is the ENTRYPOINT only: argparse, orchestration, printing. Dataset
construction and the embargoed temporal split live in mltrain/meta_labeling.py;
the fit, the honest metrics and the export schema live in mltrain/meta_eval.py.
Both are unit-tested in tests/test_meta_labeling.py.
"""

import argparse
import json
import sys
from datetime import UTC, datetime
from pathlib import Path

import numpy as np

from mltrain.meta_eval import (
    DEFAULT_C,
    DEFAULT_CI,
    DEFAULT_MIN_TRAIN_FRAC,
    DEFAULT_N_BOOTSTRAP,
    DEFAULT_WALK_FORWARD_FOLDS,
    MIN_TRAIN_ROWS,
    build_export,
    build_verdict,
    evaluate_meta_predictions,
    fit_meta_labeler,
    walk_forward_evaluation,
)
from mltrain.meta_labeling import (
    DEFAULT_ELIGIBLE_OUTCOMES,
    DEFAULT_EMBARGO,
    DEFAULT_TEST_SIZE,
    SETTLED_ELIGIBLE_OUTCOMES,
    build_dataset,
    load_journal_rows,
    temporal_index_split,
)


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(
        description="Train and honestly evaluate a meta-labeler on the bot trade journal"
    )
    p.add_argument(
        "--journal",
        default="../../bot/data/trade_journal.jsonl",
        help="Path to trade_journal.jsonl",
    )
    p.add_argument(
        "--output",
        default="./output/meta_labeler.json",
        help="Where to write the exported model JSON",
    )
    p.add_argument(
        "--settled-only",
        action="store_true",
        help="Restrict to WIN/LOSS (drops CUT_LOSS, whose outcome the cut-loss policy confounds)",
    )
    p.add_argument("--test-size", type=float, default=DEFAULT_TEST_SIZE)
    p.add_argument(
        "--embargo",
        type=int,
        default=DEFAULT_EMBARGO,
        help="Rows dropped after the split boundary (ML4T embargo)",
    )
    p.add_argument("--C", dest="c", type=float, default=DEFAULT_C, help="Inverse L2 strength")
    p.add_argument("--folds", type=int, default=DEFAULT_WALK_FORWARD_FOLDS)
    p.add_argument("--min-train-frac", type=float, default=DEFAULT_MIN_TRAIN_FRAC)
    p.add_argument("--bootstrap", type=int, default=DEFAULT_N_BOOTSTRAP)
    p.add_argument("--seed", type=int, default=42)
    p.add_argument("--dry-run", action="store_true", help="Evaluate but do not write --output")
    return p.parse_args()


def print_calibration(calibration: dict) -> None:
    print("   Calibration bins (predicted -> observed):")
    for row in calibration["bins"]:
        if not row["count"]:
            continue
        print(
            f"     [{row['min_prob']:.2f}, {row['max_prob']:.2f})  n={row['count']:>4}  "
            f"pred={row['avg_predicted']:.4f}  obs={row['observed_rate']:.4f}  "
            f"gap={row['gap']:.4f}"
        )


def main() -> int:
    args = parse_args()
    eligible = SETTLED_ELIGIBLE_OUTCOMES if args.settled_only else DEFAULT_ELIGIBLE_OUTCOMES

    print("=== Meta-Labeler (secondary take/skip model) ===")
    print(f"Journal: {args.journal}")
    print(f"Eligible outcomes: {', '.join(eligible)}")
    print("")

    print("1. Loading journal")
    try:
        loaded = load_journal_rows(args.journal)
    except FileNotFoundError as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 1

    print("")
    print("2. Building meta-label dataset (features knowable at decision time only)")
    try:
        dataset = build_dataset(loaded.rows, eligible_outcomes=eligible)
    except ValueError as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 1
    print(f"   Features: {len(dataset.feature_names)} -> {', '.join(dataset.feature_names)}")

    print("")
    print("3. Temporal split (no shuffling, embargo + slug purge at the boundary)")
    split = temporal_index_split(
        dataset.entered_at,
        dataset.slugs,
        test_size=args.test_size,
        embargo=args.embargo,
    )
    print(
        f"   Train: {split.train_idx.size:,} | Test: {split.test_idx.size:,} "
        f"(embargoed {split.n_embargoed}, purged {split.n_purged} same-slug rows)"
    )
    if split.train_idx.size < MIN_TRAIN_ROWS or split.test_idx.size == 0:
        print(
            f"ERROR: need >= {MIN_TRAIN_ROWS} train rows and a non-empty test slice",
            file=sys.stderr,
        )
        return 1

    y_train = dataset.y[split.train_idx]
    y_test = dataset.y[split.test_idx]
    print(f"   Train base rate: {y_train.mean() * 100:.2f}%")
    print(f"   Test  base rate: {y_test.mean() * 100:.2f}%  <- the always-take benchmark")

    print("")
    print(f"4. Fitting L2 logistic regression (C={args.c}, no class weighting, not tuned)")
    try:
        model = fit_meta_labeler(
            dataset.X[split.train_idx],
            y_train,
            feature_names=dataset.feature_names,
            c=args.c,
            seed=args.seed,
        )
    except ValueError as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 1

    order = np.argsort(-np.abs(np.asarray(model.coefficients)))
    print("   Largest standardised coefficients:")
    for i in order[:8]:
        print(f"     {model.feature_names[i]:<24} {model.coefficients[i]:+.4f}")

    print("")
    print("5. Held-out evaluation")
    y_prob = model.predict_proba(dataset.X[split.test_idx])
    holdout = evaluate_meta_predictions(
        y_test,
        y_prob,
        n_bootstrap=args.bootstrap,
        ci=DEFAULT_CI,
        rng=np.random.default_rng(args.seed),
    )
    auc_txt = f"{holdout.auc:.4f}" if holdout.auc is not None else "undefined (single class)"
    ci_txt = (
        f"[{holdout.auc_ci_low:.4f}, {holdout.auc_ci_high:.4f}]"
        if holdout.auc_ci_low is not None
        else "n/a"
    )
    print(f"   n            : {holdout.n:,}")
    print(f"   Base rate    : {holdout.base_rate * 100:.2f}%")
    print(f"   Accuracy     : {holdout.accuracy * 100:.2f}%")
    print(f"   AUC          : {auc_txt}   95% bootstrap CI {ci_txt}")
    print(f"   Brier        : {holdout.brier:.4f}")
    print(f"   ECE / MCE    : {holdout.ece:.4f} / {holdout.mce:.4f}")
    print_calibration(holdout.calibration)

    print("")
    print(f"6. Walk-forward spread ({args.folds} expanding-window refits)")
    walk_forward = walk_forward_evaluation(
        dataset,
        n_folds=args.folds,
        min_train_frac=args.min_train_frac,
        embargo=args.embargo,
        c=args.c,
        seed=args.seed,
    )
    for fold in walk_forward.folds:
        fold_auc = f"{fold.auc:.4f}" if fold.auc is not None else "n/a"
        print(
            f"     fold {fold.fold}: train={fold.n_train:>4} test={fold.n_test:>4} "
            f"base={fold.base_rate * 100:5.1f}%  acc={fold.accuracy * 100:5.1f}%  auc={fold_auc}"
        )
    if walk_forward.mean_auc is not None:
        print(
            f"   AUC mean {walk_forward.mean_auc:.4f} +/- {walk_forward.std_auc:.4f} "
            f"(min {walk_forward.min_auc:.4f}, max {walk_forward.max_auc:.4f})"
        )
    else:
        print("   No fold produced a defined AUC.")

    print("")
    verdict = build_verdict(holdout, walk_forward)
    print("7. Verdict")
    print(f"   {verdict.message}")

    export = build_export(
        model,
        dataset=dataset,
        split=split,
        holdout=holdout,
        walk_forward=walk_forward,
        verdict=verdict,
        journal_path=args.journal,
        generated_at=datetime.now(UTC).isoformat(),
        eligible_outcomes=eligible,
        embargo=args.embargo,
        test_size=args.test_size,
    )

    print("")
    if args.dry_run:
        print("8. --dry-run: not writing the model")
        return 0

    out_path = Path(args.output)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(export, indent=2), encoding="utf-8")
    print(f"8. Wrote {out_path} ({out_path.stat().st_size:,} bytes)")
    print("   NOT deployed: nothing was copied to public/ml/ and the bot is unchanged.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
