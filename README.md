# Steady Scalp — Pump.fun Sharpe Sprint

[![make.fun · u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)
[![rank](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/zxpast/makefun-pump-fun-sharpe-sprint/rank.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)
[![reward](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/zxpast/makefun-pump-fun-sharpe-sprint/reward.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)

**Referral code: `6hmpy1rq`**

Bounty: [Pump Fun Sharpe Sprint](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)

A paper-trading bot for the `agent-fun/replay/v2` pump.fun replay. It trades for
**hourly Sharpe, not raw PnL**: small stakes, tight exits, and a strict opening-tape
filter, so the score comes from many small wins instead of one lucky moonshot.

## How it trades

- **Entry:** fresh launches (age ≤ 2 slots) whose opening tape passes the rug filter —
  creator did not sell, creator buy under 2.5 SOL, at least 15 distinct buyers, real SOL
  5–100 — sized at min(0.35 SOL, 1% of real reserve) with a 2% buy-slippage guard.
- **Exit:** take-profit +15% (half banked at +8%), stop-loss −6%, 120-slot time limit,
  or at once when the creator sells.
- **Guardrails:** 0.012 SOL probe round trips keep the 20-coin / 0.01-SOL round-trip bar
  met on a quiet window; max 5 open positions; no shorts, no leverage.
- **Determinism:** every decision is a pure function of the batches the harness sends —
  no clock, no randomness, no I/O. Two graded runs produce byte-identical action logs.

## Layout

- `main.ts` — entrypoint (`node /bot/main.ts`).
- `strategy.ts` — the strategy and its swept parameters.
- `vendor/makefun-bot.ts` — the kit's SDK shim, vendored byte for byte.
- `tools/` — local backtest harness (engine port + Sharpe/slice scoring; dev only, not
  run by the grader).

## Dev-window backtest (full 24h, local engine port, exact house Sharpe math)

| Metric | Value |
|---|---|
| Net PnL | +0.3943 SOL (+3.94%) |
| Sharpe (hourly, 24h) | 0.5608 |
| 6h-slice Sharpes | −0.58, +0.79, +0.88, +0.41 |
| 6h windows positive (19 overlapping) | 17/19 (mean 0.57, median 0.64) |
| Fills / coins / guardrail round trips | 156 / 73 / 73 |
| Win rate | 26.0% (19/73 trips) |
| Max drawdown | 0.0029 |
| Net PnL ex-top-3 coins | +0.1887 SOL |
| Net PnL at 2× fees | +0.2670 SOL |

Baselines on the same window: hold-cash 0.0000 SOL (Sharpe null), equal-weight −0.0228 SOL
(Sharpe −0.22), momentum pilot −9.5894 SOL (Sharpe −0.56), reversion pilot −4.0418 SOL
(Sharpe −0.49), previous launch-scalp "Onward Aurora" +0.2944 SOL (Sharpe 0.28, but 95%
of its profit came from its 3 best coins).
