import { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { AddressPoint } from './rooftop.ts';

/**
 * A LOCAL address-point index, queried instead of the network.
 *
 * This is the answer to a gap that no amount of retrying the National
 * Address Database fixes. NAD is aggregated from states that volunteer,
 * and a 5km-box probe over each city (measured, not assumed) found ZERO
 * NAD points in Detroit, Grand Rapids, Pittsburgh, Honolulu, Las Vegas,
 * Manchester, Charleston, Boise, Jackson and Miami — while Philadelphia
 * and Hartford are dense. Contribution is county-by-county even within
 * one state.
 *
 * OpenAddresses collects the same authoritative local files directly from
 * counties, so it carries much of what NAD never received. Built into a
 * SQLite index by scripts/build-address-index.ts.
 *
 * TWO THINGS THIS DELIBERATELY DOES NOT DO:
 *
 *   1. It does not decide which point IS the address. It returns the
 *      neighbourhood; rooftop.ts's matchAddressPoint() applies the
 *      house-number, directional, street-type and unit guards it already
 *      has. Keeping that judgement in one place is the point — two
 *      matchers would drift apart.
 *   2. It does not claim national coverage. OpenAddresses is voluntary
 *      too: New Hampshire, for instance, ships only five towns and
 *      Manchester is not among them. An empty result here is a genuine
 *      "not published", not an error, and the caller falls through to the
 *      network tiers exactly as before.
 *
 * Absent index file = absent tier. Nothing breaks; the pipeline behaves
 * as it did before this existed, which is what makes the index optional
 * for anyone who does not want 5GB of extracts on disk.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const DB_PATH = process.env.ADDRESS_INDEX_PATH
  ?? join(HERE, '..', 'data', 'address-points', 'address-points.db');

/** Must match scripts/build-address-index.ts — a mismatch silently returns nothing. */
const CELL = 0.01;

let db: DatabaseSync | null = null;
let tried = false;

function handle(): DatabaseSync | null {
  if (tried) return db;
  tried = true;
  if (!existsSync(DB_PATH)) return null;
  try {
    db = new DatabaseSync(DB_PATH, { readOnly: true });
  } catch {
    db = null;
  }
  return db;
}

/** Whether a local index is available at all — for a caller that wants to report which tiers are live. */
export function hasLocalAddressIndex(): boolean {
  return handle() !== null;
}

export interface LocalIndexStats {
  available: boolean;
  totalPoints: number;
  states: { state: string; points: number }[];
}

export function localAddressIndexStats(): LocalIndexStats {
  const h = handle();
  if (!h) return { available: false, totalPoints: 0, states: [] };
  const total = h.prepare('SELECT COUNT(*) AS c FROM points').get() as { c: number };
  const rows = h
    .prepare('SELECT state, COUNT(*) AS c FROM points GROUP BY state ORDER BY c DESC')
    .all() as { state: string; c: number }[];
  return {
    available: true,
    totalPoints: total.c,
    states: rows.map((r) => ({ state: r.state, points: r.c })),
  };
}

/**
 * Address points within `radiusMeters` of a coordinate, in the same shape
 * fetchAddressPointsNear() returns from NAD, so both feed the same
 * matcher.
 *
 * The cell index narrows to a block of ~1.1km cells first — a bounding
 * box on raw lat/lon would force a full scan of ~100M rows.
 */
export function localAddressPointsNear(
  lat: number,
  lon: number,
  radiusMeters = 300,
): AddressPoint[] {
  const h = handle();
  if (!h) return [];

  const dLat = radiusMeters / 111_320;
  const dLon = radiusMeters / (111_320 * Math.cos((lat * Math.PI) / 180));

  const latCells = spanOf(lat - dLat, lat + dLat);
  const lonCells = spanOf(lon - dLon, lon + dLon);
  const cells: string[] = [];
  for (const la of latCells) for (const lo of lonCells) cells.push(`${la}:${lo}`);
  if (cells.length === 0) return [];

  const placeholders = cells.map(() => '?').join(',');
  const rows = h
    .prepare(
      `SELECT lat, lon, number, street, unit, city, state, source
         FROM points
        WHERE cell IN (${placeholders})
          AND lat BETWEEN ? AND ? AND lon BETWEEN ? AND ?`,
    )
    .all(...cells, lat - dLat, lat + dLat, lon - dLon, lon + dLon) as {
      lat: number; lon: number; number: string | null; street: string | null;
      unit: string | null; city: string | null; state: string; source: string;
    }[];

  return rows.map((r) => ({
    houseNumber: r.number,
    street: r.street,
    unit: r.unit,
    city: r.city,
    zip: null,
    // The shared points table has no Placement column — both builders
    // (OpenAddresses per-county extracts, NAD's own bulk text file) leave
    // it unstated here rather than guessed at, the same honesty NAD itself
    // shows by shipping "Unknown" for many of its own live-queried points.
    // A live NAD query still carries the real value via toAddressPoint().
    placement: null,
    // Full provenance ("OpenAddresses tx/harris", "NAD Cook County GIS") is
    // written into the source column AT INGEST by each build script, not
    // prefixed here — this table now holds rows from more than one
    // builder, so a single hardcoded prefix would mislabel the other's.
    source: r.source,
    lat: r.lat,
    lon: r.lon,
  }));
}

function spanOf(lo: number, hi: number): number[] {
  const a = Math.floor(lo / CELL);
  const b = Math.floor(hi / CELL);
  const out: number[] = [];
  for (let i = a; i <= b; i++) out.push(i);
  return out;
}
