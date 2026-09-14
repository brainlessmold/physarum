/**
 * Live mode: reading Uniswap V2 pools straight off Robinhood Chain.
 *
 * No SDK, no indexer, no API key, no backend. Everything here is plain
 * eth_call against the public RPC, encoded and decoded by hand, so the page
 * that shows a route is the same code that fetched the reserves behind it.
 *
 * Scope, stated before anyone asks: V2 only. Uniswap V3 and V4 are also
 * deployed on this chain and carry more volume, but their liquidity is
 * concentrated in ticks, and the slippage estimate in pools.ts (S / L) is only
 * valid for a constant-product pool. Routing V3 honestly means calling their
 * quoter, which is a different job. Rather than quietly mix the two, this
 * module reads V2 and says so.
 *
 * Addresses:
 *   RPC, chain id 4663     docs.robinhood.com/chain/connecting
 *   WETH, USDG             docs.robinhood.com/chain/contracts
 *   UniswapV2Factory       github.com/Uniswap/contracts deployments/4663.md
 */

export const RPC_URL = 'https://rpc.mainnet.chain.robinhood.com';

/**
 * Where to go when the browser refuses the direct answer.
 *
 * The public RPC intermittently sends Access-Control-Allow-Origin twice — the
 * browser reports it as "*,*" and drops the response. It clears up on its own
 * within a minute, but a visitor who lands during one of those windows sees a
 * page claiming live data and showing none. So every call goes direct first and
 * only falls back to this pass-through, which forwards the same body to the same
 * endpoint and adds a header the browser will accept. See api/rpc.ts.
 */
export const RPC_FALLBACK = '/api/rpc';
export const CHAIN_ID = 4663;

export const V2_FACTORY = '0x8bceaa40b9acdfaedf85adf4ff01f5ad6517937f';
export const WETH = '0x0bd7d308f8e1639fab988df18a8011f41eacad73';
export const USDG = '0x5fc5360d0400a0fd4f2af552add042d716f1d168';
export const USDG_DECIMALS = 6;

/** The public RPC rejects batches larger than this. Measured, not guessed: 50 is accepted, 100 is refused. */
export const MAX_BATCH = 40;

/** Uniswap V2 charges a flat 0.3% on every pool. */
export const V2_FEE_BPS = 30;

/** keccak256('PairCreated(address,address,address,uint256)') */
export const PAIR_CREATED =
  '0x0d3648bd0f6ba80134a33ba9275ac585d9d315f0ad8355cddefde31afa28d0e9';

/**
 * How far back to ask for PairCreated events.
 *
 * The public RPC accepts an unbounded range — asking from block zero works and
 * returns every pair a hub has ever had. It also returns thousands of them,
 * which is a large response for a page to swallow, so the window is bounded.
 * Three million blocks currently covers a few hundred WETH pairs and a few
 * dozen on the smaller hubs: enough to see the shape, small enough to load.
 */
export const LOG_WINDOW_BLOCKS = 3_000_000;

const SEL = {
  allPairsLength: '0x574f2ba3',
  allPairs: '0x1e3dd18b',
  getPair: '0xe6a43905',
  token0: '0x0dfe1681',
  token1: '0xd21220a7',
  getReserves: '0x0902f1ac',
  symbol: '0x95d89b41',
  decimals: '0x313ce567',
} as const;

export interface Call {
  to: string;
  data: string;
}

const word = (n: number | bigint) => n.toString(16).padStart(64, '0');
const addrWord = (a: string) => a.toLowerCase().replace(/^0x/, '').padStart(64, '0');
/** The low 20 bytes of a 32-byte word. */
const readAddress = (w: string) => '0x' + w.slice(-40);
const readUint = (hex: string, slot: number) =>
  BigInt('0x' + hex.slice(2 + slot * 64, 2 + (slot + 1) * 64));

/** Decodes a solidity `string` return value. Falls back to null on bytes32-style symbols. */
export function readString(hex: string): string | null {
  if (!hex || hex.length < 130) return null;
  try {
    const len = Number(readUint(hex, 1));
    if (!Number.isFinite(len) || len === 0 || len > 128) return null;
    const bytes = hex.slice(130, 130 + len * 2);
    if (bytes.length < len * 2) return null;
    const out = decodeURIComponent(bytes.replace(/(..)/g, '%$1'));
    return /^[\x20-\x7e]+$/.test(out) ? out : null;
  } catch {
    return null;
  }
}

/** getReserves() -> (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast) */
export function readReserves(hex: string): [bigint, bigint] | null {
  if (!hex || hex.length < 2 + 3 * 64) return null;
  return [readUint(hex, 0), readUint(hex, 1)];
}

export type Fetcher = (url: string, init: RequestInit) => Promise<Response>;

/**
 * Sends eth_call in JSON-RPC batches, in order, never more than MAX_BATCH at a
 * time. Returns one hex string (or null) per call, aligned with the input.
 */
export interface Io {
  rpcUrl?: string;
  fetcher?: Fetcher;
  pauseMs?: number;
  /** Attempts per request before giving up. The public RPC throttles. */
  retries?: number;
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * One request, with backoff.
 *
 * The public endpoint is rate limited — hit it too fast and the request does
 * not come back with an error code, it fails outright. Every call therefore
 * backs off and tries again rather than tearing the whole page down.
 */
async function send(body: unknown, io: Io): Promise<unknown> {
  const direct = io.rpcUrl ?? RPC_URL;
  const f: Fetcher = io.fetcher ?? ((u, i) => fetch(u, i));
  const tries = io.retries ?? 3;
  // Direct first, every time. The fallback is only reached once the endpoint
  // has refused three times in a row, and it is dropped again on the next call.
  const routes = io.rpcUrl || io.fetcher ? [direct] : [direct, RPC_FALLBACK];
  let last: unknown = null;

  for (const url of routes) {
    for (let attempt = 0; attempt < tries; attempt++) {
      try {
        const res = await f(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        if (!res.ok) throw new Error(`rpc ${res.status}`);
        return await res.json();
      } catch (err) {
        last = err;
        if (attempt < tries - 1) await wait(500 * (attempt + 1));
      }
    }
  }
  throw last instanceof Error ? last : new Error('rpc unreachable');
}

/** A single JSON-RPC call that is not eth_call. */
export async function rpc<T>(method: string, params: unknown[], io: Io = {}): Promise<T> {
  const json = (await send({ jsonrpc: '2.0', id: 1, method, params }, io)) as {
    result?: T;
    error?: { message?: string };
  };
  if (json.error) throw new Error(json.error.message ?? method);
  return json.result as T;
}

/**
 * Sends eth_call in JSON-RPC batches, in order, never more than MAX_BATCH at a
 * time. Returns one hex string (or null) per call, aligned with the input.
 */
export async function ethCallBatch(calls: Call[], io: Io = {}): Promise<(string | null)[]> {
  const pause = io.pauseMs ?? 220;
  const out: (string | null)[] = new Array(calls.length).fill(null);

  for (let start = 0; start < calls.length; start += MAX_BATCH) {
    const slice = calls.slice(start, start + MAX_BATCH);
    const body = slice.map((c, i) => ({
      jsonrpc: '2.0',
      id: i,
      method: 'eth_call',
      params: [{ to: c.to, data: c.data }, 'latest'],
    }));
    const json = (await send(body, io)) as Array<{ id: number; result?: string }>;
    for (const entry of json) {
      if (typeof entry.id === 'number' && typeof entry.result === 'string') {
        out[start + entry.id] = entry.result;
      }
    }
    if (start + MAX_BATCH < calls.length && pause > 0) await wait(pause);
  }
  return out;
}

/**
 * The hubs.
 *
 * Measured, not assumed. A sample of 200 pairs spread across the whole factory
 * came out 38% paired against WETH and 61% against something else — and almost
 * all of that "something else" was one token, VIRTUAL, which runs its own
 * launchpad. Tokens launched there pair with VIRTUAL and never with WETH.
 *
 * So the pool graph on this chain is not a star. It has two centres joined by a
 * deep VIRTUAL/WETH pool, plus USDG hanging off WETH as the dollar. That is why
 * routing here is a real question: getting from a VIRTUAL-side token to a
 * WETH-side one is a four-node path, and which hub you cross at matters.
 */
export interface Hub {
  symbol: string;
  /** Lower-case, as every address in this module is. */
  address: string;
  decimals: number;
}

export const HUBS: Hub[] = [
  { symbol: 'WETH', address: WETH, decimals: 18 },
  { symbol: 'VIRTUAL', address: '0xc6911796042b15d7fa4f6cde69e245ddcd3d9c31', decimals: 18 },
  { symbol: 'USDG', address: USDG, decimals: USDG_DECIMALS },
];

export const VIRTUAL = HUBS[1].address;

export interface LivePool {
  pair: string;
  /** Which hub this pool is anchored on. */
  hub: string;
  /** The other token, or a second hub when the pool joins two of them. */
  symbol: string;
  token: string;
  /** Reserve on the hub side, in whole units. */
  hubReserve: number;
  /** Both sides valued at the hub side, in dollars. */
  liquidityUsd: number;
}

export interface LiveSnapshot {
  pools: LivePool[];
  /** Every hub priced in dollars, read from the pools themselves. */
  hubUsd: Record<string, number>;
  /** Chain head at the time of the read. */
  blockNumber: number;
  /** How many pools were priced across all hubs. */
  scanned: number;
}

export interface ScanOptions {
  /** How many of a hub's newest pools to price. */
  perHubScan?: number;
  /** Ignore a pool worth less than this in dollars. */
  minUsd?: number;
  /** Keep at most this many pools per hub, deepest first. */
  perHub?: number;
  /** How far back to ask for PairCreated events. */
  windowBlocks?: number;
  rpcUrl?: string;
  fetcher?: Fetcher;
}

/**
 * Prices every hub in dollars, using USDG as the unit.
 *
 * USDG is a dollar by definition. WETH comes from the WETH/USDG pool. Every
 * other hub comes from its pool against WETH. No oracle, no price API — the
 * numbers come out of the same reserves the routing uses, so they cannot
 * disagree with it.
 */
export async function fetchHubPrices(io: Io = {}): Promise<Record<string, number>> {
  const out: Record<string, number> = { USDG: 1 };

  const others = HUBS.filter((h) => h.symbol !== 'USDG' && h.symbol !== 'WETH');
  const wanted = [
    { symbol: 'WETH', against: USDG, againstDecimals: USDG_DECIMALS, self: WETH, selfDecimals: 18 },
    ...others.map((h) => ({
      symbol: h.symbol,
      against: WETH,
      againstDecimals: 18,
      self: h.address,
      selfDecimals: h.decimals,
    })),
  ];

  const pairWords = await ethCallBatch(
    wanted.map((x) => ({
      to: V2_FACTORY,
      data: SEL.getPair + addrWord(x.self) + addrWord(x.against),
    })),
    io,
  );
  const live = wanted
    .map((x, i) => ({ x, pair: pairWords[i] ? readAddress(pairWords[i]!) : null }))
    .filter((e): e is { x: (typeof wanted)[number]; pair: string } => !!e.pair && !/^0x0+$/.test(e.pair));

  const calls: Call[] = [];
  for (const e of live) {
    calls.push({ to: e.pair, data: SEL.getReserves });
    calls.push({ to: e.pair, data: SEL.token0 });
  }
  const answers = await ethCallBatch(calls, io);

  for (let i = 0; i < live.length; i++) {
    const { x } = live[i];
    const res = readReserves(answers[i * 2] ?? '');
    const t0 = answers[i * 2 + 1];
    if (!res || !t0) continue;
    const selfIsToken0 = readAddress(t0) === x.self.toLowerCase();
    const selfRes = Number(selfIsToken0 ? res[0] : res[1]) / 10 ** x.selfDecimals;
    const otherRes = Number(selfIsToken0 ? res[1] : res[0]) / 10 ** x.againstDecimals;
    if (!selfRes) continue;
    const otherUsd = x.against === USDG ? 1 : out['WETH'];
    if (otherUsd) out[x.symbol] = (otherRes / selfRes) * otherUsd;
  }
  return out;
}

/** WETH in dollars. Its own entry point because the page shows it. */
export async function fetchEthPrice(io: Io = {}): Promise<number | null> {
  return (await fetchHubPrices(io))['WETH'] ?? null;
}

const pairKey = (a: string, b: string) => [a, b].sort().join('-');
const hexBlock = (n: number) => '0x' + Math.max(0, n).toString(16);

interface RawLog {
  topics: string[];
  data: string;
  blockNumber: string;
}

export interface PairRecord {
  pair: string;
  /** The token on the other side of the hub. */
  other: string;
  block: number;
}

/**
 * Every pool a hub has, from the factory's own PairCreated events.
 *
 * This replaces walking allPairs(i) one index at a time. The event carries the
 * two tokens and the pool address together, so two requests give a hub's whole
 * list — tokens included — where the index walk needed three calls per pool and
 * could not tell which pools mattered until it had fetched them all.
 *
 * The hub can be either side of a pair (Uniswap orders the two tokens by
 * address), so both positions are asked for.
 */
export async function fetchHubPairs(
  hub: Hub,
  fromBlock: number,
  io: Io = {},
): Promise<PairRecord[]> {
  const topic = (a: string) => '0x' + a.replace(/^0x/, '').padStart(64, '0');
  const query = (topics: (string | null)[]) =>
    rpc<RawLog[]>(
      'eth_getLogs',
      [{ address: V2_FACTORY, topics, fromBlock: hexBlock(fromBlock), toBlock: 'latest' }],
      io,
    );

  const [asToken0, asToken1] = [
    await query([PAIR_CREATED, topic(hub.address)]),
    await query([PAIR_CREATED, null, topic(hub.address)]),
  ];

  const read = (logs: RawLog[], hubIsToken0: boolean): PairRecord[] =>
    (logs ?? []).map((l) => ({
      // data is (address pair, uint allPairsLength); the pair is the first word
      pair: readAddress(l.data.slice(0, 66)),
      other: readAddress(hubIsToken0 ? l.topics[2] : l.topics[1]),
      block: Number(BigInt(l.blockNumber)),
    }));

  return [...read(asToken0, true), ...read(asToken1, false)].sort((a, b) => a.block - b.block);
}

/**
 * Reads what is actually tradable on each hub.
 *
 * Per hub: take its newest pools, price the reserves, drop the empty ones, keep
 * the deepest few. Then join the hubs to each other, because without those
 * bridges the graph is a set of islands and there is nothing to route.
 */
export async function fetchLivePools(options: ScanOptions = {}): Promise<LiveSnapshot> {
  const perHubScan = options.perHubScan ?? 30;
  const minUsd = options.minUsd ?? 2_000;
  const perHub = options.perHub ?? 4;
  const windowBlocks = options.windowBlocks ?? LOG_WINDOW_BLOCKS;
  const io: Io = { rpcUrl: options.rpcUrl, fetcher: options.fetcher };

  const hubUsd = await fetchHubPrices(io);
  const headHex = await rpc<string>('eth_blockNumber', [], io);
  const head = Number(BigInt(headHex));
  const from = head - windowBlocks;

  type Found = { pair: string; hub: string; token: string; hubReserve: number; usd: number };
  const found: Found[] = [];
  let scanned = 0;

  for (const hub of HUBS) {
    const price = hubUsd[hub.symbol];
    if (!price) continue;
    // One hub failing is not a reason to show nothing. A snapshot missing a
    // hub is still true; an empty page claiming live data is not.
    let records: PairRecord[];
    let reserves: (string | null)[];
    let token0s: (string | null)[];
    try {
      records = (await fetchHubPairs(hub, from, io)).slice(-perHubScan);
      if (records.length === 0) continue;
      reserves = await ethCallBatch(
        records.map((r) => ({ to: r.pair, data: SEL.getReserves })),
        io,
      );
      token0s = await ethCallBatch(
        records.map((r) => ({ to: r.pair, data: SEL.token0 })),
        io,
      );
    } catch {
      continue;
    }
    scanned += records.length;

    const priced: Found[] = [];
    for (let i = 0; i < records.length; i++) {
      const res = readReserves(reserves[i] ?? '');
      const t0 = token0s[i];
      if (!res || !t0) continue;
      const hubIsToken0 = readAddress(t0) === hub.address;
      const hubReserve = Number(hubIsToken0 ? res[0] : res[1]) / 10 ** hub.decimals;
      const usd = hubReserve * price * 2;
      if (usd < minUsd) continue;
      priced.push({ pair: records[i].pair, hub: hub.symbol, token: records[i].other, hubReserve, usd });
    }
    priced.sort((a, b) => b.usd - a.usd);
    found.push(...priced.slice(0, perHub));
  }

  // The bridges. Asked for by address rather than by event, because the pools
  // joining two hubs are old and may sit outside the event window.
  const links: Array<{ a: Hub; b: Hub }> = [];
  for (let i = 0; i < HUBS.length; i++) {
    for (let j = i + 1; j < HUBS.length; j++) links.push({ a: HUBS[i], b: HUBS[j] });
  }
  const linkWords = await ethCallBatch(
    links.map((l) => ({
      to: V2_FACTORY,
      data: SEL.getPair + addrWord(l.a.address) + addrWord(l.b.address),
    })),
    io,
  );
  const linkPairs = links
    .map((l, i) => ({ l, pair: linkWords[i] ? readAddress(linkWords[i]!) : null }))
    .filter((x): x is { l: { a: Hub; b: Hub }; pair: string } => !!x.pair && !/^0x0+$/.test(x.pair));

  const linkCalls: Call[] = [];
  for (const x of linkPairs) {
    linkCalls.push({ to: x.pair, data: SEL.getReserves });
    linkCalls.push({ to: x.pair, data: SEL.token0 });
  }
  const linkAnswers = await ethCallBatch(linkCalls, io);

  const already = new Set(found.map((f) => pairKey(f.hub, f.token)));
  const joins: Found[] = [];
  for (let i = 0; i < linkPairs.length; i++) {
    const res = readReserves(linkAnswers[i * 2] ?? '');
    const t0 = linkAnswers[i * 2 + 1];
    if (!res || !t0) continue;
    const { a, b } = linkPairs[i].l;
    const aIsToken0 = readAddress(t0) === a.address;
    const aRes = Number(aIsToken0 ? res[0] : res[1]) / 10 ** a.decimals;
    const price = hubUsd[a.symbol];
    if (!price || !aRes) continue;
    const usd = aRes * price * 2;
    if (usd < minUsd) continue;
    if (already.has(pairKey(a.symbol, b.address))) continue;
    joins.push({ pair: linkPairs[i].pair, hub: a.symbol, token: b.address, hubReserve: aRes, usd });
  }

  // Bridges first, so the hubs exist as nodes before anything hangs off them.
  const all = [...joins, ...found];
  const hubSymbolOf = new Map(HUBS.map((h) => [h.address, h.symbol]));
  const unknown = all.filter((f) => !hubSymbolOf.has(f.token));
  const symbols = await ethCallBatch(
    unknown.map((f) => ({ to: f.token, data: SEL.symbol })),
    io,
  );
  const symbolOf = new Map<string, string>();
  unknown.forEach((f, i) => {
    symbolOf.set(f.token, readString(symbols[i] ?? '') ?? f.token.slice(2, 8).toUpperCase());
  });

  const pools: LivePool[] = all.map((f) => ({
    pair: f.pair,
    hub: f.hub,
    token: f.token,
    symbol: hubSymbolOf.get(f.token) ?? symbolOf.get(f.token) ?? '?',
    hubReserve: f.hubReserve,
    liquidityUsd: f.usd,
  }));

  return { pools, hubUsd, blockNumber: head, scanned };
}

/**
 * Live pools in the shape the solver eats.
 *
 * Symbols are made unique before they become graph nodes: two freshly launched
 * tokens sharing a ticker is normal, and silently merging them into one node
 * would invent a route that does not exist.
 */
export function toPools(snapshot: LiveSnapshot): import('./pools.ts').Pool[] {
  const used = new Map<string, string>();
  const label = (token: string, symbol: string) => {
    const existing = used.get(token);
    if (existing) return existing;
    const taken = new Set(used.values());
    let name = symbol;
    let n = 2;
    while (taken.has(name)) name = `${symbol} (${n++})`;
    used.set(token, name);
    return name;
  };
  const hubAddress = new Map(HUBS.map((h) => [h.symbol, h.address]));
  return snapshot.pools.map((p) => ({
    tokenA: label(hubAddress.get(p.hub) ?? p.hub, p.hub),
    tokenB: label(p.token, p.symbol),
    feeBps: V2_FEE_BPS,
    liquidityUsd: p.liquidityUsd,
  }));
}
