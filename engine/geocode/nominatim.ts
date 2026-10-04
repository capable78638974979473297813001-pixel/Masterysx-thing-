/**
 * A SECOND, independent, free geocoder — OpenStreetMap's Nominatim — used
 * only as a cross-check against census.ts's result, never as the primary
 * source of truth. Two independently-built systems agreeing is real
 * evidence; the whole point here is that Census and OSM are maintained by
 * different organizations from different underlying data, so they don't
 * share a blind spot. Disagreement doesn't mean either one is WRONG — it
 * means a human should look, the same review-gate ethos every FieldMatch
 * in resolve.ts already uses.
 *
 * This does NOT itself close the rooftop-precision gap — OSM's address
 * data is crowd-sourced and interpolated in many of the same ways
 * TIGER/Line is. What it buys is a genuinely independent second opinion.
 * The precision gap is closed elsewhere and by different data: rooftop.ts
 * resolves government-surveyed address points from the National Address
 * Database, and index.ts prefers those coordinates when they exist. This
 * module's job is unchanged either way — asking a second system whether
 * the address even resolves to the same PLACE.
 *
 * Nominatim's own usage policy (https://operations.osmfoundation.org/
 * policies/nominatim/) requires: an identifying User-Agent, an absolute
 * cap of 1 request/second, and no heavy/bulk use — this module enforces
 * the rate cap itself (throttle()) rather than trusting every caller to
 * remember, since a caller doing this at onboarding time for one employee
 * address will never approach the limit, but nothing stops a future
 * caller from looping over many at once.
 */

const NOMINATIM_SEARCH = 'https://nominatim.openstreetmap.org/search';
const USER_AGENT =
  'payroll-tax-engine geocode cross-check (github.com/capable78638974979473297813001-pixel/payroll-tax-engine-)';
const DEFAULT_MIN_INTERVAL_MS = 1100; // Nominatim's policy caps at 1 req/sec; pad slightly.

let lastRequestAt = 0;

/** Module-level throttle state, deliberately shared across calls (that's the point — it enforces the cap regardless of how many callers exist). Tests pass minIntervalMs: 0 so the RATE-LIMITING LOGIC is exercised without the real suite paying real wall-clock time for it — the same fix already applied to census.ts's retry backoff. */
async function throttle(minIntervalMs: number): Promise<void> {
  const elapsed = Date.now() - lastRequestAt;
  if (elapsed < minIntervalMs) {
    await new Promise((resolve) => setTimeout(resolve, minIntervalMs - elapsed));
  }
  lastRequestAt = Date.now();
}

export interface NominatimResult {
  matched: boolean;
  /** Whichever of city/town/village/hamlet/municipality OSM's own address breakdown used — place-type vocabulary genuinely varies by settlement size (e.g. Bluffton, OH comes back under "town", Detroit under "city"). */
  place: string | null;
  county: string | null;
  coordinates: { lat: number; lon: number } | null;
}

export interface FetchOptions {
  retries?: number;
  timeoutMs?: number;
  baseBackoffMs?: number;
  minIntervalMs?: number;
}

async function fetchWithRetry(
  url: string,
  fetchImpl: typeof fetch,
  { retries = 1, timeoutMs = 10_000, baseBackoffMs = 300 }: FetchOptions = {},
): Promise<Response> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetchImpl(url, {
        signal: controller.signal,
        headers: { 'User-Agent': USER_AGENT },
      });
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

/**
 * Cross-check one address against Nominatim. Returns matched: false, not
 * a throw, both when Nominatim has no result AND when the request itself
 * failed (network/timeout/rate-limited after retries) — a cross-check
 * that couldn't run is treated the same as "no second opinion available",
 * never as evidence against the Census result. Callers that need to tell
 * "no result" apart from "request failed" should use crossCheckSafe().
 */
export async function crossCheckAddress(
  oneLineAddress: string,
  fetchImpl: typeof fetch = fetch,
  retryOptions: FetchOptions = {},
): Promise<NominatimResult> {
  await throttle(retryOptions.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS);

  const url = new URL(NOMINATIM_SEARCH);
  url.searchParams.set('q', oneLineAddress);
  url.searchParams.set('format', 'jsonv2');
  url.searchParams.set('addressdetails', '1');
  url.searchParams.set('limit', '1');

  const res = await fetchWithRetry(url.toString(), fetchImpl, retryOptions);
  if (!res.ok) {
    throw new Error(`Nominatim returned HTTP ${res.status} for "${oneLineAddress}"`);
  }
  const body = (await res.json()) as {
    lat?: string;
    lon?: string;
    address?: Record<string, string>;
  }[];

  const match = body[0];
  if (!match) return { matched: false, place: null, county: null, coordinates: null };

  const addr = match.address ?? {};
  const place = addr.city ?? addr.town ?? addr.village ?? addr.hamlet ?? addr.municipality ?? null;
  const county = addr.county ?? null;
  const lat = Number(match.lat);
  const lon = Number(match.lon);

  return {
    matched: true,
    place,
    county,
    coordinates: Number.isFinite(lat) && Number.isFinite(lon) ? { lat, lon } : null,
  };
}

export interface StructuredAddressHit {
  /** OSM's own confidence that this is a HOUSE-level result rather than a street or town centroid: 30 is the house rank. Anything less is not an address point, whatever else it looks like. */
  placeRank: number;
  houseNumber: string | null;
  road: string | null;
  coordinates: { lat: number; lon: number } | null;
}

/**
 * A STRUCTURED address lookup — street/city/state/postcode in their own
 * fields rather than one free-text string. Used by rooftop.ts to ask
 * whether OSM happens to hold a house-level point for an address the
 * National Address Database has nothing for, which is a genuinely
 * different question from crossCheckAddress()'s "does a second geocoder
 * agree about the PLACE".
 *
 * Returns whatever OSM says, including results that shouldn't be
 * trusted — the caller does the judging, because the judgement is
 * specific to what it's for. That matters here: OSM's own house-level
 * answer for 90 W Broad St, Columbus is confidently wrong (see
 * buildings.ts), and a caller that treats rank-30 as proof will inherit
 * that error.
 */
export async function searchStructuredAddress(
  parts: { street: string; city?: string; state?: string; postalcode?: string },
  fetchImpl: typeof fetch = fetch,
  retryOptions: FetchOptions = {},
): Promise<StructuredAddressHit | null> {
  await throttle(retryOptions.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS);

  const url = new URL(NOMINATIM_SEARCH);
  url.searchParams.set('street', parts.street);
  if (parts.city) url.searchParams.set('city', parts.city);
  if (parts.state) url.searchParams.set('state', parts.state);
  if (parts.postalcode) url.searchParams.set('postalcode', parts.postalcode);
  url.searchParams.set('format', 'jsonv2');
  url.searchParams.set('addressdetails', '1');
  url.searchParams.set('limit', '1');

  const res = await fetchWithRetry(url.toString(), fetchImpl, retryOptions);
  if (!res.ok) throw new Error(`Nominatim returned HTTP ${res.status} for a structured address lookup`);
  const body = (await res.json()) as {
    lat?: string;
    lon?: string;
    place_rank?: number;
    address?: Record<string, string>;
  }[];

  const match = body[0];
  if (!match) return null;
  const lat = Number(match.lat);
  const lon = Number(match.lon);
  return {
    placeRank: match.place_rank ?? 0,
    houseNumber: match.address?.house_number ?? null,
    road: match.address?.road ?? null,
    coordinates: Number.isFinite(lat) && Number.isFinite(lon) ? { lat, lon } : null,
  };
}

/** Same as searchStructuredAddress(), but a failure is reported rather than thrown — this is a fallback lookup, never a reason to fail a resolution that already has an answer. */
export async function searchStructuredAddressSafe(
  parts: { street: string; city?: string; state?: string; postalcode?: string },
  fetchImpl: typeof fetch = fetch,
  retryOptions: FetchOptions = {},
): Promise<{ ok: true; hit: StructuredAddressHit | null } | { ok: false; error: string }> {
  try {
    return { ok: true, hit: await searchStructuredAddress(parts, fetchImpl, retryOptions) };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Same as crossCheckAddress(), but a failure (network/timeout/rate-limit) is caught and reported as `{ok: false}` rather than thrown — a cross-check is a bonus signal, never something that should fail an otherwise-successful primary resolution. */
export async function crossCheckSafe(
  oneLineAddress: string,
  fetchImpl: typeof fetch = fetch,
  retryOptions: FetchOptions = {},
): Promise<{ ok: true; result: NominatimResult } | { ok: false; error: string }> {
  try {
    const result = await crossCheckAddress(oneLineAddress, fetchImpl, retryOptions);
    return { ok: true, result };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Great-circle distance in miles — used only to flag a LARGE disagreement in resolved position, not to claim either point is more accurate. */
export function milesBetween(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const R = 3958.8; // Earth radius in miles
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}
