import * as fs from 'node:fs';
import * as path from 'node:path';

type ChartRow = { rank: number; universe_id: number };
type Snapshot = {
  at: number;
  rows: ChartRow[];
  details: unknown;
};
type DistributionRow = { universe_id: number; p: number };

const HOURS = 60 * 60 * 1000;
const DECAY_TIME = 40 * HOURS;
const AGE_LIMIT = 28 * 24 * HOURS;
const NEIGHBOR_WEIGHTS = [0.18, 0.64, 0.18] as const;
const NEWEST_CHART_WEIGHTS = [0.08, 0.24, 0.36, 0.24, 0.08] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function timestamp(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function snapshotFrom(value: unknown): Snapshot | null {
  if (!isRecord(value)) return null;
  const at = timestamp(value.at);
  if (at === null || !Array.isArray(value.up_and_coming)) return null;

  const rows: ChartRow[] = [];
  for (const candidate of value.up_and_coming) {
    if (!isRecord(candidate)) continue;
    const { rank, universe_id: universeId } = candidate;
    if (!Number.isInteger(rank) || (rank as number) < 1) continue;
    if (!Number.isInteger(universeId) || (universeId as number) <= 0) continue;
    rows.push({ rank: rank as number, universe_id: universeId as number });
  }
  if (rows.length === 0) return null;
  return { at, rows, details: value.details };
}

function snapshotsFromFile(filePath: string): Snapshot[] {
  const contents = fs.readFileSync(filePath, 'utf8');
  const snapshots: Snapshot[] = [];
  for (const line of contents.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const snapshot = snapshotFrom(JSON.parse(line) as unknown);
      if (snapshot) snapshots.push(snapshot);
    } catch {
      // Skip malformed lines while retaining the rest of the history.
    }
  }
  snapshots.sort((a, b) => a.at - b.at);
  return snapshots;
}

function creationTimes(snapshots: Snapshot[]): Map<number, number> {
  const created = new Map<number, number>();
  // Ascending snapshots make the newest usable creation detail win.
  for (const snapshot of snapshots) {
    const details = snapshot.details;
    if (Array.isArray(details)) {
      for (const entry of details) {
        if (!isRecord(entry)) continue;
        const id = entry.id ?? entry.universe_id;
        const parsedId = typeof id === 'string' && /^\d+$/.test(id) ? Number(id) : id;
        if (!Number.isInteger(parsedId) || (parsedId as number) <= 0) continue;
        const time = timestamp(entry.created);
        if (time !== null) created.set(parsedId as number, time);
      }
    } else if (isRecord(details)) {
      for (const [key, entry] of Object.entries(details)) {
        if (!/^\d+$/.test(key) || !isRecord(entry)) continue;
        const time = timestamp(entry.created);
        if (time !== null) created.set(Number(key), time);
      }
    }
  }
  return created;
}

function activeWindowShare(createdAt: number | undefined, from: number, until: number): number {
  if (createdAt === undefined) return 1;
  const birthday = createdAt + AGE_LIMIT;
  if (birthday <= from) return 0;
  if (birthday >= until) return 1;
  return (birthday - from) / (until - from);
}

function orderedRows(rows: ChartRow[]): ChartRow[] {
  return rows.slice().sort((a, b) => a.rank - b.rank || a.universe_id - b.universe_id);
}

function buildRankProbabilities(snapshots: Snapshot[], places: number): Map<number, number>[] {
  const byPlace = Array.from({ length: places }, () => new Map<number, number>());
  const rankWeights = new Map<number, Map<number, number>>();
  let totalWeight = 0;
  const newest = snapshots[snapshots.length - 1];

  if (newest) {
    for (const snapshot of snapshots) {
      const weight = Math.exp(-(newest.at - snapshot.at) / DECAY_TIME);
      totalWeight += weight;
      for (const row of snapshot.rows) {
        if (row.rank > 14) continue;
        let counts = rankWeights.get(row.universe_id);
        if (!counts) {
          counts = new Map<number, number>();
          rankWeights.set(row.universe_id, counts);
        }
        counts.set(row.rank, (counts.get(row.rank) ?? 0) + weight);
      }
    }

    if (totalWeight > 0) {
      for (const [universeId, counts] of rankWeights) {
        for (let place = 1; place <= places; place++) {
          const raw = (
            NEIGHBOR_WEIGHTS[0] * (counts.get(place - 1) ?? 0) +
            NEIGHBOR_WEIGHTS[1] * (counts.get(place) ?? 0) +
            NEIGHBOR_WEIGHTS[2] * (counts.get(place + 1) ?? 0)
          ) / totalWeight;
          if (raw > 0) byPlace[place - 1].set(universeId, raw * 0.8);
        }
      }

      // Add the small newest-chart blend, preserving its rank-based neighbor weights.
      const newestRows = orderedRows(newest.rows);
      const idAtRank = new Map(newestRows.map((row) => [row.rank, row.universe_id]));
      for (let place = 1; place <= places; place++) {
        const distribution = byPlace[place - 1];
        for (let offset = -2; offset <= 2; offset++) {
          const gameId = idAtRank.get(place + offset);
          if (gameId === undefined) continue;
          distribution.set(gameId, (distribution.get(gameId) ?? 0) + 0.2 * NEWEST_CHART_WEIGHTS[offset + 2]);
        }
      }
    }
  }
  return byPlace;
}

function applyAgeOut(
  byPlace: Map<number, number>[],
  snapshots: Snapshot[],
  windowFrom: number,
  windowUntil: number,
): void {
  const created = creationTimes(snapshots);
  // Expired games are removed; games aging out within the window retain their active share.
  for (const distribution of byPlace) {
    for (const [gameId, value] of distribution) {
      const share = activeWindowShare(created.get(gameId), windowFrom, windowUntil);
      if (share <= 0) distribution.delete(gameId);
      else distribution.set(gameId, value * share);
    }
  }
}

function capNamedMass(byPlace: Map<number, number>[], places: number, snapshotCount: number): void {
  const confidence = Math.min(1, snapshotCount / 40);
  for (let place = 1; place <= places; place++) {
    const ramp = places === 1 ? 0.45 : 0.45 + (0.70 - 0.45) * ((place - 1) / (places - 1));
    const unnamed = ramp + (0.70 - ramp) * (1 - confidence);
    const cap = 1 - unnamed;
    const distribution = byPlace[place - 1];
    let sum = 0;
    for (const value of distribution.values()) sum += value;
    if (sum > cap && sum > 0) {
      const scale = cap / sum;
      for (const [gameId, value] of distribution) distribution.set(gameId, value * scale);
    }
  }
}

function outputRows(byPlace: Map<number, number>[], places: number): DistributionRow[] {
  const probabilities: Array<{ universe_id: number; place: number; p: number }> = [];
  for (let place = 1; place <= places; place++) {
    const ranked = Array.from(byPlace[place - 1], ([universe_id, p]) => ({ universe_id, p }))
      .filter((row) => row.p >= 0.002)
      .sort((a, b) => b.p - a.p || a.universe_id - b.universe_id)
      .slice(0, 100);
    const rounded = ranked.map((row) => ({ universe_id: row.universe_id, p: Number(row.p.toFixed(6)) }));
    let roundedSum = rounded.reduce((sum, row) => sum + row.p, 0);
    // Rounding can add a few ulps beyond the probability simplex.
    while (rounded.length > 0 && roundedSum > 1) {
      const removed = rounded.pop()!;
      roundedSum -= removed.p;
    }
    for (const row of rounded) {
      probabilities.push({ universe_id: row.universe_id, place, p: row.p });
    }
  }
  return probabilities;
}

function topGames(byPlace: Map<number, number>[], snapshots: Snapshot[], places: number): number[] {
  const allGames = new Set<number>();
  const totalMass = new Map<number, number>();
  for (const distribution of byPlace) {
    for (const [gameId, value] of distribution) {
      allGames.add(gameId);
      totalMass.set(gameId, (totalMass.get(gameId) ?? 0) + value);
    }
  }

  const newest = snapshots[snapshots.length - 1];
  const newestRank = new Map<number, number>();
  if (newest) {
    for (const row of newest.rows) {
      const previous = newestRank.get(row.universe_id);
      if (previous === undefined || row.rank < previous) newestRank.set(row.universe_id, row.rank);
    }
  }
  const top10 = Array.from(totalMass.keys()).sort((a, b) =>
    (totalMass.get(b)! - totalMass.get(a)!) ||
    ((newestRank.get(a) ?? Number.POSITIVE_INFINITY) - (newestRank.get(b) ?? Number.POSITIVE_INFINITY)) ||
    a - b,
  ).slice(0, places);

  if (top10.length < places && newest) {
    const newestRows = orderedRows(newest.rows);
    for (const row of newestRows) {
      if (top10.length >= places) break;
      if (!top10.includes(row.universe_id)) top10.push(row.universe_id);
    }
  }
  // If the newest chart is short, use earlier sightings to fill remaining slots.
  if (top10.length < places) {
    for (let index = snapshots.length - 1; index >= 0 && top10.length < places; index--) {
      const rows = orderedRows(snapshots[index].rows);
      for (const row of rows) {
        if (top10.length >= places) break;
        if (!top10.includes(row.universe_id)) top10.push(row.universe_id);
      }
    }
  }
  if (top10.length < places) {
    for (const gameId of Array.from(allGames).sort((a, b) => a - b)) {
      if (top10.length >= places) break;
      if (!top10.includes(gameId)) top10.push(gameId);
    }
  }
  return top10;
}

function run(): void {
  const inputDir = process.env.MAKEFUN_INPUT_DIR ?? '/input';
  const outputDir = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';
  const taskValue: unknown = JSON.parse(fs.readFileSync(path.join(inputDir, 'task.json'), 'utf8'));
  const task = isRecord(taskValue) ? taskValue : {};
  const placesValue = task.places;
  const outputValue = task.output;
  const window = isRecord(task.window) ? task.window : {};
  const places = Number.isInteger(placesValue) && (placesValue as number) > 0 ? placesValue as number : 10;
  const outputName = typeof outputValue === 'string' && outputValue.length > 0 ? outputValue : 'forecast.json';
  const parsedWindowFrom = timestamp(window.from);
  const parsedWindowUntil = timestamp(window.until);
  // Invalid window bounds use a unit interval and therefore leave age shares unchanged.
  const windowFrom = parsedWindowFrom !== null && parsedWindowUntil !== null && parsedWindowUntil > parsedWindowFrom ? parsedWindowFrom : 0;
  const windowUntil = parsedWindowFrom !== null && parsedWindowUntil !== null && parsedWindowUntil > parsedWindowFrom ? parsedWindowUntil : 1;

  let snapshots: Snapshot[] = [];
  try {
    snapshots = snapshotsFromFile(path.join(inputDir, 'history.ndjson'));
  } catch {
    // Missing or unreadable history is equivalent to no usable snapshots.
  }

  const byPlace = buildRankProbabilities(snapshots, places);
  applyAgeOut(byPlace, snapshots, windowFrom, windowUntil);
  capNamedMass(byPlace, places, snapshots.length);
  const probabilities = outputRows(byPlace, places);
  const top10 = topGames(byPlace, snapshots, places);
  const output = { probabilities, top10 };
  fs.writeFileSync(path.join(outputDir, outputName), `${JSON.stringify(output).replace(/\n+$/, '')}\n`, 'utf8');
}

run();
