#!/bin/bash
# ═══ BTC Prediction ML Training Pipeline ═══
# One-click script to generate data, train, and deploy model
#
# Usage:
#   chmod +x runTraining.sh
#   ./runTraining.sh [--days 30] [--tune] [--deploy]
#
# Requirements:
#   - Node.js 18+ (for data generation)
#   - Python 3.8+ with: xgboost, pandas, numpy, scikit-learn
#   - Optional: optuna (for --tune Bayesian hyperparameter optimization)
#
# Install Python deps:
#   pip install xgboost pandas numpy scikit-learn optuna

set -e

# ═══ Parse args ═══
DAYS=540
TUNE=""
DEPLOY=false
EPOCHS=1200
TUNE_TRIALS=150
MIN_MOVE="0.0005"

while [[ $# -gt 0 ]]; do
  case $1 in
    --days)      DAYS="$2"; shift 2 ;;
    --tune)      TUNE="--tune"; shift ;;
    --tune-trials) TUNE_TRIALS="$2"; shift 2 ;;
    --epochs)    EPOCHS="$2"; shift 2 ;;
    --min-move)  MIN_MOVE="$2"; shift 2 ;;
    --deploy)    DEPLOY=true; shift ;;
    --help)
      echo "Usage: ./runTraining.sh [--days 30] [--tune] [--tune-trials 100] [--min-move 0.0005] [--deploy]"
      echo ""
      echo "  --days N          Days of historical data (default: 30)"
      echo "  --tune            Run Optuna Bayesian hyperparameter optimization"
      echo "  --tune-trials N   Number of Optuna trials (default: 100)"
      echo "  --min-move F      Min price move fraction to keep sample (default: 0.0005 = 0.05%)"
      echo "  --epochs N        Max training rounds (default: 1000)"
      echo "  --deploy          Auto-copy model to public/ml/"
      exit 0
      ;;
    *) echo "Unknown arg: $1"; exit 1 ;;
  esac
done

echo ""
echo "╔══════════════════════════════════════════════════╗"
echo "║  BTC Prediction ML Training Pipeline v10          ║"
echo "╠══════════════════════════════════════════════════╣"
echo "║  Days: $DAYS | Epochs: $EPOCHS | Tune: ${TUNE:-no} | Min-move: $MIN_MOVE"
echo "╚══════════════════════════════════════════════════╝"
echo ""

# ═══ Check dependencies ═══
echo "🔍 Checking dependencies..."
command -v node >/dev/null 2>&1 || { echo "❌ Node.js not found. Install Node.js 18+"; exit 1; }
command -v python3 >/dev/null 2>&1 || command -v python >/dev/null 2>&1 || { echo "❌ Python not found"; exit 1; }

PYTHON=$(command -v python3 || command -v python)
echo "   Node: $(node --version)"
echo "   Python: $($PYTHON --version)"

# Check Python packages
$PYTHON -c "import xgboost" 2>/dev/null || { echo "❌ xgboost not installed. Run: pip install xgboost"; exit 1; }
$PYTHON -c "import pandas" 2>/dev/null || { echo "❌ pandas not installed. Run: pip install pandas"; exit 1; }
$PYTHON -c "import sklearn" 2>/dev/null || { echo "❌ scikit-learn not installed. Run: pip install scikit-learn"; exit 1; }
if [ -n "$TUNE" ]; then
  $PYTHON -c "import optuna" 2>/dev/null || { echo "⚠️  optuna not installed. Run: pip install optuna"; echo "   Continuing without tuning..."; TUNE=""; }
fi
echo "   ✅ All dependencies OK"

# ═══ Step 0: Prepare Polymarket features + smart money lookup ═══
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
POLY_DATA_DIR="$SCRIPT_DIR/polymarket_btc15m_data"
POLY_LOOKUP="$SCRIPT_DIR/polymarket_lookup.json"
POLY_FLAG=""

if [ -d "$POLY_DATA_DIR" ] && [ -f "$POLY_DATA_DIR/02_btc15m_ml_ready.csv" ]; then
  echo ""
  echo "═══ STEP 0a: Prepare Polymarket Features ═══"
  echo ""
  $PYTHON "$SCRIPT_DIR/preparePolymarketFeatures.py" --data-dir "$POLY_DATA_DIR" --output "$POLY_LOOKUP"

  if [ -f "$POLY_LOOKUP" ]; then
    POLY_FLAG="--polymarket-lookup $POLY_LOOKUP"
    echo "   ✅ Polymarket lookup ready"
  else
    echo "   ⚠️  Polymarket lookup generation failed, continuing without real data"
  fi
else
  echo ""
  echo "   ℹ️  No Polymarket data at $POLY_DATA_DIR — using simulation"
fi

# ═══ Step 1: Generate training data ═══
echo ""
echo "═══ STEP 1/3: Generate Training Data ═══"
echo ""

DATA_FILE="$SCRIPT_DIR/training_data.csv"

node "$SCRIPT_DIR/generateTrainingData.mjs" --days $DAYS --min-move $MIN_MOVE --output "$DATA_FILE" $POLY_FLAG

if [ ! -f "$DATA_FILE" ]; then
  echo "❌ Training data generation failed"
  exit 1
fi

ROWS=$(wc -l < "$DATA_FILE")
echo "   ✅ Generated $((ROWS - 1)) samples"

# ═══ Step 2: Train XGBoost ═══
echo ""
echo "═══ STEP 2/3: Train XGBoost Model ═══"
echo ""

OUTPUT_DIR="$SCRIPT_DIR/output"
$PYTHON "$SCRIPT_DIR/trainXGBoost_v3.py" \
  --input "$DATA_FILE" \
  --output-dir "$OUTPUT_DIR" \
  --epochs $EPOCHS \
  --tune-trials $TUNE_TRIALS \
  --holdout-frac 0.125 \
  $TUNE

# ═══ Step 3: Deploy (optional) ═══
if [ "$DEPLOY" = true ]; then
  echo ""
  echo "═══ STEP 3/3: Deploy to public/ml/ ═══"
  echo ""

  # Try to find public/ml/ directory
  PUBLIC_ML=""
  for dir in "./public/ml" "../public/ml" "../../public/ml"; do
    if [ -d "$dir" ]; then
      PUBLIC_ML="$dir"
      break
    fi
  done

  if [ -z "$PUBLIC_ML" ]; then
    echo "   ⚠️  public/ml/ not found. Creating it..."
    mkdir -p ./public/ml
    PUBLIC_ML="./public/ml"
  fi

  cp "$OUTPUT_DIR/xgboost_model.json" "$PUBLIC_ML/xgboost_model.json"
  cp "$OUTPUT_DIR/norm_browser.json" "$PUBLIC_ML/norm_browser.json"
  if [ -f "$OUTPUT_DIR/lightgbm_model.json" ]; then
    cp "$OUTPUT_DIR/lightgbm_model.json" "$PUBLIC_ML/lightgbm_model.json"
  fi
  echo "   ✅ Deployed to $PUBLIC_ML/"
  echo "      - xgboost_model.json"
  echo "      - norm_browser.json"
  echo "      - lightgbm_model.json (if LGB trained)"
else
  echo ""
  echo "═══ STEP 3/3: Manual Deploy ═══"
  echo ""
  echo "   Copy these files to your React app's public/ml/ folder:"
  echo "     cp $OUTPUT_DIR/xgboost_model.json public/ml/"
  echo "     cp $OUTPUT_DIR/norm_browser.json  public/ml/"
fi

echo ""
echo "╔══════════════════════════════════════════════════╗"
echo "║  ✅ Pipeline Complete!                            ║"
echo "║                                                  ║"
echo "║  Files in $OUTPUT_DIR/:"
echo "║  ├── xgboost_model.json  (browser model)"
echo "║  ├── norm_browser.json   (normalization)"
echo "║  ├── xgboost_model.ubj   (Python model)"
echo "║  └── training_report.txt (metrics)"
echo "╚══════════════════════════════════════════════════╝"
