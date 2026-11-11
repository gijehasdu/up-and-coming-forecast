// up-and-coming-forecast: a probabilistic forecast of Roblox's Up-and-Coming chart.
//
// The program reads the chart history in /input/history.ndjson plus /input/task.json and writes
// /output/forecast.json: for each of the chart's top 10 places, a probability for each game named
// being at that place over the scored window, and a top 10 in order.
//
// Model, in one paragraph: the chart churns too fast for a persistence forecast, so each place's
// distribution is built from the whole history with exponential recency weighting (a 40-hour time
// constant): how often each game sat at each rank, smoothed across neighbouring ranks. A fifth of
// the result is a "the chart has barely moved yet" component centred on the last read, which is
// what the window's first hours look like. Every place keeps a large share unnamed (45% at place 1
// rising to 70% at place 10): that share is spread over every game the forecast did not name, which
// is how new arrivals and games outside the recent top ranks get their probability. Where the
// history carries a game's creation date, a game is also scaled by the share of the scored window
// it spends inside the chart's 28-day age limit, because a game that ages out cannot hold a place.
//
// The forecast is deterministic: no randomness anywhere, so two runs on the same history produce
// the same bytes.

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

/** Recency time constant, hours: a read this old counts e^-1 against the newest one. */
const TAU_HOURS = 40;
/** Ranks whose sightings feed the per-place distributions (a game seen at 11-14 can still rise). */
const COUNTED_RANKS = 14;
/** Neighbour smoothing over ranks: weight on rank k-1, k, k+1 when building place k. */
const RANK_KERNEL: ReadonlyArray<readonly [number, number]> = [
  [-1, 0.18],
  [0, 0.64],
  [1, 0.18],
];
/** Share of each place borrowed from the last read's chart, spread over two neighbours each way. */
const LAST_CHART_SHARE = 0.2;
const LAST_CHART_KERNEL: ReadonlyArray<readonly [number, number]> = [
  [-2, 0.08],
  [-1, 0.24],
  [0, 0.36],
  [1, 0.24],
  [2, 0.08],
];
/** Unnamed share left at place 1 and at place 10, ramped linearly between them. */
const UNNAMED_FIRST = 0.45;
const UNNAMED_LAST = 0.7;
/** Rows smaller than this are dropped: they cannot move a log score and only cost bytes. */
const MIN_ROW = 0.002;
/** The chart only lists games published within this many days. */
const AGE_LIMIT_MS = 28 * 24 * 3600 * 1000;

interface ChartRow {
  rank: number;
  universe_id: number;
}

interface Snapshot {
  at: string;
  up_and_coming?: ChartRow[];
  details?: unknown;
}

interface GameDetail {
  created?: string;
}

const task = JSON.parse(readFileSync(join(INPUT_DIR, 'task.json'), 'utf8')) as {
  places: number;
  output: string;
  window: { from: string; until: string };
};
const places = task.places;

const lines = readFileSync(join(INPUT_DIR, 'history.ndjson'), 'utf8')
  .split('\n')
  .filter((l) => l.trim() !== '');
const snapshots: Snapshot[] = lines
  .map((l) => JSON.parse(l) as Snapshot)
  .filter((s) => Array.isArray(s.up_and_coming) && s.up_and_coming.length > 0)
  .sort((a, b) => Date.parse(a.at) - Date.parse(b.at));

const lastTime = Date.parse(snapshots[snapshots.length - 1]!.at);

// Recency weights, one per snapshot.
const weights = snapshots.map((s) => Math.exp(-(lastTime - Date.parse(s.at)) / (TAU_HOURS * 3600 * 1000)));
const weightSum = weights.reduce((a, b) => a + b, 0);

// Weighted sightings: sightings.get(game).get(rank) = weighted count of the game at that rank.
const sightings = new Map<number, Map<number, number>>();
snapshots.forEach((snap, i) => {
  const w = weights[i]!;
  for (const row of snap.up_and_coming!) {
    if (row.rank > COUNTED_RANKS) continue;
    let byRank = sightings.get(row.universe_id);
    if (byRank === undefined) {
      byRank = new Map();
      sightings.set(row.universe_id, byRank);
    }
    byRank.set(row.rank, (byRank.get(row.rank) ?? 0) + w);
  }
});

// Creation dates, from any snapshot that carries details: the newest detail wins.
function detailCreated(details: unknown, universeId: number): string | undefined {
  if (details === null || typeof details !== 'object') return undefined;
  let entry: unknown;
  if (Array.isArray(details)) {
    entry = (details as Array<Record<string, unknown>>).find((d) => d?.id === universeId || d?.universe_id === universeId);
  } else {
    entry = (details as Record<string, unknown>)[String(universeId)];
  }
  const created = (entry as GameDetail | undefined)?.created;
  return typeof created === 'string' ? created : undefined;
}
const createdAt = new Map<number, number>();
for (const snap of snapshots) {
  if (snap.details === undefined || snap.details === null) continue;
  for (const row of snap.up_and_coming!) {
    const c = detailCreated(snap.details, row.universe_id);
    if (c !== undefined) createdAt.set(row.universe_id, Date.parse(c));
  }
}

// Share of the scored window each game spends inside the age limit (1 when its age is unknown).
const windowFrom = Date.parse(task.window.from);
const windowUntil = Date.parse(task.window.until);
const windowMs = Math.max(1, windowUntil - windowFrom);
function eligibleShare(universeId: number): number {
  const created = createdAt.get(universeId);
  if (created === undefined || Number.isNaN(created)) return 1;
  const agesOutAt = created + AGE_LIMIT_MS;
  if (agesOutAt <= windowFrom) return 0;
  if (agesOutAt >= windowUntil) return 1;
  return (agesOutAt - windowFrom) / windowMs;
}

// The last read's chart, in order, for the barely-moved component and the final tie-breaks.
const lastChart = [...snapshots[snapshots.length - 1]!.up_and_coming!]
  .sort((a, b) => a.rank - b.rank)
  .map((r) => r.universe_id);
const lastRank = new Map<number, number>(lastChart.map((id, i) => [id, i + 1]));

interface ProbRow {
  universe_id: number;
  place: number;
  p: number;
}

// A short history knows less about the chart's habits, so it trusts its named rows less: the
// unnamed ramp below is lifted toward UNNAMED_LAST everywhere as the snapshot count falls to zero.
const historyConfidence = Math.min(1, snapshots.length / 40);

const probabilities: ProbRow[] = [];
const totalMass = new Map<number, number>();
for (let place = 1; place <= places; place++) {
  const ramped = UNNAMED_FIRST + ((UNNAMED_LAST - UNNAMED_FIRST) * (place - 1)) / Math.max(1, places - 1);
  const unnamed = ramped + (UNNAMED_LAST - ramped) * (1 - historyConfidence);
  const rows = new Map<number, number>();
  // History component: kernel-smoothed weighted sightings at this place.
  for (const [id, byRank] of sightings) {
    let v = 0;
    for (const [offset, kw] of RANK_KERNEL) v += kw * (byRank.get(place + offset) ?? 0);
    v /= weightSum;
    if (v > 0) rows.set(id, v);
  }
  // Blend in the barely-moved component, then scale each game by its eligible share of the window.
  for (const [id, v] of [...rows]) rows.set(id, v * (1 - LAST_CHART_SHARE));
  for (const [offset, kw] of LAST_CHART_KERNEL) {
    const id = lastChart[place - 1 + offset];
    if (id !== undefined) rows.set(id, (rows.get(id) ?? 0) + kw * LAST_CHART_SHARE);
  }
  for (const [id, v] of [...rows]) {
    const share = eligibleShare(id);
    if (share <= 0) rows.delete(id);
    else rows.set(id, v * share);
  }
  // Cap the named mass at 1 - unnamed, drop dust, and keep the largest rows (at most 100 a place).
  let sum = [...rows.values()].reduce((a, b) => a + b, 0);
  if (sum > 1 - unnamed) {
    const scale = (1 - unnamed) / sum;
    for (const [id, v] of rows) rows.set(id, v * scale);
    sum = 1 - unnamed;
  }
  const kept = [...rows.entries()]
    .filter(([, v]) => v >= MIN_ROW)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 100);
  for (const [id, v] of kept) {
    probabilities.push({ universe_id: id, place, p: Math.round(v * 1e6) / 1e6 });
    totalMass.set(id, (totalMass.get(id) ?? 0) + v);
  }
}

// Top 10: most total probability mass first; ties go to the game ranked higher when the history ends.
const top10 = [...totalMass.entries()]
  .sort((a, b) => b[1] - a[1] || (lastRank.get(a[0]) ?? 999) - (lastRank.get(b[0]) ?? 999))
  .slice(0, places)
  .map(([id]) => id);
for (const id of lastChart) {
  if (top10.length >= places) break;
  if (!top10.includes(id)) top10.push(id);
}

writeFileSync(join(OUTPUT_DIR, task.output), `${JSON.stringify({ probabilities, top10 })}\n`);
