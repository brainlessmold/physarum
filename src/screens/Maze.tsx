import { useMemo, useState } from 'react';
import { generateMaze, mazeEndpoints } from '../core/graph.ts';
import { shortestPath } from '../core/dijkstra.ts';
import { SimCanvas, type SimStats } from '../SimCanvas.tsx';

const COLS = 13;
const ROWS = 8;

export function Maze() {
  const [seed, setSeed] = useState(0);
  const [stats, setStats] = useState<SimStats | null>(null);

  const { graph, food, reference } = useMemo(() => {
    const g = generateMaze(COLS, ROWS);
    const [source, sink] = mazeEndpoints(COLS, ROWS);
    return { graph: g, food: [source, sink], reference: shortestPath(g, source, sink) };
  }, [seed]);

  const delta = stats ? stats.length - reference.distance : null;
  const matched = delta !== null && Math.abs(delta) < 1e-3;

  return (
    <div className="screen">
      <p className="lede">
        Nature, 2000: the mold was placed in a maze with food at both ends. It withdrew from
        every dead end and held one tube — the shortest path. Same thing here, except it is
        being computed in your browser.
      </p>

      <div className="frame">
        <SimCanvas graph={graph} food={food} onStats={setStats} />
        <div className="bar">
          <span>
            step <b>{stats?.steps ?? 0}</b>
          </span>
          <span>
            tubes alive{' '}
            <b>
              {stats?.alive ?? '—'} / {stats?.total ?? '—'}
            </b>
          </span>
          <span>
            network length <b>{stats ? stats.length.toFixed(3) : '—'}</b>
          </span>
          <span>
            Dijkstra <b>{reference.distance.toFixed(3)}</b>
          </span>
          <button type="button" onClick={() => setSeed((s) => s + 1)}>
            new maze
          </button>
        </div>
      </div>

      <p className={matched ? 'verdict ok' : 'verdict wait'}>
        {matched
          ? 'Converged: the surviving network matches the shortest path.'
          : 'Running. Yellow marks the tubes carrying flow; they thicken, the rest die off.'}
      </p>

      <p className="note">
        Dijkstra on the right is the control. Same graph, ordinary algorithm. The mold has to
        arrive at the same number, and <code>npm test</code> checks that across twenty mazes in
        a row.
      </p>
    </div>
  );
}
