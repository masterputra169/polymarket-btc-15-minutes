/*
 * Native C11 multi-threaded Monte Carlo accelerator for POLY//15 Study Portal.
 *
 * Runs exact 1,000,000-path simulations across all horizons (up to 10,000 trades)
 * using 64-bit xorshift64* PRNG (per-path SplitMix64 seed -> thread-count invariant),
 * Float32 bankroll storage + 16-bit radix sort, and uint16 drawdown counting sort.
 * Peak RSS for 1,000,000 paths x 22 fan steps x 7 horizons is ~105 MB.
 *
 * Build: gcc -O3 -pthread -Wall -Wextra scripts/study/mc_accel.c -o mc_accel -lm
 */

#include <math.h>
#include <pthread.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#ifndef M_PI
#define M_PI 3.14159265358979323846
#endif

static inline uint64_t splitmix64(uint64_t z) {
  z += 0x9e3779b97f4a7c15ULL;
  z = (z ^ (z >> 30)) * 0xbf58476d1ce4e5b9ULL;
  z = (z ^ (z >> 27)) * 0x94d049bb133111ebULL;
  return z ^ (z >> 31);
}

static inline uint64_t xorshift64star(uint64_t *state) {
  uint64_t x = *state;
  x ^= x >> 12;
  x ^= x << 25;
  x ^= x >> 27;
  *state = x;
  return x * 0x2545F4914F6CDD1DULL;
}

static inline double next_uniform(uint64_t *rng) {
  return ((double)(xorshift64star(rng) >> 11) + 0.5) * (1.0 / 9007199254740992.0);
}

static double sample_gamma(double shape, uint64_t *rng) {
  if (!(shape > 0.0)) return 0.0;
  if (shape < 1.0) {
    double u = next_uniform(rng);
    if (u <= 1e-12) u = 1e-12;
    return sample_gamma(shape + 1.0, rng) * pow(u, 1.0 / shape);
  }
  double d = shape - 1.0 / 3.0;
  double c = 1.0 / sqrt(9.0 * d);
  for (;;) {
    double u1 = next_uniform(rng);
    double u2 = next_uniform(rng);
    if (u1 <= 1e-12) u1 = 1e-12;
    double z = sqrt(-2.0 * log(u1)) * cos(2.0 * M_PI * u2);
    double v = 1.0 + c * z;
    if (v <= 0.0) continue;
    double v3 = v * v * v;
    double u = next_uniform(rng);
    if (u <= 1e-12) u = 1e-12;
    double z2 = z * z;
    if (u < 1.0 - 0.0331 * z2 * z2) return d * v3;
    if (log(u) < 0.5 * z2 + d * (1.0 - v3 + log(v3))) return d * v3;
  }
}

static double sample_beta(double alpha, double beta, uint64_t *rng) {
  double gx = sample_gamma(alpha, rng);
  double gy = sample_gamma(beta, rng);
  double sum = gx + gy;
  return sum > 0.0 ? gx / sum : 0.5;
}

static inline double r2(double x) {
  double v = floor(x * 100.0 + (x >= 0.0 ? 0.5 : -0.5)) / 100.0;
  return fabs(v) < 0.005 ? 0.0 : v;
}

static inline double clamp_d(double x, double lo, double hi) {
  return x < lo ? lo : (x > hi ? hi : x);
}

/* 2-pass 16-bit radix sort for non-negative finite IEEE-754 floats. */
static void radix_sort_floats(float *arr, float *tmp, int n) {
  static const int BUCKETS = 65536;
  uint32_t *counts = (uint32_t *)calloc((size_t)BUCKETS, sizeof(uint32_t));
  if (!counts) {
    fprintf(stderr, "mc_accel: OOM radix counts\n");
    exit(1);
  }
  uint32_t *a = (uint32_t *)arr;
  uint32_t *t = (uint32_t *)tmp;

  for (int i = 0; i < n; i++) {
    if (!(arr[i] > 0.0f) || !isfinite(arr[i])) arr[i] = 0.0f;
    counts[a[i] & 0xFFFFu]++;
  }
  uint32_t sum = 0;
  for (int b = 0; b < BUCKETS; b++) {
    uint32_t c = counts[b];
    counts[b] = sum;
    sum += c;
  }
  for (int i = 0; i < n; i++) {
    uint32_t v = a[i];
    t[counts[v & 0xFFFFu]++] = v;
  }

  memset(counts, 0, (size_t)BUCKETS * sizeof(uint32_t));
  for (int i = 0; i < n; i++) {
    counts[t[i] >> 16]++;
  }
  sum = 0;
  for (int b = 0; b < BUCKETS; b++) {
    uint32_t c = counts[b];
    counts[b] = sum;
    sum += c;
  }
  for (int i = 0; i < n; i++) {
    uint32_t v = t[i];
    a[counts[v >> 16]++] = v;
  }
  free(counts);
}

typedef struct {
  char id[128];
  int modeCode;
  int32_t seed;
  double bayesianAlpha;
  double bayesianBeta;
  double riskPct;
  double minBetUsd;
  double maxBetUsd;
  double pStress;
  double stopFloor;
  double compStopFloor;
  int nSamples;
  double *allPnl;
  double *allRet;
  int nWin;
  double *winArr;
  int nLoss;
  double *lossArr;
} ScenarioInput;

typedef struct {
  const ScenarioInput *sc;
  double startBankroll;
  int nPaths;
  int pStart;
  int pEnd;
  int nFan;
  const int *fanSteps;
  const int *horizonIdxOfFan;
  float **stepVals;
  uint16_t **horizonDds;
  int sampleStride;
  int samplePathCount;
  double **samplePaths;
} WorkerArgs;

static void *sim_worker(void *arg) {
  WorkerArgs *w = (WorkerArgs *)arg;
  const ScenarioInput *sc = w->sc;
  const int modeCode = sc->modeCode;
  const double startBankroll = w->startBankroll;
  const double stopFloor = sc->stopFloor;
  const double compStopFloor = sc->compStopFloor;
  const double riskPct = sc->riskPct;
  const double minBetUsd = sc->minBetUsd;
  const double maxBetUsd = sc->maxBetUsd;
  const int nSamples = sc->nSamples;
  const int nWin = sc->nWin;
  const int nLoss = sc->nLoss;
  const double *allPnl = sc->allPnl;
  const double *allRet = sc->allRet;
  const double *winArr = sc->winArr;
  const double *lossArr = sc->lossArr;
  const int nFan = w->nFan;
  const int *fanSteps = w->fanSteps;
  const int *horizonIdxOfFan = w->horizonIdxOfFan;
  const uint32_t pStressThresh = (uint32_t)(sc->pStress * 4294967296.0);
  const uint64_t seedHi = ((uint64_t)(uint32_t)sc->seed) << 32;

  for (int p = w->pStart; p < w->pEnd; p++) {
    uint64_t rng = splitmix64(seedHi ^ (uint64_t)(p + 1));
    if (rng == 0) rng = 0x9e3779b97f4a7c15ULL;

    double b = startBankroll;
    double peak = startBankroll;
    double maxDd = 0.0;
    double minRatio = 1.0;
    double ddThresh = startBankroll;
    uint32_t pThresh = pStressThresh;

    if (modeCode == 1) {
      double pDraw = clamp_d(sample_beta(sc->bayesianAlpha, sc->bayesianBeta, &rng), 0.05, 0.99);
      pThresh = (uint32_t)(pDraw * 4294967296.0);
    }

    int sampleIdx = -1;
    if (p % w->sampleStride == 0) {
      int candidate = p / w->sampleStride;
      if (candidate < w->samplePathCount) {
        sampleIdx = candidate;
        w->samplePaths[sampleIdx][0] = startBankroll;
      }
    }

    int prevStep = 0;
    for (int fi = 1; fi < nFan; fi++) {
      int target = fanSteps[fi];
      int count = target - prevStep;

      if (modeCode == 0) {
        for (int k = 0; k < count; k++) {
          if (b < stopFloor) { b = 0.0; break; }
          uint64_t r = xorshift64star(&rng);
          uint32_t idx = (uint32_t)(((r >> 32) * (uint64_t)nSamples) >> 32);
          b += allPnl[idx];
          if (b <= 0.0) {
            b = 0.0;
            maxDd = 1.0;
            minRatio = 0.0;
            ddThresh = 0.0;
            break;
          }
          if (b > peak) {
            peak = b;
            ddThresh = peak * minRatio;
          } else if (b < ddThresh) {
            minRatio = b / peak;
            maxDd = 1.0 - minRatio;
            ddThresh = b;
          }
        }
      } else if (modeCode == 1 || modeCode == 3) {
        for (int k = 0; k < count; k++) {
          if (b < stopFloor) { b = 0.0; break; }
          uint64_t r = xorshift64star(&rng);
          uint32_t hi = (uint32_t)(r >> 32);
          uint32_t lo = (uint32_t)(r & 0xFFFFFFFFu);
          if (hi < pThresh) {
            uint32_t idx = (uint32_t)(((uint64_t)lo * (uint64_t)nWin) >> 32);
            b += winArr[idx];
          } else {
            uint32_t idx = (uint32_t)(((uint64_t)lo * (uint64_t)nLoss) >> 32);
            b += lossArr[idx];
          }
          if (b <= 0.0) {
            b = 0.0;
            maxDd = 1.0;
            minRatio = 0.0;
            ddThresh = 0.0;
            break;
          }
          if (b > peak) {
            peak = b;
            ddThresh = peak * minRatio;
          } else if (b < ddThresh) {
            minRatio = b / peak;
            maxDd = 1.0 - minRatio;
            ddThresh = b;
          }
        }
      } else {
        for (int k = 0; k < count; k++) {
          if (b < compStopFloor) { b = 0.0; break; }
          double bet = b * riskPct;
          if (bet < minBetUsd) bet = minBetUsd;
          else if (bet > maxBetUsd) bet = maxBetUsd;
          if (bet > b) bet = b;
          uint64_t r = xorshift64star(&rng);
          uint32_t idx = (uint32_t)(((r >> 32) * (uint64_t)nSamples) >> 32);
          b += bet * allRet[idx];
          if (b <= 0.0) {
            b = 0.0;
            maxDd = 1.0;
            minRatio = 0.0;
            ddThresh = 0.0;
            break;
          }
          if (b > peak) {
            peak = b;
            ddThresh = peak * minRatio;
          } else if (b < ddThresh) {
            minRatio = b / peak;
            maxDd = 1.0 - minRatio;
            ddThresh = b;
          }
        }
      }

      w->stepVals[fi][p] = (float)b;
      if (sampleIdx >= 0) w->samplePaths[sampleIdx][fi] = b;
      int hi = horizonIdxOfFan[fi];
      if (hi >= 0) {
        double scaled = maxDd * 65535.0;
        if (scaled < 0.0) scaled = 0.0;
        if (scaled > 65535.0) scaled = 65535.0;
        w->horizonDds[hi][p] = (uint16_t)(scaled + 0.5);
      }
      prevStep = target;
    }
  }
  return NULL;
}

static inline int q_idx(double pct, int n) {
  int i = (int)floor((pct / 100.0) * (double)(n - 1));
  if (i < 0) return 0;
  if (i >= n) return n - 1;
  return i;
}

static void emit_horizon_json(
    const float *sortedVals,
    const uint16_t *ddArr,
    double startBankroll,
    int nPaths) {
  double p5 = r2(sortedVals[q_idx(5.0, nPaths)]);
  double p10 = r2(sortedVals[q_idx(10.0, nPaths)]);
  double p25 = r2(sortedVals[q_idx(25.0, nPaths)]);
  double p50 = r2(sortedVals[q_idx(50.0, nPaths)]);
  double p75 = r2(sortedVals[q_idx(75.0, nPaths)]);
  double p90 = r2(sortedVals[q_idx(90.0, nPaths)]);
  double p95 = r2(sortedVals[q_idx(95.0, nPaths)]);

  double minV = (double)sortedVals[0];
  double maxV = (double)sortedVals[nPaths - 1];
  double lo = minV;
  double hi = (maxV - minV < 1e-6) ? (minV + 1.0) : maxV;
  const int nBins = 22;
  double step = (hi - lo) / (double)nBins;
  int finalHistCounts[22];
  memset(finalHistCounts, 0, sizeof(finalHistCounts));

  double sum = 0.0;
  int cntProfit = 0, cntDouble = 0, cntFiveX = 0, cntRuinHalf = 0, cntBankrupt = 0;
  double bankruptThresh = fmin(2.5, startBankroll * 0.1);
  double profitThresh = startBankroll + 1e-9;
  double doubleThresh = startBankroll * 2.0;
  double fiveXThresh = startBankroll * 5.0;
  double halfThresh = startBankroll * 0.5;

  for (int i = 0; i < nPaths; i++) {
    double v = (double)sortedVals[i];
    sum += v;
    if (v > profitThresh) cntProfit++;
    if (v >= doubleThresh) cntDouble++;
    if (v >= fiveXThresh) cntFiveX++;
    if (v <= halfThresh) cntRuinHalf++;
    if (v <= bankruptThresh) cntBankrupt++;
    int bin = (int)floor((v - lo) / step);
    if (bin < 0) bin = 0;
    else if (bin >= nBins) bin = nBins - 1;
    finalHistCounts[bin]++;
  }

  int tailCount = (int)ceil(0.05 * (double)nPaths);
  if (tailCount < 1) tailCount = 1;
  if (tailCount > nPaths) tailCount = nPaths;
  double tailSum = 0.0;
  for (int i = 0; i < tailCount; i++) tailSum += (double)sortedVals[i];
  double cvar95Final = r2(tailSum / (double)tailCount);

  double mean = r2(sum / (double)nPaths);
  double base = startBankroll > 0.0 ? startBankroll : 1.0;

  /* Drawdown exact summary via 65536-bucket counting sort */
  static uint32_t ddCounts[65536];
  memset(ddCounts, 0, sizeof(ddCounts));
  for (int i = 0; i < nPaths; i++) ddCounts[ddArr[i]]++;

  int idx50 = q_idx(50.0, nPaths);
  int idx95 = q_idx(95.0, nPaths);
  int idx99 = q_idx(99.0, nPaths);
  int tailStart = (int)floor(0.95 * (double)nPaths);
  if (tailStart < 0) tailStart = 0;
  if (tailStart >= nPaths) tailStart = nPaths - 1;

  double dd50 = 0.0, dd95 = 0.0, dd99 = 0.0;
  int got50 = 0, got95 = 0, got99 = 0;
  double tailDdSum = 0.0;
  int cntOver25 = 0, cntOver50 = 0;
  int ddHistCounts[20];
  memset(ddHistCounts, 0, sizeof(ddHistCounts));

  int cum = 0;
  for (int v = 0; v < 65536; v++) {
    uint32_t c = ddCounts[v];
    if (c == 0) continue;
    int prevCum = cum;
    cum += (int)c;
    double frac = (double)v / 65535.0;
    double pct = frac * 100.0;

    if (!got50 && cum > idx50) { dd50 = pct; got50 = 1; }
    if (!got95 && cum > idx95) { dd95 = pct; got95 = 1; }
    if (!got99 && cum > idx99) { dd99 = pct; got99 = 1; }

    if (cum > tailStart) {
      int overlapStart = prevCum > tailStart ? prevCum : tailStart;
      int overlap = cum - overlapStart;
      tailDdSum += (double)overlap * frac;
    }

    if (pct >= 25.0) cntOver25 += (int)c;
    if (pct >= 50.0) cntOver50 += (int)c;
    int bin = (int)floor(pct / 5.0);
    if (bin < 0) bin = 0;
    else if (bin >= 20) bin = 19;
    ddHistCounts[bin] += (int)c;
  }

  int tailDdN = nPaths - tailStart;
  if (tailDdN < 1) tailDdN = 1;
  double cvar95MaxDdPct = r2((tailDdSum / (double)tailDdN) * 100.0);

  printf("{");
  printf("\"p5\":%.2f,\"cvar95Final\":%.2f,\"p10\":%.2f,\"p25\":%.2f,\"p50\":%.2f,\"p75\":%.2f,\"p90\":%.2f,\"p95\":%.2f,",
         p5, cvar95Final, p10, p25, p50, p75, p90, p95);
  printf("\"mean\":%.2f,\"min\":%.2f,\"max\":%.2f,", mean, r2(minV), r2(maxV));
  printf("\"medianReturnPct\":%.2f,\"meanReturnPct\":%.2f,",
         r2(((p50 - startBankroll) / base) * 100.0),
         r2(((mean - startBankroll) / base) * 100.0));
  printf("\"probProfitPct\":%.2f,\"probDoublePct\":%.2f,\"probFiveXPct\":%.2f,\"probRuinHalfPct\":%.2f,\"probBankruptPct\":%.2f,",
         r2(((double)cntProfit / (double)nPaths) * 100.0),
         r2(((double)cntDouble / (double)nPaths) * 100.0),
         r2(((double)cntFiveX / (double)nPaths) * 100.0),
         r2(((double)cntRuinHalf / (double)nPaths) * 100.0),
         r2(((double)cntBankrupt / (double)nPaths) * 100.0));

  printf("\"finalHist\":{\"counts\":[");
  for (int b = 0; b < nBins; b++) printf("%s%d", b ? "," : "", finalHistCounts[b]);
  printf("],\"edges\":[");
  for (int b = 0; b <= nBins; b++) printf("%s%.2f", b ? "," : "", r2(lo + (double)b * step));
  printf("]},");

  printf("\"medianMaxDdPct\":%.2f,\"p95MaxDdPct\":%.2f,\"cvar95MaxDdPct\":%.2f,\"p99MaxDdPct\":%.2f,",
         r2(dd50), r2(dd95), cvar95MaxDdPct, r2(dd99));
  printf("\"probDdOver25Pct\":%.2f,\"probDdOver50Pct\":%.2f,",
         r2(((double)cntOver25 / (double)nPaths) * 100.0),
         r2(((double)cntOver50 / (double)nPaths) * 100.0));
  printf("\"ddHist\":{\"counts\":[");
  for (int b = 0; b < 20; b++) printf("%s%d", b ? "," : "", ddHistCounts[b]);
  printf("],\"edges\":[0,5,10,15,20,25,30,35,40,45,50,55,60,65,70,75,80,85,90,95,100]}");
  printf("}");
}

static double *read_double_array(int *outN) {
  int n = 0;
  if (scanf("%d", &n) != 1 || n <= 0) {
    fprintf(stderr, "mc_accel: invalid array length\n");
    exit(2);
  }
  double *arr = (double *)malloc((size_t)n * sizeof(double));
  if (!arr) {
    fprintf(stderr, "mc_accel: OOM array\n");
    exit(1);
  }
  for (int i = 0; i < n; i++) {
    if (scanf("%lf", &arr[i]) != 1) {
      fprintf(stderr, "mc_accel: unexpected EOF reading array\n");
      exit(2);
    }
  }
  *outN = n;
  return arr;
}

int main(void) {
  double startBankroll = 100.0;
  int nPaths = 10000;
  int nThreads = 2;
  if (scanf("%lf %d %d", &startBankroll, &nPaths, &nThreads) != 3) {
    fprintf(stderr, "mc_accel: invalid header\n");
    return 2;
  }
  if (nPaths < 10) nPaths = 10;
  if (nThreads < 1) nThreads = 1;
  if (nThreads > 16) nThreads = 16;
  if (nThreads > nPaths) nThreads = nPaths;

  int nFan = 0;
  if (scanf("%d", &nFan) != 1 || nFan < 2) return 2;
  int *fanSteps = (int *)malloc((size_t)nFan * sizeof(int));
  for (int i = 0; i < nFan; i++) {
    if (scanf("%d", &fanSteps[i]) != 1) return 2;
  }

  int nHorizons = 0;
  if (scanf("%d", &nHorizons) != 1 || nHorizons < 1) return 2;
  int *horizons = (int *)malloc((size_t)nHorizons * sizeof(int));
  for (int i = 0; i < nHorizons; i++) {
    if (scanf("%d", &horizons[i]) != 1) return 2;
  }

  int *horizonIdxOfFan = (int *)malloc((size_t)nFan * sizeof(int));
  int *fanIdxOfHorizon = (int *)malloc((size_t)nHorizons * sizeof(int));
  for (int fi = 0; fi < nFan; fi++) horizonIdxOfFan[fi] = -1;
  for (int hi = 0; hi < nHorizons; hi++) {
    fanIdxOfHorizon[hi] = -1;
    for (int fi = 0; fi < nFan; fi++) {
      if (fanSteps[fi] == horizons[hi]) {
        horizonIdxOfFan[fi] = hi;
        fanIdxOfHorizon[hi] = fi;
        break;
      }
    }
    if (fanIdxOfHorizon[hi] < 0) {
      fprintf(stderr, "mc_accel: horizon %d missing from fanSteps\n", horizons[hi]);
      return 2;
    }
  }

  int nScenarios = 0;
  if (scanf("%d", &nScenarios) != 1 || nScenarios < 1) return 2;

  /* Allocate reusable buffers across scenarios (keeps peak RSS ~105 MB at 1M paths) */
  float **stepVals = (float **)calloc((size_t)nFan, sizeof(float *));
  for (int fi = 1; fi < nFan; fi++) {
    stepVals[fi] = (float *)malloc((size_t)nPaths * sizeof(float));
    if (!stepVals[fi]) {
      fprintf(stderr, "mc_accel: OOM stepVals[%d]\n", fi);
      return 1;
    }
  }
  float *radixTmp = (float *)malloc((size_t)nPaths * sizeof(float));
  uint16_t **horizonDds = (uint16_t **)calloc((size_t)nHorizons, sizeof(uint16_t *));
  for (int hi = 0; hi < nHorizons; hi++) {
    horizonDds[hi] = (uint16_t *)malloc((size_t)nPaths * sizeof(uint16_t));
    if (!horizonDds[hi]) {
      fprintf(stderr, "mc_accel: OOM horizonDds[%d]\n", hi);
      return 1;
    }
  }

  const int samplePathCount = 6;
  const int sampleStride = (nPaths / samplePathCount) > 1 ? (nPaths / samplePathCount) : 1;
  double **samplePaths = (double **)malloc((size_t)samplePathCount * sizeof(double *));
  for (int s = 0; s < samplePathCount; s++) {
    samplePaths[s] = (double *)malloc((size_t)nFan * sizeof(double));
  }

  double *fanOut[7];
  for (int q = 0; q < 7; q++) fanOut[q] = (double *)malloc((size_t)nFan * sizeof(double));

  printf("[");
  for (int si = 0; si < nScenarios; si++) {
    ScenarioInput sc;
    memset(&sc, 0, sizeof(sc));
    if (scanf("%127s %d %d %lf %lf %lf %lf %lf %lf %lf %lf",
              sc.id, &sc.modeCode, &sc.seed,
              &sc.bayesianAlpha, &sc.bayesianBeta,
              &sc.riskPct, &sc.minBetUsd, &sc.maxBetUsd,
              &sc.pStress, &sc.stopFloor, &sc.compStopFloor) != 11) {
      fprintf(stderr, "mc_accel: invalid scenario %d header\n", si);
      return 2;
    }
    sc.allPnl = read_double_array(&sc.nSamples);
    int nRet = 0;
    sc.allRet = read_double_array(&nRet);
    sc.winArr = read_double_array(&sc.nWin);
    sc.lossArr = read_double_array(&sc.nLoss);

    for (int s = 0; s < samplePathCount; s++) {
      for (int fi = 0; fi < nFan; fi++) samplePaths[s][fi] = startBankroll;
    }

    pthread_t threads[16];
    WorkerArgs wargs[16];
    int chunk = (nPaths + nThreads - 1) / nThreads;
    int launched = 0;
    for (int t = 0; t < nThreads; t++) {
      int pStart = t * chunk;
      int pEnd = pStart + chunk;
      if (pStart >= nPaths) break;
      if (pEnd > nPaths) pEnd = nPaths;
      wargs[t].sc = &sc;
      wargs[t].startBankroll = startBankroll;
      wargs[t].nPaths = nPaths;
      wargs[t].pStart = pStart;
      wargs[t].pEnd = pEnd;
      wargs[t].nFan = nFan;
      wargs[t].fanSteps = fanSteps;
      wargs[t].horizonIdxOfFan = horizonIdxOfFan;
      wargs[t].stepVals = stepVals;
      wargs[t].horizonDds = horizonDds;
      wargs[t].sampleStride = sampleStride;
      wargs[t].samplePathCount = samplePathCount;
      wargs[t].samplePaths = samplePaths;
      if (nThreads == 1) {
        sim_worker(&wargs[t]);
      } else {
        if (pthread_create(&threads[t], NULL, sim_worker, &wargs[t]) != 0) {
          fprintf(stderr, "mc_accel: pthread_create failed\n");
          return 1;
        }
        launched++;
      }
    }
    for (int t = 0; t < launched; t++) pthread_join(threads[t], NULL);

    /* Sort each fan step in-place (step 0 is constant startBankroll) */
    double sbR2 = r2(startBankroll);
    for (int q = 0; q < 7; q++) fanOut[q][0] = sbR2;
    const double pcts[7] = {5.0, 10.0, 25.0, 50.0, 75.0, 90.0, 95.0};
    for (int fi = 1; fi < nFan; fi++) {
      radix_sort_floats(stepVals[fi], radixTmp, nPaths);
      for (int q = 0; q < 7; q++) {
        fanOut[q][fi] = r2(stepVals[fi][q_idx(pcts[q], nPaths)]);
      }
    }

    if (si > 0) printf(",");
    printf("{\"id\":\"%s\",\"fan\":{", sc.id);
    const char *fanNames[7] = {"p5", "p10", "p25", "p50", "p75", "p90", "p95"};
    for (int q = 0; q < 7; q++) {
      printf("%s\"%s\":[", q ? "," : "", fanNames[q]);
      for (int fi = 0; fi < nFan; fi++) {
        printf("%s%.2f", fi ? "," : "", fanOut[q][fi]);
      }
      printf("]");
    }
    printf("},\"samplePaths\":[");
    for (int s = 0; s < samplePathCount; s++) {
      printf("%s[", s ? "," : "");
      for (int fi = 0; fi < nFan; fi++) {
        printf("%s%.2f", fi ? "," : "", r2(samplePaths[s][fi]));
      }
      printf("]");
    }
    printf("],\"horizons\":{");
    for (int hi = 0; hi < nHorizons; hi++) {
      printf("%s\"%d\":", hi ? "," : "", horizons[hi]);
      emit_horizon_json(stepVals[fanIdxOfHorizon[hi]], horizonDds[hi], startBankroll, nPaths);
    }
    printf("}}");

    free(sc.allPnl);
    free(sc.allRet);
    free(sc.winArr);
    free(sc.lossArr);
  }
  printf("]\n");

  for (int q = 0; q < 7; q++) free(fanOut[q]);
  for (int s = 0; s < samplePathCount; s++) free(samplePaths[s]);
  free(samplePaths);
  for (int hi = 0; hi < nHorizons; hi++) free(horizonDds[hi]);
  free(horizonDds);
  free(radixTmp);
  for (int fi = 1; fi < nFan; fi++) free(stepVals[fi]);
  free(stepVals);
  free(fanIdxOfHorizon);
  free(horizonIdxOfFan);
  free(horizons);
  free(fanSteps);
  return 0;
}
