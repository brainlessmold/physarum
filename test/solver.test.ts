/**
 * Check: the mold must converge on the same path as Dijkstra.
 *
 * Run with:  npm test
 */

import { generateMaze, mazeEndpoints } from '../src/core/graph.ts';
import { Physarum } from '../src/core/solver.ts';
import { shortestPath } from '../src/core/dijkstra.ts';

/** Deterministic generator, so the test does not flake. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const COLS = 11;
const ROWS = 7;
const STEPS = 600;
const TRIALS = 20;
const TOL = 1e-3;

let passed = 0;
const failures: string[] = [];

for (let trial = 0; trial < TRIALS; trial++) {
  const rng = mulberry32(1000 + trial);
  const graph = generateMaze(COLS, ROWS, { rng });
  const [source, sink] = mazeEndpoints(COLS, ROWS);

  const reference = shortestPath(graph, source, sink);
  if (!isFinite(reference.distance)) {
    failures.push(`run ${trial}: the graph came out disconnected, that is a generator bug`);
    continue;
  }

  const mold = new Physarum(graph, [source, sink], { rng });
  mold.run(STEPS);

  const survivingLength = mold.networkLength(0.25);
  const delta = Math.abs(survivingLength - reference.distance);

  if (delta < TOL) {
    passed++;
  } else {
    failures.push(
      `run ${trial}: mold ${survivingLength.toFixed(5)}, ` +
        `Dijkstra ${reference.distance.toFixed(5)}, difference ${delta.toFixed(5)}`,
    );
  }
}

console.log(`\nMaze ${COLS}x${ROWS}, ${STEPS} steps, ${TRIALS} runs`);
console.log(`Matched Dijkstra: ${passed} / ${TRIALS}`);

if (failures.length) {
  console.log('\nMismatches:');
  for (const f of failures) console.log('  ' + f);
}

if (passed < TRIALS) {
  console.error('\nFAILED: the solver did not converge on the shortest path.');
  process.exit(1);
}

console.log('\nOK: in every run the surviving network matched the shortest path.\n');
