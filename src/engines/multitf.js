/**
 * ═══ Multi-Timeframe Confirmation Engine ═══
 *
 * Compares 1-minute and 5-minute candle signals.
 * When both timeframes agree, the signal is more reliable.
 * When they disagree, confidence should be reduced.
 *
 * 5m candles are slower but filter out noise from 1m candles.
 * This acts as a "reality check" on the 1m-based indicators.
 */

/**
 * Compute multi-timeframe confirmation.
 *
 * @param {Object} params
 * @param {number|null} params.delta1m - 1-min price delta
 * @param {number|null} params.delta3m - 3-min price delta
 * @param {number|null} params.delta5m - 5-min price delta (from 5m candle)
 * @param {string|null} params.ha1mColor - Heiken Ashi color on 1m ('green'/'red')
 * @param {string|null} params.ha5mColor - Heiken Ashi color on 5m ('green'/'red')
 * @param {number|null} params.rsi1m - RSI on 1m candles
 * @param {number|null} params.rsi5m - RSI on 5m candles
 * @returns {{ signal: string, agreement: boolean, detail: string, confidence: number }}
 */
export function computeMultiTfConfirmation({
  delta1m = null,
  delta3m = null,
  delta5m = null,
  ha1mColor = null,
  ha5mColor = null,
  rsi1m = null,
  rsi5m = null,
}) {
  let upVotes = 0;
  let downVotes = 0;
  let tf1mSignal = 'NEUTRAL';
  let tf5mSignal = 'NEUTRAL';

  // ═══ 1m timeframe direction ═══
  // Use delta1m + delta3m combined
  if (delta1m !== null && delta3m !== null) {
    if (delta1m > 0 && delta3m > 0) { upVotes++; tf1mSignal = 'UP'; }
    else if (delta1m < 0 && delta3m < 0) { downVotes++; tf1mSignal = 'DOWN'; }
  } else if (delta1m !== null) {
    if (delta1m > 0) { upVotes++; tf1mSignal = 'UP'; }
    else if (delta1m < 0) { downVotes++; tf1mSignal = 'DOWN'; }
  }

  // ═══ 5m timeframe direction ═══
  if (delta5m !== null) {
    if (delta5m > 0) { upVotes++; tf5mSignal = 'UP'; }
    else if (delta5m < 0) { downVotes++; tf5mSignal = 'DOWN'; }
  }

  // Heiken Ashi cross-TF check
  if (ha1mColor && ha5mColor) {
    const c1 = ha1mColor.toLowerCase();
    const c5 = ha5mColor.toLowerCase();
    if (c1 === 'green' && c5 === 'green') upVotes++;
    else if (c1 === 'red' && c5 === 'red') downVotes++;
  }

  // RSI cross-TF check
  if (rsi1m !== null && rsi5m !== null) {
    if (rsi1m > 55 && rsi5m > 55) upVotes++;
    else if (rsi1m < 45 && rsi5m < 45) downVotes++;
  }

  // Determine result
  const total = upVotes + downVotes;
  if (total === 0) {
    return { signal: 'NEUTRAL', agreement: false, detail: 'No TF data', confidence: 0.5 };
  }

  const signal = upVotes > downVotes ? 'UP' : upVotes < downVotes ? 'DOWN' : 'NEUTRAL';
  // Soft agreement: 1m has direction AND 5m doesn't contradict (neutral 5m = no objection)
  const agreement = tf1mSignal !== 'NEUTRAL' && (tf5mSignal === 'NEUTRAL' || tf1mSignal === tf5mSignal);
  const confidence = Math.max(upVotes, downVotes) / total;

  const detail = agreement
    ? `1m ${tf1mSignal} ✓ 5m ${tf5mSignal} (${upVotes}U/${downVotes}D)`
    : `1m ${tf1mSignal} ✗ 5m ${tf5mSignal} (${upVotes}U/${downVotes}D)`;

  return { signal, agreement, detail, confidence };
}