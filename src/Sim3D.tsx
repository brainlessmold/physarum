import { useEffect, useRef, useState } from 'react';
import { buildBlob } from './core/blob.ts';
import { Physarum } from './core/solver.ts';
import { render3d } from './core/render3d.ts';

export interface Sim3DStats {
  steps: number;
  alive: number;
  total: number;
  nodes: number;
}

interface Props {
  aspect?: number;
  onStats?: (s: Sim3DStats) => void;
  /** Bump to grow a fresh body. */
  seed?: number;
}

const ALIVE_CUT = 0.012;

export function Sim3D({ aspect = 0.82, onStats, seed = 0 }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [dragging, setDragging] = useState(false);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const { graph, food } = buildBlob({ count: 96, neighbours: 5, foodCount: 14 });
    const mold = new Physarum(graph, food, {
      I0: 1,
      g: 1.12,
      dt: 0.1,
      pairsPerStep: 6,
      relaxIters: 18,
    });

    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const camera = { yaw: 0.6, pitch: -0.32, distance: 2.4 };

    let raf = 0;
    let width = 0;
    let height = 0;
    let dpr = 1;
    let last = 0;
    let sinceReport = 0;
    let held = false;
    let px = 0;
    let py = 0;

    const resize = () => {
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      width = canvas.clientWidth || 600;
      height = Math.max(260, Math.round(width * aspect));
      canvas.style.height = `${height}px`;
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
    };

    const paint = () => {
      render3d(ctx, graph, width, height, dpr, {
        camera,
        food,
        aliveCut: ALIVE_CUT,
        showLattice: true,
        maxWidth: 9,
      });
    };

    const report = () => {
      onStats?.({
        steps: mold.steps,
        alive: mold.surviving({ absolute: ALIVE_CUT }).length,
        total: graph.edges.length,
        nodes: graph.nodes.length,
      });
    };

    /* ---------------- pointer: drag to turn it ---------------- */

    const down = (ev: PointerEvent) => {
      held = true;
      setDragging(true);
      px = ev.clientX;
      py = ev.clientY;
      canvas.setPointerCapture(ev.pointerId);
    };
    const move = (ev: PointerEvent) => {
      if (!held) return;
      camera.yaw += (ev.clientX - px) * 0.008;
      camera.pitch += (ev.clientY - py) * 0.006;
      camera.pitch = Math.max(-1.3, Math.min(1.3, camera.pitch));
      px = ev.clientX;
      py = ev.clientY;
      if (reduce) paint();
    };
    const up = (ev: PointerEvent) => {
      held = false;
      setDragging(false);
      try {
        canvas.releasePointerCapture(ev.pointerId);
      } catch {
        /* pointer already released */
      }
    };

    canvas.addEventListener('pointerdown', down);
    canvas.addEventListener('pointermove', move);
    canvas.addEventListener('pointerup', up);
    canvas.addEventListener('pointercancel', up);
    window.addEventListener('resize', resize);

    resize();

    if (reduce) {
      mold.run(420);
      paint();
      report();
    } else {
      const loop = (ts: number) => {
        if (ts - last > 26) {
          last = ts;
          mold.step();
          // Idle spin, so it reads as an object rather than a picture.
          if (!held) camera.yaw += 0.0028;
          paint();
          if (++sinceReport >= 5) {
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
      canvas.removeEventListener('pointerdown', down);
      canvas.removeEventListener('pointermove', move);
      canvas.removeEventListener('pointerup', up);
      canvas.removeEventListener('pointercancel', up);
      window.removeEventListener('resize', resize);
    };
  }, [aspect, seed]);

  return (
    <canvas
      ref={canvasRef}
      className="sim-canvas sim-3d"
      style={{ cursor: dragging ? 'grabbing' : 'grab', touchAction: 'none' }}
      aria-label="A three-dimensional network grown by the Physarum model. Drag to turn it."
    />
  );
}
