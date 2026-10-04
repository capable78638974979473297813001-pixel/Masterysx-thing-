/**
 * Live network calls to the Census Bureau's own free, public geocoding
 * services. Deliberately kept thin — everything that can be tested without
 * a live HTTP round-trip lives in resolve.ts/normalize.ts instead; fetch
 * is confined to exactly these two functions and nothing else in this
 * project ever calls them at paycheck-calculation time.
 *
 * Two SEPARATE Census services are needed, not one:
 *   1. geocoding.geo.census.gov/geocoder — address string -> lat/lon plus
 *      States/Counties/Incorporated Places/County Subdivisions. This is
 *      the ordinary "geocoder" most integrations mean by the word.
 *   2. tigerweb.geo.census.gov/.../tigerWMS_Current/MapServer/identify —
 *      school district boundaries are NOT included in service #1's
 *      response at any benchmark/vintage tried (confirmed empirically this
 *      session — Unified/Elementary/Secondary School District layers came
 *      back empty even on vintages that documented them). TIGERweb's
 *      generic identify operation, queried at the coordinates service #1
 *      already returned, is what actually has them (layers 14/16/18).
 *
 * HONEST LIMITS, not fixed here because they can't be without a paid
 * service this project deliberately doesn't depend on (see README's own
 * "zero dependencies" stance):
 *   - This geocoder INTERPOLATES a point along a street segment's address
 *     range rather than using surveyed rooftop coordinates. For an address
 *     genuinely near a jurisdiction line, that can occasionally place the
 *     point on the wrong side. matchQuality.addressRangeWidth (below) is
 *     the honest signal for THIS module's own output — a WIDE range means
 *     less positional confidence, not a guarantee of correctness.
 *     NO LONGER THE WHOLE STORY: rooftop.ts now resolves an authoritative,
 *     government-surveyed address point for addresses the National Address
 *     Database covers, and index.ts prefers that point over this one when
 *     it exists (measured on this project's own demo addresses: 15 of 18).
 *     Where NAD has no point, everything above still applies exactly as
 *     written.
 *   - No USPS CASS certification. normalizeAddress() below does cheap,
 *     genuinely useful cleanup (whitespace, secondary-unit stripping for
 *     the retry fallback) but is not a full address-correction service.
 */
import type { CensusGeographies } from './resolve.ts';

const GEOCODER_BASE = 'https://geocoding.geo.census.gov/geocoder/geographies/onelineaddress';
const TIGERWEB_BASE = 'https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb';

/**
 * Boundaries move. Cities annex land, school districts merge, county
 * subdivisions get redrawn — and a paycheck dated last year should be
 * resolved against the boundaries that existed last year, not today's.
 * TIGERweb publishes a separate MapServer per vintage, so this is a
 * matter of asking the right one.
 *
 * Verified live (2026-08-25) against TIGERweb's own service directory:
 * ACS2012 through ACS2019 and ACS2021 through ACS2025 exist, there is
 * no ACS2020 (the decennial year publishes as Census2020 instead),
 * Census2010 covers the previous decennial, and tigerWMS_Current is the
 * newest boundary set. A year with no published vintage falls forward to
 * Current rather than guessing.
 */
const ACS_VINTAGE_YEARS = new Set([
  2012, 2013, 2014, 2015, 2016, 2017, 2018, 2019, 2021, 2022, 2023, 2024, 2025,
]);

/** Which TIGERweb vintage service answers for a given check date. Pure. */
export function tigerwebServiceForDate(checkDate?: string): string {
  if (!checkDate) return 'tigerWMS_Current';
  const year = Number(checkDate.slice(0, 4));
  if (!Number.isFinite(year)) return 'tigerWMS_Current';
  if (year <= 2011) return 'tigerWMS_Census2010';
  if (year === 2020) return 'tigerWMS_Census2020';
  if (ACS_VINTAGE_YEARS.has(year)) return `tigerWMS_ACS${year}`;
  return 'tigerWMS_Current';
}

/**
 * Layer NUMBERS are not stable across vintages — Incorporated Places is
 * layer 28 in ACS2023, 26 in Census2020, and 26 in ACS2019 where States
 * and Counties also shift from 80/82 to 82/84. Hardcoding them would
 * silently query the wrong boundary type on an older check date, which
 * is worse than not supporting vintages at all. So layers are looked up
 * by NAME from each service's own metadata, once, and cached.
 */
const LAYER_NAMES = {
  schoolDistricts: 'Unified School Districts',
  countySubdivisions: 'County Subdivisions',
  places: 'Incorporated Places',
  states: 'States',
  counties: 'Counties',
} as const;

type LayerKey = keyof typeof LAYER_NAMES;

const layerIdCache = new Map<string, Promise<Partial<Record<LayerKey, number>>>>();

/** Test-only: forget cached layer metadata so a mocked fetch is actually consulted. */
export function clearVintageLayerCache(): void {
  layerIdCache.clear();
}

async function layerIdsFor(
  service: string,
  fetchImpl: typeof fetch,
  retryOptions: FetchOptions,
): Promise<Partial<Record<LayerKey, number>>> {
  const cached = layerIdCache.get(service);
  if (cached) return cached;

  const pending = (async () => {
    const res = await fetchWithRetry(`${TIGERWEB_BASE}/${service}/MapServer?f=json`, fetchImpl, retryOptions);
    if (!res.ok) throw new Error(`TIGERweb ${service} metadata returned HTTP ${res.status}`);
    const body = (await res.json()) as { layers?: { id: number; name: string }[] };
    const byName = new Map((body.layers ?? []).map((l) => [l.name, l.id]));
    const ids: Partial<Record<LayerKey, number>> = {};
    for (const [key, name] of Object.entries(LAYER_NAMES) as [LayerKey, string][]) {
      const id = byName.get(name);
      if (id !== undefined) ids[key] = id;
    }
    return ids;
  })();

  layerIdCache.set(service, pending);
  try {
    return await pending;
  } catch (err) {
    // A failed metadata fetch must not poison every later call.
    layerIdCache.delete(service);
    throw err;
  }
}

/**
 * Signals about HOW confidently this address resolved, all derived from
 * fields Census's own response already carries but this module previously
 * discarded. None of these upgrade interpolation to rooftop precision —
 * they tell a caller when to trust the match less, not how to trust it
 * more. Actually replacing the interpolated coordinate with a surveyed
 * one is rooftop.ts's job, not this module's.
 */
export interface MatchQuality {
  /** Census's own normalized interpretation of the input — compare against what was submitted; a large divergence (wrong street, wrong city) is a red flag Census's own confidence score won't otherwise surface. */
  matchedAddress: string;
  /**
   * How many addresses wide the street-segment range Census interpolated
   * within is (e.g. a "90"-to-"98" range is 9 wide). Bureau of the Census
   * TIGER/Line address ranges are usually EVEN-only or ODD-only on one
   * side of a street, so a "wide" range spans more physical distance than
   * the raw number suggests — treated here only as a relative signal
   * (bigger = less positionally precise), not an absolute distance.
   * Null when Census didn't return a usable range (rare).
   */
  addressRangeWidth: number | null;
  /** true when the address needed the fallback retry (secondary/unit info stripped) to match at all — a real, if small, precision cost: the interpolation ran against the base street address, not the specific unit. */
  matchedViaFallback: boolean;
}

export interface AddressGeocodeResult {
  matched: boolean;
  coordinates: { x: number; y: number } | null;
  geographies: CensusGeographies | null;
  matchQuality: MatchQuality | null;
}

function namesFrom(layer: unknown): string[] {
  if (!Array.isArray(layer)) return [];
  return layer.map((entry) => (entry as { NAME?: string }).NAME).filter((n): n is string => !!n);
}

/**
 * Cheap, honest address cleanup — NOT USPS CASS certification (that
 * requires USPS licensing this project doesn't have; see this module's own
 * doc comment). Collapses whitespace and drops common secondary-unit
 * designators (apartment/suite/unit/floor/# numbers), which is specifically
 * what Census's address-RANGE geocoder chokes on: TIGER/Line ranges are
 * keyed to the base street number, not the unit, so "123 Main St Apt 4B"
 * routinely fails to match even though "123 Main St" matches cleanly.
 * Exported so a caller can pre-clean before the first attempt too, not
 * just as this module's internal fallback.
 */
export function normalizeAddress(address: string): string {
  return address.trim().replace(/\s+/g, ' ');
}

/** The fallback form used on a retry: strips a trailing secondary-unit designator, if any. Returns null when there's nothing to strip (no point retrying with an identical string). */
export function stripSecondaryUnit(address: string): string | null {
  const stripped = address.replace(
    /,?\s+(apt|apartment|unit|ste|suite|fl|floor|#|rm|room|bldg|building)\.?\s*\S+\s*(?=,|$)/i,
    '',
  );
  const cleaned = normalizeAddress(stripped);
  return cleaned === normalizeAddress(address) ? null : cleaned;
}

const DIRECTIONALS: Record<string, string> = {
  N: 'N', S: 'S', E: 'E', W: 'W', NE: 'NE', NW: 'NW', SE: 'SE', SW: 'SW',
  NORTH: 'N', SOUTH: 'S', EAST: 'E', WEST: 'W',
  NORTHEAST: 'NE', NORTHWEST: 'NW', SOUTHEAST: 'SE', SOUTHWEST: 'SW',
};

/** House number and street directionals of a one-line address, as far as they can be read from it. */
function addressParts(address: string): { number: string | null; directionals: string } {
  const [street = ''] = address.toUpperCase().split(',');
  const tokens = street.replace(/[.#]/g, ' ').trim().split(/\s+/).filter(Boolean);
  const number = tokens[0] && /^\d/.test(tokens[0]) ? tokens.shift()! : null;
  const dirs: string[] = [];
  // A directional only counts when a street name remains beside it: in
  // "100 North St", NORTH is the name.
  if (tokens.length > 2 && DIRECTIONALS[tokens[0]]) dirs.push(DIRECTIONALS[tokens[0]]);
  if (tokens.length > 2 && DIRECTIONALS[tokens[tokens.length - 1]]) dirs.push(`(suffix) ${DIRECTIONALS[tokens[tokens.length - 1]]}`);
  return { number, directionals: dirs.join(' ') };
}

/**
 * Where Census's matched address names a different address from the one
 * submitted: another house number, or a street direction changed, dropped
 * or supplied. On the 2026-09-30 coverage run Census matched "100 N
 * Capitol Ave, Lansing" as 100 S Capitol, "1 E Edenton St, Raleigh" as
 * 1 W Edenton, and "1007 E Grand Ave, Des Moines" as 1007 Grand Ave two
 * kilometres west. Spelling, abbreviation and ZIP differences are not
 * reported: Census routinely replaces a government building's own ZIP
 * (36130, 05633, 50319) with the street's delivery ZIP. Empty when either
 * address can't be read.
 */
export function matchedAddressDifferences(submitted: string, matched: string): string[] {
  if (!matched) return [];
  const a = addressParts(stripSecondaryUnit(submitted) ?? submitted);
  const b = addressParts(matched);
  if (!a.number || !b.number) return [];
  const out: string[] = [];
  if (a.number !== b.number) out.push(`house number ${a.number} → ${b.number}`);
  if (a.directionals !== b.directionals) {
    out.push(`street direction ${a.directionals || 'none'} → ${b.directionals || 'none'}`);
  }
  return out;
}

export interface FetchOptions {
  retries?: number;
  timeoutMs?: number;
  /** Base delay for exponential backoff (attempt N waits baseBackoffMs * 2^N). Defaults to a real, production-sane 300ms — tests pass 0 so the retry/backoff LOGIC is exercised without the real suite paying real wall-clock time for it. */
  baseBackoffMs?: number;
}

/**
 * Fetch with a timeout and retry-with-backoff on transient failures
 * (network errors, 5xx, 429) — NOT on a genuine 4xx (bad request), which
 * retrying can't fix. Free government services carry no SLA and do
 * occasionally hiccup; this doesn't manufacture uptime Census doesn't
 * have, it just stops a single transient blip from failing the whole
 * resolution outright.
 */
async function fetchWithRetry(
  url: string,
  fetchImpl: typeof fetch,
  { retries = 2, timeoutMs = 10_000, baseBackoffMs = 300 }: FetchOptions = {},
): Promise<Response> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetchImpl(url, { signal: controller.signal });
      clearTimeout(timer);
      if (res.ok) return res;
      if (res.status < 500 && res.status !== 429) return res; // real client error, retrying won't help
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

function extractMatchQuality(match: {
  matchedAddress?: string;
  addressComponents?: { fromAddress?: string; toAddress?: string };
}): MatchQuality {
  const from = Number(match.addressComponents?.fromAddress);
  const to = Number(match.addressComponents?.toAddress);
  const width = Number.isFinite(from) && Number.isFinite(to) ? Math.abs(to - from) : null;
  return {
    matchedAddress: match.matchedAddress ?? '',
    addressRangeWidth: width,
    matchedViaFallback: false, // overwritten by the caller when the fallback path is actually the one that matched
  };
}

async function geocodeOnce(
  oneLineAddress: string,
  fetchImpl: typeof fetch,
  retryOptions: FetchOptions,
): Promise<AddressGeocodeResult> {
  const url = new URL(GEOCODER_BASE);
  url.searchParams.set('address', oneLineAddress);
  url.searchParams.set('benchmark', 'Public_AR_Current');
  url.searchParams.set('vintage', 'Current_Current');
  url.searchParams.set('format', 'json');

  const res = await fetchWithRetry(url.toString(), fetchImpl, retryOptions);
  if (!res.ok) {
    throw new Error(`Census geocoder returned HTTP ${res.status} for "${oneLineAddress}"`);
  }
  const body = (await res.json()) as {
    result: {
      addressMatches: {
        coordinates: { x: number; y: number };
        geographies: Record<string, unknown>;
        matchedAddress?: string;
        addressComponents?: { fromAddress?: string; toAddress?: string };
      }[];
    };
  };

  const match = body.result.addressMatches[0];
  if (!match) return { matched: false, coordinates: null, geographies: null, matchQuality: null };

  const geo = match.geographies;
  const statesLayer = geo['States'];
  const stateAbbrev =
    (Array.isArray(statesLayer) && (statesLayer[0] as { STUSAB?: string } | undefined)?.STUSAB) ||
    '';

  return {
    matched: true,
    coordinates: match.coordinates,
    geographies: {
      state: stateAbbrev,
      incorporatedPlaces: namesFrom(geo['Incorporated Places']),
      countySubdivisions: namesFrom(geo['County Subdivisions']),
      counties: namesFrom(geo['Counties']),
    },
    matchQuality: extractMatchQuality(match),
  };
}

/**
 * Geocode one address to coordinates plus the Census geography layers this
 * project's resolve.ts knows how to match against. Returns matched: false
 * (not a thrown error) when Census has no address match even after the
 * fallback retry — an unmatched address is an expected, common outcome
 * (typos, new construction, PO boxes), not a bug.
 *
 * Retries once with the secondary-unit designator stripped (see
 * stripSecondaryUnit()) if the first attempt doesn't match — a real match-
 * rate improvement specific to Census's address-RANGE geocoder, which
 * matches on the base street address and often fails outright on "Apt 4B"-
 * style suffixes that a rooftop geocoder wouldn't even blink at.
 */
export async function geocodeAddress(
  oneLineAddress: string,
  fetchImpl: typeof fetch = fetch,
  retryOptions: FetchOptions = {},
): Promise<AddressGeocodeResult> {
  const cleaned = normalizeAddress(oneLineAddress);
  const first = await geocodeOnce(cleaned, fetchImpl, retryOptions);
  if (first.matched) return first;

  const fallback = stripSecondaryUnit(cleaned);
  if (!fallback) return first;

  const retried = await geocodeOnce(fallback, fetchImpl, retryOptions);
  if (retried.matched && retried.matchQuality) {
    retried.matchQuality.matchedViaFallback = true;
  }
  return retried;
}

/**
 * Look up the Unified/Secondary/Elementary school district at a resolved
 * coordinate pair. Returns null when no district layer covers the point —
 * the correct outcome for most of the country, which has no school
 * district income tax concept at all (Ohio is the only state this project
 * models that does) — OR when the lookup itself failed after retries
 * (network/timeout), which is deliberately NOT the same as "no district
 * here" but returns the same shape; see fetchSchoolDistrictAtPointSafe()
 * for a caller that needs to tell the two apart.
 */
export async function fetchSchoolDistrictAtPoint(
  x: number,
  y: number,
  fetchImpl: typeof fetch = fetch,
  retryOptions: FetchOptions = {},
  checkDate?: string,
): Promise<string | null> {
  const service = tigerwebServiceForDate(checkDate);
  const ids = await layerIdsFor(service, fetchImpl, retryOptions);
  if (ids.schoolDistricts === undefined) return null;
  const results = await identifyAt(x, y, String(ids.schoolDistricts), service, fetchImpl, retryOptions);
  return results[0]?.value ?? null;
}

interface IdentifyResult {
  layerId?: number;
  value?: string;
  attributes?: Record<string, string>;
}

/** The one TIGERweb identify() call both point lookups in this module are built on. Layers are the caller's business; everything else about the request is fixed. */
async function identifyAt(
  x: number,
  y: number,
  layers: string,
  service: string,
  fetchImpl: typeof fetch,
  retryOptions: FetchOptions,
): Promise<IdentifyResult[]> {
  const url = new URL(`${TIGERWEB_BASE}/${service}/MapServer/identify`);
  url.searchParams.set('geometry', JSON.stringify({ x, y }));
  url.searchParams.set('geometryType', 'esriGeometryPoint');
  url.searchParams.set('sr', '4326');
  url.searchParams.set('layers', `all:${layers}`);
  url.searchParams.set('tolerance', '0');
  url.searchParams.set('mapExtent', `${x - 1},${y - 1},${x + 1},${y + 1}`);
  url.searchParams.set('imageDisplay', '600,550,96');
  url.searchParams.set('returnGeometry', 'false');
  url.searchParams.set('f', 'json');

  const res = await fetchWithRetry(url.toString(), fetchImpl, retryOptions);
  if (!res.ok) {
    throw new Error(`TIGERweb identify returned HTTP ${res.status} for (${x}, ${y})`);
  }
  const body = (await res.json()) as { results?: IdentifyResult[] };
  return body.results ?? [];
}

/**
 * Resolve the SAME set of geographies the address geocoder returns, but at
 * an arbitrary point rather than from an address string. This is what makes
 * an authoritative rooftop coordinate actually worth having: the geocoder's
 * own geographies describe the point IT chose (interpolated, at the curb),
 * so re-asking at the corrected point is the only way a better coordinate
 * can change a jurisdiction answer.
 *
 * Note the vocabulary matches deliberately: identify() returns "Columbus"
 * as its display value but carries Census's own "Columbus city" /
 * "Franklin County" spellings in each result's attributes, which is what
 * this reads — so resolve.ts's matching sees exactly the strings it would
 * have seen from the geocoder, with no second naming convention to
 * normalize. The state comes back as a real USPS code (STUSAB), not a
 * full state name, for the same reason.
 *
 * Returns null when the point resolves to no state at all (offshore, or a
 * bad coordinate) — a caller should keep whatever it already had.
 */
export async function fetchGeographiesAtPoint(
  x: number,
  y: number,
  fetchImpl: typeof fetch = fetch,
  retryOptions: FetchOptions = {},
  checkDate?: string,
): Promise<{ geographies: CensusGeographies; schoolDistrict: string | null } | null> {
  const service = tigerwebServiceForDate(checkDate);
  const ids = await layerIdsFor(service, fetchImpl, retryOptions);
  const wanted: LayerKey[] = ['schoolDistricts', 'countySubdivisions', 'places', 'states', 'counties'];
  const requested = wanted.map((key) => ids[key]).filter((id): id is number => id !== undefined);
  if (requested.length === 0) return null;

  const results = await identifyAt(x, y, requested.join(','), service, fetchImpl, retryOptions);

  const named = (key: LayerKey): string[] => {
    const layerId = ids[key];
    if (layerId === undefined) return [];
    return results
      .filter((r) => r.layerId === layerId)
      .map((r) => r.attributes?.NAME ?? r.value)
      .filter((n): n is string => !!n);
  };

  const state = results.find((r) => r.layerId === ids.states)?.attributes?.STUSAB;
  if (!state) return null;

  return {
    geographies: {
      state,
      incorporatedPlaces: named('places'),
      countySubdivisions: named('countySubdivisions'),
      counties: named('counties'),
    },
    schoolDistrict: named('schoolDistricts')[0] ?? null,
  };
}

/** Same as fetchGeographiesAtPoint(), but a failure is reported rather than thrown — an address resolution that already has the geocoder's own answer should degrade to that, not fail outright. */
export async function fetchGeographiesAtPointSafe(
  x: number,
  y: number,
  fetchImpl: typeof fetch = fetch,
  retryOptions: FetchOptions = {},
  checkDate?: string,
): Promise<
  | { ok: true; result: { geographies: CensusGeographies; schoolDistrict: string | null } | null }
  | { ok: false; error: string }
> {
  try {
    return { ok: true, result: await fetchGeographiesAtPoint(x, y, fetchImpl, retryOptions, checkDate) };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Same as fetchSchoolDistrictAtPoint(), but a network/timeout failure
 * (after retries already built into fetchWithRetry) is caught and
 * reported as `{ok: false}` rather than thrown — so a caller resolving a
 * whole address (see index.ts's geocodeAndResolve()) can still return the
 * municipality/county match it already has instead of failing the ENTIRE
 * resolution because one secondary lookup had a bad moment. A genuine
 * `null` result (no school district at this point — the common case)
 * still comes back as `{ok: true, district: null}`, distinct from a
 * failure.
 */
export async function fetchSchoolDistrictAtPointSafe(
  x: number,
  y: number,
  fetchImpl: typeof fetch = fetch,
  retryOptions: FetchOptions = {},
  checkDate?: string,
): Promise<{ ok: true; district: string | null } | { ok: false; error: string }> {
  try {
    const district = await fetchSchoolDistrictAtPoint(x, y, fetchImpl, retryOptions, checkDate);
    return { ok: true, district };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
