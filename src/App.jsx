import React, { useMemo, useEffect, useRef, memo } from 'react';
import { useBotData } from './hooks/useBotData.js';
import { useCountdown } from './hooks/useCountdown.js';
import { initLoggerDB, shouldLog, logSnapshot } from './data/polymarketLogger.js';
import { recordPrediction, autoSettle, loadHistory, onMarketSwitch, getSignalPerfStats, computeOverallCRPS } from './engines/feedback.js';
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
  // Use ref to avoid re-creating effect closure on every data change (500ms)
  useEffect(() => { initLoggerDB(); }, []);
  const dataRef = React.useRef(data);
  dataRef.current = data;
  useEffect(() => {
    const id = setInterval(() => {
      const d = dataRef.current;
      if (!d || !shouldLog()) return;
      logSnapshot({
        timestamp: Date.now(),
        btcPrice: d.lastPrice,
        priceToBeat: d.priceToBeat,
        marketSlug: d.marketSlug,
        marketUp: d.marketUp,
        marketDown: d.marketDown,
        marketPriceMomentum: d.marketPriceMomentum ?? 0,
        orderbookImbalance: d.orderbookSignal?.imbalance ?? null,
        spreadPct: d.orderbookUp?.spread ?? null,
        rsi: d.rsiNow,
        rsiSlope: d.rsiSlope,
        macdHist: d.macd?.hist ?? null,
        macdLine: d.macd?.line ?? null,
        vwapNow: d.vwapNow,
        vwapSlope: d.vwapSlope,
        haColor: d.consec?.color ?? null,
        haCount: d.consec?.count ?? 0,
        delta1m: d.delta1m,
        delta3m: d.delta3m,
        volumeRecent: d.volumeRecent,
        volumeAvg: d.volumeAvg,
        regime: d.regimeInfo?.regime ?? 'unknown',
        regimeConfidence: d.regimeInfo?.confidence ?? 0,
        timeLeftMin: d.timeLeftMin,
        bbWidth: d.bb?.width ?? null,
        bbPercentB: d.bb?.percentB ?? null,
        bbSqueeze: d.bb?.squeeze ?? false,
        bbSqueezeIntensity: d.bb?.squeezeIntensity ?? 0,
        atrPct: d.atr?.atrPct ?? null,
        atrRatio: d.atr?.atrRatio ?? null,
        volDeltaBuyRatio: d.volDelta?.buyRatio ?? null,
        volDeltaAccel: d.volDelta?.deltaAccel ?? null,
        emaDistPct: d.emaCross?.distancePct ?? null,
        emaCrossSignal: d.emaCross?.cross === 'BULL_CROSS' ? 1 : d.emaCross?.cross === 'BEAR_CROSS' ? -1 : 0,
        stochK: d.stochRsi?.k ?? null,
        stochKD: d.stochRsi ? (d.stochRsi.k - d.stochRsi.d) : null,
        vwapCrossCount: d.vwapCrossCount ?? 0,
        multiTfAgreement: d.multiTfConfirm?.agreement ?? false,
        failedVwapReclaim: d.failedVwapReclaim ?? false,
        fundingRate: d.fundingRate?.rate ?? null,
        momentum5CandleSlope: d.momentum5CandleSlope ?? 0,
        volatilityChangeRatio: d.volatilityChangeRatio ?? 1,
        priceConsistency: d.priceConsistency ?? 0.5,
      });
    }, 5_000); // Check every 5s (shouldLog() gates to 30s)
    return () => clearInterval(id);
  }, []);

  // ═══ Browser-side signal perf tracking (bridges bot data → localStorage) ═══
  // Records predictions + settles them client-side so signalPerf accumulates
  // M8: Added [data] dep — was running every render (~2x/sec from useCountdown).
  // Now runs once per data update (~2s when bot sends new WS message).
  const prevSlugRef = useRef(null);
  useEffect(() => {
    const d = dataRef.current;
    if (!d) return;

    // Auto-settle near market expiry
    try {
      autoSettle(d.marketSlug, d.lastPrice ?? d.btcPrice, d.priceToBeat, d.timeLeftMin);
    } catch { /* */ }

    // Detect slug change → settle old market predictions
    if (d.marketSlug && prevSlugRef.current && prevSlugRef.current !== d.marketSlug) {
      try { onMarketSwitch(prevSlugRef.current, d.marketSlug); } catch { /* */ }
    }
    if (d.marketSlug) prevSlugRef.current = d.marketSlug;

    // Record prediction when bot enters trade
    if (d.rec?.action === 'ENTER' && d.rec?.side && d.marketSlug) {
      try {
        recordPrediction({
          side: d.rec.side,
          modelProb: d.rec.side === 'UP' ? (d.pLong ?? d.ensembleUp) : (d.pShort ?? d.ensembleDown),
          marketPrice: d.rec.side === 'UP' ? d.marketUp : d.marketDown,
          btcPrice: d.lastPrice ?? d.btcPrice,
          priceToBeat: d.priceToBeat,
          marketSlug: d.marketSlug,
          regime: d.regimeInfo?.regime ?? d.regime,
          mlConfidence: d.ml?.confidence ?? null,
          breakdown: d.scoreBreakdown,
        });
      } catch { /* */ }
    }
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
    data?.rec?.action, data?.rec?.side, data?.rec?.confidence, data?.rec?.phase,
    data?.edge?.bestEdge, data?.edge?.bestSide, data?.timeDecay,
    data?.regimeInfo?.regime, data?.regimeInfo?.confidence, data?.regimeInfo?.label,
    data?.feedbackStats?.accuracy, data?.feedbackStats?.streak,
    data?.haNarrative, data?.rsiNarrative, data?.macdNarrative, data?.vwapNarrative,
    data?.timing?.phase, data?.timing?.timeLeftMin, data?.consec?.count, data?.consec?.color,
    data?.ml?.confidence, data?.ml?.side,
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
    data?.macd?.hist, data?.macd?.line, data?.macdLabel, data?.macdNarrative,
    data?.vwapNow, data?.vwapDist, data?.vwapSlope, data?.vwapSlopeLabel, data?.vwapNarrative,
    data?.consec?.count, data?.consec?.color, data?.haNarrative,
    data?.delta1m, data?.delta3m, data?.lastClose,
    data?.realizedVol, data?.volProfile?.label,
    data?.multiTfConfirm?.agreement, data?.multiTfConfirm?.score,
    data?.regimeInfo?.regime, data?.regimeInfo?.confidence,
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
    data?.orderbookUp?.bestBid, data?.orderbookUp?.bestAsk, data?.orderbookUp?.spread,
    data?.orderbookDown?.bestBid, data?.orderbookDown?.bestAsk,
    data?.orderbookSignal?.imbalance, data?.orderbookSignal?.signal,
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
    data?.edge?.bestEdge, data?.edge?.bestSide, data?.edge?.confidence,
    data?.edge?.edgeUp, data?.edge?.edgeDown,
    data?.rec?.action, data?.rec?.side, data?.rec?.confidence, data?.rec?.phase,
    data?.pLong, data?.pShort, data?.ruleUp,
    data?.marketUp, data?.marketDown, data?.timeLeftMin,
    data?.feedbackStats?.accuracy, data?.feedbackStats?.streak,
    data?.ml?.confidence, data?.ml?.side,
    data?.regimeInfo?.regime, data?.regimeInfo?.confidence,
    data?.arbitrage?.found, data?.arbitrage?.profitPct,
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
  }, [data?.ml?.available, data?.ml?.probUp, data?.ml?.confidence, data?.ml?.side, data?.ml?.status, data?.pLong, data?.pShort, data?.rawUp, data?.ruleUp]);

  // AccuracyPanel: feedback + detailed stats + signal performance
  // signalPerf/CRPS computed from browser-side stores (populated by bridge effect above)
  const accuracyData = useMemo(() => {
    if (!data) return null;
    return {
      feedbackStats: data.feedbackStats,
      detailedFeedback: data.detailedFeedback,
      signalPerf: getSignalPerfStats(),
      overallCRPS: computeOverallCRPS(loadHistory()),
    };
  }, [data?.feedbackStats?.accuracy, data?.feedbackStats?.streak, data?.feedbackStats?.totalPredictions,
      data?.detailedFeedback?.totalSettled]);

  // PositionPanel: positions + bankroll + cutLoss + recentJournal from bot
  const positionData = useMemo(() => {
    if (!data) return null;
    return {
      positions: data.positions,
      bankroll: data.bankroll,
      cutLoss: data.cutLoss ?? null,
      recentJournal: data.recentJournal ?? [],
      marketUp: data.marketUp,
      marketDown: data.marketDown,
    };
  }, [
    data?.positions?.lastUpdate,
    data?.positions?.list?.length,
    data?.positions?.botPosition?.side,
    data?.positions?.botPosition?.size,
    data?.positions?.botPosition?.fillConfirmed,
    data?.bankroll,
    data?.cutLoss?.dropPct,
    data?.cutLoss?.attempts,
    data?.cutLoss?.active,
    data?.recentJournal?.length,
    data?.recentJournal?.[0]?._ts,
    data?.marketUp,
    data?.marketDown,
  ]);

  // BetSizingPanel: bet sizing output
  const betSizingData = useMemo(() => {
    if (!data) return null;
    return { betSizing: data.betSizing, rec: data.rec, regimeInfo: data.regimeInfo };
  }, [data?.betSizing?.betPercent, data?.betSizing?.shouldBet, data?.betSizing?.riskLevel, data?.betSizing?.bankroll, data?.rec?.action, data?.rec?.side, data?.regimeInfo?.regime, data?.regimeInfo?.confidence]);

  // BotPanel: extract only what BotPanel needs (was passing full `data` = ~200 fields retained)
  const botData = useMemo(() => {
    if (!data) return null;
    return {
      paused: data.paused, ts: data.ts, pollCounter: data.pollCounter,
      dryRun: data.dryRun, btcPrice: data.btcPrice, priceToBeat: data.priceToBeat,
      timeLeftMin: data.timeLeftMin,
      rec: data.rec, ml: data.ml, edge: data.edge,
      betSizing: data.betSizing, stats: data.stats,
      indicators: data.indicators, regime: data.regime, regimeConfidence: data.regimeConfidence,
      bankroll: data.bankroll, ensembleUp: data.ensembleUp, ruleUp: data.ruleUp,
      marketUp: data.marketUp, marketDown: data.marketDown,
      sources: data.sources, arbitrage: data.arbitrage,
      fillTracker: data.fillTracker, signalStability: data.signalStability,
      usdcBalance: data.usdcBalance,
      metEngine: data.metEngine,
      positions: data.positions,
    };
  }, [
    data?.ts, data?.pollCounter, data?.paused, data?.dryRun,
    data?.rec?.action, data?.rec?.side, data?.rec?.confidence, data?.rec?.phase,
    data?.ml?.available, data?.ml?.probUp, data?.ml?.confidence, data?.ml?.side,
    data?.edge?.bestEdge, data?.bankroll, data?.stats?.wins, data?.stats?.losses,
    data?.stats?.dailyPnL, data?.stats?.consecutiveLosses,
    data?.regime, data?.ensembleUp, data?.marketUp, data?.marketDown,
    data?.signalStability?.confirmCount, data?.signalStability?.recentFlips,
    data?.arbitrage?.found,
    data?.metEngine?.last?.ts, data?.metEngine?.enabled,
    data?.positions?.botPosition?.side, data?.positions?.botPosition?.size,
  ]);

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
          <BotPanel connected={botConnected} data={botData} />

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
        Not financial advice. Use at your own risk. — created by @masterputra
      </footer>
    </div>
  );
}
