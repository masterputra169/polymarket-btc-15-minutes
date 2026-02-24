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
  let totalVoters = 0;  // H5 multi-TF fix: track how many data points actually voted
  let tf1mSignal = 'NEUTRAL';
  let tf5mSignal = 'NEUTRAL';

  // ═══ 1m timeframe direction ═══
  // Use delta1m + delta3m combined
  if (delta1m !== null && delta3m !== null) {
    totalVoters++;
    if (delta1m > 0 && delta3m > 0) { upVotes++; tf1mSignal = 'UP'; }
    else if (delta1m < 0 && delta3m < 0) { downVotes++; tf1mSignal = 'DOWN'; }
  } else if (delta1m !== null) {
    totalVoters++;
    if (delta1m > 0) { upVotes++; tf1mSignal = 'UP'; }
    else if (delta1m < 0) { downVotes++; tf1mSignal = 'DOWN'; }
  }
  // FIX: If delta1m is null, this timeframe ABSTAINS (does not vote at all).
  // Previously it would still count as a member, causing missing data to look like disagreement.

  // ═══ 5m timeframe direction ═══
  // FIX: Only vote if 5m data actually exists. Missing = abstain (NEUTRAL), not contradict.
  if (delta5m !== null) {
    totalVoters++;
    if (delta5m > 0) { upVotes++; tf5mSignal = 'UP'; }
    else if (delta5m < 0) { downVotes++; tf5mSignal = 'DOWN'; }
  }

  // Heiken Ashi cross-TF check
  // FIX: Only count when BOTH timeframes have data. Missing data = abstain.
  if (ha1mColor && ha5mColor) {
    totalVoters++;
    const c1 = ha1mColor.toLowerCase();
    const c5 = ha5mColor.toLowerCase();
    if (c1 === 'green' && c5 === 'green') upVotes++;
    else if (c1 === 'red' && c5 === 'red') downVotes++;
    // If colors differ, this voter is counted but neither side gets a vote (genuine disagreement)
  }
  // FIX: If either HA color is missing, don't count this as a voter at all

  // RSI cross-TF check
  // FIX: Only count when BOTH timeframes have data. Missing data = abstain.
  if (rsi1m !== null && rsi5m !== null) {
    totalVoters++;
    if (rsi1m > 55 && rsi5m > 55) upVotes++;
    else if (rsi1m < 45 && rsi5m < 45) downVotes++;
  }

  // M6: Track whether we actually have 5m data — if not, agreement is vacuous
  const has5mData = delta5m !== null || ha5mColor !== null || rsi5m !== null;

  // Determine result
  // FIX: Use totalVoters (data that actually exists) not upVotes+downVotes
  if (totalVoters === 0) {
    return { signal: 'NEUTRAL', agreement: false, detail: 'No TF data', confidence: 0.5 };
  }

  const total = upVotes + downVotes;
  const signal = upVotes > downVotes ? 'UP' : upVotes < downVotes ? 'DOWN' : 'NEUTRAL';
  // M4: Agreement requires BOTH timeframes to have a directional signal that matches.
  // 5m NEUTRAL (delta5m ~ 0) is NOT confirmation — it means 5m has no opinion.
  const agreement = has5mData && tf1mSignal !== 'NEUTRAL' && tf5mSignal !== 'NEUTRAL' && tf1mSignal === tf5mSignal;
  const confidence = totalVoters > 0 ? Math.max(upVotes, downVotes) / totalVoters : 0.5;

  const detail = !has5mData
    ? `1m ${tf1mSignal} (no 5m data)`
    : agreement
      ? `1m ${tf1mSignal} ✓ 5m ${tf5mSignal} (${upVotes}U/${downVotes}D)`
      : `1m ${tf1mSignal} ✗ 5m ${tf5mSignal} (${upVotes}U/${downVotes}D)`;

  return { signal, agreement, detail, confidence };
}