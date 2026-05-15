#!/bin/bash
# Emergency restore v16 — gunakan kalau model di public/ml/ accidentally replaced
# atau retrain berikutnya deploy model inferior.
#
# Usage: ./restore-v16.sh
set -e

ML_DIR="A:/PolymarketBTC15mAssistant-main/frontend/public/ml"
LOCK_DIR="$ML_DIR/v16_locked"

if [ ! -d "$LOCK_DIR" ]; then
  echo "✗ Lock folder tidak ada: $LOCK_DIR"
  exit 1
fi

echo "Backup current model files (just in case)..."
cp "$ML_DIR/xgboost_model.json"  "$ML_DIR/xgboost_model.pre_restore.bak" 2>/dev/null || true
cp "$ML_DIR/lightgbm_model.json" "$ML_DIR/lightgbm_model.pre_restore.bak" 2>/dev/null || true
cp "$ML_DIR/norm_browser.json"   "$ML_DIR/norm_browser.pre_restore.bak" 2>/dev/null || true

echo "Restoring v16 from $LOCK_DIR ..."
cp "$LOCK_DIR/xgboost_model.json"  "$ML_DIR/xgboost_model.json"
cp "$LOCK_DIR/lightgbm_model.json" "$ML_DIR/lightgbm_model.json"
cp "$LOCK_DIR/norm_browser.json"   "$ML_DIR/norm_browser.json"

echo "✓ v16 restored. Restarting bot..."
pm2 restart polymarket-bot --update-env 2>&1 | grep -E "online|errored" | head -2

echo ""
echo "Verifikasi: pm2 logs polymarket-bot | grep 'XGBoost v3 loaded'"
echo "Akan tampil: 1200/1200 trees, 79 features (= v16 signature)"
