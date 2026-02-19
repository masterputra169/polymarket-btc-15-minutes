/**
 * Live Polymarket data logger — IndexedDB-backed.
 *
 * Captures real Polymarket features + BTC price + indicators every 30s
 * for future ML training with real (not simulated) Polymarket data.
 *
 * Dev console:
 *   window.__getLogCount()          → number of stored rows
 *   window.__exportTrainingCSV()    → download CSV
 *   window.__clearTrainingLog()     → purge all data
 */

const DB_NAME = 'polymarket_training_log';
const STORE_NAME = 'snapshots';
const DB_VERSION = 1;
const LOG_INTERVAL_MS = 30_000; // log once per 30s
const ROTATE_INTERVAL_MS = 3_600_000; // check rotation every 1h
const ROTATE_MAX_AGE_MS = 7 * 24 * 3_600_000; // keep 7 days

let db = null;
let lastLogMs = 0;
let lastRotateMs = 0;

// ═══ IndexedDB setup ═══

export function initLoggerDB() {
  return new Promise((resolve) => {
    try {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = (e) => {
        const d = e.target.result;
        if (!d.objectStoreNames.contains(STORE_NAME)) {
          const store = d.createObjectStore(STORE_NAME, { keyPath: 'id', autoIncrement: true });
          store.createIndex('timestamp', 'timestamp', { unique: false });
        }
      };
      req.onsuccess = (e) => {
        db = e.target.result;
        console.log('[PolyLogger] IndexedDB ready');
        resolve(true);
      };
      req.onerror = () => {
        console.warn('[PolyLogger] IndexedDB failed to open');
        resolve(false);
      };
    } catch {
      resolve(false);
    }
  });
}

// ═══ Throttle gate — caller checks BEFORE allocating snapshot object ═══

export function shouldLog() {
  return db !== null && (Date.now() - lastLogMs >= LOG_INTERVAL_MS);
}

// ═══ Auto-rotation: delete rows older than 7 days (runs at most once/hour) ═══

function maybeRotate() {
  if (!db) return;
  const now = Date.now();
  if (now - lastRotateMs < ROTATE_INTERVAL_MS) return;
  lastRotateMs = now;
  try {
    const cutoff = now - ROTATE_MAX_AGE_MS;
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const idx = tx.objectStore(STORE_NAME).index('timestamp');
    const range = IDBKeyRange.upperBound(cutoff);
    const req = idx.openCursor(range);
    let deleted = 0;
    req.onsuccess = (e) => {
      const cursor = e.target.result;
      if (cursor) {
        cursor.delete();
        deleted++;
        cursor.continue();
      } else if (deleted > 0) {
        console.log(`[PolyLogger] Rotated ${deleted} rows older than 7d`);
      }
    };
  } catch { /* ignore rotation errors */ }
}

// ═══ Log a snapshot (only call after shouldLog() returns true) ═══

let _logCount = 0; // session counter, no console spam

export function logSnapshot(row) {
  if (!db) return;
  lastLogMs = Date.now();
  try {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).add(row);
    _logCount++;
    // Log only every 100 snapshots (~50 min) to avoid console memory accumulation
    if (_logCount % 100 === 1) {
      console.log(`[PolyLogger] ${_logCount} snapshots logged this session`);
    }
  } catch (err) {
    if (err?.name === 'QuotaExceededError') {
      console.warn('[PolyLogger] IndexedDB quota exceeded — logging paused. Export and clear data.');
      db = null; // stop further attempts
    }
  }
  maybeRotate();
}

// ═══ Utilities ═══

export async function getLogCount() {
  if (!db) return 0;
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const req = tx.objectStore(STORE_NAME).count();
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(0);
    } catch { resolve(0); }
  });
}

export async function clearLog() {
  if (!db) return;
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      tx.objectStore(STORE_NAME).clear();
      tx.oncomplete = () => { console.log('[PolyLogger] Log cleared'); resolve(); };
      tx.onerror = () => resolve();
    } catch { resolve(); }
  });
}

// ═══ Export to CSV ═══

export async function exportToCSV() {
  if (!db) { console.warn('[PolyLogger] DB not initialized'); return; }

  const rows = await new Promise((resolve) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const req = tx.objectStore(STORE_NAME).index('timestamp').getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => resolve([]);
  });

  if (rows.length === 0) {
    console.log('[PolyLogger] No data to export');
    return;
  }

  rows.sort((a, b) => a.timestamp - b.timestamp);

  // Compute labels: for each row, find the BTC price ~15 min later
  const labeled = [];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const targetTime = row.timestamp + 15 * 60 * 1000;

    let futurePrice = null;
    for (let j = i + 1; j < rows.length; j++) {
      if (rows[j].timestamp >= targetTime) {
        futurePrice = rows[j].btcPrice;
        break;
      }
    }

    if (futurePrice === null) continue;

    const ptb = row.priceToBeat ?? row.btcPrice;
    const label = futurePrice > ptb ? 1 : 0;
    const moveAbs = Math.abs(futurePrice - ptb) / ptb;
    if (moveAbs < 0.0008) continue; // 0.08% min-move filter

    labeled.push({ ...row, label, futurePrice });
  }

  if (labeled.length === 0) {
    console.log('[PolyLogger] No labeled rows (need >15 min of data for labels)');
    return;
  }

  const header = [
    'timestamp', 'btcPrice', 'priceToBeat', 'marketSlug', 'futurePrice',
    'marketUp', 'marketDown', 'marketPriceMomentum', 'orderbookImbalance', 'spreadPct',
    'rsi', 'rsiSlope', 'macdHist', 'macdLine',
    'vwapNow', 'vwapSlope', 'haColor', 'haCount',
    'delta1m', 'delta3m', 'volumeRecent', 'volumeAvg',
    'regime', 'regimeConfidence', 'timeLeftMin',
    'bbWidth', 'bbPercentB', 'bbSqueeze', 'bbSqueezeIntensity',
    'atrPct', 'atrRatio',
    'volDeltaBuyRatio', 'volDeltaAccel',
    'emaDistPct', 'emaCrossSignal',
    'stochK', 'stochKD',
    'vwapCrossCount', 'multiTfAgreement', 'failedVwapReclaim',
    'fundingRate',
    'momentum5CandleSlope', 'volatilityChangeRatio', 'priceConsistency',
    'label',
  ].join(',');

  const csvRows = labeled.map(r => [
    r.timestamp, r.btcPrice, r.priceToBeat ?? '', r.marketSlug, r.futurePrice,
    r.marketUp ?? '', r.marketDown ?? '', r.marketPriceMomentum, r.orderbookImbalance ?? '', r.spreadPct ?? '',
    r.rsi ?? '', r.rsiSlope ?? '', r.macdHist ?? '', r.macdLine ?? '',
    r.vwapNow ?? '', r.vwapSlope ?? '', r.haColor ?? '', r.haCount,
    r.delta1m, r.delta3m, r.volumeRecent, r.volumeAvg,
    r.regime, r.regimeConfidence, r.timeLeftMin ?? '',
    r.bbWidth ?? '', r.bbPercentB ?? '', r.bbSqueeze ? 1 : 0, r.bbSqueezeIntensity,
    r.atrPct ?? '', r.atrRatio ?? '',
    r.volDeltaBuyRatio ?? '', r.volDeltaAccel ?? '',
    r.emaDistPct ?? '', r.emaCrossSignal,
    r.stochK ?? '', r.stochKD ?? '',
    r.vwapCrossCount, r.multiTfAgreement ? 1 : 0, r.failedVwapReclaim ? 1 : 0,
    r.fundingRate ?? '',
    r.momentum5CandleSlope ?? 0, r.volatilityChangeRatio ?? 1, r.priceConsistency ?? 0.5,
    r.label,
  ].join(','));

  const csv = [header, ...csvRows].join('\n');

  const blob = new Blob([csv], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `polymarket_training_${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(url);

  console.log(`[PolyLogger] Exported ${labeled.length} labeled rows (${rows.length} total snapshots)`);
}

// ═══ Expose to dev console ═══

if (typeof window !== 'undefined') {
  window.__getLogCount = async () => {
    const n = await getLogCount();
    console.log(`[PolyLogger] ${n} snapshots stored`);
    return n;
  };
  window.__exportTrainingCSV = exportToCSV;
  window.__clearTrainingLog = clearLog;
}
