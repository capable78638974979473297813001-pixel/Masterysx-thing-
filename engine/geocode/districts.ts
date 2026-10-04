/**
 * Taxing districts that are NOT Census geographies.
 *
 * Everything else in this module resolves jurisdictions out of Census
 * data — states, counties, county subdivisions, incorporated places,
 * school districts. That works because most local payroll taxes are
 * levied by exactly those bodies. Some are not. A regional government or
 * a transit district draws its own boundary, files it nowhere Census
 * publishes, and taxes wages inside it anyway. For those, a correct
 * address point and a perfect Census lookup still produce the wrong
 * answer — not because the geocoding failed, but because the boundary
 * isn't in the data being searched.
 *
 * This module holds point-in-district checks against the boundaries
 * those governments publish themselves. Each entry names the service it
 * queries, because provenance is the whole argument for trusting it: an
 * arbitrary polygon from a third party would be worse than admitting the
 * boundary is unknown.
 *
 * COVERED HERE:
 *   - Portland Metro's district, which is what Metro's Supportive
 *     Housing Services personal income tax is levied inside. Published
 *     by Metro itself as part of RLIS, its regional GIS.
 *   - Ohio's JEDDs and JEDZs — joint economic development districts and
 *     zones, the contractual arrangement that lets a municipality tax
 *     income earned on adjoining UNINCORPORATED township land without
 *     annexing it. There is no municipality at that address, so no
 *     amount of Census place matching will ever find the tax. Ohio
 *     publishes all 142 boundaries as a statewide service on its own
 *     ArcGIS server, keyed by the same jedd_id that
 *     data/local/OH-jedd-jedz-2026.json (downloaded from Ohio's Finder
 *     rate database) uses — so the boundary lookup and the rate table
 *     join on an ID rather than on a name, exactly.
 *
 *   - Oregon's LOCAL TRANSIT PAYROLL TAX DISTRICTS. Researched nationally
 *     first (2026-09-03): this "a district funds itself via employer
 *     payroll tax rather than property/sales tax" mechanism turns out to
 *     be genuinely Oregon-specific — no other state does this. But Oregon
 *     itself has more of it than this project had modelled: not just
 *     TriMet and LTD, but Canby, Sandy, South Clackamas (SCTD), and
 *     Wilsonville (SMART) all levy the same kind of employer excise.
 *     Checked each of Oregon's OTHER transportation districts (Basin
 *     Transit, Grant County, Hood River County, Lincoln County, Rogue
 *     Valley, Salem/SAMTD, Sunset Empire, Tillamook County) directly and
 *     confirmed they fund themselves via PROPERTY TAX, not payroll —
 *     verified for Tillamook ("a property tax levy of twenty cents per
 *     thousand assessed valuation"), Hood River County ("local property
 *     tax, fare revenue... Federal and State funds", no payroll mention),
 *     and Basin Transit ("roughly 30% of its funding from a local
 *     property tax rate... the BTS Transportation District" — its
 *     "payroll tax" mentions turned out to be Oregon's existing STATEWIDE
 *     transit tax, already modelled as OR_STT, not a district-specific
 *     one). The remaining three (Grant County, Lincoln County, Sunset
 *     Empire) share the same rural-county-district profile as the
 *     confirmed three and were not independently re-verified one-by-one —
 *     disclosed as pattern-matched, not exhaustively primary-sourced,
 *     unlike the three that were.
 *
 *     Found ONE unified live source for the payroll-tax-funded ones: the
 *     Oregon Department of Transportation's own statewide "jurisdictions"
 *     layer (gis.odot.state.or.us) carries every Oregon transportation
 *     district — payroll-funded and property-funded alike — as named
 *     polygons with a JRSDCT_TYP=6 ("transportation district") code.
 *     oregonTransitDistrictAtPoint() below queries it and maps the
 *     PAYROLL-FUNDED subset (TriMet, LTD, SCTD) to this engine's
 *     certificate.locality values, while deliberately never matching the
 *     property-funded ones even though they're the same layer — setting
 *     locality for one of those would fabricate a payroll tax that
 *     doesn't exist. This REPLACES two earlier, separate approaches: LTD
 *     used to be resolved against RLID's own regional boundary service,
 *     and TriMet used to be resolved against a vendored copy of its own
 *     KML boundary file with a hand-written point-in-polygon check (both
 *     worked, both are now redundant with this one statewide source,
 *     which additionally removes the vendored file's own refresh
 *     commitment entirely — a live query never goes stale).
 *
 *     Canby's district is NOT in the ODOT layer above — checked directly,
 *     genuinely absent — because Canby's own transit tax boundary is NOT
 *     the "Canby" city-limits polygon that layer's JRSDCT_TYP=1 entries
 *     hold; it's the Canby URBAN GROWTH BOUNDARY, explicitly described by
 *     Canby's own transit-tax guide as "the Canby Urban Growth Boundary –
 *     an area including and extending somewhat beyond the city limits of
 *     Canby." That's a different, genuinely separate boundary type, so
 *     isInsideCanbyTransitDistrict() below queries Oregon's own statewide
 *     UGB layer (published by DLCD, the Department of Land Conservation
 *     and Development) instead. Sandy and Wilsonville, by contrast, ARE
 *     simply their own city limits (confirmed directly from each city's
 *     own transit-tax guide) — so those two need no special boundary
 *     lookup at all; they're resolved the ordinary way, through Census
 *     incorporated-place matching, the same as Denver's or Seattle's
 *     local taxes.
 */
import type { FetchOptions } from './census.ts';

/**
 * Metro's own regional GIS (RLIS), layer 3 of its public boundary
 * service. Verified live against three points: downtown Portland and
 * Beaverton both fall inside; Salem, an hour south, does not.
 */
const METRO_BOUNDARY_LAYER =
  'https://gis.oregonmetro.gov/arcgis/rest/services/OpenData/BoundaryDataWebMerc/MapServer/3/query';

/**
 * Ohio's own JEDD/JEDZ boundary service, published by the state on
 * maps.ohio.gov. 142 polygons, each carrying the `jedd_id` that Ohio's
 * Finder rate database uses as its key. Verified live: a point taken
 * inside the Bath-Akron-Fairlawn JEDD's own published geometry comes back
 * as jedd_id 9004, the same id its rate row carries.
 */
const OHIO_JEDD_LAYER = 'https://maps.ohio.gov/arcgis/rest/services/Tax/JEDDJEDZ/MapServer/0/query';

/**
 * ODOT's own statewide transportation-jurisdictions layer — every Oregon
 * transportation/transit district, JRSDCT_TYP=6, alongside cities
 * (TYP=1), counties (TYP=2), and other jurisdiction types this project
 * doesn't need. Verified live: a Molalla point returns "South Clackamas
 * Transit District" (and Clackamas County, and Molalla the city — all
 * three genuinely contain the point, which is normal for nested
 * jurisdictions); a Portland point returns "Tri County Metropolitan Mass
 * Transit District of Oregon", not SCTD.
 */
const ODOT_TRANSIT_DISTRICTS_LAYER = 'https://gis.odot.state.or.us/arcgis1006/rest/services/tpod/jurisdictions/MapServer/0/query';

/**
 * Oregon's own statewide Urban Growth Boundary layer, published by DLCD
 * (Dept of Land Conservation and Development) — the authority that
 * actually draws UGBs, not a derived or third-party copy. Verified live:
 * a downtown-Canby point returns the "Canby" UGB; a downtown-Portland
 * point returns the (correctly different) "Metro" UGB, not Canby's.
 */
const CANBY_UGB_LAYER =
  'https://gis.lcd.state.or.us/server/rest/services/Framework/AdminBounds_UrbanGrowthBoundaries/MapServer/0/query';

/**
 * The payroll-tax-funded subset of ODOT's JRSDCT_TYP=6 layer, mapped to
 * this engine's certificate.locality values. Every other TYP=6 name in
 * that layer (Basin Transit, Grant County, Hood River County, Lincoln
 * County, Rogue Valley, Salem/SAMTD, Sunset Empire, Tillamook County) is
 * deliberately NOT in this table — see this file's own top comment for
 * why those fund themselves via property tax instead, and setting
 * locality for one would fabricate a tax that doesn't exist.
 */
const OREGON_PAYROLL_TRANSIT_DISTRICTS: Record<string, string> = {
  'Tri County Metropolitan Mass Transit District of Oregon': 'TriMet',
  'Lane Transit District': 'LTD',
  'South Clackamas Transit District': 'SCTD',
};

export interface JeddDistrict {
  name: string;
  /** Ohio's own id for the zone — the exact join key into data/local/OH-jedd-jedz-YYYY.json. */
  jeddId: string;
  active: boolean;
}

export interface JeddCheck {
  /** false when Ohio's boundary service couldn't be reached — NOT a claim that the address is outside every JEDD. */
  attempted: boolean;
  /**
   * The one zone containing the point. Null when there is none — and also
   * when several ACTIVE zones overlap here (see `ambiguous`), since which
   * one taxes the address can't be decided from feature order.
   */
  jedd: JeddDistrict | null;
  /** Every distinct zone the layer returned for this point (present when attempted). */
  candidates?: JeddDistrict[];
  /** True when more than one distinct active zone contains the point. */
  ambiguous?: boolean;
}

export interface DistrictCheck {
  /** false when the publishing government's service couldn't be reached — NOT a claim that the address is outside the district. A caller must treat this as "unknown", the same convention every other optional lookup here uses. */
  attempted: boolean;
  inside: boolean;
}

export interface OregonTransitDistrictCheck {
  /** false when ODOT's own service couldn't be reached — NOT a claim that the address is outside every payroll-tax district. */
  attempted: boolean;
  /** One of 'TriMet' | 'LTD' | 'SCTD', or null when the point isn't inside any payroll-tax-funded Oregon transit district (which includes sitting inside a property-tax-funded one like Rogue Valley or Tillamook — that's a real "no payroll tax here" answer, not an unknown). */
  locality: string | null;
}

async function fetchWithRetry(
  url: string,
  fetchImpl: typeof fetch,
  { retries = 1, timeoutMs = 20_000, baseBackoffMs = 400 }: FetchOptions = {},
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

/**
 * Ask an ArcGIS layer whether a point falls inside any of its polygons.
 * Deliberately asks for no attributes and no geometry: the only thing
 * this needs is whether the intersection returned anything, and a
 * boundary layer's own field names are nobody else's business.
 */
async function pointIsInsideLayer(
  layerQueryUrl: string,
  lat: number,
  lon: number,
  fetchImpl: typeof fetch,
  retryOptions: FetchOptions,
): Promise<DistrictCheck> {
  const url = new URL(layerQueryUrl);
  url.searchParams.set('geometry', JSON.stringify({ x: lon, y: lat, spatialReference: { wkid: 4326 } }));
  url.searchParams.set('geometryType', 'esriGeometryPoint');
  url.searchParams.set('inSR', '4326');
  url.searchParams.set('spatialRel', 'esriSpatialRelIntersects');
  url.searchParams.set('returnGeometry', 'false');
  url.searchParams.set('returnIdsOnly', 'true');
  url.searchParams.set('f', 'json');

  try {
    const res = await fetchWithRetry(url.toString(), fetchImpl, retryOptions);
    if (!res.ok) return { attempted: false, inside: false };
    const body = (await res.json()) as {
      error?: unknown;
      objectIds?: number[] | null;
      features?: unknown[];
    };
    if (body.error) return { attempted: false, inside: false };
    // returnIdsOnly answers with objectIds; some servers ignore it and
    // answer with features anyway, so both shapes count.
    const hits = body.objectIds?.length ?? body.features?.length ?? 0;
    return { attempted: true, inside: hits > 0 };
  } catch {
    return { attempted: false, inside: false };
  }
}

/**
 * Is this point inside Portland Metro's district — i.e. does Metro's
 * Supportive Housing Services tax apply to work performed here?
 *
 * Metro's district is not a county, not a city, and not a Census place:
 * it covers the urban parts of Clackamas, Multnomah and Washington
 * counties and stops well short of each county's full extent, which is
 * why no combination of Census layers can stand in for it. Never throws.
 */
export async function isInsidePortlandMetro(
  lat: number,
  lon: number,
  fetchImpl: typeof fetch = fetch,
  retryOptions: FetchOptions = {},
): Promise<DistrictCheck> {
  return pointIsInsideLayer(METRO_BOUNDARY_LAYER, lat, lon, fetchImpl, retryOptions);
}

/**
 * Is this point inside Canby's transit tax district — i.e. the Canby
 * Urban Growth Boundary, NOT simply Canby city limits (see this file's
 * own top comment for why those are genuinely different boundaries
 * here). Queries Oregon's own statewide UGB layer, published by DLCD.
 * Never throws.
 */
export async function isInsideCanbyTransitDistrict(
  lat: number,
  lon: number,
  fetchImpl: typeof fetch = fetch,
  retryOptions: FetchOptions = {},
): Promise<DistrictCheck> {
  const url = new URL(CANBY_UGB_LAYER);
  url.searchParams.set('geometry', JSON.stringify({ x: lon, y: lat, spatialReference: { wkid: 4326 } }));
  url.searchParams.set('geometryType', 'esriGeometryPoint');
  url.searchParams.set('inSR', '4326');
  url.searchParams.set('spatialRel', 'esriSpatialRelIntersects');
  url.searchParams.set('outFields', 'NAME');
  url.searchParams.set('returnGeometry', 'false');
  url.searchParams.set('f', 'json');

  try {
    const res = await fetchWithRetry(url.toString(), fetchImpl, retryOptions);
    if (!res.ok) return { attempted: false, inside: false };
    const body = (await res.json()) as { error?: unknown; features?: { attributes?: { NAME?: string } }[] };
    if (body.error) return { attempted: false, inside: false };
    // The UGB layer covers every Oregon city's UGB, not just Canby's — a
    // point can legitimately sit inside SOME city's UGB (e.g. Portland's,
    // returned as "Metro") without being inside Canby's. Only Canby's own
    // named UGB counts.
    const inside = (body.features ?? []).some((f) => f.attributes?.NAME === 'Canby');
    return { attempted: true, inside };
  } catch {
    return { attempted: false, inside: false };
  }
}

/**
 * Which Oregon local transit payroll tax district (if any) this point
 * falls inside — TriMet, LTD, or SCTD, the three that actually levy an
 * employer payroll excise. See this file's own top comment for how the
 * other Oregon transportation districts in the same source layer were
 * checked and confirmed property-tax-funded instead, and therefore
 * deliberately excluded here. Never throws.
 */
export async function oregonTransitDistrictAtPoint(
  lat: number,
  lon: number,
  fetchImpl: typeof fetch = fetch,
  retryOptions: FetchOptions = {},
): Promise<OregonTransitDistrictCheck> {
  const url = new URL(ODOT_TRANSIT_DISTRICTS_LAYER);
  url.searchParams.set('geometry', JSON.stringify({ x: lon, y: lat, spatialReference: { wkid: 4326 } }));
  url.searchParams.set('geometryType', 'esriGeometryPoint');
  url.searchParams.set('inSR', '4326');
  url.searchParams.set('spatialRel', 'esriSpatialRelIntersects');
  url.searchParams.set('where', 'JRSDCT_TYP=6');
  url.searchParams.set('outFields', 'JRSDCT_NM');
  url.searchParams.set('returnGeometry', 'false');
  url.searchParams.set('f', 'json');

  try {
    const res = await fetchWithRetry(url.toString(), fetchImpl, retryOptions);
    if (!res.ok) return { attempted: false, locality: null };
    const body = (await res.json()) as { error?: unknown; features?: { attributes?: { JRSDCT_NM?: string } }[] };
    if (body.error) return { attempted: false, locality: null };

    for (const feature of body.features ?? []) {
      const name = feature.attributes?.JRSDCT_NM;
      const locality = name ? OREGON_PAYROLL_TRANSIT_DISTRICTS[name] : undefined;
      if (locality) return { attempted: true, locality };
    }
    // Reached a real answer of "no payroll-tax district here" — including
    // when the point IS inside a property-tax-funded one (Rogue Valley,
    // Tillamook, etc.) that simply isn't in the lookup table above.
    return { attempted: true, locality: null };
  } catch {
    return { attempted: false, locality: null };
  }
}

/**
 * Which Ohio JEDD/JEDZ, if any, contains this point.
 *
 * This is the lookup that makes the JEDD rate table usable at all: the
 * zones cover unincorporated township land, so an address inside one
 * resolves to NO incorporated place, and every municipality-name match in
 * resolve.ts correctly finds nothing. The tax is real regardless — a JEDD
 * levies at a municipal rate on income earned inside it. Never throws.
 */
export async function jeddAtPoint(
  lat: number,
  lon: number,
  fetchImpl: typeof fetch = fetch,
  retryOptions: FetchOptions = {},
): Promise<JeddCheck> {
  const url = new URL(OHIO_JEDD_LAYER);
  url.searchParams.set('geometry', JSON.stringify({ x: lon, y: lat, spatialReference: { wkid: 4326 } }));
  url.searchParams.set('geometryType', 'esriGeometryPoint');
  url.searchParams.set('inSR', '4326');
  url.searchParams.set('spatialRel', 'esriSpatialRelIntersects');
  url.searchParams.set('outFields', 'name,jedd_id,active');
  url.searchParams.set('returnGeometry', 'false');
  url.searchParams.set('f', 'json');

  try {
    const res = await fetchWithRetry(url.toString(), fetchImpl, retryOptions);
    if (!res.ok) return { attempted: false, jedd: null };
    const body = (await res.json()) as {
      error?: unknown;
      features?: { attributes?: { name?: string; jedd_id?: number | string; active?: string } }[];
    };
    if (body.error) return { attempted: false, jedd: null };

    // Every feature, not just the first: if polygons overlap, the answer
    // must not depend on the order the service happens to return them.
    const candidates: JeddDistrict[] = [];
    for (const feature of body.features ?? []) {
      const hit = feature.attributes;
      if (!hit || hit.jedd_id === undefined || hit.jedd_id === null) continue;
      const jeddId = String(hit.jedd_id);
      if (candidates.some((c) => c.jeddId === jeddId)) continue;
      candidates.push({
        name: (hit.name ?? '').trim(),
        jeddId,
        // Ohio ships this as a "Y"/"N" flag; an inactive zone stays
        // reported rather than hidden, so a caller can see WHY no tax
        // applies instead of seeing nothing at all.
        active: (hit.active ?? '').toUpperCase() === 'Y',
      });
    }
    if (candidates.length === 0) return { attempted: true, jedd: null, candidates, ambiguous: false };
    const active = candidates.filter((c) => c.active);
    if (active.length > 1) return { attempted: true, jedd: null, candidates, ambiguous: true };
    // One active zone wins over inactive leftovers; with none active, the
    // (single, or first inactive) zone is reported so the reason is visible.
    return { attempted: true, jedd: active[0] ?? candidates[0], candidates, ambiguous: false };
  } catch {
    return { attempted: false, jedd: null };
  }
}

export { METRO_BOUNDARY_LAYER, OHIO_JEDD_LAYER, ODOT_TRANSIT_DISTRICTS_LAYER, CANBY_UGB_LAYER };
