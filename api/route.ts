/**
 * The routing endpoint.
 *
 * Everything else on this site shows the organism solving. This lets something
 * else ask it. Give it two tokens and a trade size and it reads the chain, runs
 * the model until the network stops changing, and answers with the route that
 * survived.
 *
 *     /api/route?from=WETH&to=USDG&size=10000
 *
 * Two things are deliberate.
 *
 * The answer carries Dijkstra's result next to the mould's, and a flag saying
 * whether they agree. The model is proven to converge on the shortest path, so
 * a disagreement means this endpoint is wrong — and it says so itself rather
 * than waiting to be caught.
 *
 * And the pool snapshot is held for a few seconds between calls. Reading every
 * pool takes a dozen round trips to the chain, and doing that per request would
 * make the endpoint unusable. The age of the snapshot is in every answer, so
 * nobody has to take its freshness on trust.
 */
export const config = { runtime: 'edge' };

// No .ts on these two on purpose. Vercel scans the entry file of an edge
// function before bundling it and rejects a specifier ending in .ts outright:
//   The Edge Function "api/route" is referencing unsupported modules
// Extensionless, the same files resolve, and everything they import in turn is
// left alone because by then it is the bundler's problem, not the scanner's.
import { fetchLivePools, toPools, RPC_URL, type LiveSnapshot } from '../src/core/chain';
import { planRoute } from '../src/core/route';

/** Server side there is no CORS to work around, so the chain is read directly. */
const io = { rpcUrl: RPC_URL };

const MAX_AGE_MS = 8_000;
let cached: { at: number; snapshot: LiveSnapshot } | null = null;

async function snapshot(): Promise<{ snapshot: LiveSnapshot; ageMs: number }> {
  const now = Date.now();
  if (cached && now - cached.at < MAX_AGE_MS) {
    return { snapshot: cached.snapshot, ageMs: now - cached.at };
  }
  const fresh = await fetchLivePools({ ...io });
  cached = { at: now, snapshot: fresh };
  return { snapshot: fresh, ageMs: 0 };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body, null, 2), {
    status,
    headers: {
      'content-type': 'application/json',
      'access-control-allow-origin': '*',
      'cache-control': 'no-store',
    },
  });

export default async function handler(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const size = Number(url.searchParams.get('size') ?? 10_000);
  if (!isFinite(size) || size <= 0) {
    return json({ error: 'size must be a positive number of dollars' }, 400);
  }

  let snap: LiveSnapshot;
  let ageMs: number;
  try {
    ({ snapshot: snap, ageMs } = await snapshot());
  } catch {
    return json({ error: 'the chain did not answer' }, 502);
  }

  const pools = toPools(snap, size);
  if (pools.length < 2) return json({ error: 'no pools were readable just now' }, 502);

  const from = url.searchParams.get('from');
  const to = url.searchParams.get('to');
  if (!from || !to) {
    const tokens = [...new Set(pools.flatMap((p) => [p.tokenA, p.tokenB]))];
    return json({
      usage: '/api/route?from=WETH&to=USDG&size=10000',
      block: snap.blockNumber,
      tokens,
      note: 'Symbols as they appear on the chain. Two tokens may share one; they are kept apart by address.',
    });
  }

  const plan = planRoute(pools, from, to, size);
  if ('error' in plan) return json({ ...plan, from, to }, 400);

  return json({
    from,
    to,
    tradeSizeUsd: size,
    block: snap.blockNumber,
    snapshotAgeMs: ageMs,
    ...plan,
    disclaimer:
      'A quote is true for its block and nothing more. Re-check against the pool before swapping.',
  });
}
