import React, { useMemo, memo } from 'react';
import { useBotData } from './hooks/useBotData.js';
import { useCountdown } from './hooks/useCountdown.js';
import CurrentPriceCard from './components/CurrentPriceCard.jsx';
import TAIndicators from './components/TAIndicators.jsx';
import PredictPanel from './components/PredictPanel.jsx';
import PolymarketPanel from './components/PolymarketPanel.jsx';
import EdgePanel from './components/EdgePanel.jsx';
import MLPanel from './components/MlPanel.jsx';
import AccuracyPanel from './components/AccuracyPanel.jsx';
import BetSizingPanel from './components/BetSizingPanel.jsx';
import BotPanel from './components/BotPanel.jsx';
import SessionInfo from './components/SessionInfo.jsx';

// ═══ React.memo: StatusDot only re-renders when connected/label changes ═══
const StatusDot = memo(function StatusDot({ connected, label }) {
  const cls = connected ? '' : 'status-dot--error';
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
      <span className={`status-dot ${cls}`} style={{ width: 5, height: 5 }} />
      <span>{label}</span>
    </span>
  );
});

export default function App() {
  // ═══ Single data source: bot via WebSocket ═══
  const { data, loading, error, setBankroll, botConnected, binancePrice, binancePrevPrice } = useBotData();

  // Smooth 1-second countdown (local timer, no network)
  const smoothTimeLeft = useCountdown(data?.settlementMs ?? null);

  // Chainlink price: bot resolves priority (Polymarket WS > Chainlink WSS > RPC)
  const chainlinkResolved = useMemo(() => {
    if (data?.chainlinkRpc?.price != null) {
      return {
        price: data.chainlinkRpc.price,
        prevPrice: null,
        connected: true,
        source: data.chainlinkRpc.source ?? 'Chainlink RPC',
      };
    }
    return { price: null, prevPrice: null, connected: false, source: 'None' };
  }, [data?.chainlinkRpc?.price, data?.chainlinkRpc?.source]);

  const chainlinkConnected = data?.chainlinkRpc?.price != null;

  // ═══════════════════════════════════════════════════════════════
  // useMemo DATA SLICING — stable references for child components
  // Each child only re-renders when ITS specific data changes
  // ═══════════════════════════════════════════════════════════════

  // Header status deps
  const mlStatus = data?.ml?.status;

  // CurrentPriceCard: binance + chainlink + timer
  const priceCardProps = useMemo(() => ({
    chainlinkPrice: chainlinkResolved.price,
    chainlinkPrevPrice: chainlinkResolved.prevPrice,
    chainlinkConnected,
    chainlinkSource: chainlinkResolved.source,
    binancePrice: binancePrice ?? data?.lastPrice,
    binancePrevPrice,
    binanceConnected: data?.binanceConnected ?? false,
    timeLeftMin: smoothTimeLeft ?? data?.timeLeftMin,
    priceToBeat: data?.priceToBeat,
  }), [
    chainlinkResolved.price, chainlinkResolved.prevPrice,
    chainlinkConnected, chainlinkResolved.source,
    binancePrice, binancePrevPrice, data?.binanceConnected,
    data?.lastPrice, smoothTimeLeft, data?.timeLeftMin, data?.priceToBeat,
  ]);

  // PredictPanel: probability, recommendation, score
  const predictData = useMemo(() => {
    if (!data) return null;
    return {
      pLong: data.pLong,
      pShort: data.pShort,
      rawUp: data.rawUp,
      rawDown: data.rawDown,
      rec: data.rec,
      edge: data.edge,
      timeDecay: data.timeDecay,
      scoreBreakdown: data.scoreBreakdown,
      regimeInfo: data.regimeInfo,
      feedbackStats: data.feedbackStats,
      haNarrative: data.haNarrative,
      rsiNarrative: data.rsiNarrative,
      macdNarrative: data.macdNarrative,
      vwapNarrative: data.vwapNarrative,
      timing: data.timing,
      consec: data.consec,
      ml: data.ml,
    };
  }, [
    data?.pLong, data?.pShort, data?.rawUp, data?.rawDown,
    data?.rec, data?.edge, data?.timeDecay,
    data?.scoreBreakdown, data?.regimeInfo, data?.feedbackStats,
    data?.haNarrative, data?.rsiNarrative, data?.macdNarrative, data?.vwapNarrative,
    data?.timing, data?.consec, data?.ml?.confidence,
  ]);

  // TAIndicators: RSI, MACD, VWAP, HA, BB, ATR, EMA, VolDelta, StochRSI, Funding, Hidden
  const taData = useMemo(() => {
    if (!data) return null;
    return {
      rsiNow: data.rsiNow,
      rsiSlope: data.rsiSlope,
      rsiNarrative: data.rsiNarrative,
      macd: data.macd,
      macdLabel: data.macdLabel,
      macdNarrative: data.macdNarrative,
      vwapNow: data.vwapNow,
      vwapDist: data.vwapDist,
      vwapSlope: data.vwapSlope,
      vwapSlopeLabel: data.vwapSlopeLabel,
      vwapNarrative: data.vwapNarrative,
      consec: data.consec,
      haNarrative: data.haNarrative,
      delta1m: data.delta1m,
      delta3m: data.delta3m,
      lastClose: data.lastClose,
      realizedVol: data.realizedVol,
      volProfile: data.volProfile,
      multiTfConfirm: data.multiTfConfirm,
      regimeInfo: data.regimeInfo,
      bb: data.bb,
      atr: data.atr,
      volDelta: data.volDelta,
      emaCross: data.emaCross,
      stochRsi: data.stochRsi,
      fundingRate: data.fundingRate,
      volumeRatio: data.volumeRatio,
      vwapCrossCount: data.vwapCrossCount,
      failedVwapReclaim: data.failedVwapReclaim,
    };
  }, [
    data?.rsiNow, data?.rsiSlope, data?.rsiNarrative,
    data?.macd, data?.macdLabel, data?.macdNarrative,
    data?.vwapNow, data?.vwapDist, data?.vwapSlope, data?.vwapSlopeLabel, data?.vwapNarrative,
    data?.consec, data?.haNarrative,
    data?.delta1m, data?.delta3m, data?.lastClose,
    data?.realizedVol, data?.volProfile, data?.multiTfConfirm, data?.regimeInfo,
    data?.bb?.width, data?.bb?.percentB, data?.bb?.squeeze,
    data?.atr?.atr, data?.atr?.atrRatio,
    data?.volDelta?.buyRatio, data?.volDelta?.netDeltaPct,
    data?.emaCross?.distancePct, data?.emaCross?.cross,
    data?.stochRsi?.k, data?.stochRsi?.d,
    data?.fundingRate?.ratePct,
    data?.volumeRatio, data?.vwapCrossCount, data?.failedVwapReclaim,
  ]);

  // PolymarketPanel: market prices, orderbook, CLOB
  const polyData = useMemo(() => {
    if (!data) return null;
    return {
      poly: data.poly,
      marketUp: data.marketUp,
      marketDown: data.marketDown,
      marketSlug: data.marketSlug,
      liquidity: data.liquidity,
      orderbookUp: data.orderbookUp,
      orderbookDown: data.orderbookDown,
      orderbookSignal: data.orderbookSignal,
      clobSource: data.clobSource,
      clobWsConnected: data.clobWsConnected,
      priceToBeat: data.priceToBeat,
      marketQuestion: data.marketQuestion,
      settlementLeftMin: smoothTimeLeft ?? data.settlementLeftMin,
    };
  }, [
    data?.poly?.ok, data?.poly?.reason, data?.poly?.market?.question, data?.poly?.market?.slug,
    data?.marketUp, data?.marketDown, data?.marketSlug, data?.liquidity,
    data?.orderbookUp, data?.orderbookDown, data?.orderbookSignal,
    data?.clobSource, data?.clobWsConnected,
    data?.priceToBeat, data?.marketQuestion, smoothTimeLeft, data?.settlementLeftMin,
  ]);

  // EdgePanel: edge, recommendation, ML confidence, arbitrage
  const edgeData = useMemo(() => {
    if (!data) return null;
    return {
      edge: data.edge,
      rec: data.rec,
      pLong: data.pLong,
      pShort: data.pShort,
      ruleUp: data.ruleUp,
      marketUp: data.marketUp,
      marketDown: data.marketDown,
      timeLeftMin: data.timeLeftMin,
      feedbackStats: data.feedbackStats,
      ml: data.ml,
      regimeInfo: data.regimeInfo,
      arbitrage: data.arbitrage,
    };
  }, [
    data?.edge, data?.rec, data?.pLong, data?.pShort, data?.ruleUp,
    data?.marketUp, data?.marketDown, data?.timeLeftMin, data?.feedbackStats,
    data?.ml?.confidence, data?.regimeInfo, data?.arbitrage,
  ]);

  // MLPanel: ML-specific + rule prob
  const mlData = useMemo(() => {
    if (!data) return null;
    return {
      ml: data.ml,
      pLong: data.pLong,
      pShort: data.pShort,
      rawUp: data.rawUp,
      ruleUp: data.ruleUp,
    };
  }, [data?.ml, data?.pLong, data?.pShort, data?.rawUp, data?.ruleUp]);

  // AccuracyPanel: feedback + detailed stats
  const accuracyData = useMemo(() => {
    if (!data) return null;
    return {
      feedbackStats: data.feedbackStats,
      detailedFeedback: data.detailedFeedback,
    };
  }, [data?.feedbackStats, data?.detailedFeedback?.totalSettled]);

  // BetSizingPanel: bet sizing output
  const betSizingData = useMemo(() => {
    if (!data) return null;
    return { betSizing: data.betSizing, rec: data.rec, regimeInfo: data.regimeInfo };
  }, [data?.betSizing?.betPercent, data?.betSizing?.shouldBet, data?.betSizing?.riskLevel, data?.betSizing?.bankroll]);

  return (
    <div className="app-container">
      {/* Header */}
      <header className="app-header">
        <div className="app-header__title">
          <span className="btc-icon">₿</span>
          Polymarket BTC 15m Assistant
        </div>
        <div className="app-header__status">
          <StatusDot connected={data?.binanceConnected ?? false} label="Binance" />
          <span style={{ color: 'var(--text-dim)' }}>|</span>
          <StatusDot connected={chainlinkConnected} label={`Chainlink (${chainlinkResolved.source})`} />
          <span style={{ color: 'var(--text-dim)' }}>|</span>
          <StatusDot connected={data?.clobWsConnected ?? false} label={`CLOB ${data?.clobWsConnected ? 'WS' : 'REST'}`} />
          <span style={{ color: 'var(--text-dim)' }}>|</span>
          <StatusDot connected={mlStatus === 'ready'} label="ML" />
          <span style={{ color: 'var(--text-dim)' }}>|</span>
          <StatusDot connected={botConnected} label="Bot" />
        </div>
      </header>

      {/* Bot disconnected warning */}
      {!botConnected && data && (
        <div className="connection-banner connection-banner--warning">
          Bot disconnected — showing last received data
        </div>
      )}

      {/* Loading */}
      {loading && !data && (
        <div className="loading-screen">
          <div className="loading-screen__spinner" />
          <div className="loading-screen__text">
            {botConnected ? 'Receiving data...' : 'Waiting for bot...'}
          </div>
        </div>
      )}

      {/* Dashboard Grid */}
      {data && (
        <div className="dashboard-grid">
          {/* Row 0: Bot Status (full width) */}
          <BotPanel connected={botConnected} data={data} />

          {/* Row 1: Price + Timer (full width) */}
          <CurrentPriceCard {...priceCardProps} />

          {/* Row 2: Prediction + TA */}
          <PredictPanel data={predictData} />
          <TAIndicators data={taData} />

          {/* Row 3: Polymarket + Edge */}
          <PolymarketPanel data={polyData} clobWsConnected={data?.clobWsConnected ?? false} />
          <EdgePanel data={edgeData} />

          {/* Row 4: ML Engine (full width) */}
          <MLPanel data={mlData} />

          {/* Row 5: Bet Sizing (full width) */}
          <BetSizingPanel data={betSizingData} setBankroll={setBankroll} />

          {/* Row 6: Accuracy Dashboard (full width) */}
          <AccuracyPanel data={accuracyData} />

          {/* Row 7: Session (full width) */}
          <SessionInfo />
        </div>
      )}

      {/* Footer */}
      <footer className="app-footer">
        Not financial advice. Use at your own risk. — created by @krajekis
      </footer>
    </div>
  );
}
