/**
 * Cities of the Kanto region around Tokyo.
 *
 * The coordinates are real (latitude/longitude of actual cities).
 * TO BE CLEAR: this is NOT the point set from Tero et al. 2010 — that used 36
 * stations of the suburban rail network, marked with oat flakes on a damp
 * substrate. These are major cities of the same region, reproducing the setup
 * of the problem rather than the experiment itself.
 */

export interface City {
  name: string;
  lat: number;
  lon: number;
  /** In the paper Tokyo was modelled as a cluster of food sources, being larger than the rest. */
  hub?: boolean;
}

export const KANTO: City[] = [
  { name: 'Tokyo', lat: 35.68, lon: 139.76, hub: true },
  { name: 'Yokohama', lat: 35.44, lon: 139.64 },
  { name: 'Kawasaki', lat: 35.53, lon: 139.7 },
  { name: 'Chiba', lat: 35.61, lon: 140.12 },
  { name: 'Saitama', lat: 35.86, lon: 139.65 },
  { name: 'Hachioji', lat: 35.67, lon: 139.32 },
  { name: 'Odawara', lat: 35.26, lon: 139.15 },
  { name: 'Yokosuka', lat: 35.28, lon: 139.67 },
  { name: 'Kisarazu', lat: 35.38, lon: 139.93 },
  { name: 'Narita', lat: 35.78, lon: 140.32 },
  { name: 'Choshi', lat: 35.73, lon: 140.83 },
  { name: 'Tsuchiura', lat: 36.08, lon: 140.2 },
  { name: 'Mito', lat: 36.37, lon: 140.47 },
  { name: 'Hitachi', lat: 36.6, lon: 140.65 },
  { name: 'Utsunomiya', lat: 36.56, lon: 139.88 },
  { name: 'Oyama', lat: 36.31, lon: 139.8 },
  { name: 'Maebashi', lat: 36.39, lon: 139.06 },
  { name: 'Takasaki', lat: 36.32, lon: 139.0 },
  { name: 'Kumagaya', lat: 36.15, lon: 139.39 },
  { name: 'Kofu', lat: 35.66, lon: 138.57 },
  { name: 'Otsuki', lat: 35.61, lon: 138.94 },
  { name: 'Numazu', lat: 35.1, lon: 138.86 },
  { name: 'Atami', lat: 35.1, lon: 139.07 },
  { name: 'Hiratsuka', lat: 35.33, lon: 139.35 },
  { name: 'Fujisawa', lat: 35.34, lon: 139.49 },
  { name: 'Machida', lat: 35.55, lon: 139.45 },
  { name: 'Tachikawa', lat: 35.7, lon: 139.41 },
  { name: 'Kawagoe', lat: 35.93, lon: 139.49 },
  { name: 'Koshigaya', lat: 35.89, lon: 139.79 },
  { name: 'Kashiwa', lat: 35.87, lon: 139.98 },
  { name: 'Funabashi', lat: 35.69, lon: 139.98 },
  { name: 'Tateyama', lat: 34.98, lon: 139.87 },
  { name: 'Mobara', lat: 35.43, lon: 140.29 },
  { name: 'Katsuura', lat: 35.15, lon: 140.32 },
  { name: 'Ashikaga', lat: 36.34, lon: 139.45 },
  { name: 'Nikko', lat: 36.75, lon: 139.61 },
];

/** Projects latitude/longitude into [0..1] coordinates, preserving proportions. */
export function project(cities: City[]): Array<{ x: number; y: number; label: string }> {
  const lons = cities.map((c) => c.lon);
  const lats = cities.map((c) => c.lat);
  const minLon = Math.min(...lons);
  const maxLon = Math.max(...lons);
  const minLat = Math.min(...lats);
  const maxLat = Math.max(...lats);

  // At Tokyo's latitude a degree of longitude is about cos(35.7deg) shorter than a degree of latitude.
  const kx = Math.cos((35.7 * Math.PI) / 180);
  const spanX = (maxLon - minLon) * kx;
  const spanY = maxLat - minLat;
  const span = Math.max(spanX, spanY);

  const offX = (span - spanX) / 2;
  const offY = (span - spanY) / 2;

  return cities.map((c) => ({
    x: ((c.lon - minLon) * kx + offX) / span,
    // Latitude grows northwards, the screen coordinate grows downwards.
    y: 1 - ((c.lat - minLat) + offY) / span,
    label: c.name,
  }));
}

/**
 * Candidate graph: every city is joined to its k nearest neighbours.
 * The mold then selects a subnetwork out of those edges, the way it selected
 * routes on the continuous substrate in the paper.
 */
export function nearestNeighbourEdges(
  points: Array<{ x: number; y: number }>,
  k = 4,
): Array<[number, number]> {
  const seen = new Set<string>();
  const out: Array<[number, number]> = [];

  for (let i = 0; i < points.length; i++) {
    const order = points
      .map((p, j) => ({ j, d: Math.hypot(p.x - points[i].x, p.y - points[i].y) }))
      .filter((o) => o.j !== i)
      .sort((a, b) => a.d - b.d)
      .slice(0, k);

    for (const o of order) {
      const key = i < o.j ? `${i}-${o.j}` : `${o.j}-${i}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(i < o.j ? [i, o.j] : [o.j, i]);
    }
  }
  return out;
}
