/**
 * The Physarum polycephalum model.
 *
 * Tero A., Takagi S., Saigusa T., Ito K., Bebber D.P., Fricker M.D.,
 * Yumiki K., Kobayashi R., Nakagaki T.
 * "Rules for Biologically Inspired Adaptive Network Design"
 * Science 327, 439 (2010). DOI: 10.1126/science.1177894
 *
 * The whole organism is two equations:
 *
 *   Q_ij = D_ij * (p_i - p_j) / L_ij          flux through a tube
 *   dD_ij/dt = f(|Q_ij|) - D_ij               tube adaptation
 *   f(Q) = Q^g / (1 + Q^g)
 *
 * A tube that carries flow thickens. A tube that doesn't, dies.
 * There is nothing else to it.
 *
 * IMPORTANT. The CURRENT I0 is fixed at the source, not the pressure at both
 * ends. With fixed pressures the total flux decays together with the
 * conductivities and the whole network fades to zero. With fixed current the
 * flux along the surviving path stays near I0 and the system reaches
 * equilibrium.
 */

import type { Graph } from './graph.ts';

export interface SolverOptions {
  /** Current injected into the source. The paper uses I0 = 2. */
  I0?: number;
  /** Exponent in f(Q). g > 1 collapses the network to a single path, g < 1 keeps it branched. */
  g?: number;
  /** Integration step. */
  dt?: number;
  /** Gauss-Seidel iterations per step. */
  relaxIters?: number;
  /**
   * How many source-sink pairs to average over in a single step.
   *
   * Only meaningful with more than two food nodes. With one pair per step the
   * peripheral tubes decay between visits and the network stops covering the
   * outer nodes. Averaging over several pairs makes adaptation slower than the
   * pair sampling, and the network stays connected.
   */
  pairsPerStep?: number;
  /** Lower clamp on conductivity, to avoid division by zero. */
  dMin?: number;
  rng?: () => number;
}

const DEFAULTS: Required<Omit<SolverOptions, 'rng'>> = {
  I0: 1,
  g: 1.8,
  dt: 0.15,
  relaxIters: 60,
  dMin: 1e-4,
  pairsPerStep: 1,
};

export class Physarum {
  readonly graph: Graph;
  /** Food nodes. Exactly two means a fixed source and sink. More means a random pair each step. */
  readonly food: number[];
  readonly opts: Required<Omit<SolverOptions, 'rng'>>;

  pressures: Float64Array;
  steps = 0;

  private rng: () => number;
  private acc: Float64Array | null = null;
  private source: number;
  private sink: number;

  constructor(graph: Graph, food: number[], options: SolverOptions = {}) {
    if (food.length < 2) throw new Error('At least two food nodes are required');
    this.graph = graph;
    this.food = food.slice();
    this.opts = { ...DEFAULTS, ...stripRng(options) };
    this.rng = options.rng ?? Math.random;
    this.pressures = new Float64Array(graph.nodes.length);
    this.source = food[0];
    this.sink = food[1];
  }

  private pickPair(): void {
    if (this.food.length === 2) {
      this.source = this.food[0];
      this.sink = this.food[1];
      return;
    }
    const n = this.food.length;
    const i = Math.floor(this.rng() * n);
    let j = Math.floor(this.rng() * (n - 1));
    if (j >= i) j++;
    this.source = this.food[i];
    this.sink = this.food[j];
  }

  /**
   * Solves Kirchhoff's system with Gauss-Seidel relaxation.
   *
   * Interior node:  p_i = ( SUM c_ij * p_j ) / SUM c_ij
   * Source node:    p_i = ( SUM c_ij * p_j + I0 ) / SUM c_ij
   * Sink is pinned: p_sink = 0
   *
   * where c_ij = D_ij / L_ij is the edge conductance.
   */
  private relax(): void {
    const { nodes, edges, adj } = this.graph;
    const p = this.pressures;
    const { I0, relaxIters } = this.opts;

    for (let iter = 0; iter < relaxIters; iter++) {
      for (let i = 0; i < nodes.length; i++) {
        if (i === this.sink) {
          p[i] = 0;
          continue;
        }
        const inc = adj[i];
        let num = 0;
        let den = 0;
        for (let k = 0; k < inc.length; k++) {
          const e = edges[inc[k]];
          const other = e.a === i ? e.b : e.a;
          const c = e.D / e.L;
          num += c * p[other];
          den += c;
        }
        if (den <= 0) {
          p[i] = 0;
          continue;
        }
        if (i === this.source) num += I0;
        p[i] = num / den;
      }
    }
  }

  /** One step: solve pressures, compute fluxes, update conductivities. */
  step(): void {
    const { edges } = this.graph;
    const p = this.pressures;
    const { g, dt, dMin, pairsPerStep } = this.opts;

    const k = this.food.length > 2 ? Math.max(1, pairsPerStep) : 1;
    if (!this.acc || this.acc.length !== edges.length) {
      this.acc = new Float64Array(edges.length);
    }
    const acc = this.acc;
    acc.fill(0);

    for (let round = 0; round < k; round++) {
      this.pickPair();
      this.relax();

      for (let i = 0; i < edges.length; i++) {
        const e = edges[i];
        const q = (e.D / e.L) * (p[e.a] - p[e.b]);
        e.Q = q;

        const pow = Math.pow(Math.abs(q), g);
        acc[i] += pow / (1 + pow);
      }
    }

    for (let i = 0; i < edges.length; i++) {
      const e = edges[i];
      e.D += dt * (acc[i] / k - e.D);
      if (e.D < dMin) e.D = dMin;
    }
    this.steps++;
  }

  run(n: number): void {
    for (let i = 0; i < n; i++) this.step();
  }

  maxD(): number {
    let m = 0;
    for (const e of this.graph.edges) if (e.D > m) m = e.D;
    return m || 1;
  }

  /**
   * Indices of the surviving tubes.
   *
   * The threshold is relative by default: a fraction of the thickest tube.
   * That is correct in single source-sink mode, where the network collapses
   * onto one path.
   *
   * In network mode (food in many nodes) a relative threshold lies: a tube to
   * a far node only carries flow in a small fraction of the sampled pairs, so
   * its equilibrium thickness is inherently small and it gets cut along with
   * the dead ones. Pass an absolute threshold there — dead tubes decay to dMin
   * and separate from the living ones by an order of magnitude.
   */
  surviving(threshold: number | { absolute: number } = 0.25): number[] {
    const cut =
      typeof threshold === 'number' ? this.maxD() * threshold : threshold.absolute;
    const out: number[] = [];
    for (let i = 0; i < this.graph.edges.length; i++) {
      if (this.graph.edges[i].D > cut) out.push(i);
    }
    return out;
  }

  /** Total length of the surviving tubes. This is the network cost. */
  networkLength(threshold: number | { absolute: number } = 0.25): number {
    let total = 0;
    for (const i of this.surviving(threshold)) total += this.graph.edges[i].L;
    return total;
  }
}

function stripRng(o: SolverOptions) {
  const { rng: _rng, ...rest } = o;
  return rest;
}
