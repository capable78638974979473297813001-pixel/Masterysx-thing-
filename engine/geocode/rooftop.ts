/**
 * ROOFTOP PRECISION — the thing census.ts's own doc comment said this
 * project could only flag, never fix.
 *
 * Census's geocoder INTERPOLATES: it finds the street segment whose
 * address range contains the number and places a point proportionally
 * along it, at the curb. For "90 W Broad St, Columbus, OH" that lands 58m
 * from the building the address actually names (City Hall) and 23m from a
 * completely different one (LeVeque Tower). Near a municipal or school
 * district line, that error is the difference between withholding the
 * right local tax and the wrong one.
 *
 * What a paid geocoder has that this project didn't: authoritative
 * ADDRESS POINTS — one surveyed coordinate per real address, produced by
 * the county or state that assigns the addresses in the first place
 * (usually for E911 dispatch, where sending the ambulance to the curb
 * two doors down is a real problem). Those points are not proprietary.
 * The US DOT aggregates them into the NATIONAL ADDRESS DATABASE, ~98
 * MILLION address points contributed by state, local, and tribal
 * governments, published free and queryable point-by-point through a
 * public ArcGIS feature service. No key, no license, no bulk download.
 *
 * On the same Columbus address, live: NAD returns 39.962431,-83.003328 —
 * which sits 3.9m from City Hall's own traced building footprint, versus
 * Census's interpolated point 58m away next to the wrong tower. That is
 * rooftop precision, on free public data, in one HTTP call.
 *
 * IMAGERY closes the loop. OSM's building footprints (buildings.ts) are
 * polygons traced from satellite imagery — many of them machine-detected
 * by Microsoft's and Esri's computer-vision models and imported
 * wholesale; the Columbus footprints this was tested against literally
 * carry `source=esri/Franklin_County_OH_Buildings` tags. So an address
 * point can be checked against a building detected from imagery: if the
 * authoritative point lands ON a mapped structure, that is two
 * independent systems — one surveyed, one seen from orbit — agreeing on
 * where the building is. `confirmedOnBuilding` below is exactly that
 * check, and it is the automated form of the satellite-photo inspection
 * that started this whole line of work.
 *
 * HONEST LIMITS, measured rather than assumed (see the coverage numbers
 * in this project's own commit for this module):
 *   - COVERAGE IS NOT UNIVERSAL. NAD is voluntary: states and counties
 *     contribute what they have, so some areas are dense with points and
 *     others have none at all. Where there's no point, this returns
 *     `found: false` and the caller keeps Census's interpolated result —
 *     the precision is address-by-address, not a blanket upgrade.
 *   - A point is only as good as the government that submitted it. Most
 *     are structure-placed; some are parcel centroids or driveway access
 *     points. NAD's own `Placement` field says which, when the submitter
 *     populated it (Ohio's, for one, ships "Unknown").
 *   - This is positional precision, not address VALIDATION. A typo'd or
 *     nonexistent address doesn't become valid because no point matched.
 */
import { streetKey, streetKeyCapitolNormalized, streetKeyWithoutDirectionals, streetKeyWithoutType } from './buildings.ts';
import type { FetchOptions } from './census.ts';
import { searchStructuredAddressSafe } from './nominatim.ts';
import { resolveParcelCentroid, type ParcelCentroidResult } from './parcel.ts';
import { localAddressPointsNear } from './local-address-index.ts';

/**
 * The National Address Database, published by the US Department of
 * Transportation and hosted as a public ArcGIS feature service. Queried
 * by bounding box; ~98M points nationally.
 *
 * NOTE for anyone editing the query: this service rejects (HTTP 400,
 * with an empty message) several parameters that look perfectly legal —
 * `resultRecordCount`, `outSR`, and attribute-only `where` clauses on
 * fields like Zip_Code all failed against it. A bounding-box geometry
 * filter with `outFields=*` is what actually works, so that is what this
 * uses. Don't "tidy" it into a where-clause lookup without re-testing.
 */
const NAD_QUERY =
  'https://services.arcgis.com/xOi1kZaI0eWDREZv/ArcGIS/rest/services/Address_Points_from_National_Address_Database_view/FeatureServer/0/query';

/** How far around the interpolated point to look for the authoritative one. Interpolation error is a block-scale error — 300m covers it generously while keeping the response small enough to stay under the service's 2000-record cap even in a dense downtown (the Columbus test box returns ~227). */
const SEARCH_RADIUS_METERS = 300;

/**
 * A second, wider radius tried ONLY for an exact house-number-and-street
 * match, and ONLY after every tier has already come up empty at the
 * normal radius — never for the neighbor-bracket tier, which relies on
 * the narrow radius itself as its implicit "this is close to the target"
 * guard (neighborBracket() has no separate distance-to-interpolated check
 * of its own; widening its input radius would let it bracket two real
 * points that are near EACH OTHER but both far from the address actually
 * asked for).
 *
 * Exists because of a real, verified case: North Dakota's capitol address
 * (600 E Boulevard Ave, Bismarck) sits on East Boulevard Avenue, which
 * NAD publishes densely — but the point actually tagged house number 600
 * sits 443m from Census's own interpolated position for it, well outside
 * the normal 300m box, while the correctly-sequenced 604/608/612 points
 * nearby all fall within it. The likely reason is the same one already
 * documented for Pennsylvania's and Mississippi's capitol buildings in
 * parcel.ts: a large government campus can have its assigned address
 * point sited at the actual building or driveway entrance, set well back
 * from where a TIGER/Line address range would place a curb interpolation.
 * An exact match on house number AND street name is strong enough
 * evidence on its own that widening the search for it — but ONLY as a
 * last resort, after nothing closer has already succeeded — is safe: it
 * can only improve an address that would otherwise be reported as
 * uncorrected `interpolated`, never override a tier that already found
 * something at the normal radius.
 */
const WIDE_SEARCH_RADIUS_METERS = 600;

/** A NAD point this far from the rest of its own match group means the group isn't one building — most likely the same house number on the same street name in two different places inside the search box. Reported rather than silently averaged. */
const IMPLAUSIBLE_SPREAD_METERS = 120;

/**
 * OSM's house-level points are the fallback where NAD publishes nothing —
 * and they are NOT trusted on their own. OSM's own house-level answer for
 * 90 W Broad St, Columbus lands 897m away, on the wrong side of the
 * river; a rank-30 "house" result with a matching house number can still
 * be a different building entirely.
 *
 * So an OSM point is only used when it CORROBORATES the position Census
 * already interpolated — same block, give or take. Within that radius the
 * two independent systems agree about where the address is and OSM adds
 * precision; beyond it they disagree, and this module has no way to tell
 * which one is wrong, so it keeps the interpolated point and says so.
 * 250m is deliberately generous: interpolation itself is routinely 100m+
 * off (measured, this project's own demo addresses), so a tighter radius
 * would reject correct OSM points for being more accurate than the thing
 * they're checked against.
 */
const OSM_CORROBORATION_METERS = 250;

/** House numbers this far apart aren't neighbours in any useful sense, and interpolating between them is no better than what Census already does. */
const MAX_NEIGHBOR_NUMBER_GAP = 60;

/** Two "neighbouring" authoritative points further apart than this are not on the same block face; interpolating between them would invent a position. */
const MAX_NEIGHBOR_SPAN_METERS = 400;

interface NadAttributes {
  AddNo_Full?: string | null;
  St_PreDir?: string | null;
  St_PreTyp?: string | null;
  St_Name?: string | null;
  St_PosTyp?: string | null;
  St_PosDir?: string | null;
  Unit?: string | null;
  Inc_Muni?: string | null;
  Post_City?: string | null;
  Zip_Code?: string | null;
  Placement?: string | null;
  NAD_Source?: string | null;
  Latitude?: number | null;
  Longitude?: number | null;
}

export interface AddressPoint {
  houseNumber: string | null;
  street: string | null;
  unit: string | null;
  city: string | null;
  zip: string | null;
  /** NAD's own description of what the coordinate points at ("Structure", "Parcel", "Unknown"...) — populated by the submitting government, and frequently "Unknown". */
  placement: string | null;
  /** Which government submitted the point. Worth surfacing: it's the actual provenance of the coordinate. */
  source: string | null;
  lat: number;
  lon: number;
}

/** Compose the street name the way an address is written, out of NAD's separate directional/type/name columns: "West" + "BROAD" + "Street" -> "West BROAD Street". */
function composeStreet(a: NadAttributes): string | null {
  const parts = [a.St_PreDir, a.St_PreTyp, a.St_Name, a.St_PosTyp, a.St_PosDir]
    .map((p) => (p ?? '').trim())
    .filter((p) => p.length > 0);
  return parts.length > 0 ? parts.join(' ') : null;
}

function toAddressPoint(a: NadAttributes): AddressPoint | null {
  // The service returns geometry in Web Mercator, but every record also
  // carries plain WGS84 Latitude/Longitude columns. Using those keeps this
  // module free of a projection conversion whose only purpose would be to
  // undo one the service already did.
  if (typeof a.Latitude !== 'number' || typeof a.Longitude !== 'number') return null;
  if (!Number.isFinite(a.Latitude) || !Number.isFinite(a.Longitude)) return null;
  return {
    houseNumber: (a.AddNo_Full ?? '').trim() || null,
    street: composeStreet(a),
    unit: (a.Unit ?? '').trim() || null,
    city: (a.Inc_Muni ?? a.Post_City ?? '').trim() || null,
    zip: (a.Zip_Code ?? '').trim() || null,
    placement: (a.Placement ?? '').trim() || null,
    source: (a.NAD_Source ?? '').trim() || null,
    lat: a.Latitude,
    lon: a.Longitude,
  };
}

/**
 * TWO retries, not one: the feature service does hiccup under a run of
 * back-to-back queries — this project's own geocode demo, which resolves
 * eighteen addresses in a row, hit a transient failure on one of them and
 * fell back to the interpolated point for that address alone. A retry
 * budget is the difference between "this address has no published point"
 * and "the service blinked", and those two must never look alike.
 */
const NAD_RETRIES = 2;

async function fetchWithRetry(
  url: string,
  fetchImpl: typeof fetch,
  { retries = NAD_RETRIES, timeoutMs = 30_000, baseBackoffMs = 400 }: FetchOptions = {},
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

/** True when a street name carries a leading or trailing directional at all ("W Broad St" yes, "Holliday Street" no) — the fallback below is only safe between a name that has one and a name that doesn't. */
function hasDirectional(street: string): boolean {
  return streetKey(street) !== streetKeyWithoutDirectionals(street);
}

function metersBetween(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const R = 6_371_000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

/**
 * Fetch every authoritative address point within roughly `radiusMeters`
 * of a coordinate. Returns a result object rather than throwing, and
 * keeps "the service answered and there are no points here" (ok, empty —
 * the normal outcome wherever NAD has no contributing government)
 * distinct from "the request failed", for the same reason buildings.ts
 * does: an outage must never read as evidence about an address.
 */
export async function fetchAddressPointsNear(
  lat: number,
  lon: number,
  radiusMeters: number = SEARCH_RADIUS_METERS,
  fetchImpl: typeof fetch = fetch,
  retryOptions: FetchOptions = {},
): Promise<{ ok: true; points: AddressPoint[] } | { ok: false; error: string }> {
  const dLat = radiusMeters / 111_320;
  const dLon = radiusMeters / (111_320 * Math.cos((lat * Math.PI) / 180));
  const url = new URL(NAD_QUERY);
  url.searchParams.set('geometry', `${lon - dLon},${lat - dLat},${lon + dLon},${lat + dLat}`);
  url.searchParams.set('geometryType', 'esriGeometryEnvelope');
  url.searchParams.set('inSR', '4326');
  url.searchParams.set('outFields', '*');
  url.searchParams.set('returnGeometry', 'false');
  url.searchParams.set('f', 'json');

  try {
    const res = await fetchWithRetry(url.toString(), fetchImpl, retryOptions);
    if (!res.ok) return { ok: false, error: `National Address Database returned HTTP ${res.status}` };
    const body = (await res.json()) as { error?: { message?: string }; features?: { attributes?: NadAttributes }[] };
    if (body.error) return { ok: false, error: body.error.message || 'National Address Database rejected the query' };
    const points = (body.features ?? [])
      .map((f) => (f.attributes ? toAddressPoint(f.attributes) : null))
      .filter((p): p is AddressPoint => p !== null);
    return { ok: true, points };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export interface AddressParts {
  houseNumber: string | null;
  street: string | null;
  city: string | null;
  state: string | null;
  postalcode: string | null;
}

/** Split a one-line US address into the fields a structured geocoder wants. Deliberately simple — it handles the shape this project's own callers use ("90 W Broad St, Columbus, OH 43215") and returns nulls rather than guessing when a piece isn't there. */
export function parseAddressParts(oneLineAddress: string): AddressParts {
  const segments = oneLineAddress.split(',').map((s) => s.trim()).filter(Boolean);
  const streetSegment = segments[0] ?? '';
  const houseNumber = /^\s*(\d+)/.exec(streetSegment)?.[1] ?? null;
  const street = streetSegment.replace(/^\s*\d+\s*/, '').trim() || null;

  const last = segments[segments.length - 1] ?? '';
  const stateZip = /^([A-Za-z]{2})\s+(\d{5})(?:-\d{4})?$/.exec(last);
  const stateOnly = /^([A-Za-z]{2})$/.exec(last);
  const state = stateZip?.[1] ?? stateOnly?.[1] ?? null;
  const postalcode = stateZip?.[2] ?? null;
  const city = segments.length >= 3 ? segments[segments.length - 2] : null;

  return { houseNumber, street, city, state, postalcode };
}

/** The unit designator written into a one-line address ("123 Main St Apt 4B" -> "4B"), used to pick between per-unit points when a building has one point per unit. Null when the address names no unit. */
export function extractUnit(oneLineAddress: string): string | null {
  const m = /\b(?:apt|apartment|unit|ste|suite|rm|room|#)\.?\s*([A-Za-z0-9-]+)/i.exec(oneLineAddress);
  return m ? m[1] : null;
}

export interface RooftopMatch {
  point: { lat: number; lon: number };
  /** How many NAD points matched the address. More than one is normal and not a problem: a tower publishes one point per unit, all within the same building. */
  matchCount: number;
  /** Farthest matched point from the group's own centre. Small means one building; large means the search box caught two different places sharing a street name and number. */
  spreadMeters: number;
  /** The specific point chosen, with its provenance — which government published it, and what NAD says the coordinate refers to. */
  chosen: AddressPoint;
  /** True when the address named a unit and a point for that exact unit was found — the most precise case available. */
  matchedUnit: boolean;
  /** True when the street names only matched after setting directionals aside (Maryland publishes Baltimore's "N Holliday St" as plain "Holliday Street"). Still a real match — but a looser one, and only ever accepted when every candidate it produced sits in one tight cluster. */
  directionalFallback: boolean;
  /** True when the street names only matched after treating "Capital"/"Capitol" as the same word (Kentucky's own NAD submission spells Frankfort's state-capitol street "Capital Avenue"; Census/USPS spell the same street "Capitol Ave"). See streetKeyCapitolNormalized()'s own doc comment. Same tight-cluster guard as directionalFallback. */
  capitolFallback: boolean;
  /** True when the street names only matched after dropping the street TYPE ("St" vs "Ave") — NAD's Wayne County file publishes Detroit's 1901 St Antoine as street "ST ANTOINE" with no type at all. Riskier than the directional or capitol fallback (a grid city really can carry the same house number on both "Main St" and "Main Ave"), so it leans on the same tight-cluster guard those use. See streetKeyWithoutType()'s own doc comment. */
  streetTypeFallback: boolean;
}

/**
 * Pure — pick the authoritative point for an address out of a fetched
 * batch. Matching is on house number plus street, with the street
 * normalized through buildings.ts's own streetKey() so NAD's
 * "West BROAD Street" and a written "W Broad St" compare equal.
 *
 * When several points match (a tower with one point per unit), the
 * address's own unit wins if it names one; otherwise the group's centre
 * is used, which for a set of unit points inside one building is a point
 * inside that building. `spreadMeters` is reported so a caller can tell a
 * tight cluster from a group that isn't one place at all.
 */
export function matchAddressPoint(oneLineAddress: string, points: AddressPoint[]): RooftopMatch | null {
  const targetNumber = /^\s*(\d+)/.exec(oneLineAddress)?.[1] ?? null;
  const firstSegment = oneLineAddress.split(',')[0] ?? '';
  const targetStreetRaw = firstSegment.replace(/^\s*\d+\s*/, '').trim();
  if (!targetNumber || targetStreetRaw.length === 0) return null;

  // The written street may still carry a unit designator ("Main St Apt 4B");
  // NAD keeps units in their own column, so compare street names without it.
  const targetStreet = streetKey(
    targetStreetRaw.replace(/\s*\b(?:apt|apartment|unit|ste|suite|fl|floor|rm|room|#)\.?\s*[A-Za-z0-9-]+\s*$/i, ''),
  );

  const sameNumber = points.filter((p) => p.houseNumber === targetNumber && p.street !== null);
  let matches = sameNumber.filter((p) => streetKey(p.street!) === targetStreet);
  let directionalFallback = false;

  if (matches.length === 0) {
    // Second pass, deliberately looser: address authorities disagree about
    // whether a directional belongs in the name at all — Maryland
    // publishes Baltimore's "N Holliday St" as plain "Holliday Street".
    //
    // Two guards keep that from becoming a wrong answer. First, one side
    // must have NO directional: a target on "W Broad" may match a
    // candidate on plain "Broad", but never one on "E Broad" — those are
    // opposite sides of a real street, and downtown Columbus has both at
    // the same numbers. Second, every surviving candidate must land in one
    // tight cluster, since averaging two genuinely different places would
    // invent a point in the middle of the road.
    const targetCore = streetKeyWithoutDirectionals(targetStreetRaw);
    const targetHasDirectional = hasDirectional(targetStreetRaw);
    const loose = sameNumber.filter(
      (p) =>
        streetKeyWithoutDirectionals(p.street!) === targetCore &&
        (!targetHasDirectional || !hasDirectional(p.street!)),
    );
    if (loose.length > 0) {
      const looseCentre = {
        lat: loose.reduce((sum, p) => sum + p.lat, 0) / loose.length,
        lon: loose.reduce((sum, p) => sum + p.lon, 0) / loose.length,
      };
      if (Math.max(...loose.map((p) => metersBetween(looseCentre, p))) <= IMPLAUSIBLE_SPREAD_METERS) {
        matches = loose;
        directionalFallback = true;
      }
    }
  }

  // Fourth pass: one side writes the street TYPE and the other doesn't.
  // Verified live -- Detroit's Wayne County file publishes 1901 St Antoine
  // as "ST ANTOINE" while the address is written "1901 St Antoine St", so
  // the exact key comparison misses the correct building outright.
  //
  // Riskier than the directional pass, because "Main St" and "Main Ave"
  // both reduce to "main" and a grid city really does carry the same house
  // number on both. Same tight-cluster guard as the directional and
  // capitol passes above: only accepted when every surviving candidate
  // lands within IMPLAUSIBLE_SPREAD_METERS of the group's own centre, so
  // two genuinely different streets sharing a house number don't get
  // averaged into a point in the middle of neither.
  let streetTypeFallback = false;
  if (matches.length === 0) {
    const targetCore = streetKeyWithoutType(targetStreetRaw);
    const loose = sameNumber.filter((p) => streetKeyWithoutType(p.street!) === targetCore);
    if (loose.length > 0) {
      const looseCentre = {
        lat: loose.reduce((sum, p) => sum + p.lat, 0) / loose.length,
        lon: loose.reduce((sum, p) => sum + p.lon, 0) / loose.length,
      };
      if (Math.max(...loose.map((p) => metersBetween(looseCentre, p))) <= IMPLAUSIBLE_SPREAD_METERS) {
        matches = loose;
        streetTypeFallback = true;
      }
    }
  }

  let capitolFallback = false;
  if (matches.length === 0) {
    // Third pass, narrower than it looks: see streetKeyCapitolNormalized()'s
    // own doc comment for why this exists (a verified, specific real-world
    // spelling split, not a guess) and why it's kept separate from
    // streetKey() itself. Same house-number requirement and tight-cluster
    // guard as the directional fallback above.
    const targetCapitol = streetKeyCapitolNormalized(targetStreetRaw);
    const loose = sameNumber.filter((p) => streetKeyCapitolNormalized(p.street!) === targetCapitol);
    if (loose.length > 0) {
      const looseCentre = {
        lat: loose.reduce((sum, p) => sum + p.lat, 0) / loose.length,
        lon: loose.reduce((sum, p) => sum + p.lon, 0) / loose.length,
      };
      if (Math.max(...loose.map((p) => metersBetween(looseCentre, p))) <= IMPLAUSIBLE_SPREAD_METERS) {
        matches = loose;
        capitolFallback = true;
      }
    }
  }

  if (matches.length === 0) return null;

  const targetUnit = extractUnit(oneLineAddress);
  const unitMatch = targetUnit
    ? matches.find((p) => p.unit !== null && p.unit.toLowerCase() === targetUnit.toLowerCase())
    : undefined;

  const centroid = {
    lat: matches.reduce((sum, p) => sum + p.lat, 0) / matches.length,
    lon: matches.reduce((sum, p) => sum + p.lon, 0) / matches.length,
  };
  const spreadMeters = Math.max(...matches.map((p) => metersBetween(centroid, p)));

  const chosen = unitMatch ?? matches.find((p) => p.unit === null) ?? matches[0];
  const point = unitMatch ? { lat: unitMatch.lat, lon: unitMatch.lon } : centroid;

  return {
    point,
    matchCount: matches.length,
    spreadMeters,
    chosen,
    matchedUnit: Boolean(unitMatch),
    directionalFallback,
    capitolFallback,
    streetTypeFallback,
  };
}

export interface NeighborBracket {
  point: { lat: number; lon: number };
  below: AddressPoint;
  above: AddressPoint;
  /** How far apart the two bracketing points are — small means one block face. */
  spanMeters: number;
}

/**
 * Pure — when the authority publishes the street but not this exact
 * number (real and common: state capitols, new construction, renumbered
 * buildings), interpolate between the nearest published number BELOW and
 * the nearest ABOVE.
 *
 * This is still interpolation, and it is labelled as such everywhere it
 * surfaces. What makes it better than Census's own is what it
 * interpolates BETWEEN: two surveyed points that really exist, usually a
 * few doors apart, rather than the two ends of a TIGER address range that
 * may span an entire block face. It refuses to extrapolate past either
 * end, and refuses brackets too wide (in numbers or metres) to describe
 * one block.
 */
export function neighborBracket(oneLineAddress: string, points: AddressPoint[]): NeighborBracket | null {
  const { houseNumber, street } = parseAddressParts(oneLineAddress);
  if (!houseNumber || !street) return null;
  const target = Number(houseNumber);
  if (!Number.isFinite(target)) return null;

  const targetStreet = streetKey(street);
  let onStreet = points
    .filter((p) => p.street !== null && streetKey(p.street) === targetStreet && p.houseNumber !== null)
    .map((p) => ({ p, n: Number(p.houseNumber) }))
    .filter(({ n }) => Number.isFinite(n));

  if (onStreet.length === 0) {
    // Same knowing fallback as matchAddressPoint()'s third pass — see
    // streetKeyCapitolNormalized()'s own doc comment. No extra spread guard
    // needed here beyond what's already below: MAX_NEIGHBOR_NUMBER_GAP and
    // MAX_NEIGHBOR_SPAN_METERS apply to whatever this finds either way.
    const targetCapitol = streetKeyCapitolNormalized(street);
    onStreet = points
      .filter((p) => p.street !== null && streetKeyCapitolNormalized(p.street) === targetCapitol && p.houseNumber !== null)
      .map((p) => ({ p, n: Number(p.houseNumber) }))
      .filter(({ n }) => Number.isFinite(n));
  }

  let below: { p: AddressPoint; n: number } | null = null;
  let above: { p: AddressPoint; n: number } | null = null;
  for (const candidate of onStreet) {
    if (candidate.n < target && (below === null || candidate.n > below.n)) below = candidate;
    if (candidate.n > target && (above === null || candidate.n < above.n)) above = candidate;
  }
  if (!below || !above) return null;
  if (target - below.n > MAX_NEIGHBOR_NUMBER_GAP || above.n - target > MAX_NEIGHBOR_NUMBER_GAP) return null;

  const spanMeters = metersBetween(below.p, above.p);
  if (spanMeters > MAX_NEIGHBOR_SPAN_METERS) return null;

  const fraction = (target - below.n) / (above.n - below.n);
  return {
    point: {
      lat: below.p.lat + (above.p.lat - below.p.lat) * fraction,
      lon: below.p.lon + (above.p.lon - below.p.lon) * fraction,
    },
    below: below.p,
    above: above.p,
    spanMeters,
  };
}

/**
 * Which kind of point a resolution ended up with, best first:
 *   'authoritative'  — a point published for this exact address by the
 *                      government that assigns addresses. Rooftop.
 *   'authoritative-neighbors' — interpolated between the two nearest
 *                      published points on the same street. Still built
 *                      from two real government-surveyed points (not
 *                      guessed), just not the exact address — block-level,
 *                      honestly better than a TIGER range, not rooftop.
 *   'osm-corroborated' — OSM holds a house-level point for this address
 *                      AND it agrees with Census's own position, so two
 *                      independent systems place the address there.
 *                      Crowd-sourced: good, not authoritative.
 *   'parcel-centroid' — a COUNTY government's own tax-parcel polygon (not
 *                      NAD, a separate registry — see parcel.ts's own doc
 *                      comment) matched this address and its area passed
 *                      a "single building, not a whole campus" size gate.
 *                      Weaker than 'authoritative' — a legal boundary's
 *                      centroid, not a surveyed structure point — but
 *                      real government data, only ever used in place of
 *                      'osm-corroborated' when it lands measurably closer
 *                      to Census's own interpolated point.
 *
 * resolveRooftop() checks 'authoritative-neighbors' BEFORE
 * 'osm-corroborated' for exactly that reason: a tight NAD bracket (both
 * MAX_NEIGHBOR_NUMBER_GAP and MAX_NEIGHBOR_SPAN_METERS already guard
 * against a loose one) is built from real surveyed government points,
 * which is a better kind of evidence than a crowd-sourced point merely
 * not disagreeing with Census's own rough interpolation — verified this
 * matters live: 210 Capitol Ave, Hartford, CT sits 200m from a real NAD
 * bracket (numbers 168 and 223) that used to lose to OSM's corroborated
 * point purely because OSM was checked first, not because it was better.
 * 'parcel-centroid' is checked LAST, against whatever 'osm-corroborated'
 * found (if anything), and only wins by being closer to Census's own
 * point — never merely by existing. See parcel.ts's own doc comment for
 * why: a parcel centroid is unreliable in a way OSM's corroboration
 * check already isn't, so it only ever gets to REPLACE a result, never to
 * be trusted purely on its own say-so the way the other three tiers are.
 */
export type AddressPointTier =
  | 'authoritative'
  | 'authoritative-neighbors'
  | 'osm-corroborated'
  | 'parcel-centroid';

export interface OsmPointResult {
  point: { lat: number; lon: number };
  metersFromInterpolated: number;
  houseNumber: string | null;
  road: string | null;
}

export interface RooftopResult {
  /** false when the National Address Database couldn't be reached — no evidence either way, exactly like the other cross-checks here. */
  attempted: boolean;
  /** true when ANY tier produced a better point than the interpolated one. false with attempted: true means every tier came up empty — the honest outcome where nobody publishes this address. */
  found: boolean;
  /** Which tier produced the point. Null when none did. */
  tier: AddressPointTier | null;
  /** The best available coordinate, when found. */
  point: { lat: number; lon: number } | null;
  /** Set on the 'authoritative' tier only. */
  match: RooftopMatch | null;
  /** Set on the 'authoritative-neighbors' tier only. */
  neighbors: NeighborBracket | null;
  /** Set on the 'osm-corroborated' tier only. */
  osm: OsmPointResult | null;
  /** Set on the 'parcel-centroid' tier only. */
  parcel: ParcelCentroidResult | null;
  /** How far the authoritative point sits from Census's interpolated one — the size of the error being corrected. */
  metersFromInterpolated: number | null;
  /** True when the match group is too spread out to be one building; the point is still returned, but a caller should treat it as suspect. */
  ambiguous: boolean;
}

/**
 * Resolve one address to an authoritative rooftop coordinate, given
 * Census's interpolated point to search around. Never throws.
 */
/**
 * NAD and OpenAddresses often carry the SAME county's points, because
 * OpenAddresses ingests some of the same state files NAD does. Two copies
 * of one address would let neighborBracket() "bracket" a point with
 * itself, so identity is house number + street + a ~1m coordinate
 * rounding, keeping whichever was seen first (NAD, since it is merged
 * first and carries a Placement field OpenAddresses lacks).
 */
function dedupePoints(points: AddressPoint[]): AddressPoint[] {
  const seen = new Set<string>();
  const out: AddressPoint[] = [];
  for (const p of points) {
    const key = `${(p.houseNumber ?? '').toLowerCase()}|${(p.street ?? '').toLowerCase()}|${p.lat.toFixed(5)}|${p.lon.toFixed(5)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(p);
  }
  return out;
}

export async function resolveRooftop(
  oneLineAddress: string,
  interpolated: { lat: number; lon: number },
  fetchImpl: typeof fetch = fetch,
  retryOptions: FetchOptions = {},
  radiusMeters: number = SEARCH_RADIUS_METERS,
  /**
   * The local address index — OpenAddresses' per-county extracts and NAD's
   * own bulk text file, both loaded into the same table (scripts/
   * build-address-index.ts and scripts/build-nad-index.ts). Injectable for
   * the same reason fetchImpl is: a fixture-driven test supplies its own
   * network, and it must be able to supply its own local index too, or it
   * stops being hermetic the moment someone builds the multi-GB database on
   * their machine. Caught exactly that way -- three tests began failing
   * because they were silently reading real Detroit data.
   */
  localPointsImpl?: (lat: number, lon: number, radius: number) => AddressPoint[],
): Promise<RooftopResult> {
  // A caller that injected its own fetch supplied its own world -- almost
  // always a fixture-driven test. Reading the real on-disk index there
  // would make the same test pass or fail depending on whether someone
  // had run scripts/build-address-index.ts on that machine. Caught
  // exactly that way: three hermetic tests started reading live Detroit
  // data. An explicit localPointsImpl always wins over this default.
  const readLocal =
    localPointsImpl ?? (fetchImpl === globalThis.fetch ? localAddressPointsNear : () => []);
  const empty = {
    found: false as const,
    tier: null,
    point: null,
    match: null,
    neighbors: null,
    osm: null,
    parcel: null,
    metersFromInterpolated: null,
    ambiguous: false,
  };

  const fetched = await fetchAddressPointsNear(
    interpolated.lat,
    interpolated.lon,
    radiusMeters,
    fetchImpl,
    retryOptions,
  );

  // The LOCAL index is merged with NAD's own LIVE answer rather than
  // replacing it, because the local index (even with NAD's own bulk file
  // loaded into it — see scripts/build-nad-index.ts) is a point-in-time
  // snapshot and the live service can carry a point published since. NAD
  // and OpenAddresses are themselves merged the same way inside that local
  // index: neither is a superset of the other — NAD is dense in
  // Philadelphia and empty in Pittsburgh; OpenAddresses is the reverse in
  // several states. Merging means every tier below — exact match, neighbour
  // bracket, the wider exact-match retry — sees whichever source actually
  // published this address, with no extra branching.
  //
  // Absent index = empty array = behaviour identical to before it existed.
  const local = readLocal(interpolated.lat, interpolated.lon, radiusMeters);
  const points = dedupePoints([...(fetched.ok ? fetched.points : []), ...local]);

  // Tier 1 — a point published for this exact address.
  const match = matchAddressPoint(oneLineAddress, points);
  if (match) {
    return {
      attempted: true,
      found: true,
      tier: 'authoritative',
      point: match.point,
      match,
      neighbors: null,
      osm: null,
      parcel: null,
      metersFromInterpolated: metersBetween(interpolated, match.point),
      ambiguous: match.spreadMeters > IMPLAUSIBLE_SPREAD_METERS,
    };
  }

  // Tier 2 — between the nearest published numbers on the same street.
  // Tried BEFORE the OSM tier: two real surveyed government points,
  // gap- and span-guarded, are a better kind of evidence than a
  // crowd-sourced point that merely doesn't disagree with Census's own
  // rough interpolation. See AddressPointTier's own doc comment.
  const neighbors = neighborBracket(oneLineAddress, points);
  if (neighbors) {
    return {
      attempted: true,
      found: true,
      tier: 'authoritative-neighbors',
      point: neighbors.point,
      match: null,
      neighbors,
      osm: null,
      parcel: null,
      metersFromInterpolated: metersBetween(interpolated, neighbors.point),
      ambiguous: false,
    };
  }

  // Tier 3 — OSM's own house-level point, but only if it corroborates
  // where Census already put the address. See OSM_CORROBORATION_METERS.
  const osm = await resolveOsmPoint(oneLineAddress, interpolated, fetchImpl, retryOptions);

  // Tier 4 — a county's own tax-parcel centroid (see parcel.ts's own doc
  // comment for the whole mechanism and why it is gated the way it is).
  // Tried regardless of whether OSM already succeeded — the only way to
  // find out a parcel centroid is the BETTER of the two, as it verifiably
  // is for at least one real address (Pennsylvania's Capitol, 68m vs.
  // OSM's 131m) — but it only ever REPLACES osm's result by landing
  // measurably closer to Census's own interpolated point, never merely by
  // existing.
  const parcel = await resolveParcelCentroid(oneLineAddress, interpolated, fetchImpl, retryOptions);

  if (parcel && (!osm || parcel.metersFromInterpolated < osm.metersFromInterpolated)) {
    return {
      attempted: fetched.ok,
      found: true,
      tier: 'parcel-centroid',
      point: parcel.point,
      match: null,
      neighbors: null,
      osm: null,
      parcel,
      metersFromInterpolated: parcel.metersFromInterpolated,
      ambiguous: false,
    };
  }

  if (osm) {
    return {
      attempted: fetched.ok,
      found: true,
      tier: 'osm-corroborated',
      point: osm.point,
      match: null,
      neighbors: null,
      osm,
      parcel: null,
      metersFromInterpolated: osm.metersFromInterpolated,
      ambiguous: false,
    };
  }

  // Last resort — an exact match, but only found by looking further than
  // the normal radius. Tried only when NOTHING else worked (see
  // WIDE_SEARCH_RADIUS_METERS's own doc comment for why this is safe: it
  // can only improve an otherwise-`interpolated` result, never displace a
  // tier that already succeeded), and only when this call is itself at
  // the default radius — a caller who explicitly passed a custom
  // radiusMeters gets exactly the search they asked for, not a silently
  // widened one.
  if (radiusMeters === SEARCH_RADIUS_METERS) {
    const widerLocal = readLocal(interpolated.lat, interpolated.lon, WIDE_SEARCH_RADIUS_METERS);
    const wider = await fetchAddressPointsNear(
      interpolated.lat,
      interpolated.lon,
      WIDE_SEARCH_RADIUS_METERS,
      fetchImpl,
      retryOptions,
    );
    const widePoints = dedupePoints([...(wider.ok ? wider.points : []), ...widerLocal]);
    if (widePoints.length > 0) {
      const wideMatch = matchAddressPoint(oneLineAddress, widePoints);
      if (wideMatch) {
        return {
          attempted: true,
          found: true,
          tier: 'authoritative',
          point: wideMatch.point,
          match: wideMatch,
          neighbors: null,
          osm: null,
          parcel: null,
          metersFromInterpolated: metersBetween(interpolated, wideMatch.point),
          ambiguous: wideMatch.spreadMeters > IMPLAUSIBLE_SPREAD_METERS,
        };
      }
    }
  }

  return { ...empty, attempted: fetched.ok };
}

/**
 * Tier 2's lookup: ask OSM for a house-level point, then refuse it unless
 * it agrees with the interpolated position. Every guard here exists
 * because a rank-30 OSM "house" result is not evidence on its own — the
 * house number and street must match what was asked for, and the point
 * must be close enough to Census's own that the two sources are talking
 * about the same building.
 */
async function resolveOsmPoint(
  oneLineAddress: string,
  interpolated: { lat: number; lon: number },
  fetchImpl: typeof fetch,
  retryOptions: FetchOptions,
): Promise<OsmPointResult | null> {
  const parts = parseAddressParts(oneLineAddress);
  if (!parts.street || !parts.houseNumber) return null;

  const outcome = await searchStructuredAddressSafe(
    {
      street: `${parts.houseNumber} ${parts.street}`,
      city: parts.city ?? undefined,
      state: parts.state ?? undefined,
      postalcode: parts.postalcode ?? undefined,
    },
    fetchImpl,
    retryOptions,
  );
  if (!outcome.ok || !outcome.hit) return null;

  const hit = outcome.hit;
  // 30 is OSM's house rank. A street- or town-level result carries a
  // lower one and is not an address point at all.
  if (hit.placeRank !== 30 || !hit.coordinates) return null;
  if (hit.houseNumber !== parts.houseNumber) return null;
  if (hit.road && streetKey(hit.road) !== streetKey(parts.street)) return null;

  const metersFromInterpolated = metersBetween(interpolated, hit.coordinates);
  if (metersFromInterpolated > OSM_CORROBORATION_METERS) return null;

  return {
    point: hit.coordinates,
    metersFromInterpolated,
    houseNumber: hit.houseNumber,
    road: hit.road,
  };
}

export {
  IMPLAUSIBLE_SPREAD_METERS,
  MAX_NEIGHBOR_NUMBER_GAP,
  MAX_NEIGHBOR_SPAN_METERS,
  OSM_CORROBORATION_METERS,
  SEARCH_RADIUS_METERS,
  WIDE_SEARCH_RADIUS_METERS,
};
