/**
 * Bot configuration.
 * Imports shared CONFIG from frontend and overrides proxy URLs with direct API URLs.
 */

import { CONFIG as SHARED_CONFIG, BET_SIZING, WS_DEFAULTS, WS_POLYMARKET_LIVE, WS_CHAINLINK } from '../../src/config.js';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Override proxy paths with direct API URLs
const CONFIG = {
  ...SHARED_CONFIG,
  binanceBaseUrl: 'https://data-api.binance.vision',
  gammaBaseUrl: 'https://gamma-api.polymarket.com',
  clobBaseUrl: 'https://clob.polymarket.com',
  pollIntervalMs: parseInt(process.env.POLL_INTERVAL_MS || '5000', 10),
};

const BOT_CONFIG = {
  dryRun: process.env.DRY_RUN !== 'false',
  bankroll: parseFloat(process.env.BANKROLL || '100'),
  maxDailyLossPct: parseFloat(process.env.MAX_DAILY_LOSS_PCT || '20'),
  maxConsecutiveLosses: parseInt(process.env.MAX_CONSECUTIVE_LOSSES || '5', 10),
  logLevel: process.env.LOG_LEVEL || 'info',

  // File paths for persistence
  dataDir: resolve(__dirname, '..', 'data'),
  tradesFile: resolve(__dirname, '..', 'data', 'trades.json'),
  feedbackFile: resolve(__dirname, '..', 'data', 'feedback.json'),
  stateFile: resolve(__dirname, '..', 'data', 'state.json'),

  // ML model paths (read from frontend public/)
  modelPath: resolve(__dirname, '..', '..', 'public', 'ml', 'xgboost_model.json'),
  normPath: resolve(__dirname, '..', '..', 'public', 'ml', 'norm_browser.json'),
};

export { CONFIG, BET_SIZING, BOT_CONFIG, WS_DEFAULTS, WS_POLYMARKET_LIVE, WS_CHAINLINK };
