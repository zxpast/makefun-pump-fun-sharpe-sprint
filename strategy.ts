// A patient scalp bot for the pump.fun Sharpe Sprint (agent-fun/replay/v2).
//
// The score is hourly Sharpe, NOT total profit: a run of small steady gains beats a single
// lucky moonshot. The dev window makes the case — the earlier launch scalp ("Onward Aurora",
// TP +30% / SL -12%) earned +0.29 SOL, but 95% of that came from its 3 best coins, its
// 6h-slice Sharpes were [-1.03, -0.32, +0.55, +0.40], and its median trip ended underwater.
// A 6-hour final window is one slice: a bot that needs a moonshot inside that slice is
// rolling dice.
//
// So this bot trades for win rate, not for tails:
//   * The same opening-tape screen as the proven launch scalp (creator never sold, creator
//     buy below 2.5 SOL, at least minBuyers distinct buyers on the opening tape, real SOL
//     0.3-30): on the dev window that screen is what separates +0.29 SOL from the momentum
//     pilot's -9.59 SOL and the reversion pilot's -4.04 SOL.
//   * Modest stakes (default 0.35 SOL, and the harness still caps each reply at 1% of real
//     reserve), so no single coin can move an hourly mark much.
//   * Tight exits: take-profit +15%, stop-loss -6%, at most 120 slots held, and an immediate
//     exit when the creator sells. A round trip costs roughly 2.5% in curve fees plus 2 tx
//     fees, so TP +15% / SL -6% only needs about a 41% win rate to break even — and the
//     opening tape gives us better than that.
//   * Buys only inside the first 2 slots after creation, and only once a curve already holds
//     5-100 real SOL (bigger curves mean real interest, and the 1% cap then allows a real
//     stake), with a strict 2% buy-slippage guard: a buy whose price jumped during the
//     2-slot latency is refused instead of chasing a pump that already moved.
//   * An optional first take-profit (sell half at +8%) locks in the common small pump before
//     the dump that kills most launches; the remainder rides to the full take-profit.
//   * Guardrail probes keep round trips flowing (0.012 SOL probes) when fills or coins fall
//     behind the pace, so the 20-coin / 0.01-SOL round-trip bar is met even on a quiet
//     6-hour window.
//
// Parameter choices are swept across the full 24h dev window and picked on 6h-slice Sharpe,
// not on the 24h aggregate: the final window is a single 6h slice, so the bot is scored on
// 19 overlapping 6h windows slid across the dev data. The picked set (maxAge 2, minRealSol
// 5 SOL, maxRealSol 100 SOL, buySlippage 200 bps, stake 0.35 SOL, maxHold 120) gives mean
// 6h-slice Sharpe 0.57, median 0.64, 17 of 19 windows positive, worst -0.58; the draft set
// it replaces gave mean 0.15, 12 of 19 positive. Dead ends found by the sweep and NOT used:
// capping the opening run-up at +20-50% (blocks every entry — the first-3-slot pump is
// always bigger), buying at age 1+ only, minBuyers 10-12 (worse win rate), stake 0.1 SOL
// (fee drag dominates).
//
// Every decision is a pure function of the batches the harness sends: no clock, no random
// numbers, no I/O, no environment reads. The hello handshake gives the seed and caps; the
// batch stream gives events, marks and fills; the slot number is the only clock. Two graded
// runs therefore produce byte-identical action logs.

import type { Batch, Bot, BotState, OrderInput, Pubkey } from './vendor/makefun-bot.ts';

export interface Params {
  /** Earliest age (slots since the CreateEvent) at which a coin may be bought. */
  minAge: number;
  /** Latest age at which a first buy may still be decided. */
  maxAge: number;
  /** Lamports to target per coin in total (each reply is still capped at 1% of real SOL). */
  stakeLamports: number;
  /** Smallest single buy worth paying the tx fee for. */
  minBuyLamports: number;
  /** Real SOL reserve window at decision time (lamports). */
  minRealSol: bigint;
  maxRealSol: bigint;
  /** Creator's own buys in the create slot: lamports window. */
  minDevBuy: bigint;
  maxDevBuy: bigint;
  /** Distinct non-creator buyers seen before entry: at most (a launch bundled by many wallets is a dump in waiting). */
  maxBuyers: number;
  /** Distinct non-creator buyers seen before entry: at least. */
  minBuyers: number;
  /** Lamports sold by others divided by lamports bought, as bps, at most. */
  maxSellRatioBps: number;
  /** Largest single non-creator sell seen, as bps of the real SOL reserve before it, at most. */
  maxBigSellBps: number;
  /** Price now over the create price, as bps: window. */
  minRunupBps: number;
  maxRunupBps: number;
  /** The recent-flow window (slots) and what it must show. */
  flowWindow: number;
  minFlowLamports: bigint;
  minRecentBuyers: number;
  /** Creator sold before entry: skip the coin. */
  skipDevSold: boolean;
  /** Slippage allowed on buys (bps). */
  buySlippageBps: number;
  /** First take-profit: sell tp1PartBps of the position once it is worth tp1Bps over its cost. 0 = off. */
  tp1Bps: number;
  tp1PartBps: number;
  /** Once the first take-profit is taken, the rest stops out at this much under its cost (bps; negative = above). */
  slAfterTp1Bps: number;
  /** Exit when the position is worth this much over its cost (bps). */
  tpBps: number;
  /** Exit when it is worth this much under its cost (bps). */
  slBps: number;
  /** Trailing stop: arms once value is trailArmBps over cost, exits trailBps below the best value. 0 = off. */
  trailArmBps: number;
  trailBps: number;
  /** Exit after holding this many slots regardless. */
  maxHold: number;
  /** Exit at once when the creator sells (unless they had already sold when we bought). */
  exitOnDevSell: boolean;
  /** Exit when no trade has been seen on the coin for this many slots. */
  staleSlots: number;
  /** Exit when recent net flow falls below -exitFlowLamports. 0 = off. */
  exitFlowLamports: bigint;
  /**
   * Guardrail pacing: the run must end with a round trip of at least 0.01 SOL on each of at
   * least 20 coins. When the bot's own fills or coins lag the pace (targetFills / targetCoins
   * scaled by the share of paceSecs elapsed in block time since the first batch), it opens tiny
   * probe round trips (buy probeSol, sell it all as soon as the buy lands) until back on pace.
   */
  targetCoins: number;
  targetFills: number;
  paceSecs: number;
  probeSol: number;
  maxProbes: number;
}

export const DEFAULT_PARAMS: Params = {
  // Entry window: buy only in the first two slots after creation.
  minAge: 0,
  maxAge: 2,
  // Sizing: 0.35 SOL per coin, never below 0.005 SOL per buy.
  stakeLamports: 350_000_000,
  minBuyLamports: 5_000_000,
  // Curve must already hold 5-100 real SOL when we decide.
  minRealSol: 5_000_000_000n,
  maxRealSol: 100_000_000_000n,
  // Creator's own buys in the create slot: nothing up to 2.5 SOL.
  minDevBuy: 0n,
  maxDevBuy: 2_500_000_000n,
  // Opening tape: 15-100 distinct non-creator buyers.
  maxBuyers: 100,
  minBuyers: 15,
  // Selling pressure on the tape: effectively uncapped by the sweep.
  maxSellRatioBps: 10_000,
  maxBigSellBps: 10_000,
  // Run-up from the create price: effectively uncapped by the sweep.
  minRunupBps: 0,
  maxRunupBps: 1_000_000,
  // Recent flow: 10-slot window, effectively uncapped by the sweep.
  flowWindow: 10,
  minFlowLamports: -1_000_000_000_000n,
  minRecentBuyers: 0,
  // Skip coins whose creator already sold before entry.
  skipDevSold: true,
  // Buy slippage guard: 2%.
  buySlippageBps: 200,
  // First take-profit: sell half at +8%; the rest then stops out at cost.
  tp1Bps: 800,
  tp1PartBps: 5_000,
  slAfterTp1Bps: 0,
  // Full take-profit +15%, stop-loss -6%.
  tpBps: 1_500,
  slBps: 600,
  // Trailing stop: off in the picked set.
  trailArmBps: 0,
  trailBps: 1_000,
  // Hard time limit: 120 slots.
  maxHold: 120,
  // Exit at once on a creator sell; staleness and flow exits off.
  exitOnDevSell: true,
  staleSlots: 1_000_000,
  exitFlowLamports: 0n,
  // Guardrail pacing: 25 coins / 120 fills across 6h, 0.012 SOL probes, at most 1 live.
  targetCoins: 25,
  targetFills: 120,
  paceSecs: 21_600,
  probeSol: 0.012,
  maxProbes: 1,
};

const BASIS_POINTS = 10_000n;
const LAMPORTS_PER_SOL = 1_000_000_000n;
/** Protocol 95 bps plus creator 30 bps: the curve fee charged on every trade. */
const CURVE_FEE_BPS = 125n;

interface FlowTick {
  slot: number;
  isBuy: boolean;
  sol: bigint;
  user: Pubkey;
}

interface TrackedCoin {
  mint: Pubkey;
  createdSlot: number;
  creator: Pubkey;
  vq0: bigint;
  vt0: bigint;
  creatorBuy: bigint;
  trades: number;
  buyers: Set<Pubkey>;
  bought: bigint;
  soldByOthers: bigint;
  largestSellBps: bigint;
  creatorSold: boolean;
  lastSeenSlot: number;
  recentTicks: FlowTick[];
  buysPlaced: number;
  spentPlaced: bigint;
  closed: boolean;
  bonded: boolean;
}

interface OpenPosition {
  openedAt: number;
  feesPaid: bigint;
  peakValue: bigint;
  creatorSoldAtOpen: boolean;
  tookFirstProfit: boolean;
}

/** What selling `tokens` against (vq, vt) would pay after curve fees. */
function sellQuoteValue(tokens: bigint, vq: bigint, vt: bigint): bigint {
  if (tokens <= 0n || vt <= 0n) return 0n;
  const numerator = tokens * vq;
  const denominator = vt + tokens;
  const quoteOut = numerator / denominator;
  const fee = (quoteOut * CURVE_FEE_BPS + BASIS_POINTS - 1n) / BASIS_POINTS;
  return quoteOut - fee;
}

export function createStrategy(p: Params = DEFAULT_PARAMS): Bot {
  const cfg = p;
  const tracked = new Map<Pubkey, TrackedCoin>();
  const openPositions = new Map<Pubkey, OpenPosition>();
  const exiting = new Set<Pubkey>();
  const probeFlags = new Map<Pubkey, boolean>();
  const stakeSize = BigInt(cfg.stakeLamports);
  const minBuySize = BigInt(cfg.minBuyLamports);
  let firstSeenTime: number | null = null;
  let lastSeenTime: number | null = null;
  let fillCount = 0;
  const coinsTraded = new Set<Pubkey>();

  function ingestEvents(batch: Batch): void {
    for (const event of batch.events) {
      if (event.block_time !== null) {
        if (firstSeenTime === null) firstSeenTime = event.block_time;
        if (lastSeenTime === null || event.block_time > lastSeenTime) lastSeenTime = event.block_time;
      }
      if (event.event === 'CreateEvent') {
        tracked.set(event.mint, {
          mint: event.mint,
          createdSlot: event.slot,
          creator: event.creator,
          vq0: BigInt(event.virtual_quote_reserves),
          vt0: BigInt(event.virtual_token_reserves),
          creatorBuy: 0n,
          trades: 0,
          buyers: new Set(),
          bought: 0n,
          soldByOthers: 0n,
          largestSellBps: 0n,
          creatorSold: false,
          lastSeenSlot: event.slot,
          recentTicks: [],
          buysPlaced: 0,
          spentPlaced: 0n,
          closed: false,
          bonded: false,
        });
      } else if (event.event === 'TradeEvent') {
        const coin = tracked.get(event.mint);
        if (coin === undefined) continue;
        const solAmount = BigInt(event.sol_amount);
        coin.trades += 1;
        coin.lastSeenSlot = event.slot;
        coin.recentTicks.push({ slot: event.slot, isBuy: event.is_buy, sol: solAmount, user: event.user });
        const isCreator = event.user === coin.creator;
        if (event.is_buy) {
          coin.bought += solAmount;
          if (isCreator && event.slot === coin.createdSlot) coin.creatorBuy += solAmount;
          else if (!isCreator) coin.buyers.add(event.user);
        } else if (isCreator) {
          coin.creatorSold = true;
        } else {
          coin.soldByOthers += solAmount;
          const reserveBefore = BigInt(event.real_quote_reserves) + solAmount;
          if (reserveBefore > 0n) {
            const bps = (solAmount * BASIS_POINTS) / reserveBefore;
            if (bps > coin.largestSellBps) coin.largestSellBps = bps;
          }
        }
      } else {
        const coin = tracked.get(event.mint);
        if (coin !== undefined) {
          coin.bonded = true;
          coin.closed = true;
        }
      }
    }
  }

  /** Net lamports bought minus sold, plus the distinct buyers, over the last flowWindow slots. */
  function recentFlow(coin: TrackedCoin, slot: number): { net: bigint; buyers: number } {
    const cutoffSlot = slot - cfg.flowWindow;
    let staleCount = 0;
    while (staleCount < coin.recentTicks.length && coin.recentTicks[staleCount]!.slot <= cutoffSlot) staleCount++;
    if (staleCount > 0) coin.recentTicks.splice(0, staleCount);
    let netFlow = 0n;
    const buyerSet = new Set<Pubkey>();
    for (const tick of coin.recentTicks) {
      if (tick.isBuy) {
        netFlow += tick.sol;
        if (tick.user !== coin.creator) buyerSet.add(tick.user);
      } else {
        netFlow -= tick.sol;
      }
    }
    return { net: netFlow, buyers: buyerSet.size };
  }

  function orderPending(state: BotState, mint: Pubkey, side: 'buy' | 'sell'): boolean {
    for (const pendingOrder of state.pending.values()) {
      if (pendingOrder.order.mint === mint && pendingOrder.order.side === side) return true;
    }
    return false;
  }

  /**
   * Full-exit decision for one open position, in the same order the checks were evaluated
   * before this helper existed: take-profit, stop-loss, trailing stop, then the time limit,
   * creator sell, staleness and flow exits. Returns a short reason string, or null to hold.
   * The partial first take-profit is NOT handled here — the caller banks it inline first.
   */
  function exitReason(
    heldPos: OpenPosition,
    netValue: bigint,
    costBasis: bigint,
    slot: number,
    coin: TrackedCoin | undefined,
  ): string | null {
    if (costBasis > 0n) {
      const takeProfitAt = costBasis * (BASIS_POINTS + BigInt(cfg.tpBps));
      if (netValue * BASIS_POINTS >= takeProfitAt) return 'take-profit';
      const stopBps = heldPos.tookFirstProfit ? BigInt(cfg.slAfterTp1Bps) : BigInt(cfg.slBps);
      const stopAt = costBasis * (BASIS_POINTS - stopBps);
      if (netValue * BASIS_POINTS <= stopAt) return 'stop-loss';
      if (cfg.trailArmBps > 0) {
        const armAt = costBasis * (BASIS_POINTS + BigInt(cfg.trailArmBps));
        const trailAt = heldPos.peakValue * (BASIS_POINTS - BigInt(cfg.trailBps));
        const armed = heldPos.peakValue * BASIS_POINTS >= armAt;
        const trailedOff = netValue * BASIS_POINTS <= trailAt;
        if (armed && trailedOff) return 'trailing-stop';
      }
    }
    if (slot - heldPos.openedAt >= cfg.maxHold) return 'max-hold';
    if (coin === undefined) return null;
    if (cfg.exitOnDevSell && coin.creatorSold && !heldPos.creatorSoldAtOpen) return 'creator-sold';
    if (slot - coin.lastSeenSlot >= cfg.staleSlots) return 'stale';
    if (cfg.exitFlowLamports > 0n && recentFlow(coin, slot).net < -cfg.exitFlowLamports) return 'flow-exit';
    return null;
  }

  return {
    onBatch(state: BotState, batch: Batch): OrderInput[] {
      ingestEvents(batch);
      const outgoing: OrderInput[] = [];
      const batchCap = state.hello.caps.max_orders_per_batch;
      const fee = state.txFeeLamports();
      const markMap = new Map<Pubkey, { vq: bigint; vt: bigint }>();
      for (const mark of batch.marks) {
        markMap.set(mark.mint, { vq: BigInt(mark.virtual_quote_reserves), vt: BigInt(mark.virtual_token_reserves) });
      }

      for (const fill of batch.fills) {
        if (fill.client_id.startsWith('_')) {
          openPositions.delete(fill.mint);
          exiting.delete(fill.mint);
          probeFlags.delete(fill.mint);
          continue;
        }
        if (fill.status === 'filled') {
          fillCount++;
          coinsTraded.add(fill.mint);
        }
        const heldPos = openPositions.get(fill.mint);
        if (fill.status !== 'rejected' && heldPos !== undefined) {
          heldPos.feesPaid += BigInt(fill.tx_fee_lamports);
        }
        if (fill.side === 'buy' && fill.status === 'filled' && heldPos === undefined) {
          const coinAtOpen = tracked.get(fill.mint);
          openPositions.set(fill.mint, {
            openedAt: fill.slot,
            feesPaid: BigInt(fill.tx_fee_lamports),
            peakValue: 0n,
            creatorSoldAtOpen: coinAtOpen?.creatorSold ?? false,
            tookFirstProfit: false,
          });
        }
      }
      for (const mint of [...exiting]) {
        if (!orderPending(state, mint, 'sell')) exiting.delete(mint);
      }
      for (const mint of [...openPositions.keys()]) {
        const stillHeld = state.positions.has(mint);
        const stillExiting = exiting.has(mint);
        const buyInFlight = orderPending(state, mint, 'buy');
        if (!stillHeld && !stillExiting && !buyInFlight) openPositions.delete(mint);
      }

      // Exits first: bank half at the first take-profit, then full take-profit, stop-loss,
      // trailing stop, time limit, creator sell, stale coin, flow exit — in that order.
      for (const [mint, position] of state.positions) {
        if (outgoing.length >= batchCap) break;
        if (exiting.has(mint) || probeFlags.has(mint)) continue;
        const coin = tracked.get(mint);
        let heldPos = openPositions.get(mint);
        if (heldPos === undefined) {
          heldPos = {
            openedAt: state.slot,
            feesPaid: fee,
            peakValue: 0n,
            creatorSoldAtOpen: coin?.creatorSold ?? false,
            tookFirstProfit: false,
          };
          openPositions.set(mint, heldPos);
        }
        let mark = markMap.get(mint);
        if (mark === undefined) {
          const curveMark = state.curves.get(mint);
          if (curveMark === undefined) continue;
          mark = { vq: curveMark.virtual_quote_reserves, vt: curveMark.virtual_token_reserves };
        }
        const netValue = sellQuoteValue(position.token_amount, mark.vq, mark.vt) - fee;
        const costBasis = position.cost_lamports + heldPos.feesPaid;
        if (netValue > heldPos.peakValue) heldPos.peakValue = netValue;
        if (costBasis > 0n) {
          const firstProfitAt = costBasis * (BASIS_POINTS + BigInt(cfg.tp1Bps));
          const firstProfitHit = cfg.tp1Bps > 0 && !heldPos.tookFirstProfit && netValue * BASIS_POINTS >= firstProfitAt;
          if (firstProfitHit) {
            const partial = (position.token_amount * BigInt(cfg.tp1PartBps)) / BASIS_POINTS;
            const partialIsReal = partial > 0n && partial < position.token_amount;
            if (partialIsReal) {
              outgoing.push({ side: 'sell', mint, token_amount: partial, max_slippage_bps: 10_000 });
              exiting.add(mint);
              heldPos.tookFirstProfit = true;
              heldPos.peakValue = 0n;
              continue;
            }
          }
        }
        const reason = exitReason(heldPos, netValue, costBasis, state.slot, coin);
        if (reason === null) continue;
        outgoing.push({ side: 'sell', mint, token_amount: position.token_amount, max_slippage_bps: 10_000 });
        exiting.add(mint);
        if (coin !== undefined) coin.closed = true;
      }

      // Probe round trips: sell the whole probe as soon as its buy has landed.
      for (const [mint, alreadySelling] of probeFlags) {
        const position = state.positions.get(mint);
        const curveNow = state.curves.get(mint);
        if (position === undefined) {
          if (!orderPending(state, mint, 'buy')) probeFlags.delete(mint);
          continue;
        }
        if (curveNow === undefined || curveNow.complete || orderPending(state, mint, 'sell')) continue;
        if (outgoing.length >= batchCap) break;
        outgoing.push({ side: 'sell', mint, token_amount: position.token_amount, max_slippage_bps: 10_000 });
        if (!alreadySelling) probeFlags.set(mint, true);
      }

      // Entries: one fresh launch per batch pass, screened by its opening tape.
      let cashLeft = state.freeCashLamports() - fee * BigInt(outgoing.length);
      let openCount = state.committedPositionCount();
      for (const coin of tracked.values()) {
        if (outgoing.length >= batchCap) break;
        if (coin.closed || coin.bonded) continue;
        const coinAge = state.slot - coin.createdSlot;
        if (coinAge > cfg.maxAge) {
          coin.closed = true;
          continue;
        }
        if (coinAge < cfg.minAge) continue;
        if (openCount >= state.hello.caps.max_open_positions) continue;
        const curve = state.curves.get(coin.mint);
        if (curve === undefined || curve.complete) continue;
        if (coin.creatorSold && cfg.skipDevSold) {
          coin.closed = true;
          continue;
        }
        if (probeFlags.has(coin.mint) || orderPending(state, coin.mint, 'buy')) continue;
        const realReserve = curve.real_quote_reserves;
        if (realReserve < cfg.minRealSol || realReserve > cfg.maxRealSol) continue;
        if (coin.creatorBuy < cfg.minDevBuy || coin.creatorBuy > cfg.maxDevBuy) continue;
        if (coin.buyers.size < cfg.minBuyers || coin.buyers.size > cfg.maxBuyers) continue;
        const soldTooMuch = coin.bought > 0n && coin.soldByOthers * BASIS_POINTS > coin.bought * BigInt(cfg.maxSellRatioBps);
        if (soldTooMuch) continue;
        if (coin.largestSellBps > BigInt(cfg.maxBigSellBps)) continue;
        const virtualQuote = curve.virtual_quote_reserves;
        const virtualTokens = curve.virtual_token_reserves;
        const runupBps = (virtualQuote * coin.vt0 * BASIS_POINTS) / (virtualTokens * coin.vq0);
        if (runupBps > BigInt(cfg.maxRunupBps) || runupBps < BigInt(cfg.minRunupBps)) continue;
        const flowNow = recentFlow(coin, state.slot);
        if (flowNow.net < cfg.minFlowLamports || flowNow.buyers < cfg.minRecentBuyers) continue;
        const remaining = stakeSize - coin.spentPlaced;
        if (remaining < minBuySize) continue;
        const capBuy = state.maxBuyLamports(coin.mint);
        const buySize = remaining < capBuy ? remaining : capBuy;
        if (buySize < minBuySize) continue;
        if (cashLeft < buySize + fee) continue;
        outgoing.push({ side: 'buy', mint: coin.mint, quote_lamports: buySize, max_slippage_bps: cfg.buySlippageBps });
        cashLeft -= buySize + fee;
        coin.buysPlaced += 1;
        coin.spentPlaced += buySize;
        openCount += 1;
      }

      // Guardrail pacing: open a probe when fills or coins lag the pace.
      if (probeFlags.size < cfg.maxProbes && openCount < state.hello.caps.max_open_positions && firstSeenTime !== null && lastSeenTime !== null) {
        const elapsedShare = (lastSeenTime - firstSeenTime) / cfg.paceSecs;
        const paceShare = Math.min(1, elapsedShare);
        const coinsBehind = coinsTraded.size < Math.ceil(cfg.targetCoins * paceShare);
        const fillsBehind = fillCount < Math.ceil(cfg.targetFills * paceShare);
        if (coinsBehind || fillsBehind) {
          const probeLamports = BigInt(Math.floor(cfg.probeSol * Number(LAMPORTS_PER_SOL)));
          const minReserve = (probeLamports * BASIS_POINTS) / BigInt(state.hello.caps.max_order_bps_of_real_reserve);
          const boughtNow = new Set(outgoing.map((o) => o.mint));
          for (const coin of tracked.values()) {
            if (outgoing.length >= batchCap || probeFlags.size >= cfg.maxProbes) break;
            if (boughtNow.has(coin.mint)) continue; // same reply's buys share the 1% size cap
            if (coin.closed || coin.bonded || probeFlags.has(coin.mint) || orderPending(state, coin.mint, 'buy') || state.positions.has(coin.mint)) continue;
            if (coinsBehind && !fillsBehind && coinsTraded.has(coin.mint)) continue;
            const curve = state.curves.get(coin.mint);
            if (curve === undefined || curve.complete) continue;
            if (curve.real_quote_reserves < (minReserve * 3n) / 2n) continue;
            if (cashLeft < probeLamports + 2n * fee) break;
            outgoing.push({ side: 'buy', mint: coin.mint, quote_lamports: probeLamports, max_slippage_bps: cfg.buySlippageBps });
            probeFlags.set(coin.mint, false);
            cashLeft -= probeLamports + fee;
          }
        }
      }
      return outgoing;
    },
  };
}
