import { useEffect, useRef } from 'react';
import type { Graph } from './core/graph.ts';
import { Physarum, type SolverOptions } from './core/solver.ts';
import { render, PALETTE, type RenderOptions } from './core/render.ts';

export interface SimStats {
  steps: number;
  alive: number;
  total: number;
  length: number;
}

interface Props {
  graph: Graph;
  food: number[];
  options?: SolverOptions;
  renderOptions?: Partial<RenderOptions>;
  aspect?: number;
  /** Absolute threshold for a living tube. Needed in network mode, see Physarum.surviving. */
  aliveCut?: number;
  /** How many steps to run at once when the viewer has animations turned off. */
  staticSteps?: number;
  /** Milliseconds between steps. Larger means a slower, more watchable run. */
  stepInterval?: number;
  /** Hold the fully flooded start state for this long, so the start is visible. */
  holdMs?: number;
  onStats?: (s: SimStats) => void;
}

export function SimCanvas({
  graph,
  food,
  options,
  renderOptions,
  aspect = 0.52,
  aliveCut,
  staticSteps = 500,
  stepInterval = 28,
  holdMs = 0,
  onStats,
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const mold = new Physarum(graph, food, options);
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    let raf = 0;
    let width = 0;
    let height = 0;
    let dpr = 1;

    const resize = () => {
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      width = canvas.clientWidth || 600;
      height = Math.max(220, Math.round(width * aspect));
      canvas.style.height = `${height}px`;
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
    };

    const started = performance.now();

    const paint = () => {
      render(ctx, graph, width, height, dpr, {
        palette: PALETTE,
        food,
        aliveCut,
        time: (performance.now() - started) / 1000,
        ...renderOptions,
      });
    };

    const report = () => {
      const cut = aliveCut === undefined ? 0.25 : { absolute: aliveCut };
      onStats?.({
        steps: mold.steps,
        alive: mold.surviving(cut).length,
        total: graph.edges.length,
        length: mold.networkLength(cut),
      });
    };

    resize();
    window.addEventListener('resize', resize);

    if (reduce) {
      mold.run(staticSteps);
      paint();
      report();
    } else {
      let last = 0;
      let sinceReport = 0;
      let begun = 0;
      // One relaxation before the first frame, so the flux is real from the
      // outset and the flooded start state is not a flat picture.
      mold.step();
      paint();
      report();

      const loop = (ts: number) => {
        if (!begun) begun = ts;
        const past = ts - begun > holdMs;
        if (past && ts - last > stepInterval) {
          last = ts;
          mold.step();
          if (++sinceReport >= 4) {
            sinceReport = 0;
            report();
          }
        }
        paint();
        raf = requestAnimationFrame(loop);
      };
      raf = requestAnimationFrame(loop);
    }

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', resize);
    };
    // the graph is recreated by the caller whenever a fresh run is needed
  }, [graph, food, aspect, aliveCut, staticSteps, stepInterval, holdMs]);

  return <canvas ref={canvasRef} className="sim-canvas" />;
}
