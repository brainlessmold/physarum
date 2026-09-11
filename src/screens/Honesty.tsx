const REAL: Array<[string, string]> = [
  ['The equations', 'Tero et al., Science 327:439 (2010), unmodified. Implemented in src/core/solver.ts, 120 lines'],
  ['Convergence', 'Bonifaci, Mehlhorn, Varma (2012): the model provably converges on the shortest path'],
  ['The check', 'npm test runs twenty mazes and compares the result against Dijkstra on the same graph'],
  ['City coordinates', 'Real latitudes and longitudes of cities in the Kanto region'],
  ['The code', 'Fully open, MIT. Forks and runs with one command'],
];

const NOT_REAL: Array<[string, string]> = [
  ['This is not a living cell', 'It is a mathematical model of the organism. There is no live slime mold anywhere in this project'],
  ['It understands nothing', 'The model minimises path length on a graph. It has no notion of a token, a price or a wallet'],
  ['The experiment is not reproduced', 'The Tokyo screen poses the same problem, but on a different point set and on a graph rather than a continuous substrate'],
  ['The 1.75 against 1.80 figures', "That is the authors' result, not our measurement"],
  ['The writing', 'All copy was written by a human. The organism wrote nothing and cannot'],
];

export function Honesty() {
  return (
    <div className="screen">
      <p className="lede">
        Forty projects will appear in this space within a week, and most of their numbers will be
        made up. So here is a plain statement of what can be verified and what cannot.
      </p>

      <div className="split">
        <section>
          <h3 className="col-head real">Real</h3>
          <dl>
            {REAL.map(([k, v]) => (
              <div key={k}>
                <dt>{k}</dt>
                <dd>{v}</dd>
              </div>
            ))}
          </dl>
        </section>

        <section>
          <h3 className="col-head fake">Not real</h3>
          <dl>
            {NOT_REAL.map(([k, v]) => (
              <div key={k}>
                <dt>{k}</dt>
                <dd>{v}</dd>
              </div>
            ))}
          </dl>
        </section>
      </div>

      <div className="honesty-inline">
        <b>Sources.</b> Nakagaki, Yamada, Tóth — Nature 407:470 (2000). Tero et al. — Science
        327:439 (2010), DOI 10.1126/science.1177894. Bonifaci, Mehlhorn, Varma — "Physarum can
        compute shortest paths" (2012).
      </div>
    </div>
  );
}
