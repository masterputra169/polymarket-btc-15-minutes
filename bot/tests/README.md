# Bot Unit Tests

Minimal test coverage untuk hot/critical modules. Foundation untuk future
TypeScript migration (tests = safety net for refactor).

## Run

```bash
npm run test           # vitest run (CI mode)
npm run test:watch     # vitest watch
```

## Coverage Strategy

Tier 1 (existing): TS checker (`npm run typecheck`)
Tier 2 (this dir): Unit tests for pure functions
Tier 3 (future): Integration tests requiring mock CLOB/Binance
Tier 4 (future): E2E with shadow mode

## Files

- `treeEval.test.js` — XGBoost tree traversal correctness
- `edge.test.js` — Phase-based edge decision logic
- `tradeFilters.test.js` — Trade filter gates (15 filters)

## Adding Tests

For each test:
1. Pure function with deterministic input/output
2. No I/O, no module-level state
3. No bot restart required to verify
