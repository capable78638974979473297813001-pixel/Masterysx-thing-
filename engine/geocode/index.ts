/**
 * Public entry point: street address(es) in, resolved certificate fields
 * out. Ties together census.ts's live fetches and resolve.ts's pure
 * matching — kept as a thin orchestrator so each half stays independently
 * testable (resolve.ts's tests use captured fixture JSON; this file itself
 * is exercised only by examples/geocode-demo.ts against the live services).
 *
 * This is explicitly an ONBOARDING/ADDRESS-CHANGE step, not something
 * calculatePaycheck() ever calls — see resolve.ts's own doc comment for
 * why. Call it once when an employee's work or home address is entered or
 * changes, review anything below 'matched' confidence, then store the
 * resulting certificate fields on the employee record for
 * calculatePaycheck() to read on every subsequent paycheck without ever
 * touching the network.
 *
 * Two entry points:
 *   - resolveAddress() — ONE address, ONE role. Fine for the common case
 *     (MI/OH/PA/IN local taxes, all keyed purely off that single address).
 *   - resolveEmployee() — BOTH addresses together. Required whenever a tax
 *     is keyed off something that isn't simply "this one address's own
 *     role": Yonkers' resident/nonresident-worker taxes are mutually
 *     exclusive and need to compare both addresses to know which one (if
 *     either) fires; Missouri's Kansas City/St. Louis earnings tax fires
 *     from EITHER address; NYC's resident tax and Maryland's/Multnomah's
 *     taxes are role-specific in a way a single generic 'work'/'residence'
 *     label doesn't capture without the state-specific knowledge encoded
 *     below (verified against each tax's own doc comment in
 *     taxes/state.ts, not assumed).
 */
import {
  fetchGeographiesAtPointSafe,
  fetchSchoolDistrictAtPointSafe,
  geocodeAddress,
  matchedAddressDifferences,
  tigerwebServiceForDate,
  type MatchQuality,
} from './census.ts';
import {
  isInsideCanbyTransitDistrict,
  isInsidePortlandMetro,
  jeddAtPoint,
  oregonTransitDistrictAtPoint,
  type JeddCheck,
  type JeddDistrict,
} from './districts.ts';
import { ohJEDDBoundaryGaps, ohJEDDRuleset } from '../src/registry.ts';
import { parseAddressParts, resolveRooftop, type AddressPointTier, type RooftopResult } from './rooftop.ts';
import { checkNearestBuilding, LARGE_HOUSE_NUMBER_GAP, type BuildingCheckResult } from './buildings.ts';
import { crossCheckSafe, milesBetween, searchStructuredAddressSafe, type NominatimResult } from './nominatim.ts';
import { namesEqual, stripCountySuffix, stripPlaceTypeSuffix } from './normalize.ts';
import { resolveJurisdiction, toCertificateFields, type ResolvedJurisdiction } from './resolve.ts';
import type { StateCertificate } from '../src/types.ts';

export type {
  CensusGeographies,
  FieldMatch,
  MatchConfidence,
  ResolvedJurisdiction,
} from './resolve.ts';
export { resolveJurisdiction, toCertificateFields } from './resolve.ts';
export {
  fetchSchoolDistrictAtPoint,
  geocodeAddress,
  matchedAddressDifferences,
  normalizeAddress,
  type FetchOptions,
  type MatchQuality,
} from './census.ts';
export { crossCheckAddress, type NominatimResult } from './nominatim.ts';
export {
  isInsideCanbyTransitDistrict,
  isInsidePortlandMetro,
  jeddAtPoint,
  oregonTransitDistrictAtPoint,
  type DistrictCheck,
  type JeddCheck,
  type JeddDistrict,
  type OregonTransitDistrictCheck,
} from './districts.ts';
export { checkNearestBuilding, LARGE_HOUSE_NUMBER_GAP, type BuildingCheckResult, type NearbyBuilding } from './buildings.ts';
export {
  fetchAddressPointsNear,
  matchAddressPoint,
  neighborBracket,
  parseAddressParts,
  resolveRooftop,
  type AddressPoint,
  type AddressPointTier,
  type NeighborBracket,
  type RooftopMatch,
  type RooftopResult,
} from './rooftop.ts';
export {
  PARCEL_SOURCES,
  MAX_TRUSTED_PARCEL_AREA_SQUARE_METERS,
  resolveParcelCentroid,
  type ParcelCentroidResult,
  type ParcelSource,
} from './parcel.ts';

/**
 * A LARGE disagreement in resolved COORDINATES between Census and
 * Nominatim is a stronger signal than a place-name mismatch — it usually
 * means one geocoder resolved a genuinely different location (a common
 * street name in another part of town, a stale OSM node), not just a
 * naming-convention difference. 0.5 miles is deliberately conservative:
 * ordinary interpolation slop between two independent geocoders on the
 * SAME address is normally much smaller than this.
 */
const LARGE_DISTANCE_DISAGREEMENT_MILES = 0.5;

/**
 * A WIDE interpolation range is the honest signal available for addresses
 * that are still resolved by interpolation — i.e. the ones rooftop.ts
 * could not find an authoritative address point for. 20 is not a
 * scientific threshold — it's a deliberately conservative "worth a second
 * look before this address goes live near a boundary" line, picked to
 * flag block faces with many addressable lots rather than ordinary short
 * suburban blocks. It is deliberately NOT raised on a rooftop-resolved
 * address: it describes a coordinate that resolution didn't use.
 */
const WIDE_ADDRESS_RANGE_THRESHOLD = 20;

export interface CrossCheckResult {
  /** false when Nominatim's own result couldn't be obtained at all (network/rate-limit/no-match) — a missing cross-check is NOT evidence against the Census result, it just means no second opinion was available this call. */
  attempted: boolean;
  nominatim: NominatimResult | null;
  /** true when Nominatim's place/county names disagree with what Census resolved (case-insensitive, suffix-normalized) — two independently-maintained datasets giving different answers, not necessarily either one being wrong. */
  placeDisagreement: boolean;
  /** true when the two geocoders' coordinates are more than LARGE_DISTANCE_DISAGREEMENT_MILES apart. */
  distanceDisagreementMiles: number | null;
  /**
   * A THIRD, independent signal — see buildings.ts's own doc comment for
   * the full story: OpenStreetMap's traced building-footprint data (a
   * different subsystem from Nominatim's own address search) found a
   * genuine real-world error this way — Nominatim and Census had both
   * "matched" 90 W Broad St, Columbus, but Nominatim's point sat next to a
   * building tagged "500 W Broad Street", a 410-number gap, while Census's
   * point sat next to one tagged "50 W Broad Street", a 40-number gap.
   */
  building: BuildingCheckResult;
}

export interface AddressResolution {
  address: string;
  matched: boolean;
  resolved: ResolvedJurisdiction | null;
  certificateFields: Partial<StateCertificate>;
  matchQuality: MatchQuality | null;
  crossCheck: CrossCheckResult | null;
  /**
   * How the coordinate these jurisdictions were resolved at was obtained,
   * best first (see rooftop.ts for each tier's own reasoning):
   *   'rooftop'      — a point published for this exact address by the
   *                    government that assigns addresses.
   *   'rooftop-osm'  — OpenStreetMap holds a house-level point for this
   *                    address and it agrees with Census's own position.
   *                    Crowd-sourced and corroborated, not authoritative.
   *   'neighbor'     — interpolated between the two nearest published
   *                    points on the same street. Block-level.
   *   'parcel-centroid' — a county government's own tax-parcel polygon
   *                    centroid, only ever used in place of 'rooftop-osm'
   *                    when it measurably beats it — see parcel.ts and
   *                    rooftop.ts's own AddressPointTier doc comment.
   *   'interpolated' — Census's own position along a TIGER address range,
   *                    which is what this project had before any of the
   *                    above existed.
   */
  precision: 'rooftop' | 'rooftop-osm' | 'neighbor' | 'parcel-centroid' | 'interpolated';
  /** The coordinate the jurisdictions were actually resolved at. */
  coordinates: { lat: number; lon: number } | null;
  /**
   * Which geocoder produced the coordinate. 'census-address-range' means
   * the address was in Census's own TIGER ranges; the 'osm-*' values mean
   * it was not, and OpenStreetMap supplied the point instead — at which
   * stage the jurisdictions were resolved by testing that point against
   * boundary polygons rather than from an address match.
   */
  coordinateSource: CoordinateSource | null;
  /**
   * The raw Census geography names at the resolved point, before any
   * registry matching. `resolved` above is the tax-registry view of this
   * address; these are the plain place/county names underneath it, kept
   * because not every consumer is a tax lookup — the minimum wage
   * resolver matches city and county ordinances against these directly
   * (see src/minimum-wage-address.ts).
   *
   * An EMPTY incorporatedPlaces array is meaningful, not missing data: it
   * means the point falls on unincorporated land, which is exactly the
   * condition an "unincorporated areas only" county ordinance requires.
   */
  geographies: { incorporatedPlaces: string[]; counties: string[] } | null;
  /** The authoritative-address-point lookup, whatever its outcome — including the distance between the two points, which is the size of the interpolation error this corrected. */
  rooftop: RooftopResult | null;
  /** The Ohio JEDD/JEDZ containing this address, if any — a tax that exists on unincorporated land where no municipality does. Null everywhere outside Ohio, and wherever Ohio's boundary service couldn't be reached (which is then a lowConfidenceReason, not a silent "no JEDD"). */
  jedd: JeddDistrict | null;
  /**
   * True when no field was ambiguous, every field whose registry covers the
   * whole state (PA PSD, IN county, MD county) matched, every live boundary
   * lookup this address needed answered, AND the geocode itself was
   * high-confidence (narrow interpolation range, no fallback retry needed,
   * no cross-check disagreement) — false means a human should look before
   * this address goes live in certificate data. A 'no_match' on a
   * closed-list registry (e.g. a Michigan city outside the taxing list) is
   * usually the right answer and does not by itself clear this flag.
   */
  fullyResolved: boolean;
  /** Plain-language reasons fullyResolved is false, if it is — empty when fullyResolved is true. */
  lowConfidenceReasons: string[];
}

/**
 * Local-tax fields whose registry covers EVERY address in the state, so a
 * 'no_match' there means the resolver failed, not that no tax applies:
 * every Pennsylvania municipality/school-district pair has a PSD code and
 * EIT, every Indiana county levies a county income tax, and every
 * Maryland county (and Baltimore City) levies a local income tax. For
 * closed-list registries (Michigan's cities, Ohio's taxing municipalities
 * and school districts, Alabama's and Kentucky's cities) a no_match is
 * usually the correct answer and is not flagged.
 */
const EXHAUSTIVE_LOCAL_FIELDS: Record<string, { field: keyof ResolvedJurisdiction; label: string }[]> = {
  PA: [{ field: 'paJurisdiction', label: 'Pennsylvania local jurisdiction (PSD code for EIT/LST)' }],
  IN: [{ field: 'county', label: 'Indiana county (county income tax)' }],
  MD: [{ field: 'mdCounty', label: 'Maryland county (local income tax)' }],
};

/** Reasons an exhaustive local field failed to match. Exported for tests. */
export function requiredFieldReasons(resolved: ResolvedJurisdiction): string[] {
  const reasons: string[] = [];
  for (const { field, label } of EXHAUSTIVE_LOCAL_FIELDS[resolved.state] ?? []) {
    const m = resolved[field] as { confidence?: string } | null;
    if (!m || m.confidence === 'no_match') {
      reasons.push(
        `No ${label} matched this address, but every address in ${resolved.state} has one — the local tax for this address would be omitted. Resolve it by hand before using this profile.`,
      );
    }
  }
  return reasons;
}

/**
 * Turn Ohio's JEDD/JEDZ boundary lookup into what the certificate may use
 * and what a reviewer must be told. Pure (the lookup is passed in), so the
 * decision logic is testable without the network.
 *
 *   - Lookup failed: no zone can be ruled in or out -> review.
 *   - Several active zones overlap the point: don't pick one -> review.
 *   - A zone was found but has no rate row: the tax would silently be
 *     zero -> review, and no workJEDDId is set.
 *   - No zone found, but the address is where a zone WITHOUT a published
 *     polygon may be (data file boundaryGaps) -> review.
 */
export function ohioJeddDecision(input: {
  found: JeddCheck;
  checkDate: string;
  counties: string[];
  places: string[];
  /** Whether the address matched a taxing Ohio municipality. */
  municipalityMatched: boolean;
}): { jedd: JeddDistrict | null; workJEDDId: string | null; reasons: string[] } {
  const { found, checkDate } = input;
  if (!found.attempted) {
    return {
      jedd: null,
      workJEDDId: null,
      reasons: [
        "Ohio's JEDD/JEDZ boundary service could not be reached, so this address was NOT checked for a joint economic development district tax. Retry before relying on this profile; an address inside a zone owes that zone's rate.",
      ],
    };
  }
  if (found.ambiguous) {
    const names = (found.candidates ?? []).filter((c) => c.active).map((c) => `${c.name} (${c.jeddId})`).join(', ');
    return {
      jedd: null,
      workJEDDId: null,
      reasons: [`This point falls inside more than one active Ohio JEDD/JEDZ polygon (${names}). Which zone taxes it can't be decided automatically; none was applied. Confirm the zone by hand.`],
    };
  }
  if (found.jedd?.active) {
    if (!ohJEDDRuleset(found.jedd.jeddId, checkDate)) {
      return {
        jedd: found.jedd,
        workJEDDId: null,
        reasons: [`This address is inside ${found.jedd.name} (Ohio zone id ${found.jedd.jeddId}), but there is no rate on file for that zone id, so its tax can't be computed. Look up the zone's rate before using this profile.`],
      };
    }
    return { jedd: found.jedd, workJEDDId: found.jedd.jeddId, reasons: [] };
  }

  // No zone by coordinate. Zones with no published polygon can't be ruled out.
  const counties = input.counties.map((c) => stripCountySuffix(c).toLowerCase());
  const places = input.places.map((p) => stripPlaceTypeSuffix(p).toLowerCase());
  const possible = ohJEDDBoundaryGaps(checkDate).filter((g) => {
    if (!g.countyHints.some((c) => counties.includes(c.toLowerCase()))) return false;
    return !input.municipalityMatched || g.placeHints.some((p) => places.includes(p.toLowerCase()));
  });
  if (possible.length === 0) return { jedd: null, workJEDDId: null, reasons: [] };
  return {
    jedd: null,
    workJEDDId: null,
    reasons: [
      `No JEDD/JEDZ polygon contains this address, but it is in an area where ${possible.length === 1 ? 'a zone' : 'zones'} with NO published boundary may apply: ` +
        possible.map((g) => `${g.name} (${g.jeddId})`).join(', ') +
        ". Ohio's boundary layer can't detect these; confirm with the zone's administrator whether this address is inside one.",
    ],
  };
}

function attemptedMatches(resolved: ResolvedJurisdiction) {
  return [
    resolved.miCity,
    resolved.ohMunicipality,
    resolved.ohSchoolDistrict,
    resolved.county,
    resolved.paJurisdiction,
    resolved.mdCounty,
    resolved.alMunicipality,
    resolved.alCounty,
    resolved.kyCity,
    resolved.kyCounty,
  ].filter((m) => m !== null);
}

/**
 * Geocode one address and resolve it against every registry this module
 * knows how to match. Returns matched: false, not a throw, when Census has
 * no match even after census.ts's own secondary-unit-stripping retry — an
 * unmatched address is a common, expected outcome.
 *
 * The school-district lookup (Ohio only) uses the "Safe" variant that
 * catches its own network failures rather than letting one flaky
 * secondary call take down a resolution that otherwise succeeded — a
 * caller still gets the municipality/county match, plus an explicit note
 * that the school-district half needs a retry.
 */
/** The tier names rooftop.ts reports, in the vocabulary a caller of this module reads. */
function precisionForTier(tier: AddressPointTier): 'rooftop' | 'rooftop-osm' | 'neighbor' | 'parcel-centroid' {
  switch (tier) {
    case 'authoritative':
      return 'rooftop';
    case 'osm-corroborated':
      return 'rooftop-osm';
    case 'authoritative-neighbors':
      return 'neighbor';
    case 'parcel-centroid':
      return 'parcel-centroid';
  }
}

/** How the point that replaced the interpolated one was obtained, in a sentence a reviewer can act on. */
function describePoint(rooftop: RooftopResult): string {
  switch (rooftop.tier) {
    case 'authoritative':
      return `its authoritative address point, published by ${rooftop.match!.chosen.source ?? 'the local address authority'}`;
    case 'osm-corroborated':
      return "OpenStreetMap's own house-level point for it, which agrees with Census's position";
    case 'authoritative-neighbors':
      return `a position interpolated between the authoritative points for ${rooftop.neighbors!.below.houseNumber} and ${rooftop.neighbors!.above.houseNumber} on the same street`;
    case 'parcel-centroid':
      return `${rooftop.parcel!.source.jurisdictionLabel}'s own tax-parcel centroid for it (${rooftop.parcel!.areaSquareMeters.toFixed(0)} sqm), which lands closer to Census's position than OpenStreetMap's own point did`;
    default:
      return 'a corrected point';
  }
}

/** Human-readable list of every geography that came out DIFFERENT at the authoritative point than at the interpolated one. Empty is the normal, reassuring case; non-empty means the corrected coordinate changed the tax answer. */
function geographyDifferences(
  interpolated: { incorporatedPlaces: string[]; counties: string[]; countySubdivisions: string[]; state: string },
  rooftop: { incorporatedPlaces: string[]; counties: string[]; countySubdivisions: string[]; state: string },
): string[] {
  const differences: string[] = [];
  const compare = (label: string, a: string[], b: string[]) => {
    const left = [...a].sort().join(', ') || 'none';
    const right = [...b].sort().join(', ') || 'none';
    if (left !== right) differences.push(`${label}: "${left}" -> "${right}"`);
  };
  if (interpolated.state !== rooftop.state) differences.push(`state: "${interpolated.state}" -> "${rooftop.state}"`);
  compare('place', interpolated.incorporatedPlaces, rooftop.incorporatedPlaces);
  compare('county subdivision', interpolated.countySubdivisions, rooftop.countySubdivisions);
  compare('county', interpolated.counties, rooftop.counties);
  return differences;
}

/**
 * Where the coordinate a resolution used actually came from. Reported so
 * a reviewer can tell "Census had this address in its own ranges" from
 * "no official range existed and OpenStreetMap supplied the point" —
 * those deserve different amounts of trust, and collapsing them into one
 * "matched" would hide that.
 */
export type CoordinateSource =
  | 'census-address-range'
  | 'osm-structured'
  | 'osm-freeform';

/**
 * Get a coordinate for an address WITHOUT Census's address ranges.
 *
 * Tried in order of how specific the answer is:
 *   1. OSM structured search at house rank — a real house-level point.
 *   2. OSM free-text search — will happily return a street or town
 *      centroid, which is still enough to answer which city and county
 *      contain it, and is reported as the weaker source it is.
 *
 * Every step is failure-tolerant: a fallback that throws is a fallback
 * that didn't help, never a reason to fail the whole resolution.
 */
async function coordinateFromFallbackGeocoders(
  address: string,
): Promise<{ lat: number; lon: number; source: CoordinateSource } | null> {
  const parts = parseAddressParts(address);
  if (parts.street) {
    const structured = await searchStructuredAddressSafe({
      street: parts.houseNumber ? `${parts.houseNumber} ${parts.street}` : parts.street,
      city: parts.city ?? undefined,
      state: parts.state ?? undefined,
      postalcode: parts.postalcode ?? undefined,
    });
    if (structured.ok && structured.hit?.coordinates) {
      return { ...structured.hit.coordinates, source: 'osm-structured' };
    }
  }

  const free = await crossCheckSafe(address);
  if (free.ok && free.result.matched && free.result.coordinates) {
    return { ...free.result.coordinates, source: 'osm-freeform' };
  }

  return null;
}

async function geocodeAndResolve(address: string, checkDate: string): Promise<{
  resolved: ResolvedJurisdiction;
  matched: true;
  matchQuality: MatchQuality;
  schoolDistrictLookupFailed: boolean;
  coordinates: { x: number; y: number };
  geographies: { incorporatedPlaces: string[]; counties: string[] };
  precision: 'rooftop' | 'rooftop-osm' | 'neighbor' | 'parcel-centroid' | 'interpolated';
  point: { lat: number; lon: number };
  rooftop: RooftopResult;
  rooftopJurisdictionChanges: string[];
  coordinateSource: CoordinateSource;
} | {
  resolved: null;
  matched: false;
  matchQuality: null;
  schoolDistrictLookupFailed: false;
  coordinates: null;
  geographies: null;
  precision: 'interpolated';
  point: null;
  rooftop: null;
  rooftopJurisdictionChanges: never[];
  coordinateSource: null;
}> {
  let geocoded = await geocodeAddress(address);
  let coordinateSource: CoordinateSource = 'census-address-range';

  // CENSUS IS ONE SOURCE OF A COORDINATE, NOT THE ANSWER.
  //
  // Census's address geocoder can only match an address that appears in
  // its own TIGER address RANGES. New construction, recently annexed
  // streets, rural routes and plenty of ordinary addresses simply are not
  // in them, and when that happens it returns no match at all — which used
  // to end the whole resolution, even though the jurisdiction question was
  // still perfectly answerable.
  //
  // It is answerable because the two halves are independent:
  //
  //   1. WHERE IS THIS ADDRESS?  — any geocoder can answer. Census's
  //      address ranges are one; OpenStreetMap's structured search is
  //      another, and it holds house-level points for many addresses
  //      TIGER has never heard of.
  //   2. WHICH JURISDICTIONS CONTAIN THAT POINT? — this is a point-in-
  //      polygon test against published boundary polygons, and it never
  //      needed the address at all. fetchGeographiesAtPoint() asks
  //      TIGERweb's own boundary service exactly that.
  //
  // So when step 1's first source comes up empty, fall through to the
  // next one and then answer step 2 from the polygons. resolveRooftop()
  // below still runs either way and can upgrade the point to a true
  // rooftop position from the National Address Database.
  if (!geocoded.matched || !geocoded.coordinates) {
    const fallback = await coordinateFromFallbackGeocoders(address);
    if (fallback) {
      const atPoint = await fetchGeographiesAtPointSafe(fallback.lon, fallback.lat, fetch, {}, checkDate);
      if (atPoint.ok && atPoint.result?.geographies) {
        geocoded = {
          matched: true,
          coordinates: { x: fallback.lon, y: fallback.lat },
          geographies: atPoint.result.geographies,
          // No TIGER address range was involved, so there is no range
          // width or side to report. Saying "matched via fallback" is the
          // honest description of what happened.
          matchQuality: {
            addressRangeWidth: null,
            matchedViaFallback: true,
            side: null,
            tigerLineId: null,
          } as MatchQuality,
        };
        coordinateSource = fallback.source;
      }
    }
  }

  if (!geocoded.matched || !geocoded.geographies || !geocoded.coordinates || !geocoded.matchQuality) {
    return {
      resolved: null,
      matched: false,
      matchQuality: null,
      schoolDistrictLookupFailed: false,
      coordinates: null,
      geographies: null,
      precision: 'interpolated',
      point: null,
      rooftop: null,
      rooftopJurisdictionChanges: [],
      coordinateSource: null,
    };
  }

  const interpolated = { lat: geocoded.coordinates.y, lon: geocoded.coordinates.x };
  const rooftop = await resolveRooftop(address, interpolated);

  let geographies = geocoded.geographies;
  let point = interpolated;
  let precision: 'rooftop' | 'rooftop-osm' | 'neighbor' | 'parcel-centroid' | 'interpolated' = 'interpolated';
  let rooftopJurisdictionChanges: string[] = [];
  let schoolDistrictName: string | undefined;
  let schoolDistrictLookupFailed = false;
  let historicalVintage = false;

  // An authoritative point is only worth having if the jurisdictions get
  // re-asked AT it — the geocoder's own geographies describe the curb
  // position it chose, not this address's actual parcel. An ambiguous
  // match (see rooftop.ts) is deliberately NOT used: a point averaged
  // across two places that share a street name is worse than the honest
  // interpolation.
  if (rooftop.found && rooftop.point && !rooftop.ambiguous) {
    const at = await fetchGeographiesAtPointSafe(rooftop.point.lon, rooftop.point.lat, undefined, {}, checkDate);
    if (at.ok && at.result) {
      rooftopJurisdictionChanges = geographyDifferences(geocoded.geographies, at.result.geographies);
      geographies = at.result.geographies;
      schoolDistrictName = at.result.schoolDistrict ?? undefined;
      point = rooftop.point;
      precision = precisionForTier(rooftop.tier!);
    }
  }

  // The geocoder's own geographies describe TODAY's boundaries. For a
  // check date in a year with its own published TIGERweb vintage, the
  // boundaries that were in force then are the ones that decide the tax —
  // cities annex land, districts merge — so re-resolve at the same point
  // against that vintage. Skipped when the vintage IS the current one,
  // where the extra request would return what Census already said.
  if (precision === 'interpolated' && tigerwebServiceForDate(checkDate) !== 'tigerWMS_Current') {
    const at = await fetchGeographiesAtPointSafe(point.lon, point.lat, undefined, {}, checkDate);
    if (at.ok && at.result) {
      geographies = at.result.geographies;
      schoolDistrictName = at.result.schoolDistrict ?? undefined;
      historicalVintage = true;
    }
  }

  // Only needed on the interpolated path, and only when the identify call
  // above didn't already run: the rooftop lookup returns the school
  // district from the SAME identify call, so this would be a duplicate.
  if (precision === 'interpolated' && !historicalVintage && geographies.state === 'OH') {
    const sd = await fetchSchoolDistrictAtPointSafe(point.lon, point.lat, undefined, {}, checkDate);
    if (sd.ok) {
      schoolDistrictName = sd.district ?? undefined;
    } else {
      schoolDistrictLookupFailed = true;
    }
  }

  return {
    resolved: resolveJurisdiction(geographies, checkDate, schoolDistrictName),
    matched: true,
    matchQuality: geocoded.matchQuality,
    schoolDistrictLookupFailed,
    coordinates: geocoded.coordinates,
    geographies: {
      incorporatedPlaces: geographies.incorporatedPlaces,
      counties: geographies.counties,
    },
    precision,
    point,
    rooftop,
    rooftopJurisdictionChanges,
    coordinateSource,
  };
}

/**
 * Compare Census's resolved place/county names and coordinates against
 * Nominatim's own independent result for the SAME address. Never throws
 * and never blocks the primary resolution — a cross-check that couldn't
 * run (Nominatim down, rate-limited, no match) comes back as
 * `attempted: false`, treated as "no second opinion", not as evidence
 * against Census.
 */
async function runCrossCheck(
  address: string,
  census: { incorporatedPlaces: string[]; counties: string[] },
  censusCoordinates: { x: number; y: number },
): Promise<CrossCheckResult> {
  // Concurrent on purpose: these are two independent services (Nominatim's
  // address search and Overpass's footprint data), and the building check
  // is run against CENSUS's own point regardless of whether Nominatim
  // answers at all — the two signals are not conditional on each other.
  const [outcome, building] = await Promise.all([
    crossCheckSafe(address),
    checkNearestBuilding(address, { lat: censusCoordinates.y, lon: censusCoordinates.x }),
  ]);

  if (!outcome.ok || !outcome.result.matched) {
    return { attempted: false, nominatim: null, placeDisagreement: false, distanceDisagreementMiles: null, building };
  }

  const nominatim = outcome.result;
  const placeMatches =
    !nominatim.place ||
    census.incorporatedPlaces.some((p) => namesEqual(stripPlaceTypeSuffix(p), nominatim.place!));
  const countyMatches =
    !nominatim.county ||
    census.counties.some((c) => namesEqual(stripCountySuffix(c), stripCountySuffix(nominatim.county!)));

  const distanceDisagreementMiles = nominatim.coordinates
    ? milesBetween({ lat: censusCoordinates.y, lon: censusCoordinates.x }, nominatim.coordinates)
    : null;

  return {
    attempted: true,
    nominatim,
    placeDisagreement: !placeMatches || !countyMatches,
    distanceDisagreementMiles,
    building,
  };
}

/**
 * Resolve a full street address (e.g. "2 Woodward Ave, Detroit, MI 48226")
 * into the certificate fields taxes/state.ts already knows how to read.
 * `role` controls whether MI/OH/MD/AL/KY-city local fields land as
 * workCity/residenceCity and PA's PSD lands as workPSD/residencePSD.
 * Kentucky's county half (certificate.workCounty, for the KRS 68.197
 * city-vs-county credit) is only ever populated on a 'work'-role call —
 * kentuckyLocalTax() has no residence-county concept.
 *
 * Sufficient on its own for MI, OH, IN, PA, MD, AL, and KY
 * (single-address-scoped taxes, though KY's credit needs a caller to
 * resolve the SAME work address for both city and county context — one
 * resolveAddress('work', ...) call already returns both fields together).
 * Use resolveEmployee() instead for NY/MO/NJ/OR/CO/WV, whose taxes are
 * keyed off a comparison between BOTH addresses, or a WORK-only locality
 * flag not captured by a plain workCity/residenceCity field — see this
 * module's own doc comment above.
 */
export async function resolveAddress(
  address: string,
  role: 'work' | 'residence',
  checkDate: string,
): Promise<AddressResolution> {
  const {
    resolved,
    matched,
    matchQuality,
    schoolDistrictLookupFailed,
    coordinates,
    geographies,
    precision,
    point,
    rooftop,
    rooftopJurisdictionChanges,
    coordinateSource,
  } = await geocodeAndResolve(address, checkDate);
  if (!matched) {
    return {
      address,
      matched: false,
      resolved: null,
      certificateFields: {},
      matchQuality: null,
      crossCheck: null,
      precision: 'interpolated',
      coordinates: null,
      geographies: null,
      coordinateSource: null,
      rooftop: null,
      jedd: null,
      fullyResolved: false,
      lowConfidenceReasons: ['Census could not match this address at all, even after retrying with any apartment/suite/unit designator stripped.'],
    };
  }

  const certificateFields = toCertificateFields(resolved, role);

  // Ohio only, and only for a WORK address: a JEDD taxes income earned
  // inside it, on land that belongs to no municipality. Asked at the
  // resolved point, which is exactly why the rooftop work matters here —
  // a JEDD boundary follows parcel lines around a development, and a
  // curb-interpolated point can easily sit on the wrong side of one.
  let jedd: JeddDistrict | null = null;
  const jeddReasons: string[] = [];
  if (resolved.state === 'OH' && role === 'work') {
    const decision = ohioJeddDecision({
      found: await jeddAtPoint(point.lat, point.lon),
      checkDate,
      counties: geographies.counties,
      places: geographies.incorporatedPlaces,
      municipalityMatched: resolved.ohMunicipality?.confidence === 'matched',
    });
    jedd = decision.jedd;
    if (decision.workJEDDId) certificateFields.workJEDDId = decision.workJEDDId;
    jeddReasons.push(...decision.reasons);
  }
  // Cross-checked at the point actually used, not at the one Census
  // guessed: when a rooftop point replaced it, that is the coordinate
  // whose plausibility a caller needs confirmed.
  const crossCheck = await runCrossCheck(address, geographies, { x: point.lon, y: point.lat });

  const lowConfidenceReasons: string[] = [];
  // Census had no address range for this one, so the point came from
  // OpenStreetMap and the jurisdictions were resolved by testing that
  // point against boundary polygons. That is a real answer — but it rests
  // on a crowd-sourced position rather than an official address range, so
  // a reviewer should know which of the two produced it.
  if (coordinateSource === 'osm-structured') {
    lowConfidenceReasons.push(
      "Census had no address range for this address, so OpenStreetMap's house-level point was used instead and the jurisdictions were resolved by testing that point against boundary polygons. The jurisdiction answer is a genuine point-in-polygon result; the POSITION it was tested at is crowd-sourced rather than official.",
    );
  }
  if (coordinateSource === 'osm-freeform') {
    lowConfidenceReasons.push(
      "Census had no address range for this address, and OpenStreetMap had no house-level point either — the position used is OSM's free-text result, which can be a street or town centroid rather than the building. Good enough to place the address in a city or county; NOT good enough to trust near a jurisdiction line.",
    );
  }
  const anyFieldAmbiguous = attemptedMatches(resolved).some((m) => m!.confidence === 'ambiguous');
  if (anyFieldAmbiguous) {
    lowConfidenceReasons.push('One or more jurisdiction fields matched more than one candidate — see the ambiguous FieldMatch(es) in `resolved` for the candidate list.');
  }
  // A no_match is only a failure where the registry covers the whole state.
  lowConfidenceReasons.push(...requiredFieldReasons(resolved));
  lowConfidenceReasons.push(...jeddReasons);
  // Only while Census's point is the one used: every better tier looks up
  // the address as submitted, so its point is for the right address even
  // when Census matched another one.
  const differences =
    precision === 'interpolated' ? matchedAddressDifferences(address, matchQuality.matchedAddress ?? '') : [];
  if (differences.length > 0) {
    lowConfidenceReasons.push(
      `Census matched "${matchQuality.matchedAddress}", which differs from the address given (${differences.join('; ')}) — it may have placed a different address. Confirm the address before trusting these jurisdictions.`,
    );
  }
  if (matchQuality.matchedViaFallback) {
    lowConfidenceReasons.push('Only matched after stripping an apartment/suite/unit designator — the interpolated position is for the base street address, not the specific unit.');
  }
  // Only meaningful while the interpolated point is the one being used:
  // a wide address range describes how loosely CENSUS positioned this
  // address, and says nothing about an authoritative point that replaced
  // it. Warning about it anyway would be describing a coordinate this
  // resolution didn't use.
  if (
    precision === 'interpolated' &&
    matchQuality.addressRangeWidth !== null &&
    matchQuality.addressRangeWidth > WIDE_ADDRESS_RANGE_THRESHOLD
  ) {
    lowConfidenceReasons.push(`Census interpolated this address within a wide address range (${matchQuality.addressRangeWidth} addresses on this block face) — less positionally precise than a narrow range, worth a second look if this address is near a jurisdiction boundary.`);
  }
  if (schoolDistrictLookupFailed) {
    lowConfidenceReasons.push('The Ohio school-district lookup (a separate Census service from the main geocoder) failed after retries — municipality/county resolution above is unaffected, but schoolDistrictCode was not attempted this call. Retry resolveAddress() to try again.');
  }
  if (crossCheck.placeDisagreement) {
    lowConfidenceReasons.push(`OpenStreetMap's independent geocoder resolved this address to a different place/county than Census did (Nominatim: ${crossCheck.nominatim?.place ?? '?'}, ${crossCheck.nominatim?.county ?? '?'}) — two independently-maintained datasets disagree, worth a second look before trusting either one.`);
  }
  if (crossCheck.distanceDisagreementMiles !== null && crossCheck.distanceDisagreementMiles > LARGE_DISTANCE_DISAGREEMENT_MILES) {
    lowConfidenceReasons.push(`OpenStreetMap's independent geocoder placed this address ${crossCheck.distanceDisagreementMiles.toFixed(2)} miles from Census's own coordinates — larger than ordinary interpolation slop, suggesting one of the two geocoders resolved a genuinely different location.`);
  }
  if (rooftopJurisdictionChanges.length > 0) {
    lowConfidenceReasons.push(
      `This address sits near a jurisdiction line: resolving it at ${describePoint(rooftop!)} (${rooftop!.metersFromInterpolated!.toFixed(0)}m from Census's interpolated position) produced DIFFERENT geographies — ${rooftopJurisdictionChanges.join('; ')}. The better point's answer is what's returned above; the interpolated answer is recorded here because a difference of this kind changes which local tax applies and deserves a human's eyes once.`,
    );
  }
  if (rooftop?.ambiguous) {
    lowConfidenceReasons.push(
      `The National Address Database has several points for this house number and street that are too far apart to be one building (${rooftop.match!.spreadMeters.toFixed(0)}m apart) — most likely the same address exists twice inside the search area. Census's interpolated position was kept rather than picking one of them.`,
    );
  }
  if (crossCheck.building.houseNumberGap !== null && crossCheck.building.houseNumberGap > LARGE_HOUSE_NUMBER_GAP) {
    const onStreet = crossCheck.building.onStreet!;
    lowConfidenceReasons.push(
      `The resolved point sits ${Math.round(onStreet.distanceMeters)}m from a mapped building tagged "${onStreet.houseNumber} ${onStreet.street}"` +
        (onStreet.name ? ` (${onStreet.name})` : '') +
        ` — ${crossCheck.building.houseNumberGap} house numbers from this address on the same street, which is numerically implausible for that distance. This is the check that caught a real Nominatim error on 90 W Broad St, Columbus (see buildings.ts); worth confirming the point landed on the right block before this address goes live.`,
    );
  }

  return {
    address,
    matched: true,
    resolved,
    certificateFields,
    matchQuality,
    crossCheck,
    precision,
    coordinates: point,
    geographies: {
      incorporatedPlaces: geographies.incorporatedPlaces,
      counties: geographies.counties,
    },
    coordinateSource,
    rooftop,
    jedd,
    fullyResolved: lowConfidenceReasons.length === 0,
    lowConfidenceReasons,
  };
}

export interface LocalityResolution {
  /** Set only when exactly one candidate fired — undefined on both zero and more-than-one. */
  locality: string | undefined;
  /** Set only when more than one candidate fired at once — see resolveLocalityCandidates()'s own doc comment. */
  conflictMessage: string | null;
}

/**
 * The single-slot arbitration behind certificate.locality — pulled out as
 * its own pure function (rather than left inline in resolveEmployee())
 * specifically so it can be unit-tested without a live Census call: the
 * conflict case it exists to catch (two different caller-resolved-locality
 * taxes both firing at once, e.g. a Kansas-City-work/Wilmington-residence
 * employee, or a Kansas-City-work/City-of-St.-Louis-residence employee
 * within Missouri itself) needs no network to construct — it only needs
 * the already-collected candidate set resolveEmployee() builds from both
 * addresses' flags and async boundary lookups.
 *
 * Zero candidates: no caller-resolved-locality tax applies — `locality` is
 * undefined, no conflict. Exactly one: the ordinary case — `locality` is
 * that candidate. More than one: a genuine conflict this function cannot
 * arbitrate on its own (certificate.locality is one string; two states'
 * worth of these taxes cannot both live on it) — `locality` stays
 * undefined and `conflictMessage` names every candidate, so the caller
 * builds separate work/residence certificates by hand instead of losing
 * whichever candidate a silent pick would have dropped.
 */
export function resolveLocalityCandidates(candidates: ReadonlySet<string>): LocalityResolution {
  if (candidates.size === 0) return { locality: undefined, conflictMessage: null };
  if (candidates.size === 1) return { locality: [...candidates][0], conflictMessage: null };
  return {
    locality: undefined,
    conflictMessage:
      `certificate.locality could not be set: this employee's work and residence addresses independently ` +
      `qualify for more than one caller-resolved-locality tax at once (${[...candidates].sort().join(', ')}), ` +
      `but certificate.locality is a single field and can only hold one value. Each of these needs its own ` +
      `certificate (build separate workState/residenceState certificates by hand from resolveAddress()'s own ` +
      `per-role output, one per state, rather than this function's single merged certificateFields) — resolving ` +
      `them onto one shared field here would silently drop whichever one lost.`,
  };
}

export interface EmployeeResolution {
  work: AddressResolution | null;
  residence: AddressResolution | null;
  /** The merged certificate object — everything from resolveAddress() for each role, PLUS the cross-address flags below. Feed this straight into PaycheckInput.workState.certificate. */
  certificateFields: Partial<StateCertificate>;
  /** Taxes this session confirmed CANNOT be resolved from Census/TIGERweb data at all (not a match failure — no boundary data exists for these). Surfaced so a caller doesn't mistake silence for "not applicable". */
  notResolvable: string[];
  /** Merged from both addresses' own AddressResolution.lowConfidenceReasons, each prefixed with which address it came from — empty when both addresses (that were supplied) resolved with full confidence. */
  lowConfidenceReasons: string[];
  /**
   * Boundary services that could not be reached this call (a subset of
   * notResolvable). Each is an UNKNOWN, not a "no tax here": the profile
   * may be missing a local tax until the lookup is retried.
   */
  lookupFailures: string[];
  /**
   * True only when every supplied address matched and resolved with full
   * confidence, no boundary lookup failed, and no locality conflict was
   * left for a human. A caller should not put a profile into production
   * payroll while this is false.
   */
  fullyResolved: boolean;
}

/**
 * Resolve an employee's work AND residence addresses together, applying
 * the cross-address business rules a single resolveAddress() call can't:
 *
 *   - New York City / Yonkers resident tax: RESIDENCE address only
 *     (nycLocalTax()/yonkersLocalTax()'s own doc comments — "applies to
 *     residents only").
 *   - Yonkers nonresident-worker tax: WORK address, and only when the
 *     residence address is NOT also Yonkers (the two are mutually
 *     exclusive per yonkersLocalTax()'s own doc comment).
 *   - Missouri Kansas City / St. Louis earnings tax, and Delaware's
 *     Wilmington Wage Tax: EITHER address (missouriLocalEarningsTax()'s/
 *     wilmingtonWageTax()'s own doc comments — "certificate.locality (the
 *     caller's own resolution of 'does this employee's residence OR work
 *     location put them in scope')").
 *   - Newark payroll tax: WORK address (an employer tax on services
 *     performed there).
 *   - Multnomah County Preschool For All tax: WORK address (Portland's own
 *     withholding guidance: "employees that work within Multnomah
 *     County" — confirmed directly, not assumed, since Metro's own
 *     guidance for the SHS tax uses the same "work within" framing).
 *   - West Virginia's Municipal Service Fee: WORK address (duty-station
 *     based, westVirginiaMunicipalServiceFee()'s own doc comment).
 *   - Colorado's Occupational Privilege Tax (Denver, Glendale, Greenwood
 *     Village, Sheridan, or Aurora — matched by whichever city the WORK
 *     address is actually in): sets certificate.locality to the matched
 *     city name, but coloradoOccupationalPrivilegeTax() ALSO needs
 *     certificate.localMonthlyCompensation and
 *     certificate.localOPTWithheldThisMonth — genuine payroll-history
 *     facts no address can supply, surfaced via notResolvable below
 *     rather than silently left unset with no explanation.
 *
 * Either address may be omitted (e.g. an employee who lives out of state
 * and whose residence-state taxes aren't modelled here) — every rule above
 * degrades gracefully to "that flag stays false" rather than throwing.
 */
export async function resolveEmployee(
  addresses: { work?: string; residence?: string },
  checkDate: string,
): Promise<EmployeeResolution> {
  const [work, residence] = await Promise.all([
    addresses.work ? resolveAddress(addresses.work, 'work', checkDate) : Promise.resolve(null),
    addresses.residence
      ? resolveAddress(addresses.residence, 'residence', checkDate)
      : Promise.resolve(null),
  ]);

  const fields: Partial<StateCertificate> = {
    ...(work?.certificateFields ?? {}),
    ...(residence?.certificateFields ?? {}),
  };

  const workFlags = work?.resolved?.flags;
  const residenceFlags = residence?.resolved?.flags;

  if (residenceFlags?.newYorkCity) fields.nycResident = true;

  if (residenceFlags?.yonkers) {
    fields.yonkersResident = true;
  } else if (workFlags?.yonkers) {
    fields.yonkersNonresidentWorker = true;
  }

  // certificate.locality is ONE shared string (see its own doc comment in
  // src/types.ts), but SEVERAL genuinely independent caller-resolved-
  // locality taxes can each try to claim it: Newark (NJ), Kansas City/
  // St. Louis (MO), Wilmington (DE), Seattle (WA), the Denver family (CO),
  // WV's six service-fee cities, and Oregon's transit districts. Within
  // one state these are mutually exclusive by construction (an address is
  // never in two of a state's own cities at once), but ACROSS states they
  // are not: an employee who works in Kansas City, MO and lives in
  // Wilmington, DE genuinely owes both cities' taxes, on two DIFFERENT
  // certificates (workState's and residenceState's) — and even within one
  // state, working in Kansas City while residing in the City of St. Louis
  // itself (not a suburb) genuinely owes both. Silently picking a winner
  // by evaluation order would drop a real, owed local tax with no signal
  // at all. So every candidate is collected here, and it is this
  // function's own job to say when more than one is on the table rather
  // than trusting whichever happened to run last — the same "explicit
  // conflict over a confidently wrong number" discipline
  // src/taxes/state.ts's own local-tax dispatch uses throughout.
  const localityCandidates = new Set<string>();
  if (workFlags?.newark) localityCandidates.add('Newark');
  if (workFlags?.kansasCity || residenceFlags?.kansasCity) localityCandidates.add('Kansas City');
  if (workFlags?.stLouis || residenceFlags?.stLouis) localityCandidates.add('St. Louis');
  if (workFlags?.wilmington || residenceFlags?.wilmington) localityCandidates.add('Wilmington');
  // Seattle's JumpStart payroll expense tax. Employer-paid, and banded by
  // BOTH the employer's prior-year Seattle payroll and the employee's own
  // annual compensation — neither of which an address can supply. Setting
  // the locality is what makes seattlePayrollExpenseTax() reachable at
  // all; the two figures it still needs are reported in notResolvable
  // below.
  if (workFlags?.seattle) localityCandidates.add('Seattle');
  if (work?.resolved?.wvServiceFeeCity) localityCandidates.add(work.resolved.wvServiceFeeCity);
  // Colorado's Occupational Privilege Tax: WORK address, duty-station
  // based like WV's service fee — same matched-name mechanism. Found
  // 2026-09-03: coloradoOccupationalPrivilegeTax() already computed all
  // five cities (Denver, Glendale, Greenwood Village, Sheridan, Aurora —
  // Aurora kept for its pre-2025-01-01 repeal date), but this resolver
  // used to set only Denver's boolean flag, leaving the other four
  // unreachable even though each is a plain Census incorporated place
  // needing no special boundary at all.
  if (work?.resolved?.coOptCity) localityCandidates.add(work.resolved.coOptCity);

  if (workFlags?.multnomahCounty) fields.multnomahCounty = true;

  const notResolvable: string[] = [];
  const lookupFailures: string[] = [];
  // A boundary service that didn't answer: unknown, reported both ways.
  const unreachable = (message: string) => {
    notResolvable.push(message);
    lookupFailures.push(message);
  };
  const workState = work?.resolved?.state ?? residence?.resolved?.state;
  if (workState === 'OR') {
    // Metro's district is not a Census geography — it covers the urban
    // parts of three counties and stops short of each one's full extent —
    // so it's resolved against the boundary Metro itself publishes. The
    // WORK address decides it: Metro's own withholding guidance keys the
    // SHS tax off where the work is performed, the same framing
    // multnomahCounty already uses above.
    const metroPoint = work?.coordinates ?? null;
    if (metroPoint) {
      const metro = await isInsidePortlandMetro(metroPoint.lat, metroPoint.lon);
      if (metro.attempted) {
        if (metro.inside) fields.metroDistrict = true;
      } else {
        unreachable(
          "Portland Metro's Supportive Housing Services district (certificate.metroDistrict) — Metro's own boundary service could not be reached this call, so this was NOT determined either way. Retry before treating its absence as 'outside the district'.",
        );
      }
    }
    // Oregon's local transit payroll tax districts — TriMet, LTD, SCTD,
    // Canby, Sandy, Wilsonville. All six are geographically disjoint (no
    // real address sits in two at once — each was established explicitly
    // to replace, not stack with, TriMet's own tax for that area, per
    // each district's own transit-tax guide), so there's no precedence
    // question in letting whichever check hits last win.
    if (metroPoint) {
      const transit = await oregonTransitDistrictAtPoint(metroPoint.lat, metroPoint.lon);
      if (transit.attempted) {
        if (transit.locality) localityCandidates.add(transit.locality);
      } else {
        unreachable(
          "Oregon's TriMet/LTD/SCTD transit payroll excises (certificate.locality) — ODOT's own jurisdictions service could not be reached this call, so this was NOT determined either way. Retry before treating its absence as 'outside every district'. (Canby/Sandy/Wilsonville below aren't affected by this — they're resolved separately.)",
        );
      }

      const canby = await isInsideCanbyTransitDistrict(metroPoint.lat, metroPoint.lon);
      if (canby.attempted) {
        if (canby.inside) localityCandidates.add('CanbyTransit');
      } else {
        unreachable(
          "Canby's transit payroll excise (certificate.locality = 'CanbyTransit') — Oregon's own UGB boundary service could not be reached this call, so this was NOT determined either way. Retry before treating its absence as 'outside the district'.",
        );
      }
    }
    // Sandy and Wilsonville are simply their own city limits — no special
    // boundary lookup needed, just the ordinary Census place match
    // already computed above as workFlags.sandy/wilsonville. Disjoint from
    // TriMet/LTD/SCTD/Canby above (see this block's own header comment),
    // so adding both a transit-district hit and one of these to the same
    // set never happens in practice — kept as a set anyway so a future
    // boundary change that broke that disjointness would surface as a
    // detected conflict below rather than a silent pick.
    if (workFlags?.sandy) localityCandidates.add('SandyTransit');
    if (workFlags?.wilsonville) localityCandidates.add('SMART');
  }
  if (workFlags?.seattle) {
    notResolvable.push(
      "Seattle's JumpStart payroll expense tax needs input.employer.seattlePriorYearPayrollExpense (which rate tier " +
        "the employer falls in) and input.ytd.seattleCompensation (this employee's Seattle pay so far this year). " +
        "Both are payroll facts no address can answer. certificate.locality was set to 'Seattle'; those two still need caller input.",
    );
  }
  if (work?.resolved?.coOptCity) {
    notResolvable.push(
      `${work.resolved.coOptCity}'s Occupational Privilege Tax needs certificate.localMonthlyCompensation (this month's cumulative pay so far in the district) and certificate.localOPTWithheldThisMonth — real payroll-history facts, not something any address can supply. certificate.locality was set to '${work.resolved.coOptCity}'; those two fields still need caller input.`,
    );
  }

  // Resolve the collected candidates LAST, once every synchronous flag and
  // every async boundary lookup above has had its say — see
  // resolveLocalityCandidates()'s own doc comment for what each outcome
  // means.
  const settled = resolveLocalityCandidates(localityCandidates);
  if (settled.locality) fields.locality = settled.locality;
  if (settled.conflictMessage) notResolvable.push(settled.conflictMessage);

  const lowConfidenceReasons = [
    ...(work?.lowConfidenceReasons ?? []).map((r) => `Work address: ${r}`),
    ...(residence?.lowConfidenceReasons ?? []).map((r) => `Residence address: ${r}`),
  ];

  const supplied = [work, residence].filter((r): r is AddressResolution => r !== null);
  const fullyResolved =
    supplied.length > 0 &&
    supplied.every((r) => r.matched && r.fullyResolved) &&
    lookupFailures.length === 0 &&
    !settled.conflictMessage;

  return { work, residence, certificateFields: fields, notResolvable, lowConfidenceReasons, lookupFailures, fullyResolved };
}
