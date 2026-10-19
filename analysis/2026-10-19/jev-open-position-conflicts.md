# JEV vs open position conflicts — 2026-10-19

## What was checked

Joined the trade journal to jev_log.jsonl by market slug, using the latest JEV call made **at or before** the position entry. Only 6 journal trades have such a JEV opinion (JEV started mid-day).

| Outcome | n | Bot wins | JEV wins |
| --- | ---: | ---: | ---: |
| JEV agrees with position | 3 | 3 | 3 |
| JEV conflicts with position | **3** | **1** | **2** |

So the observation is real but n=3. Bot WR in conflicts is 1/3 = 33.3% (95% CI 6–79%); JEV 2/3. Under JEV full-sample direction accuracy 57.9%, the chance of JEV winning at least 2 of 3 is about **62%** — this is not statistically surprising.

## The three conflict cases

| JEV call | Candidate side at call | Final position | JEV | Outcome |
| --- | --- | --- | --- | --- |
| 04:01:06 (WAIT) | none | DOWN (04:03) | UP 27% | DOWN — bot win, JEV wrong |
| 08:30:36 (ENTER) | UP | DOWN (08:33) | UP 48% | UP — bot loss, JEV right |
| 13:45:36 (ENTER) | DOWN | UP (13:48) | DOWN 73% | DOWN — bot loss, JEV right |

Key point: in the 08:30 and 13:45 cases, JEV did **not** oppose the candidate the bot had at call time — it agreed with the then-current rule side. The **bot side flipped after the JEV call**, and the final position ended up opposite. The 04:01 case is a WAIT call; the bot later entered DOWN and JEV was wrong.

So the apparent “JEV contradicted my open position and was right” is mostly a **timing/synchronisation artifact**, not evidence of a better model: JEV answered an earlier state; the final entry was later (and sometimes on the other side).

## What should happen

1. **Do not exit or hedge an open position because JEV disagrees.** Exits should stay deterministic (cut-loss/settlement); reacting to a stale model opinion is post-hoc market timing.
2. **Attach JEV to the final fill, not the candidate.** Current JEV_CALL_ON=entry calls at decide()/candidate time; the actual executeDirectionalTrade can happen 2–3 minutes later and on the other side. Log/refresh JEV at the final entry, or store entry.jevDirection / entry.jevConflict in the journal for every actual fill.
3. **If JEV is to be a veto**, it must be evaluated and applied **before** entry on the exact final side; a stale “opposite” opinion cannot be used after the position is open. Keep it shadow until that is implemented and validated.
4. **Track conflict outcomes separately** (n≥30) before drawing conclusions. Current conflict sample n=3: 2/3 JEV is a coincidence candidate, not an edge.
5. The full JEV audit still says: direction 57.9% (22/38), no-side calls 41.2%, settle Brier 0.3017 vs market 0.1686. That does not support promoting JEV to gate/primary.

## Suggested next code step (not done yet)

Add entry.jevDirection, entry.jevConfidence, entry.jevSettleUp, entry.jevConflict to the journal at the actual fill (tradePipeline), and optionally re-call JEV once at final entry. That makes future “JEV vs position” analysis exact instead of reconstructing call times.


## Implemented 2026-10-19 14:56 UTC

`loop.ts` now force-refreshes JEV after the actual fill (`entryRefresh: true`); `tradePipeline` writes `jevDirection/jevConfidence/jevSettleUp/jevRegime/jevCallTs/jevConflict` into the journal. The next actual entry will be the first exact row.
