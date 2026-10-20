import React, { useMemo, useEffect, useRef, memo } from 'react';
import { useBotData } from './hooks/useBotData.ts';
import { describeClobSource } from './components/clobSourceLabel.ts';
import { useCountdown } from './hooks/useCountdown.ts';
import { initLoggerDB, shouldLog, logSnapshot } from './data/polymarketLogger.ts';
import { recordPrediction, autoSettle, onMarketSwitch, getSignalPerfStats } from './engines/feedback.ts';
import CurrentPriceCard from './components/CurrentPriceCard.tsx';
import TAIndicators from './components/TAIndicators.tsx';
import PredictPanel from './components/PredictPanel.tsx';
import PolymarketPanel from './components/PolymarketPanel.tsx';
import EdgePanel from './components/EdgePanel.tsx';
import MLPanel from './components/MlPanel.tsx';
import AccuracyPanel from './components/AccuracyPanel.tsx';
import BetSizingPanel from './components/BetSizingPanel.tsx';
import BotPanel from './components/BotPanel.tsx';
import PositionPanel from './components/PositionPanel.tsx';
import LimitOrderPanel from './components/LimitOrderPanel.tsx';
import TraderDiscoveryPanel from './components/TraderDiscoveryPanel.tsx';
import SessionInfo from './components/SessionInfo.tsx';
import TapePanel from './components/TapePanel.tsx';
import JournalTimeSeriesPanel from './components/JournalTimeSeriesPanel.tsx';
import JevPanel from './components/JevPanel.tsx';
import DashboardShell from './components/dashboard/DashboardShell.tsx';
import type { DashboardWidget, ShellStatus } from './components/dashboard/DashboardShell.tsx';

// ═══ React.memo: StatusPill — rounded pill with dot + label ═══
const StatusPill = memo(function StatusPill({ connected, label, dotClass }) {
  // dotClass wins when given — some signals have a third, amber state.
  const dotCls = dotClass ?? (connected ? '' : 'status-dot--error');
  return (
    <span className="status-pill">
      <span className={`status-dot ${dotCls}`} style={{ width: 6, height: 6 }} />
      <span>{label}</span>
    </span>
  );
});

export default function App() {
  // ═══ Single data source: bot via WebSocket ═══
  const { data, loading, error, setBankroll, sendBotCommand, botConnected, reconnect, binancePrice, binancePrevPrice } = useBotData();

  // One verdict for the header pill and the Polymarket panel — they used to
  // read different signals and could contradict each other on screen.
  const clobLabel = useMemo(
    () => describeClobSource(data ?? {}),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [data?.clobStatus, data?.clobDownReason, data?.clobSource,
      Math.round((data?.clobQuietMs ?? 0) / 1000)],
  );

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
          mlSide: d.ml?.side ?? d.rec.side ?? null,
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
    ptbExact: data?.ptbExact ?? null,
    ptbSource: data?.ptbSource ?? null,
  }), [
    chainlinkResolved.price, chainlinkResolved.prevPrice,
    chainlinkConnected, chainlinkResolved.source,
    binancePrice, binancePrevPrice, data?.binanceConnected,
    data?.lastPrice, smoothTimeLeft, data?.timeLeftMin, data?.priceToBeat,
    data?.ptbExact, data?.ptbSource,
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
      clobStatus: data.clobStatus,
      clobQuietMs: data.clobQuietMs,
      clobDownReason: data.clobDownReason,
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
    data?.clobSource, data?.clobStatus, data?.clobDownReason,
    Math.round((data?.clobQuietMs ?? 0) / 1000),
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
      journal: data.journalAnalytics?.patterns ?? null,
      actualPnl: data.journalAnalytics?.actualPnl ?? null,
    };
  }, [data?.feedbackStats?.accuracy, data?.feedbackStats?.streak, data?.feedbackStats?.totalPredictions,
      data?.detailedFeedback?.totalSettled, data?.journalAnalytics?.patterns?.totalTrades,
      data?.journalAnalytics?.patterns?.overallWr, data?.journalAnalytics?.patterns?.totalPnl,
      data?.journalAnalytics?.patterns?.brier]);

  // JournalTimeSeriesPanel: time-series analytics from bot
  // Granular deps — only re-render when actual data changes, NOT computedAt (which ticks every recompute)
  const journalAnalyticsData = useMemo(() => {
    if (!data?.journalAnalytics) return null;
    const ja = data.journalAnalytics;
    return {
      patterns: ja.patterns,
      hourly: ja.hourly,
      sessions: ja.sessions,
      dayOfWeek: ja.dayOfWeek,
      equityCurve: ja.equityCurve,
      events: ja.events,
      sources: ja.sources,
      actualPnl: ja.actualPnl,
      margin: ja.margin,
      computedAt: ja.computedAt,
    };
  }, [
    data?.journalAnalytics?.patterns?.totalTrades,
    data?.journalAnalytics?.patterns?.totalPnl,
    data?.journalAnalytics?.patterns?.overallWr,
    data?.journalAnalytics?.patterns?.currentStreak?.count,
    // Every margin field the panel renders needs its own dep. `pnl` in
    // particular moves on its own: journalAnalytics overwrites analysis.pnl from
    // the verified on-chain journal and only rewrites `outcome` when the sign
    // flips, so a correction can change P&L while trades / winRate / breakeven /
    // marginPp all stay put. Keying on marginPp alone froze the figure on screen.
    // Comparing `margin` by reference is not an option: the snapshot is fresh
    // JSON every poll, so that would re-render this panel ~20x/second.
    data?.journalAnalytics?.margin?.lifetime?.marginPp,
    data?.journalAnalytics?.margin?.lifetime?.breakevenPct,
    data?.journalAnalytics?.margin?.realistic?.trades,
    data?.journalAnalytics?.margin?.realistic?.marginPp,
    data?.journalAnalytics?.margin?.realistic?.winRatePct,
    data?.journalAnalytics?.margin?.realistic?.breakevenPct,
    data?.journalAnalytics?.margin?.realistic?.pnl,
    data?.journalAnalytics?.sources?.total,
    data?.journalAnalytics?.events?.length,
    data?.journalAnalytics?.equityCurve?.length,
    data?.journalAnalytics?.actualPnl?.lastBankroll,
  ]);

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

  // LimitOrderPanel: limit order state + market prices for discount calc
  const limitOrderData = useMemo(() => {
    if (!data) return null;
    return {
      limitOrder: data.limitOrder ?? null,
      marketUp: data.marketUp,
      marketDown: data.marketDown,
    };
  }, [
    data?.limitOrder?.phase, data?.limitOrder?.side,
    data?.limitOrder?.targetPrice, data?.limitOrder?.size,
    data?.limitOrder?.placedAt, data?.limitOrder?.cancelReason,
    data?.limitOrder?.lastEvent?.type, data?.limitOrder?.lastEvent?.ageSec,
    data?.limitOrder?.cancelAfterMin,
    data?.marketUp, data?.marketDown,
  ]);

  // TapePanel: market tape recorder health. Snapshots tick once a second, so
  // this repaints at most ~1/s — not on every broadcast.
  const tapeData = useMemo(() => data?.tape ?? null, [
    data?.tape?.running, data?.tape?.bookLive, data?.tape?.market,
    data?.tape?.localFiles, data?.tape?.localBytes, data?.tape?.buffered,
    data?.tape?.uploaded, data?.tape?.lastUploadError, data?.tape?.errors, data?.tape?.uploadsConfigured,
    data?.tape?.hour?.hour, data?.tape?.hour?.snapshots, data?.tape?.hour?.decisions,
    data?.tape?.hour?.trades, data?.tape?.hour?.resyncs, data?.tape?.hour?.entered,
    data?.tape?.lastHour?.hour,
  ]);

  // BotPanel: extract only what BotPanel needs
  // NOTE: ts/pollCounter excluded from deps — they change every ~50ms poll but are cosmetic.
  // BotPanel uses a local interval to tick the "Xs ago" display independently.
  // JevPanel: JEV / TypeSafe decision layer status (mode, last decision, calls).
const jevData = useMemo(() => data?.jev ?? null, [
  data?.jev?.calls, data?.jev?.errors, data?.jev?.mode, data?.jev?.configured,
  data?.jev?.last?.ts, data?.jev?.last?.direction, data?.jev?.last?.directionConfidence,
  data?.jev?.last?.settleUpProbability, data?.jev?.last?.regime, data?.jev?.last?.marketUp, data?.jev?.last?.marketDown,
  data?.jev?.lastCostUsd, data?.jev?.totalCostUsd,
]);

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
      limitOrder: data.limitOrder,
      profitTarget: data.profitTarget,
      profitTargetPaused: data.profitTargetPaused,
    };
  }, [
    data?.paused, data?.dryRun,
    data?.rec?.action, data?.rec?.side, data?.rec?.confidence, data?.rec?.phase,
    data?.ml?.available, data?.ml?.probUp, data?.ml?.confidence, data?.ml?.side,
    data?.edge?.bestEdge, data?.bankroll, data?.stats?.wins, data?.stats?.losses,
    data?.stats?.dailyPnL, data?.stats?.consecutiveLosses,
    data?.regime, data?.ensembleUp, data?.marketUp, data?.marketDown,
    data?.signalStability?.confirmCount, data?.signalStability?.recentFlips,
    data?.arbitrage?.found,
    data?.metEngine?.last?.ts, data?.metEngine?.enabled,
    data?.positions?.botPosition?.side, data?.positions?.botPosition?.size,
    data?.limitOrder?.phase, data?.limitOrder?.lastEvent?.type,
    data?.fillTracker?.fillRate, data?.fillTracker?.pending,
    data?.btcPrice, data?.priceToBeat, data?.timeLeftMin,
    data?.usdcBalance?.balance,
    data?.profitTarget?.profit, data?.profitTarget?.targetReached,
    data?.profitTargetPaused,
  ]);

  const shellStatus: ShellStatus = {
    btcPrice: data?.lastPrice ?? binancePrice ?? null,
    priceToBeat: data?.priceToBeat ?? null,
    timeLeftMin: smoothTimeLeft ?? data?.timeLeftMin ?? null,
    marketUp: data?.marketUp ?? null,
    marketDown: data?.marketDown ?? null,
    bankroll: data?.bankroll ?? null,
    dailyPnl: data?.stats?.dailyPnL ?? null,
    wins: data?.stats?.wins ?? null,
    losses: data?.stats?.losses ?? null,
    dryRun: data?.dryRun ?? true,
    paused: botPaused,
    botConnected,
    binanceConnected: data?.binanceConnected ?? false,
    chainlinkConnected,
    mlReady: mlStatus === 'ready',
    clobLabel: clobLabel ? { short: clobLabel.short, dotClass: clobLabel.dotClass } : null,
    error: error ? String(error) : null,
  };

  const dashboardWidgets: DashboardWidget[] = !data ? [] : [
    {
      id: 'market', title: 'Market Pulse', icon: '◉', description: 'live BTC, PTB, countdown and UP/DOWN odds',
      category: 'market', accent: 'cyan', defaultW: 8, defaultH: 2, minW: 4, minH: 2,
      defaultRect: { x: 0, y: 0, w: 8, h: 2 }, content: <CurrentPriceCard {...priceCardProps} />,
    },
    {
      id: 'bot', title: 'Bot Core', icon: '⚙', description: 'mode, decision, risk and live sources',
      category: 'system', accent: 'mint', defaultW: 4, defaultH: 2, minW: 3, minH: 2,
      defaultRect: { x: 8, y: 0, w: 4, h: 2 }, content: <BotPanel connected={botConnected} data={botData} />,
    },
    {
      id: 'prediction', title: 'Prediction', icon: '◆', description: 'model probability and recommendation',
      category: 'strategy', accent: 'cyan', defaultW: 4, defaultH: 3, minW: 3, minH: 2,
      defaultRect: { x: 0, y: 2, w: 4, h: 3 }, content: <PredictPanel data={predictData} />,
    },
    {
      id: 'edge', title: 'Edge Analysis', icon: '⚖', description: 'edge, agreement and regime',
      category: 'strategy', accent: 'mint', defaultW: 4, defaultH: 3, minW: 3, minH: 2,
      defaultRect: { x: 4, y: 2, w: 4, h: 3 }, content: <EdgePanel data={edgeData} />,
    },
    {
      id: 'polymarket', title: 'Polymarket', icon: '◈', description: 'market book, liquidity and CLOB health',
      category: 'market', accent: 'violet', defaultW: 4, defaultH: 3, minW: 3, minH: 2,
      defaultRect: { x: 8, y: 2, w: 4, h: 3 }, content: <PolymarketPanel data={polyData} />,
    },
    {
      id: 'ta', title: 'TA Matrix', icon: '▥', description: 'trend, momentum, volatility and flow',
      category: 'strategy', accent: 'ember', defaultW: 4, defaultH: 3, minW: 3, minH: 2,
      defaultRect: { x: 0, y: 5, w: 4, h: 3 }, content: <TAIndicators data={taData} />,
    },
    {
      id: 'ml', title: 'ML Engine', icon: '◍', description: 'XGBoost + LightGBM inference',
      category: 'strategy', accent: 'violet', defaultW: 4, defaultH: 3, minW: 3, minH: 2,
      defaultRect: { x: 4, y: 5, w: 4, h: 3 }, content: <MLPanel data={mlData} />,
    },
    {
      id: 'jev', title: 'JEV Layer', icon: '◇', description: 'independent judgment, shadow mode',
      category: 'strategy', accent: 'ember', defaultW: 4, defaultH: 2, minW: 3, minH: 2,
      defaultRect: { x: 8, y: 5, w: 4, h: 2 }, content: <JevPanel data={jevData} />,
    },
    {
      id: 'betSizing', title: 'Bet Sizing', icon: '⌁', description: 'Kelly, bankroll and risk budget',
      category: 'strategy', accent: 'mint', defaultW: 4, defaultH: 2, minW: 3, minH: 2,
      defaultRect: { x: 0, y: 8, w: 4, h: 2 }, content: <BetSizingPanel data={betSizingData} setBankroll={setBankroll} />,
    },
    {
      id: 'position', title: 'Positions', icon: '▣', description: 'open book, exits and recent fills',
      category: 'system', accent: 'cyan', defaultW: 4, defaultH: 2, minW: 3, minH: 2,
      defaultRect: { x: 4, y: 8, w: 4, h: 2 }, content: <PositionPanel data={positionData} sendBotCommand={sendBotCommand} />,
    },
    {
      id: 'session', title: 'Session', icon: '◷', description: 'market clock and session state',
      category: 'market', accent: 'ember', defaultW: 4, defaultH: 2, minW: 3, minH: 2,
      defaultRect: { x: 8, y: 8, w: 4, h: 2 }, content: <SessionInfo />,
    },
    {
      id: 'accuracy', title: 'Accuracy', icon: '✓', description: 'Brier, calibration, streak and margin',
      category: 'analytics', accent: 'mint', defaultW: 6, defaultH: 3, minW: 4, minH: 2,
      defaultRect: { x: 0, y: 10, w: 6, h: 3 }, content: <AccuracyPanel data={accuracyData} />,
    },
    {
      id: 'journal', title: 'Journal Analytics', icon: '⌁', description: 'equity, sessions, hourly edge',
      category: 'analytics', accent: 'violet', defaultW: 6, defaultH: 3, minW: 4, minH: 2,
      defaultRect: { x: 6, y: 10, w: 6, h: 3 }, content: <JournalTimeSeriesPanel data={journalAnalyticsData} />,
    },
    {
      id: 'tape', title: 'Market Tape', icon: '◫', description: 'recorder health and coverage',
      category: 'analytics', accent: 'cyan', defaultW: 4, defaultH: 2, minW: 3, minH: 2,
      defaultRect: { x: 0, y: 13, w: 4, h: 2 }, content: <TapePanel tape={tapeData} />,
    },
    {
      id: 'limitOrder', title: 'Limit Order', icon: '↔', description: 'passive order lifecycle',
      category: 'strategy', accent: 'ember', defaultW: 4, defaultH: 2, minW: 3, minH: 2,
      defaultRect: { x: 4, y: 13, w: 4, h: 2 }, content: <LimitOrderPanel data={limitOrderData} />,
    },
    {
      id: 'traderDiscovery', title: 'Trader Discovery', icon: '⌖', description: 'wallet scan and simulation',
      category: 'analytics', accent: 'violet', defaultW: 4, defaultH: 3, minW: 3, minH: 2,
      defaultRect: { x: 8, y: 13, w: 4, h: 3 }, content: <TraderDiscoveryPanel sendBotCommand={sendBotCommand} />,
    },
  ];

  return (
    <DashboardShell
      widgets={dashboardWidgets}
      status={shellStatus}
      loading={loading && !data}
      onReconnect={reconnect}
      onToggleBot={() => sendBotCommand(botPaused ? 'botResume' : 'botPause')}
    />
  );
}
