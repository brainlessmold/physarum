import { useMemo, useState } from 'react';
import { buildPoolGraph, EXAMPLE_POOLS, poolCost } from '../core/pools.ts';
import { shortestPath } from '../core/dijkstra.ts';
import { SimCanvas, type SimStats } from '../SimCanvas.tsx';

const TRADE_SIZES = [1_000, 10_000, 50_000, 250_000];

export function Pools() {
  const [tradeSizeUsd, setTradeSize] = useState(10_000);
  const [from, setFrom] = useState('USDC');
  const [to, setTo] = useState('MOLD');
  const [stats, setStats] = useState<SimStats | null>(null);

  const { graph, tokens, indexOf } = useMemo(
    () => buildPoolGraph(EXAMPLE_POOLS, { tradeSizeUsd }),
    [tradeSizeUsd],
  );

  const a = indexOf(from);
  const b = indexOf(to);
  const food = useMemo(() => (a >= 0 && b >= 0 && a !== b ? [a, b] : [0, 1]), [a, b]);
  const best = useMemo(() => shortestPath(graph, food[0], food[1]), [graph, food]);

  return (
    <div className="screen">
      <p className="lede">
        The same organism on a graph of pools. Nodes are tokens, edge length is what a swap
        through that pool actually costs: fee plus slippage. The network it converges on is the
        route.
      </p>

      <div className="controls">
        <label>
          from
          <select id="pool-from" value={from} onChange={(e) => setFrom(e.target.value)}>
            {tokens.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </label>
        <label>
          to
          <select id="pool-to" value={to} onChange={(e) => setTo(e.target.value)}>
            {tokens.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </label>
        <label>
          trade size
          <select
            id="pool-size"
            value={tradeSizeUsd}
            onChange={(e) => setTradeSize(Number(e.target.value))}
          >
            {TRADE_SIZES.map((s) => (
              <option key={s} value={s}>
                ${s.toLocaleString('en-US')}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className="frame">
        <SimCanvas
          graph={graph}
          food={food}
          aspect={0.7}
          renderOptions={{ showLabels: true, padding: 40 }}
          onStats={setStats}
        />
        <div className="bar">
          <span>
            step <b>{stats?.steps ?? 0}</b>
          </span>
          <span>
            route{' '}
            <b>{best.nodes.length ? best.nodes.map((i) => tokens[i]).join(' → ') : 'no path'}</b>
          </span>
          <span>
            cost <b>{isFinite(best.distance) ? `${(best.distance * 100).toFixed(2)}%` : '—'}</b>
          </span>
        </div>
      </div>

      <div className="t-scroll">
        <table>
          <thead>
            <tr>
              <th>pool</th>
              <th className="num">fee</th>
              <th className="num">liquidity</th>
              <th className="num">cost to route</th>
            </tr>
          </thead>
          <tbody>
            {EXAMPLE_POOLS.map((p) => (
              <tr key={`${p.tokenA}-${p.tokenB}`}>
                <td>
                  {p.tokenA} / {p.tokenB}
                </td>
                <td className="num">{(p.feeBps / 100).toFixed(2)}%</td>
                <td className="num">${p.liquidityUsd.toLocaleString('en-US')}</td>
                <td className="num">{(poolCost(p, { tradeSizeUsd }) * 100).toFixed(2)}%</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="honesty-inline">
        <b>This is example data, not real pools.</b> The screener plugs in here — it already
        collects RH Chain pools, they just need to be handed over in the <code>Pool</code> shape
        from <code>src/core/pools.ts</code>. Slippage is a rough <code>S / L</code> estimate for a
        constant-product pool; before any real swap the route must be re-checked against the
        pool's own quoter.
      </div>
    </div>
  );
}
