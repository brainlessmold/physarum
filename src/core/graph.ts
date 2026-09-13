/**
 * Graph structures for the Physarum model.
 *
 * Nodes are points on the plane in normalised [0..1] coordinates.
 * Edges are tubes: L is length (cost of passage), D is conductivity (thickness).
 */

export interface GraphNode {
  x: number;
  y: number;
  /** Depth, for the three-dimensional panel. Absent means flat. */
  z?: number;
  label?: string;
  /**
   * Which side of the node its label sits on. A layout that knows where a node
   * sits relative to its neighbours knows where the label will not collide;
   * without this every label goes above, and on a graph with a horizontal spine
   * they pile onto each other.
   */
  anchor?: 'n' | 's' | 'e' | 'w';
}

export interface GraphEdge {
  a: number;
  b: number;
  /** Tube length. In live mode this holds the cost of a swap. */
  L: number;
  /** Conductivity. This is the tube's thickness. */
  D: number;
  /** Flux on the last step. Filled in by the solver. */
  Q: number;
}

export interface Graph {
  nodes: GraphNode[];
  edges: GraphEdge[];
  /** adj[i] — indices of the edges incident to node i. */
  adj: number[][];
}

export interface BuildOptions {
  /** Initial conductivity of every tube. */
  d0?: number;
  /** Spread of the initial conductivity. */
  jitter?: number;
  rng?: () => number;
}

function dist(a: GraphNode, b: GraphNode): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  const dz = (a.z ?? 0) - (b.z ?? 0);
  return Math.hypot(dx, dy, dz);
}

/** Builds a graph from nodes and a list of pairs. Lengths are euclidean. */
export function buildGraph(
  nodes: GraphNode[],
  pairs: Array<[number, number]>,
  opts: BuildOptions = {},
): Graph {
  const rng = opts.rng ?? Math.random;
  const d0 = opts.d0 ?? 0.55;
  const jitter = opts.jitter ?? 0.25;

  const edges: GraphEdge[] = pairs.map(([a, b]) => ({
    a,
    b,
    L: Math.max(dist(nodes[a], nodes[b]), 1e-6),
    D: d0 + rng() * jitter,
    Q: 0,
  }));

  return { nodes, edges, adj: buildAdjacency(nodes.length, edges) };
}

/**
 * Builds a graph from nodes and explicit edge lengths.
 *
 * Needed for live mode: there an edge length is not a distance on screen but
 * what it actually costs to swap through that pool.
 */
export function buildWeightedGraph(
  nodes: GraphNode[],
  weighted: Array<{ a: number; b: number; L: number }>,
  opts: BuildOptions = {},
): Graph {
  const rng = opts.rng ?? Math.random;
  const d0 = opts.d0 ?? 0.55;
  const jitter = opts.jitter ?? 0.25;

  const edges: GraphEdge[] = weighted.map((e) => ({
    a: e.a,
    b: e.b,
    L: Math.max(e.L, 1e-6),
    D: d0 + rng() * jitter,
    Q: 0,
  }));

  return { nodes, edges, adj: buildAdjacency(nodes.length, edges) };
}

function buildAdjacency(nodeCount: number, edges: GraphEdge[]): number[][] {
  const adj: number[][] = Array.from({ length: nodeCount }, () => []);
  for (let i = 0; i < edges.length; i++) {
    adj[edges[i].a].push(i);
    adj[edges[i].b].push(i);
  }
  return adj;
}

/* ------------------------------------------------------------------ */
/* Maze                                                                */
/* ------------------------------------------------------------------ */

function find(parent: number[], i: number): number {
  while (parent[i] !== i) {
    parent[i] = parent[parent[i]];
    i = parent[i];
  }
  return i;
}

export interface MazeOptions extends BuildOptions {
  /** Share of extra edges added on top of the spanning tree. Creates loops and forks. */
  extraEdgeRatio?: number;
}

/**
 * A cols x rows lattice with edges removed at random.
 *
 * A spanning tree is built first via union-find, which guarantees the graph is
 * connected and a source-to-sink path always exists. Then part of the removed
 * edges is added back so that alternative routes appear: without them the mold
 * has nothing to choose between.
 */
export function generateMaze(cols: number, rows: number, opts: MazeOptions = {}): Graph {
  const rng = opts.rng ?? Math.random;
  const extra = opts.extraEdgeRatio ?? 0.35;

  const nodes: GraphNode[] = [];
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      nodes.push({ x: cols > 1 ? i / (cols - 1) : 0.5, y: rows > 1 ? j / (rows - 1) : 0.5 });
    }
  }

  const candidates: Array<[number, number]> = [];
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      const id = j * cols + i;
      if (i < cols - 1) candidates.push([id, id + 1]);
      if (j < rows - 1) candidates.push([id, id + cols]);
    }
  }

  for (let i = candidates.length - 1; i > 0; i--) {
    const k = Math.floor(rng() * (i + 1));
    const tmp = candidates[i];
    candidates[i] = candidates[k];
    candidates[k] = tmp;
  }

  const parent = nodes.map((_, i) => i);
  const chosen: Array<[number, number]> = [];
  const rest: Array<[number, number]> = [];

  for (const pair of candidates) {
    const ra = find(parent, pair[0]);
    const rb = find(parent, pair[1]);
    if (ra !== rb) {
      parent[ra] = rb;
      chosen.push(pair);
    } else {
      rest.push(pair);
    }
  }
  for (const pair of rest) {
    if (rng() < extra) chosen.push(pair);
  }

  return buildGraph(nodes, chosen, opts);
}

/** Lattice edge nodes: entry on the middle left, exit on the middle right. */
export function mazeEndpoints(cols: number, rows: number): [number, number] {
  const mid = Math.floor(rows / 2);
  return [mid * cols, mid * cols + (cols - 1)];
}
