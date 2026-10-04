/**
 * A THIRD, genuinely automated cross-check, added after discovering (by
 * hand, with satellite imagery — see nominatim.ts's own doc comment for
 * why that can't be the shipped feature) that Nominatim itself can be
 * confidently wrong: for "90 W Broad St, Columbus, OH", Nominatim placed
 * the address 0.56 miles away, on top of a real but entirely different
 * building (COSI, across the river), while Census's own point landed
 * correctly near the actual building (Columbus City Hall). A place-name
 * agreement check wouldn't have caught that — both geocoders "matched",
 * they just matched different things.
 *
 * What DOES catch it, and IS a real function (not a photo needing a human
 * or an LLM to look at it): OpenStreetMap separately publishes actual
 * TRACED BUILDING FOOTPRINT polygons — real structure geometry, drawn by
 * volunteers from imagery over years, independent of Nominatim's own
 * address-search index (a different OSM subsystem entirely, queried via
 * the Overpass API rather than Nominatim's endpoint). Many of those
 * footprints carry `addr:housenumber`/`addr:street` tags. This module:
 *
 *   1. Fetches every tagged building within ~150m of a resolved point.
 *   2. Finds the nearest one ON THE SAME STREET as the address being
 *      geocoded, and reads its house number.
 *   3. Compares that number against the ADDRESS BEING GEOCODED'S OWN
 *      house number. A large gap (Nominatim's case: the nearest building
 *      on W Broad Street was tagged "500" against a target of "90" — a
 *      410-number gap) is real, cheap, deterministic evidence the point
 *      landed somewhere numerically implausible for that street. A small
 *      gap (Census's case: "50 West Broad Street" against a target of
 *      "90" — 40 numbers, effectively next door) is reassuring, though
 *      not proof — street numbering isn't perfectly linear everywhere.
 *
 * The SAME-STREET restriction matters and is not decoration: the single
 * nearest building to a downtown point is often on a cross street (at
 * Census's own Columbus point, the third-closest footprint is "25 South
 * Front Street"), and comparing house numbers across two different
 * streets compares nothing at all. Numbers are only ever compared within
 * one street; when no footprint on the target street is tagged nearby,
 * this check reports no signal rather than a made-up one.
 *
 * HONEST LIMIT: this catches "far enough away that the house numbers
 * don't line up", not "close enough that the wrong building was picked
 * anyway." If the wrong building sits directly next to the right one
 * with a similar house number, this check won't catch it — no visual
 * inspection substitute exists here (see nominatim.ts's own doc comment
 * again: that requires an actual trained model, not achievable in this
 * project). Coverage is also uneven by design: OSM's building footprints
 * are dense downtown and sparse in rural areas, so many addresses get no
 * signal at all from this. It's a real, additive signal, not a
 * replacement for anything else this module already does.
 */
import { stripSecondaryUnit, type FetchOptions } from './census.ts';

/** census.ts's own options, plus the request-spacing cap and the availability state this module needs. Declared here rather than widened in census.ts, which has neither concept (nominatim.ts carries its own minIntervalMs for the same reason). */
export interface OverpassFetchOptions extends FetchOptions {
  minIntervalMs?: number;
  /** Which availability record this call should read and update. Defaults to the module-wide one, which is the point of it — pass an isolated record only in tests. */
  circuit?: OverpassCircuit;
}

/**
 * ONE endpoint on purpose. The obvious hardening move when the public
 * instance is busy — and it does go fully unreachable, not merely slow,
 * as it did while this was being written — is to fall back to a mirror.
 * That was tried against the real mirrors and rejected: overpass.osm.ch
 * answers HTTP 200 with ZERO elements for a US bounding box, because it
 * serves a Switzerland-only extract, and this check reads "no elements"
 * as "nothing is mapped here." A mirror with partial coverage doesn't
 * degrade the signal, it silently inverts it. The others tried
 * (overpass.kumi.systems, overpass.private.coffee) were themselves
 * erroring at the time and so could not be verified at all.
 *
 * So: when Overpass can't answer, this check reports itself unavailable
 * and the resolution carries on without it — see checkNearestBuilding().
 * Anyone adding a fallback later must first confirm the mirror actually
 * covers the whole US, not just that it returns 200.
 */
const OVERPASS_API = 'https://overpass-api.de/api/interpreter';
const USER_AGENT =
  'payroll-tax-engine geocode building-footprint check (github.com/capable78638974979473297813001-pixel/payroll-tax-engine-)';

interface OverpassElement {
  tags?: Record<string, string>;
  geometry?: { lat: number; lon: number }[];
}

export interface NearbyBuilding {
  distanceMeters: number;
  name: string | null;
  houseNumber: string | null;
  street: string | null;
}

/**
 * Overpass's public instance is a volunteer-run service with no SLA and a
 * shared per-IP query budget, and it genuinely does hand back HTTP 504
 * "dispatcher" errors under load — observed live while building this, on
 * a query that succeeded unchanged moments later. Hence TWO retries here
 * rather than census.ts's one: this call is a bonus signal, and giving up
 * on the first hiccup would silently downgrade the check to "unavailable"
 * for ordinary server busyness. The retry budget is still spent only on
 * transient failures (5xx/429/network), never on a 4xx.
 */
const OVERPASS_RETRIES = 2;

/**
 * Overpass's usage policy asks for moderate use of the public instance,
 * and enforces it: firing this module's queries back-to-back for a list
 * of addresses (which this project's own geocode demo does — ~20 in a few
 * seconds) got the endpoint to stop answering this machine entirely for a
 * while. That is a self-inflicted outage, not a service failure, so the
 * cap is enforced HERE rather than trusted to every caller — the same
 * decision, for the same reason, as nominatim.ts's own throttle. One
 * address at onboarding time never comes close to the limit.
 */
const DEFAULT_MIN_INTERVAL_MS = 1100;

let lastRequestAt = 0;

/** Module-level throttle state, deliberately shared across calls (that's the point). Tests pass minIntervalMs: 0 so the request LOGIC is exercised without the suite paying real wall-clock time. */
async function throttle(minIntervalMs: number): Promise<void> {
  const elapsed = Date.now() - lastRequestAt;
  if (elapsed < minIntervalMs) {
    await new Promise((resolve) => setTimeout(resolve, minIntervalMs - elapsed));
  }
  lastRequestAt = Date.now();
}

/** Honour a server-sent Retry-After (seconds, or an HTTP date) when there is one — a rate-limited service telling you exactly how long to wait is better information than any backoff curve. Capped so a hostile or garbled value can't hang a resolution. */
function retryAfterMs(res: Response): number | null {
  const header = res.headers.get('retry-after');
  if (!header) return null;
  const seconds = Number(header);
  const ms = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(header) - Date.now();
  if (!Number.isFinite(ms) || ms <= 0) return null;
  return Math.min(ms, 10_000);
}

/**
 * Distinguishes "Overpass answered, unhappily" (an HTTP status) from
 * "Overpass never answered at all" (connection refused, DNS, timeout).
 * The circuit breaker below treats those two very differently, and by the
 * time the error surfaces there's otherwise no way to tell them apart.
 */
class OverpassRequestError extends Error {
  readonly transport: boolean;

  constructor(message: string, transport: boolean) {
    super(message);
    this.name = 'OverpassRequestError';
    this.transport = transport;
  }
}

/**
 * When the endpoint is UNREACHABLE rather than merely busy, every
 * subsequent address pays the full retry-and-timeout budget for nothing —
 * a batch of 20 addresses would sit there for the better part of twenty
 * minutes producing no signal. That is exactly what happened here: the
 * public instance stopped answering this machine entirely, mid-session,
 * for many minutes at a stretch.
 *
 * So this module remembers. A transport failure (no answer at all) opens
 * the circuit immediately, since nothing about the next address will make
 * the host reachable; repeated HTTP-level failures open it after
 * CIRCUIT_FAILURE_THRESHOLD, since those can be one unlucky query. While
 * the circuit is open, checks report themselves unavailable INSTANTLY —
 * which is the same honest answer they would have reached slowly, minus
 * the wait and minus hammering a service that is already struggling.
 */
export interface OverpassCircuit {
  consecutiveFailures: number;
  /** Epoch ms until which requests are skipped outright. */
  openUntil: number;
}

const CIRCUIT_FAILURE_THRESHOLD = 3;
const CIRCUIT_COOLDOWN_MS = 5 * 60_000;

const sharedCircuit: OverpassCircuit = { consecutiveFailures: 0, openUntil: 0 };

async function fetchWithRetry(
  url: string,
  body: URLSearchParams,
  fetchImpl: typeof fetch,
  {
    retries = OVERPASS_RETRIES,
    timeoutMs = 20_000,
    baseBackoffMs = 500,
    minIntervalMs = DEFAULT_MIN_INTERVAL_MS,
  }: OverpassFetchOptions = {},
): Promise<Response> {
  let lastError: unknown;
  let lastFailureWasTransport = false;
  for (let attempt = 0; attempt <= retries; attempt++) {
    await throttle(minIntervalMs);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let serverAskedForMs: number | null = null;
    try {
      const res = await fetchImpl(url, {
        method: 'POST',
        body,
        signal: controller.signal,
        headers: { 'User-Agent': USER_AGENT },
      });
      clearTimeout(timer);
      if (res.ok) return res;
      if (res.status < 500 && res.status !== 429) return res;
      serverAskedForMs = retryAfterMs(res);
      lastError = new Error(`HTTP ${res.status}`);
      lastFailureWasTransport = false;
    } catch (err) {
      clearTimeout(timer);
      lastError = err;
      lastFailureWasTransport = true;
    }
    if (attempt < retries) {
      const waitMs = serverAskedForMs ?? (baseBackoffMs > 0 ? baseBackoffMs * 2 ** attempt : 0);
      if (waitMs > 0) await new Promise((resolve) => setTimeout(resolve, waitMs));
    }
  }
  throw new OverpassRequestError(
    lastError instanceof Error ? lastError.message : String(lastError),
    lastFailureWasTransport,
  );
}

function haversineMeters(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const R = 6_371_000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

/**
 * Distance from a point to a polygon's nearest EDGE, approximated by
 * sampling each edge segment — accurate enough at building scale (tens of
 * meters), not meant for anything larger.
 *
 * Deliberately NOT point-in-polygon containment, which was tried first
 * and rejected against real data: Census's own (correct) point for 90 W
 * Broad St falls tens of meters OUTSIDE City Hall's footprint, because
 * address-range interpolation lands a point near the STREET CURB, not
 * inside the building it belongs to. Containment would have scored the
 * right answer as a miss.
 */
function distanceToPolygonMeters(point: { lat: number; lon: number }, ring: { lat: number; lon: number }[]): number {
  let min = Infinity;
  const STEPS = 12;
  for (let i = 0; i < ring.length - 1; i++) {
    const a = ring[i];
    const b = ring[i + 1];
    for (let s = 0; s <= STEPS; s++) {
      const t = s / STEPS;
      const sample = { lat: a.lat + (b.lat - a.lat) * t, lon: a.lon + (b.lon - a.lon) * t };
      min = Math.min(min, haversineMeters(point, sample));
    }
  }
  return min;
}

/** Directional prefixes/suffixes, expanded so "W Broad St" and "West Broad Street" compare equal — OSM taggers and postal addresses genuinely differ on this within the same block (both forms appear in the real Columbus data this module was built against). */
const DIRECTIONALS: Record<string, string> = {
  n: 'north', s: 'south', e: 'east', w: 'west',
  ne: 'northeast', nw: 'northwest', se: 'southeast', sw: 'southwest',
};

/** Street-type suffixes, expanded for the same reason. Applied only at the END of the name — never at the front, so "St Clair Ave" doesn't become "Street Clair Avenue". */
export const STREET_TYPES: Record<string, string> = {
  st: 'street', str: 'street', ave: 'avenue', av: 'avenue', rd: 'road', blvd: 'boulevard',
  dr: 'drive', ln: 'lane', ct: 'court', pl: 'place', pkwy: 'parkway', pky: 'parkway',
  hwy: 'highway', cir: 'circle', ter: 'terrace', trl: 'trail', sq: 'square', expy: 'expressway',
};

/**
 * Numbered streets are the one place streetKey() used to fail silently:
 * found live against the National Address Database, Juneau, AK publishes
 * "FOURTH Street" and "West FOURTH Street" — the word form — while every
 * address this project or a caller writes says "4th St". Neither
 * DIRECTIONALS nor STREET_TYPES touches this (it's the street NAME, not
 * a prefix or suffix), so "120 4th St" against that data matched nothing
 * at all: not tier 1 (exact), not tier 3 (neighbor bracket, since nothing
 * on "4th" was found to bracket between) — a real address with a real
 * published point, missed for a spelling difference alone. Nationally
 * this is not an Alaska-only quirk: numbered streets are common, and
 * which convention a state's address authority uses is arbitrary and
 * inconsistent even within one state.
 *
 * These tables let ordinalRunAt() below recognise a run of number-words
 * ending in an ordinal ("twenty first", "One Hundred Twenty-Fifth" — NYC
 * goes at least that high) and collapse it to the digit form ("21st",
 * "125th") every other source already uses, the same expand-to-one-
 * canonical-form approach DIRECTIONALS and STREET_TYPES already use, just
 * for numbers instead of compass points and abbreviations.
 */
const CARDINAL_ONES: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9,
};
const CARDINAL_TENS: Record<string, number> = {
  twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90,
};
const ORDINAL_ONES: Record<string, number> = {
  first: 1, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6, seventh: 7, eighth: 8, ninth: 9,
};
const ORDINAL_TEENS: Record<string, number> = {
  tenth: 10, eleventh: 11, twelfth: 12, thirteenth: 13, fourteenth: 14,
  fifteenth: 15, sixteenth: 16, seventeenth: 17, eighteenth: 18, nineteenth: 19,
};
const ORDINAL_TENS: Record<string, number> = {
  twentieth: 20, thirtieth: 30, fortieth: 40, fiftieth: 50,
  sixtieth: 60, seventieth: 70, eightieth: 80, ninetieth: 90,
};

/** "1" -> "1st", "12" -> "12th", "23" -> "23rd" — English ordinal suffix, with the 11/12/13 exception. */
function ordinalSuffix(n: number): string {
  if (n % 100 >= 11 && n % 100 <= 13) return `${n}th`;
  switch (n % 10) {
    case 1: return `${n}st`;
    case 2: return `${n}nd`;
    case 3: return `${n}rd`;
    default: return `${n}th`;
  }
}

/**
 * Try to read a number-word run starting at tokens[i] that ENDS in an
 * ordinal word — "fourth" (1 token), "twenty first" (2), "one hundred
 * twenty fifth" (4). Returns the digit-ordinal form and how many tokens
 * it consumed, or null if tokens[i] doesn't start one. Greedy but
 * unambiguous: English number-words have exactly one reading here, so
 * there's no case where trying the longest run first could pick a wrong
 * one over a right one the way there could be with, say, abbreviation
 * expansion.
 */
function ordinalRunAt(tokens: string[], i: number): { text: string; length: number } | null {
  const t0 = tokens[i];

  // Longest: "one hundred twenty fifth" / "one hundred fifth" / "one hundredth".
  if (t0 === 'one' && tokens[i + 1] === 'hundred') {
    if (tokens[i + 2] !== undefined && CARDINAL_TENS[tokens[i + 2]] !== undefined && ORDINAL_ONES[tokens[i + 3]] !== undefined) {
      return { text: ordinalSuffix(100 + CARDINAL_TENS[tokens[i + 2]] + ORDINAL_ONES[tokens[i + 3]]), length: 4 };
    }
    if (ORDINAL_TEENS[tokens[i + 2]] !== undefined) {
      return { text: ordinalSuffix(100 + ORDINAL_TEENS[tokens[i + 2]]), length: 3 };
    }
    if (ORDINAL_TENS[tokens[i + 2]] !== undefined) {
      return { text: ordinalSuffix(100 + ORDINAL_TENS[tokens[i + 2]]), length: 3 };
    }
    if (ORDINAL_ONES[tokens[i + 2]] !== undefined) {
      return { text: ordinalSuffix(100 + ORDINAL_ONES[tokens[i + 2]]), length: 3 };
    }
  }
  if (t0 === 'one' && tokens[i + 1] === 'hundredth') {
    return { text: '100th', length: 2 };
  }
  if (t0 === 'hundredth') {
    return { text: '100th', length: 1 };
  }

  // "twenty first" -> 21st.
  if (CARDINAL_TENS[t0] !== undefined && ORDINAL_ONES[tokens[i + 1]] !== undefined) {
    return { text: ordinalSuffix(CARDINAL_TENS[t0] + ORDINAL_ONES[tokens[i + 1]]), length: 2 };
  }

  // Single-word: "fourth", "eleventh", "twentieth".
  if (ORDINAL_ONES[t0] !== undefined) return { text: ordinalSuffix(ORDINAL_ONES[t0]), length: 1 };
  if (ORDINAL_TEENS[t0] !== undefined) return { text: ordinalSuffix(ORDINAL_TEENS[t0]), length: 1 };
  if (ORDINAL_TENS[t0] !== undefined) return { text: ordinalSuffix(ORDINAL_TENS[t0]), length: 1 };

  return null;
}

/** Scan a token list left to right, collapsing every number-word run ordinalRunAt() recognises into its digit form. Tokens that are already digits ("4th"), or aren't a number word at all ("broad"), pass through untouched. */
function normalizeOrdinalTokens(tokens: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < tokens.length; ) {
    const run = ordinalRunAt(tokens, i);
    if (run) {
      out.push(run.text);
      i += run.length;
    } else {
      out.push(tokens[i]);
      i += 1;
    }
  }
  return out;
}

/**
 * Normalize a street name to a comparable key: lowercased, punctuation
 * dropped, directionals and the trailing street type expanded to their
 * full words.
 *
 * The street type is expanded at the last position OR just before a
 * trailing directional, because both orderings are real and both appear
 * in live data: "710 20th St N" is written that way on the envelope,
 * while the Alabama 911 Board publishes the same street as "20th Street
 * North". Without the second case those two never compare equal, and the
 * address silently gets no authoritative point.
 */
export function streetKey(street: string): string {
  const rawTokens = street.toLowerCase().replace(/[.,#-]/g, ' ').split(/\s+/).filter(Boolean);
  const tokens = normalizeOrdinalTokens(rawTokens);
  const last = tokens.length - 1;
  const typePosition = last > 0 && DIRECTIONALS[tokens[last]] ? last - 1 : last;
  return tokens
    .map((token, i) => {
      const isEdge = i === 0 || i === last;
      if (isEdge && DIRECTIONALS[token]) return DIRECTIONALS[token];
      if (i === typePosition && i > 0 && STREET_TYPES[token]) return STREET_TYPES[token];
      return token;
    })
    .join(' ');
}

/** Every directional word, in the fully-expanded form streetKey() produces — used to compare street names when one source writes the directional and the other doesn't. */
const EXPANDED_DIRECTIONALS = new Set(Object.values(DIRECTIONALS));

/**
 * The street key with any leading or trailing directional removed:
 * "north holliday street" -> "holliday street". Address authorities
 * genuinely disagree about these — Maryland publishes Baltimore's
 * "N Holliday St" as plain "Holliday Street" — so this exists to let a
 * caller retry a failed match with the directional set aside. It is
 * deliberately a SEPARATE function rather than folded into streetKey():
 * dropping the directional makes north and south sides of a divided
 * street compare equal, which is only acceptable as a knowing fallback,
 * never as the default comparison.
 */
export function streetKeyWithoutDirectionals(street: string): string {
  const tokens = streetKey(street).split(' ');
  while (tokens.length > 1 && EXPANDED_DIRECTIONALS.has(tokens[0])) tokens.shift();
  while (tokens.length > 1 && EXPANDED_DIRECTIONALS.has(tokens[tokens.length - 1])) tokens.pop();
  return tokens.join(' ');
}

/** Every street-type word in the fully-expanded form streetKey() produces ("street", "avenue", ...) — used to compare street names when one source writes the type and the other doesn't. */
const EXPANDED_STREET_TYPES = new Set(Object.values(STREET_TYPES));

/**
 * The street key with a trailing street TYPE removed:
 * "st antoine street" -> "st antoine".
 *
 * Exists because OpenAddresses and NAD disagree about whether the type
 * belongs in the name at all. Verified live: Detroit's Wayne County file
 * publishes 1901 St Antoine as street "ST ANTOINE", while the address is
 * universally written "1901 St Antoine St" — so an exact key comparison
 * misses a point that is unambiguously the right building.
 *
 * Deliberately a SEPARATE function, and used only as a knowing fallback,
 * for the same reason streetKeyWithoutDirectionals() is: dropping the
 * type makes "Main St" and "Main Ave" compare equal, and in a grid city
 * those are two different streets that can carry the same house number.
 * The caller is responsible for the cluster guard that makes that safe.
 */
export function streetKeyWithoutType(street: string): string {
  const tokens = streetKey(street).split(' ');
  while (tokens.length > 1 && EXPANDED_STREET_TYPES.has(tokens[tokens.length - 1])) tokens.pop();
  return tokens.join(' ');
}

/**
 * The street key with "capital"/"capitol" treated as one word.
 *
 * A verified real-world spelling split, not a guessed one: Census/USPS
 * consistently write Kentucky's own seat-of-government street as "Capitol
 * Ave" (the correct sense — the building), but Kentucky's own NAD
 * submission spells every point on it "Capital Avenue" (the wrong-but-
 * common homophone) — confirmed live 2026-09-02: 700 Capitol Ave,
 * Frankfort, KY has zero matches on "capitol" and 29 points on "Capital
 * Avenue" including one at house number 704, four doors from the target.
 * The same misspelling recurs elsewhere for the same reason (it names a
 * government building, and government data-entry gets its own building's
 * name wrong often enough to be a pattern, not a fluke).
 *
 * Deliberately NOT folded into streetKey() itself, for the same reason
 * streetKeyWithoutDirectionals() isn't: unlike a directional or a street
 * type, "Capital" and "Capitol" are genuinely different words elsewhere
 * (a real "Capital Blvd" financial-district street is not the same place
 * as a "Capitol Blvd" near a statehouse), so this is a knowing fallback a
 * caller reaches for after the exact and directional-fallback passes both
 * find nothing — never the default comparison. matchAddressPoint() and
 * neighborBracket() apply the same house-number and tight-cluster guards
 * to this pass as they do to the directional fallback, so a coincidental
 * same-number collision on an unrelated same-named street still can't
 * produce a wrong point.
 */
export function streetKeyCapitolNormalized(street: string): string {
  return streetKey(street)
    .split(' ')
    .map((token) => (token === 'capital' || token === 'capitol' ? 'capitol' : token))
    .join(' ');
}

/** Extract the leading house number from a one-line address string (e.g. "90 W Broad St, Columbus, OH" -> "90"). Returns null when the address doesn't start with a number. */
export function extractHouseNumber(oneLineAddress: string): string | null {
  const m = /^\s*(\d+)/.exec(oneLineAddress);
  return m ? m[1] : null;
}

/** Extract the street name from a one-line address: the first comma-separated segment, minus its house number and any apartment/suite designator (reusing census.ts's own stripper rather than keeping a second copy of that regex). Returns null when nothing comparable is left. */
export function extractStreet(oneLineAddress: string): string | null {
  const firstSegment = (stripSecondaryUnit(oneLineAddress) ?? oneLineAddress).split(',')[0] ?? '';
  const withoutNumber = firstSegment.replace(/^\s*\d+\s*/, '').trim();
  return withoutNumber.length > 0 ? withoutNumber : null;
}

function toNearbyBuilding(el: OverpassElement, distanceMeters: number): NearbyBuilding {
  const tags = el.tags ?? {};
  return {
    distanceMeters,
    name: tags.name ?? null,
    houseNumber: tags['addr:housenumber'] ?? null,
    street: tags['addr:street'] ?? null,
  };
}

function scan(
  point: { lat: number; lon: number },
  elements: OverpassElement[],
  accept: (el: OverpassElement) => boolean,
): NearbyBuilding | null {
  let best: NearbyBuilding | null = null;
  for (const el of elements) {
    if (!el.geometry || el.geometry.length < 2) continue;
    if (!accept(el)) continue;
    const distanceMeters = distanceToPolygonMeters(point, el.geometry);
    if (best === null || distanceMeters < best.distanceMeters) {
      best = toNearbyBuilding(el, distanceMeters);
    }
  }
  return best;
}

/**
 * Pure — given already-fetched Overpass elements, find the nearest
 * building of any kind to a point. Reported for context only (it's what a
 * human reviewing the address would see first on a map); the house-number
 * comparison itself uses nearestBuildingOnStreet(). Kept separate from the
 * fetch so it's testable with a captured fixture, the same split every
 * other live-data module in this project uses.
 */
export function nearestBuilding(
  point: { lat: number; lon: number },
  elements: OverpassElement[],
): NearbyBuilding | null {
  return scan(point, elements, () => true);
}

/**
 * Pure — the nearest building whose `addr:street` tag names the SAME
 * street as the address being checked, and which carries a house number
 * to compare. This, not the nearest building overall, is the one whose
 * number means anything: see this module's own doc comment.
 */
export function nearestBuildingOnStreet(
  point: { lat: number; lon: number },
  elements: OverpassElement[],
  targetStreet: string,
): NearbyBuilding | null {
  const target = streetKey(targetStreet);
  return scan(point, elements, (el) => {
    const street = el.tags?.['addr:street'];
    if (!street || !el.tags?.['addr:housenumber']) return false;
    return streetKey(street) === target;
  });
}

/**
 * Fetch every tagged building within roughly `radiusMeters` of a point via
 * the Overpass API — a separate OSM subsystem from Nominatim's own
 * address-search index (see this module's own top comment for why that
 * separation is exactly the point).
 *
 * Returns a result object rather than throwing, and deliberately
 * distinguishes "the query ran and there is genuinely nothing mapped
 * here" (ok, empty — the normal rural case) from "the query itself
 * failed" (not ok). Collapsing those two into one empty array would let a
 * server outage masquerade as real evidence about an address.
 *
 * NOTE for anyone editing the query: a plain bounding-box
 * `way["building"](...)` is used on purpose. An `is_in()`-based query was
 * tried first and timed out repeatedly against the public instance.
 */
export async function fetchNearbyBuildings(
  lat: number,
  lon: number,
  radiusMeters: number,
  fetchImpl: typeof fetch = fetch,
  retryOptions: OverpassFetchOptions = {},
): Promise<{ ok: true; elements: OverpassElement[] } | { ok: false; error: string }> {
  const circuit = retryOptions.circuit ?? sharedCircuit;
  if (Date.now() < circuit.openUntil) {
    return {
      ok: false,
      error: 'Overpass skipped: recent requests to it failed, backing off rather than making every address wait for the same timeout',
    };
  }

  // A crude but adequate degrees-per-meter conversion at typical US
  // latitudes — this only sizes a query bounding box, not anything that
  // needs to be precise.
  const dLat = radiusMeters / 111_320;
  const dLon = radiusMeters / (111_320 * Math.cos((lat * Math.PI) / 180));
  const query = `[out:json][timeout:20];way["building"](${lat - dLat},${lon - dLon},${lat + dLat},${lon + dLon});out tags geom;`;

  try {
    const res = await fetchWithRetry(
      OVERPASS_API,
      new URLSearchParams({ data: query }),
      fetchImpl,
      retryOptions,
    );
    if (!res.ok) {
      recordFailure(circuit, false);
      return { ok: false, error: `Overpass returned HTTP ${res.status}` };
    }
    const body = (await res.json()) as { elements?: OverpassElement[] };
    circuit.consecutiveFailures = 0;
    circuit.openUntil = 0;
    return { ok: true, elements: body.elements ?? [] };
  } catch (err) {
    recordFailure(circuit, err instanceof OverpassRequestError && err.transport);
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** A host that never answered is out, not busy: open the circuit at once. Failures that DID come back with a status get the benefit of the doubt until there are CIRCUIT_FAILURE_THRESHOLD of them in a row. */
function recordFailure(circuit: OverpassCircuit, transport: boolean): void {
  circuit.consecutiveFailures++;
  if (transport || circuit.consecutiveFailures >= CIRCUIT_FAILURE_THRESHOLD) {
    circuit.openUntil = Date.now() + CIRCUIT_COOLDOWN_MS;
  }
}

export interface BuildingCheckResult {
  /** true when Overpass actually answered — NOT a claim that anything was found. An address with no mapped footprints nearby (common outside downtowns) is `attempted: true` with everything below null: a real "no evidence either way", distinct from the service being unreachable. */
  attempted: boolean;
  /** The nearest footprint of any kind, for context in a human review. Its house number is NOT compared — it's frequently on a cross street. */
  nearest: NearbyBuilding | null;
  /** The nearest footprint tagged on the SAME street as the target address. This is the one the comparison uses. */
  onStreet: NearbyBuilding | null;
  /** Absolute difference between the target address's house number and `onStreet`'s — null whenever either number is unavailable, or no same-street footprint was found nearby. */
  houseNumberGap: number | null;
}

/**
 * A gap this large between the target house number and a real tagged
 * building on the same street, within 150m, means the point is
 * numerically implausible for that address — the Nominatim error this
 * module was built to catch scored 410. It sits deliberately well above
 * the 40 that Census's own CORRECT point scored on that same address: a
 * threshold tight enough to flag ordinary same-block slop would produce
 * false alarms on every street whose numbering isn't linear, and this
 * signal is only worth having if a flag means something.
 */
const LARGE_HOUSE_NUMBER_GAP = 150;

/** Search radius. Wide enough to find a block's footprints from a curb-interpolated point, tight enough that a "nearby" building is genuinely nearby. */
const NO_BUILDING_NEARBY_METERS = 150;

/**
 * Run the full check: fetch nearby buildings, find the nearest one on the
 * target street, compare house numbers. Never throws — a failed Overpass
 * request comes back as `attempted: false`, the same "no second opinion,
 * not evidence against the primary result" convention nominatim.ts uses.
 */
export async function checkNearestBuilding(
  targetAddress: string,
  point: { lat: number; lon: number },
  fetchImpl: typeof fetch = fetch,
  retryOptions: OverpassFetchOptions = {},
): Promise<BuildingCheckResult> {
  const fetched = await fetchNearbyBuildings(
    point.lat,
    point.lon,
    NO_BUILDING_NEARBY_METERS,
    fetchImpl,
    retryOptions,
  );
  if (!fetched.ok) {
    return { attempted: false, nearest: null, onStreet: null, houseNumberGap: null };
  }

  const nearest = nearestBuilding(point, fetched.elements);
  const targetStreet = extractStreet(targetAddress);
  const onStreet = targetStreet
    ? nearestBuildingOnStreet(point, fetched.elements, targetStreet)
    : null;

  const targetNumber = extractHouseNumber(targetAddress);
  const onStreetNumber = onStreet?.houseNumber ? Number(onStreet.houseNumber) : null;
  const houseNumberGap =
    targetNumber !== null && onStreetNumber !== null && Number.isFinite(onStreetNumber)
      ? Math.abs(Number(targetNumber) - onStreetNumber)
      : null;

  return { attempted: true, nearest, onStreet, houseNumberGap };
}

export { LARGE_HOUSE_NUMBER_GAP, NO_BUILDING_NEARBY_METERS };
