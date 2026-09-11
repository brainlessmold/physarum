import { useEffect, useRef, useState } from 'react';
import type { Graph } from './core/graph.ts';
import { Physarum, type SolverOptions } from './core/solver.ts';
import { render, isDark, LIGHT, DARK, type RenderOptions } from './core/render.ts';

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
  onStats,
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [dark, setDark] = useState(() => (typeof window === 'undefined' ? false : isDark()));

  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const sync = () => setDark(isDark());
    mq.addEventListener('change', sync);
    const obs = new MutationObserver(sync);
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    return () => {
      mq.removeEventListener('change', sync);
      obs.disconnect();
    };
  }, []);

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

    const palette = dark ? DARK : LIGHT;

    const resize = () => {
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      width = canvas.clientWidth || 600;
      height = Math.max(220, Math.round(width * aspect));
      canvas.style.height = `${height}px`;
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
    };

    const paint = () => {
      render(ctx, graph, width, height, dpr, {
        palette,
        food,
        aliveCut,
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
      const loop = (ts: number) => {
        if (ts - last > 28) {
          last = ts;
          mold.step();
          paint();
          if (++sinceReport >= 6) {
            sinceReport = 0;
            report();
          }
        }
        raf = requestAnimationFrame(loop);
      };
      raf = requestAnimationFrame(loop);
    }

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', resize);
    };
    // the graph is recreated by the caller whenever a fresh run is needed
  }, [graph, food, dark, aspect, aliveCut, staticSteps]);

  return <canvas ref={canvasRef} className="sim-canvas" />;
}
