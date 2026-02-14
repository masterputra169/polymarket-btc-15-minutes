import React, { useMemo, useEffect, memo } from 'react';
import { useBotData } from './hooks/useBotData.js';
import { useCountdown } from './hooks/useCountdown.js';
import { initLoggerDB, shouldLog, logSnapshot } from './data/polymarketLogger.js';
import CurrentPriceCard from './components/CurrentPriceCard.jsx';
import TAIndicators from './components/TAIndicators.jsx';
import PredictPanel from './components/PredictPanel.jsx';
import PolymarketPanel from './components/PolymarketPanel.jsx';
import EdgePanel from './components/EdgePanel.jsx';
import MLPanel from './components/MlPanel.jsx';
import AccuracyPanel from './components/AccuracyPanel.jsx';
import BetSizingPanel from './components/BetSizingPanel.jsx';
import BotPanel from './components/BotPanel.jsx';
import PositionPanel from './components/PositionPanel.jsx';
import TraderDiscoveryPanel from './components/TraderDiscoveryPanel.jsx';
import SessionInfo from './components/SessionInfo.jsx';

// ═══ React.memo: StatusPill — rounded pill with dot + label ═══
const StatusPill = memo(function StatusPill({ connected, label }) {
  const dotCls = connected ? '' : 'status-dot--error';
  return (
    <span className="status-pill">
      <span className={`status-dot ${dotCls}`} style={{ width: 6, height: 6 }} />
      <span>{label}</span>
    </span>
  );
});

export default function App() {
  // ═══ Single data source: bot via WebSocket ═══
  const { data, loading, error, setBankroll, sendBotCommand, botConnected, binancePrice, binancePrevPrice } = useBotData();

  const botPaused = data?.paused === true;

  // ═══ Polymarket training data logger (IndexedDB, every 30s) ═══
  useEffect(() => { initLoggerDB(); }, []);
  useEffect(() => {
    if (!data || !shouldLog()) return;
    logSnapshot({
      timestamp: Date.now(),
      btcPrice: data.lastPrice,
      priceToBeat: data.priceToBeat,
      marketSlug: data.marketSlug,
      marketUp: data.marketUp,
      marketDown: data.marketDown,
      marketPriceMomentum: data.marketPriceMomentum ?? 0,
      orderbookImbalance: data.orderbookSignal?.imbalance ?? null,
      spreadPct: data.orderbookUp?.spread ?? null,
      rsi: data.rsiNow,
      rsiSlope: data.rsiSlope,
      macdHist: data.macd?.hist ?? null,
      macdLine: data.macd?.line ?? null,
      vwapNow: data.vwapNow,
      vwapSlope: data.vwapSlope,
      haColor: data.consec?.color ?? null,
      haCount: data.consec?.count ?? 0,
      delta1m: data.delta1m,
      delta3m: data.delta3m,
      volumeRecent: data.volumeRecent,
      volumeAvg: data.volumeAvg,
      regime: data.regimeInfo?.regime ?? 'unknown',
      regimeConfidence: data.regimeInfo?.confidence ?? 0,
      timeLeftMin: data.timeLeftMin,
      bbWidth: data.bb?.width ?? null,
      bbPercentB: data.bb?.percentB ?? null,
      bbSqueeze: data.bb?.squeeze ?? false,
      bbSqueezeIntensity: data.bb?.squeezeIntensity ?? 0,
      atrPct: data.atr?.atrPct ?? null,
      atrRatio: data.atr?.atrRatio ?? null,
      volDeltaBuyRatio: data.volDelta?.buyRatio ?? null,
      volDeltaAccel: data.volDelta?.deltaAccel ?? null,
      emaDistPct: data.emaCross?.distancePct ?? null,
      emaCrossSignal: data.emaCross?.cross === 'BULL_CROSS' ? 1 : data.emaCross?.cross === 'BEAR_CROSS' ? -1 : 0,
      stochK: data.stochRsi?.k ?? null,
      stochKD: data.stochRsi ? (data.stochRsi.k - data.stochRsi.d) : null,
      vwapCrossCount: data.vwapCrossCount ?? 0,
      multiTfAgreement: data.multiTfConfirm?.agreement ?? false,
      failedVwapReclaim: data.failedVwapReclaim ?? false,
      fundingRate: data.fundingRate?.rate ?? null,
      momentum5CandleSlope: data.momentum5CandleSlope ?? 0,
      volatilityChangeRatio: data.volatilityChangeRatio ?? 1,
      priceConsistency: data.priceConsistency ?? 0.5,
    });
  }, [data]);

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
    data?.timing, data?.consec, data?.ml?.confidence, data?.ml?.side,
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
    data?.ml?.confidence, data?.ml?.side, data?.regimeInfo, data?.arbitrage,
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

  // PositionPanel: positions from bot
  const positionData = useMemo(() => {
    if (!data) return null;
    return { positions: data.positions };
  }, [data?.positions?.lastUpdate, data?.positions?.list?.length]);

  // BetSizingPanel: bet sizing output
  const betSizingData = useMemo(() => {
    if (!data) return null;
    return { betSizing: data.betSizing, rec: data.rec, regimeInfo: data.regimeInfo };
  }, [data?.betSizing?.betPercent, data?.betSizing?.shouldBet, data?.betSizing?.riskLevel, data?.betSizing?.bankroll, data?.rec?.action, data?.rec?.side, data?.regimeInfo?.regime, data?.regimeInfo?.confidence]);

  return (
    <div className="app-container">
      {/* Header */}
      <header className="app-header">
        <div className="app-header__title">
          <span className="btc-icon">₿</span>
          Polymarket BTC 15m Assistant
        </div>
        <div className="app-header__status">
          <StatusPill connected={data?.binanceConnected ?? false} label="Binance" />
          <StatusPill connected={chainlinkConnected} label={`CL:${chainlinkResolved.source}`} />
          <StatusPill connected={data?.clobWsConnected ?? false} label={`CLOB ${data?.clobWsConnected ? 'WS' : 'REST'}`} />
          <StatusPill connected={mlStatus === 'ready'} label="ML" />
          <StatusPill connected={botConnected} label="Bot" />
          {/* Bot START/STOP control */}
          <button
            className={`btn-bot-control ${
              !botConnected
                ? 'btn-bot-control--disabled'
                : botPaused
                  ? 'btn-bot-control--start'
                  : 'btn-bot-control--stop'
            }`}
            disabled={!botConnected}
            onClick={() => sendBotCommand(botPaused ? 'botResume' : 'botPause')}
          >
            <span style={{ fontSize: '0.9em' }}>{botPaused ? '\u25B6' : '\u25A0'}</span>
            {!botConnected ? 'OFFLINE' : botPaused ? 'START' : 'STOP'}
          </button>
        </div>
      </header>

      {/* Bot disconnected warning */}
      {!botConnected && data && (
        <div className="connection-banner connection-banner--warning">
          Bot disconnected — showing last received data
        </div>
      )}

      {/* Bot paused banner */}
      {botConnected && botPaused && (
        <div className="paused-banner">
          BOT PAUSED — Analysis loop stopped. Click START to resume.
        </div>
      )}

      {/* Loading */}
      {loading && !data && (
        <div className="loading-screen">
          <div className="loading-screen__icon">₿</div>
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

          {/* Row 0b: Positions (full width) */}
          <PositionPanel data={positionData} sendBotCommand={sendBotCommand} />

          {/* Row 0c: Trader Discovery (full width) */}
          <TraderDiscoveryPanel sendBotCommand={sendBotCommand} />

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
