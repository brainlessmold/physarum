/**
 * Uniswap V4: pools that do not exist as contracts.
 *
 * On V2 and V3 a pool is its own address, so you can ask the factory for it and
 * read its reserves. V4 keeps every pool inside one contract — the PoolManager —
 * and identifies each by a hash of its key: the two currencies, the fee, the
 * tick spacing, and the address of its hook. There is nothing to call getPool
 * on and no reserves to read.
 *
 * So pools are found the only way they can be: from the Initialize event the
 * PoolManager emits when one is created. The event carries the id and the whole
 * key, which is everything needed to quote it.
 *
 * And quoting is the only honest way to price a V4 pool, because of hooks. A
 * hook is arbitrary code the pool runs on every swap, and it can change the
 * price, charge its own fee, or refuse the trade. No formula over pool state can
 * account for that; the quoter executes the hook and returns the real number.
 * One of the pools this project's own token trades in has a hook.
 *
 * Native ETH is currency zero here, not WETH.
 *
 * Addresses from github.com/Uniswap/contracts, deployments/4663.md.
 */

import { ethCallBatch, rpc, type Call, type Io, addrWord, readAddress, readFirstUint } from './rpc.ts';

export const POOL_MANAGER = '0x8366a39cc670b4001a1121b8f6a443a643e40951';
export const V4_QUOTER = '0x8dc178efb8111bb0973dd9d722ebeff267c98f94';
export const STATE_VIEW = '0xf3334192d15450cdd385c8b70e03f9a6bd9e673b';

/** Native ETH, as V4 addresses it. */
export const NATIVE = '0x0000000000000000000000000000000000000000';

/** keccak256('Initialize(bytes32,address,address,uint24,int24,address,uint160,int24)') */
export const INITIALIZE =
  '0xdd466e674ea557f56295e2d0218a125ea4b4f0f6f3307b95f85e6110838d6438';

const SEL_V4 = {
  /** StateView.getLiquidity(bytes32) */
  liquidity: '0xfa6793d5',
  /** StateView.getSlot0(bytes32) */
  slot0: '0xc815641c',
  /** V4Quoter.quoteExactInputSingle(((address,address,uint24,int24,address),bool,uint128,bytes)) */
  quote: '0xaa9d21cb',
} as const;

/** Like numWord, but for a value that may be negative — the tick spacing is. */
const signedWord = (n: bigint | number) => {
  let v = BigInt(n);
  if (v < 0n) v += 1n << 256n; // two's complement
  return v.toString(16).padStart(64, '0');
};
const wordAt = (data: string, i: number) => data.slice(2 + i * 64, 2 + (i + 1) * 64);
const readInt24 = (word: string) => {
  const v = parseInt(word.slice(-6), 16);
  return v >= 0x800000 ? v - 0x1000000 : v;
};

export interface PoolKey {
  currency0: string;
  currency1: string;
  fee: number;
  tickSpacing: number;
  hooks: string;
}

export interface V4Pool extends PoolKey {
  id: string;
  block: number;
  /** True when a hook runs on this pool's swaps, so only a quote can price it. */
  hooked: boolean;
}

interface RawLog {
  topics: string[];
  data: string;
  blockNumber: string;
}

/**
 * Every V4 pool holding this token, from the PoolManager's Initialize events.
 * The token can be either side of the key, so both positions are asked for.
 */
export async function findV4Pools(token: string, fromBlock: number, io: Io = {}): Promise<V4Pool[]> {
  const topic = '0x' + addrWord(token);
  const from = '0x' + Math.max(0, fromBlock).toString(16);
  const query = (topics: (string | null)[]) =>
    rpc<RawLog[]>(
      'eth_getLogs',
      [{ address: POOL_MANAGER, topics, fromBlock: from, toBlock: 'latest' }],
      io,
    );

  const [asFirst, asSecond] = [
    await query([INITIALIZE, null, topic]),
    await query([INITIALIZE, null, null, topic]),
  ];

  const seen = new Set<string>();
  const out: V4Pool[] = [];
  for (const log of [...(asFirst ?? []), ...(asSecond ?? [])]) {
    const id = log.topics[1];
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const hooks = readAddress('0x' + wordAt(log.data, 2));
    out.push({
      id,
      currency0: readAddress(log.topics[2]),
      currency1: readAddress(log.topics[3]),
      fee: Number(BigInt('0x' + wordAt(log.data, 0))),
      tickSpacing: readInt24(wordAt(log.data, 1)),
      hooks,
      hooked: !/^0x0+$/.test(hooks),
      block: Number(BigInt(log.blockNumber)),
    });
  }
  return out.sort((a, b) => a.block - b.block);
}

/**
 * Encodes QuoteExactSingleParams. The struct carries a bytes member, which makes
 * the whole argument dynamic — hence the leading offset, and the empty hookData
 * tail at the end.
 */
export function encodeQuote(key: PoolKey, zeroForOne: boolean, amountIn: bigint): string {
  return (
    SEL_V4.quote +
    signedWord(32) +
    addrWord(key.currency0) +
    addrWord(key.currency1) +
    signedWord(key.fee) +
    signedWord(key.tickSpacing) +
    addrWord(key.hooks) +
    signedWord(zeroForOne ? 1 : 0) +
    signedWord(amountIn) +
    signedWord(256) +
    signedWord(0)
  );
}

export interface V4Quote {
  pool: V4Pool;
  amountIn: bigint;
  amountOut: bigint;
  /** Liquidity the pool reports, in its own units. Indicative only on V4. */
  liquidity: bigint | null;
}

/**
 * Asks the quoter what each pool would actually give for `amountIn` of the
 * token on the `from` side. Pools that answer nothing are dropped; a hook is
 * allowed to refuse a trade, and a refusal is an answer, not an error.
 */
export async function quoteV4(
  pools: V4Pool[],
  from: string,
  amountIn: bigint,
  io: Io = {},
): Promise<V4Quote[]> {
  if (pools.length === 0 || amountIn <= 0n) return [];
  const calls: Call[] = [];
  for (const p of pools) {
    const zeroForOne = p.currency0.toLowerCase() === from.toLowerCase();
    calls.push({ to: V4_QUOTER, data: encodeQuote(p, zeroForOne, amountIn) });
    calls.push({ to: STATE_VIEW, data: SEL_V4.liquidity + p.id.slice(2) });
  }
  const answers = await ethCallBatch(calls, io);

  const out: V4Quote[] = [];
  pools.forEach((pool, i) => {
    const amountOut = readFirstUint(answers[i * 2] ?? '');
    if (amountOut === null || amountOut <= 0n) return;
    out.push({ pool, amountIn, amountOut, liquidity: readFirstUint(answers[i * 2 + 1] ?? '') });
  });
  return out;
}

/** The pool that gives the most for the same input. */
export function bestQuote(quotes: V4Quote[]): V4Quote | null {
  let best: V4Quote | null = null;
  for (const q of quotes) if (!best || q.amountOut > best.amountOut) best = q;
  return best;
}

export interface TokenMarket {
  token: string;
  /** Price of one token in dollars, or null when nothing would quote. */
  priceUsd: number | null;
  /** Pools the PoolManager holds for this token. */
  pools: number;
  /** How many of them run a hook on every swap. */
  hooked: number;
  /** The pool the price came from. */
  best: V4Pool | null;
  /** What was sent in to get the quote — a small trade, to stay near the marginal price. */
  probeUsd: number;
  /** Chain head when the quote was taken. A quote is only true for its block. */
  blockNumber: number | null;
}

/**
 * Prices a token from its own V4 pools.
 *
 * A small trade is quoted into every pool that has ETH on the other side, and
 * the pool that gives the most decides the price. Small, because the point is
 * the current price rather than what a large order would do to it.
 */
export async function fetchTokenMarket(
  token: string,
  options: { ethUsd: number; decimals?: number; fromBlock?: number; probeUsd?: number },
  io: Io = {},
): Promise<TokenMarket> {
  const decimals = options.decimals ?? 18;
  const probeUsd = options.probeUsd ?? 25;
  const empty: TokenMarket = { token, priceUsd: null, pools: 0, hooked: 0, best: null, probeUsd, blockNumber: null };
  if (!(options.ethUsd > 0)) return empty;

  const head = await rpc<string>('eth_blockNumber', [], io).catch(() => null);
  const blockNumber = head ? Number(BigInt(head)) : null;

  const pools = await findV4Pools(token, options.fromBlock ?? 0, io);
  const hooked = pools.filter((p) => p.hooked).length;
  const againstEth = pools.filter(
    (p) => p.currency0 === NATIVE || p.currency1 === NATIVE,
  );
  if (againstEth.length === 0) return { ...empty, pools: pools.length, hooked, blockNumber };

  const amountIn = BigInt(Math.max(1, Math.round((probeUsd / options.ethUsd) * 1e18)));
  const quotes = await quoteV4(againstEth, NATIVE, amountIn, io);
  const best = bestQuote(quotes);
  if (!best) return { ...empty, pools: pools.length, hooked, blockNumber };

  const tokensOut = Number(best.amountOut) / 10 ** decimals;
  const priceUsd = tokensOut > 0 ? probeUsd / tokensOut : null;

  return { token, priceUsd, pools: pools.length, hooked, best: best.pool, probeUsd, blockNumber };
}
