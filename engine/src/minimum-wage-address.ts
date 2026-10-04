/**
 * Address → minimum wage.
 *
 * `minimumWage()` in minimum-wage.ts deliberately refuses to guess a
 * locality from a state code: it takes a locality id and merges the levels
 * that apply. This module is the missing half — turning the place and
 * county names a geocode actually produced into one of the 69 local
 * ordinance ids in data/minimum-wage/local/.
 *
 * It is kept OUT of minimum-wage.ts on purpose, mirroring how geocode/ is
 * kept out of calculatePaycheck(): the wage lookup itself stays pure and
 * offline, and only this layer knows anything about addresses.
 *
 * The one rule worth stating up front, because it is the easiest thing to
 * get quietly wrong: a county ordinance scoped to "unincorporated areas
 * only" must fire ONLY when the address is in no incorporated place at
 * all. King County's $20.29 and Los Angeles County's $17.81 both work this
 * way — an address inside Seattle or inside the City of Los Angeles is
 * covered by the CITY's ordinance and expressly not the county's. Census
 * gives us exactly the signal needed for this: an empty incorporatedPlaces
 * array means the point falls on unincorporated land.
 */

import { localMinimumWages, minimumWage, type MinimumWageAnswer, type MinimumWageQuery } from './minimum-wage.ts';
import type { MinimumWageJurisdiction } from './registry.ts';

/**
 * Census appends a type word to place names ("Seattle city", "Renton
 * city", "West Hollywood city") and "County" to county names. Ordinance
 * files carry the bare proper name. Strip conservatively — only the
 * trailing type word, and only lower-case ones, so a genuine
 * "... City" in a proper name (Kansas City, Culver City, Daly City,
 * Redwood City, National City, Union City, Foster City) survives.
 *
 * This is the same case-sensitivity lesson geocode/normalize.ts already
 * learned the hard way: a case-INsensitive strip turned "Kansas City city"
 * into "Kansas".
 */
const PLACE_TYPE_WORDS = [
  'city',
  'town',
  'village',
  'borough',
  'municipality',
  'CDP',
  'urban county',
  'unified government',
  'metro government',
  'consolidated government',
];

export function normalizePlaceName(raw: string): string {
  let name = raw.trim();
  // Census parenthetical qualifiers: "Indianapolis city (balance)",
  // "Louisville/Jefferson County metro government (balance)".
  name = name.replace(/\s*\(balance\)\s*$/i, '').trim();
  for (const word of PLACE_TYPE_WORDS) {
    // Case-SENSITIVE for the lower-case forms; "CDP" is genuinely upper.
    const suffix = ` ${word}`;
    if (name.length > suffix.length && name.endsWith(suffix)) {
      name = name.slice(0, -suffix.length).trim();
      break;
    }
  }
  return name;
}

export function normalizeCountyName(raw: string): string {
  return raw
    .trim()
    .replace(/\s+(County|Parish|Borough|Census Area|Municipality|City and Borough)$/i, '')
    .trim();
}

function canonical(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

/**
 * A jurisdiction's own name, reduced to the part that can be compared with
 * a geocoded name. Ordinance names carry human scope notes the geocoder
 * will never produce — "King County (unincorporated areas only)",
 * "Los Angeles County (unincorporated areas only)". Those are handled by
 * `unincorporatedOnly` below, not by string matching.
 */
function comparableJurisdictionName(j: MinimumWageJurisdiction): string {
  return canonical(normalizeCountyName(normalizePlaceName(j.name.replace(/\s*\([^)]*\)\s*$/, ''))));
}

function unincorporatedOnly(j: MinimumWageJurisdiction): boolean {
  return /unincorporated/i.test(j.name) || /unincorporated/i.test(j.coverage ?? '');
}

export interface LocalityMatch {
  /** The ordinance id to pass to minimumWage({ locality }). */
  id: string;
  name: string;
  level: string;
  /** How this matched, in words a reviewer can check. */
  via: 'incorporated place' | 'county' | 'city and county' | 'unincorporated county';
  matchedOn: string;
}

export interface LocalityResolution {
  /** The ordinance that applies, or null when the address is in a state with locals but none of them cover it. */
  match: LocalityMatch | null;
  /** Every local ordinance in this state, so a caller can offer a manual override. */
  available: { id: string; name: string; level: string }[];
  /** Plain-language account of what happened — always populated, including on a miss. */
  note: string;
}

/**
 * Match a geocoded address's place/county names against one state's local
 * minimum wage ordinances.
 *
 * `incorporatedPlaces` empty means unincorporated land — see the module
 * comment. Pass exactly what Census returned; normalization happens here.
 */
export function resolveMinimumWageLocality(
  state: string,
  incorporatedPlaces: string[],
  counties: string[],
  checkDate: string,
): LocalityResolution {
  const jurisdictions = localMinimumWages(state, checkDate);
  const available = jurisdictions.map((j) => ({ id: j.id, name: j.name, level: j.level }));

  if (jurisdictions.length === 0) {
    return {
      match: null,
      available,
      note: `${state} has no local minimum wage ordinances in this dataset — the state (or federal) floor is the whole answer.`,
    };
  }

  const places = incorporatedPlaces.map(normalizePlaceName).filter(Boolean);
  const countyNames = counties.map(normalizeCountyName).filter(Boolean);
  const isUnincorporated = places.length === 0;

  // 1. A city ordinance for the incorporated place itself. Checked first:
  //    where a city and a county ordinance both exist, the city is the one
  //    the employee is actually inside.
  for (const place of places) {
    const hit = jurisdictions.find(
      (j) =>
        (j.level === 'city' || j.level === 'city_and_county') &&
        !unincorporatedOnly(j) &&
        (comparableJurisdictionName(j) === canonical(place) || canonical(j.id) === canonical(place)),
    );
    if (hit) {
      return {
        match: {
          id: hit.id,
          name: hit.name,
          level: hit.level,
          via: hit.level === 'city_and_county' ? 'city and county' : 'incorporated place',
          matchedOn: place,
        },
        available,
        note: `Address is inside ${hit.name}, which sets its own minimum wage.`,
      };
    }
  }

  // 2. A county ordinance. Two shapes, and the difference matters:
  //    countywide (Cook County IL, Montgomery County MD) applies to
  //    incorporated cities within it too; "unincorporated areas only"
  //    (King County WA, Los Angeles County CA) does not.
  for (const county of countyNames) {
    const hit = jurisdictions.find(
      (j) =>
        (j.level === 'county' || j.level === 'city_and_county') &&
        comparableJurisdictionName(j) === canonical(county),
    );
    if (!hit) continue;

    if (unincorporatedOnly(hit)) {
      if (!isUnincorporated) {
        // A real, common outcome worth reporting rather than silently
        // skipping: the county ordinance exists but expressly does not
        // reach this address.
        continue;
      }
      return {
        match: {
          id: hit.id,
          name: hit.name,
          level: hit.level,
          via: 'unincorporated county',
          matchedOn: county,
        },
        available,
        note: `Address is on unincorporated land in ${county} County, where the county's own ordinance applies.`,
      };
    }

    return {
      match: {
        id: hit.id,
        name: hit.name,
        level: hit.level,
        via: hit.level === 'city_and_county' ? 'city and county' : 'county',
        matchedOn: county,
      },
      available,
      note: `Address is in ${hit.name}, whose ordinance applies countywide.`,
    };
  }

  const where = places.length > 0 ? places.join(', ') : `unincorporated ${countyNames.join(', ')}`;
  return {
    match: null,
    available,
    note:
      `No ${state} local ordinance covers ${where}. ${jurisdictions.length} ${state} ` +
      `${jurisdictions.length === 1 ? 'locality has' : 'localities have'} one, and this address is in none of them — ` +
      `so the state floor applies. This is the ordinary outcome for most addresses in a state that has local wages.`,
  };
}

/**
 * The two states whose own rulesets split by geography rather than by
 * employer — and which `minimumWage()` will not guess at from a bare state
 * code. Both splits are stated by the ruleset itself, quoted here:
 *
 *   NY  "Work performed in NYC or in Nassau, Suffolk or Westchester county."
 *   OR  "Baker, Coos, Crook, Curry, Douglas, Gilliam, Grant, Harney,
 *        Jefferson, Klamath, Lake, Malheur, Morrow, Sherman, Umatilla,
 *        Union, Wallowa and Wheeler counties."
 *
 * Both are clean county tests, so a geocoded county resolves them exactly.
 * Oregon's THIRD region is not: portland_metro is an urban growth
 * boundary, not a county, and a UGB cuts through Multnomah/Washington/
 * Clackamas rather than following their lines. geocode/districts.ts's
 * isInsidePortlandMetro() answers that one from the coordinate; this
 * function deliberately does not guess it from the county name, and
 * returns undefined so the caller supplies it.
 */
const NY_DOWNSTATE_COUNTIES = new Set([
  'bronx', 'kings', 'new york', 'queens', 'richmond', // the five NYC boroughs
  'nassau', 'suffolk', 'westchester',
]);

const OR_NONURBAN_COUNTIES = new Set([
  'baker', 'coos', 'crook', 'curry', 'douglas', 'gilliam', 'grant', 'harney',
  'jefferson', 'klamath', 'lake', 'malheur', 'morrow', 'sherman', 'umatilla',
  'union', 'wallowa', 'wheeler',
]);

export function regionFromCounty(state: string, counties: string[]): string | undefined {
  const names = counties.map((c) => canonical(normalizeCountyName(c)));
  if (state === 'NY') {
    return names.some((n) => NY_DOWNSTATE_COUNTIES.has(n)) ? 'downstate' : undefined;
  }
  if (state === 'OR') {
    return names.some((n) => OR_NONURBAN_COUNTIES.has(n)) ? 'nonurban' : undefined;
  }
  return undefined;
}

export interface AddressMinimumWageInput {
  checkDate: string;
  state: string;
  incorporatedPlaces: string[];
  counties: string[];
  employeeCount?: number;
  tipped?: boolean;
  region?: string;
  occupation?: MinimumWageQuery['occupation'];
  /** Skip the address match and force this ordinance — for a caller correcting a resolution by hand. */
  localityOverride?: string;
}

export interface AddressMinimumWageAnswer {
  wage: MinimumWageAnswer;
  locality: LocalityResolution;
  /** The exact query handed to minimumWage(), so the answer is reproducible without re-geocoding. */
  query: MinimumWageQuery;
}

/**
 * The whole path: geocoded names in, binding wage out, with the locality
 * match and the losing candidates both visible.
 */
export function minimumWageForAddress(input: AddressMinimumWageInput): AddressMinimumWageAnswer {
  const locality = resolveMinimumWageLocality(
    input.state,
    input.incorporatedPlaces,
    input.counties,
    input.checkDate,
  );

  const localityId = input.localityOverride ?? locality.match?.id;
  // An explicitly supplied region always wins — Oregon's Portland metro
  // UGB can only come from the caller (see regionFromCounty's comment).
  const region = input.region ?? regionFromCounty(input.state, input.counties);

  const query: MinimumWageQuery = {
    checkDate: input.checkDate,
    state: input.state,
    ...(localityId ? { locality: localityId } : {}),
    ...(input.employeeCount !== undefined ? { employeeCount: input.employeeCount } : {}),
    ...(input.tipped ? { tipped: true } : {}),
    ...(region ? { region } : {}),
    ...(input.occupation ? { occupation: input.occupation } : {}),
  };

  return { wage: minimumWage(query), locality, query };
}
