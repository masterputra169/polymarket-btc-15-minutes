import React, { memo } from 'react';
import { formatNumber, formatSignedDelta, narrativeFromSign } from '../utils.js';
import SignalRow from './ta/SignalRow.jsx';
import BollingerRow from './ta/BollingerRow.jsx';
import AtrRow from './ta/AtrRow.jsx';
import VolumeDeltaRow from './ta/VolumeDeltaRow.jsx';
import EmaCrossRow from './ta/EmaCrossRow.jsx';
import StochRsiRow from './ta/StochRsiRow.jsx';
import FundingRateRow from './ta/FundingRateRow.jsx';
import HiddenFeatures from './ta/HiddenFeatures.jsx';

function TAIndicators({ data }) {
  if (!data) return null;

  const {
    consec, haNarrative, rsiNow, rsiSlope, rsiNarrative,
    macdLabel, macdNarrative, delta1m, delta3m, lastClose,
    vwapNow, vwapDist, vwapSlopeLabel, vwapNarrative,
    bb, atr, volDelta, emaCross, stochRsi, fundingRate,
  } = data;

  const heikenValue = `${consec?.color ?? '-'} x${consec?.count ?? 0}`;
  const rsiArrow = rsiSlope !== null && rsiSlope < 0 ? '\u2193' : rsiSlope !== null && rsiSlope > 0 ? '\u2191' : '-';
  const rsiValue = `${formatNumber(rsiNow, 1)} ${rsiArrow}`;
  const d1 = formatSignedDelta(delta1m, lastClose);
  const d3 = formatSignedDelta(delta3m, lastClose);
  const vwapValue = `${formatNumber(vwapNow, 0)} (${vwapDist !== null ? (vwapDist * 100).toFixed(2) + '%' : '-'}) | slope: ${vwapSlopeLabel}`;

  return (
    <div className="card" style={{ animationDelay: '0.1s' }}>
      <div className="card__header">
        <span className="card__title">\uD83D\uDCCA TA Indicators</span>
        <span className="card__badge badge--live">LIVE</span>
      </div>

      <SignalRow name="Heiken Ashi" value={heikenValue} narrative={haNarrative} />
      <SignalRow name="RSI" value={rsiValue} narrative={rsiNarrative} />
      <SignalRow name="MACD" value={macdLabel} narrative={macdNarrative} />
      <BollingerRow bb={bb} />
      <AtrRow atr={atr} />
      <EmaCrossRow emaCross={emaCross} />
      <VolumeDeltaRow volDelta={volDelta} />
      <StochRsiRow stochRsi={stochRsi} />
      <FundingRateRow fundingRate={fundingRate} />
      <SignalRow name="Delta 1min" value={d1} narrative={narrativeFromSign(delta1m)} />
      <SignalRow name="Delta 3min" value={d3} narrative={narrativeFromSign(delta3m)} />
      <SignalRow name="VWAP" value={vwapValue} narrative={vwapNarrative} />
      <HiddenFeatures data={data} />
    </div>
  );
}

export default memo(TAIndicators, (prev, next) => {
  const a = prev.data;
  const b = next.data;
  if (!a || !b) return a === b;
  return (
    a.consec?.color === b.consec?.color &&
    a.consec?.count === b.consec?.count &&
    a.haNarrative === b.haNarrative &&
    a.rsiNow === b.rsiNow &&
    a.rsiSlope === b.rsiSlope &&
    a.rsiNarrative === b.rsiNarrative &&
    a.macdLabel === b.macdLabel &&
    a.macdNarrative === b.macdNarrative &&
    a.delta1m === b.delta1m &&
    a.delta3m === b.delta3m &&
    a.lastClose === b.lastClose &&
    a.vwapNow === b.vwapNow &&
    a.vwapDist === b.vwapDist &&
    a.vwapSlopeLabel === b.vwapSlopeLabel &&
    a.vwapNarrative === b.vwapNarrative &&
    a.bb?.width === b.bb?.width &&
    a.bb?.percentB === b.bb?.percentB &&
    a.bb?.squeeze === b.bb?.squeeze &&
    a.atr?.atr === b.atr?.atr &&
    a.atr?.atrRatio === b.atr?.atrRatio &&
    a.volDelta?.buyRatio === b.volDelta?.buyRatio &&
    a.volDelta?.netDeltaPct === b.volDelta?.netDeltaPct &&
    a.emaCross?.distancePct === b.emaCross?.distancePct &&
    a.emaCross?.cross === b.emaCross?.cross &&
    a.stochRsi?.k === b.stochRsi?.k &&
    a.stochRsi?.d === b.stochRsi?.d &&
    a.fundingRate?.ratePct === b.fundingRate?.ratePct &&
    a.volumeRatio === b.volumeRatio &&
    a.vwapCrossCount === b.vwapCrossCount &&
    a.failedVwapReclaim === b.failedVwapReclaim &&
    a.regimeInfo?.regime === b.regimeInfo?.regime &&
    a.multiTfConfirm?.agreement === b.multiTfConfirm?.agreement
  );
});
