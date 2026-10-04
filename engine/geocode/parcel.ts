/**
 * PARCEL-CENTROID FALLBACK — a fifth attempt, tried only where NAD has
 * nothing (rooftop.ts's own 'authoritative'/'authoritative-neighbors'
 * tiers) and OSM either has nothing or disagrees with Census.
 *
 * WHERE THIS CAME FROM: chasing why 9 states' sample civic addresses have
 * ZERO National Address Database points within 300m (confirmed live,
 *2026-09-06 — not a bug in this project's NAD query, verified by querying
 * NAD directly and getting an empty result). Many COUNTY governments
 * separately publish their own tax-parcel GIS layer, which usually carries
 * a site address AND a polygon. That polygon's centroid can stand in for
 * a rooftop point — but ONLY conditionally, because it is a fundamentally
 * different kind of evidence than a NAD point:
 *
 *   - A NAD point is placed BY THE ADDRESSING AUTHORITY, at the structure,
 *     for emergency dispatch. It answers "where is this address."
 *   - A tax parcel's polygon is a LEGAL PROPERTY BOUNDARY. Its centroid
 *     answers "where is the middle of this boundary," which is the same
 *     thing only when the parcel is small and holds one building.
 *
 * PROVEN BOTH WAYS, live, same session: Pennsylvania's Capitol address has
 * no NAD point, but Dauphin County's own parcel GIS carries a 287 sqm
 * parcel (a single state office building) whose centroid lands 68m from
 * the true address — an IMPROVEMENT over the 131m OSM fallback already in
 * place. Mississippi's Capitol address also has no NAD point, and Hinds
 * County's own parcel GIS (hosted by the state's own DEQ) carries a
 * parcel for the same complex — but it is 31,551 sqm, the entire capitol
 * grounds, and its centroid lands 146m away, WORSE than the 8m OSM
 * fallback already in place for that state. Same technique, opposite
 * verdict, because the two counties' parcels describe different things
 * (one building vs. an entire government campus) at the same address.
 *
 * THE GATE THIS FILE ENFORCES, to make sure PA's case is captured without
 * MS's case ever reaching a caller: reject any parcel whose area exceeds
 * MAX_TRUSTED_PARCEL_AREA_SQUARE_METERS outright — no result at all, same
 * "refuse rather than guess" discipline as every other tier in this
 * module. The caller (rooftop.ts) additionally only prefers this result
 * over OSM's when it is the CLOSER of the two to Census's own
 * interpolated point — a parcel centroid earns the upgrade by being
 * measurably better, not by existing at all.
 *
 * NO NATIONAL REGISTRY OF THIS EXISTS ON FREE TERMS. Every county runs its
 * own GIS with its own field names (Dauphin County: house_numb/street_nam
 * split fields; Hinds County: one combined SITEADD string) and its own
 * service URL — there is no shared schema the way NAD itself provides
 * one. PARCEL_SOURCES below is therefore a REGISTRY OF INDIVIDUALLY
 * VERIFIED COUNTIES, not a formula that covers a state once one county in
 * it is added. A jurisdiction absent from this registry was not tried —
 * it does not mean no such county service exists, only that finding and
 * verifying one is per-county research this project hasn't done yet, the
 * same "not yet looked up, never confirmed absent" discipline this
 * project applies everywhere else.
 */
import type { FetchOptions } from './census.ts';
import { streetKey, streetKeyWithoutDirectionals, STREET_TYPES } from './buildings.ts';
import { parseAddressParts } from './rooftop.ts';

/** A single county (or other sub-state) government's own parcel GIS service, individually verified. */
export interface ParcelSource {
  /** Two-letter state code this source can answer for. */
  state: string;
  /** Human-readable, for citing in a result's own detail string. */
  jurisdictionLabel: string;
  /** The ArcGIS FeatureServer/MapServer layer query endpoint. */
  queryUrl: string;
  /** Field name carrying the house number, when the schema splits it out. Mutually exclusive with siteAddressField. */
  houseNumberField?: string;
  /** Field name carrying the street name, paired with houseNumberField. */
  streetNameField?: string;
  /** Field name carrying ONE combined "123 MAIN ST" string, when the schema doesn't split it. Mutually exclusive with houseNumberField/streetNameField. */
  siteAddressField?: string;
  source: string;
}

/**
 * Individually verified county parcel sources — see this file's own doc
 * comment for why this is a per-county registry, not a per-state one, and
 * why a state's absence here means unresearched, not unavailable.
 */
export const PARCEL_SOURCES: ParcelSource[] = [
  {
    state: 'PA',
    jurisdictionLabel: 'Dauphin County, PA',
    queryUrl:
      'https://services2.arcgis.com/EEtiX55QzkHKYQKY/arcgis/rest/services/DC_Parcels/FeatureServer/0/query',
    houseNumberField: 'house_numb',
    streetNameField: 'street_nam',
    source: 'Dauphin County IT/GIS (data-dauphinco.opendata.arcgis.com)',
  },
];

/** No single building any US state government owns approaches this footprint — a government CAMPUS (Mississippi's capitol grounds parcel, verified live) runs to tens of thousands of square meters. Deliberately generous rather than tight: the goal is excluding multi-building complexes, not tuning for one building type. */
export const MAX_TRUSTED_PARCEL_AREA_SQUARE_METERS = 2000;

/** How far around the interpolated point to pull candidate parcels — deliberately wider than a tight "contains the point" radius, precisely because the CORRECT small parcel is often not the one the interpolated point happens to land in (see resolveParcelCentroid's own comment on Pennsylvania's Capitol case). The area gate, not this radius, is what keeps a wrong neighbour out. */
const PARCEL_SEARCH_RADIUS_METERS = 100;

export interface ParcelCentroidResult {
  point: { lat: number; lon: number };
  areaSquareMeters: number;
  metersFromInterpolated: number;
  source: ParcelSource;
}

interface RawParcelFeature {
  attributes: Record<string, unknown>;
  geometry?: { rings?: number[][][] };
}

const PARCEL_RETRIES = 2;

/** Same shape as every other geocode/*.ts fetchWithRetry — timeout, backoff, and a retry only on a transient failure (5xx/429/network), never on a definitive 4xx. Kept as its own copy rather than a shared import, matching this project's existing per-file convention (see rooftop.ts/census.ts/districts.ts/nominatim.ts/buildings.ts, each of which also carries its own). */
async function fetchWithRetry(
  url: string,
  fetchImpl: typeof fetch,
  { retries = PARCEL_RETRIES, timeoutMs = 30_000, baseBackoffMs = 400 }: FetchOptions = {},
): Promise<Response> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetchImpl(url, { signal: controller.signal });
      clearTimeout(timer);
      if (res.ok) return res;
      if (res.status < 500 && res.status !== 429) return res;
      lastError = new Error(`HTTP ${res.status}`);
    } catch (err) {
      clearTimeout(timer);
      lastError = err;
    }
    if (attempt < retries && baseBackoffMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, baseBackoffMs * 2 ** attempt));
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

async function queryParcels(
  source: ParcelSource,
  lat: number,
  lon: number,
  radiusMeters: number,
  fetchImpl: typeof fetch,
  retryOptions: FetchOptions,
): Promise<RawParcelFeature[]> {
  const outFields = [source.houseNumberField, source.streetNameField, source.siteAddressField]
    .filter((f): f is string => !!f)
    .join(',');
  const params = new URLSearchParams({
    geometry: `${lon},${lat}`,
    geometryType: 'esriGeometryPoint',
    inSR: '4326',
    spatialRel: 'esriSpatialRelIntersects',
    outFields: outFields || '*',
    returnGeometry: 'true',
    outSR: '4326',
    f: 'json',
    ...(radiusMeters > 0 ? { distance: String(radiusMeters), units: 'esriSRUnit_Meter' } : {}),
  });

  const res = await fetchWithRetry(`${source.queryUrl}?${params.toString()}`, fetchImpl, retryOptions);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = (await res.json()) as { features?: RawParcelFeature[]; error?: unknown };
  if (body.error) throw new Error(JSON.stringify(body.error));
  return body.features ?? [];
}

/** Signed area via the shoelace formula, in an equirectangular projection local to refLat — fine at parcel scale (never more than a few hundred meters across), wrong at any larger scale. */
function ringAreaSquareMeters(ring: number[][], refLat: number): number {
  const metersPerDegreeLat = 111_320;
  const metersPerDegreeLon = 111_320 * Math.cos((refLat * Math.PI) / 180);
  const pts = ring.map(([lon, lat]) => [lon * metersPerDegreeLon, lat * metersPerDegreeLat]);
  let area = 0;
  for (let i = 0; i < pts.length; i++) {
    const [x1, y1] = pts[i];
    const [x2, y2] = pts[(i + 1) % pts.length];
    area += x1 * y2 - x2 * y1;
  }
  return Math.abs(area) / 2;
}

/** Plain vertex-average centroid — not area-weighted, which is a known approximation for a very non-convex ring, but fine at the single-building scale MAX_TRUSTED_PARCEL_AREA_SQUARE_METERS already restricts this to. */
function ringCentroid(ring: number[][]): { lat: number; lon: number } {
  const lon = ring.reduce((s, p) => s + p[0], 0) / ring.length;
  const lat = ring.reduce((s, p) => s + p[1], 0) / ring.length;
  return { lat, lon };
}

/** Haversine — same formula rooftop.ts's own metersBetween uses, kept as its own copy per this project's existing per-file convention. */
function metersBetween(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const R = 6_371_000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

/**
 * Classifies one parcel feature's own address attribution against the
 * target address — the gate that replaced an earlier, WRONG version of
 * this function that picked "whichever small nearby parcel is closest,"
 * full stop. Caught live, same session: for Pennsylvania's Capitol
 * address (501 3rd St), that rule's closest small parcel was attributed
 * to house number 400 — a real, different, nearby building — not 501.
 * Distance to a point says nothing about whether a parcel IS that
 * address; only the parcel's own address fields do.
 *
 *   'exact'        — this parcel's own house number and street match the
 *                     target, after the same normalization rooftop.ts
 *                     uses for NAD matching. Strong evidence.
 *   'unattributed' — this parcel carries no ordinary house number at all
 *                     (blank, or the '0' placeholder Pennsylvania's own
 *                     data uses) — the pattern a government building
 *                     without a standard postal address shows in county
 *                     tax records (verified live: the PA Capitol's own
 *                     parcel carries neither a number nor even the
 *                     'SOUTH OFFICE BLDG' name text a truly attributed
 *                     one does). Weaker evidence — used only when no
 *                     'exact' candidate exists at all.
 *   'other'        — a real, different address. NEVER used, at any
 *                     distance, at any size — this is exactly the
 *                     misattribution this project refuses to guess past.
 */
/** True when a street name carries a leading/trailing directional at all — mirrors rooftop.ts's own hasDirectional, kept as its own copy per this project's existing per-file convention. */
function hasDirectional(street: string): boolean {
  return streetKey(street) !== streetKeyWithoutDirectionals(street);
}

/** Every street-type word streetKey() can expand a street name to end in. */
const EXPANDED_STREET_TYPES = new Set(Object.values(STREET_TYPES));

/**
 * The street key with any trailing street-TYPE word removed on top of
 * streetKeyWithoutDirectionals' own directional stripping — needed
 * because county parcel data commonly omits the type entirely (verified
 * live: Dauphin County, PA's own street_nam field stores "3RD", never
 * "3rd St" or "3rd Street"), which streetKeyWithoutDirectionals alone
 * does not bridge (it strips directionals, not types). Not exported —
 * this project's own buildings.ts deliberately keeps type-stripping out
 * of the shared streetKey() family (a caller like OSM's road-name match
 * genuinely needs "St" vs "Street" to still compare, just not present vs.
 * absent), so this stays a narrower, local tool for parcel data's own
 * habit of dropping the type outright.
 */
function streetKeyWithoutType(street: string): string {
  const tokens = streetKeyWithoutDirectionals(street).split(' ');
  if (tokens.length > 1 && EXPANDED_STREET_TYPES.has(tokens[tokens.length - 1])) tokens.pop();
  return tokens.join(' ');
}

function classifyParcelAddress(
  attributes: Record<string, unknown>,
  source: ParcelSource,
  targetHouseNumber: string,
  targetStreet: string,
): 'exact' | 'unattributed' | 'other' {
  if (!source.houseNumberField || !source.streetNameField) return 'other';
  const rawNumber = String(attributes[source.houseNumberField] ?? '').trim();
  const rawStreet = String(attributes[source.streetNameField] ?? '').trim();

  if (rawNumber === '' || rawNumber === '0') return 'unattributed';
  if (rawNumber !== targetHouseNumber.trim()) return 'other';

  if (streetKey(rawStreet) === streetKey(targetStreet)) return 'exact';

  // Directional fallback, same discipline as rooftop.ts's own
  // matchAddressPoint: a parcel dataset omitting "N"/"W" entirely from
  // "N 3rd St" is common (verified live: Dauphin County, PA does this),
  // but a candidate carrying the OPPOSITE directional never matches —
  // "N 3rd" and "S 3rd" are different streets, not a formatting
  // difference, so at least one side must have none at all.
  if (
    streetKeyWithoutDirectionals(rawStreet) === streetKeyWithoutDirectionals(targetStreet) &&
    (!hasDirectional(targetStreet) || !hasDirectional(rawStreet))
  ) {
    return 'exact';
  }

  // Type-suffix fallback, same directional guard as above applied to
  // whichever side is missing the street type instead of the
  // directional — county parcel data routinely stores a street name with
  // NEITHER a directional nor a type ("3RD" for "N 3rd St"), so this
  // strips both sides down to the bare core name before comparing.
  if (
    streetKeyWithoutType(rawStreet) === streetKeyWithoutType(targetStreet) &&
    (!hasDirectional(targetStreet) || !hasDirectional(rawStreet))
  ) {
    return 'exact';
  }

  return 'other';
}

/**
 * Try every registered parcel source for this address's state, in order.
 * Within each, gather every parcel within PARCEL_SEARCH_RADIUS_METERS,
 * classify each one's own address attribution against the target (see
 * classifyParcelAddress), and — among whichever tier is better populated,
 * 'exact' preferred over 'unattributed', 'other' never considered at
 * all — return the smallest-area candidate that still passes
 * MAX_TRUSTED_PARCEL_AREA_SQUARE_METERS. Never throws; a fetch failure or
 * gate rejection is indistinguishable from "no source registered" to the
 * caller, which already treats null as "this tier had nothing to add."
 */
export async function resolveParcelCentroid(
  oneLineAddress: string,
  interpolated: { lat: number; lon: number },
  fetchImpl: typeof fetch = fetch,
  retryOptions: FetchOptions = {},
): Promise<ParcelCentroidResult | null> {
  const parts = parseAddressParts(oneLineAddress);
  if (!parts.state || !parts.houseNumber || !parts.street) return null;
  const candidates = PARCEL_SOURCES.filter((s) => s.state === parts.state!.toUpperCase());
  if (candidates.length === 0) return null;

  for (const source of candidates) {
    let features: RawParcelFeature[];
    try {
      // A single buffered query, not "does one contain the point, else
      // buffer" — containment alone is a trap: a government campus often
      // has the interpolated point sitting inside an ADJACENT building's
      // oversized parcel (verified live: Pennsylvania's own interpolated
      // point for its Capitol address contains within a 64,819 sqm
      // neighbouring office-building parcel, not the Capitol's own small
      // one), and stopping at that first, wrong, oversized match would
      // never reach the correct smaller parcel sitting a few metres away.
      features = await queryParcels(
        source,
        interpolated.lat,
        interpolated.lon,
        PARCEL_SEARCH_RADIUS_METERS,
        fetchImpl,
        retryOptions,
      );
    } catch {
      continue;
    }
    if (features.length === 0) continue;

    const scored: { centroid: { lat: number; lon: number }; area: number; distance: number; tier: 'exact' | 'unattributed' }[] = [];
    for (const f of features) {
      const ring = f.geometry?.rings?.[0];
      if (!ring || ring.length < 3) continue;
      const tier = classifyParcelAddress(f.attributes, source, parts.houseNumber, parts.street);
      if (tier === 'other') continue;
      const area = ringAreaSquareMeters(ring, interpolated.lat);
      if (area > MAX_TRUSTED_PARCEL_AREA_SQUARE_METERS) continue;
      const centroid = ringCentroid(ring);
      const distance = metersBetween(interpolated, centroid);
      scored.push({ centroid, area, distance, tier });
    }
    if (scored.length === 0) continue;

    // 'exact' candidates entirely displace 'unattributed' ones when any
    // exist — an exact address match is never worse evidence than a
    // government building with no address at all. Smallest area within
    // the winning tier, on the theory that a smaller footprint is more
    // likely to be the single named structure rather than a larger lot
    // that merely happens to include it.
    const exact = scored.filter((s) => s.tier === 'exact');
    const pool = exact.length > 0 ? exact : scored;
    const best = pool.reduce((a, b) => (b.area < a.area ? b : a));

    return {
      point: best.centroid,
      areaSquareMeters: best.area,
      metersFromInterpolated: best.distance,
      source,
    };
  }
  return null;
}
