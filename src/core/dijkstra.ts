/**
 * Plain Dijkstra. Used only as a control: the mold must arrive at exactly the
 * same path.
 */

import type { Graph } from './graph.ts';

export interface ShortestPath {
  distance: number;
  /** Node indices from source to sink. Empty when there is no path. */
  nodes: number[];
  /** Edge indices along the path. */
  edges: number[];
}

export function shortestPath(graph: Graph, source: number, sink: number): ShortestPath {
  const n = graph.nodes.length;
  const dist = new Float64Array(n).fill(Infinity);
  const prevNode = new Int32Array(n).fill(-1);
  const prevEdge = new Int32Array(n).fill(-1);
  const visited = new Uint8Array(n);

  dist[source] = 0;

  for (;;) {
    let u = -1;
    let best = Infinity;
    for (let i = 0; i < n; i++) {
      if (!visited[i] && dist[i] < best) {
        best = dist[i];
        u = i;
      }
    }
    if (u === -1) break;
    visited[u] = 1;
    if (u === sink) break;

    for (const ei of graph.adj[u]) {
      const e = graph.edges[ei];
      const v = e.a === u ? e.b : e.a;
      const nd = dist[u] + e.L;
      if (nd < dist[v] - 1e-12) {
        dist[v] = nd;
        prevNode[v] = u;
        prevEdge[v] = ei;
      }
    }
  }

  if (!isFinite(dist[sink])) return { distance: Infinity, nodes: [], edges: [] };

  const nodes: number[] = [];
  const edges: number[] = [];
  let cur = sink;
  while (cur !== -1) {
    nodes.push(cur);
    if (prevEdge[cur] !== -1) edges.push(prevEdge[cur]);
    cur = prevNode[cur];
  }
  nodes.reverse();
  edges.reverse();

  return { distance: dist[sink], nodes, edges };
}
