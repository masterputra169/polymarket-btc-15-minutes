@echo off
setlocal enabledelayedexpansion

REM --- BTC Prediction ML Training Pipeline v8 ---

set DAYS=540
set TUNE=
set DEPLOY=false
set EPOCHS=1200
set TUNE_TRIALS=150
set MIN_MOVE=0.0005
set PROXY=

:parse_args
if "%~1"=="" goto done_args
if "%~1"=="--days" ( set DAYS=%~2& shift& shift& goto parse_args )
if "%~1"=="--tune" ( set TUNE=--tune& shift& goto parse_args )
if "%~1"=="--tune-trials" ( set TUNE_TRIALS=%~2& shift& shift& goto parse_args )
if "%~1"=="--epochs" ( set EPOCHS=%~2& shift& shift& goto parse_args )
if "%~1"=="--min-move" ( set MIN_MOVE=%~2& shift& shift& goto parse_args )
if "%~1"=="--deploy" ( set DEPLOY=true& shift& goto parse_args )
if "%~1"=="--proxy" ( set PROXY=%~2& shift& shift& goto parse_args )
if "%~1"=="--help" (
    echo Usage: runTraining.bat [OPTIONS]
    echo.
    echo   --days N          Days of historical data [default: 540]
    echo   --tune            Run Optuna tuning [150 trials]
    echo   --tune-trials N   Number of tuning trials [default: 150]
    echo   --epochs N        Max training rounds [default: 1200]
    echo   --min-move F      Min price move fraction to keep sample [default: 0.0005]
    echo   --deploy          Auto-copy model to public/ml/
    echo   --proxy URL       Binance API proxy URL
    exit /b 0
)
echo Unknown arg: %~1
exit /b 1
:done_args

echo.
echo ================================================
echo   BTC ML Training Pipeline v8
echo ================================================
echo   Days: %DAYS% -- Epochs: %EPOCHS% -- Tune: %TUNE%
echo   Trials: %TUNE_TRIALS% -- Min-move: %MIN_MOVE%
if defined PROXY echo   Proxy: %PROXY%
echo ================================================
echo.

REM --- Check dependencies ---
echo [1/4] Checking dependencies...

where node >nul 2>&1 || ( echo ERROR: Node.js not found & exit /b 1 )
for /f "tokens=*" %%i in ('node --version') do echo   Node: %%i

where python >nul 2>&1 || ( echo ERROR: Python not found & exit /b 1 )
for /f "tokens=*" %%i in ('python --version') do echo   Python: %%i

python -c "import xgboost" 2>nul || ( echo ERROR: pip install xgboost & exit /b 1 )
python -c "import pandas" 2>nul || ( echo ERROR: pip install pandas & exit /b 1 )
python -c "import sklearn" 2>nul || ( echo ERROR: pip install scikit-learn & exit /b 1 )

if defined TUNE (
    python -c "import optuna" 2>nul
    if errorlevel 1 (
        echo WARNING: optuna not installed. Continuing without tuning...
        set TUNE=
    )
)
echo   OK - All dependencies found
echo.

set SCRIPT_DIR=%~dp0
set DATA_FILE=%SCRIPT_DIR%training_data.csv
set OUTPUT_DIR=%SCRIPT_DIR%output

set PROXY_ARG=
if defined PROXY set PROXY_ARG=--proxy %PROXY%

REM --- Step 1: Generate training data ---
echo ================================================
echo   STEP 1/3: Generate Training Data
echo ================================================
echo.

node "%SCRIPT_DIR%generateTrainingData.mjs" --days %DAYS% --min-move %MIN_MOVE% --output "%DATA_FILE%" %PROXY_ARG%

if not exist "%DATA_FILE%" (
    echo ERROR: Training data generation failed
    echo   Try: runTraining.bat --days %DAYS% --proxy http://localhost:3456
    exit /b 1
)

set ROWCOUNT=0
for /f "usebackq" %%a in (`type "%DATA_FILE%" ^| find /c /v ""`) do set ROWCOUNT=%%a
set /a SAMPLES=ROWCOUNT-1
echo   Generated %SAMPLES% samples
echo.

REM --- Step 2: Train XGBoost v8 ---
echo ================================================
echo   STEP 2/3: Train XGBoost v8
echo ================================================
echo.

if not exist "%OUTPUT_DIR%" mkdir "%OUTPUT_DIR%"

python "%SCRIPT_DIR%trainXGBoost_v3.py" --input "%DATA_FILE%" --output-dir "%OUTPUT_DIR%" --epochs %EPOCHS% --tune-trials %TUNE_TRIALS% %TUNE%

if errorlevel 1 (
    echo ERROR: Training failed
    exit /b 1
)

REM --- Step 3: Deploy ---
if "%DEPLOY%"=="true" (
    echo.
    echo ================================================
    echo   STEP 3/3: Deploy to public/ml/
    echo ================================================
    echo.

    set "PUBLIC_ML="
    if exist "%SCRIPT_DIR%..\public\ml" set "PUBLIC_ML=%SCRIPT_DIR%..\public\ml"
    if exist "%SCRIPT_DIR%..\..\public\ml" set "PUBLIC_ML=%SCRIPT_DIR%..\..\public\ml"
    if exist "%SCRIPT_DIR%..\..\..\public\ml" set "PUBLIC_ML=%SCRIPT_DIR%..\..\..\public\ml"

    if not defined PUBLIC_ML (
        echo   public\ml\ not found. Creating at ..\..\public\ml\
        mkdir "%SCRIPT_DIR%..\..\public\ml" 2>nul
        set "PUBLIC_ML=%SCRIPT_DIR%..\..\public\ml"
    )

    copy /Y "%OUTPUT_DIR%\xgboost_model.json" "!PUBLIC_ML!\xgboost_model.json" >nul
    copy /Y "%OUTPUT_DIR%\norm_browser.json" "!PUBLIC_ML!\norm_browser.json" >nul
    echo   Deployed to !PUBLIC_ML!\
    echo     - xgboost_model.json
    echo     - norm_browser.json
) else (
    echo.
    echo   To deploy manually:
    echo     copy "%OUTPUT_DIR%\xgboost_model.json" public\ml\
    echo     copy "%OUTPUT_DIR%\norm_browser.json"  public\ml\
)

echo.
echo ================================================
echo   Pipeline v8 Complete!
echo ================================================

endlocal