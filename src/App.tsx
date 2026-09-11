import { useState } from 'react';
import { Maze } from './screens/Maze.tsx';
import { Tokyo } from './screens/Tokyo.tsx';
import { Pools } from './screens/Pools.tsx';
import { Honesty } from './screens/Honesty.tsx';

const TABS = [
  { id: 'maze', label: 'Maze', el: <Maze /> },
  { id: 'tokyo', label: 'Tokyo', el: <Tokyo /> },
  { id: 'pools', label: 'Pools', el: <Pools /> },
  { id: 'honesty', label: "What's real", el: <Honesty /> },
] as const;

export function App() {
  const [tab, setTab] = useState<string>('maze');
  const active = TABS.find((t) => t.id === tab) ?? TABS[0];

  return (
    <div className="wrap">
      <header className="mast">
        <p className="eyebrow">Physarum polycephalum · Robinhood Chain</p>
        <h1>
          Zero neurons<span className="dot">.</span>
        </h1>
        <p className="thesis">
          One cell with no nervous system. It finds shortest paths and designs transport
          networks — and it does it on this page, right now, not in a recorded video.
        </p>
      </header>

      <nav className="tabs" role="tablist">
        {TABS.map((t) => (
          <button
            key={t.id}
            id={`tab-${t.id}`}
            type="button"
            role="tab"
            aria-selected={t.id === active.id}
            className={t.id === active.id ? 'on' : ''}
            onClick={() => setTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </nav>

      <main>{active.el}</main>

      <footer className="foot">
        <span>
          Model: Tero et al., <i>Science</i> 327:439 (2010)
        </span>
        <span>MIT · source fully open</span>
      </footer>
    </div>
  );
}
