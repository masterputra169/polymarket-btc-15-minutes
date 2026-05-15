# Tier-1 TypeScript-Check Audit Report

**Scan date:** 2026-05-14
**Tool:** `tsc -p jsconfig.json` (TypeScript 5.9.3 with `checkJs: true`)
**Scope:** `bot/**/*.js`, `src/**/*.{js,jsx}` (excluding node_modules + generated)
**Total errors found:** 294
**Risk:** ZERO — read-only scan, no files modified

## Audit Philosophy

Tier-1 = TS checker on existing JS WITHOUT migrating files. Goal: surface
latent bugs that would otherwise hide until they crash production.

## Severity Classification

| Severity | Definition | Count |
|---|---|---|
| 🔴 CRITICAL | Runtime ReferenceError / TypeError waiting to fire | **3** |
| 🟠 HIGH | Data corruption / silent wrong behavior | **8** |
| 🟡 MEDIUM | Type inference mismatch (likely OK but worth review) | ~50 |
| 🟢 LOW | Library type strictness / inferred ambient types | ~230 |

## 🔴 CRITICAL — Must Fix (TDZ + Runtime Crashes)

### 1. `postTradeAnalyst.js:126` — `rlSection` used before declaration
```
TS2448: Block-scoped variable 'rlSection' used before its declaration.
```
Same TDZ class as `alreadyHasPosition` bug fixed earlier today. Template literal
references `${rlSection}` at line 126, but `let rlSection = ''` is at line 139.
If template evaluates before line 139, throws `ReferenceError`.

**Impact:** Post-trade analysis AI feature crashes silently. Function may catch
the error but lose context.
**Fix:** Move `rlSection` initialization before the template literal assignment.

### 2. `loop.js:939` — `timeLeftMin` used before declaration
```
TS2448: Block-scoped variable 'timeLeftMin' used before its declaration.
```
`captureEntrySnapshot({...timeLeftMin, ...})` at line 939, but `let timeLeftMin`
declared later. Triggers in phantom-fill-on-market-switch code path.

**Impact:** Bot would log `Cannot access timeLeftMin before initialization`
during specific limit-fill edge cases. Position still recorded but snapshot
incomplete.
**Fix:** Move `timeLeftMin` declaration earlier in poll loop.

### 3. `driftDetector.js:176` — invalid `detached` option in execSync
```
TS2769: Object literal may only specify known properties, and 'detached'
        does not exist in type 'ExecSyncOptionsWithStringEncoding'.
```
`execSync('command', { detached: true })` — `detached` is for `spawn`, not
`execSync`. Silently ignored → spawned process is NOT actually detached →
parent process may hang on child shutdown.

**Impact:** If drift detector triggers retraining, process management broken.
**Fix:** Use `spawn()` with `detached: true, stdio: 'ignore'` and `.unref()`.

## 🟠 HIGH — Data Correctness Issues

### 4. `loop.js:1724,1732,2243,2283` — `recordTrade` missing required `orderId` + `actualCost`
```
TS2345: Property 'actualCost' is missing in type '...'
        Type '...' is missing properties: orderId, actualCost
```
4 call sites pass partial trade data without `orderId` and `actualCost`. Means
trade journal entries from these paths have undefined/missing critical fields.

**Impact:** Trade reconciler can't match entries → journal verification gaps.
**Fix:** Pass `orderId` (from order response) + `actualCost` (size × price) at
all call sites.

### 5. `loop.js:1733` — wrong arg count
```
TS2554: Expected 2 arguments, but got 1.
```
Function call missing required second argument. Will likely use `undefined` →
NaN propagation or null deref downstream.

**Fix:** Check function signature, pass missing arg.

### 6. `fetch-trades.js:18` — imports deprecated SDK
```
TS2307: Cannot find module '@polymarket/clob-client' or its corresponding
        type declarations.
```
Imports old `@polymarket/clob-client` instead of `clob-client-v2`. Either
module not installed (script broken) or running against legacy API.

**Fix:** Update to `@polymarket/clob-client-v2` and update API patterns.

### 7. `limitOrderManager.js:160` — silently dropped params
```
TS2339: Property 'btcDelta1m' does not exist on type '{...}'.
TS2339: Property 'spread' does not exist on type '{...}'.
```
Caller passes `btcDelta1m` and `spread` but function signature doesn't accept
them → silently dropped. These looked-intended-to-be-used filter inputs.

**Fix:** Either add to function signature or remove from call site.

### 8. `signalComputation.js:61` + `loop.js:1186` — `smartFlowSignal` not in interface
Caller passes `smartFlowSignal`, function interface doesn't declare it →
silently ignored.

### 9. `smartMoneyTracker.js:165,229` — `direction` returns wider type
```
TS2322: Type 'string' is not assignable to type '"UP" | "DOWN" | "NEUTRAL"'.
```
Function declared to return one of 3 specific strings, but returns generic
string. Possible bug where direction could be wrong value like 'up' (lowercase)
or empty string.

### 10. `settlement.js:273,300,329` — `ptbRaw` not in interface
Settlement passes extra `ptbRaw` field that consumer doesn't expect. Either
typo or dead-code field. Caller uses it at lines 300/329 but type says it
doesn't exist → silent failure.

### 11. `loop.js:1223` — assigning object to number
```
TS2322: Type '{ slug, value, updatedAt }' is not assignable to type 'number'.
```
Variable typed as `number` but receives `{ slug, value, updatedAt }` object.
Subsequent numeric ops will produce `NaN`.

## 🟡 MEDIUM — Type Mismatches Worth Reviewing

- Ethers v6 compat: 6 files use `_signTypedData` (v5 name) instead of
  `signTypedData` (v6). Patched in some files (e.g., `derive-credentials.js:18`
  has compat shim), but others (e.g., `fetch-trades.js`) may not.
- `loop.js:568,578,585` — accessing `.rejected`, `.uncertain`, `.verified`
  on objects that don't declare those properties. Either type inference
  missed actual shape or these are bugs.
- `loop.js:859` — calling `.then(...)` on object that might not be a Promise.
- `loop.js:1534,1648,1707,1757,1767,1768` — multiple property-mismatch
  patterns in cut-loss/take-profit/decision objects.
- `tradePipeline.js:85` — `orderbookUp`/`orderbookDown` extras in input.
- `usdcSync.js:182,188` — `balance` and `local` not in return type.

## 🟢 LOW — Inference Noise

- ~230 errors are TS inferring strict types where JS is permissive (e.g.,
  ApiKeyCreds shape, Wallet vs ClobSigner adapters).
- These won't cause runtime errors but indicate spots where JSDoc would
  improve clarity.

## Suggested Fix Priority

### Phase 1 — CRITICAL (today, if possible during observation mode)
- [ ] Fix `postTradeAnalyst.js:126` TDZ
- [ ] Fix `loop.js:939` TDZ
- [ ] Fix `driftDetector.js:176` execSync option

### Phase 2 — HIGH (post-observation, after v19 stable)
- [ ] Audit recordTrade call sites — add missing `orderId` + `actualCost`
- [ ] Fix `loop.js:1733` missing arg
- [ ] Update `fetch-trades.js` to clob-client-v2
- [ ] Sync limitOrderManager params with caller
- [ ] Fix smartMoneyTracker return type narrowing
- [ ] Investigate ptbRaw in settlement
- [ ] Investigate `loop.js:1223` object→number assign

### Phase 3 — MEDIUM (when adding test coverage)
- [ ] Add JSDoc types to public APIs
- [ ] Verify ethers v6 compat shims complete
- [ ] Document return type contracts

### Phase 4 — LOW (only during full TS migration)
- Tightening strict types in jsconfig
- Migrating to `.ts` files

## Run Commands

```bash
# Full scan
npm run typecheck

# Bot only
npm run typecheck:bot

# Frontend only
npm run typecheck:frontend
```

## Conclusion

Tier-1 scan **was worth it** — found 3 CRITICAL bugs that match the class of
the bug we manually discovered today (TDZ). The TypeScript compiler costs $0
setup, ran in 30s, and gave us a permanent regression-detection capability.

**Recommendation:** Don't do full TS migration yet — wait for v19 to stabilize.
But keep `npm run typecheck` in CI / pre-commit hooks NOW to prevent new
type-class bugs from sneaking in.

This is the **80% value, 20% effort** option.
