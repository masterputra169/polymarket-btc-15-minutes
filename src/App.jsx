import React, { useMemo, memo } from 'react';
import { useBinanceStream } from './hooks/useBinanceStream.js';
import { usePolymarketChainlinkStream } from './hooks/usePolymarketChainlinkStream.js';
import { useChainlinkWssStream } from './hooks/useChainlinkWssStream.js';
import { usePolymarketClobStream } from './hooks/usePolymarketClobStream.js';
import { useMarketData } from './hooks/useMarketData.js';
import { useCountdown } from './hooks/useCountdown.js';
import CurrentPriceCard from './components/CurrentPriceCard.jsx';
import TAIndicators from './components/TAIndicators.jsx';
import PredictPanel from './components/PredictPanel.jsx';
import PolymarketPanel from './components/PolymarketPanel.jsx';
import EdgePanel from './components/EdgePanel.jsx';
import MLPanel from './components/MlPanel.jsx';
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
  // Data sources
  const binance = useBinanceStream();
  const polymarketWs = usePolymarketChainlinkStream();
  const chainlinkWss = useChainlinkWssStream();

  // ═══ Real-time CLOB WebSocket ═══
  const clobWs = usePolymarketClobStream();

  // Pass CLOB WS data to useMarketData so it can use real-time prices
  const { data, loading, error } = useMarketData({ clobWs });

  // Smooth 1-second countdown (instead of 5s poll jumps)
  const smoothTimeLeft = useCountdown(data?.settlementMs ?? null);

  // Chainlink price priority: Polymarket WS > Chainlink WSS > Chainlink HTTP RPC
  const chainlinkResolved = useMemo(() => {
    if (polymarketWs.price !== null) {
      return {
        price: polymarketWs.price,
        prevPrice: polymarketWs.prevPrice,
        connected: polymarketWs.connected,
        source: 'Polymarket WS',
      };
    }
    if (chainlinkWss.price !== null) {
      return {
        price: chainlinkWss.price,
        prevPrice: chainlinkWss.prevPrice,
        connected: chainlinkWss.connected,
        source: 'Chainlink WSS',
      };
    }
    if (data?.chainlinkRpc?.price !== null && data?.chainlinkRpc?.price !== undefined) {
      return {
        price: data.chainlinkRpc.price,
        prevPrice: null,
        connected: true,
        source: 'Chainlink RPC',
      };
    }
    return {
      price: null,
      prevPrice: null,
      connected: false,
      source: 'None',
    };
  }, [polymarketWs, chainlinkWss, data?.chainlinkRpc]);

  const chainlinkConnected =
    polymarketWs.connected || chainlinkWss.connected || (data?.chainlinkRpc?.price != null);

  // ═══════════════════════════════════════════════════════════════
  // useMemo DATA SLICING — stable references for child components
  // Each child only re-renders when ITS specific data changes
  // ═══════════════════════════════════════════════════════════════

  // Header status deps
  const mlStatus = data?.ml?.status;
  const hasError = !!error;

  // CurrentPriceCard: only binance + chainlink + timer
  const priceCardProps = useMemo(() => ({
    chainlinkPrice: chainlinkResolved.price,
    chainlinkPrevPrice: chainlinkResolved.prevPrice,
    chainlinkConnected,
    chainlinkSource: chainlinkResolved.source,
    binancePrice: binance.price ?? data?.lastPrice,
    binancePrevPrice: binance.prevPrice,
    binanceConnected: binance.connected,
    timeLeftMin: smoothTimeLeft ?? data?.timeLeftMin,
    priceToBeat: data?.priceToBeat,
  }), [
    chainlinkResolved.price, chainlinkResolved.prevPrice,
    chainlinkConnected, chainlinkResolved.source,
    binance.price, binance.prevPrice, binance.connected,
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
      // New indicators
      volDelta: data.volDelta,
      emaCross: data.emaCross,
      stochRsi: data.stochRsi,
      fundingRate: data.fundingRate,
      // Hidden features exposed
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
    // New indicators
    data?.volDelta?.buyRatio, data?.volDelta?.netDeltaPct,
    data?.emaCross?.distancePct, data?.emaCross?.cross,
    data?.stochRsi?.k, data?.stochRsi?.d,
    data?.fundingRate?.ratePct,
    // Hidden features
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

  // EdgePanel: edge, recommendation, ML confidence
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
    };
  }, [
    data?.edge, data?.rec, data?.pLong, data?.pShort, data?.ruleUp,
    data?.marketUp, data?.marketDown, data?.timeLeftMin, data?.feedbackStats,
    data?.ml?.confidence,
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

  return (
    <div className="app-container">
      {/* Header */}
      <header className="app-header">
        <div className="app-header__title">
          <span className="btc-icon">₿</span>
          Polymarket BTC 15m Assistant
        </div>
        <div className="app-header__status">
          <StatusDot connected={binance.connected} label="Binance" />
          <span style={{ color: 'var(--text-dim)' }}>|</span>
          <StatusDot connected={chainlinkConnected} label={`Chainlink (${chainlinkResolved.source})`} />
          <span style={{ color: 'var(--text-dim)' }}>|</span>
          <StatusDot connected={clobWs.connected} label={`CLOB ${clobWs.connected ? 'WS' : 'REST'}`} />
          <span style={{ color: 'var(--text-dim)' }}>|</span>
          <StatusDot connected={mlStatus === 'ready'} label="ML" />
          <span style={{ color: 'var(--text-dim)' }}>|</span>
          <StatusDot connected={!hasError} label="Data" />
        </div>
      </header>

      {/* Connection errors */}
      {error && (
        <div className="connection-banner connection-banner--error">
          ⚠ Data fetch error: {error}
        </div>
      )}

      {/* Chainlink fallback notice */}
      {!polymarketWs.connected && chainlinkResolved.source !== 'Polymarket WS' && chainlinkResolved.price !== null && (
        <div className="connection-banner connection-banner--warning">
          ⚠ Polymarket WS unavailable — using fallback: {chainlinkResolved.source}
        </div>
      )}

      {/* Loading */}
      {loading && !data && (
        <div className="loading-screen">
          <div className="loading-screen__spinner" />
          <div className="loading-screen__text">Connecting to markets...</div>
        </div>
      )}

      {/* Dashboard Grid */}
      {data && (
        <div className="dashboard-grid">
          {/* Row 1: Price + Timer (full width) */}
          <CurrentPriceCard {...priceCardProps} />

          {/* Row 2: Prediction + TA */}
          <PredictPanel data={predictData} />
          <TAIndicators data={taData} />

          {/* Row 3: Polymarket + Edge */}
          <PolymarketPanel data={polyData} clobWsConnected={clobWs.connected} />
          <EdgePanel data={edgeData} />

          {/* Row 4: ML Engine (full width) */}
          <MLPanel data={mlData} />

          {/* Row 5: Session (full width) */}
          <SessionInfo />
        </div>
      )}

      {/* Footer */}
      <footer className="app-footer">
        ⚠ Not financial advice. Use at your own risk. — created by @krajekis
      </footer>
    </div>
  );
}