/**
 * Name normalization for matching a Census Bureau geography name against
 * this project's own rate-table keys.
 *
 * The two sides never use the same convention. Census returns "Bluffton
 * village", "Columbus city", "Marion County", "Abington township",
 * "Bluffton Exempted Village School District". This project's own data
 * files (built independently, straight off each state's own primary
 * source) use "Bluffton", "Columbus", "Marion", "Abington", "ABINGTON TWP",
 * "Bluffton EVSD (expires 2028)". Every function here is pure and
 * deterministic — no network, no fuzzy/probabilistic matching — so a match
 * or non-match is always explainable and reproducible.
 */

/** Strip a parenthetical annotation, e.g. "Bluffton EVSD (expires 2028)" -> "Bluffton EVSD". */
export function stripParenthetical(name: string): string {
  return name.replace(/\s*\([^)]*\)\s*$/, '').trim();
}

/**
 * Census's "Incorporated Places" / "County Subdivisions" layers append a
 * legal/statistical qualifier this project's own MI/OH city files never
 * carry (they're keyed by the bare name). "Indianapolis city (balance)" is
 * the specific reason this strips iteratively rather than once — a single
 * regex pass leaves "(balance)" behind after removing "city ".
 *
 * The type-suffix match is deliberately CASE-SENSITIVE (lowercase only) —
 * Census always appends its own type word in lowercase ("Kansas City
 * city", "Detroit city"), while a place's own NAME can legitimately end in
 * a capitalized version of the same word ("Kansas City", "Carson City",
 * "Jersey City", "University City"). A case-INSENSITIVE match here was a
 * real, caught bug: on "Kansas City city" it stripped the appended
 * lowercase "city" on pass 1 to get "Kansas City", then — because the
 * regex's `i` flag also matched the capital "City" that's part of the
 * actual name — the loop's own iteration stripped THAT too on pass 2,
 * collapsing "Kansas City" all the way down to "Kansas". Caught by a
 * failing test (tests/geocode.test.ts's Kansas City case) before it ever
 * reached the live demo, not by reasoning about it in the abstract.
 */
export function stripPlaceTypeSuffix(name: string): string {
  let n = name.trim();
  let prev: string;
  do {
    prev = n;
    n = n
      .replace(/\s*\(balance\)\s*$/i, '')
      .replace(/\s+(city|village|town|township|borough|CDP|municipality)\s*$/, '')
      .trim();
  } while (n !== prev);
  return n;
}

/** "Marion County" -> "Marion". Indiana's own file stores the bare name. */
export function stripCountySuffix(name: string): string {
  return name.replace(/\s+County\s*$/i, '').trim();
}

const CASE_FOLD = (s: string): string => s.trim().toUpperCase();

/** Case/whitespace-insensitive equality — the baseline every matcher below builds on. */
export function namesEqual(a: string, b: string): boolean {
  return CASE_FOLD(a) === CASE_FOLD(b);
}

/**
 * PA-EIT-LST-2026.json stores municipality names Pennsylvania's own way:
 * upper-case, township/borough abbreviated ("ABINGTON TWP", "ABBOTT TWP").
 * Census's County Subdivisions layer returns "Abington township" — this
 * expands Census's spelled-out suffix to PA's own abbreviation so a plain
 * string-equality check (namesEqual) works without a fuzzy matcher.
 */
export function toPAMunicipalityForm(censusCountySubdivisionName: string): string {
  const n = censusCountySubdivisionName.trim();
  return n
    .replace(/\s+Township\s*$/i, ' TWP')
    .replace(/\s+Borough\s*$/i, ' BORO')
    .replace(/\s+City\s*$/i, ' CITY')
    .replace(/\s+Town\s*$/i, ' TOWN')
    .toUpperCase()
    .trim();
}

/**
 * Ohio school district names on each side use genuinely different
 * vocabularies for the SAME legal concept: Census/TIGERweb spells out
 * "Exempted Village School District" / "City School District" / "Local
 * School District"; data/local/OH-school-districts-2026.json (parsed
 * directly from Ohio's own SDIT_LIST.pdf) abbreviates to "EVSD"/"CSD"/
 * "LSD"/"JVSD" and appends parenthetical expiration notes. Reduces BOTH
 * sides to just the district's own place name plus a normalized type code,
 * so "Bluffton Exempted Village School District" and "Bluffton EVSD
 * (expires 2028)" both become {base: "BLUFFTON", type: "EVSD"}.
 */
export interface SchoolDistrictKey {
  base: string;
  type: string | null;
}

const OH_SD_TYPE_WORDS: [RegExp, string][] = [
  [/\bExempted\s+Village\b/i, 'EVSD'],
  [/\bLocal\b/i, 'LSD'],
  [/\bCity\b/i, 'CSD'],
  [/\bJoint\s+Vocational\b/i, 'JVSD'],
  [/\bUnion\b/i, 'USD'],
];

export function schoolDistrictKeyFromCensusName(censusName: string): SchoolDistrictKey {
  let base = censusName.replace(/\s*School\s+District\s*$/i, '').trim();
  let type: string | null = null;
  for (const [re, code] of OH_SD_TYPE_WORDS) {
    if (re.test(base)) {
      type = code;
      base = base.replace(re, '').trim();
      break;
    }
  }
  return { base: CASE_FOLD(base), type };
}

const OH_SD_ABBREVIATIONS = ['EVSD', 'CSD', 'LSD', 'JVSD', 'USD'];

export function schoolDistrictKeyFromDataFileName(dataFileName: string): SchoolDistrictKey {
  const withoutNote = stripParenthetical(dataFileName);
  const tokens = withoutNote.trim().split(/\s+/);
  const last = tokens[tokens.length - 1]?.toUpperCase();
  if (last && OH_SD_ABBREVIATIONS.includes(last)) {
    return { base: CASE_FOLD(tokens.slice(0, -1).join(' ')), type: last };
  }
  // PA's DCED file spells the same thing "LANCASTER S D" / "CONESTOGA
  // VALLEY S D" -- "School District" abbreviated to two separate letters.
  // Census writes "Lancaster School District", which the census-side key
  // already reduces to "LANCASTER", so without this the two never meet
  // and every PA municipality split across school districts stays
  // unresolvable. Stripped only at the END, so a district genuinely
  // named "... S D Something" is untouched.
  if (tokens.length >= 3 && tokens[tokens.length - 2]?.toUpperCase() === 'S' && last === 'D') {
    return { base: CASE_FOLD(tokens.slice(0, -2).join(' ')), type: null };
  }
  return { base: CASE_FOLD(withoutNote), type: null };
}

/**
 * Kentucky's confirmed COUNTY-level occupational-tax entries use two
 * different naming patterns for the same kind of jurisdiction (general
 * county government) — "Caldwell County" and "Martin County Fiscal
 * Court" — plus a THIRD, genuinely different jurisdiction type that
 * happens to also have "County" in its name: school-district-level
 * entries like "Cumberland County Public School District" (KRS
 * 67.750(10)'s independent school-district taxing authority, a different
 * legal actor from the county fiscal court itself). Returns null for the
 * school-district case deliberately — geocoding a Census "Cumberland
 * County" match to the SCHOOL DISTRICT'S occupational tax would
 * misrepresent what's actually being charged, even though today it's the
 * only confirmed Cumberland-named entry; a general "X County"/"X County
 * Fiscal Court" match is a claim about the county GOVERNMENT specifically.
 */
export function toKYCountyBaseName(name: string): string | null {
  if (/school|schools/i.test(name)) return null;
  return name
    .replace(/\s+Fiscal\s+Court\s*$/i, '')
    .replace(/\s+County\s*$/i, '')
    .trim();
}

/**
 * MD-2026.json's own countyRates object keys its 23 counties + Baltimore
 * City (a state-recognised independent city, part of NO county) in
 * camelCase with punctuation stripped: "AnneArundel", "PrinceGeorges",
 * "StMarys", "QueenAnnes", "BaltimoreCounty", "BaltimoreCity". Census
 * returns "Anne Arundel County", "Prince George's County", "St. Mary's
 * County", "Queen Anne's County", "Baltimore County" (the Counties layer)
 * and "Baltimore city" (the Incorporated Places layer, NOT Counties,
 * since Baltimore City sits inside no county) — this collapses either
 * form down to MD's own key so a plain equality check works.
 */
export function toMDCountyKey(censusName: string): string {
  const n = censusName.trim();
  // Baltimore is the one name MD-2026.json deliberately keeps the suffix
  // on ("BaltimoreCounty" vs "BaltimoreCity") precisely because the two are
  // easily confused, adjacent, different jurisdictions -- every other
  // county's key drops "County" entirely, so this can't be a general rule.
  if (/^Baltimore\s+County$/i.test(n)) return 'BaltimoreCounty';
  if (/^Baltimore\s+city$/i.test(n)) return 'BaltimoreCity';

  return n
    .replace(/\s+County\s*$/i, '')
    .replace(/'/g, '')
    .replace(/[.\s]+/g, ' ')
    .trim()
    .split(' ')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join('');
}

/**
 * Two district keys match when their base place-name is identical. The
 * `type` code is carried through for a confidence signal (see resolve.ts)
 * but NOT required to agree — Census and Ohio's own PDF have been observed
 * to classify the same district's type word slightly differently, so
 * requiring type equality would produce false negatives on a signal this
 * project doesn't fully trust either side of, per the confidence tiers.
 */
export function schoolDistrictKeysMatch(a: SchoolDistrictKey, b: SchoolDistrictKey): boolean {
  return a.base === b.base && a.base.length > 0;
}
