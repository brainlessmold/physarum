import { useEffect, useMemo, useState } from 'react';
import { buildGraph, generateMaze, mazeEndpoints } from './core/graph.ts';
import { shortestPath } from './core/dijkstra.ts';
import { KANTO, project, nearestNeighbourEdges } from './data/kanto.ts';
import { buildPoolGraph, defaultEnds, EXAMPLE_POOLS, poolCost } from './core/pools.ts';
import { fetchLivePools, toPools, type LiveSnapshot } from './core/chain.ts';
import { SimCanvas, type SimStats } from './SimCanvas.tsx';
import { Sim3D, type Sim3DStats } from './Sim3D.tsx';

/** Verified on chain: name Physarum, symbol PHYSARUM, 18 decimals, 1e9 supply. */
const CONTRACT: string | null = '0x421f2cedab5e16fbfa39fd537b67863c6a7c72af';
/** Name and ticker are the same word, as everywhere else in this meta. */
const NAME = 'Physarum';
const TICKER = 'PHYSARUM';
const REPO = 'https://github.com/brainlessmold/physarum';
const HANDLE = 'https://x.com/brainlessmold';

/* ------------------------------------------------------------------ */
/* Legend                                                              */
/* ------------------------------------------------------------------ */

/**
 * Visitors arrive here from sites where the dots on a dark field are neurons —
 * elegans plots 302 soma positions, flybrain labels its panel "FIRING NEURONS".
 * Without this the reflex reading inverts the one claim the project makes.
 */
function Legend({ junctions = true }: { junctions?: boolean }) {
  return (
    <ul className="legend">
      <li>
        <i className="k-food" /> food source — an oat flake in the dish; every one has to be reached
      </li>
      {junctions ? (
        <li>
          <i className="k-node" /> junction — a place a tube is allowed to branch
        </li>
      ) : null}
      <li>
        <i className="k-tube" /> tube — thickness is the flow it carries
      </li>
      <li>
        <i className="k-dead" /> abandoned — carried nothing, starved
      </li>
      <li className="not">not neurons. this organism has none.</li>
    </ul>
  );
}

/* ------------------------------------------------------------------ */
/* The body                                                            */
/* ------------------------------------------------------------------ */

function Body3D() {
  const [seed, setSeed] = useState(0);
  const [stats, setStats] = useState<Sim3DStats | null>(null);

  return (
    <div className="body3d">
      <Sim3D aspect={0.82} seed={seed} onStats={setStats} />
      <div className="strip">
        <span>
          step <b>{stats?.steps ?? 0}</b>
        </span>
        <span>
          tubes <b>{stats ? `${stats.alive} / ${stats.total}` : '—'}</b>
        </span>
        <span>
          points <b>{stats?.nodes ?? '—'}</b>
        </span>
        <span className="hint">drag to turn it</span>
        <button className="ghost push" type="button" onClick={() => setSeed((x) => x + 1)}>
          grow another
        </button>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Live panel                                                          */
/* ------------------------------------------------------------------ */

function LivePanel() {
  const [seed, setSeed] = useState(0);
  const [stats, setStats] = useState<SimStats | null>(null);

  const { graph, food, candidates } = useMemo(() => {
    const points = project(KANTO);
    const pairs = nearestNeighbourEdges(points, 4);
    return {
      graph: buildGraph(points, pairs),
      food: KANTO.map((_, i) => i),
      candidates: pairs,
    };
  }, [seed]);

  const pruned = stats ? stats.total - stats.alive : null;

  return (
    <>
      <div className="live-wrap">
        <div className="live-canvas">
          <SimCanvas
            graph={graph}
            food={food}
            aspect={0.66}
            options={{ I0: 1, g: 1.15, dt: 0.12, pairsPerStep: 8, relaxIters: 20 }}
            aliveCut={0.01}
            renderOptions={{
              underlay: candidates,
              showLabels: true,
              showFlow: true,
              maxWidth: 7,
              padding: 38,
            }}
            onStats={setStats}
          />
        </div>

        <div className="live-side">
          <div className="readout">
            <span className="lbl">Integration step</span>
            <span className="val">{stats?.steps ?? 0}</span>
            <span className="note">8 source-sink pairs per step</span>
          </div>
          <div className="readout">
            <span className="lbl">Tubes alive</span>
            <span className="val">
              {stats?.alive ?? '—'} <span style={{ color: 'var(--faint)' }}>/ {stats?.total ?? '—'}</span>
            </span>
            <span className="note">{pruned === null ? '—' : `${pruned} starved and died`}</span>
          </div>
          <div className="readout">
            <span className="lbl">Network length</span>
            <span className="val">{stats ? stats.length.toFixed(3) : '—'}</span>
            <span className="note">sum of surviving tube lengths</span>
          </div>
          <div className="readout">
            <span className="lbl">Food sources</span>
            <span className="val">{KANTO.length}</span>
            <span className="note">Kanto cities, real coordinates</span>
          </div>
          <div className="readout">
            <span className="lbl">Neurons</span>
            <span className="val">0</span>
            <span className="note">one cell, no nervous system</span>
          </div>
        </div>
      </div>

      <div className="strip">
        <span>
          model <b>Tero et al. 2010</b>
        </span>
        <span>
          I₀ <b>1.0</b>
        </span>
        <span>
          g <b>1.15</b>
        </span>
        <span>
          dt <b>0.12</b>
        </span>
        <span>
          solver <b>Gauss-Seidel ×20</b>
        </span>
        <button className="ghost push" type="button" onClick={() => setSeed((s) => s + 1)}>
          regrow
        </button>
      </div>
      <Legend />
    </>
  );
}

/* ------------------------------------------------------------------ */
/* Lab                                                                 */
/* ------------------------------------------------------------------ */

const MAZE_COLS = 11;
const MAZE_ROWS = 7;

function MazeLab() {
  const [seed, setSeed] = useState(0);
  const [stats, setStats] = useState<SimStats | null>(null);

  const { graph, food, reference } = useMemo(() => {
    const g = generateMaze(MAZE_COLS, MAZE_ROWS);
    const [s, t] = mazeEndpoints(MAZE_COLS, MAZE_ROWS);
    return { graph: g, food: [s, t], reference: shortestPath(g, s, t) };
  }, [seed]);

  const matched = stats !== null && Math.abs(stats.length - reference.distance) < 1e-3;

  // Once it has settled, hold the answer for a moment and then lay out a new
  // maze. Otherwise the panel is a still picture for anyone who arrives late.
  useEffect(() => {
    if (!matched) return;
    const t = setTimeout(() => setSeed((s) => s + 1), 2600);
    return () => clearTimeout(t);
  }, [matched, seed]);

  return (
    <div className="lab">
      <div className="lab-head">
        <p>
          Food at both ends of a maze. The mold floods every corridor at once, then starves the
          ones that lead nowhere. The moving dots are the flux: they run in the direction the flow
          goes, faster where there is more of it, and a tube thickens in proportion to what passes
          through it — so the dots are the reason the survivors survive. Grey is a corridor given
          up on, white is one kept. Dijkstra runs on the same graph as a control; the two numbers
          have to meet, and then a fresh maze is laid out.
        </p>
      </div>
      <p className={matched ? 'verdict ok' : 'verdict wait'}>
        {matched
          ? '✓ converged — surviving network equals the shortest path'
          : stats && stats.steps < 3
            ? '· flooded — every corridor is open'
            : '· starving the dead ends'}
      </p>
      <SimCanvas
        graph={graph}
        food={food}
        aspect={0.46}
        options={{ g: 1.8, dt: 0.045, I0: 1 }}
        stepInterval={62}
        holdMs={1500}
        renderOptions={{ showLattice: true, showFlow: true, maxWidth: 11, padding: 30 }}
        onStats={setStats}
      />
      <div className="strip">
        <span>
          step <b>{stats?.steps ?? 0}</b>
        </span>
        <span>
          corridors <b>{stats ? `${stats.alive} / ${stats.total}` : '—'}</b>
        </span>
        <span>
          mold <b>{stats ? stats.length.toFixed(3) : '—'}</b>
        </span>
        <span>
          dijkstra <b>{reference.distance.toFixed(3)}</b>
        </span>
        <button className="ghost push" type="button" onClick={() => setSeed((s) => s + 1)}>
          new maze
        </button>
      </div>
      <div className="lab-legend">
        <Legend />
      </div>
    </div>
  );
}

type FeedState = 'loading' | 'live' | 'offline';

function PoolsLab() {
  const [tradeSizeUsd, setTradeSize] = useState(10_000);
  const [stats, setStats] = useState<SimStats | null>(null);
  const [snapshot, setSnapshot] = useState<LiveSnapshot | null>(null);
  const [feed, setFeed] = useState<FeedState>('loading');
  const [ends, setEnds] = useState<[string, string] | null>(null);

  // Read the chain once, on mount. Until it answers the example graph is shown
  // and labelled as an example; if it never answers, that label stays.
  useEffect(() => {
    let cancelled = false;
    fetchLivePools({ perHubScan: 30, minUsd: 2_000, perHub: 4 })
      .then((snap) => {
        if (cancelled) return;
        if (snap.pools.length < 2) {
          setFeed('offline');
          return;
        }
        setSnapshot(snap);
        setFeed('live');
        setEnds(null);
      })
      .catch(() => {
        if (!cancelled) setFeed('offline');
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const pools = useMemo(
    () => (snapshot ? toPools(snapshot, tradeSizeUsd) : EXAMPLE_POOLS),
    [snapshot, tradeSizeUsd],
  );
  const viaV3 = pools.filter((p) => p.venue === 'v3').length;

  const { graph, tokens, indexOf } = useMemo(
    () => buildPoolGraph(pools, { tradeSizeUsd }),
    [pools, tradeSizeUsd],
  );

  const fallback = useMemo(() => defaultEnds(pools), [pools]);
  const from = ends && tokens.includes(ends[0]) ? ends[0] : fallback[0];
  const to = ends && tokens.includes(ends[1]) ? ends[1] : fallback[1];

  const a = indexOf(from);
  const b = indexOf(to);
  const food = useMemo(() => (a >= 0 && b >= 0 && a !== b ? [a, b] : [0, 1]), [a, b]);
  const best = useMemo(() => shortestPath(graph, food[0], food[1]), [graph, food]);

  const ethUsd = snapshot?.hubUsd['WETH'] ?? null;
  const worst = Math.max(...pools.map((p) => poolCost(p, { tradeSizeUsd }) * 100));

  return (
    <div className="lab">
      <div className="lab-head">
        <p>
          The same organism on a graph of liquidity pools. Nodes are tokens, edge length is what a
          swap through that pool actually costs — fee plus slippage. Shortest path is therefore the
          cheapest route.
        </p>
        <p className={`feed feed-${feed}`}>
          {feed === 'live' && snapshot ? (
            <>
              <b>Live.</b> {snapshot.pools.length} Uniswap V2 pools, read from Robinhood Chain at
              block {snapshot.blockNumber.toLocaleString('en-US')}. The factory's own PairCreated
              events give every pool on each hub; the reserves, symbols and prices are then read
              from the pools themselves, straight from your browser over the public RPC — no
              indexer, no API key, nothing precomputed. WETH at $
              {ethUsd ? Math.round(ethUsd).toLocaleString('en-US') : '—'}, priced from the WETH/USDG
              pool, and every other hub priced through that.{' '}
              {viaV3 > 0 ? (
                <>
                  <b>{viaV3}</b> of these hops route through Uniswap V3 instead, because its own
                  quoter answered cheaper at this trade size — those costs are a simulation of the
                  swap against live tick state, not a formula.
                </>
              ) : (
                <>Every hop here is constant-product; V3 was asked and quoted no cheaper.</>
              )}{' '}
              (The endpoint intermittently sends its CORS header twice, which browsers reject; when
              that happens the call is repeated through a pass-through that forwards the same
              request unchanged — <code>api/rpc.ts</code> in the repository.)
            </>
          ) : feed === 'loading' ? (
            <>
              <b>Example data.</b> Reading the chain now — the graph will swap to live pools when it
              answers.
            </>
          ) : (
            <>
              <b>Example data.</b> The chain did not answer, so this is the example graph. Nothing
              here is a real pool.
            </>
          )}
        </p>
      </div>
      <div className="controls">
        <label>
          from
          <select
            id="pool-from"
            value={from}
            onChange={(e) => setEnds([e.target.value, to])}
          >
            {tokens.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </label>
        <label>
          to
          <select id="pool-to" value={to} onChange={(e) => setEnds([from, e.target.value])}>
            {tokens.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </label>
        <label>
          size
          <select
            id="pool-size"
            value={tradeSizeUsd}
            onChange={(e) => setTradeSize(Number(e.target.value))}
          >
            {[1_000, 10_000, 50_000, 250_000].map((s) => (
              <option key={s} value={s}>
                ${s.toLocaleString('en-US')}
              </option>
            ))}
          </select>
        </label>
      </div>
      <SimCanvas
        graph={graph}
        food={food}
        aspect={0.56}
        stepInterval={38}
        renderOptions={{ showLabels: true, padding: 58, showLattice: true, showFlow: true }}
        onStats={setStats}
      />
      <div className="strip">
        <span>
          step <b>{stats?.steps ?? 0}</b>
        </span>
        <span>
          route <b>{best.nodes.length ? best.nodes.map((i) => tokens[i]).join(' \u2192 ') : 'none'}</b>
        </span>
        <span>
          cost <b>{isFinite(best.distance) ? `${(best.distance * 100).toFixed(2)}%` : '\u2014'}</b>
        </span>
        <span>
          worst pool <b>{worst.toFixed(1)}%</b>
        </span>
        <span>
          venue <b>{viaV3 > 0 ? `${pools.length - viaV3}×V2 · ${viaV3}×V3` : 'V2'}</b>
        </span>
      </div>
    </div>
  );
}

const LABS = [
  { id: 'maze', label: 'Maze', el: <MazeLab /> },
  { id: 'pools', label: 'Pools', el: <PoolsLab /> },
] as const;

/* ------------------------------------------------------------------ */
/* Page                                                                */
/* ------------------------------------------------------------------ */

const MECHANISM = [
  {
    n: '01',
    title: 'Flow',
    body:
      'A unit of current is pushed from one food source to another. It spreads across the tubes exactly as current spreads across resistors — more of it through the thick, short ones. Solving that is Kirchhoff’s law, nothing more.',
    syms: ['Q_ij', 'p_i', 'L_ij'],
  },
  {
    n: '02',
    title: 'Adaptation',
    body:
      'Every tube then measures how much passed through it and changes its own thickness to match. Carried a lot, it widens. Carried nothing, it narrows. This is the only rule the organism has.',
    syms: ['dD/dt', 'f(|Q|)', 'g = 1.15'],
  },
  {
    n: '03',
    title: 'Selection',
    body:
      'Repeat with a new pair of sources. A tube survives exactly when it lies on a useful route between many pairs; one serving almost nobody starves. What is left is the network worth building.',
    syms: ['D_min', '59 / 95'],
  },
];

const REAL: Array<[string, string]> = [
  [
    'The equations',
    'Tero et al., Science 327:439 (2010), unmodified. 120 lines in src/core/solver.ts.',
  ],
  [
    'The proof',
    'Bonifaci, Mehlhorn and Varma showed in 2012 that this model provably converges on the shortest path. It is a theorem, not a heuristic.',
  ],
  [
    'The check',
    'npm test runs twenty random mazes and compares the surviving network against Dijkstra on the same graph. Twenty of twenty match to within 1e-3.',
  ],
  [
    'The computation',
    'It runs in this tab. Nothing here is a recording, a replay or a video — the linear system is being solved in your browser, sixty times a second.',
  ],
  ['The coordinates', 'Real latitudes and longitudes of thirty-six cities in the Kanto region.'],
  ['The code', 'Open in full under MIT. Clone it, run the tests, change the parameters.'],
];

const NOT_REAL: Array<[string, string]> = [
  [
    'This is not a living cell',
    'It is a mathematical model of one. No slime mold was grown, filmed or measured for this project.',
  ],
  [
    'It understands nothing',
    'The model minimises path length on a weighted graph. It has no notion of a token, a price, a market or a wallet, and no language in which to have one.',
  ],
  [
    'The experiment is not reproduced',
    'The Tokyo panel poses the same problem the paper posed, but on a different set of points and on a nearest-neighbour graph rather than a continuous substrate.',
  ],
  [
    'The 1.75 and 1.80 figures',
    "Those are the paper authors' measurements of the real organism against the real railway. They are not our numbers.",
  ],
  [
    'The pool data',
    'The pools on the Pools panel are an illustrative example with plausible figures, not live chain data.',
  ],
  [
    'The body at the top is not a scan',
    'No volumetric data of Physarum exists. Points are scattered through a ball and the solver grows tubes between them — the shape is the model\u2019s own output, not a picture of an organism.',
  ],
  ['The writing', 'Every word on this page was written by a person. The organism wrote nothing.'],
];

const PLAN: Array<[string, string, string, 'done' | 'now' | 'next']> = [
  ['01', 'Solver implemented', 'Kirchhoff relaxation plus tube adaptation, no dependencies', 'done'],
  ['02', 'Verified against Dijkstra', 'Twenty random mazes, twenty matches, in the test suite', 'done'],
  ['03', 'Network mode', 'Thirty-six cities, connected, cost 2.04 against the minimum spanning tree', 'done'],
  ['04', 'Published', 'MIT, full source, runs from a clean clone', 'done'],
  [
    '05',
    'Live pool data',
    'The Pools screen reads Uniswap V2 off Robinhood Chain in your browser — no indexer, no key',
    'done',
  ],
  ['06', 'Token', `${NAME} · ${TICKER}, deployed on Robinhood Chain`, 'done'],
  [
    '07',
    'Concentrated liquidity',
    'Every hop also quoted on Uniswap V3 through QuoterV2 — a simulated swap, not a formula',
    'done',
  ],
  ['08', 'Uniswap V4', 'The same, through the V4 quoter and its singleton pools', 'now'],
  ['09', 'Routing endpoint', 'The surviving network served as a quote for any pair', 'next'],
];

export function Site() {
  const [lab, setLab] = useState<string>('maze');
  const [copied, setCopied] = useState(false);
  const activeLab = LABS.find((l) => l.id === lab) ?? LABS[0];

  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1800);
    return () => clearTimeout(t);
  }, [copied]);

  const copy = () => {
    if (!CONTRACT) return;
    try {
      navigator.clipboard.writeText(CONTRACT).then(
        () => setCopied(true),
        () => undefined,
      );
    } catch {
      /* clipboard unavailable */
    }
  };

  return (
    <>
      <div className="specimen">
        <div className="shell specimen-in">
          <span>
            specimen <b>Physarum polycephalum</b>
          </span>
          <span>
            neurons <b>0</b>
          </span>
          <span>
            cells <b>1</b>
          </span>
          <span>
            model <b>Science 327:439</b>
          </span>
          <span className="live">
            <span className="dot-live" /> computing live
          </span>
        </div>
      </div>

      <div className="shell">
        <header className="mast">
          <div className="mast-grid">
            <div>
              <p className="binomial">Physarum polycephalum · acellular slime mold</p>
              <h1 className="title">Zero neurons.</h1>
              <p className="sub">and it still rebuilt the Tokyo rail network</p>
              <p className="thesis">
                A single cell with no brain, no nervous system and nothing to learn with. It finds
                shortest paths and designs transport networks, and it is doing it on this page
                right now.
              </p>
            </div>
            <div>
              <Body3D />
              <Legend junctions={false} />
              <p className="caption">
                Not a scan and not a sculpture — no volumetric data of this organism exists. Food
                is scattered through a ball, the same solver runs, and these are the tubes that
                survived. Turn it with the mouse.
              </p>
            </div>
          </div>
        </header>

        <section id="live">
          <p className="kicker">Where the mold is right now</p>
          <h2>Thirty-six cities, no map of Japan.</h2>
          <p>
            Food is placed on every city of the Kanto region. Two of them are picked at random,
            current is pushed from one to the other, and every tube adjusts its thickness to the
            flow it carried. Then another pair, and another. Nothing in the code knows what Tokyo is
            — there are only thirty-six pairs of coordinates.
          </p>
          <LivePanel />
          <p className="tight">
            This is not a recording. The whole organism is a hundred and twenty lines, so it fits in
            a browser tab with room to spare — the linear system above is being solved on your
            machine as you read this.
          </p>

          <div className="ca">
            <span className="tick">
              {NAME} · {TICKER}
            </span>
            <span className={CONTRACT ? 'addr' : 'addr pending'}>
              {CONTRACT ?? 'not deployed yet — no token exists at this time'}
            </span>
            {CONTRACT ? (
              <button className="ghost" type="button" onClick={copy}>
                {copied ? 'copied' : 'copy'}
              </button>
            ) : null}
          </div>
        </section>

        <section id="what">
          <p className="kicker">What it is</p>
          <h2>A real optimizer, not a metaphor.</h2>
          <p>
            Every other organism in this space brags about neuron counts. A hundred and sixty-five
            thousand. Three hundred and two. This one has none — it is a single cell, and it has no
            nervous system at all. What it has instead is two equations, written down in 2010 after
            the organism was watched solving the problem in a lab.
          </p>

          <div className="eq">
            Q<sub>ij</sub> = D<sub>ij</sub> · (p<sub>i</sub> − p<sub>j</sub>) / L<sub>ij</sub>
            <br />
            dD<sub>ij</sub>/dt = f(|Q<sub>ij</sub>|) − D<sub>ij</sub>
            &nbsp;&nbsp;&nbsp;f(Q) = Q<sup>g</sup> / (1 + Q<sup>g</sup>)
            <br />
            <span className="cmt">
              a tube that carries flow thickens · a tube that carries none dies
            </span>
          </div>

          <p>
            In 2000 the organism was put in a maze with food at both ends and withdrew from every
            dead end but the shortest path. In 2010 oat flakes were laid on a map of Japan, one per
            city around Tokyo; twenty-six hours later the network it had grown matched the Tokyo
            rail system in cost and transport efficiency. In 2012 the model was proven to converge
            on the shortest path — not approximately, not usually. A theorem.
          </p>
          <p className="tight">
            That is the part worth holding on to. This is not a simulation that looks busy on a
            screen. It is an optimizer with a proof behind it, and you can check its answer against
            Dijkstra in the panel below.
          </p>
        </section>

        <section id="how">
          <p className="kicker">How it works</p>
          <h2>Three rules, applied forever.</h2>
          <div className="steps">
            {MECHANISM.map((m) => (
              <div className="step" key={m.n}>
                <span className="num">{m.n}</span>
                <h4>{m.title}</h4>
                <p>{m.body}</p>
                <div className="sym">
                  {m.syms.map((s) => (
                    <span key={s}>{s}</span>
                  ))}
                </div>
              </div>
            ))}
          </div>
          <p className="tight">
            One implementation detail decides whether this works at all: the <em>current</em> is
            fixed at the source, never the pressure at both ends. Pin the pressures and the whole
            network quietly decays to nothing.
          </p>
        </section>

        <section id="lab">
          <p className="kicker">Run it yourself</p>
          <h2>Check the answer, don't take it.</h2>
          <p>
            Both panels run the same solver as the one at the top of this page. Nothing is
            precomputed and nothing is fetched.
          </p>
          <div className="tabs" role="tablist">
            {LABS.map((l) => (
              <button
                key={l.id}
                id={`lab-${l.id}`}
                type="button"
                role="tab"
                aria-selected={l.id === activeLab.id}
                className={l.id === activeLab.id ? 'on' : ''}
                onClick={() => setLab(l.id)}
              >
                {l.label}
              </button>
            ))}
          </div>
          {activeLab.el}
        </section>

        <section id="why">
          <p className="kicker">Why three panels</p>
          <h2>Each one answers the next objection.</h2>
          <p>
            The panels are not a gallery. They are an argument, and they only work in this order.
          </p>
          <div className="steps">
            <div className="step">
              <span className="num">The maze · Nature 2000</span>
              <h4>Does it get the right answer?</h4>
              <p>
                Anyone can build a simulation that squirms convincingly. The maze is the control:
                Dijkstra solves the same graph, and the two numbers are printed side by side. If
                they ever disagree, the project is worthless and you can see it immediately. Twenty
                random mazes are checked this way in the test suite on every run.
              </p>
            </div>
            <div className="step">
              <span className="num">Tokyo · Science 2010</span>
              <h4>Is the problem worth solving?</h4>
              <p>
                Shortest path between two points is homework. Deciding which links are worth
                building between thirty-six cities is not — it is what railway planners do, and it
                took Japan decades. Given only coordinates and the same two equations, the mold
                settles on the corridors that were actually built. Nothing in the code has ever
                heard of Tokyo.
              </p>
            </div>
            <div className="step">
              <span className="num">Pools · Robinhood Chain</span>
              <h4>Does it apply to anything?</h4>
              <p>
                Swap a token pair and you are walking a graph: nodes are tokens, edges are pools,
                and the length of an edge is what passing through it costs you in fees and
                slippage. Shortest path on that graph is the cheapest route. The mold is not being
                repurposed here — it is the same solver, handed a different set of edge lengths.
              </p>
            </div>
          </div>
          <p className="tight">
            Correct, then non-trivial, then useful. Take any one away and the other two stop
            meaning anything.
          </p>
        </section>

        <section id="honesty">
          <p className="kicker">What is real, and what is not</p>
          <h2>Said plainly, before anyone asks.</h2>
          <p>
            There will be forty of these projects within a week and most of their numbers will be
            invented. So here is the line, drawn by us, in advance.
          </p>
          <div className="split">
            <div className="col">
              <h3 className="col-head real">Real</h3>
              <dl>
                {REAL.map(([k, v]) => (
                  <div key={k}>
                    <dt>{k}</dt>
                    <dd>{v}</dd>
                  </div>
                ))}
              </dl>
            </div>
            <div className="col">
              <h3 className="col-head fake">Not real</h3>
              <dl>
                {NOT_REAL.map(([k, v]) => (
                  <div key={k}>
                    <dt>{k}</dt>
                    <dd>{v}</dd>
                  </div>
                ))}
              </dl>
            </div>
          </div>
        </section>

        <section id="plan">
          <p className="kicker">The sequence</p>
          <h2>What is done, and what is not.</h2>
          <p>Not a roadmap of promises. Everything marked done is in the repository right now.</p>
          <div className="plan">
            {PLAN.map(([n, what, detail, st]) => (
              <div className="row" key={n}>
                <span className="n">{n}</span>
                <span className="what">
                  {what}
                  <small>{detail}</small>
                </span>
                <span className={`st ${st}`}>{st === 'now' ? 'building' : st}</span>
              </div>
            ))}
          </div>
        </section>

        <section id="refs">
          <p className="kicker">Sources</p>
          <h2>Three papers, all public.</h2>
          <div className="refs">
            <div>
              Nakagaki T., Yamada H., Tóth Á. — Maze-solving by an amoeboid organism.{' '}
              <em>Nature</em> 407:470 (2000)
            </div>
            <div>
              Tero A., Takagi S., Saigusa T., Ito K., Bebber D.P., Fricker M.D., Yumiki K.,
              Kobayashi R., Nakagaki T. — Rules for Biologically Inspired Adaptive Network Design.{' '}
              <em>Science</em> 327:439 (2010). DOI 10.1126/science.1177894
            </div>
            <div>
              Bonifaci V., Mehlhorn K., Varma G. — Physarum can compute shortest paths (2012)
            </div>
          </div>
        </section>

        <footer>
          <span>Physarum polycephalum</span>
          <a href={REPO}>github ↗</a>
          <a href={HANDLE}>@brainlessmold ↗</a>
          <span style={{ marginLeft: 'auto' }}>MIT · 0 neurons</span>
        </footer>
      </div>
    </>
  );
}
