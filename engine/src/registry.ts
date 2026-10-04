import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const DATA_ROOT = join(import.meta.dirname, '..', 'data');

const datedCache = new Map<string, StateRuleset>();
const cache = new Map<string, unknown>();

/**
 * Reads one data file's raw text, or returns undefined if it doesn't
 * exist. Defaults to real Node filesystem access (every existing
 * consumer — the test suite, examples/, the CLI tools). Swappable via
 * setDataReader() for runtimes with no filesystem at all, e.g. a
 * Supabase Edge Function (Deno, sandboxed) serving this engine as an API:
 * there, main.ts calls setDataReader() once at startup with a reader
 * backed by a build-time-bundled object instead of node:fs, and every
 * other file in src/ — already written with explicit .ts import
 * extensions throughout, which happens to be exactly what Deno's own
 * module resolution requires — runs completely unmodified.
 */
export type DataReader = (relPath: string) => string | undefined;

let dataReader: DataReader = (relPath) => {
  const full = join(DATA_ROOT, relPath);
  return existsSync(full) ? readFileSync(full, 'utf8') : undefined;
};

export function setDataReader(reader: DataReader): void {
  dataReader = reader;
  cache.clear();
  datedCache.clear();
}

/**
 * Whether a data file exists, routed through the SAME swappable dataReader
 * loadJson() uses — every hasXRuleset() below used to call node:fs's
 * existsSync() directly against DATA_ROOT instead, which happened to work
 * under the real filesystem but always returned false under a swapped
 * reader (e.g. the Edge Function's build-time bundled object, which has no
 * filesystem at all): the file was genuinely present in the bundle, but
 * the existence CHECK never looked there, so callers like calculatePaycheck
 * silently believed a state's own ruleset didn't exist. Routing through
 * the same reader as the actual load guarantees the two can never disagree
 * again.
 */
function dataFileExists(relPath: string): boolean {
  return dataReader(relPath.replace(/\\/g, '/')) !== undefined;
}

function loadJson<T>(relPath: string): T {
  const cached = cache.get(relPath);
  if (cached !== undefined) return cached as T;

  // Normalized to forward slashes regardless of host OS (join() on
  // Windows produces backslashes) so a bundled-object reader keyed by a
  // fixed forward-slash convention matches reliably on every platform.
  const key = relPath.replace(/\\/g, '/');
  const raw = dataReader(key);
  if (raw === undefined) {
    throw new RulesetNotFoundError(relPath);
  }
  const parsed = JSON.parse(raw) as T;
  cache.set(relPath, parsed);
  return parsed;
}

export class RulesetNotFoundError extends Error {
  readonly relPath: string;

  constructor(relPath: string) {
    super(
      `No ruleset at data/${relPath}. Rates are data, not code: add the file ` +
        `(with its source URL and verifiedOn date) rather than hardcoding a rate.`,
    );
    this.name = 'RulesetNotFoundError';
    this.relPath = relPath;
  }
}

/**
 * Resolve the tax year from a check date.
 *
 * Deliberately derived from the check date and never from the clock: a
 * correction run in March for a December check must use December's rules.
 */
export function yearOf(checkDate: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(checkDate);
  if (!m) throw new Error(`checkDate must be ISO yyyy-mm-dd, got: ${checkDate}`);
  return Number(m[1]);
}

export interface Bracket {
  from: number;
  to: number | null;
  base: number;
  rate: number;
}

export interface FederalRuleset {
  year: number;
  sources: { id: string; title: string; url: string; verifiedOn: string }[];
  incomeTax: {
    step1StandardAdjustment: { married_joint: number; other: number };
    supplementalRate: number;
    supplementalMandatoryRate: number;
    supplementalMandatoryThreshold: number;
    standardSchedules: Record<string, Bracket[]>;
    multipleJobsSchedules: Record<string, Bracket[]>;
    exemptPretax: string[];
    nonresidentAlienAdjustment: Record<string, number>;
  };
  socialSecurity: {
    employeeRate: number;
    employerRate: number;
    wageBase: number;
    exemptPretax: string[];
  };
  medicare: {
    employeeRate: number;
    employerRate: number;
    wageBase: number | null;
    additional: { rate: number; threshold: number; employeeOnly: boolean };
    exemptPretax: string[];
  };
  futa: {
    netRate: number;
    wageBase: number;
    exemptPretax: string[];
  };
  /**
   * IRC annual elective-deferral limits, in dollars — the ceiling on how
   * much of a 401(k)/403(b)/457(b)/SIMPLE deduction can actually be
   * pretax-exempt this calendar year, not just how much a plan lets an
   * employee defer. See capElectiveDeferrals() in wages.ts for how these
   * are applied (standard limits only — no catch-up, see that function's
   * own doc comment for why).
   */
  electiveDeferralLimits: {
    /** 401(k) and 403(b) share ONE combined IRC 402(g) limit. */
    section402gAggregate: number;
    /** A governmental/tax-exempt 457(b) plan's OWN separate limit — not aggregated with 401(k)/403(b). */
    deferral457: number;
    /** A SIMPLE plan's own separate, lower limit (IRC 408(p)/401(k) SIMPLE). */
    simple: number;
  };
  /** Household / agricultural / election-worker coverage thresholds — shaped and read in taxes/federal.ts. */
  employmentCategories?: unknown;
  /** Railroad Tier II and RUIA parameters — shaped and read in taxes/federal.ts. */
  railroadRetirement?: unknown;
}

export function federalRuleset(checkDate: string): FederalRuleset {
  return loadJson<FederalRuleset>(join('federal', `${yearOf(checkDate)}.json`));
}

export interface StateRuleset {
  code: string;
  name: string;
  year: number;
  method: string;
  sources: { title: string; url: string; verifiedOn: string }[];
  [key: string]: unknown;
}

/**
 * A mid-year change inside one year's file: from `from` (a check date,
 * inclusive) each dotted path in `set` takes the new value. Used where a
 * state reissued its tables part-way through a year (Idaho's May 2025 rate
 * cut, Utah's June 2025 tables) and the method has no dated switch of its own.
 */
interface EffectiveDatedChange {
  from: string;
  set: Record<string, unknown>;
  note?: string;
}

function applyEffectiveDated(base: StateRuleset, checkDate: string): StateRuleset {
  const changes = (base.effectiveDated as EffectiveDatedChange[] | undefined) ?? [];
  const due = changes.filter((c) => c.from <= checkDate).sort((a, b) => a.from.localeCompare(b.from));
  if (due.length === 0) return base;
  const key = `${base.code}-${base.year}@${due.at(-1)!.from}`;
  const hit = datedCache.get(key);
  if (hit) return hit;
  const out = structuredClone(base) as Record<string, unknown>;
  for (const change of due) {
    for (const [path, value] of Object.entries(change.set)) {
      const parts = path.split('.');
      let node = out as Record<string, unknown>;
      for (const part of parts.slice(0, -1)) {
        if (typeof node[part] !== 'object' || node[part] === null) {
          throw new Error(`effectiveDated path ${path} does not exist in ${base.code}-${base.year}.json`);
        }
        node = node[part] as Record<string, unknown>;
      }
      node[parts.at(-1)!] = structuredClone(value);
    }
  }
  datedCache.set(key, out as StateRuleset);
  return out as StateRuleset;
}

export function stateRuleset(code: string, checkDate: string): StateRuleset {
  const base = loadJson<StateRuleset>(
    join('states', `${code.toUpperCase()}-${yearOf(checkDate)}.json`),
  );
  return base.effectiveDated ? applyEffectiveDated(base, checkDate) : base;
}

export function hasStateRuleset(code: string, checkDate: string): boolean {
  return dataFileExists(join('states', `${code.toUpperCase()}-${yearOf(checkDate)}.json`));
}

export function hasFederalRuleset(checkDate: string): boolean {
  return dataFileExists(join('federal', `${yearOf(checkDate)}.json`));
}

/** The 50 states plus DC -- the codes a state ruleset can exist for. */
export const STATE_CODES = [
  'AL', 'AK', 'AZ', 'AR', 'CA', 'CO', 'CT', 'DE', 'DC', 'FL', 'GA', 'HI', 'ID', 'IL', 'IN', 'IA', 'KS',
  'KY', 'LA', 'ME', 'MD', 'MA', 'MI', 'MN', 'MS', 'MO', 'MT', 'NE', 'NV', 'NH', 'NJ', 'NM', 'NY', 'NC',
  'ND', 'OH', 'OK', 'OR', 'PA', 'RI', 'SC', 'SD', 'TN', 'TX', 'UT', 'VT', 'VA', 'WA', 'WV', 'WI', 'WY',
] as const;

/** The states with a ruleset for this check date's tax year. */
export function statesWithRuleset(checkDate: string): string[] {
  return STATE_CODES.filter((c) => hasStateRuleset(c, checkDate));
}

/**
 * Thrown when a tax rule refuses to compute because the agency publishes no
 * method for this input (for example a pay frequency its tables skip). The
 * message names the agency source and is written for the caller to read;
 * the engine refuses rather than guess a number.
 */
export class CannotComputeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CannotComputeError';
  }
}

/**
 * Thrown when a check date falls in a tax year this build only partly
 * covers: the federal rules or a work/residence state's rules for that year
 * are missing. Computing anyway would return federal-only withholding that
 * looks complete, so the engine refuses instead.
 */
export class UnsupportedTaxYearError extends Error {
  readonly year: number;
  readonly missing: string[];
  constructor(year: number, missing: string[], coveredStates: string[]) {
    super(
      `Tax year ${year} is not fully available for this paycheck: no ${year} rules for ${missing.join(' or ')}. ` +
        (coveredStates.length
          ? `${year} is available for federal tax and ${coveredStates.join(', ')} only.`
          : `There are no ${year} rules in this build.`),
    );
    this.name = 'UnsupportedTaxYearError';
    this.year = year;
    this.missing = missing;
  }
}

/**
 * Throws UnsupportedTaxYearError unless the federal rules and every state
 * this paycheck touches have a ruleset for the check date's year. A state
 * code that has no ruleset in ANY year is left to the engine's own
 * "NOT MODELLED" line; this guards only against a real state missing a year.
 */
export function assertTaxYearCovered(checkDate: string, stateCodes: (string | undefined)[]): void {
  const year = yearOf(checkDate);
  const missing: string[] = [];
  if (!hasFederalRuleset(checkDate)) missing.push('federal tax');
  for (const code of new Set(stateCodes.filter((c): c is string => Boolean(c)).map((c) => c.toUpperCase()))) {
    if ((STATE_CODES as readonly string[]).includes(code) && !hasStateRuleset(code, checkDate)) missing.push(code);
  }
  if (missing.length) throw new UnsupportedTaxYearError(year, missing, statesWithRuleset(checkDate));
}

export interface CountyEntry {
  name: string;
  countyCode: string;
  rate: number;
  changedSinceOct2025?: boolean;
  /**
   * Changes part-way through the file's year: from `on` (a check date,
   * inclusive) the county's rate is `rate`. Indiana's Departmental Notice
   * is reissued each 1 Jan and 1 Oct. The latest change on or before the
   * check date wins.
   */
  rateChanges?: { on: string; rate: number }[];
}

function countyEntryOn(raw: CountyEntry, checkDate: string): CountyEntry {
  const due = (raw.rateChanges ?? []).filter((c) => c.on <= checkDate).sort((a, b) => a.on.localeCompare(b.on));
  const last = due[due.length - 1];
  return last ? { ...raw, rate: last.rate } : raw;
}

interface CountyRegistryFile {
  year: number;
  counties: CountyEntry[];
}

/**
 * Whether a mandatory county-level registry exists for this state/year — e.g.
 * Indiana, where every address falls inside exactly one of 92 counties (no
 * closed-list-with-a-zero-case the way Michigan's 24 cities work).
 */
export function hasCountyRuleset(stateCode: string, checkDate: string): boolean {
  return dataFileExists(
    join('local', `${stateCode.toUpperCase()}-counties-${yearOf(checkDate)}.json`),
  );
}

/**
 * Look up one county's rate by name (case-insensitive). Returns undefined
 * for an unrecognised name rather than throwing — the caller decides how to
 * surface that (see taxes/state.ts's handling of a missing/unknown county).
 */
export function countyRuleset(
  stateCode: string,
  countyName: string,
  checkDate: string,
): CountyEntry | undefined {
  const file = loadJson<CountyRegistryFile>(
    join('local', `${stateCode.toUpperCase()}-counties-${yearOf(checkDate)}.json`),
  );
  const found = file.counties.find(
    (c) => c.name.toLowerCase() === countyName.toLowerCase(),
  );
  return found && countyEntryOn(found, checkDate);
}

/**
 * Every county in one state's registry — for a caller that needs to search
 * (e.g. geocode/'s fuzzy name matching) rather than look up an exact known
 * name the way countyRuleset() does.
 */
export function allCounties(stateCode: string, checkDate: string): CountyEntry[] {
  const file = loadJson<CountyRegistryFile>(
    join('local', `${stateCode.toUpperCase()}-counties-${yearOf(checkDate)}.json`),
  );
  return file.counties.map((c) => countyEntryOn(c, checkDate));
}

export interface PALocalEntry {
  psdCode: string;
  county: string;
  municipality: string;
  schoolDistrict: string;
  residentEIT: number;
  nonresidentEIT: number;
  schoolDistrictEIT: number;
  totalResidentEIT: number;
  /** Act 511/319's own EIT low-income exemption threshold (estimated annual earned income) for this jurisdiction's MUNICIPAL EIT portion — below it, that portion (residentEIT on a resident's own entry, nonresidentEIT on a work entry) is exempt entirely. Present on only 49 of 2,627 entries; absent means no municipal EIT exemption ordinance is on file for this PSD. */
  municipalEitLIE?: number;
  /** Same mechanism as municipalEitLIE, but for the SCHOOL DISTRICT's own EIT portion (schoolDistrictEIT) — only ever relevant on a RESIDENT's own entry, since school district EIT is levied on residents, not nonresidents. */
  schoolDistrictEitLIE?: number;
  lst?: {
    municipal: number;
    schoolDistrict: number;
    total: number;
    lowIncomeExemption?: { municipal: number; schoolDistrict: number };
  };
}

interface PALocalRegistryFile {
  year: number;
  jurisdictions: (PALocalEntry & { rateChanges?: PARateChange[] })[];
}

/**
 * A change part-way through the register's year: from `on` (a check date,
 * inclusive) the listed fields take these values. Philadelphia resets its
 * wage tax every 1 July; school districts change on 1 July too.
 */
interface PARateChange {
  on: string;
  set: Partial<Pick<PALocalEntry, 'residentEIT' | 'nonresidentEIT' | 'schoolDistrictEIT' | 'totalResidentEIT' | 'lst'>>;
}

function paEntryOn(
  raw: PALocalEntry & { rateChanges?: PARateChange[] },
  checkDate: string,
): PALocalEntry {
  const due = (raw.rateChanges ?? []).filter((c) => c.on <= checkDate).sort((a, b) => a.on.localeCompare(b.on));
  if (due.length === 0) return raw;
  const out: PALocalEntry & { rateChanges?: PARateChange[] } = { ...raw };
  for (const c of due) Object.assign(out, c.set);
  if (due.some((c) => c.set.totalResidentEIT === undefined && (c.set.residentEIT !== undefined || c.set.schoolDistrictEIT !== undefined))) {
    out.totalResidentEIT = Math.round((out.residentEIT + out.schoolDistrictEIT) * 1e6) / 1e6;
  }
  return out;
}

/** Whether a PA Act 32 local (EIT/LST) registry exists for this check date. */
export function hasPALocalRuleset(checkDate: string): boolean {
  return dataFileExists(join('local', `PA-EIT-LST-${yearOf(checkDate)}.json`));
}

/**
 * Look up one PSD (Political Subdivision) code's EIT/LST rates. Returns
 * undefined for an unrecognised code — same convention as countyRuleset(),
 * the caller (taxes/state.ts) decides how to surface that.
 */
export function paLocalRuleset(
  psdCode: string,
  checkDate: string,
): PALocalEntry | undefined {
  const file = loadJson<PALocalRegistryFile>(
    join('local', `PA-EIT-LST-${yearOf(checkDate)}.json`),
  );
  const raw = file.jurisdictions.find((j) => j.psdCode === psdCode);
  return raw && paEntryOn(raw, checkDate);
}

/** Every PA Act 32 jurisdiction — for geocode/'s county+municipality search. */
export function allPALocalJurisdictions(checkDate: string): PALocalEntry[] {
  const file = loadJson<PALocalRegistryFile>(
    join('local', `PA-EIT-LST-${yearOf(checkDate)}.json`),
  );
  return file.jurisdictions.some((j) => j.rateChanges)
    ? file.jurisdictions.map((j) => paEntryOn(j, checkDate))
    : file.jurisdictions;
}

export interface MICityEntry {
  name: string;
  residentRate: number;
  nonresidentRate: number;
  exemptionAmount: number;
}

interface MICityRegistryFile {
  year: number;
  cities: MICityEntry[];
}

/** Whether a Michigan local city-income-tax registry exists for this check date. */
export function hasMICityRuleset(checkDate: string): boolean {
  return dataFileExists(join('local', `MI-cities-${yearOf(checkDate)}.json`));
}

/**
 * Look up one Michigan city's rates by name (case-insensitive) — same
 * "closed list, undefined for an unrecognised name" convention as
 * countyRuleset()/paLocalRuleset(). An undefined return here is the
 * CORRECT signal for "not one of the 24 taxing cities," not a data gap —
 * see MI-cities-2026.json's own localTaxScope: any address not in the
 * list owes $0 by the same closed-list authority (Act 284).
 */
export function miCityRuleset(
  cityName: string,
  checkDate: string,
): MICityEntry | undefined {
  const file = loadJson<MICityRegistryFile>(
    join('local', `MI-cities-${yearOf(checkDate)}.json`),
  );
  return file.cities.find((c) => c.name.toLowerCase() === cityName.toLowerCase());
}

/** Every Michigan taxing city — for geocode/'s fuzzy name matching. */
export function allMICities(checkDate: string): MICityEntry[] {
  const file = loadJson<MICityRegistryFile>(
    join('local', `MI-cities-${yearOf(checkDate)}.json`),
  );
  return file.cities;
}

export interface KYJurisdictionEntry {
  name: string;
  /** Flat rate applying regardless of residency. Null when this jurisdiction instead uses a resident/nonresident split (see the two fields below). */
  wageRateDecimal: number | null;
  wageRateResidentDecimal: number | null;
  wageRateNonresidentDecimal: number | null;
  /** KRS 68.197(10)(c)'s SS-wage-base-cap variant — Walton and Florence are the two confirmed real-world users. When true, this jurisdiction's taxable base stops accruing once YTD wages reach the federal Social Security wage base, the same cap FICA itself uses. */
  capAtSSWageBase: boolean;
  /** Dollars of wages taxed per employee per year, for a city whose ordinance sets a maximum (Bardwell: $1,000 of tax at 1% = $100,000). YTD wages come in under ytd.localIncomeTax['KY_LOCAL_<name>'], the same tracker capAtSSWageBase uses. */
  annualWageCap?: number;
  /** How the wage rate was established (the data file's wageRateStatus), e.g. 'inferred_small_city_single_rate_pattern'. Absent for the consolidated governments. */
  wageRateStatus?: string;
}

interface KYOccupationalRegistryFile {
  jurisdictions: {
    scraped: Record<
      string,
      {
        name: string;
        wageRateDecimal?: number | null;
        wageRateResidentDecimal?: number | null;
        wageRateNonresidentDecimal?: number | null;
        capAtSSWageBase?: boolean;
        annualWageCap?: number;
        wageRateStatus?: string;
        /** Mid-year rate changes: from `on` (a check date, inclusive) the flat rate is `wageRateDecimal`. A rate of 0 means no wage tax yet. */
        rateChanges?: { on: string; wageRateDecimal: number }[];
      }
    >;
    louisvilleMetro: { residentRate: number; nonresidentRate: number; citiesWithinMetro?: string[] };
    lexingtonFayette: { residentRate: number; nonresidentRate: number };
  };
}

/** Whether a Kentucky occupational tax registry exists for this check date. */
export function hasKYOccupationalRuleset(checkDate: string): boolean {
  return dataFileExists(join('local', `KY-occupational-${yearOf(checkDate)}.json`));
}

/**
 * Every Kentucky city/county/consolidated-government jurisdiction that has
 * a CONFIRMED wage-withholding rate — as of 2026-08-31, 250 entries (248
 * from the scraped 250 + Louisville Metro + Lexington-Fayette), the
 * overwhelming majority cross-checked against the Kentucky League of
 * Cities' own official statewide FY2023 occupational tax survey (a
 * dedicated Payroll Tax Rate column — see that file's own knownGaps for
 * the corrections it caught). Only 2 scraped entries are deliberately
 * EXCLUDED, and both are understood rather than unresolved — see
 * data/local/KY-occupational-<year>.json's own jurisdictions.coverage
 * field for which two and why. This count has moved several times before
 * settling here — verify against that file and allKYJurisdictions()'s own
 * runtime output before citing it again regardless.
 */
export function allKYJurisdictions(checkDate: string): KYJurisdictionEntry[] {
  const file = loadJson<KYOccupationalRegistryFile>(
    join('local', `KY-occupational-${yearOf(checkDate)}.json`),
  );
  const entries: KYJurisdictionEntry[] = [];

  for (const raw of Object.values(file.jurisdictions.scraped)) {
    // The flat rate in force on this check date: the latest change on or
    // before it, else the base rate (Elsmere 1.25% -> 1.75% and Grant
    // County 2.5% -> 2.0% on 2026-07-01; Falmouth's tax starts that day).
    const change = (raw.rateChanges ?? [])
      .filter((c) => c.on <= checkDate)
      .sort((a, b) => a.on.localeCompare(b.on))
      .at(-1);
    const flatRate = change ? change.wageRateDecimal : raw.wageRateDecimal;
    if (flatRate === 0) continue;
    const hasFlat = flatRate !== null && flatRate !== undefined;
    const hasSplit =
      raw.wageRateResidentDecimal !== null &&
      raw.wageRateResidentDecimal !== undefined &&
      raw.wageRateNonresidentDecimal !== null &&
      raw.wageRateNonresidentDecimal !== undefined;
    if (!hasFlat && !hasSplit) continue;
    entries.push({
      name: raw.name,
      wageRateDecimal: hasFlat ? (flatRate as number) : null,
      wageRateResidentDecimal: hasSplit ? (raw.wageRateResidentDecimal as number) : null,
      wageRateNonresidentDecimal: hasSplit ? (raw.wageRateNonresidentDecimal as number) : null,
      capAtSSWageBase: raw.capAtSSWageBase ?? false,
      ...(raw.annualWageCap !== undefined ? { annualWageCap: raw.annualWageCap } : {}),
      ...(raw.wageRateStatus ? { wageRateStatus: raw.wageRateStatus } : {}),
    });
  }

  entries.push({
    name: 'Louisville',
    wageRateDecimal: null,
    wageRateResidentDecimal: file.jurisdictions.louisvilleMetro.residentRate,
    wageRateNonresidentDecimal: file.jurisdictions.louisvilleMetro.nonresidentRate,
    capAtSSWageBase: false,
  });
  entries.push({
    name: 'Lexington',
    wageRateDecimal: null,
    wageRateResidentDecimal: file.jurisdictions.lexingtonFayette.residentRate,
    wageRateNonresidentDecimal: file.jurisdictions.lexingtonFayette.nonresidentRate,
    capAtSSWageBase: false,
  });

  return entries;
}

/**
 * Louisville/Jefferson County Metro: its resident/nonresident rates and the
 * 83 cities inside it. Metro's tax applies to work anywhere in the county;
 * a city's own tax is owed on top, with no credit (KRS 68.197's credit is
 * for 30,000-300,000-population counties only).
 */
export function kyLouisvilleMetro(checkDate: string): { residentRate: number; nonresidentRate: number; cities: string[] } {
  const file = loadJson<KYOccupationalRegistryFile>(
    join('local', `KY-occupational-${yearOf(checkDate)}.json`),
  );
  const m = file.jurisdictions.louisvilleMetro;
  return { residentRate: m.residentRate, nonresidentRate: m.nonresidentRate, cities: m.citiesWithinMetro ?? [] };
}

/** Look up one Kentucky jurisdiction by name (case-insensitive) among the confirmed-rate set — see allKYJurisdictions()'s own doc comment for what "confirmed" means here. */
export function kyJurisdictionRuleset(
  name: string,
  checkDate: string,
): KYJurisdictionEntry | undefined {
  return allKYJurisdictions(checkDate).find((e) => e.name.toLowerCase() === name.toLowerCase());
}

export interface ALMunicipalityEntry {
  name: string;
  rate: number;
  /**
   * Other spellings that resolve to this same municipality. Exists because
   * the source list is a survey and a survey can misspell its own members:
   * ALM prints "Hacklebug" for what is certainly Hackleburg, the Marion
   * County town sitting among the other Marion County entries on the same
   * list. The entry keeps the source's spelling as its canonical name — this
   * project quotes ALM rather than silently correcting it — and carries the
   * real one here, so a caller who spells the town the way the world spells
   * it still gets the 1% instead of a silent no-tax result.
   */
  aliases?: string[];
  /**
   * Where the rate was read. primary_source: the levying body's own
   * ordinance/form/page, the collecting agent's current return, or statute.
   * league_survey_only: only the Alabama League of Municipalities' survey.
   * conflicting_sources: the city's own form and the survey disagree; the
   * city's figure is used and `conflict` says how.
   */
  confirmation?: {
    tier: 'primary_source' | 'league_survey_only' | 'conflicting_sources';
    conflict?: string;
  };
  /**
   * Dated rates, oldest first: the latest entry whose `from` is on or
   * before the check date sets `rate` (Opelika's 1.5% ran to 2025-03-31).
   */
  rateHistory?: { from: string; rate: number }[];
}

/**
 * A county-level Alabama occupational fee (today only Macon County, Ala.
 * Code 45-44-244.31). It applies only outside the towns that already had
 * their own occupational tax on the statute's cutoff date, listed here as
 * excludedMunicipalities.
 */
export interface ALCountyEntry {
  name: string;
  rate: number;
  statute: string;
  excludedMunicipalities: { name: string; basis: string }[];
}

interface ALMunicipalityRegistryFile {
  year: number;
  municipalities: ALMunicipalityEntry[];
  counties?: ALCountyEntry[];
}

/** Whether an Alabama municipal occupational tax registry exists for this check date. */
export function hasALMunicipalityRuleset(checkDate: string): boolean {
  return dataFileExists(join('local', `AL-municipalities-${yearOf(checkDate)}.json`));
}

/**
 * Look up one Alabama municipality's occupational tax rate by name
 * (case-insensitive) — same closed-list convention as every other local
 * lookup in this file. Unlike Ohio, Alabama's occupational tax is
 * WORK-location-only (no confirmed residence-based component was found),
 * so there is only ever one role to resolve, not a resident/nonresident
 * or home/work pair.
 */
export function alMunicipalityRuleset(
  name: string,
  checkDate: string,
): ALMunicipalityEntry | undefined {
  const file = loadJson<ALMunicipalityRegistryFile>(
    join('local', `AL-municipalities-${yearOf(checkDate)}.json`),
  );
  const wanted = name.trim().toLowerCase();
  const entry = file.municipalities.find(
    (m) =>
      m.name.toLowerCase() === wanted ||
      (m.aliases ?? []).some((alias) => alias.toLowerCase() === wanted),
  );
  const dated = entry?.rateHistory?.filter((h) => h.from <= checkDate).at(-1);
  return entry && dated && dated.rate !== entry.rate ? { ...entry, rate: dated.rate } : entry;
}

/**
 * Look up an Alabama county-level occupational fee by county name
 * (case-insensitive; a trailing " County" is ignored).
 */
export function alCountyRuleset(name: string, checkDate: string): ALCountyEntry | undefined {
  const file = loadJson<ALMunicipalityRegistryFile>(
    join('local', `AL-municipalities-${yearOf(checkDate)}.json`),
  );
  const wanted = name.trim().toLowerCase().replace(/\s+county$/, '');
  return (file.counties ?? []).find((c) => c.name.toLowerCase() === wanted);
}

/** Every Alabama county with a county-level occupational fee — for geocode/. */
export function allALCounties(checkDate: string): ALCountyEntry[] {
  const file = loadJson<ALMunicipalityRegistryFile>(
    join('local', `AL-municipalities-${yearOf(checkDate)}.json`),
  );
  return file.counties ?? [];
}

/** Every Alabama taxing municipality — for geocode/'s fuzzy name matching. */
export function allALMunicipalities(checkDate: string): ALMunicipalityEntry[] {
  const file = loadJson<ALMunicipalityRegistryFile>(
    join('local', `AL-municipalities-${yearOf(checkDate)}.json`),
  );
  return file.municipalities;
}

export interface OHMunicipalityEntry {
  name: string;
  municode: string;
  rate: number;
  effectiveFrom: string;
  administeredBy: string;
  /**
   * Dated rates within the file's year, oldest first: the latest entry whose
   * `from` is on or before the check date sets `rate` (a 0 rate means the
   * town was not taxing yet, or had repealed).
   */
  rateHistory?: { from: string; rate: number }[];
}

/**
 * The pre-tax categories that reduce an Ohio municipal (or JEDD/JEDZ)
 * wage base. Held in the local data file, with its ORC 718.01(R) citation,
 * because it differs from the Ohio state income tax list: municipal
 * "qualifying wages" start from Medicare wages and add 401(k)/403(b)/457
 * deferrals back, so a deferral that lowers state tax does not lower this.
 */
interface OHLocalTaxableWages {
  exemptPretax: string[];
}

interface OHMunicipalityRegistryFile {
  year: number;
  taxableWages?: OHLocalTaxableWages;
  municipalities: OHMunicipalityEntry[];
}

function requireOHLocalExemptPretax(file: { taxableWages?: OHLocalTaxableWages }, path: string): string[] {
  const list = file.taxableWages?.exemptPretax;
  if (!Array.isArray(list)) {
    // No silent fallback to the state list: that is exactly the bug this
    // field exists to prevent.
    throw new Error(`${path} has no taxableWages.exemptPretax; the Ohio local wage base can't be determined.`);
  }
  return list;
}

/** Pre-tax categories that reduce the Ohio municipal income tax base (ORC 718.01(R)). */
export function ohMunicipalExemptPretax(checkDate: string): string[] {
  const path = join('local', `OH-municipalities-${yearOf(checkDate)}.json`);
  return requireOHLocalExemptPretax(loadJson<OHMunicipalityRegistryFile>(path), path);
}

/** Whether an Ohio municipal income tax registry exists for this check date. */
export function hasOHMunicipalityRuleset(checkDate: string): boolean {
  return dataFileExists(join('local', `OH-municipalities-${yearOf(checkDate)}.json`));
}

/**
 * Look up one Ohio municipality's rate by name (case-insensitive) — same
 * "closed list, undefined for an unrecognised name" convention as
 * miCityRuleset()/countyRuleset(). Unlike Michigan's file, there is only
 * ONE rate per municipality (not a resident/nonresident split) — see
 * OH-municipalities-2026.json's own residencyNote: this rate applies to
 * income earned within the municipality regardless of who earned it, and
 * separately to a RESIDENT's total income if their home municipality is
 * also on this list. taxes/state.ts's ohioLocalTax() is what combines the
 * two roles and applies the ORC 718.121 inter-municipal credit.
 */
export function ohMunicipalityRuleset(
  name: string,
  checkDate: string,
): OHMunicipalityEntry | undefined {
  const file = loadJson<OHMunicipalityRegistryFile>(
    join('local', `OH-municipalities-${yearOf(checkDate)}.json`),
  );
  const entry = file.municipalities.find((m) => m.name.toLowerCase() === name.toLowerCase());
  const dated = entry?.rateHistory?.filter((h) => h.from <= checkDate).at(-1);
  return entry && dated && dated.rate !== entry.rate ? { ...entry, rate: dated.rate } : entry;
}

/** Every Ohio taxing municipality — for geocode/'s fuzzy name matching. */
export function allOHMunicipalities(checkDate: string): OHMunicipalityEntry[] {
  const file = loadJson<OHMunicipalityRegistryFile>(
    join('local', `OH-municipalities-${yearOf(checkDate)}.json`),
  );
  return file.municipalities;
}

export interface OHSchoolDistrictEntry {
  county: string;
  sdNumber: string;
  irn: string;
  name: string;
  /** The file year's rate; the 2026 file names it rate2026. */
  rate?: number;
  rate2026?: number;
  earnedIncomeOnlyBase: boolean;
  firstYearEffective: number;
}

interface OHSchoolDistrictRegistryFile {
  year: number;
  districts: OHSchoolDistrictEntry[];
}

/** Whether an Ohio School District Income Tax (SDIT) registry exists for this check date. */
export function hasOHSchoolDistrictRuleset(checkDate: string): boolean {
  return dataFileExists(join('local', `OH-school-districts-${yearOf(checkDate)}.json`));
}

/**
 * Look up one Ohio school district's SDIT rate by its 4-digit sdNumber —
 * not by name, since Ohio's own published names carry embedded annotations
 * (e.g. "Bluffton EVSD (expires 2028)") that make an exact-string caller
 * input unreliable; sdNumber is the stable, unambiguous key Ohio's own SD 100
 * withholding forms use. Same "closed list, undefined for an unrecognised
 * code" convention as every other local lookup in this file.
 */
export function ohSchoolDistrictRuleset(
  sdNumber: string,
  checkDate: string,
): OHSchoolDistrictEntry | undefined {
  const file = loadJson<OHSchoolDistrictRegistryFile>(
    join('local', `OH-school-districts-${yearOf(checkDate)}.json`),
  );
  return file.districts.find((d) => d.sdNumber === sdNumber);
}

export interface OHJEDDEntry {
  name: string;
  jeddId: string;
  rate: number;
  effectiveFrom: string;
  /** The district was dissolved or its contract ended: no tax on checks dated on/after this. */
  terminatedOn?: string;
  /** Scheduled end of the current rate (e.g. a step-down period). */
  rateEndsOn?: string;
  /** Tax applies only to the first N dollars (not cents) of district wages each year. */
  annualWageCap?: number;
  /** The year annualWageCap is for (these caps are CPI-adjusted annually). */
  annualWageCapYear?: number;
  /** Dated rates within the file's year, oldest first; the latest `from` on or before the check date sets `rate`. */
  rateHistory?: { from: string; rate: number }[];
}

/** A JEDD/JEDZ rate row with no polygon in Ohio's boundary layer — see the data file's boundaryGaps. */
export interface OHJEDDBoundaryGap {
  jeddId: string;
  name: string;
  /** Inferred from the zone's name; scopes a review warning only, never a tax. */
  countyHints: string[];
  placeHints: string[];
  kind: string;
}

interface OHJEDDRegistryFile {
  year: number;
  taxableWages?: OHLocalTaxableWages;
  zones: OHJEDDEntry[];
  boundaryGaps?: { zones: OHJEDDBoundaryGap[] };
}

/** Pre-tax categories that reduce a JEDD/JEDZ income tax base (Chapter 718, via ORC 715.72 / 715.691). */
export function ohJEDDExemptPretax(checkDate: string): string[] {
  const path = join('local', `OH-jedd-jedz-${yearOf(checkDate)}.json`);
  return requireOHLocalExemptPretax(loadJson<OHJEDDRegistryFile>(path), path);
}

/** Whether an Ohio JEDD/JEDZ rate registry exists for this check date. */
export function hasOHJEDDRuleset(checkDate: string): boolean {
  return dataFileExists(join('local', `OH-jedd-jedz-${yearOf(checkDate)}.json`));
}

/**
 * Look up one Ohio JEDD/JEDZ's rate by Ohio's own jeddId — never by name.
 * The id is what makes this safe to automate: geocode/districts.ts reads
 * the containing zone's `jedd_id` straight off Ohio's published boundary
 * layer, and the two datasets are keyed the same way, so no string
 * matching sits between the boundary and the rate. Same closed-list,
 * undefined-for-an-unknown-id convention as every other local lookup here.
 */
export function ohJEDDRuleset(jeddId: string, checkDate: string): OHJEDDEntry | undefined {
  const file = loadJson<OHJEDDRegistryFile>(join('local', `OH-jedd-jedz-${yearOf(checkDate)}.json`));
  const zone = file.zones.find((z) => z.jeddId === jeddId);
  const dated = zone?.rateHistory?.filter((h) => h.from <= checkDate).at(-1);
  return zone && dated && dated.rate !== zone.rate ? { ...zone, rate: dated.rate } : zone;
}

/** Rate rows whose zone can't be found by coordinate (no published polygon). */
export function ohJEDDBoundaryGaps(checkDate: string): OHJEDDBoundaryGap[] {
  return loadJson<OHJEDDRegistryFile>(join('local', `OH-jedd-jedz-${yearOf(checkDate)}.json`)).boundaryGaps?.zones ?? [];
}

/** Every Ohio JEDD/JEDZ on file. */
export function allOHJEDDs(checkDate: string): OHJEDDEntry[] {
  return loadJson<OHJEDDRegistryFile>(join('local', `OH-jedd-jedz-${yearOf(checkDate)}.json`)).zones;
}

/** Every Ohio school district that levies SDIT — for geocode/'s fuzzy name matching. */
export function allOHSchoolDistricts(checkDate: string): OHSchoolDistrictEntry[] {
  const file = loadJson<OHSchoolDistrictRegistryFile>(
    join('local', `OH-school-districts-${yearOf(checkDate)}.json`),
  );
  return file.districts;
}

export interface GarnishmentSource {
  title: string;
  url: string;
  verifiedOn: string;
  verifiedBy?: string;
}

export interface GarnishmentFederalRuleset {
  year: number;
  sources: GarnishmentSource[];
  federalMinimumHourlyWage: number;
  ordinaryGarnishment: {
    maxDisposableEarningsFraction: number;
    minimumWageWeeklyMultiplier: number;
  };
  supportOrder: {
    supportingOtherFamilyFraction: number;
    notSupportingOtherFamilyFraction: number;
    arrearsBonusFraction: number;
  };
  studentLoanDefault: {
    maxDisposableEarningsFraction: number;
    minimumWageWeeklyMultiplier: number;
  };
}

/** The CCPA's federal garnishment ceilings — see data/garnishment/federal-*.json. */
export function garnishmentFederalRuleset(checkDate: string): GarnishmentFederalRuleset {
  return loadJson<GarnishmentFederalRuleset>(
    join('garnishment', `federal-${yearOf(checkDate)}.json`),
  );
}

/** One "lesser of X% of gross/disposable" test — a state's cap is the MINIMUM across every entry here (plus the minimum-wage floor, if this state's ordinaryGarnishment block also sets one). */
export interface GarnishmentCapFraction {
  basis: 'gross' | 'disposable';
  fraction: number;
}

/**
 * A cliff bracket keyed on multiples of the applicable weekly minimum wage —
 * Minnesota's shape (Minn. Stat. 571.922). Unlike the federal "lesser of a
 * fraction or the amount over a floor" rule, crossing a threshold here puts
 * the WHOLE disposable-earnings figure into that bracket's flat fraction,
 * not just the excess above it. Disposable earnings at or below the lowest
 * tier's minMultiplier are fully exempt (no tier matches).
 */
export interface GarnishmentTier {
  minMultiplier: number;
  /** null means "and above" — the top, uncapped bracket. */
  maxMultiplier: number | null;
  fraction: number;
}

/**
 * A cliff bracket keyed on a FIXED gross-weekly dollar threshold rather than
 * a multiple of minimum wage — Nevada's shape (NRS 31.295). The matching
 * tier's fraction applies to DISPOSABLE earnings; which tier matches is
 * decided by GROSS. Evaluated in ascending order; the first tier whose
 * maxGrossWeekly is at or above this period's gross wins (null = the
 * top, unbounded bracket).
 */
export interface GarnishmentGrossWeeklyTier {
  maxGrossWeekly: number | null;
  fraction: number;
}

/**
 * A MARGINAL (not cliff) bracket schedule denominated in MONTHLY disposable
 * earnings — Hawaii's shape (Haw. Rev. Stat. 652-1). Unlike GarnishmentTier,
 * each bracket's fraction applies only to the slice of disposable earnings
 * actually falling within it, the same way an income tax bracket works, and
 * the monthly-denominated breakpoints are prorated to whatever pay
 * frequency the paycheck actually uses. Brackets are ascending by
 * `upToMonthly`; null means the top, unbounded bracket.
 */
export interface GarnishmentMarginalBracket {
  upToMonthly: number | null;
  fraction: number;
}

/**
 * New Jersey's income-tier test (N.J. Stat. 2A:17-56(a)): a judgment
 * creditor may take at most `belowThresholdFraction` while the debtor's
 * ANNUALIZED income is at or under `thresholdMultipleOfPoverty` times the
 * HHS federal poverty guideline for their own household size — a real
 * number this project didn't track anywhere else, so it is carried here
 * rather than assumed. Above that threshold the statute itself sets no
 * fixed number ("the court... may order a larger percentage"), so this
 * project falls through to the plain federal CCPA default in that case —
 * disclosed as a modelling choice, not a verbatim NJ figure. Requires the
 * caller to supply `GarnishmentOrder.householdSize`; absent that fact, this
 * engine does not guess it and falls through to the same federal default,
 * exactly the way an unset `headOfFamily` is never assumed true.
 */
export interface GarnishmentPovertyGuidelineTier {
  belowThresholdFraction: number;
  /** What `belowThresholdFraction` applies to — NJ's own statute text ("wages... earnings... due and owing") reads as gross, not the CCPA's narrower "disposable earnings" term of art. */
  basis: 'gross' | 'disposable';
  thresholdMultipleOfPoverty: number;
  /** HHS poverty guideline for a household of 1 — 48 contiguous states + DC table (NJ is not AK/HI). Re-published every January; re-verify yearly. */
  povertyGuidelineBase: number;
  /** Added per household member beyond 1, same HHS table. */
  povertyGuidelinePerAdditionalPerson: number;
  /** A separate flat WEEKLY dollar amount exempt from execution regardless of the percentage test — N.J. Stat. 2A:17-50's $48, distinct from the poverty-guideline mechanism above. */
  flatWeeklyExemption?: number;
}

/**
 * One state's (or one head-of-family variant's) full garnishment formula.
 * Every field is optional because a formula can be built from any ONE of
 * capFractions/tiers/grossWeeklyTiers/marginalMonthlyBrackets/
 * povertyGuidelineTier (mutually exclusive in practice — a real state
 * statute uses exactly one shape) plus an optional minimum-wage floor
 * layered on top of capFractions specifically (see
 * minimumWageWeeklyMultiplier's own doc comment).
 */
export interface GarnishmentFormula {
  /**
   * The minimum-wage floor's own multiplier and hourly figure, layered on
   * top of `capFractions` only. BOTH optional together — omit both when the
   * state's formula has no separate floor test (e.g. Delaware's flat 15%,
   * already more protective than the federal floor at every realistic
   * income level) or when the shape used (tiers/grossWeeklyTiers/
   * marginalMonthlyBrackets) is already self-contained. stateMinimumHourlyWage
   * is pre-resolved to whichever of that state's own minimum wage or the
   * federal $7.25 is GREATER, at authoring time — see this file's own
   * per-state $note for which one actually won and when to re-check it.
   */
  minimumWageWeeklyMultiplier?: number;
  stateMinimumHourlyWage?: number;
  /**
   * When true, stateMinimumHourlyWage is replaced at calculation time by
   * the minimum-wage ruleset for this state, check date, and optional
   * GarnishmentInput.workRegion. The stored number remains the baseline
   * the data file documents.
   */
  hourlyWageFromMinimumWageRuleset?: boolean;
  /**
   * What fraction of the excess over the minimum-wage floor is actually
   * reachable — every state in this file except California takes the
   * FULL excess (the federal CCPA's own rule: disposable earnings minus the
   * floor, no further scaling), so this defaults to 1.0 (100%) when omitted
   * and every existing entry's behavior is unchanged. California's own
   * formula (Cal. Civ. Proc. Code § 706.050) is the one exception found so
   * far: only 40% of the amount by which disposable earnings exceed 48x the
   * applicable minimum wage is reachable, not the full excess — set to 0.40
   * there. Only meaningful alongside `capFractions` plus a minimum-wage
   * floor; ignored otherwise.
   */
  minimumWageExcessFraction?: number;
  /** Shape A — the lesser of one or more straight fractions (of gross and/or disposable earnings), e.g. Illinois, Connecticut, New York, Massachusetts, Delaware, Colorado, Washington. */
  capFractions?: GarnishmentCapFraction[];
  /** Shape B — a cliff-bracket schedule keyed on multiples of minimum wage, e.g. Minnesota. */
  tiers?: GarnishmentTier[];
  /** Shape C — a cliff-bracket schedule keyed on a fixed gross-weekly dollar threshold, e.g. Nevada. */
  grossWeeklyTiers?: GarnishmentGrossWeeklyTier[];
  /** Shape D — a MARGINAL bracket schedule denominated in monthly dollars, e.g. Hawaii. */
  marginalMonthlyBrackets?: GarnishmentMarginalBracket[];
  /** Shape E — an income-tier test keyed to the debtor's household size against the HHS federal poverty guideline, e.g. New Jersey. */
  povertyGuidelineTier?: GarnishmentPovertyGuidelineTier;
  /**
   * A flat per-dependent WEEKLY dollar reduction applied to the computed cap
   * (after the fraction/floor test, before clamping at zero) — North
   * Dakota's $20/dependent (N.D. Cent. Code 32-09.1-06). Only meaningful
   * alongside `capFractions`; requires the order's own `dependents` count
   * (see GarnishmentOrder) — absent or 0 dependents means no reduction.
   */
  perDependentWeeklyReduction?: number;
  /**
   * A flat per-week dollar floor — a legislated figure, not derived from
   * any minimum wage — layered on top of `capFractions` the same way
   * `minimumWageWeeklyMultiplier` is. Alaska's own shape (AS 09.38.030(a)):
   * $473/week exempt regardless of the 25%-of-disposable fraction, i.e.
   * the state's OWN dollar figure substitutes for "30x minimum wage" in
   * the usual CCPA-shaped test. Mutually exclusive with
   * `minimumWageWeeklyMultiplier` in practice — a state's floor is either
   * minimum-wage-derived or a flat legislated dollar amount, never both.
   */
  flatWeeklyFloor?: number;
  /**
   * The higher flat floor that applies instead of `flatWeeklyFloor` when
   * `GarnishmentOrder.soleHouseholdSupport` is true — Alaska's $743/week
   * (AS 09.38.050(b)), available only once the debtor has filed the
   * court affidavit asserting their earnings alone support their
   * household. Only meaningful alongside `flatWeeklyFloor`.
   */
  flatWeeklyFloorSoleSupport?: number;
  /**
   * Iowa's own ADDITIONAL layer (Iowa Code 642.21): a cumulative CALENDAR-
   * YEAR dollar cap per judgment creditor, on top of whichever per-paycheck
   * shape above already applies (Iowa's is the plain federal CCPA test —
   * capFractions 25%/30x-federal — so this tier cap is a genuinely
   * SEPARATE, more restrictive ceiling layered over it, not a replacement).
   * Selected by the debtor's own earnings "reasonably expected" for the
   * year (GarnishmentOrder.expectedAnnualEarnings) — ascending by
   * `belowAnnualEarnings`, null meaning the top unbounded tier. Requires
   * the caller to supply that expectation; absent, this engine does not
   * guess a tier and the extra annual layer simply doesn't apply (the
   * per-paycheck shape above still does).
   */
  annualCapTiers?: GarnishmentAnnualCapTier[];
}

export interface GarnishmentAnnualCapTier {
  /** Upper bound (exclusive) of "reasonably expected annual earnings" this tier covers — null means the top, unbounded tier. */
  belowAnnualEarnings: number | null;
  /** A flat annual dollar cap for this tier (Iowa's own $250/$400/$800/$1,500/$2,000 tiers). Mutually exclusive with `maxAnnualFractionOfEarnings`. */
  maxAnnualCents?: number;
  /** A tier defined as a FRACTION of the debtor's own expected annual earnings instead of a flat dollar figure — Iowa's own top tier ($50k+ expected earnings: 10% of expected earnings, not a fixed dollar cap). Mutually exclusive with `maxAnnualCents`. */
  maxAnnualFractionOfEarnings?: number;
}

export interface GarnishmentStateOverride {
  /** True where state law bars ordinary consumer/creditor garnishment outright (TX, PA, NC, SC). Never affects support orders or federal student loan default — those preempt state wage exemptions entirely. */
  ordinaryGarnishmentProhibited?: boolean;
  /**
   * A status-conditioned full exemption from ordinary garnishment — Florida's
   * "head of family" rule (Fla. Stat. 222.11), the only one of these this
   * project has researched. The caller asserts the qualifying fact on the
   * GarnishmentOrder itself (`headOfFamily`), same discipline as every other
   * eligibility flag this engine refuses to guess; `waivableInWriting: true`
   * means the debtor can waive it (`wageExemptionWaivedInWriting: true` on
   * the order), in which case this state's ordinaryGarnishment/federal-default
   * rule applies as if the exemption were never there.
   */
  fullExemption?: {
    qualifyingFlag: 'headOfFamily';
    waivableInWriting: boolean;
  };
  ordinaryGarnishment?: GarnishmentFormula;
  /**
   * Applies INSTEAD of ordinaryGarnishment/the federal default whenever
   * order.headOfFamily is true — Missouri's own reduced-percentage variant
   * (Mo. Rev. Stat. 525.030: 10% instead of the ordinary 25%), distinct from
   * Florida's all-or-nothing `fullExemption` above. Checked before
   * `fullExemption`, so a state could in principle carry both (none
   * currently does).
   */
  headOfFamilyOrdinaryGarnishment?: GarnishmentFormula;
  sources: GarnishmentSource[];
  $note?: string;
  knownGap?: string;
}

interface GarnishmentStateOverrideFile {
  year: number;
  states: Record<string, GarnishmentStateOverride>;
}

/**
 * A state's own departure from the federal CCPA ordinary-garnishment
 * default, if this project has researched one — undefined means "use the
 * federal default," never "confirmed no departure exists." See
 * data/garnishment/state-overrides-*.json's own $scopeNote.
 */
export function garnishmentStateOverride(
  code: string,
  checkDate: string,
): GarnishmentStateOverride | undefined {
  const file = loadJson<GarnishmentStateOverrideFile>(
    join('garnishment', `state-overrides-${yearOf(checkDate)}.json`),
  );
  return file.states[code.toUpperCase()];
}

// ---------------------------------------------------------------------------
// Minimum wage — data/minimum-wage/
//
// A separate dataset from everything above it in this file. Every other
// ruleset here answers "what is withheld from this paycheck"; these answer
// "how low may the paycheck itself go," which is a floor on GROSS pay, not
// a tax. They live in their own folder for that reason, and the loaders
// below deliberately mirror the same shape as the tax loaders so the
// swappable dataReader (Edge Function bundling, tests) covers them too.
// ---------------------------------------------------------------------------

/** One published hourly figure, carried as both dollars and cents. */
export interface MinimumWageAmount {
  hourly: number;
  hourlyCents: number;
  id?: string;
  label?: string;
  test?: string;
  note?: string;
  effectiveFrom?: string;
  effectiveTo?: string;
  /** Machine-readable employer-size test, where the jurisdiction's tier is a headcount. */
  appliesWhen?: { employeeCountMin?: number; employeeCountMax?: number };
  /** True where the tier means "this ordinance does not reach this employer at all." */
  notCovered?: boolean;
  /**
   * Marks a variant as a named geographic sub-region overriding the
   * standard or tipped figure entirely (New York's downstate counties,
   * Oregon's Portland metro/non-urban tiers) — selected via
   * MinimumWageQuery.region, never via employeeCount.
   */
  regionalOverrideOf?: 'standard' | 'tipped';
  /** The region this tipped-rate variant belongs to, matched against MinimumWageQuery.region. */
  region?: string;
  /** New York's own tipped-employee occupation split; matched against MinimumWageQuery.occupation. */
  occupation?: 'food_service' | 'service_employee';
  /**
   * Marks this variant as the rate that was in effect BEFORE the headline
   * `standard`/`tipped` figure took over mid-YEAR — e.g. Alaska's $13.00
   * from 2025-07-01 through 2026-06-30, before its $14.00 step on
   * 2026-07-01. Selected purely by `effectiveFrom`/`effectiveTo` covering
   * `checkDate`, with no size or region test — this project's data
   * represents the state of the world AS OF its own `asOf` date, not a
   * full year-round history, so this field exists ONLY where a checkDate
   * earlier in the same calendar year would otherwise get the wrong,
   * later-in-the-year figure.
   */
  historicalPredecessorOf?: 'standard' | 'tipped';
  [key: string]: unknown;
}

export interface TippedMinimumWage {
  tipCreditAllowed: boolean;
  cashWage: number;
  cashWageCents: number;
  maxTipCredit?: number;
  maxTipCreditCents?: number;
  tippedEmployeeThreshold?: { amount: number; period: string; note?: string } | null;
  note?: string;
}

export interface MinimumWageJurisdiction extends MinimumWageAmount {
  id: string;
  name: string;
  level: string;
  tipped?: TippedMinimumWage;
  variants?: MinimumWageAmount[];
  coverage?: string;
  status?: string;
}

export interface FederalMinimumWageRuleset {
  jurisdiction: { level: string; code: string; name: string };
  year: number;
  asOf: string;
  standard: MinimumWageAmount;
  tipped: TippedMinimumWage;
  youthAndTraining: MinimumWageAmount[];
  [key: string]: unknown;
}

export interface StateMinimumWageRuleset {
  jurisdiction: { level: string; code: string; name: string };
  year: number;
  asOf: string;
  hasStateMinimumWage?: boolean;
  /** Null only for American Samoa, whose federal floor is 18 industry rates instead. */
  standard: MinimumWageAmount | null;
  tipped: TippedMinimumWage;
  variants?: MinimumWageAmount[];
  youthAndTraining?: MinimumWageAmount[];
  industryRates?: MinimumWageAmount[];
  sources: { title: string; url: string; verifiedOn: string }[];
  [key: string]: unknown;
}

export interface LocalMinimumWageFile {
  state: string;
  year: number;
  asOf: string;
  jurisdictions: MinimumWageJurisdiction[];
  [key: string]: unknown;
}

export function federalMinimumWageRuleset(checkDate: string): FederalMinimumWageRuleset {
  return loadJson<FederalMinimumWageRuleset>(
    join('minimum-wage', `federal-${yearOf(checkDate)}.json`),
  );
}

/**
 * One state's, DC's or a territory's own minimum wage ruleset. States and
 * territories live in sibling folders because a territory is not a state
 * anywhere else in this engine either; this resolves whichever exists.
 */
export function stateMinimumWageRuleset(
  code: string,
  checkDate: string,
): StateMinimumWageRuleset {
  const upper = code.toUpperCase();
  const year = yearOf(checkDate);
  const statePath = join('minimum-wage', 'states', `${upper}-${year}.json`);
  if (dataFileExists(statePath)) {
    return loadJson<StateMinimumWageRuleset>(statePath);
  }
  return loadJson<StateMinimumWageRuleset>(
    join('minimum-wage', 'territories', `${upper}-${year}.json`),
  );
}

export function hasStateMinimumWageRuleset(code: string, checkDate: string): boolean {
  const upper = code.toUpperCase();
  const year = yearOf(checkDate);
  return (
    dataFileExists(join('minimum-wage', 'states', `${upper}-${year}.json`)) ||
    dataFileExists(join('minimum-wage', 'territories', `${upper}-${year}.json`))
  );
}

export function hasLocalMinimumWageRuleset(stateCode: string, checkDate: string): boolean {
  return dataFileExists(
    join('minimum-wage', 'local', `${stateCode.toUpperCase()}-local-${yearOf(checkDate)}.json`),
  );
}

/**
 * Every local minimum wage ordinance this project has researched in one
 * state. An empty result means "no ordinance file for this state," which is
 * NOT the same as "no locality in this state has one" — see the folder's
 * own README for what was canvassed.
 */
export function localMinimumWageRuleset(
  stateCode: string,
  checkDate: string,
): MinimumWageJurisdiction[] {
  if (!hasLocalMinimumWageRuleset(stateCode, checkDate)) return [];
  const file = loadJson<LocalMinimumWageFile>(
    join('minimum-wage', 'local', `${stateCode.toUpperCase()}-local-${yearOf(checkDate)}.json`),
  );
  return file.jurisdictions;
}

export interface SectoralMinimumWageFile {
  state: string;
  year: number;
  sectors: (MinimumWageAmount & { id: string; name: string; coverage: string })[];
  [key: string]: unknown;
}

export function hasSectoralMinimumWageRuleset(stateCode: string, checkDate: string): boolean {
  return dataFileExists(
    join('minimum-wage', 'sectoral', `${stateCode.toUpperCase()}-sectoral-${yearOf(checkDate)}.json`),
  );
}

export function sectoralMinimumWageRuleset(
  stateCode: string,
  checkDate: string,
): SectoralMinimumWageFile['sectors'] {
  if (!hasSectoralMinimumWageRuleset(stateCode, checkDate)) return [];
  return loadJson<SectoralMinimumWageFile>(
    join(
      'minimum-wage',
      'sectoral',
      `${stateCode.toUpperCase()}-sectoral-${yearOf(checkDate)}.json`,
    ),
  ).sectors;
}
