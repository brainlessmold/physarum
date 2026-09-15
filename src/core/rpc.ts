/**
 * Talking to the chain, and the wire format it talks in.
 *
 * Kept apart from everything that uses it for a reason that is not tidiness:
 * chain.ts reads pools, v3.ts and v4.ts quote them, and all three need this
 * transport. When it lived in chain.ts the modules imported each other in a
 * circle, which a browser tolerates and a server bundle does not — it loaded
 * the cycle and died on the first call, in under half a second, with nothing
 * in the log to say why.
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

/** The public RPC rejects batches larger than this. Measured, not guessed: 50 is accepted, 100 is refused. */
export const MAX_BATCH = 40;

export interface Call {
  to: string;
  data: string;
}

export const word = (n: number | bigint) => n.toString(16).padStart(64, '0');
export const addrWord = (a: string) => a.toLowerCase().replace(/^0x/, '').padStart(64, '0');
/** The low 20 bytes of a 32-byte word. */
export const readAddress = (w: string) => '0x' + w.slice(-40);
export const readUint = (hex: string, slot: number) =>
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
