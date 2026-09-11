import { useMemo, useState } from 'react';
import { buildGraph } from '../core/graph.ts';
import { KANTO, project, nearestNeighbourEdges } from '../data/kanto.ts';
import { SimCanvas, type SimStats } from '../SimCanvas.tsx';

export function Tokyo() {
  const [seed, setSeed] = useState(0);
  const [stats, setStats] = useState<SimStats | null>(null);

  const { graph, food, candidates } = useMemo(() => {
    const points = project(KANTO);
    const pairs = nearestNeighbourEdges(points, 4);
    const g = buildGraph(points, pairs);
    // Food sits in every city: the source-sink pair is redrawn on every step.
    const f = KANTO.map((_, i) => i);
    return { graph: g, food: f, candidates: pairs };
  }, [seed]);

  return (
    <div className="screen">
      <p className="lede">
        Science, 2010: oat flakes were laid out on the cities around Tokyo. Within 26 hours the
        mold had grown a network matching the Tokyo rail system in cost and efficiency.
      </p>

      <div className="frame">
        <SimCanvas
          graph={graph}
          food={food}
          aspect={0.78}
          options={{ I0: 1, g: 1.15, dt: 0.12, pairsPerStep: 8, relaxIters: 20 }}
          aliveCut={0.01}
          renderOptions={{ underlay: candidates, showLabels: true, maxWidth: 6, padding: 34 }}
          onStats={setStats}
        />
        <div className="bar">
          <span>
            step <b>{stats?.steps ?? 0}</b>
          </span>
          <span>
            routes{' '}
            <b>
              {stats?.alive ?? '—'} / {stats?.total ?? '—'}
            </b>
          </span>
          <span>
            cities <b>{KANTO.length}</b>
          </span>
          <button type="button" onClick={() => setSeed((s) => s + 1)}>
            restart
          </button>
        </div>
      </div>

      <p className="note">
        Dashed lines are every route that was available. Yellow marks the ones the mold kept.
        The exponent g = 1.15 comes from the paper: at that value the network does not collapse
        into a single line but stays branched, like an actual railway. The source-sink pair is
        redrawn every step and averaged over eight pairs at once — otherwise the tubes to distant
        cities die off between visits and the network stops covering them.
      </p>

      <div className="honesty-inline">
        <b>What is honest here.</b> The equations and parameters are from the paper. The
        coordinates are the real coordinates of Kanto cities. But this is <b>not</b> a
        reproduction of the experiment: the paper used 36 suburban rail stations on a continuous
        substrate, not a nearest-neighbour graph. The 1.75 against 1.80 figures are the authors'
        result, not ours.
      </div>
    </div>
  );
}
