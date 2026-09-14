/**
 * Checks for the concentrated-liquidity side.
 *
 * The quoter is answered here by a constant-product pool, which is not what V3
 * is — but it is a market whose exact answer is known in closed form, so the
 * arithmetic this module wraps around the quoter can be checked against it. The
 * property that matters is the one measured against the real chain: at a trade
 * small enough to cross nothing, the cost this produces must come out equal to
 * the fee of the tier, and nothing more.
 */

import { findV3Pools, quoteV3, cheapestPerPair, FEE_TIERS, QUOTER_V2, V3_FACTORY } from '../src/core/v3.ts';
import { poolCost, type Pool } from '../src/core/pools.ts';

let failed = false;
function check(label: string, ok: boolean, detail: string) {
  console.log(`  ${ok ? 'OK  ' : 'FAIL'}  ${label} — ${detail}`);
  if (!ok) failed = true;
}

const w = (n: bigint | number) => BigInt(n).toString(16).padStart(64, '0');
const addrW = (a: string) => a.toLowerCase().replace(/^0x/, '').padStart(64, '0');

const WETH = '0x0bd7d308f8e1639fab988df18a8011f41eacad73';
const USDG = '0x5fc5360d0400a0fd4f2af552add042d716f1d168';
const GHOST = '0x9999999999999999999999999999999999999999';

/** Reserves the fake quoter trades against, per fee tier. Deeper tier, thinner fee. */
const DEPTH: Record<number, bigint> = {
  100: 4_000n * 10n ** 18n,
  500: 800n * 10n ** 18n,
  3000: 200n * 10n ** 18n,
  10000: 20n * 10n ** 18n,
};
const PRICE = 2500n; // USDG per WETH, before fee and slippage

let requests = 0;

const fakeFetcher = async (_url: string, init: RequestInit): Promise<Response> => {
  requests++;
  const body = JSON.parse(String(init.body)) as Array<{ id: number; params: [{ to: string; data: string }, string] }>;
  const out = body.map(({ id, params }) => {
    const { to, data } = params[0];
    const at = to.toLowerCase();
    const arg = data.slice(10);
    let result: string | undefined;

    if (at === V3_FACTORY && data.startsWith('0x1698ee82')) {
      const b = '0x' + arg.slice(88, 128);
      const fee = Number(BigInt('0x' + arg.slice(128, 192)));
      // every tier exists for WETH/USDG; nothing exists for the ghost token
      const exists = b === USDG && FEE_TIERS.includes(fee as (typeof FEE_TIERS)[number]);
      result = '0x' + addrW(exists ? `0x${fee.toString(16).padStart(40, 'a')}` : '0x0');
    }

    if (at === QUOTER_V2 && data.startsWith('0xc6a5026a')) {
      const amountIn = BigInt('0x' + arg.slice(128, 192));
      const fee = Number(BigInt('0x' + arg.slice(192, 256)));
      const R_in = DEPTH[fee];
      if (R_in && amountIn > 0n) {
        // constant product, 6-decimal output side
        // Both sides 18 decimals: a six-decimal output side would round the
        // probe trade down to dust and make this fixture, not the code, the
        // thing under test.
        const net = (amountIn * BigInt(1_000_000 - fee)) / 1_000_000n;
        const R_out = R_in * PRICE;
        const amountOut = (net * R_out) / (R_in + net);
        result = '0x' + w(amountOut) + w(0) + w(0) + w(0);
      }
    }
    return { jsonrpc: '2.0', id, result };
  });
  return new Response(JSON.stringify(out), { status: 200 });
};

const io = { fetcher: fakeFetcher, pauseMs: 0 };
const E = 10n ** 18n;
const amountInOf = (_t: string, usd: number) => (BigInt(Math.round(usd)) * E) / PRICE;
const SIZES = [1_000, 10_000, 50_000, 250_000];

/* ---------------- discovery ---------------- */

console.log('\nFinding the tiers that exist');

const pools = await findV3Pools([{ tokenIn: WETH, tokenOut: USDG }, { tokenIn: WETH, tokenOut: GHOST }], io);
check('every tier of a real pair found', pools.length === FEE_TIERS.length, `${pools.length} of ${FEE_TIERS.length}`);
check('a pair with no pool is dropped, not kept as the zero address', !pools.some((p) => p.tokenOut === GHOST), 'ghost pair absent');
check('the fee tier is carried through', pools.map((p) => p.fee).sort((a, b) => a - b).join(',') === [...FEE_TIERS].join(','), pools.map((p) => p.fee).join(', '));

/* ---------------- the quote ---------------- */

console.log('\nWhat the quoter says it costs');

const quotes = await quoteV3(pools, amountInOf, [1, ...SIZES], io);
check('every pool quoted', quotes.length === pools.length, `${quotes.length} of ${pools.length}`);

for (const tier of FEE_TIERS) {
  const q = quotes.find((x) => x.fee === tier)!;
  const tiny = q.costBySize[1];
  const expected = tier / 1e6;
  check(
    `tier ${(tier / 10_000).toFixed(2)}% — a trade of $1 costs the fee and nothing more`,
    Math.abs(tiny - expected) < 2e-4,
    `${(tiny * 100).toFixed(4)}% against a fee of ${(expected * 100).toFixed(2)}%`,
  );
}

const deep = quotes.find((q) => q.fee === 100)!;
check(
  'cost rises with trade size',
  SIZES.every((s, i) => i === 0 || deep.costBySize[s] >= deep.costBySize[SIZES[i - 1]]),
  SIZES.map((s) => `$${s / 1000}k:${(deep.costBySize[s] * 100).toFixed(3)}%`).join('  '),
);

const thin = quotes.find((q) => q.fee === 10_000)!;
check(
  'the thin tier is worse than the deep one on a large trade',
  thin.costBySize[250_000] > deep.costBySize[250_000],
  `1.00% tier ${(thin.costBySize[250_000] * 100).toFixed(2)}% against 0.01% tier ${(deep.costBySize[250_000] * 100).toFixed(2)}%`,
);

console.log('\nPicking a tier');

const bestSmall = cheapestPerPair(quotes, 1_000).get(`${WETH}>${USDG}`)!;
const bestLarge = cheapestPerPair(quotes, 250_000).get(`${WETH}>${USDG}`)!;
check('a tier is chosen per size', !!bestSmall && !!bestLarge, `$1k → ${bestSmall.fee}, $250k → ${bestLarge.fee}`);
check(
  'the chosen tier is the cheapest one at that size',
  quotes.every((q) => q.costBySize[250_000] >= bestLarge.costBySize[250_000]),
  `${(bestLarge.costBySize[250_000] * 100).toFixed(3)}% is the lowest of ${quotes.length}`,
);

/* ---------------- the constant-product side ---------------- */

console.log('\nThe V2 cost, which is now exact rather than estimated');

const pool: Pool = { tokenA: 'WETH', tokenB: 'X', feeBps: 30, liquidityUsd: 1_000_000 };
const atNothing = poolCost({ ...pool }, { tradeSizeUsd: 0.01 });
check('a trade of nothing costs the fee', Math.abs(atNothing - 0.003) < 1e-5, `${(atNothing * 100).toFixed(4)}%`);

const small = poolCost(pool, { tradeSizeUsd: 1_000 });
const big = poolCost(pool, { tradeSizeUsd: 100_000 });
check('cost rises with size', big > small, `${(small * 100).toFixed(2)}% → ${(big * 100).toFixed(2)}%`);
check(
  'a trade far past the pool never costs more than everything',
  poolCost(pool, { tradeSizeUsd: 10 ** 12 }) <= 1,
  `${(poolCost(pool, { tradeSizeUsd: 10 ** 12 }) * 100).toFixed(2)}% at a trade of $1T`,
);
check(
  'slippage counts the input side, which is half the pool',
  Math.abs(poolCost({ ...pool, feeBps: 0 }, { tradeSizeUsd: 500_000 }) - 0.5) < 1e-9,
  'a trade equal to the input reserve loses exactly half',
);

const quotedPool: Pool = { ...pool, cost: 0.0004, venue: 'v3' };
check(
  'a pool carrying its own quote uses it and ignores the formula',
  Math.abs(poolCost(quotedPool, { tradeSizeUsd: 250_000 }) - 0.0004) < 1e-12,
  '0.04% from the quoter, not 20% from the estimate',
);

console.log('');
if (failed) {
  console.error('FAILED\n');
  process.exit(1);
}
console.log('All checks passed.\n');
