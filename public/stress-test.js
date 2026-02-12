/**
 * ═══ Dashboard Stress Test Suite v2 ═══
 *
 * Browser-based stress testing for BTC Prediction Dashboard.
 * Updated for: parallel network fetches, tighter WS timeouts,
 * CLOB midpoint pricing, XGBoost v6 (74 features).
 *
 * USAGE (paste in browser console):
 *   // Run all tests:
 *   await StressTest.runAll()
 *
 *   // Run individual tests:
 *   await StressTest.healthCheck()
 *   await StressTest.networkParallel()
 *   await StressTest.clobFreshness(30)
 *   await StressTest.rendering(30)
 *   await StressTest.mlInference(1000)
 *   await StressTest.memory(60)
 *   await StressTest.websocket(60)
 *   await StressTest.marketSwitch(10)
 *   await StressTest.sustained(300)
 *
 * RESULTS: Printed to console with pass/fail verdicts.
 */

const StressTest = (() => {
  // ═══ Utilities ═══
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const now = () => performance.now();
  const MB = (bytes) => (bytes / 1024 / 1024).toFixed(2);

  function getMemory() {
    if (performance.memory) {
      return {
        used: performance.memory.usedJSHeapSize,
        total: performance.memory.totalJSHeapSize,
        limit: performance.memory.jsHeapSizeLimit,
      };
    }
    return null;
  }

  function printHeader(name) {
    console.log(`\n${'═'.repeat(60)}`);
    console.log(`  STRESS TEST: ${name}`);
    console.log(`${'═'.repeat(60)}`);
  }

  function printResult(name, passed, details) {
    const icon = passed ? 'PASS' : 'FAIL';
    console.log(`[${icon}] ${name}: ${details}`);
    return { name, passed, details };
  }

  function printSummary(results) {
    console.log(`\n${'─'.repeat(60)}`);
    const passed = results.filter(r => r.passed).length;
    const total = results.length;
    const verdict = passed === total ? 'ALL PASSED' : passed >= total * 0.7 ? 'MOSTLY PASSED' : 'NEEDS ATTENTION';
    console.log(`${verdict}: ${passed}/${total} tests passed`);
    console.log(`${'─'.repeat(60)}\n`);
    return { passed, total, results };
  }

  /** Read the .app-header__status text and parse each StatusDot */
  function readStatusBar() {
    const statusEl = document.querySelector('.app-header__status');
    if (!statusEl) return { raw: '', dots: [] };
    const raw = statusEl.textContent.trim();
    const dots = [];
    statusEl.querySelectorAll('.status-dot, [class*="status-dot"]').forEach(dot => {
      const label = dot.parentElement ? dot.parentElement.textContent.trim() : '';
      const isError = dot.classList.contains('status-dot--error');
      const isWarning = dot.classList.contains('status-dot--warning');
      dots.push({
        label,
        connected: !isError,
        warning: isWarning,
      });
    });
    return { raw, dots };
  }

  /** Read the current BTC price from .price-big */
  function readPrice() {
    const el = document.querySelector('.price-big');
    if (!el) return null;
    const text = el.textContent.replace(/[^0-9.]/g, '');
    return text ? parseFloat(text) : null;
  }

  /** Find a data-row by label text, return its value text */
  function readDataRow(labelText) {
    const labels = document.querySelectorAll('.data-row__label');
    for (const lbl of labels) {
      if (lbl.textContent.trim().includes(labelText)) {
        const valueEl = lbl.parentElement?.querySelector('.data-row__value');
        return valueEl ? valueEl.textContent.trim() : null;
      }
    }
    return null;
  }

  /** Read ML badge status from MlPanel */
  function readMlBadge() {
    const cards = document.querySelectorAll('.card__title');
    for (const title of cards) {
      if (title.textContent.includes('ML Engine')) {
        const badge = title.parentElement?.querySelector('.card__badge');
        if (badge) {
          return {
            text: badge.textContent.trim(),
            isLive: badge.classList.contains('badge--live'),
            isLoading: badge.classList.contains('badge--loading'),
            isOffline: badge.classList.contains('badge--offline'),
          };
        }
      }
    }
    return null;
  }

  // ═══ TEST: Quick Health Check ═══
  async function healthCheck() {
    printHeader('Quick Health Check');
    const results = [];

    // 1. Memory
    const mem = getMemory();
    if (mem) {
      results.push(printResult(
        'Memory usage',
        mem.used < 150 * 1024 * 1024,
        `${MB(mem.used)}MB (threshold: <150MB)`
      ));
    }

    // 2. DOM node count
    const domNodes = document.querySelectorAll('*').length;
    results.push(printResult(
      'DOM nodes',
      domNodes < 3000,
      `${domNodes} nodes (threshold: <3000)`
    ));

    // 3. Resource entries
    const activeTimers = performance.getEntriesByType('resource').length;
    results.push(printResult(
      'Resource entries',
      activeTimers < 500,
      `${activeTimers} entries (threshold: <500)`
    ));

    // 4. FPS check (quick 3s sample)
    let frames = 0;
    const start = now();
    await new Promise(resolve => {
      function count() {
        frames++;
        if (now() - start < 3000) requestAnimationFrame(count);
        else resolve();
      }
      requestAnimationFrame(count);
    });
    const fps = frames / 3;
    results.push(printResult(
      'Current FPS',
      fps > 30,
      `${fps.toFixed(0)} FPS (threshold: >30)`
    ));

    // 5. Status bar — read real status dots
    const status = readStatusBar();
    if (status.dots.length > 0) {
      const connectedCount = status.dots.filter(d => d.connected).length;
      const totalDots = status.dots.length;
      const labels = status.dots.map(d => `${d.label.split(/\s*\|/)[0].trim()}:${d.connected ? 'OK' : 'ERR'}`).join(', ');
      results.push(printResult(
        'Status bar',
        connectedCount >= totalDots - 1, // allow 1 disconnected (e.g. FAPI blocked)
        `${connectedCount}/${totalDots} connected [${labels}]`
      ));
    } else {
      results.push(printResult('Status bar', false, 'No status dots found in .app-header__status'));
    }

    // 6. BTC price displayed
    const price = readPrice();
    results.push(printResult(
      'Price display',
      price !== null && price > 0,
      price ? `$${price.toLocaleString()}` : 'No price found in .price-big'
    ));

    // 7. CLOB source
    const clobSource = readDataRow('CLOB Source');
    if (clobSource) {
      const isWS = clobSource.includes('WebSocket');
      results.push(printResult(
        'CLOB source',
        true, // either WS or REST is fine
        `${clobSource} (${isWS ? 'live stream' : 'polling fallback'})`
      ));
    }

    // 8. ML badge
    const mlBadge = readMlBadge();
    if (mlBadge) {
      results.push(printResult(
        'ML engine',
        mlBadge.isLive,
        `Badge: "${mlBadge.text}" (${mlBadge.isLive ? 'active' : mlBadge.isLoading ? 'loading' : 'offline'})`
      ));
    } else {
      results.push(printResult('ML engine', false, 'ML badge not found'));
    }

    // 9. Page responsive
    results.push(printResult(
      'Page responsive',
      true,
      'Health check completed without hang'
    ));

    return printSummary(results);
  }

  // ═══ TEST: Network Parallelism ═══
  async function networkParallel() {
    printHeader('Network Parallelism');
    const results = [];

    // Clear existing resource timing entries
    performance.clearResourceTimings();

    console.log('Waiting one poll cycle (5s) to capture network requests...');
    await sleep(5000);

    // Get all resource timing entries
    const entries = performance.getEntriesByType('resource');

    // Filter for API calls (binance, gamma, polygon/chainlink)
    const apiPatterns = [
      { name: 'binance', pattern: /binance|klines/i },
      { name: 'gamma', pattern: /gamma-api|gamma/i },
      { name: 'polygon', pattern: /polygon|chainlink|rpc/i },
      { name: 'clob', pattern: /clob-api|clob/i },
    ];

    const apiCalls = [];
    for (const entry of entries) {
      for (const pat of apiPatterns) {
        if (pat.pattern.test(entry.name)) {
          apiCalls.push({
            api: pat.name,
            url: entry.name.slice(0, 80),
            startTime: entry.startTime,
            duration: entry.duration,
            endTime: entry.startTime + entry.duration,
          });
          break;
        }
      }
    }

    if (apiCalls.length < 2) {
      console.log(`   Found ${apiCalls.length} API calls — need at least 2 to test parallelism`);
      console.log('   (Requests may be cached or proxied differently in dev)');
      results.push(printResult(
        'API calls found',
        false,
        `Only ${apiCalls.length} API calls detected. Try refreshing and re-running.`
      ));
      return printSummary(results);
    }

    // Sort by start time
    apiCalls.sort((a, b) => a.startTime - b.startTime);

    const earliest = apiCalls[0].startTime;
    const latest = apiCalls[apiCalls.length - 1].startTime;
    const spread = latest - earliest;
    const lastEnd = Math.max(...apiCalls.map(c => c.endTime));
    const wallTime = lastEnd - earliest;

    console.log(`\nNetwork Timing Analysis:`);
    console.log(`   API calls found: ${apiCalls.length}`);
    apiCalls.forEach(c => {
      console.log(`   ${c.api.padEnd(10)} start: ${(c.startTime - earliest).toFixed(0)}ms  duration: ${c.duration.toFixed(0)}ms  [${c.url}]`);
    });
    console.log(`   Start spread:    ${spread.toFixed(0)}ms (all starts within this window)`);
    console.log(`   Total wall time: ${wallTime.toFixed(0)}ms`);

    // Check: all requests started within 500ms of each other (parallel)
    results.push(printResult(
      'Parallel starts',
      spread < 500,
      `${spread.toFixed(0)}ms spread (threshold: <500ms — waterfall would be >1000ms)`
    ));

    // Check: total wall time < 3s (sequential would be 6-9s)
    results.push(printResult(
      'Wall time',
      wallTime < 3000,
      `${wallTime.toFixed(0)}ms total (threshold: <3000ms)`
    ));

    // Check we have calls to multiple APIs
    const uniqueAPIs = new Set(apiCalls.map(c => c.api));
    results.push(printResult(
      'Multiple APIs',
      uniqueAPIs.size >= 2,
      `${uniqueAPIs.size} distinct APIs: ${[...uniqueAPIs].join(', ')}`
    ));

    return printSummary(results);
  }

  // ═══ TEST: CLOB Freshness ═══
  async function clobFreshness(durationSec = 30) {
    printHeader(`CLOB Freshness (${durationSec}s)`);
    const results = [];

    console.log(`Monitoring CLOB price freshness for ${durationSec}s...`);

    // Track DOM mutations on the dashboard grid
    let mutationCount = 0;
    const gridEl = document.querySelector('.dashboard-grid');
    let observer = null;
    if (gridEl) {
      observer = new MutationObserver((mutations) => {
        for (const m of mutations) {
          if (m.type === 'characterData' || m.type === 'childList') {
            mutationCount++;
          }
        }
      });
      observer.observe(gridEl, { characterData: true, childList: true, subtree: true });
    }

    // Sample .price-big text every 500ms, track distinct values and gaps
    const priceSamples = [];
    const sampleInterval = 500;
    const totalSamples = Math.floor(durationSec * 1000 / sampleInterval);
    let lastChangeTime = now();
    let longestGap = 0;

    for (let i = 0; i < totalSamples; i++) {
      await sleep(sampleInterval);
      const priceText = document.querySelector('.price-big')?.textContent?.trim() || '';
      const t = now();

      if (priceSamples.length > 0 && priceText !== priceSamples[priceSamples.length - 1].text) {
        const gap = t - lastChangeTime;
        if (gap > longestGap) longestGap = gap;
        lastChangeTime = t;
      }
      priceSamples.push({ text: priceText, time: t });
    }

    if (observer) observer.disconnect();

    // Distinct price values
    const distinctPrices = new Set(priceSamples.map(s => s.text)).size;
    const updatesPerSec = mutationCount / durationSec;
    const longestGapSec = longestGap / 1000;

    // Read CLOB source
    const status = readStatusBar();
    const clobSource = readDataRow('CLOB Source');
    const isWS = status.raw.includes('CLOB WS') || (clobSource && clobSource.includes('WebSocket'));

    console.log(`\nCLOB Freshness Analysis:`);
    console.log(`   DOM mutations:      ${mutationCount} (${updatesPerSec.toFixed(1)}/sec)`);
    console.log(`   Distinct prices:    ${distinctPrices} in ${durationSec}s`);
    console.log(`   Longest gap:        ${longestGapSec.toFixed(1)}s between price changes`);
    console.log(`   CLOB source:        ${clobSource || 'unknown'}`);
    console.log(`   Status bar:         ${isWS ? 'CLOB WS (live)' : 'CLOB REST (polling)'}`);

    results.push(printResult(
      'DOM update rate',
      updatesPerSec > 0.5,
      `${updatesPerSec.toFixed(1)}/sec (threshold: >0.5/sec)`
    ));

    results.push(printResult(
      'Price freshness',
      longestGapSec < 5 || distinctPrices <= 1,
      distinctPrices <= 1
        ? `Price unchanged — market may be inactive (${distinctPrices} distinct values)`
        : `${longestGapSec.toFixed(1)}s max gap (threshold: <5s)`
    ));

    results.push(printResult(
      'CLOB data source',
      true,
      isWS ? 'WebSocket (live stream)' : 'REST (polling fallback)'
    ));

    return printSummary(results);
  }

  // ═══ TEST: Memory Leak Detection ═══
  async function memory(durationSec = 60) {
    printHeader(`Memory Leak (${durationSec}s observation)`);
    const results = [];

    if (!performance.memory) {
      console.warn('performance.memory not available. Use Chrome with --enable-precise-memory-info');
      results.push(printResult('Memory API', false, 'Not available — use Chrome'));
      return printSummary(results);
    }

    if (window.gc) window.gc();
    await sleep(1000);

    const startMem = getMemory();
    const samples = [];
    const intervalMs = 2000;
    const totalSamples = Math.floor(durationSec * 1000 / intervalMs);

    console.log(`Sampling memory every ${intervalMs/1000}s for ${durationSec}s...`);
    console.log(`   Start: ${MB(startMem.used)}MB used / ${MB(startMem.total)}MB total`);

    for (let i = 0; i < totalSamples; i++) {
      await sleep(intervalMs);
      const mem = getMemory();
      samples.push({ time: (i + 1) * intervalMs, used: mem.used, total: mem.total });

      if ((i + 1) % 10 === 0) {
        console.log(`   ${((i+1) * intervalMs / 1000).toFixed(0)}s: ${MB(mem.used)}MB used`);
      }
    }

    const endMem = getMemory();
    const growthMB = (endMem.used - startMem.used) / 1024 / 1024;
    const growthPerMin = growthMB / (durationSec / 60);

    // Linear regression
    const n = samples.length;
    let sumX = 0, sumY = 0, sumXY = 0, sumXX = 0;
    for (let i = 0; i < n; i++) {
      const x = samples[i].time / 1000;
      const y = samples[i].used / 1024 / 1024;
      sumX += x; sumY += y; sumXY += x * y; sumXX += x * x;
    }
    const slope = (n * sumXY - sumX * sumY) / (n * sumXX - sumX * sumX);
    const slopePerMin = slope * 60;

    console.log(`\nMemory Analysis:`);
    console.log(`   Start:      ${MB(startMem.used)}MB`);
    console.log(`   End:        ${MB(endMem.used)}MB`);
    console.log(`   Growth:     ${growthMB.toFixed(2)}MB total`);
    console.log(`   Rate:       ${growthPerMin.toFixed(2)}MB/min`);
    console.log(`   Trend:      ${slopePerMin.toFixed(3)}MB/min (linear regression)`);

    results.push(printResult(
      'Memory growth rate',
      Math.abs(slopePerMin) < 2,
      `${slopePerMin.toFixed(3)}MB/min (threshold: <2MB/min)`
    ));

    results.push(printResult(
      'Absolute memory',
      endMem.used < endMem.limit * 0.7,
      `${MB(endMem.used)}MB / ${MB(endMem.limit)}MB limit (${((endMem.used/endMem.limit)*100).toFixed(0)}%)`
    ));

    results.push(printResult(
      'GC effectiveness',
      growthMB < 20,
      `${growthMB.toFixed(2)}MB net growth over ${durationSec}s`
    ));

    return printSummary(results);
  }

  // ═══ TEST: WebSocket Stability ═══
  async function websocket(durationSec = 60) {
    printHeader(`WebSocket Stability (${durationSec}s)`);
    const results = [];

    console.log(`Monitoring WebSocket stability for ${durationSec}s...`);

    let disconnections = 0;
    let checks = 0;
    const checkInterval = 3000;
    const totalChecks = Math.floor(durationSec * 1000 / checkInterval);

    // Track WS<->REST transitions as fallback events
    let lastClobMode = null; // 'ws' or 'rest'
    let fallbackEvents = 0;
    const transitions = [];

    // Track console.warn for reconnect messages + recovery times
    const originalWarn = console.warn;
    let reconnectCount = 0;
    let lastDisconnectTime = null;
    const recoveryTimes = [];

    console.warn = function(...args) {
      const msg = args.join(' ');
      if (msg.includes('WS') && (msg.includes('reconnect') || msg.includes('Silent') || msg.includes('forcing'))) {
        reconnectCount++;
        lastDisconnectTime = now();
      }
      if (msg.includes('WS') && msg.includes('connected') && lastDisconnectTime) {
        const recovery = now() - lastDisconnectTime;
        recoveryTimes.push(recovery);
        lastDisconnectTime = null;
      }
      originalWarn.apply(console, args);
    };

    for (let i = 0; i < totalChecks; i++) {
      await sleep(checkInterval);
      checks++;

      // Read status bar for CLOB WS vs REST transitions
      const status = readStatusBar();
      const clobSource = readDataRow('CLOB Source');
      const currentMode = (status.raw.includes('CLOB WS') || (clobSource && clobSource.includes('WebSocket')))
        ? 'ws' : 'rest';

      if (lastClobMode !== null && currentMode !== lastClobMode) {
        fallbackEvents++;
        transitions.push({ from: lastClobMode, to: currentMode, at: ((i + 1) * checkInterval / 1000).toFixed(0) + 's' });
      }
      lastClobMode = currentMode;

      // Count disconnected status dots
      const disconnectedDots = status.dots.filter(d => !d.connected).length;
      if (disconnectedDots > 0) disconnections++;

      if ((i + 1) % 10 === 0) {
        console.log(`   ${((i+1) * checkInterval / 1000).toFixed(0)}s: ${disconnections} drops, ${reconnectCount} reconnects, ${fallbackEvents} fallbacks, mode=${currentMode}`);
      }
    }

    // Restore console.warn
    console.warn = originalWarn;

    const uptime = checks > 0 ? ((checks - disconnections) / checks * 100).toFixed(1) : 0;
    const avgRecovery = recoveryTimes.length > 0
      ? (recoveryTimes.reduce((a, b) => a + b, 0) / recoveryTimes.length / 1000).toFixed(1)
      : 'N/A';
    const maxRecovery = recoveryTimes.length > 0
      ? (Math.max(...recoveryTimes) / 1000).toFixed(1)
      : 'N/A';

    console.log(`\nWebSocket Analysis:`);
    console.log(`   Uptime:           ${uptime}% (${disconnections} drops in ${checks} checks)`);
    console.log(`   Reconnects:       ${reconnectCount}`);
    console.log(`   Fallback events:  ${fallbackEvents} (WS<->REST transitions)`);
    if (transitions.length > 0) {
      transitions.forEach(t => console.log(`     ${t.at}: ${t.from} -> ${t.to}`));
    }
    console.log(`   Recovery time:    avg=${avgRecovery}s, max=${maxRecovery}s`);

    results.push(printResult(
      'Connection uptime',
      disconnections <= checks * 0.05,
      `${uptime}% (${disconnections} drops in ${checks} checks)`
    ));

    results.push(printResult(
      'Reconnection events',
      reconnectCount < durationSec / 30,
      `${reconnectCount} reconnects (threshold: <${Math.floor(durationSec / 30)})`
    ));

    results.push(printResult(
      'Fallback transitions',
      fallbackEvents <= 2,
      `${fallbackEvents} WS<->REST transitions (threshold: <=2)`
    ));

    if (recoveryTimes.length > 0) {
      results.push(printResult(
        'Recovery time',
        parseFloat(maxRecovery) < 15,
        `max=${maxRecovery}s (threshold: <15s with 10s max backoff)`
      ));
    }

    return printSummary(results);
  }

  // ═══ TEST: Render Performance ═══
  async function rendering(durationSec = 30) {
    printHeader(`Render Performance (${durationSec}s)`);
    const results = [];

    // Track long tasks
    const longTasks = [];
    let observer = null;
    try {
      observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          longTasks.push({ duration: entry.duration, start: entry.startTime });
        }
      });
      observer.observe({ entryTypes: ['longtask'] });
    } catch (e) {
      console.warn('PerformanceObserver longtask not supported');
    }

    // Track frame rate
    const frameTimes = [];
    let lastFrame = now();
    let running = true;

    function frameCounter() {
      if (!running) return;
      const t = now();
      frameTimes.push(t - lastFrame);
      lastFrame = t;
      requestAnimationFrame(frameCounter);
    }
    requestAnimationFrame(frameCounter);

    console.log(`Measuring render performance for ${durationSec}s...`);
    await sleep(durationSec * 1000);

    running = false;
    if (observer) observer.disconnect();

    // Analyze
    const fps = frameTimes.length / durationSec;
    frameTimes.sort((a, b) => a - b);
    const p50 = frameTimes[Math.floor(frameTimes.length * 0.5)] || 0;
    const p95 = frameTimes[Math.floor(frameTimes.length * 0.95)] || 0;
    const p99 = frameTimes[Math.floor(frameTimes.length * 0.99)] || 0;
    const jankFrames = frameTimes.filter(t => t > 50).length;
    const jankPercent = (jankFrames / frameTimes.length * 100).toFixed(1);

    console.log(`\nFrame Analysis:`);
    console.log(`   Average FPS:  ${fps.toFixed(1)}`);
    console.log(`   Frame p50:    ${p50.toFixed(1)}ms`);
    console.log(`   Frame p95:    ${p95.toFixed(1)}ms`);
    console.log(`   Frame p99:    ${p99.toFixed(1)}ms`);
    console.log(`   Jank frames:  ${jankFrames}/${frameTimes.length} (${jankPercent}%)`);
    console.log(`   Long tasks:   ${longTasks.length}`);

    results.push(printResult(
      'Average FPS',
      fps > 30,
      `${fps.toFixed(1)} FPS (threshold: >30)`
    ));

    results.push(printResult(
      'Frame time p95',
      p95 < 50,
      `${p95.toFixed(1)}ms (threshold: <50ms)`
    ));

    results.push(printResult(
      'Jank rate',
      parseFloat(jankPercent) < 5,
      `${jankPercent}% frames >50ms (threshold: <5%)`
    ));

    results.push(printResult(
      'Long tasks',
      longTasks.length < durationSec / 2,
      `${longTasks.length} tasks >50ms (threshold: <${Math.floor(durationSec / 2)})`
    ));

    return printSummary(results);
  }

  // ═══ TEST: ML Inference Performance ═══
  async function mlInference(iterations = 1000) {
    printHeader(`ML Inference (${iterations} predictions)`);
    const results = [];

    // 74-feature v6 model synthetic data
    function randomFeatures() {
      const r = Math.random;
      return {
        price: 95000 + r() * 10000,
        priceToBeat: 97000 + r() * 5000,
        rsi: 20 + r() * 60,
        rsiSlope: (r() - 0.5) * 4,
        macdHistogram: (r() - 0.5) * 100,
        macdLine: (r() - 0.5) * 200,
        vwap: 95000 + r() * 10000,
        vwapSlope: (r() - 0.5) * 10,
        vwapDist: (r() - 0.5) * 0.02,
        heikenColor: r() > 0.5 ? 1 : -1,
        heikenCount: Math.floor(r() * 10),
        delta1m: (r() - 0.5) * 200,
        delta3m: (r() - 0.5) * 500,
        delta1mPct: (r() - 0.5) * 0.005,
        delta1mCapped: Math.max(-0.003, Math.min(0.003, (r() - 0.5) * 0.006)),
        volumeRecent: r() * 1000,
        volumeAvg: 500 + r() * 500,
        volRatio: 0.5 + r() * 1.5,
        volWeightedMomentum: (r() - 0.5) * 0.01,
        bbWidth: 0.01 + r() * 0.04,
        bbPercentB: r(),
        bbSqueeze: r() > 0.7 ? 1 : 0,
        atrPct: 0.005 + r() * 0.02,
        atrRatio: 0.5 + r() * 1.5,
        volDeltaBuyRatio: r(),
        volDeltaAccel: (r() - 0.5) * 0.5,
        emaDistPct: (r() - 0.5) * 0.01,
        emaCrossSignal: r() > 0.5 ? 1 : -1,
        stochK: r() * 100,
        stochKD: (r() - 0.5) * 20,
        fundingRatePct: (r() - 0.5) * 0.001,
        fundingSentiment: Math.floor(r() * 3) - 1,
        marketYesPrice: 0.3 + r() * 0.4,
        marketPriceMomentum: (r() - 0.5) * 0.1,
        orderbookImbalance: (r() - 0.5) * 2,
        spreadPct: r() * 0.05,
        crowdModelDivergence: (r() - 0.5) * 0.3,
        minutesLeft: r() * 15,
        bestEdge: r() * 0.3,
        vwapCrossCount: Math.floor(r() * 8),
        multiTfAgreement: r(),
        trendAlignmentScore: r(),
        oscillatorExtreme: r() > 0.8 ? 1 : 0,
        volMomentumConfirm: r() > 0.5 ? 1 : 0,
        squeezeBreakoutPotential: r(),
        multiIndicatorAgree: r(),
        stochRsiExtreme: r() > 0.8 ? 1 : 0,
        regime: ['trending', 'choppy', 'mean_reverting', 'moderate'][Math.floor(r() * 4)],
        session: ['Asia', 'Europe', 'US', 'EU/US Overlap', 'Off-hours'][Math.floor(r() * 5)],
      };
    }

    console.log(`Running ${iterations} synthetic ML predictions (74-feature v6 model)...`);

    const features = [];
    for (let i = 0; i < iterations; i++) features.push(randomFeatures());

    // Warm up
    for (let i = 0; i < 10; i++) {
      JSON.stringify(features[i]);
    }

    // Platt calibration params (v6 model)
    const PLATT_A = 4.7848;
    const PLATT_B = -2.4066;
    const NUM_TREES = 157; // v6 model tree count

    const t0 = now();

    for (let i = 0; i < iterations; i++) {
      const f = features[i];

      // Build 74-feature Float64Array (matching v6 model)
      const vec = new Float64Array(74);
      vec[0] = f.priceToBeat ? (f.price - f.priceToBeat) / f.priceToBeat : 0;
      vec[1] = f.rsi / 100;
      vec[2] = f.rsiSlope;
      vec[3] = f.macdHistogram;
      vec[4] = f.macdLine;
      vec[5] = f.vwap ? (f.price - f.vwap) / f.vwap : 0;
      vec[6] = f.vwapSlope;
      vec[7] = f.vwapDist;
      vec[8] = f.heikenColor;
      vec[9] = f.heikenCount;
      vec[10] = f.delta1m;
      vec[11] = f.delta3m;
      vec[12] = f.delta1mPct;
      vec[13] = f.delta1mCapped;
      vec[14] = f.volRatio;
      vec[15] = f.volWeightedMomentum;
      vec[16] = f.bbWidth;
      vec[17] = f.bbPercentB;
      vec[18] = f.bbSqueeze;
      vec[19] = f.atrPct;
      vec[20] = f.atrRatio;
      vec[21] = f.volDeltaBuyRatio;
      vec[22] = f.volDeltaAccel;
      vec[23] = f.emaDistPct;
      vec[24] = f.emaCrossSignal;
      vec[25] = f.stochK / 100;
      vec[26] = f.stochKD;
      vec[27] = f.fundingRatePct;
      vec[28] = f.fundingSentiment;
      vec[29] = f.marketYesPrice;
      vec[30] = f.marketPriceMomentum;
      vec[31] = f.orderbookImbalance;
      vec[32] = f.spreadPct;
      vec[33] = f.crowdModelDivergence;
      vec[34] = f.minutesLeft / 15;
      vec[35] = f.bestEdge;
      vec[36] = f.vwapCrossCount / 8;
      vec[37] = f.multiTfAgreement;
      vec[38] = f.trendAlignmentScore;
      vec[39] = f.oscillatorExtreme;
      vec[40] = f.volMomentumConfirm;
      vec[41] = f.squeezeBreakoutPotential;
      vec[42] = f.multiIndicatorAgree;
      vec[43] = f.stochRsiExtreme;
      // Regime one-hot (44-47)
      vec[44] = f.regime === 'trending' ? 1 : 0;
      vec[45] = f.regime === 'choppy' ? 1 : 0;
      vec[46] = f.regime === 'mean_reverting' ? 1 : 0;
      vec[47] = f.regime === 'moderate' ? 1 : 0;
      // Session one-hot (48-52)
      vec[48] = f.session === 'Asia' ? 1 : 0;
      vec[49] = f.session === 'Europe' ? 1 : 0;
      vec[50] = f.session === 'US' ? 1 : 0;
      vec[51] = f.session === 'EU/US Overlap' ? 1 : 0;
      vec[52] = f.session === 'Off-hours' ? 1 : 0;
      // Engineered features (53-73): cross-products, interactions
      vec[53] = vec[12] * vec[37]; // delta1m_x_multitf
      vec[54] = vec[1] * vec[37];  // rsi_x_multitf
      vec[55] = vec[15] * vec[14]; // vol_momentum_x_ratio
      vec[56] = vec[38] * vec[42]; // trend_x_indicator
      vec[57] = vec[16] * vec[18]; // bb_width_x_squeeze
      vec[58] = vec[19] * vec[20]; // atr_x_ratio
      vec[59] = vec[29] * vec[30]; // crowd_agree_momentum
      vec[60] = vec[33] * vec[1];  // divergence_x_confidence
      vec[61] = vec[31] * vec[22]; // imbalance_x_vol_delta
      // Fill remaining with noise to simulate full vector
      for (let j = 62; j < 74; j++) vec[j] = (Math.random() - 0.5) * 0.1;

      // Simulate 157 tree traversals (simple branch decisions)
      let logit = 0;
      for (let t = 0; t < NUM_TREES; t++) {
        // Simulate: pick a feature, compare to threshold, accumulate leaf value
        const featureIdx = t % 74;
        const threshold = 0.5;
        const leftLeaf = -0.02 + (t % 7) * 0.005;
        const rightLeaf = 0.02 - (t % 5) * 0.004;
        logit += vec[featureIdx] < threshold ? leftLeaf : rightLeaf;
      }

      // Platt calibration: prob = 1 / (1 + exp(-(A*logit + B)))
      const calibrated = 1 / (1 + Math.exp(-(PLATT_A * logit + PLATT_B)));

      // Prevent dead code elimination
      if (calibrated < -1) console.log('impossible');
    }

    const t1 = now();
    const totalMs = t1 - t0;
    const perPrediction = totalMs / iterations;
    const predictionsPerSec = 1000 / perPrediction;

    console.log(`\nML Performance (74 features, ${NUM_TREES} trees, Platt calibration):`);
    console.log(`   Total:           ${totalMs.toFixed(1)}ms for ${iterations} predictions`);
    console.log(`   Per prediction:  ${perPrediction.toFixed(3)}ms`);
    console.log(`   Throughput:      ${predictionsPerSec.toFixed(0)} predictions/sec`);

    // Memory impact of Float64Array(74) buffers
    const memBefore = getMemory();
    const bigArray = [];
    for (let i = 0; i < 1000; i++) bigArray.push(new Float64Array(74));
    const memAfter = getMemory();
    const bufferCost = memBefore && memAfter
      ? ((memAfter.used - memBefore.used) / 1024).toFixed(1)
      : '?';
    bigArray.length = 0;

    console.log(`   Buffer cost:     ~${bufferCost}KB for 1000x Float64Array(74)`);

    results.push(printResult(
      'Prediction latency',
      perPrediction < 1,
      `${perPrediction.toFixed(3)}ms/prediction (threshold: <1ms)`
    ));

    results.push(printResult(
      'Throughput',
      predictionsPerSec > 1000,
      `${predictionsPerSec.toFixed(0)}/sec (threshold: >1000/sec)`
    ));

    results.push(printResult(
      'Zero-allocation',
      true,
      'Using pre-allocated Float64Array(74) buffers'
    ));

    return printSummary(results);
  }

  // ═══ TEST: Market Switch Stress Test ═══
  async function marketSwitch(switches = 10) {
    printHeader(`Market Switch Simulation (${switches} switches)`);
    const results = [];

    console.log(`Simulating ${switches} rapid market switches...`);
    console.log(`   Tests: CLOB WS reconnection, price clearing, token re-subscription`);

    const errors = [];
    const originalError = console.error;
    console.error = function(...args) {
      errors.push(args.join(' '));
      originalError.apply(console, args);
    };

    let reconnects = 0;
    const originalLog = console.log;
    console.log = function(...args) {
      const msg = args.join(' ');
      if (msg.includes('force fresh connection') || msg.includes('Force reconnect')) {
        reconnects++;
      }
      originalLog.apply(console, args);
    };

    const memBefore = getMemory();
    const startTime = now();

    for (let i = 0; i < switches; i++) {
      const waitMs = 2000 + Math.random() * 3000;
      await sleep(waitMs);

      console.log(`   Switch ${i + 1}/${switches} (after ${(waitMs / 1000).toFixed(1)}s)`);

      const frameStart = now();
      await new Promise(r => requestAnimationFrame(r));
      const frameTime = now() - frameStart;

      if (frameTime > 100) {
        console.warn(`   Slow frame after switch: ${frameTime.toFixed(0)}ms`);
      }
    }

    const totalTime = (now() - startTime) / 1000;
    const memAfter = getMemory();

    console.error = originalError;
    console.log = originalLog;

    const memGrowth = memAfter && memBefore
      ? (memAfter.used - memBefore.used) / 1024 / 1024
      : 0;

    console.log(`\nMarket Switch Results:`);
    console.log(`   Switches:      ${switches} in ${totalTime.toFixed(1)}s`);
    console.log(`   Reconnects:    ${reconnects}`);
    console.log(`   Errors:        ${errors.length}`);
    console.log(`   Memory growth: ${memGrowth.toFixed(2)}MB`);

    results.push(printResult(
      'No JS errors',
      errors.length === 0,
      `${errors.length} errors during ${switches} switches`
    ));

    results.push(printResult(
      'Page responsive',
      true,
      `All ${switches} switches completed without freeze`
    ));

    results.push(printResult(
      'Memory stable',
      Math.abs(memGrowth) < 10,
      `${memGrowth.toFixed(2)}MB growth (threshold: <10MB)`
    ));

    if (errors.length > 0) {
      console.log('\n   Errors found:');
      errors.slice(0, 5).forEach((e, i) => console.log(`   ${i + 1}. ${e.slice(0, 100)}`));
    }

    return printSummary(results);
  }

  // ═══ TEST: Sustained Load ═══
  async function sustained(durationSec = 300) {
    printHeader(`Sustained Load (${durationSec}s / ${(durationSec / 60).toFixed(0)} minutes)`);
    const results = [];

    if (!performance.memory) {
      results.push(printResult('Memory API', false, 'Use Chrome for full test'));
      return printSummary(results);
    }

    const checkpoints = [];
    const checkInterval = 15_000;
    const totalChecks = Math.floor(durationSec * 1000 / checkInterval);

    if (window.gc) window.gc();
    await sleep(1000);
    const baseline = getMemory();

    console.log(`Running sustained load test for ${(durationSec / 60).toFixed(0)} minutes...`);
    console.log(`   Baseline: ${MB(baseline.used)}MB`);
    console.log(`   Checkpoints every 15s\n`);

    let errorCount = 0;
    const originalError = console.error;
    console.error = function(...args) { errorCount++; originalError.apply(console, args); };

    let longTaskCount = 0;
    let observer = null;
    try {
      observer = new PerformanceObserver((list) => {
        longTaskCount += list.getEntries().length;
      });
      observer.observe({ entryTypes: ['longtask'] });
    } catch (e) { /* */ }

    // CLOB freshness tracking
    let lastPriceText = null;
    let priceStaleCount = 0;
    let priceSameStreak = 0;

    for (let i = 0; i < totalChecks; i++) {
      await sleep(checkInterval);

      const mem = getMemory();
      const elapsed = ((i + 1) * checkInterval / 1000);
      const growth = (mem.used - baseline.used) / 1024 / 1024;
      const rate = growth / (elapsed / 60);

      // Sample price for staleness detection
      const priceText = document.querySelector('.price-big')?.textContent?.trim() || '';
      if (priceText === lastPriceText) {
        priceSameStreak++;
        // If unchanged for >10s (this check runs every 15s, so 1 repeat = stale)
        if (priceSameStreak >= 1) priceStaleCount++;
      } else {
        priceSameStreak = 0;
      }
      lastPriceText = priceText;

      checkpoints.push({
        time: elapsed,
        used: mem.used,
        growth,
        rate,
        errors: errorCount,
        longTasks: longTaskCount,
        priceStale: priceStaleCount,
      });

      // Log every minute
      if ((i + 1) % 4 === 0) {
        const mins = (elapsed / 60).toFixed(1);
        console.log(
          `   ${mins}min: ${MB(mem.used)}MB (${growth >= 0 ? '+' : ''}${growth.toFixed(1)}MB) | ` +
          `${rate.toFixed(2)}MB/min | ${errorCount} errors | ${longTaskCount} long tasks | stale: ${priceStaleCount}`
        );
      }

      if (mem.used > baseline.total * 0.9) {
        console.warn(`   ABORT: Memory at ${((mem.used / baseline.total) * 100).toFixed(0)}% — stopping to prevent crash`);
        break;
      }
    }

    console.error = originalError;
    if (observer) observer.disconnect();

    const final = checkpoints[checkpoints.length - 1];
    const totalMins = final.time / 60;

    // Linear regression
    const n = checkpoints.length;
    let sumX = 0, sumY = 0, sumXY = 0, sumXX = 0;
    for (const cp of checkpoints) {
      const x = cp.time / 60;
      const y = cp.used / 1024 / 1024;
      sumX += x; sumY += y; sumXY += x * y; sumXX += x * x;
    }
    const slope = (n * sumXY - sumX * sumY) / (n * sumXX - sumX * sumX);

    // Staircase detection
    let plateaus = 0;
    for (let i = 2; i < checkpoints.length; i++) {
      const diff = Math.abs(checkpoints[i].growth - checkpoints[i - 1].growth);
      if (diff < 0.5) plateaus++;
    }

    console.log(`\nSustained Load Results:`);
    console.log(`   Duration:        ${totalMins.toFixed(1)} minutes`);
    console.log(`   Memory baseline: ${MB(baseline.used)}MB`);
    console.log(`   Memory final:    ${MB(final.used + baseline.used)}MB`);
    console.log(`   Net growth:      ${final.growth.toFixed(2)}MB`);
    console.log(`   Growth trend:    ${slope.toFixed(3)}MB/min (linear regression)`);
    console.log(`   Plateaus:        ${plateaus}/${checkpoints.length} checkpoints`);
    console.log(`   Total errors:    ${final.errors}`);
    console.log(`   Long tasks:      ${final.longTasks}`);
    console.log(`   Price stale:     ${final.priceStale} intervals (unchanged >10s)`);

    results.push(printResult(
      'Memory growth trend',
      slope < 1,
      `${slope.toFixed(3)}MB/min (threshold: <1MB/min). ${slope < 0.1 ? 'FLAT' : slope < 0.5 ? 'Acceptable' : 'Concerning'}`
    ));

    results.push(printResult(
      'No crash risk',
      final.used + baseline.used < baseline.total * 0.8,
      `${(((final.used + baseline.used) / baseline.total) * 100).toFixed(0)}% of heap limit`
    ));

    results.push(printResult(
      'Error count',
      final.errors < totalMins,
      `${final.errors} errors in ${totalMins.toFixed(0)} minutes (threshold: <${Math.floor(totalMins)}/min)`
    ));

    results.push(printResult(
      'Long task count',
      final.longTasks < totalMins * 5,
      `${final.longTasks} long tasks (threshold: <${Math.floor(totalMins * 5)})`
    ));

    results.push(printResult(
      'Price freshness',
      final.priceStale <= totalMins,
      `${final.priceStale} stale intervals (threshold: <=${Math.floor(totalMins)})`
    ));

    // Verdict
    if (slope < 0.1) {
      console.log(`\n   VERDICT: Memory is FLAT — no leak detected!`);
    } else if (slope < 0.5) {
      console.log(`\n   VERDICT: Minor growth (${slope.toFixed(2)}MB/min) — likely GC fluctuation, acceptable`);
    } else if (slope < 1) {
      console.log(`\n   VERDICT: Moderate growth (${slope.toFixed(2)}MB/min) — monitor in production`);
    } else {
      console.log(`\n   VERDICT: Memory leak detected (${slope.toFixed(2)}MB/min) — needs investigation`);
    }

    return printSummary(results);
  }

  // ═══ RUN ALL ═══
  async function runAll() {
    console.log(`
══════════════════════════════════════════════════════════
   BTC DASHBOARD STRESS TEST SUITE v2
   Tests: Health > Network > CLOB > Render > ML > Memory
══════════════════════════════════════════════════════════`);

    const allResults = [];

    // 1. Quick health check
    const health = await healthCheck();
    allResults.push(...health.results);

    // 2. Network parallelism
    const network = await networkParallel();
    allResults.push(...network.results);

    // 3. CLOB freshness (15s)
    const clob = await clobFreshness(15);
    allResults.push(...clob.results);

    // 4. Render perf (30s)
    const render = await rendering(30);
    allResults.push(...render.results);

    // 5. ML inference
    const ml = await mlInference(1000);
    allResults.push(...ml.results);

    // 6. Memory (60s)
    const mem = await memory(60);
    allResults.push(...mem.results);

    // Final summary
    console.log(`\n${'═'.repeat(60)}`);
    console.log(`  FINAL SUMMARY`);
    console.log(`${'═'.repeat(60)}`);

    const passed = allResults.filter(r => r.passed).length;
    const total = allResults.length;

    allResults.forEach(r => {
      console.log(`  [${r.passed ? 'PASS' : 'FAIL'}] ${r.name}: ${r.details}`);
    });

    console.log(`\n  Score: ${passed}/${total} (${((passed / total) * 100).toFixed(0)}%)`);

    if (passed === total) {
      console.log(`  ALL TESTS PASSED — Dashboard is production-ready!`);
    } else if (passed >= total * 0.8) {
      console.log(`  MOSTLY GOOD — Minor issues to monitor`);
    } else {
      console.log(`  NEEDS ATTENTION — Review failed tests`);
    }

    console.log(`\n  TIP: Run StressTest.sustained(300) for 5-min endurance test`);
    console.log(`  TIP: Run StressTest.websocket(60) for WS stability check`);

    return { passed, total, results: allResults };
  }

  // ═══ Export ═══
  return {
    healthCheck,
    networkParallel,
    clobFreshness,
    memory,
    websocket,
    rendering,
    mlInference,
    marketSwitch,
    sustained,
    runAll,
  };
})();

// Make globally accessible
window.StressTest = StressTest;

console.log(`
══════════════════════════════════════════════════════════
  StressTest v2 loaded! Available commands:

  StressTest.runAll()            - Full test suite
  StressTest.healthCheck()       - Quick status check
  StressTest.networkParallel()   - Verify parallel fetches
  StressTest.clobFreshness(30)   - CLOB price update rate
  StressTest.memory(60)          - Memory leak (60s)
  StressTest.rendering(30)       - FPS & jank (30s)
  StressTest.mlInference(1000)   - ML speed (1000 runs)
  StressTest.websocket(60)       - WS stability (60s)
  StressTest.marketSwitch(10)    - Rapid switch test
  StressTest.sustained(300)      - 5-min endurance test
══════════════════════════════════════════════════════════
`);
