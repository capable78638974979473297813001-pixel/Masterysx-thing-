/**
 * Address -> jurisdiction resolution, pure half.
 *
 * This module never touches the network — it takes ALREADY-FETCHED Census
 * geography data ("fetch is a parameter, not a side effect") and matches it
 * against this project's own name-keyed local tax registries. That split
 * is what makes this deterministically unit-testable with a captured JSON
 * fixture instead of a live HTTP call, and it's also what keeps a resolved
 * address from becoming a silent moving target: the resolution step runs
 * ONCE per employee address, not once
 * per paycheck. calculatePaycheck() itself still never touches the network
 * — this module only ever produces the certificate fields it already
 * accepts (workCity, county, schoolDistrictCode, workPSD, ...), it doesn't
 * change how paychecks are computed.
 */
import {
  allALCounties,
  allALMunicipalities,
  allCounties,
  allKYJurisdictions,
  allMICities,
  allOHMunicipalities,
  allOHSchoolDistricts,
  allPALocalJurisdictions,
  stateRuleset,
  type ALCountyEntry,
  type ALMunicipalityEntry,
  type CountyEntry,
  type KYJurisdictionEntry,
  type MICityEntry,
  type OHMunicipalityEntry,
  type OHSchoolDistrictEntry,
  type PALocalEntry,
} from '../src/registry.ts';
import type { StateCertificate } from '../src/types.ts';
import {
  namesEqual,
  schoolDistrictKeyFromCensusName,
  schoolDistrictKeyFromDataFileName,
  schoolDistrictKeysMatch,
  stripCountySuffix,
  stripPlaceTypeSuffix,
  toKYCountyBaseName,
  toMDCountyKey,
  toPAMunicipalityForm,
} from './normalize.ts';

/** A confidence tier for one resolved field — the same disclosed-tier ethos this project's data files already use (source_verified / modelled / etc.), applied to a MATCH instead of a rate. */
export type MatchConfidence = 'matched' | 'no_match' | 'ambiguous';

export interface FieldMatch<T> {
  confidence: MatchConfidence;
  entry: T | null;
  /** All candidates found when confidence is 'ambiguous' — surfaced for a human to pick, never guessed at. */
  candidates?: T[];
}

/**
 * The subset of a Census geocoder "geographies" response this module reads.
 * Mirrors the real API's field names (NAME, STUSAB) directly rather than
 * inventing new ones, so a caller can pass a real response's `geographies`
 * object through with minimal reshaping — see census.ts's fetch wrapper.
 */
export interface CensusGeographies {
  state: string; // 2-letter USPS code, e.g. "OH"
  incorporatedPlaces: string[];
  countySubdivisions: string[];
  counties: string[]; // e.g. "Franklin County" — Census's own suffixed form
}

function matchMICityByName(places: string[], checkDate: string): FieldMatch<MICityEntry> {
  const all = allMICities(checkDate);
  const candidates: MICityEntry[] = [];
  for (const place of places) {
    const stripped = stripPlaceTypeSuffix(place);
    const hit = all.find((c) => namesEqual(c.name, stripped));
    if (hit && !candidates.includes(hit)) candidates.push(hit);
  }
  if (candidates.length === 1) return { confidence: 'matched', entry: candidates[0] };
  if (candidates.length > 1) return { confidence: 'ambiguous', entry: null, candidates };
  return { confidence: 'no_match', entry: null };
}

function matchOHMunicipalityByName(
  places: string[],
  countySubdivisions: string[],
  checkDate: string,
): FieldMatch<OHMunicipalityEntry> {
  const all = allOHMunicipalities(checkDate);
  const candidateNames = [...places, ...countySubdivisions].map(stripPlaceTypeSuffix);
  const candidates: OHMunicipalityEntry[] = [];
  for (const name of candidateNames) {
    const hit = all.find((m) => namesEqual(m.name, name));
    if (hit && !candidates.includes(hit)) candidates.push(hit);
  }
  if (candidates.length === 1) return { confidence: 'matched', entry: candidates[0] };
  if (candidates.length > 1) return { confidence: 'ambiguous', entry: null, candidates };
  // Genuinely correct outcome for most Ohio addresses, not a failure: only
  // ~679 of Ohio's thousands of townships/unincorporated areas tax income.
  return { confidence: 'no_match', entry: null };
}

function matchCountyByName(
  stateCode: string,
  censusCounties: string[],
  checkDate: string,
): FieldMatch<CountyEntry> {
  const all = allCounties(stateCode, checkDate);
  const candidates: CountyEntry[] = [];
  for (const c of censusCounties) {
    const stripped = stripCountySuffix(c);
    const hit = all.find((e) => namesEqual(e.name, stripped));
    if (hit && !candidates.includes(hit)) candidates.push(hit);
  }
  if (candidates.length === 1) return { confidence: 'matched', entry: candidates[0] };
  if (candidates.length > 1) return { confidence: 'ambiguous', entry: null, candidates };
  return { confidence: 'no_match', entry: null };
}

/**
 * Pennsylvania's PSD codes are keyed by (county, municipality) together —
 * Census's "Abington township" alone isn't unique across PA's 67 counties,
 * so this requires BOTH a county match (against the county Census already
 * resolved from the same geocode) and a municipality-name match against
 * the PA-form-converted county-subdivision name.
 */
function matchPAJurisdiction(
  censusCounties: string[],
  countySubdivisions: string[],
  checkDate: string,
  censusSchoolDistrictName?: string,
): FieldMatch<PALocalEntry> {
  const all = allPALocalJurisdictions(checkDate);
  const countyNames = censusCounties.map((c) => stripCountySuffix(c).toUpperCase());
  const municipalityForms = countySubdivisions.map(toPAMunicipalityForm);

  const candidates: PALocalEntry[] = [];
  for (const entry of all) {
    const countyOk = countyNames.some((c) => namesEqual(c, entry.county));
    const muniOk = municipalityForms.some((m) => namesEqual(m, entry.municipality));
    if (countyOk && muniOk && !candidates.includes(entry)) candidates.push(entry);
  }
  if (candidates.length === 1) return { confidence: 'matched', entry: candidates[0] };

  // A PSD code is keyed on (municipality x SCHOOL DISTRICT), so a
  // municipality split across districts has several of them and county +
  // municipality alone genuinely cannot choose. Lancaster City is exactly
  // this: three PSDs (360399 Conestoga Valley, 360999 Lampeter-Strasburg,
  // 361001 Lancaster SD), and before this the whole address resolved to
  // NO PSD at all -- so PA local tax silently could not be computed from
  // an address there, which is how a Lancaster resident ended up taxed at
  // the 1.00% nonresident rate instead of their real 1.60%.
  //
  // The school district boundary IS published, and this project already
  // reads it at the resolved point for Ohio's SDIT. Reusing that name,
  // and Ohio's own key normalizer, picks the right PSD without guessing.
  // Deliberately only a TIE-BREAK: if the district name matches nothing,
  // or still matches several, the answer stays 'ambiguous' rather than
  // becoming a confident wrong PSD.
  if (candidates.length > 1 && censusSchoolDistrictName) {
    const wanted = schoolDistrictKeyFromCensusName(censusSchoolDistrictName);
    const byDistrict = candidates.filter((c) =>
      schoolDistrictKeysMatch(wanted, schoolDistrictKeyFromDataFileName(c.schoolDistrict)),
    );
    if (byDistrict.length === 1) return { confidence: 'matched', entry: byDistrict[0] };
  }

  if (candidates.length > 1) return { confidence: 'ambiguous', entry: null, candidates };
  return { confidence: 'no_match', entry: null };
}

/**
 * Ohio school district matching, given the district name TIGERweb's
 * identify operation returned at the resolved coordinates (see census.ts's
 * fetchSchoolDistrictAtPoint() — a SEPARATE Census service from the
 * geocoder, since school district boundaries aren't in the geocoder's own
 * "geographies" response). A non-match here is the common, CORRECT case:
 * only 214 of Ohio's 600+ school districts currently levy SDIT at all.
 */
function matchOHSchoolDistrictByName(
  censusSchoolDistrictName: string,
  checkDate: string,
): FieldMatch<OHSchoolDistrictEntry> {
  const key = schoolDistrictKeyFromCensusName(censusSchoolDistrictName);
  const all = allOHSchoolDistricts(checkDate);
  const candidates = all.filter((d) =>
    schoolDistrictKeysMatch(key, schoolDistrictKeyFromDataFileName(d.name)),
  );
  if (candidates.length === 1) return { confidence: 'matched', entry: candidates[0] };
  if (candidates.length > 1) return { confidence: 'ambiguous', entry: null, candidates };
  return { confidence: 'no_match', entry: null };
}

/**
 * Maryland's 23 counties + Baltimore City piggyback local income tax
 * (MDConfig.countyRates, inline in data/states/MD-2026.json — NOT a
 * separate data/local file the way IN/MI/OH/PA's locals are, since MD's
 * "local" tax is really a state-defined per-county rate table rather than
 * an independently-set municipal ordinance). Checks BOTH the Counties
 * layer (23 real counties) and Incorporated Places (Baltimore City sits
 * inside no county, so it only ever appears there) since which layer has
 * the answer depends on whether the address is inside a county or inside
 * the one county-equivalent independent city.
 */
function matchMDCounty(
  places: string[],
  counties: string[],
  checkDate: string,
): FieldMatch<string> {
  const rules = stateRuleset('MD', checkDate) as unknown as {
    countyRates?: Record<string, unknown>;
  };
  const keys = Object.keys(rules.countyRates ?? {}).filter((k) => !k.startsWith('$'));

  const candidates: string[] = [];
  for (const name of [...counties, ...places]) {
    const key = toMDCountyKey(name);
    if (keys.includes(key) && !candidates.includes(key)) candidates.push(key);
  }
  if (candidates.length === 1) return { confidence: 'matched', entry: candidates[0] };
  if (candidates.length > 1) return { confidence: 'ambiguous', entry: null, candidates };
  return { confidence: 'no_match', entry: null };
}

/** Alabama's municipal occupational tax list — same list-lookup shape as Michigan's/Ohio's cities. */
function matchALMunicipalityByName(
  places: string[],
  checkDate: string,
): FieldMatch<ALMunicipalityEntry> {
  const all = allALMunicipalities(checkDate);
  const candidates: ALMunicipalityEntry[] = [];
  for (const place of places) {
    const stripped = stripPlaceTypeSuffix(place);
    // Same alias check as alMunicipalityRuleset(): the source list spells
    // Hackleburg "Hacklebug" and keeps the real name on aliases.
    const hit = all.find(
      (c) =>
        namesEqual(c.name, stripped) ||
        (c.aliases ?? []).some((alias) => namesEqual(alias, stripped)),
    );
    if (hit && !candidates.includes(hit)) candidates.push(hit);
  }
  if (candidates.length === 1) return { confidence: 'matched', entry: candidates[0] };
  if (candidates.length > 1) return { confidence: 'ambiguous', entry: null, candidates };
  return { confidence: 'no_match', entry: null };
}

/**
 * Kentucky's CITY-role match — Incorporated Places against the 39
 * confirmed jurisdictions (including "Louisville" and "Lexington", which
 * are themselves literal entries in that confirmed set, no special-casing
 * needed the way Maryland's Baltimore City required).
 */
function matchKYCityByName(places: string[], checkDate: string): FieldMatch<KYJurisdictionEntry> {
  const all = allKYJurisdictions(checkDate);
  const candidates: KYJurisdictionEntry[] = [];
  for (const place of places) {
    const stripped = stripPlaceTypeSuffix(place);
    const hit = all.find((c) => namesEqual(c.name, stripped));
    if (hit && !candidates.includes(hit)) candidates.push(hit);
  }
  if (candidates.length === 1) return { confidence: 'matched', entry: candidates[0] };
  if (candidates.length > 1) return { confidence: 'ambiguous', entry: null, candidates };
  return { confidence: 'no_match', entry: null };
}

/**
 * Kentucky's COUNTY-role match — the Counties layer against the same
 * confirmed set, but via toKYCountyBaseName() rather than a plain
 * namesEqual: Kentucky's own confirmed entries mix "Caldwell County" and
 * "Martin County Fiscal Court" for the SAME kind of jurisdiction (general
 * county government), and deliberately excludes school-district-level
 * entries like "Cumberland County Public School District" from this
 * role — see toKYCountyBaseName()'s own doc comment for why conflating
 * those would misrepresent what's actually being charged.
 */
function matchKYCountyByName(
  counties: string[],
  checkDate: string,
): FieldMatch<KYJurisdictionEntry> {
  const all = allKYJurisdictions(checkDate);
  const censusBaseNames = counties
    .map((c) => stripCountySuffix(c))
    .filter((n): n is string => n.length > 0);

  const candidates: KYJurisdictionEntry[] = [];
  for (const entry of all) {
    const entryBase = toKYCountyBaseName(entry.name);
    if (entryBase === null) continue; // school-district-type entry, not a county-government match
    if (censusBaseNames.some((c) => namesEqual(c, entryBase)) && !candidates.includes(entry)) {
      candidates.push(entry);
    }
  }
  if (candidates.length === 1) return { confidence: 'matched', entry: candidates[0] };
  if (candidates.length > 1) return { confidence: 'ambiguous', entry: null, candidates };
  return { confidence: 'no_match', entry: null };
}

/** Whether a specific named place appears (after stripping Census's place-type suffix) among a list of Incorporated Places. */
function placesInclude(places: string[], name: string): boolean {
  return places.some((p) => namesEqual(stripPlaceTypeSuffix(p), name));
}

/** Which of several candidate place names (if any) appears among a list of Incorporated Places — for West Virginia's 6 service-fee cities, where the MATCHED NAME itself (not just a yes/no flag) is the certificate.locality value. */
function matchAnyPlace(places: string[], candidateNames: string[]): string | null {
  for (const name of candidateNames) {
    if (placesInclude(places, name)) return name;
  }
  return null;
}

/** Whether a specific named county appears (after stripping " County") among a list of Counties. */
function countiesInclude(counties: string[], name: string): boolean {
  return counties.some((c) => namesEqual(stripCountySuffix(c), name));
}

export interface ResolvedJurisdiction {
  state: string;
  miCity: FieldMatch<MICityEntry> | null;
  ohMunicipality: FieldMatch<OHMunicipalityEntry> | null;
  ohSchoolDistrict: FieldMatch<OHSchoolDistrictEntry> | null;
  county: FieldMatch<CountyEntry> | null;
  paJurisdiction: FieldMatch<PALocalEntry> | null;
  mdCounty: FieldMatch<string> | null;
  alMunicipality: FieldMatch<ALMunicipalityEntry> | null;
  /** Alabama's county-level occupational fee (Macon County only), work role. */
  alCounty: FieldMatch<ALCountyEntry> | null;
  /** City-role match only — see index.ts's resolveEmployee() for how this combines with kyCounty for the KRS 68.197 credit. */
  kyCity: FieldMatch<KYJurisdictionEntry> | null;
  /** County-role match only. */
  kyCounty: FieldMatch<KYJurisdictionEntry> | null;
  /** Whichever of Charleston/Huntington/Morgantown/Parkersburg/Wheeling/Weirton matched, if any — the matched NAME itself is the certificate.locality value westVirginiaMunicipalServiceFee() reads. */
  wvServiceFeeCity: string | null;
  /**
   * Whichever of Denver/Glendale/Greenwood Village/Sheridan/Aurora
   * matched, if any — the matched NAME itself is the certificate.locality
   * value coloradoOccupationalPrivilegeTax() reads. Found 2026-09-03: the
   * tax computation side already supported all five (Aurora kept for its
   * pre-2025-01-01 repeal date), but this resolver only ever set Denver —
   * the other four are plain Census incorporated places, no special
   * boundary needed, the same oversight class as Oregon's Sandy/
   * Wilsonville before those were added.
   */
  coOptCity: string | null;
  /**
   * Simple named-place/county flags this address's geography matches,
   * independent of role — the caller (see index.ts's resolveEmployee())
   * applies each one to whichever address role the underlying tax
   * actually keys off (verified against taxes/state.ts's own doc comments
   * for each: NYC/Yonkers-resident from the RESIDENCE address, Yonkers-
   * nonresident-worker/Newark/Multnomah from the WORK address, Kansas
   * City/St. Louis from EITHER — see resolveEmployee()'s own comments).
   * Portland's Metro SHS district and Oregon's TriMet/Lane Transit
   * District are deliberately NOT here: confirmed this session (via
   * TIGERweb's own layer listing) that Census has no boundary data for
   * any of the three at all — they are special districts/regional
   * government boundaries outside what these two free Census services can
   * resolve, not an oversight.
   */
  flags: {
    newYorkCity: boolean;
    yonkers: boolean;
    newark: boolean;
    kansasCity: boolean;
    stLouis: boolean;
    multnomahCounty: boolean;
    wilmington: boolean;
    /**
     * Seattle's JumpStart payroll expense tax gate (certificate.locality
     * === 'Seattle'). Like Denver's, the address is only half the answer:
     * the tax bands by the EMPLOYER's prior-year Seattle payroll and by
     * each employee's own annual compensation, so
     * input.employer.seattlePriorYearPayrollExpense and
     * input.ytd.seattleCompensation still have to come from the caller.
     * Setting the locality is what makes those inputs reachable at all.
     */
    seattle: boolean;
    /**
     * Sandy's and Wilsonville's (SMART) local transit payroll excises —
     * certificate.locality 'SandyTransit'/'SMART'. Unlike TriMet/LTD/SCTD
     * (special districts with their own non-Census boundaries — see
     * districts.ts), each of these two IS simply its own city limits,
     * confirmed directly against each city's own transit-tax guide, so
     * ordinary Census incorporated-place matching resolves them.
     */
    sandy: boolean;
    wilsonville: boolean;
  };
}

/**
 * Resolve one address's geography (already fetched) against every local
 * registry this project currently has wired to calc code. Only attempts
 * the match(es) relevant to the resolved state — e.g. a Texas address
 * never runs the Ohio municipality matcher — since every other state's
 * "local" concept doesn't exist here and running it would just produce a
 * meaningless no_match rather than an informative skip.
 */
export function resolveJurisdiction(
  geo: CensusGeographies,
  checkDate: string,
  ohSchoolDistrictName?: string,
): ResolvedJurisdiction {
  const state = geo.state.toUpperCase();
  const result: ResolvedJurisdiction = {
    state,
    miCity: null,
    ohMunicipality: null,
    ohSchoolDistrict: null,
    county: null,
    paJurisdiction: null,
    mdCounty: null,
    alMunicipality: null,
    alCounty: null,
    kyCity: null,
    kyCounty: null,
    wvServiceFeeCity: null,
    coOptCity: null,
    flags: {
      newYorkCity: false,
      yonkers: false,
      newark: false,
      kansasCity: false,
      stLouis: false,
      multnomahCounty: false,
      seattle: false,
      wilmington: false,
      sandy: false,
      wilsonville: false,
    },
  };

  if (state === 'MI') {
    result.miCity = matchMICityByName(geo.incorporatedPlaces, checkDate);
  }
  if (state === 'OH') {
    result.ohMunicipality = matchOHMunicipalityByName(
      geo.incorporatedPlaces,
      geo.countySubdivisions,
      checkDate,
    );
    if (ohSchoolDistrictName) {
      result.ohSchoolDistrict = matchOHSchoolDistrictByName(ohSchoolDistrictName, checkDate);
    }
  }
  if (state === 'IN') {
    result.county = matchCountyByName('IN', geo.counties, checkDate);
  }
  if (state === 'PA') {
    result.paJurisdiction = matchPAJurisdiction(geo.counties, geo.countySubdivisions, checkDate, ohSchoolDistrictName);
  }
  if (state === 'MD') {
    result.mdCounty = matchMDCounty(geo.incorporatedPlaces, geo.counties, checkDate);
  }
  if (state === 'NY') {
    result.flags.newYorkCity = placesInclude(geo.incorporatedPlaces, 'New York');
    result.flags.yonkers = placesInclude(geo.incorporatedPlaces, 'Yonkers');
  }
  if (state === 'NJ') {
    result.flags.newark = placesInclude(geo.incorporatedPlaces, 'Newark');
  }
  if (state === 'MO') {
    result.flags.kansasCity = placesInclude(geo.incorporatedPlaces, 'Kansas City');
    result.flags.stLouis = placesInclude(geo.incorporatedPlaces, 'St. Louis');
  }
  if (state === 'OR') {
    result.flags.multnomahCounty = countiesInclude(geo.counties, 'Multnomah');
    result.flags.sandy = placesInclude(geo.incorporatedPlaces, 'Sandy');
    result.flags.wilsonville = placesInclude(geo.incorporatedPlaces, 'Wilsonville');
  }
  if (state === 'AL') {
    result.alMunicipality = matchALMunicipalityByName(geo.incorporatedPlaces, checkDate);
    const alCounty = allALCounties(checkDate).find((c) => countiesInclude(geo.counties, c.name));
    result.alCounty = alCounty ? { confidence: 'matched', entry: alCounty } : { confidence: 'no_match', entry: null };
  }
  if (state === 'KY') {
    result.kyCity = matchKYCityByName(geo.incorporatedPlaces, checkDate);
    result.kyCounty = matchKYCountyByName(geo.counties, checkDate);
  }
  if (state === 'WV') {
    result.wvServiceFeeCity = matchAnyPlace(geo.incorporatedPlaces, [
      'Charleston',
      'Huntington',
      'Morgantown',
      'Parkersburg',
      'Wheeling',
      'Weirton',
    ]);
  }
  if (state === 'CO') {
    result.coOptCity = matchAnyPlace(geo.incorporatedPlaces, ['Denver', 'Glendale', 'Greenwood Village', 'Sheridan', 'Aurora']);
  }
  if (state === 'DE') {
    result.flags.wilmington = placesInclude(geo.incorporatedPlaces, 'Wilmington');
  }
  if (state === 'WA') {
    result.flags.seattle = placesInclude(geo.incorporatedPlaces, 'Seattle');
  }

  return result;
}

/**
 * Convert a resolved jurisdiction into the exact certificate field names
 * taxes/state.ts already reads (certificate.workCity, .county, .workPSD,
 * .schoolDistrictCode — see ohioLocalTax(), michiganLocalTax(),
 * flatRateMultiExemption() for Indiana, pennsylvaniaLocalTax()). Only
 * includes a field when its match was unambiguous ('matched') — an
 * 'ambiguous' or 'no_match' result is surfaced by the caller (see
 * ResolvedJurisdiction itself) for a human to resolve, never silently
 * guessed into a certificate field that would then silently drive real
 * withholding.
 */
export function toCertificateFields(
  resolved: ResolvedJurisdiction,
  role: 'work' | 'residence',
): Partial<StateCertificate> {
  const fields: Partial<StateCertificate> = {};

  if (resolved.miCity?.confidence === 'matched' && resolved.miCity.entry) {
    fields[role === 'work' ? 'workCity' : 'residenceCity'] = resolved.miCity.entry.name;
  }
  if (resolved.ohMunicipality?.confidence === 'matched' && resolved.ohMunicipality.entry) {
    fields[role === 'work' ? 'workCity' : 'residenceCity'] = resolved.ohMunicipality.entry.name;
  }
  if (resolved.ohSchoolDistrict?.confidence === 'matched' && resolved.ohSchoolDistrict.entry) {
    fields.schoolDistrictCode = resolved.ohSchoolDistrict.entry.sdNumber;
  }
  if (resolved.county?.confidence === 'matched' && resolved.county.entry) {
    fields.county = resolved.county.entry.name;
  }
  if (resolved.paJurisdiction?.confidence === 'matched' && resolved.paJurisdiction.entry) {
    fields[role === 'work' ? 'workPSD' : 'residencePSD'] = resolved.paJurisdiction.entry.psdCode;
  }
  if (resolved.mdCounty?.confidence === 'matched' && resolved.mdCounty.entry) {
    fields.county = resolved.mdCounty.entry;
  }
  if (resolved.alMunicipality?.confidence === 'matched' && resolved.alMunicipality.entry) {
    fields[role === 'work' ? 'workCity' : 'residenceCity'] = resolved.alMunicipality.entry.name;
  }
  if (resolved.kyCity?.confidence === 'matched' && resolved.kyCity.entry) {
    fields[role === 'work' ? 'workCity' : 'residenceCity'] = resolved.kyCity.entry.name;
  }
  // Alabama's Macon County fee is work-location-based too.
  if (role === 'work' && resolved.alCounty?.confidence === 'matched' && resolved.alCounty.entry) {
    fields.workCounty = resolved.alCounty.entry.name;
  }
  // Kentucky's work county drives the KRS 68.197 credit; the residence
  // county matters only for Louisville Metro, whose resident rate applies
  // to anyone living in Jefferson County.
  if (resolved.kyCounty?.confidence === 'matched' && resolved.kyCounty.entry) {
    fields[role === 'work' ? 'workCounty' : 'residenceCounty'] = resolved.kyCounty.entry.name;
  }

  return fields;
}
