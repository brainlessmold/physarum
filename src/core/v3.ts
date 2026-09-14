/**
 * Concentrated liquidity: asking Uniswap V3 what a swap actually costs.
 *
 * The V2 side of this project estimates slippage as S / L, which is only valid
 * for a constant-product pool. V3 holds its liquidity in ticks, so that formula
 * does not describe it at all. Rather than stretch the estimate over a market it
 * does not fit, this module asks the pool's own quoter: QuoterV2 simulates the
 * swap on current state and returns the exact output.
 *
 * Cost of a hop is defined as what the trade loses against the pool's own
 * marginal price:
 *
 *     cost = 1 - rate(S) / rate(0)          rate = amountOut / amountIn
 *
 * rate(0) is taken from a trade small enough to cross no ticks, so it is the
 * marginal price minus the fee; dividing it back out by (1 - fee) recovers the
 * fee-free price and makes the fee part of the cost, exactly as it is for V2.
 *
 * Checked against the chain: at a trade of 0.001 WETH the cost this produces
 * comes out at 0.010%, 0.050%, 0.300% and 1.000% on the four fee tiers — the
 * fee, to three decimals, with nothing left over.
 *
 * What this does NOT model, stated plainly: two pools of the same pair can sit
 * at slightly different prices, and a real router would arbitrage that. Here
 * every pool is measured against its own marginal price, so a pool that is
 * simply priced worse does not look more expensive.
 *
 * Addresses from github.com/Uniswap/contracts, deployments/4663.md.
 */

import { ethCallBatch, type Call, type Io } from './chain.ts';

export const V3_FACTORY = '0x1f7d7550b1b028f7571e69a784071f0205fd2efa';
export const QUOTER_V2 = '0x33e885ed0ec9bf04ecfb19341582aadcb4c8a9e7';

/** The four fee tiers Uniswap deploys, in hundredths of a basis point. */
export const FEE_TIERS = [100, 500, 3000, 10_000] as const;

const SEL = {
  /** getPool(address,address,uint24) */
  getPool: '0x1698ee82',
  /** quoteExactInputSingle((address,address,uint256,uint24,uint160)) */
  quote: '0xc6a5026a',
} as const;

const addrWord = (a: string) => a.toLowerCase().replace(/^0x/, '').padStart(64, '0');
const numWord = (n: bigint | number) => BigInt(n).toString(16).padStart(64, '0');
const readAddress = (w: string) => '0x' + w.slice(-40);
const readUint = (hex: string) =>
  hex && hex.length >= 66 ? BigInt('0x' + hex.slice(2, 66)) : null;

export interface V3Pool {
  tokenIn: string;
  tokenOut: string;
  fee: number;
  pool: string;
}

/**
 * Which of the four tiers actually exist for these pairs.
 * One eth_call per pair per tier; a pair with no pool answers with the zero address.
 */
export async function findV3Pools(
  pairs: Array<{ tokenIn: string; tokenOut: string }>,
  io: Io = {},
): Promise<V3Pool[]> {
  const calls: Call[] = [];
  const meta: Array<{ tokenIn: string; tokenOut: string; fee: number }> = [];
  for (const p of pairs) {
    for (const fee of FEE_TIERS) {
      calls.push({
        to: V3_FACTORY,
        data: SEL.getPool + addrWord(p.tokenIn) + addrWord(p.tokenOut) + numWord(fee),
      });
      meta.push({ ...p, fee });
    }
  }
  const answers = await ethCallBatch(calls, io);
  const out: V3Pool[] = [];
  answers.forEach((hex, i) => {
    if (!hex) return;
    const pool = readAddress(hex);
    if (/^0x0+$/.test(pool)) return;
    out.push({ ...meta[i], pool });
  });
  return out;
}

export interface V3Cost {
  tokenIn: string;
  tokenOut: string;
  fee: number;
  pool: string;
  /** Fraction lost to fee and slippage, one entry per trade size asked for. */
  costBySize: Record<number, number>;
}

/** A trade small enough to cross no ticks, so its rate is the marginal one. */
const probeOf = (amountIn: bigint) => {
  const p = amountIn / 1000n;
  return p > 0n ? p : 1n;
};

/**
 * Quotes every pool at every trade size, plus one probe each.
 *
 * The whole ladder is asked for in one go so the page can switch trade size
 * without going back to the chain: a dropdown that takes ten seconds to answer
 * is a dropdown nobody touches.
 */
export async function quoteV3(
  pools: V3Pool[],
  /** Trade size in dollars -> amount of tokenIn, in its own decimals. */
  amountInOf: (tokenIn: string, sizeUsd: number) => bigint,
  sizesUsd: number[],
  io: Io = {},
): Promise<V3Cost[]> {
  if (pools.length === 0 || sizesUsd.length === 0) return [];

  const calls: Call[] = [];
  const plan: Array<{ pool: V3Pool; sizes: bigint[]; probe: bigint }> = [];

  for (const p of pools) {
    const sizes = sizesUsd.map((usd) => amountInOf(p.tokenIn, usd));
    const probe = probeOf(sizes[0]);
    plan.push({ pool: p, sizes, probe });
    const q = (amount: bigint) => ({
      to: QUOTER_V2,
      data:
        SEL.quote +
        addrWord(p.tokenIn) +
        addrWord(p.tokenOut) +
        numWord(amount) +
        numWord(p.fee) +
        numWord(0),
    });
    for (const amount of sizes) calls.push(q(amount));
    calls.push(q(probe));
  }

  const answers = await ethCallBatch(calls, io);

  const out: V3Cost[] = [];
  let cursor = 0;
  for (const { pool, sizes, probe } of plan) {
    const results = answers.slice(cursor, cursor + sizes.length + 1);
    cursor += sizes.length + 1;

    const probeOut = readUint(results[sizes.length] ?? '');
    if (probeOut === null || probeOut <= 0n) continue;
    const probeRate = Number(probeOut) / Number(probe);
    if (!isFinite(probeRate) || probeRate <= 0) continue;

    // The probe rate already has the fee taken out of it; dividing it back in
    // recovers the fee-free price, so the fee counts as cost exactly as on V2.
    const marginal = probeRate / (1 - pool.fee / 1e6);

    const costBySize: Record<number, number> = {};
    sizes.forEach((amountIn, i) => {
      const amountOut = readUint(results[i] ?? '');
      if (amountOut === null || amountOut <= 0n) return;
      const rate = Number(amountOut) / Number(amountIn);
      const cost = 1 - rate / marginal;
      if (isFinite(cost)) costBySize[sizesUsd[i]] = Math.max(cost, 0);
    });

    if (Object.keys(costBySize).length > 0) out.push({ ...pool, costBySize });
  }
  return out;
}

/** The cheapest tier for each pair at a given trade size, keyed "tokenIn>tokenOut". */
export function cheapestPerPair(quotes: V3Cost[], sizeUsd: number): Map<string, V3Cost> {
  const best = new Map<string, V3Cost>();
  for (const q of quotes) {
    const c = q.costBySize[sizeUsd];
    if (c === undefined) continue;
    const key = `${q.tokenIn}>${q.tokenOut}`;
    const cur = best.get(key);
    if (!cur || c < (cur.costBySize[sizeUsd] ?? Infinity)) best.set(key, q);
  }
  return best;
}
