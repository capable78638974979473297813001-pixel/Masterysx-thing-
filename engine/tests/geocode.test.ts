import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  namesEqual,
  schoolDistrictKeyFromCensusName,
  schoolDistrictKeyFromDataFileName,
  schoolDistrictKeysMatch,
  stripCountySuffix,
  stripParenthetical,
  stripPlaceTypeSuffix,
  toMDCountyKey,
  toPAMunicipalityForm,
} from '../geocode/normalize.ts';
import {
  resolveJurisdiction,
  toCertificateFields,
  type CensusGeographies,
} from '../geocode/resolve.ts';
import {
  fetchSchoolDistrictAtPointSafe,
  geocodeAddress,
  matchedAddressDifferences,
  normalizeAddress,
  stripSecondaryUnit,
} from '../geocode/census.ts';
import { crossCheckAddress, crossCheckSafe, milesBetween } from '../geocode/nominatim.ts';
import {
  LARGE_HOUSE_NUMBER_GAP,
  checkNearestBuilding,
  extractHouseNumber,
  extractStreet,
  fetchNearbyBuildings,
  nearestBuilding,
  nearestBuildingOnStreet,
  streetKey,
} from '../geocode/buildings.ts';
import {
  fetchAddressPointsNear,
  matchAddressPoint,
  neighborBracket,
  parseAddressParts,
  resolveRooftop,
} from '../geocode/rooftop.ts';
import { resolveParcelCentroid, PARCEL_SOURCES } from '../geocode/parcel.ts';
import {
  isInsideCanbyTransitDistrict,
  isInsidePortlandMetro,
  jeddAtPoint,
  oregonTransitDistrictAtPoint,
} from '../geocode/districts.ts';
import { resolveLocalityCandidates } from '../geocode/index.ts';

const CHECK_DATE = '2026-08-15';

/**
 * Every geography object below is a trimmed, hand-verified transcription of
 * a REAL response from geocoding.geo.census.gov, captured live this
 * session (not invented) — e.g. Bluffton:
 *   curl 'https://geocoding.geo.census.gov/geocoder/geographies/onelineaddress
 *   ?address=136+N+Main+St,+Bluffton,+OH+45817&benchmark=Public_AR_Current
 *   &vintage=Current_Current&format=json'
 * returned Incorporated Places=["Bluffton village"], County Subdivisions=
 * ["Richland township"], Counties=["Allen County"], States[0].STUSAB="OH".
 * The school district name ("Bluffton Exempted Village School District")
 * is a real TIGERweb identify() result at that same address's resolved
 * coordinates (-83.890750603619, 40.894159987441), layer 14 (Unified
 * School Districts) — school districts are NOT in the geocoder's own
 * response; see census.ts's own doc comment for why a second service call
 * is required.
 */
describe('normalize.ts', () => {
  test('stripParenthetical removes a trailing annotation', () => {
    assert.equal(stripParenthetical('Bluffton EVSD (expires 2028)'), 'Bluffton EVSD');
    assert.equal(stripParenthetical('Columbus Grove LSD'), 'Columbus Grove LSD');
  });

  test('stripPlaceTypeSuffix handles Census\'s place-type qualifiers, including the compound "city (balance)" case', () => {
    assert.equal(stripPlaceTypeSuffix('Bluffton village'), 'Bluffton');
    assert.equal(stripPlaceTypeSuffix('Detroit city'), 'Detroit');
    assert.equal(stripPlaceTypeSuffix('Indianapolis city (balance)'), 'Indianapolis');
    assert.equal(stripPlaceTypeSuffix('Abington township'), 'Abington');
  });

  test('stripCountySuffix', () => {
    assert.equal(stripCountySuffix('Marion County'), 'Marion');
    assert.equal(stripCountySuffix('Allen County'), 'Allen');
  });

  test('namesEqual is case/whitespace-insensitive', () => {
    assert.equal(namesEqual('Columbus', ' columbus '), true);
    assert.equal(namesEqual('Columbus', 'Columbus Grove'), false);
  });

  test('toPAMunicipalityForm matches PA-EIT-LST-2026.json\'s own abbreviated convention', () => {
    assert.equal(toPAMunicipalityForm('Abington township'), 'ABINGTON TWP');
    assert.equal(toPAMunicipalityForm('Abbottstown borough'), 'ABBOTTSTOWN BORO');
  });

  test('toMDCountyKey matches MD-2026.json\'s own camelCase countyRates keys, including the Baltimore City/County special case', () => {
    assert.equal(toMDCountyKey('Anne Arundel County'), 'AnneArundel');
    assert.equal(toMDCountyKey("Prince George's County"), 'PrinceGeorges');
    assert.equal(toMDCountyKey("St. Mary's County"), 'StMarys');
    assert.equal(toMDCountyKey("Queen Anne's County"), 'QueenAnnes');
    assert.equal(toMDCountyKey('Montgomery County'), 'Montgomery');
    // The one deliberate exception: MD-2026.json keeps "County"/"City" on
    // Baltimore specifically because the two are different, adjacent
    // jurisdictions that are easy to conflate.
    assert.equal(toMDCountyKey('Baltimore County'), 'BaltimoreCounty');
    assert.equal(toMDCountyKey('Baltimore city'), 'BaltimoreCity');
  });

  test('Ohio school district keys match across genuinely different vocabularies on each side', () => {
    const census = schoolDistrictKeyFromCensusName('Bluffton Exempted Village School District');
    const dataFile = schoolDistrictKeyFromDataFileName('Bluffton EVSD (expires 2028)');
    assert.deepEqual(census, { base: 'BLUFFTON', type: 'EVSD' });
    assert.deepEqual(dataFile, { base: 'BLUFFTON', type: 'EVSD' });
    assert.equal(schoolDistrictKeysMatch(census, dataFile), true);
  });

  test('school district keys do NOT match a different district', () => {
    const census = schoolDistrictKeyFromCensusName('Columbus City School District');
    const bluffton = schoolDistrictKeyFromDataFileName('Bluffton EVSD (expires 2028)');
    assert.equal(schoolDistrictKeysMatch(census, bluffton), false);
  });
});

describe('resolve.ts — real captured Census geographies', () => {
  test('Bluffton, OH: resolves BOTH a real municipal match and a real SDIT match at once', () => {
    const geo: CensusGeographies = {
      state: 'OH',
      incorporatedPlaces: ['Bluffton village'],
      countySubdivisions: ['Richland township'],
      counties: ['Allen County'],
    };
    const resolved = resolveJurisdiction(geo, CHECK_DATE, 'Bluffton Exempted Village School District');

    assert.equal(resolved.ohMunicipality?.confidence, 'matched');
    assert.equal(resolved.ohMunicipality?.entry?.name, 'Bluffton');
    assert.equal(resolved.ohMunicipality?.entry?.rate, 0.0165);
    assert.equal(resolved.ohSchoolDistrict?.confidence, 'matched');
    assert.equal(resolved.ohSchoolDistrict?.entry?.sdNumber, '0203');
    assert.equal(resolved.ohSchoolDistrict?.entry?.rate2026, 0.005);

    const fields = toCertificateFields(resolved, 'work');
    assert.equal(fields.workCity, 'Bluffton');
    assert.equal(fields.schoolDistrictCode, '0203');
  });

  test('Columbus, OH: resolves to a real municipal match, and a school district NAME that correctly finds no SDIT levy', () => {
    const geo: CensusGeographies = {
      state: 'OH',
      incorporatedPlaces: ['Columbus city'],
      countySubdivisions: ['Columbus city'],
      counties: ['Franklin County'],
    };
    // Real TIGERweb identify() result for downtown Columbus — Columbus
    // City School District does not levy SDIT (only 214 of Ohio's 600+
    // districts do), so a real, correctly-resolved district name should
    // still produce no_match here, not an error.
    const resolved = resolveJurisdiction(geo, CHECK_DATE, 'Columbus City School District');

    assert.equal(resolved.ohMunicipality?.confidence, 'matched');
    assert.equal(resolved.ohMunicipality?.entry?.name, 'Columbus');
    assert.equal(resolved.ohMunicipality?.entry?.rate, 0.025);
    assert.equal(resolved.ohSchoolDistrict?.confidence, 'no_match');

    const fields = toCertificateFields(resolved, 'work');
    assert.equal(fields.workCity, 'Columbus');
    assert.equal(fields.schoolDistrictCode, undefined);
  });

  test('Indianapolis, IN: resolves to a county match (Indiana taxes by county, not city)', () => {
    const geo: CensusGeographies = {
      state: 'IN',
      incorporatedPlaces: ['Indianapolis city (balance)'],
      countySubdivisions: ['Center township'],
      counties: ['Marion County'],
    };
    const resolved = resolveJurisdiction(geo, CHECK_DATE);
    assert.equal(resolved.county?.confidence, 'matched');
    assert.equal(resolved.county?.entry?.name, 'Marion');

    const fields = toCertificateFields(resolved, 'work');
    assert.equal(fields.county, 'Marion');
  });

  test('Detroit, MI: resolves to a real MI city match', () => {
    const geo: CensusGeographies = {
      state: 'MI',
      incorporatedPlaces: ['Detroit city'],
      countySubdivisions: ['Detroit city'],
      counties: ['Wayne County'],
    };
    const resolved = resolveJurisdiction(geo, CHECK_DATE);
    assert.equal(resolved.miCity?.confidence, 'matched');
    assert.equal(resolved.miCity?.entry?.name, 'Detroit');
    assert.equal(resolved.miCity?.entry?.residentRate, 0.024);

    const fields = toCertificateFields(resolved, 'residence');
    assert.equal(fields.residenceCity, 'Detroit');
  });

  test('Abington, PA: resolves to a real PSD code via county+municipality join', () => {
    const geo: CensusGeographies = {
      state: 'PA',
      incorporatedPlaces: [], // PA townships aren't "Incorporated Places" in Census's own terms
      countySubdivisions: ['Abington township'],
      counties: ['Montgomery County'],
    };
    const resolved = resolveJurisdiction(geo, CHECK_DATE);
    assert.equal(resolved.paJurisdiction?.confidence, 'matched');
    assert.equal(resolved.paJurisdiction?.entry?.psdCode, '460101');
    assert.equal(resolved.paJurisdiction?.entry?.municipality, 'ABINGTON TWP');

    const fields = toCertificateFields(resolved, 'work');
    assert.equal(fields.workPSD, '460101');
  });

  test('a state with no local registry wired (e.g. Texas) resolves every field to null, not a false no_match', () => {
    const geo: CensusGeographies = {
      state: 'TX',
      incorporatedPlaces: ['Austin city'],
      countySubdivisions: [],
      counties: ['Travis County'],
    };
    const resolved = resolveJurisdiction(geo, CHECK_DATE);
    assert.equal(resolved.miCity, null);
    assert.equal(resolved.ohMunicipality, null);
    assert.equal(resolved.county, null);
    assert.equal(resolved.paJurisdiction, null);
    assert.deepEqual(toCertificateFields(resolved, 'work'), {});
  });

  test('an unrecognised place name produces no_match, never a guess', () => {
    const geo: CensusGeographies = {
      state: 'MI',
      incorporatedPlaces: ['Nowhereville city'],
      countySubdivisions: [],
      counties: ['Wayne County'],
    };
    const resolved = resolveJurisdiction(geo, CHECK_DATE);
    assert.equal(resolved.miCity?.confidence, 'no_match');
    assert.equal(resolved.miCity?.entry, null);
  });

  // Real captured responses: Baltimore MD (independent city, no county),
  // Rockville MD (ordinary city inside a real county), St. Louis MO
  // (independent city), Kansas City MO (ordinary city inside Jackson
  // County), Newark NJ, Yonkers NY, midtown Manhattan NY, downtown
  // Portland OR (inside Multnomah County).
  test('Baltimore, MD: resolves via the Incorporated Places layer to BaltimoreCity, not BaltimoreCounty', () => {
    const geo: CensusGeographies = {
      state: 'MD',
      incorporatedPlaces: ['Baltimore city'],
      countySubdivisions: [],
      counties: ['Baltimore city'],
    };
    const resolved = resolveJurisdiction(geo, CHECK_DATE);
    assert.equal(resolved.mdCounty?.confidence, 'matched');
    assert.equal(resolved.mdCounty?.entry, 'BaltimoreCity');
    assert.deepEqual(toCertificateFields(resolved, 'residence'), { county: 'BaltimoreCity' });
  });

  test('Rockville, MD: an ordinary city resolves via the county it sits inside, not the city name', () => {
    const geo: CensusGeographies = {
      state: 'MD',
      incorporatedPlaces: ['Rockville city'],
      countySubdivisions: [],
      counties: ['Montgomery County'],
    };
    const resolved = resolveJurisdiction(geo, CHECK_DATE);
    assert.equal(resolved.mdCounty?.confidence, 'matched');
    assert.equal(resolved.mdCounty?.entry, 'Montgomery');
  });

  test('New York City: sets the newYorkCity flag from Incorporated Places', () => {
    const geo: CensusGeographies = {
      state: 'NY',
      incorporatedPlaces: ['New York city'],
      countySubdivisions: [],
      counties: ['New York County'],
    };
    const resolved = resolveJurisdiction(geo, CHECK_DATE);
    assert.equal(resolved.flags.newYorkCity, true);
    assert.equal(resolved.flags.yonkers, false);
  });

  test('Yonkers, NY: sets the yonkers flag, not the newYorkCity flag', () => {
    const geo: CensusGeographies = {
      state: 'NY',
      incorporatedPlaces: ['Yonkers city'],
      countySubdivisions: [],
      counties: ['Westchester County'],
    };
    const resolved = resolveJurisdiction(geo, CHECK_DATE);
    assert.equal(resolved.flags.yonkers, true);
    assert.equal(resolved.flags.newYorkCity, false);
  });

  test('St. Louis, MO: sets the stLouis flag (Census keeps the period)', () => {
    const geo: CensusGeographies = {
      state: 'MO',
      incorporatedPlaces: ['St. Louis city'],
      countySubdivisions: [],
      counties: ['St. Louis city'],
    };
    const resolved = resolveJurisdiction(geo, CHECK_DATE);
    assert.equal(resolved.flags.stLouis, true);
    assert.equal(resolved.flags.kansasCity, false);
  });

  test('Kansas City, MO: sets the kansasCity flag', () => {
    const geo: CensusGeographies = {
      state: 'MO',
      incorporatedPlaces: ['Kansas City city'],
      countySubdivisions: [],
      counties: ['Jackson County'],
    };
    const resolved = resolveJurisdiction(geo, CHECK_DATE);
    assert.equal(resolved.flags.kansasCity, true);
    assert.equal(resolved.flags.stLouis, false);
  });

  test('Newark, NJ: sets the newark flag', () => {
    const geo: CensusGeographies = {
      state: 'NJ',
      incorporatedPlaces: ['Newark city'],
      countySubdivisions: [],
      counties: ['Essex County'],
    };
    const resolved = resolveJurisdiction(geo, CHECK_DATE);
    assert.equal(resolved.flags.newark, true);
  });

  test('downtown Portland, OR: sets multnomahCounty from the Counties layer', () => {
    const geo: CensusGeographies = {
      state: 'OR',
      incorporatedPlaces: ['Portland city'],
      countySubdivisions: [],
      counties: ['Multnomah County'],
    };
    const resolved = resolveJurisdiction(geo, CHECK_DATE);
    assert.equal(resolved.flags.multnomahCounty, true);
  });

  test('a Missouri address outside both KC and St. Louis leaves both flags false', () => {
    const geo: CensusGeographies = {
      state: 'MO',
      incorporatedPlaces: ['Springfield city'],
      countySubdivisions: [],
      counties: ['Greene County'],
    };
    const resolved = resolveJurisdiction(geo, CHECK_DATE);
    assert.equal(resolved.flags.kansasCity, false);
    assert.equal(resolved.flags.stLouis, false);
  });

  test('Birmingham, AL: resolves a real municipal occupational tax match', () => {
    // Real Census result for 710 20th St N, Birmingham, AL 35203.
    const geo: CensusGeographies = {
      state: 'AL',
      incorporatedPlaces: ['Birmingham city'],
      countySubdivisions: [],
      counties: ['Jefferson County'],
    };
    const resolved = resolveJurisdiction(geo, CHECK_DATE);
    assert.equal(resolved.alMunicipality?.confidence, 'matched');
    assert.equal(resolved.alMunicipality?.entry?.name, 'Birmingham');
    assert.equal(resolved.alMunicipality?.entry?.rate, 0.01);

    const fields = toCertificateFields(resolved, 'work');
    assert.equal(fields.workCity, 'Birmingham');
  });

  test('a real AL city outside the 25-jurisdiction list: no_match, not a guess', () => {
    const geo: CensusGeographies = {
      state: 'AL',
      incorporatedPlaces: ['Montgomery city'],
      countySubdivisions: [],
      counties: ['Montgomery County'],
    };
    const resolved = resolveJurisdiction(geo, CHECK_DATE);
    assert.equal(resolved.alMunicipality?.confidence, 'no_match');
  });

  test('Edmonton, KY: resolves BOTH the city and its containing county at once — the KRS 68.197 credit-eligible pair', () => {
    // Real Census result for 105 W Main St, Edmonton, KY 42129 — Edmonton
    // is Metcalfe County's own county seat, and both are independently
    // confirmed at 1% in data/local/KY-occupational-2026.json.
    const geo: CensusGeographies = {
      state: 'KY',
      incorporatedPlaces: ['Edmonton city'],
      countySubdivisions: [],
      counties: ['Metcalfe County'],
    };
    const resolved = resolveJurisdiction(geo, CHECK_DATE);
    assert.equal(resolved.kyCity?.confidence, 'matched');
    assert.equal(resolved.kyCity?.entry?.name, 'Edmonton');
    assert.equal(resolved.kyCounty?.confidence, 'matched');
    assert.equal(resolved.kyCounty?.entry?.name, 'Metcalfe County');

    const fields = toCertificateFields(resolved, 'work');
    assert.equal(fields.workCity, 'Edmonton');
    assert.equal(fields.workCounty, 'Metcalfe County');
  });

  test('KY county matching resolves the COUNTY government, never the school district sharing its name', () => {
    // Cumberland County Public School District levies its own 0.5%
    // occupational tax, a DIFFERENT jurisdiction from the county
    // government's own 1.25% — see toKYCountyBaseName()'s doc comment.
    // Before county coverage was completed from the Kentucky Association
    // of Counties own payroll-rate table, this test asserted no_match,
    // because the only Cumberland entry carrying a rate WAS the school
    // district. The protection it guards is unchanged: a Census
    // "Cumberland County" must never resolve to the school district.
    const geo: CensusGeographies = {
      state: 'KY',
      incorporatedPlaces: [],
      countySubdivisions: [],
      counties: ['Cumberland County'],
    };
    const resolved = resolveJurisdiction(geo, CHECK_DATE);
    assert.equal(resolved.kyCounty?.confidence, 'matched');
    assert.equal(resolved.kyCounty?.entry?.name, 'Cumberland County');
    assert.equal(resolved.kyCounty?.entry?.wageRateDecimal, 0.0125);
  });

  test('KY workCounty is only populated on a work-role call, never residence', () => {
    const geo: CensusGeographies = {
      state: 'KY',
      incorporatedPlaces: ['Edmonton city'],
      countySubdivisions: [],
      counties: ['Metcalfe County'],
    };
    const resolved = resolveJurisdiction(geo, CHECK_DATE);
    const residenceFields = toCertificateFields(resolved, 'residence');
    assert.equal(residenceFields.workCounty, undefined);
    assert.equal(residenceFields.residenceCity, 'Edmonton');
  });

  test('Wheeling, WV: matches the wvServiceFeeCity field by name', () => {
    // Real Census result for 1500 Chapline St, Wheeling, WV 26003.
    const geo: CensusGeographies = {
      state: 'WV',
      incorporatedPlaces: ['Wheeling city'],
      countySubdivisions: [],
      counties: ['Ohio County'],
    };
    const resolved = resolveJurisdiction(geo, CHECK_DATE);
    assert.equal(resolved.wvServiceFeeCity, 'Wheeling');
  });

  test('a WV city with no service fee: wvServiceFeeCity stays null', () => {
    const geo: CensusGeographies = {
      state: 'WV',
      incorporatedPlaces: ['Beckley city'],
      countySubdivisions: [],
      counties: ['Raleigh County'],
    };
    const resolved = resolveJurisdiction(geo, CHECK_DATE);
    assert.equal(resolved.wvServiceFeeCity, null);
  });

  test('Denver, CO: matches coOptCity', () => {
    // Real Census result for 1437 Bannock St, Denver, CO 80202 — Denver
    // is itself a consolidated city-county government in Colorado too.
    const geo: CensusGeographies = {
      state: 'CO',
      incorporatedPlaces: ['Denver city'],
      countySubdivisions: [],
      counties: ['Denver County'],
    };
    const resolved = resolveJurisdiction(geo, CHECK_DATE);
    assert.equal(resolved.coOptCity, 'Denver');
  });

  test('a Colorado address outside every OPT city leaves coOptCity null', () => {
    const geo: CensusGeographies = {
      state: 'CO',
      incorporatedPlaces: ['Colorado Springs city'],
      countySubdivisions: [],
      counties: ['El Paso County'],
    };
    const resolved = resolveJurisdiction(geo, CHECK_DATE);
    assert.equal(resolved.coOptCity, null);
  });

  test('Glendale, CO: matches coOptCity — found 2026-09-03, previously unreachable despite the tax computation already supporting it', () => {
    const geo: CensusGeographies = {
      state: 'CO',
      incorporatedPlaces: ['Glendale city'],
      countySubdivisions: [],
      counties: ['Arapahoe County'],
    };
    const resolved = resolveJurisdiction(geo, CHECK_DATE);
    assert.equal(resolved.coOptCity, 'Glendale');
  });

  test('Greenwood Village, CO: matches coOptCity — a multi-word place name, not just single-word cities like the others', () => {
    const geo: CensusGeographies = {
      state: 'CO',
      incorporatedPlaces: ['Greenwood Village city'],
      countySubdivisions: [],
      counties: ['Arapahoe County'],
    };
    const resolved = resolveJurisdiction(geo, CHECK_DATE);
    assert.equal(resolved.coOptCity, 'Greenwood Village');
  });

  test('Sheridan, CO: matches coOptCity', () => {
    const geo: CensusGeographies = {
      state: 'CO',
      incorporatedPlaces: ['Sheridan city'],
      countySubdivisions: [],
      counties: ['Arapahoe County'],
    };
    const resolved = resolveJurisdiction(geo, CHECK_DATE);
    assert.equal(resolved.coOptCity, 'Sheridan');
  });

  test('Aurora, CO: matches coOptCity — kept resolvable despite the tax itself being repealed 2025-01-01, so a pre-repeal check date still computes it', () => {
    const geo: CensusGeographies = {
      state: 'CO',
      incorporatedPlaces: ['Aurora city'],
      countySubdivisions: [],
      counties: ['Arapahoe County'],
    };
    const resolved = resolveJurisdiction(geo, CHECK_DATE);
    assert.equal(resolved.coOptCity, 'Aurora');
  });

  test('Wilmington, DE: sets the wilmington flag', () => {
    // Real Census result for 800 N French St, Wilmington, DE 19801.
    const geo: CensusGeographies = {
      state: 'DE',
      incorporatedPlaces: ['Wilmington city'],
      countySubdivisions: [],
      counties: ['New Castle County'],
    };
    const resolved = resolveJurisdiction(geo, CHECK_DATE);
    assert.equal(resolved.flags.wilmington, true);
  });

  test('a Delaware address outside Wilmington leaves the wilmington flag false', () => {
    const geo: CensusGeographies = {
      state: 'DE',
      incorporatedPlaces: ['Dover city'],
      countySubdivisions: [],
      counties: ['Kent County'],
    };
    const resolved = resolveJurisdiction(geo, CHECK_DATE);
    assert.equal(resolved.flags.wilmington, false);
  });
});

describe('resolveLocalityCandidates() — the single-slot certificate.locality arbitration (index.ts)', () => {
  test('zero candidates: no locality, no conflict', () => {
    const result = resolveLocalityCandidates(new Set());
    assert.equal(result.locality, undefined);
    assert.equal(result.conflictMessage, null);
  });

  test('exactly one candidate: that locality, no conflict — the ordinary same-state case', () => {
    const result = resolveLocalityCandidates(new Set(['Kansas City']));
    assert.equal(result.locality, 'Kansas City');
    assert.equal(result.conflictMessage, null);
  });

  test('two DIFFERENT candidates (e.g. a Kansas-City-work / Wilmington-residence employee, or a Kansas-City-work / City-of-St.-Louis-residence employee within Missouri itself): no locality is guessed, and both names are named in the conflict message', () => {
    const result = resolveLocalityCandidates(new Set(['Kansas City', 'Wilmington']));
    assert.equal(result.locality, undefined, 'must not silently pick a winner');
    assert.ok(result.conflictMessage, 'must surface the conflict rather than staying silent');
    assert.match(result.conflictMessage!, /Kansas City/);
    assert.match(result.conflictMessage!, /Wilmington/);
    assert.match(result.conflictMessage!, /single field and can only hold one value/);
  });

  test('the same candidate reached twice (e.g. both the work AND residence flag independently point at Kansas City) collapses to one, not a conflict', () => {
    const result = resolveLocalityCandidates(new Set(['Kansas City']));
    assert.equal(result.locality, 'Kansas City');
    assert.equal(result.conflictMessage, null);
  });
});

describe('census.ts — match quality, retries, and the secondary-unit fallback (mocked fetch, no live network)', () => {
  function geocoderBody(opts: { matched: boolean; fromAddress?: string; toAddress?: string }) {
    if (!opts.matched) return { result: { addressMatches: [] } };
    return {
      result: {
        addressMatches: [
          {
            matchedAddress: '90 W BROAD ST, COLUMBUS, OH, 43215',
            coordinates: { x: -83.0, y: 40.0 },
            addressComponents: { fromAddress: opts.fromAddress, toAddress: opts.toAddress },
            geographies: {
              States: [{ STUSAB: 'OH' }],
              'Incorporated Places': [{ NAME: 'Columbus city' }],
              'County Subdivisions': [],
              Counties: [{ NAME: 'Franklin County' }],
            },
          },
        ],
      },
    };
  }

  describe('normalizeAddress / stripSecondaryUnit (pure)', () => {
    test('normalizeAddress trims and collapses internal whitespace', () => {
      assert.equal(normalizeAddress('  123  Main   St ,  Columbus, OH  '), '123 Main St , Columbus, OH');
    });

    test('stripSecondaryUnit removes a trailing apartment/suite/unit designator', () => {
      assert.equal(stripSecondaryUnit('123 Main St Apt 4B, Columbus, OH 43215'), '123 Main St, Columbus, OH 43215');
      assert.equal(stripSecondaryUnit('123 Main St Unit 12, Columbus, OH 43215'), '123 Main St, Columbus, OH 43215');
      assert.equal(stripSecondaryUnit('123 Main St Suite 200, Columbus, OH 43215'), '123 Main St, Columbus, OH 43215');
      assert.equal(stripSecondaryUnit('123 Main St #5, Columbus, OH 43215'), '123 Main St, Columbus, OH 43215');
    });

    test('stripSecondaryUnit returns null when there is nothing to strip', () => {
      assert.equal(stripSecondaryUnit('123 Main St, Columbus, OH 43215'), null);
    });
  });

  describe('matchedAddressDifferences (pure; matched addresses from the 2026-09-30 coverage run)', () => {
    test('a dropped or reversed street direction is reported', () => {
      assert.deepEqual(
        matchedAddressDifferences('1007 E Grand Ave, Des Moines, IA 50319', '1007 GRAND AVE, DES MOINES, IA, 50309'),
        ['street direction E → none'],
      );
      assert.deepEqual(
        matchedAddressDifferences('100 N Capitol Ave, Lansing, MI 48933', '100 S CAPITOL AVE, LANSING, MI, 48933'),
        ['street direction N → S'],
      );
      assert.deepEqual(
        matchedAddressDifferences('350 State St, Salt Lake City, UT 84103', '350 N STATE ST, SALT LAKE CITY, UT, 84103'),
        ['street direction none → N'],
      );
    });

    test('a different house number is reported', () => {
      assert.deepEqual(
        matchedAddressDifferences('125 Main St, Columbus, OH 43215', '123 MAIN ST, COLUMBUS, OH, 43215'),
        ['house number 125 → 123'],
      );
    });

    test('ZIP, spelling and abbreviation differences are not', () => {
      // Census swaps a government building's own ZIP for the street's.
      assert.deepEqual(matchedAddressDifferences('600 Dexter Ave, Montgomery, AL 36130', '600 DEXTER AVE, MONTGOMERY, AL, 36104'), []);
      assert.deepEqual(matchedAddressDifferences('900 Court St NE, Salem, OR 97301', '900 COURT ST NE, SALEM, OR, 97301'), []);
      assert.deepEqual(matchedAddressDifferences('1100 West Main Street, Frankfort, KY 40601', '1100 W MAIN ST, FRANKFORT, KY, 40601'), []);
      assert.deepEqual(matchedAddressDifferences('100 North St, Columbus, OH 43215', '100 NORTH ST, COLUMBUS, OH, 43215'), []);
    });

    test('a unit designator is not read as a street direction', () => {
      assert.deepEqual(matchedAddressDifferences('123 Main St Apt E, Columbus, OH 43215', '123 MAIN ST, COLUMBUS, OH, 43215'), []);
    });

    test('nothing is reported when there is no matched address to compare', () => {
      assert.deepEqual(matchedAddressDifferences('123 Main St, Columbus, OH 43215', ''), []);
    });
  });

  describe('geocodeAddress fallback retry', () => {
    test('falls back to the unit-stripped address when the full address does not match, and flags matchedViaFallback', async () => {
      let calls = 0;
      const fakeFetch = (async (url: string) => {
        calls++;
        const isFirstCall = calls === 1;
        return new Response(
          JSON.stringify(geocoderBody(isFirstCall ? { matched: false } : { matched: true, fromAddress: '90', toAddress: '98' })),
          { status: 200 },
        );
      }) as typeof fetch;

      const result = await geocodeAddress('123 Main St Apt 4B, Columbus, OH 43215', fakeFetch);
      assert.equal(calls, 2, 'should try the full address once, then the stripped fallback once');
      assert.equal(result.matched, true);
      assert.equal(result.matchQuality?.matchedViaFallback, true);
    });

    test('an address with no secondary unit to strip does not retry after a genuine no-match', async () => {
      let calls = 0;
      const fakeFetch = (async () => {
        calls++;
        return new Response(JSON.stringify(geocoderBody({ matched: false })), { status: 200 });
      }) as typeof fetch;

      const result = await geocodeAddress('999 Nowhere Rd, Columbus, OH 43215', fakeFetch);
      assert.equal(calls, 1, 'nothing to strip, so no fallback attempt should fire');
      assert.equal(result.matched, false);
    });
  });

  describe('matchQuality.addressRangeWidth', () => {
    test('computed from the matched address range Census returns', async () => {
      const fakeFetch = (async () =>
        new Response(JSON.stringify(geocoderBody({ matched: true, fromAddress: '90', toAddress: '148' })), {
          status: 200,
        })) as typeof fetch;

      const result = await geocodeAddress('90 W Broad St, Columbus, OH 43215', fakeFetch);
      assert.equal(result.matchQuality?.addressRangeWidth, 58);
      assert.equal(result.matchQuality?.matchedAddress, '90 W BROAD ST, COLUMBUS, OH, 43215');
    });
  });

  describe('retry-with-backoff on transient failures', () => {
    test('a transient 500 is retried and a subsequent success is returned', async () => {
      let calls = 0;
      const fakeFetch = (async () => {
        calls++;
        if (calls === 1) return new Response('server error', { status: 500 });
        return new Response(JSON.stringify(geocoderBody({ matched: true, fromAddress: '1', toAddress: '9' })), {
          status: 200,
        });
      }) as typeof fetch;

      const result = await geocodeAddress('90 W Broad St, Columbus, OH 43215', fakeFetch, { baseBackoffMs: 0 });
      assert.equal(calls, 2, 'one failed attempt, one retried success');
      assert.equal(result.matched, true);
    });

    test('a genuine 400 (bad request) is NOT retried — retrying a client error cannot help', async () => {
      let calls = 0;
      const fakeFetch = (async () => {
        calls++;
        return new Response('bad request', { status: 400 });
      }) as typeof fetch;

      await assert.rejects(() => geocodeAddress('90 W Broad St, Columbus, OH 43215', fakeFetch, { baseBackoffMs: 0 }));
      assert.equal(calls, 1, 'a 400 should fail fast, not burn retries');
    });

    test('exhausting all retries on persistent 500s eventually throws rather than hanging forever', async () => {
      let calls = 0;
      const fakeFetch = (async () => {
        calls++;
        return new Response('server error', { status: 500 });
      }) as typeof fetch;

      await assert.rejects(() => geocodeAddress('90 W Broad St, Columbus, OH 43215', fakeFetch, { baseBackoffMs: 0 }));
      assert.ok(calls > 1, 'should have retried at least once before giving up');
    });
  });

  describe('fetchSchoolDistrictAtPointSafe', () => {
    test('a network failure is caught and reported as {ok: false}, not thrown', async () => {
      const failingFetch = (async () => {
        throw new Error('network down');
      }) as unknown as typeof fetch;

      const result = await fetchSchoolDistrictAtPointSafe(-83.0, 40.0, failingFetch, { baseBackoffMs: 0 });
      assert.equal(result.ok, false);
    });

    test('a genuine "no district here" result still comes back as {ok: true, district: null}, distinct from a failure', async () => {
      const fakeFetch = (async () => new Response(JSON.stringify({ results: [] }), { status: 200 })) as typeof fetch;

      const result = await fetchSchoolDistrictAtPointSafe(-83.0, 40.0, fakeFetch);
      assert.deepEqual(result, { ok: true, district: null });
    });
  });
});

describe('nominatim.ts — the independent cross-check geocoder (mocked fetch, no live network)', () => {
  function nominatimBody(opts: { matched: boolean; lat?: string; lon?: string; address?: Record<string, string> }) {
    if (!opts.matched) return [];
    return [{ lat: opts.lat, lon: opts.lon, address: opts.address }];
  }

  describe('milesBetween (pure)', () => {
    test('the same point is zero miles from itself', () => {
      assert.equal(milesBetween({ lat: 39.96, lon: -83.0 }, { lat: 39.96, lon: -83.0 }), 0);
    });

    test('a real, known distance comes out approximately right', () => {
      // Columbus, OH downtown vs. a point ~1 mile east — sanity-checked
      // against a rough 1-degree-longitude-at-this-latitude ≈ 53 miles
      // approximation (0.019 deg * 53 ≈ 1.0mi), not an exact fixture.
      const miles = milesBetween({ lat: 39.9612, lon: -83.0007 }, { lat: 39.9612, lon: -82.9817 });
      assert.ok(miles > 0.8 && miles < 1.3, `expected roughly 1 mile, got ${miles}`);
    });
  });

  describe('crossCheckAddress / crossCheckSafe', () => {
    test('extracts place from whichever of city/town/village Nominatim used, and county', async () => {
      const fakeFetch = (async () =>
        new Response(
          JSON.stringify(
            nominatimBody({
              matched: true,
              lat: '40.894',
              lon: '-83.890',
              address: { town: 'Bluffton', county: 'Allen County', state: 'Ohio' },
            }),
          ),
          { status: 200 },
        )) as typeof fetch;

      const result = await crossCheckAddress('136 N Main St, Bluffton, OH 45817', fakeFetch, {
        minIntervalMs: 0,
      });
      assert.equal(result.matched, true);
      assert.equal(result.place, 'Bluffton');
      assert.equal(result.county, 'Allen County');
      assert.deepEqual(result.coordinates, { lat: 40.894, lon: -83.89 });
    });

    test('no match comes back as matched: false, not a throw', async () => {
      const fakeFetch = (async () =>
        new Response(JSON.stringify(nominatimBody({ matched: false })), { status: 200 })) as typeof fetch;

      const result = await crossCheckAddress('999 Nowhere Rd', fakeFetch, { minIntervalMs: 0 });
      assert.equal(result.matched, false);
    });

    test('crossCheckSafe catches a network failure and reports {ok: false} rather than throwing', async () => {
      const failingFetch = (async () => {
        throw new Error('network down');
      }) as unknown as typeof fetch;

      const result = await crossCheckSafe('90 W Broad St, Columbus, OH 43215', failingFetch, {
        minIntervalMs: 0,
        baseBackoffMs: 0,
      });
      assert.equal(result.ok, false);
    });

    test('crossCheckSafe wraps a genuine match as {ok: true, result}', async () => {
      const fakeFetch = (async () =>
        new Response(
          JSON.stringify(
            nominatimBody({ matched: true, lat: '39.96', lon: '-83.0', address: { city: 'Columbus', county: 'Franklin County' } }),
          ),
          { status: 200 },
        )) as typeof fetch;

      const result = await crossCheckSafe('90 W Broad St, Columbus, OH 43215', fakeFetch, { minIntervalMs: 0 });
      assert.equal(result.ok, true);
      if (result.ok) {
        assert.equal(result.result.place, 'Columbus');
      }
    });
  });
});

/**
 * The building-footprint check. Every footprint below is REAL data,
 * captured live from the Overpass API this session with the exact query
 * fetchNearbyBuildings() itself builds:
 *   curl -X POST https://overpass-api.de/api/interpreter --data-urlencode \
 *     'data=[out:json][timeout:20];way["building"](39.960237,-83.014757,39.962932,-83.011240);out tags geom;'
 * (that bbox is the ~150m box around Nominatim's own point for 90 W Broad
 * St, Columbus; the other set is the same query around Census's point).
 * Only the six closest footprints per point are kept, and only the tags
 * this module reads — coordinates are the real ones, rounded to 6
 * decimals (~0.1m).
 *
 * This is the pair of real results the whole module exists for: Census's
 * point sits 23m from "50 West Broad Street" (LeVeque Tower) — 40 numbers
 * from the target, plausible — while Nominatim's sits 10m from "500 W
 * Broad Street" (Gravity Building A), 410 numbers away, which is the
 * signal that Nominatim resolved a genuinely different location.
 */
describe('buildings.ts — the OpenStreetMap building-footprint check (real captured Overpass data, mocked fetch)', () => {
  const ring = (pairs: [number, number][]) => pairs.map(([lat, lon]) => ({ lat, lon }));
  const TARGET = '90 W Broad St, Columbus, OH 43215';
  const CENSUS_POINT = { lat: 39.962072, lon: -83.002493 };
  const NOMINATIM_POINT = { lat: 39.961585, lon: -83.012999 };

  // CENSUS point {"lat":39.962072,"lon":-83.002493} — 6 of 25 footprints returned
  const CENSUS_FOOTPRINTS = [
    // 23m away
    { tags: {"name":"LeVeque Tower","addr:housenumber":"50","addr:street":"West Broad Street","building":"yes"}, geometry: ring([[39.962419, -83.002334], [39.962216, -83.002296], [39.962242, -83.002064], [39.962247, -83.002024], [39.962289, -83.001647], [39.962370, -83.001663], [39.962423, -83.001673], [39.962452, -83.001678], [39.962410, -83.002054], [39.962443, -83.002104], [39.962437, -83.002153], [39.962734, -83.002209], [39.962714, -83.002390], [39.962419, -83.002334]]) },
    // 31m away
    { tags: {"name":"Huntington Plaza","addr:housenumber":"37","addr:street":"West Broad Street","building":"commercial"}, geometry: ring([[39.961615, -83.002180], [39.961880, -83.002233], [39.961910, -83.001981], [39.961940, -83.001725], [39.961674, -83.001672], [39.961634, -83.002022], [39.961615, -83.002180]]) },
    // 33m away
    { tags: {"name":"Ohio Department of Education","addr:housenumber":"25","addr:street":"South Front Street","building":"public"}, geometry: ring([[39.961307, -83.003126], [39.961450, -83.003153], [39.961580, -83.003179], [39.961723, -83.003206], [39.961729, -83.003158], [39.961790, -83.002618], [39.961751, -83.002611], [39.961425, -83.002548], [39.961374, -83.002538], [39.961312, -83.003078], [39.961307, -83.003126]]) },
    // 50m away
    { tags: {"name":"Palace Theatre","building":"yes"}, geometry: ring([[39.962452, -83.001678], [39.962791, -83.001737], [39.962734, -83.002209], [39.962437, -83.002153], [39.962443, -83.002104], [39.962410, -83.002054], [39.962452, -83.001678]]) },
    // 58m away
    { tags: {"name":"City Hall","building":"civic"}, geometry: ring([[39.962824, -83.003773], [39.962835, -83.003676], [39.962873, -83.003683], [39.962931, -83.003181], [39.962898, -83.003175], [39.962916, -83.003019], [39.962473, -83.002932], [39.962456, -83.003075], [39.962425, -83.003069], [39.962367, -83.003577], [39.962409, -83.003585], [39.962395, -83.003701], [39.962455, -83.003713], [39.962453, -83.003731], [39.962488, -83.003738], [39.962486, -83.003762], [39.962714, -83.003806], [39.962718, -83.003777], [39.962750, -83.003783], [39.962752, -83.003759], [39.962824, -83.003773]]) },
    // 66m away
    { tags: {"building":"parking"}, geometry: ring([[39.961604, -83.002016], [39.961611, -83.001958], [39.961621, -83.001882], [39.961602, -83.001879], [39.961620, -83.001727], [39.961460, -83.001695], [39.961427, -83.001978], [39.961526, -83.002000], [39.961545, -83.002004], [39.961595, -83.002014], [39.961602, -83.002016], [39.961604, -83.002016]]) },
  ];

  // NOMINATIM point {"lat":39.961585,"lon":-83.012999} — 6 of 10 footprints returned
  const NOMINATIM_FOOTPRINTS = [
    // 10m away
    { tags: {"name":"Gravity Building A","addr:housenumber":"500","addr:street":"W Broad Street","building":"apartments"}, geometry: ring([[39.960792, -83.013381], [39.960758, -83.013632], [39.960958, -83.013993], [39.961149, -83.014041], [39.961171, -83.013865], [39.961067, -83.013672], [39.961337, -83.013433], [39.961351, -83.013213], [39.961202, -83.013286], [39.961140, -83.013094], [39.961410, -83.012855], [39.961578, -83.013185], [39.961727, -83.013055], [39.961695, -83.012916], [39.961432, -83.012639], [39.961275, -83.012717], [39.961209, -83.012506], [39.960952, -83.012220], [39.960923, -83.012473], [39.961085, -83.012822], [39.961037, -83.012888], [39.960990, -83.012938], [39.960872, -83.012829], [39.960843, -83.013038], [39.961030, -83.013379], [39.960932, -83.013522], [39.960792, -83.013381]]) },
    // 26m away
    { tags: {"name":"Gravity Apartments parking garage","building":"parking"}, geometry: ring([[39.961174, -83.013738], [39.961367, -83.014094], [39.961568, -83.013917], [39.961651, -83.014067], [39.961673, -83.014108], [39.961725, -83.014203], [39.961813, -83.014209], [39.962032, -83.014006], [39.961840, -83.013662], [39.961956, -83.013559], [39.961791, -83.013254], [39.961742, -83.013303], [39.961714, -83.013249], [39.961174, -83.013738]]) },
    // 85m away
    { tags: {"building":"service"}, geometry: ring([[39.962128, -83.012261], [39.962123, -83.012291], [39.962144, -83.012297], [39.962149, -83.012267], [39.962128, -83.012261]]) },
    // 96m away
    { tags: {"name":"Agora Christian Fellowship Church","building":"yes"}, geometry: ring([[39.961262, -83.011452], [39.961270, -83.011394], [39.961187, -83.011386], [39.961158, -83.011607], [39.961065, -83.011585], [39.961022, -83.011607], [39.960996, -83.011805], [39.961418, -83.011891], [39.961468, -83.011492], [39.961262, -83.011452]]) },
    // 97m away
    { tags: {"building":"industrial"}, geometry: ring([[39.961847, -83.011742], [39.961844, -83.011775], [39.961739, -83.011757], [39.961743, -83.011718], [39.961707, -83.011711], [39.961705, -83.011736], [39.961448, -83.011690], [39.961434, -83.011819], [39.962055, -83.011931], [39.962071, -83.011782], [39.961847, -83.011742]]) },
    // 111m away
    { tags: {"addr:housenumber":"455","addr:street":"W Broad Street","building":"commercial"}, geometry: ring([[39.960555, -83.013208], [39.960612, -83.012696], [39.959959, -83.012572], [39.959902, -83.013084], [39.960555, -83.013208]]) },
  ];

  /**
   * Opts out of the retry backoff and the request-spacing throttle (the
   * LOGIC still runs; the suite just doesn't pay real seconds for it), and
   * hands each call its OWN availability record. That last part is not
   * ceremony: without it, the tests below that simulate an outage open the
   * module-wide circuit and every later test gets skipped instead of run —
   * which is exactly what happened the first time these were written.
   */
  const fresh = (overrides: Record<string, unknown> = {}) => ({
    minIntervalMs: 0,
    baseBackoffMs: 0,
    circuit: { consecutiveFailures: 0, openUntil: 0 },
    ...overrides,
  });

  const okFetch = (elements: unknown[]) =>
    (async () => new Response(JSON.stringify({ elements }), { status: 200 })) as unknown as typeof fetch;

  describe('street/house-number parsing (pure)', () => {
    test('streetKey makes the postal and OSM spellings of one street compare equal — both forms appear in the real data above', () => {
      assert.equal(streetKey('W Broad St'), streetKey('West Broad Street'));
      assert.equal(streetKey('W Broad Street'), streetKey('West Broad Street'));
      assert.equal(streetKey('N. Main St.'), 'north main street');
    });

    test('streetKey expands a street type only at the END, so a name that starts with one survives', () => {
      assert.equal(streetKey('St Clair Ave'), 'st clair avenue');
    });

    test('streetKey keeps genuinely different streets different', () => {
      assert.notEqual(streetKey('W Broad St'), streetKey('S Front St'));
    });

    test('streetKey makes digit and word forms of a numbered street compare equal — live NAD data for Juneau, AK publishes "FOURTH Street", not "4th St", and this address matched nothing at all before this normalization existed', () => {
      assert.equal(streetKey('4th St'), streetKey('FOURTH Street'));
      assert.equal(streetKey('3rd Ave'), streetKey('Third Avenue'));
      assert.equal(streetKey('11th St'), streetKey('Eleventh Street'));
      assert.equal(streetKey('20th St'), streetKey('Twentieth Street'));
    });

    test('streetKey collapses a two-word ordinal, spaced or hyphenated, to its digit form', () => {
      assert.equal(streetKey('21st Ave'), streetKey('Twenty First Avenue'));
      assert.equal(streetKey('21st Ave'), streetKey('Twenty-First Avenue'));
      assert.equal(streetKey('99th St'), streetKey('Ninety Ninth Street'));
    });

    test('streetKey collapses three- and four-word ordinals into the triple-digit streets some cities (Manhattan) actually have', () => {
      assert.equal(streetKey('100th St'), streetKey('One Hundredth Street'));
      assert.equal(streetKey('105th St'), streetKey('One Hundred Fifth Street'));
      assert.equal(streetKey('120th St'), streetKey('One Hundred Twentieth Street'));
      assert.equal(streetKey('125th St'), streetKey('One Hundred Twenty Fifth Street'));
    });

    test('streetKey does not collapse a bare cardinal number that never resolves to an ordinal — "One World Way" names a place, not a numbered street', () => {
      assert.equal(streetKey('One World Way'), 'one world way');
    });

    test('streetKey leaves an already-digit ordinal alone', () => {
      assert.equal(streetKey('4th St'), '4th street');
      assert.equal(streetKey('21st Ave'), '21st avenue');
    });

    test('extractHouseNumber reads the leading number, or null when there is none', () => {
      assert.equal(extractHouseNumber(TARGET), '90');
      assert.equal(extractHouseNumber('Broadway, New York, NY'), null);
    });

    test('extractStreet drops the house number and any unit designator', () => {
      assert.equal(extractStreet(TARGET), 'W Broad St');
      assert.equal(extractStreet('1600 Broadway, New York, NY 10019'), 'Broadway');
      assert.equal(extractStreet('123 Main St Apt 4B, Columbus, OH 43215'), 'Main St');
    });
  });

  describe('nearestBuilding / nearestBuildingOnStreet (pure, real footprints)', () => {
    test("the nearest footprint of any kind to Census's point is LeVeque Tower, about 23m away", () => {
      const nearest = nearestBuilding(CENSUS_POINT, CENSUS_FOOTPRINTS);
      assert.equal(nearest?.name, 'LeVeque Tower');
      assert.ok(
        nearest!.distanceMeters > 15 && nearest!.distanceMeters < 35,
        `expected roughly 23m, got ${nearest!.distanceMeters}`,
      );
    });

    test('the point falls OUTSIDE every footprint — which is why this uses nearest-edge distance, not containment', () => {
      // Census interpolates to the street curb, not into the building. If
      // this ever starts returning ~0, the geocoder's behaviour changed,
      // not this module's.
      assert.ok(nearestBuilding(CENSUS_POINT, CENSUS_FOOTPRINTS)!.distanceMeters > 5);
    });

    test('the SAME-STREET filter skips a closer cross-street building whose number would mean nothing', () => {
      // The Ohio Department of Education footprint ("25 South Front
      // Street") is only 33m from this point — closer than City Hall and
      // barely further than Huntington Plaza — but comparing 90 W Broad
      // St against a South Front Street number compares nothing.
      const onStreet = nearestBuildingOnStreet(CENSUS_POINT, CENSUS_FOOTPRINTS, 'W Broad St');
      assert.equal(onStreet?.name, 'LeVeque Tower');
      assert.equal(onStreet?.houseNumber, '50');
      assert.equal(onStreet?.street, 'West Broad Street');
    });

    test('a street with no tagged footprint nearby yields no candidate at all, rather than the wrong one', () => {
      assert.equal(nearestBuildingOnStreet(CENSUS_POINT, CENSUS_FOOTPRINTS, 'E Long St'), null);
    });

    test('a footprint tagged with a street but no house number is not a candidate — there is nothing to compare', () => {
      const untagged = [
        {
          tags: { 'addr:street': 'West Broad Street' },
          geometry: ring([
            [39.9621, -83.0025],
            [39.9622, -83.0026],
          ]),
        },
      ];
      assert.equal(nearestBuildingOnStreet(CENSUS_POINT, untagged, 'W Broad St'), null);
    });
  });

  describe('checkNearestBuilding — the real Columbus disagreement, end to end', () => {
    test("Census's point: a 40-number gap to the nearest same-street building, well under the flag threshold", async () => {
      const result = await checkNearestBuilding(TARGET, CENSUS_POINT, okFetch(CENSUS_FOOTPRINTS), fresh());
      assert.equal(result.attempted, true);
      assert.equal(result.onStreet?.houseNumber, '50');
      assert.equal(result.houseNumberGap, 40);
      assert.ok(result.houseNumberGap! < LARGE_HOUSE_NUMBER_GAP);
    });

    test("Nominatim's point: a 410-number gap — the real error this check was built to catch", async () => {
      const result = await checkNearestBuilding(TARGET, NOMINATIM_POINT, okFetch(NOMINATIM_FOOTPRINTS), fresh());
      assert.equal(result.attempted, true);
      assert.equal(result.nearest?.name, 'Gravity Building A');
      // Tagged "W Broad Street" here vs. "West Broad Street" on Census's
      // side of the river — a raw string comparison would have missed
      // this one entirely.
      assert.equal(result.onStreet?.houseNumber, '500');
      assert.equal(result.houseNumberGap, 410);
      assert.ok(result.houseNumberGap! > LARGE_HOUSE_NUMBER_GAP);
    });

    test('an address with no mapped footprints nearby is attempted-but-silent, NOT evidence against the point', async () => {
      const result = await checkNearestBuilding('1 Rural Route 2, Nowhere, OH', { lat: 40.5, lon: -83.5 }, okFetch([]), fresh());
      assert.equal(result.attempted, true);
      assert.equal(result.nearest, null);
      assert.equal(result.houseNumberGap, null);
    });

    test('a same-street footprint with no house number tagged produces no gap rather than a guess', async () => {
      const result = await checkNearestBuilding(
        TARGET,
        CENSUS_POINT,
        okFetch([
          {
            tags: { 'addr:street': 'West Broad Street', building: 'yes' },
            geometry: [
              { lat: 39.9621, lon: -83.0025 },
              { lat: 39.9622, lon: -83.0026 },
              { lat: 39.9621, lon: -83.0025 },
            ],
          },
        ]),
        fresh(),
      );
      assert.equal(result.attempted, true);
      assert.equal(result.houseNumberGap, null);
    });
  });

  describe('fetchNearbyBuildings — Overpass request shape and failure handling', () => {
    test('posts a bounding-box building query, not a GET', async () => {
      let seen: { url: string; init: RequestInit } | null = null;
      const spyFetch = (async (url: string, init: RequestInit) => {
        seen = { url, init };
        return new Response(JSON.stringify({ elements: [] }), { status: 200 });
      }) as unknown as typeof fetch;

      await fetchNearbyBuildings(39.962072, -83.002493, 150, spyFetch, fresh());
      assert.match(seen!.url, /overpass-api\.de/);
      assert.equal(seen!.init.method, 'POST');
      const body = String(seen!.init.body);
      assert.match(body, /way%5B%22building%22%5D/);
      // The bbox is built around the point, not around the whole city.
      assert.match(body, /39\.96/);
    });

    test("a transient 504 (Overpass under load — observed live, repeatedly) is retried, and the retry's success is returned", async () => {
      let calls = 0;
      const flakyFetch = (async () => {
        calls++;
        if (calls === 1) return new Response('dispatcher error', { status: 504 });
        return new Response(
          JSON.stringify({
            elements: [
              {
                tags: { building: 'yes' },
                geometry: [
                  { lat: 1, lon: 1 },
                  { lat: 1.1, lon: 1.1 },
                ],
              },
            ],
          }),
          { status: 200 },
        );
      }) as unknown as typeof fetch;

      const result = await fetchNearbyBuildings(39.96, -83.0, 150, flakyFetch, fresh());
      assert.equal(calls, 2);
      assert.equal(result.ok, true);
      if (result.ok) assert.equal(result.elements.length, 1);
    });

    test('a genuine empty result is {ok: true, elements: []} — distinct from a failed query, on purpose', async () => {
      const result = await fetchNearbyBuildings(39.96, -83.0, 150, okFetch([]), fresh());
      assert.equal(result.ok, true);
      if (result.ok) assert.deepEqual(result.elements, []);
    });

    test('exhausting the retries reports {ok: false} rather than throwing, or pretending nothing is mapped there', async () => {
      const downFetch = (async () => {
        throw new Error('network down');
      }) as unknown as typeof fetch;

      const result = await fetchNearbyBuildings(39.96, -83.0, 150, downFetch, fresh());
      assert.equal(result.ok, false);
    });

    test('back-to-back calls are spaced by the throttle — the cap Overpass asks for is enforced here, not left to callers', async () => {
      const stamps: number[] = [];
      const stampingFetch = (async () => {
        stamps.push(Date.now());
        return new Response(JSON.stringify({ elements: [] }), { status: 200 });
      }) as unknown as typeof fetch;

      const options = fresh({ minIntervalMs: 60 });
      await fetchNearbyBuildings(39.96, -83.0, 150, stampingFetch, options);
      await fetchNearbyBuildings(39.96, -83.0, 150, stampingFetch, options);
      assert.equal(stamps.length, 2);
      assert.ok(stamps[1] - stamps[0] >= 55, `expected ~60ms of spacing, got ${stamps[1] - stamps[0]}ms`);
    });

    test('a 429 with a Retry-After header waits the time the server actually asked for, not a made-up backoff', async () => {
      let calls = 0;
      const rateLimitedFetch = (async () => {
        calls++;
        if (calls === 1) {
          return new Response('rate limited', { status: 429, headers: { 'Retry-After': '0.08' } });
        }
        return new Response(JSON.stringify({ elements: [] }), { status: 200 });
      }) as unknown as typeof fetch;

      const started = Date.now();
      // baseBackoffMs: 0 would retry instantly — the header has to win.
      const result = await fetchNearbyBuildings(39.96, -83.0, 150, rateLimitedFetch, fresh());
      assert.equal(calls, 2);
      assert.equal(result.ok, true);
      assert.ok(Date.now() - started >= 70, 'expected the Retry-After delay to be honoured');
    });

    test('a host that never answers at all opens the circuit immediately — the next address is skipped, not made to wait for the same timeout', async () => {
      const circuit = { consecutiveFailures: 0, openUntil: 0 };
      const downFetch = (async () => {
        throw new Error('connect ETIMEDOUT');
      }) as unknown as typeof fetch;
      let secondCallReachedTheNetwork = false;
      const spyFetch = (async () => {
        secondCallReachedTheNetwork = true;
        return new Response(JSON.stringify({ elements: [] }), { status: 200 });
      }) as unknown as typeof fetch;

      const first = await fetchNearbyBuildings(39.96, -83.0, 150, downFetch, fresh({ circuit }));
      assert.equal(first.ok, false);
      assert.ok(circuit.openUntil > Date.now(), 'an unreachable host should open the circuit at once');

      const second = await fetchNearbyBuildings(39.96, -83.0, 150, spyFetch, fresh({ circuit }));
      assert.equal(second.ok, false);
      assert.equal(secondCallReachedTheNetwork, false);
    });

    test('an HTTP-level failure gets the benefit of the doubt until three in a row — one unlucky query is not an outage', async () => {
      const circuit = { consecutiveFailures: 0, openUntil: 0 };
      const erroringFetch = (async () => new Response('server error', { status: 500 })) as unknown as typeof fetch;
      const options = fresh({ circuit, retries: 0 });

      await fetchNearbyBuildings(39.96, -83.0, 150, erroringFetch, options);
      assert.equal(circuit.openUntil, 0, 'one failure should not open the circuit');
      await fetchNearbyBuildings(39.96, -83.0, 150, erroringFetch, options);
      assert.equal(circuit.openUntil, 0, 'two failures should not open the circuit');
      await fetchNearbyBuildings(39.96, -83.0, 150, erroringFetch, options);
      assert.ok(circuit.openUntil > Date.now(), 'three in a row is an outage');
    });

    test('a success clears the failure count, so unrelated hiccups never accumulate into a false outage', async () => {
      const circuit = { consecutiveFailures: 0, openUntil: 0 };
      const erroringFetch = (async () => new Response('server error', { status: 500 })) as unknown as typeof fetch;

      await fetchNearbyBuildings(39.96, -83.0, 150, erroringFetch, fresh({ circuit, retries: 0 }));
      assert.equal(circuit.consecutiveFailures, 1);
      await fetchNearbyBuildings(39.96, -83.0, 150, okFetch([]), fresh({ circuit }));
      assert.equal(circuit.consecutiveFailures, 0);
    });

    test('once the cooldown has passed, the next call actually tries again rather than staying open forever', async () => {
      const circuit = { consecutiveFailures: 9, openUntil: Date.now() - 1 };
      let tried = false;
      const spyFetch = (async () => {
        tried = true;
        return new Response(JSON.stringify({ elements: [] }), { status: 200 });
      }) as unknown as typeof fetch;

      const result = await fetchNearbyBuildings(39.96, -83.0, 150, spyFetch, fresh({ circuit }));
      assert.equal(tried, true);
      assert.equal(result.ok, true);
      assert.equal(circuit.consecutiveFailures, 0);
    });

    test('checkNearestBuilding turns that failure into attempted: false — no second opinion, never a mark against the address', async () => {
      const downFetch = (async () => {
        throw new Error('network down');
      }) as unknown as typeof fetch;

      const result = await checkNearestBuilding(TARGET, CENSUS_POINT, downFetch, fresh());
      assert.deepEqual(result, { attempted: false, nearest: null, onStreet: null, houseNumberGap: null });
    });
  });
});

/**
 * ROOFTOP PRECISION — the authoritative-address-point lookup.
 *
 * Every NAD record below is REAL, captured live from the National Address
 * Database's own public feature service with the exact bounding-box query
 * fetchAddressPointsNear() builds, around each address's Census-interpolated
 * position. Only the fields this module reads are kept, coordinates rounded
 * to 6 decimals (~0.1m), and the point lists trimmed to the target house
 * number plus a few neighbours on the same street.
 *
 * The three cases are here because each one broke something real:
 *   - Columbus is the case the whole module exists for: Census interpolates
 *     to the curb 82m away, next to the wrong tower, while Ohio's own
 *     address point sits 3.9m from City Hall's traced footprint.
 *   - Baltimore is why the directional fallback exists: Maryland publishes
 *     "100 N Holliday St" as plain "Holliday Street".
 *   - Birmingham is why streetKey() expands a street type that sits before
 *     a trailing directional: "710 20th St N" against "20th Street North".
 */
describe('rooftop.ts — authoritative address points (real captured National Address Database data, mocked fetch)', () => {
  const nadResponse = (features: unknown[]) =>
    (async () => new Response(JSON.stringify({ features }), { status: 200 })) as unknown as typeof fetch;
  const FAST_NAD = { baseBackoffMs: 0, minIntervalMs: 0 };

  // 90 W Broad St, Columbus, OH 43215
  // Census interpolates to 39.962072, -83.002493; 1027 NAD points in the 300m box, 149 on this street, 1 at this exact number.
  const COLUMBUS_INTERPOLATED = { lat: 39.962072, lon: -83.002493 };
  const COLUMBUS_NAD = [
    { attributes: {"AddNo_Full":"90","St_PreDir":"West","St_Name":"BROAD","St_PosTyp":"Street","Inc_Muni":"Unincorporated","Post_City":"COLUMBUS","Zip_Code":"43215","Placement":"Unknown","NAD_Source":"State of Ohio","Latitude":39.962431,"Longitude":-83.003328} },
    { attributes: {"AddNo_Full":"45","St_PreDir":"West","St_Name":"BROAD","St_PosTyp":"Street","Inc_Muni":"Unincorporated","Post_City":"COLUMBUS","Zip_Code":"43215","Placement":"Unknown","NAD_Source":"State of Ohio","Latitude":39.961711,"Longitude":-83.001855} },
    { attributes: {"AddNo_Full":"50","St_PreDir":"West","St_Name":"BROAD","St_PosTyp":"Street","Unit":"30","Inc_Muni":"Unincorporated","Post_City":"COLUMBUS","Zip_Code":"43215","Placement":"Unknown","NAD_Source":"State of Ohio","Latitude":39.962305,"Longitude":-83.001855} },
    { attributes: {"AddNo_Full":"20","St_PreDir":"East","St_Name":"BROAD","St_PosTyp":"Street","Inc_Muni":"Unincorporated","Post_City":"COLUMBUS","Zip_Code":"43215","Placement":"Unknown","NAD_Source":"State of Ohio","Latitude":39.962469,"Longitude":-83.000103} },
    { attributes: {"AddNo_Full":"50","St_PreDir":"West","St_Name":"BROAD","St_PosTyp":"Street","Unit":"2002","Inc_Muni":"Unincorporated","Post_City":"COLUMBUS","Zip_Code":"43215","Placement":"Unknown","NAD_Source":"State of Ohio","Latitude":39.962351,"Longitude":-83.002154} },
    { attributes: {"AddNo_Full":"36","St_PreDir":"West","St_Name":"BROAD","St_PosTyp":"Street","Inc_Muni":"Unincorporated","Post_City":"COLUMBUS","Zip_Code":"43215","Placement":"Unknown","NAD_Source":"State of Ohio","Latitude":39.962673,"Longitude":-83.001811} },
    { attributes: {"AddNo_Full":"50","St_PreDir":"West","St_Name":"BROAD","St_PosTyp":"Street","Unit":"14","Inc_Muni":"Unincorporated","Post_City":"COLUMBUS","Zip_Code":"43215","Placement":"Unknown","NAD_Source":"State of Ohio","Latitude":39.962388,"Longitude":-83.00228} },
    { attributes: {"AddNo_Full":"50","St_PreDir":"West","St_Name":"BROAD","St_PosTyp":"Street","Unit":"22","Inc_Muni":"Unincorporated","Post_City":"COLUMBUS","Zip_Code":"43215","Placement":"Unknown","NAD_Source":"State of Ohio","Latitude":39.96228,"Longitude":-83.00204} },
    { attributes: {"AddNo_Full":"50","St_PreDir":"West","St_Name":"BROAD","St_PosTyp":"Street","Unit":"1909","Inc_Muni":"Unincorporated","Post_City":"COLUMBUS","Zip_Code":"43215","Placement":"Unknown","NAD_Source":"State of Ohio","Latitude":39.962298,"Longitude":-83.002149} },
  ];

  // 100 N Holliday St, Baltimore, MD 21202
  // Census interpolates to 39.290556, -76.610351; 427 NAD points in the 300m box, 61 on this street, 2 at this exact number.
  const BALTIMORE_INTERPOLATED = { lat: 39.290556, lon: -76.610351 };
  const BALTIMORE_NAD = [
    { attributes: {"AddNo_Full":"100","St_Name":"Holliday","St_PosTyp":"Street","Unit":"APT 101","Inc_Muni":"Baltimore","Post_City":"Baltimore","Zip_Code":"21202","Placement":"Unknown","NAD_Source":"Maryland Department of Information Technology","Latitude":39.290878,"Longitude":-76.610511} },
    { attributes: {"AddNo_Full":"100","St_Name":"Holliday","St_PosTyp":"Street","Inc_Muni":"Baltimore","Post_City":"Baltimore","Zip_Code":"21202","Placement":"Unknown","NAD_Source":"Maryland Department of Information Technology","Latitude":39.290878,"Longitude":-76.610511} },
    { attributes: {"AddNo_Full":"234","St_Name":"Holliday","St_PosTyp":"Street","Unit":"205","Inc_Muni":"Baltimore","Post_City":"Baltimore","Zip_Code":"21202","Placement":"Unknown","NAD_Source":"Maryland Department of Information Technology","Latitude":39.292255,"Longitude":-76.610524} },
    { attributes: {"AddNo_Full":"200","St_Name":"Holliday","St_PosTyp":"Street","Inc_Muni":"Baltimore","Post_City":"Baltimore","Zip_Code":"21202","Placement":"Unknown","NAD_Source":"Maryland Department of Information Technology","Latitude":39.291662,"Longitude":-76.610555} },
    { attributes: {"AddNo_Full":"234","St_Name":"Holliday","St_PosTyp":"Street","Unit":"206","Inc_Muni":"Baltimore","Post_City":"Baltimore","Zip_Code":"21202","Placement":"Unknown","NAD_Source":"Maryland Department of Information Technology","Latitude":39.292255,"Longitude":-76.610524} },
    { attributes: {"AddNo_Full":"234","St_Name":"Holliday","St_PosTyp":"Street","Unit":"304","Inc_Muni":"Baltimore","Post_City":"Baltimore","Zip_Code":"21202","Placement":"Unknown","NAD_Source":"Maryland Department of Information Technology","Latitude":39.292255,"Longitude":-76.610524} },
    { attributes: {"AddNo_Full":"229","St_Name":"Holliday","St_PosTyp":"Street","Inc_Muni":"Baltimore","Post_City":"Baltimore","Zip_Code":"21202","Placement":"Unknown","NAD_Source":"Maryland Department of Information Technology","Latitude":39.29205,"Longitude":-76.610137} },
    { attributes: {"AddNo_Full":"234","St_Name":"Holliday","St_PosTyp":"Street","Unit":"201","Inc_Muni":"Baltimore","Post_City":"Baltimore","Zip_Code":"21202","Placement":"Unknown","NAD_Source":"Maryland Department of Information Technology","Latitude":39.292255,"Longitude":-76.610524} },
  ];

  // 710 20th St N, Birmingham, AL 35203
  // Census interpolates to 33.519727, -86.810285; 73 NAD points in the 300m box, 6 on this street, 1 at this exact number.
  const BIRMINGHAM_INTERPOLATED = { lat: 33.519727, lon: -86.810285 };
  const BIRMINGHAM_NAD = [
    { attributes: {"AddNo_Full":"710","St_Name":"20th","St_PosTyp":"Street","St_PosDir":"North","Inc_Muni":"Birmingham","Post_City":"Not stated","Zip_Code":"35203","Placement":"Unknown","NAD_Source":"Alabama 911 Board","Latitude":33.520056,"Longitude":-86.810896} },
    { attributes: {"AddNo_Full":"420","St_Name":"20th","St_PosTyp":"Street","St_PosDir":"North","Inc_Muni":"Birmingham","Post_City":"Not stated","Zip_Code":"35203","Placement":"Unknown","NAD_Source":"Alabama 911 Board","Latitude":33.517618,"Longitude":-86.808477} },
    { attributes: {"AddNo_Full":"325","St_Name":"20th","St_PosTyp":"Street","St_PosDir":"North","Inc_Muni":"Birmingham","Post_City":"Not stated","Zip_Code":"35203","Placement":"Unknown","NAD_Source":"Alabama 911 Board","Latitude":33.517186,"Longitude":-86.807145} },
    { attributes: {"AddNo_Full":"600","St_Name":"20th","St_PosTyp":"Street","St_PosDir":"North","Inc_Muni":"Birmingham","Post_City":"Not stated","Zip_Code":"35203","Placement":"Unknown","NAD_Source":"Alabama 911 Board","Latitude":33.519342,"Longitude":-86.809356} },
    { attributes: {"AddNo_Full":"417","St_Name":"20th","St_PosTyp":"Street","St_PosDir":"North","Inc_Muni":"Birmingham","Post_City":"Not stated","Zip_Code":"35203","Placement":"Unknown","NAD_Source":"Alabama 911 Board","Latitude":33.518035,"Longitude":-86.807627} },
    { attributes: {"AddNo_Full":"528","St_Name":"20th","St_PosTyp":"Street","St_PosDir":"North","Inc_Muni":"Birmingham","Post_City":"Not stated","Zip_Code":"35203","Placement":"Unknown","NAD_Source":"Alabama 911 Board","Latitude":33.518568,"Longitude":-86.809433} },
  ];

  const asPoints = async (features: unknown[]) => {
    const fetched = await fetchAddressPointsNear(39.9, -83.0, 300, nadResponse(features), FAST_NAD);
    assert.equal(fetched.ok, true);
    return fetched.ok ? fetched.points : [];
  };

  describe('reading the service response', () => {
    test('composes a written street name out of NAD\'s separate columns, and keeps unit/source/placement', async () => {
      const points = await asPoints(COLUMBUS_NAD);
      const ninety = points.find((p) => p.houseNumber === '90');
      assert.equal(ninety?.street, 'West BROAD Street');
      assert.equal(ninety?.source, 'State of Ohio');
      assert.equal(ninety?.lat, 39.962431);
      assert.equal(ninety?.lon, -83.003328);
      const unitPoint = points.find((p) => p.unit === '2002');
      assert.equal(unitPoint?.houseNumber, '50');
    });

    test('a post-directional street ("20th Street North") survives composition in the right order', async () => {
      const points = await asPoints(BIRMINGHAM_NAD);
      assert.equal(points.find((p) => p.houseNumber === '710')?.street, '20th Street North');
    });

    test('the query is the bounding-box form this service actually accepts', async () => {
      let seenUrl = '';
      const spyFetch = (async (url: string) => {
        seenUrl = String(url);
        return new Response(JSON.stringify({ features: [] }), { status: 200 });
      }) as unknown as typeof fetch;

      await fetchAddressPointsNear(39.962072, -83.002493, 300, spyFetch, FAST_NAD);
      const params = new URL(seenUrl).searchParams;
      assert.equal(params.get('geometryType'), 'esriGeometryEnvelope');
      assert.equal(params.get('inSR'), '4326');
      // outFields=* and no resultRecordCount: both deliberate, see rooftop.ts.
      assert.equal(params.get('outFields'), '*');
      assert.equal(params.get('resultRecordCount'), null);
      const [west, south, east, north] = (params.get('geometry') ?? '').split(',').map(Number);
      assert.ok(west < -83.002493 && east > -83.002493, 'box should straddle the point');
      assert.ok(south < 39.962072 && north > 39.962072, 'box should straddle the point');
    });

    test('an ArcGIS error object returned WITH HTTP 200 is a failure, not an empty area', async () => {
      // This service answers a rejected query with 200 and an error body —
      // reading that as "no address points here" would turn a bad request
      // into false evidence about an address.
      const errorBody = (async () =>
        new Response(JSON.stringify({ error: { code: 400, message: 'Invalid query parameters.' } }), {
          status: 200,
        })) as unknown as typeof fetch;

      const result = await fetchAddressPointsNear(39.9, -83.0, 300, errorBody, FAST_NAD);
      assert.equal(result.ok, false);
    });

    test('a genuinely empty area is {ok: true, points: []} — distinct from the service being down', async () => {
      const empty = await fetchAddressPointsNear(39.9, -83.0, 300, nadResponse([]), FAST_NAD);
      assert.equal(empty.ok, true);
      if (empty.ok) assert.deepEqual(empty.points, []);

      const down = (async () => {
        throw new Error('network down');
      }) as unknown as typeof fetch;
      const failed = await fetchAddressPointsNear(39.9, -83.0, 300, down, FAST_NAD);
      assert.equal(failed.ok, false);
    });
  });

  describe('matching an address to its authoritative point (pure)', () => {
    test('Columbus: finds the one point published for 90 W Broad St', async () => {
      const match = matchAddressPoint('90 W Broad St, Columbus, OH 43215', await asPoints(COLUMBUS_NAD));
      assert.equal(match?.matchCount, 1);
      assert.equal(match?.directionalFallback, false);
      assert.deepEqual(match?.point, { lat: 39.962431, lon: -83.003328 });
      assert.equal(match?.chosen.source, 'State of Ohio');
    });

    test('a tower published as one point per unit collapses to a point inside that tower', async () => {
      // LeVeque Tower's 50 W Broad address has dozens of unit points; the
      // group's centre is inside the building, and the spread is
      // building-sized rather than block-sized.
      const match = matchAddressPoint('50 W Broad St, Columbus, OH 43215', await asPoints(COLUMBUS_NAD));
      assert.ok(match!.matchCount > 1);
      assert.ok(match!.spreadMeters < 60, `expected one building, got ${match!.spreadMeters}m of spread`);
      assert.equal(match!.matchedUnit, false);
    });

    test('naming the unit picks that unit\'s own point, not the group centre', async () => {
      const match = matchAddressPoint('50 W Broad St Apt 2002, Columbus, OH 43215', await asPoints(COLUMBUS_NAD));
      assert.equal(match?.matchedUnit, true);
      assert.equal(match?.chosen.unit, '2002');
      assert.deepEqual(match?.point, { lat: 39.962351, lon: -83.002154 });
    });

    test('Baltimore: matches when the authority publishes the street WITHOUT the directional the address uses', async () => {
      const match = matchAddressPoint('100 N Holliday St, Baltimore, MD 21202', await asPoints(BALTIMORE_NAD));
      assert.equal(match?.directionalFallback, true);
      assert.equal(match?.chosen.street, 'Holliday Street');
      assert.deepEqual(match?.point, { lat: 39.290878, lon: -76.610511 });
    });

    test('Detroit: matches when the authority publishes the street with NO type at all ("ST ANTOINE" vs "St Antoine St")', async () => {
      const detroitNad = [
        {
          attributes: {
            AddNo_Full: '1901',
            St_Name: 'St Antoine',
            Inc_Muni: 'Detroit',
            Post_City: 'Detroit',
            Zip_Code: '48226',
            Placement: 'Unknown',
            NAD_Source: 'Wayne County',
            Latitude: 42.335,
            Longitude: -83.041,
          },
        },
      ];
      const match = matchAddressPoint('1901 St Antoine St, Detroit, MI 48226', await asPoints(detroitNad));
      assert.equal(match?.streetTypeFallback, true);
      assert.equal(match?.chosen.street, 'St Antoine');
      assert.deepEqual(match?.point, { lat: 42.335, lon: -83.041 });
    });

    test('the street-type fallback NEVER crosses two genuinely different streets — "Main Street" and "Main Avenue" a block apart must not average into a point on neither', async () => {
      // The exact risk streetTypeFallback's own doc comment names: a grid
      // city can carry the same house number on both. Neither type matches
      // the target's own ("Main Rd") exactly, so both only surface once the
      // type is stripped down to "main" — and the tight-cluster guard must
      // reject them rather than average two real, distant buildings.
      const gridCity = [
        { attributes: { AddNo_Full: '100', St_Name: 'Main', St_PosTyp: 'Street', Latitude: 39.9, Longitude: -83.0 } },
        { attributes: { AddNo_Full: '100', St_Name: 'Main', St_PosTyp: 'Avenue', Latitude: 39.905, Longitude: -83.0 } },
      ];
      const match = matchAddressPoint('100 Main Rd, Columbus, OH 43215', await asPoints(gridCity));
      assert.equal(match, null);
    });

    test('Birmingham: matches a street whose type sits BEFORE its directional', async () => {
      const match = matchAddressPoint('710 20th St N, Birmingham, AL 35203', await asPoints(BIRMINGHAM_NAD));
      assert.equal(match?.directionalFallback, false);
      assert.deepEqual(match?.point, { lat: 33.520056, lon: -86.810896 });
    });

    test('the fallback NEVER crosses two directionals — W Broad must not match E Broad', async () => {
      // Downtown Columbus has both, at overlapping numbers. An earlier
      // version of this matched them and returned a point on the wrong side
      // of the street; the same loosening also produced a point on North
      // Main for an address on West Main in Edmonton, KY.
      const match = matchAddressPoint('20 W Broad St, Columbus, OH 43215', await asPoints(COLUMBUS_NAD));
      assert.equal(match, null);
    });

    test('a house number the authority has never published gets no point at all, rather than a near one', async () => {
      const match = matchAddressPoint('711 20th St N, Birmingham, AL 35203', await asPoints(BIRMINGHAM_NAD));
      assert.equal(match, null);
    });

    test('an address with no house number cannot be matched', async () => {
      assert.equal(matchAddressPoint('Broadway, New York, NY', await asPoints(COLUMBUS_NAD)), null);
    });
  });

  describe('resolveRooftop — the whole lookup, end to end', () => {
    test('Columbus: reports the authoritative point and how far it moved from the interpolated one', async () => {
      const result = await resolveRooftop(
        '90 W Broad St, Columbus, OH 43215',
        COLUMBUS_INTERPOLATED,
        nadResponse(COLUMBUS_NAD),
        FAST_NAD,
      );
      assert.equal(result.attempted, true);
      assert.equal(result.found, true);
      assert.equal(result.ambiguous, false);
      assert.deepEqual(result.point, { lat: 39.962431, lon: -83.003328 });
      // The real size of the interpolation error being corrected here.
      assert.ok(
        result.metersFromInterpolated! > 70 && result.metersFromInterpolated! < 95,
        `expected roughly 82m, got ${result.metersFromInterpolated}`,
      );
    });

    test('an address the database has no point for is found: false, attempted: true — a real answer, not a failure', async () => {
      const result = await resolveRooftop(
        '2 Woodward Ave, Detroit, MI 48226',
        { lat: 42.3297, lon: -83.0455 },
        nadResponse([]),
        FAST_NAD,
      );
      assert.equal(result.attempted, true);
      assert.equal(result.found, false);
      assert.equal(result.point, null);
    });

    test('an unreachable service is attempted: false — no evidence either way, exactly like the other cross-checks', async () => {
      const down = (async () => {
        throw new Error('network down');
      }) as unknown as typeof fetch;
      const result = await resolveRooftop('90 W Broad St, Columbus, OH 43215', COLUMBUS_INTERPOLATED, down, FAST_NAD);
      assert.equal(result.attempted, false);
      assert.equal(result.found, false);
    });

    test('points too far apart to be one building are returned but flagged ambiguous, never silently averaged', async () => {
      // Same number, same street name, half a kilometre apart — the shape a
      // search box catches when one street name repeats in two places.
      const twoPlaces = [
        { attributes: { AddNo_Full: '100', St_Name: 'Main', St_PosTyp: 'Street', Latitude: 39.9, Longitude: -83.0 } },
        { attributes: { AddNo_Full: '100', St_Name: 'Main', St_PosTyp: 'Street', Latitude: 39.905, Longitude: -83.0 } },
      ];
      const result = await resolveRooftop(
        '100 Main St, Somewhere, OH',
        { lat: 39.9, lon: -83.0 },
        nadResponse(twoPlaces),
        FAST_NAD,
      );
      assert.equal(result.found, true);
      assert.equal(result.ambiguous, true);
      assert.ok(result.match!.spreadMeters > 200);
    });

    test('North Dakota: an exact match found only by widening the search radius, after every normal-radius tier fails', async () => {
      // The real case this tier exists for: North Dakota's own submission
      // publishes 600 E Boulevard Ave, Bismarck — just 444m from Census's
      // interpolated point, outside the normal 300m box. The first fetch
      // (300m) returns no point at all; only the SECOND, wider fetch (600m)
      // carries it, so this also proves the widened search is a genuine
      // last resort rather than always querying at the larger radius.
      let nadCalls = 0;
      const growingRadius = (async (url: string) => {
        const target = String(url);
        if (target.includes('nominatim')) {
          return new Response(JSON.stringify([]), { status: 200 }); // no OSM corroboration either
        }
        nadCalls++;
        if (nadCalls === 1) return new Response(JSON.stringify({ features: [] }), { status: 200 });
        return new Response(
          JSON.stringify({
            features: [
              {
                attributes: {
                  AddNo_Full: '600',
                  St_PreDir: 'East',
                  St_Name: 'Boulevard',
                  St_PosTyp: 'Avenue',
                  Post_City: 'BISMARCK',
                  Zip_Code: '58505',
                  Placement: 'Unknown',
                  NAD_Source: 'State of North Dakota',
                  Latitude: 46.82067,
                  Longitude: -100.7827,
                },
              },
            ],
          }),
          { status: 200 },
        );
      }) as unknown as typeof fetch;

      const result = await resolveRooftop(
        '600 E Boulevard Ave, Bismarck, ND 58505',
        { lat: 46.8168, lon: -100.7813 },
        growingRadius,
        FAST_NAD,
      );
      assert.equal(nadCalls, 2, 'expected exactly one narrow-radius NAD query, then one wide-radius NAD query');
      assert.equal(result.found, true);
      assert.equal(result.tier, 'authoritative');
      assert.equal(result.match!.chosen.source, 'State of North Dakota');
      assert.ok(
        result.metersFromInterpolated! > 400 && result.metersFromInterpolated! < 500,
        `expected roughly 444m, got ${result.metersFromInterpolated}`,
      );
    });

    test('an OSM/parcel result already found at the normal radius is never displaced by a wide-radius retry', async () => {
      // Same Columbus address the first test in this block uses, whose
      // exact-match point already resolves within the normal 300m box —
      // the wide-radius fallback must never even be attempted.
      let calls = 0;
      const countingFetch = (async () => {
        calls++;
        return new Response(JSON.stringify({ features: COLUMBUS_NAD }), { status: 200 });
      }) as unknown as typeof fetch;
      const result = await resolveRooftop(
        '90 W Broad St, Columbus, OH 43215',
        COLUMBUS_INTERPOLATED,
        countingFetch,
        FAST_NAD,
      );
      assert.equal(result.tier, 'authoritative');
      assert.equal(calls, 1, 'a normal-radius match must not trigger a second, wider fetch');
    });
  });

  /**
   * The two fallback tiers, which exist because authoritative coverage is
   * real but partial: measured over one Census-verified address in each of
   * the 51 US jurisdictions (npm run coverage:geocode), 34 have an
   * authoritative point published, and without these tiers the other 17
   * would fall all the way back to Census's interpolation.
   */
  describe('the fallback tiers — OSM house points and neighbour brackets', () => {
    const FAST = { minIntervalMs: 0, baseBackoffMs: 0 };

    /** Routes by URL, since a tiered resolution talks to two different services in one call. */
    const twoServiceFetch = (opts: { nad?: unknown[]; nominatim?: unknown[] }) =>
      (async (url: string) => {
        const target = String(url);
        if (target.includes('nominatim')) {
          return new Response(JSON.stringify(opts.nominatim ?? []), { status: 200 });
        }
        return new Response(JSON.stringify({ features: opts.nad ?? [] }), { status: 200 });
      }) as unknown as typeof fetch;

    /** The shape Nominatim returns for a house-level hit, trimmed to what this module reads. */
    const osmHouse = (opts: { lat: number; lon: number; houseNumber: string; road: string; rank?: number }) => [
      {
        lat: String(opts.lat),
        lon: String(opts.lon),
        place_rank: opts.rank ?? 30,
        address: { house_number: opts.houseNumber, road: opts.road },
      },
    ];

    describe('parseAddressParts (pure)', () => {
      test('splits a one-line US address into the fields a structured geocoder wants', () => {
        assert.deepEqual(parseAddressParts('90 W Broad St, Columbus, OH 43215'), {
          houseNumber: '90',
          street: 'W Broad St',
          city: 'Columbus',
          state: 'OH',
          postalcode: '43215',
        });
      });

      test('a missing ZIP is null rather than a guess, and the state still reads', () => {
        const parts = parseAddressParts('2 Woodward Ave, Detroit, MI');
        assert.equal(parts.state, 'MI');
        assert.equal(parts.postalcode, null);
        assert.equal(parts.city, 'Detroit');
      });

      test('a street with no house number yields a null number, not an empty string', () => {
        assert.equal(parseAddressParts('Broadway, New York, NY 10019').houseNumber, null);
      });
    });

    describe('neighborBracket (pure, real published numbers)', () => {
      test('interpolates between the nearest published numbers on either side', async () => {
        // Maryland publishes 100, 200, 229 and 234 Holliday Street but not
        // 215 — so 215 sits between the real points for 200 and 229.
        const points = await asPoints(BALTIMORE_NAD);
        const bracket = neighborBracket('215 Holliday St, Baltimore, MD 21202', points);
        assert.equal(bracket?.below.houseNumber, '200');
        assert.equal(bracket?.above.houseNumber, '229');
        assert.ok(bracket!.point.lat > 39.291662 && bracket!.point.lat < 39.29205, 'point should sit between the two');
      });

      test('refuses to extrapolate past the last published number', async () => {
        const points = await asPoints(BALTIMORE_NAD);
        assert.equal(neighborBracket('400 Holliday St, Baltimore, MD 21202', points), null);
      });

      test('refuses a bracket too many house numbers wide to describe a block', async () => {
        // Birmingham publishes 600 and 710 on 20th Street North. 650 is a
        // usable bracket; 700 would lean 100 numbers off the lower point.
        const points = await asPoints(BIRMINGHAM_NAD);
        assert.ok(neighborBracket('650 20th St N, Birmingham, AL 35203', points) !== null);
        assert.equal(neighborBracket('705 20th St N, Birmingham, AL 35203', points), null);
      });
    });

    describe("the OSM tier, and why it isn't trusted on its own", () => {
      test('uses an OSM house-level point when it corroborates where Census put the address', async () => {
        const result = await resolveRooftop(
          '400 S Monroe St, Tallahassee, FL 32399',
          { lat: 30.43854, lon: -84.28186 },
          twoServiceFetch({
            nad: [],
            nominatim: osmHouse({ lat: 30.4381654, lon: -84.28135, houseNumber: '400', road: 'South Monroe Street' }),
          }),
          FAST,
        );
        assert.equal(result.found, true);
        assert.equal(result.tier, 'osm-corroborated');
        assert.deepEqual(result.point, { lat: 30.4381654, lon: -84.28135 });
        assert.ok(result.metersFromInterpolated! < 250);
      });

      test('REFUSES the real OSM answer for 90 W Broad St, which is 897m away on the wrong side of the river', async () => {
        // These are the actual coordinates Nominatim returns for that
        // address — rank 30, house number 90, and wrong. Corroboration is
        // the only thing standing between this module and that error.
        const result = await resolveRooftop(
          '90 W Broad St, Columbus, OH 43215',
          COLUMBUS_INTERPOLATED,
          twoServiceFetch({
            nad: [],
            nominatim: osmHouse({ lat: 39.9615852, lon: -83.0129995, houseNumber: '90', road: 'West Broad Street' }),
          }),
          FAST,
        );
        assert.equal(result.found, false);
        assert.equal(result.tier, null);
      });

      test('refuses a street-level OSM result, however close it lands', async () => {
        const result = await resolveRooftop(
          '400 S Monroe St, Tallahassee, FL 32399',
          { lat: 30.43854, lon: -84.28186 },
          twoServiceFetch({
            nad: [],
            nominatim: osmHouse({ lat: 30.4385, lon: -84.2818, houseNumber: '400', road: 'South Monroe Street', rank: 26 }),
          }),
          FAST,
        );
        assert.equal(result.found, false);
      });

      test('refuses an OSM result for a different house number', async () => {
        const result = await resolveRooftop(
          '400 S Monroe St, Tallahassee, FL 32399',
          { lat: 30.43854, lon: -84.28186 },
          twoServiceFetch({
            nad: [],
            nominatim: osmHouse({ lat: 30.4385, lon: -84.2818, houseNumber: '402', road: 'South Monroe Street' }),
          }),
          FAST,
        );
        assert.equal(result.found, false);
      });

      test('an authoritative point always wins — the OSM service is never even asked', async () => {
        let nominatimCalled = false;
        const spyFetch = (async (url: string) => {
          if (String(url).includes('nominatim')) {
            nominatimCalled = true;
            return new Response('[]', { status: 200 });
          }
          return new Response(JSON.stringify({ features: COLUMBUS_NAD }), { status: 200 });
        }) as unknown as typeof fetch;

        const result = await resolveRooftop('90 W Broad St, Columbus, OH 43215', COLUMBUS_INTERPOLATED, spyFetch, FAST);
        assert.equal(result.tier, 'authoritative');
        assert.equal(nominatimCalled, false);
      });
    });

    describe('the parcel-centroid tier — county tax-parcel data, gated hard against real misattribution', () => {
      const PA_SOURCE = PARCEL_SOURCES.find((s) => s.state === 'PA')!;
      const HARRISBURG_INTERPOLATED = { lat: 40.263316301322, lon: -76.884360658074 };

      /** A square ring roughly sideMeters across, centered on (lat, lon). Good enough for area/centroid math at parcel scale. */
      const squareRing = (lat: number, lon: number, sideMeters: number): number[][] => {
        const dLat = sideMeters / 2 / 111_320;
        const dLon = sideMeters / 2 / (111_320 * Math.cos((lat * Math.PI) / 180));
        return [
          [lon - dLon, lat - dLat],
          [lon + dLon, lat - dLat],
          [lon + dLon, lat + dLat],
          [lon - dLon, lat + dLat],
          [lon - dLon, lat - dLat],
        ];
      };

      const parcelFeature = (opts: { houseNumber: string; street: string; lat: number; lon: number; sideMeters: number }) => ({
        attributes: { house_numb: opts.houseNumber, street_nam: opts.street },
        geometry: { rings: [squareRing(opts.lat, opts.lon, opts.sideMeters)] },
      });

      /** Routes by URL across all three services a resolution can call — NAD, Nominatim, and this one registered parcel source. */
      const threeServiceFetch = (opts: { nad?: unknown[]; nominatim?: unknown[]; parcel?: unknown[] }) =>
        (async (url: string) => {
          const target = String(url);
          if (target.includes('nominatim')) return new Response(JSON.stringify(opts.nominatim ?? []), { status: 200 });
          if (target.startsWith(PA_SOURCE.queryUrl)) {
            return new Response(JSON.stringify({ features: opts.parcel ?? [] }), { status: 200 });
          }
          return new Response(JSON.stringify({ features: opts.nad ?? [] }), { status: 200 });
        }) as unknown as typeof fetch;

      test('resolveParcelCentroid: an UNATTRIBUTED small parcel (no house number at all) is used when no exact match exists — the real Capitol case', async () => {
        const result = await resolveParcelCentroid(
          '501 N 3rd St, Harrisburg, PA 17120',
          HARRISBURG_INTERPOLATED,
          (async () =>
            new Response(
              JSON.stringify({
                features: [parcelFeature({ houseNumber: '', street: '', ...HARRISBURG_INTERPOLATED, sideMeters: 17 })],
              }),
              { status: 200 },
            )) as unknown as typeof fetch,
          { baseBackoffMs: 0 },
        );
        assert.ok(result);
        assert.equal(result!.source.state, 'PA');
        assert.ok(result!.areaSquareMeters < 300);
      });

      test('resolveParcelCentroid: NEVER uses a parcel with a real, different address, however close it is', async () => {
        // The exact bug caught live: the nearest SMALL parcel to the target
        // point was attributed to house number 400, not the target's 501 —
        // a different, real building. Distance alone must never win.
        const wrongAddress = parcelFeature({
          houseNumber: '400',
          street: '3RD',
          lat: HARRISBURG_INTERPOLATED.lat + 0.00002,
          lon: HARRISBURG_INTERPOLATED.lon,
          sideMeters: 17,
        });
        const result = await resolveParcelCentroid(
          '501 N 3rd St, Harrisburg, PA 17120',
          HARRISBURG_INTERPOLATED,
          (async () => new Response(JSON.stringify({ features: [wrongAddress] }), { status: 200 })) as unknown as typeof fetch,
          { baseBackoffMs: 0 },
        );
        assert.equal(result, null);
      });

      test('resolveParcelCentroid: an EXACT address match wins even when a closer unattributed parcel also exists', async () => {
        const exact = parcelFeature({
          houseNumber: '501',
          street: 'N 3rd St',
          lat: HARRISBURG_INTERPOLATED.lat + 0.0001,
          lon: HARRISBURG_INTERPOLATED.lon,
          sideMeters: 17,
        });
        const unattributedCloser = parcelFeature({
          houseNumber: '',
          street: '',
          ...HARRISBURG_INTERPOLATED,
          sideMeters: 17,
        });
        const result = await resolveParcelCentroid(
          '501 N 3rd St, Harrisburg, PA 17120',
          HARRISBURG_INTERPOLATED,
          (async () =>
            new Response(JSON.stringify({ features: [unattributedCloser, exact] }), { status: 200 })) as unknown as typeof fetch,
          { baseBackoffMs: 0 },
        );
        assert.ok(result);
        assert.ok(result!.metersFromInterpolated > 5, 'should have picked the farther EXACT match, not the closer unattributed one');
      });

      test('resolveParcelCentroid: a directional/street-type mismatch ("3RD" vs "N 3rd St") still counts as exact', async () => {
        const bareStreetName = parcelFeature({
          houseNumber: '501',
          street: '3RD',
          ...HARRISBURG_INTERPOLATED,
          sideMeters: 17,
        });
        const result = await resolveParcelCentroid(
          '501 N 3rd St, Harrisburg, PA 17120',
          HARRISBURG_INTERPOLATED,
          (async () => new Response(JSON.stringify({ features: [bareStreetName] }), { status: 200 })) as unknown as typeof fetch,
          { baseBackoffMs: 0 },
        );
        assert.ok(result);
      });

      test('resolveParcelCentroid: an oversized parcel (a whole government campus) is rejected outright — the real Mississippi finding', async () => {
        const wholeCampus = parcelFeature({
          houseNumber: '',
          street: '',
          ...HARRISBURG_INTERPOLATED,
          sideMeters: 300, // 90,000 sqm, an order of magnitude over the gate
        });
        const result = await resolveParcelCentroid(
          '501 N 3rd St, Harrisburg, PA 17120',
          HARRISBURG_INTERPOLATED,
          (async () => new Response(JSON.stringify({ features: [wholeCampus] }), { status: 200 })) as unknown as typeof fetch,
          { baseBackoffMs: 0 },
        );
        assert.equal(result, null);
      });

      test('resolveParcelCentroid: no registered source for this state means no query is even attempted', async () => {
        let called = false;
        const result = await resolveParcelCentroid(
          '400 High St, Jackson, MS 39201',
          { lat: 32.305111271605, lon: -90.183041057541 },
          (async () => {
            called = true;
            return new Response('{}', { status: 200 });
          }) as unknown as typeof fetch,
          { baseBackoffMs: 0 },
        );
        assert.equal(result, null);
        assert.equal(called, false);
      });

      test('resolveRooftop: a parcel centroid CLOSER than OSM wins the tier', async () => {
        const closeParcel = parcelFeature({ houseNumber: '', street: '', ...HARRISBURG_INTERPOLATED, sideMeters: 17 });
        const result = await resolveRooftop(
          '501 N 3rd St, Harrisburg, PA 17120',
          HARRISBURG_INTERPOLATED,
          threeServiceFetch({
            nad: [],
            nominatim: osmHouse({
              lat: HARRISBURG_INTERPOLATED.lat + 0.002,
              lon: HARRISBURG_INTERPOLATED.lon,
              houseNumber: '501',
              road: 'North 3rd Street',
            }),
            parcel: [closeParcel],
          }),
          FAST,
        );
        assert.equal(result.tier, 'parcel-centroid');
      });

      test('resolveRooftop: OSM wins when it is CLOSER than the parcel centroid', async () => {
        const farParcel = parcelFeature({
          houseNumber: '',
          street: '',
          lat: HARRISBURG_INTERPOLATED.lat + 0.001,
          lon: HARRISBURG_INTERPOLATED.lon,
          sideMeters: 17,
        });
        const result = await resolveRooftop(
          '501 N 3rd St, Harrisburg, PA 17120',
          HARRISBURG_INTERPOLATED,
          threeServiceFetch({
            nad: [],
            nominatim: osmHouse({
              lat: HARRISBURG_INTERPOLATED.lat + 0.00002,
              lon: HARRISBURG_INTERPOLATED.lon,
              houseNumber: '501',
              road: 'North 3rd Street',
            }),
            parcel: [farParcel],
          }),
          FAST,
        );
        assert.equal(result.tier, 'osm-corroborated');
      });
    });
  });
});

/**
 * Taxing districts that Census doesn't publish. Both response shapes below
 * are the real ones, captured live from the publishing governments' own
 * ArcGIS services: Ohio's JEDD/JEDZ layer answers with name/jedd_id/active
 * attributes, and Metro's boundary layer answers an ids-only intersect
 * query with an objectIds array.
 */
describe('districts.ts — taxing boundaries that are not Census geographies (mocked fetch)', () => {
  const FAST = { baseBackoffMs: 0 };
  const json = (body: unknown, status = 200) =>
    (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;
  const throws = (async () => {
    throw new Error('network down');
  }) as unknown as typeof fetch;

  describe('jeddAtPoint — Ohio JEDDs and JEDZs', () => {
    /** The real answer for a point inside the Bath-Akron-Fairlawn JEDD's own published polygon. */
    const BATH_AKRON_FAIRLAWN = {
      features: [{ attributes: { name: 'BATH-AKRON-FAIRLAWN JEDD', jedd_id: 9004, active: 'Y' } }],
    };

    test('returns the containing zone and its id — the exact join key into the rate file', async () => {
      const result = await jeddAtPoint(41.1405, -81.643096, json(BATH_AKRON_FAIRLAWN), FAST);
      assert.equal(result.attempted, true);
      assert.equal(result.jedd?.name, 'BATH-AKRON-FAIRLAWN JEDD');
      // Ohio ships the id as a number here and as a string in its rate
      // database; normalising to string is what makes the join work.
      assert.equal(result.jedd?.jeddId, '9004');
      assert.equal(result.jedd?.active, true);
    });

    test('an address in no zone is attempted: true with no zone — a real answer, not a failure', async () => {
      const result = await jeddAtPoint(39.9612, -83.0007, json({ features: [] }), FAST);
      assert.equal(result.attempted, true);
      assert.equal(result.jedd, null);
    });

    test('an inactive zone is reported rather than hidden, so a reviewer can see why no tax applied', async () => {
      const result = await jeddAtPoint(
        41.1405,
        -81.643096,
        json({ features: [{ attributes: { name: 'OLD JEDD', jedd_id: 9999, active: 'N' } }] }),
        FAST,
      );
      assert.equal(result.jedd?.active, false);
      assert.equal(result.jedd?.jeddId, '9999');
    });

    test('an unreachable service is attempted: false — never "there is no JEDD here"', async () => {
      const result = await jeddAtPoint(41.1405, -81.643096, throws, FAST);
      assert.deepEqual(result, { attempted: false, jedd: null });
    });

    test('an ArcGIS error body returned with HTTP 200 is a failure, not an empty area', async () => {
      const result = await jeddAtPoint(41.1405, -81.643096, json({ error: { code: 400 } }), FAST);
      assert.equal(result.attempted, false);
    });

    test('queries the point as WGS84 against Ohio\'s own layer', async () => {
      let seen = '';
      const spy = (async (url: string) => {
        seen = String(url);
        return new Response(JSON.stringify({ features: [] }), { status: 200 });
      }) as unknown as typeof fetch;

      await jeddAtPoint(41.1405, -81.643096, spy, FAST);
      const params = new URL(seen).searchParams;
      assert.match(seen, /maps\.ohio\.gov/);
      assert.equal(params.get('geometryType'), 'esriGeometryPoint');
      assert.equal(params.get('inSR'), '4326');
      assert.equal(params.get('spatialRel'), 'esriSpatialRelIntersects');
      assert.deepEqual(JSON.parse(params.get('geometry') ?? '{}'), {
        x: -81.643096,
        y: 41.1405,
        spatialReference: { wkid: 4326 },
      });
    });
  });

  describe('isInsidePortlandMetro', () => {
    test('a point inside the district comes back inside', async () => {
      const result = await isInsidePortlandMetro(45.51224, -122.6587, json({ objectIds: [1] }), FAST);
      assert.deepEqual(result, { attempted: true, inside: true });
    });

    test('a point outside comes back outside, not unknown', async () => {
      const result = await isInsidePortlandMetro(44.93826, -123.03027, json({ objectIds: [] }), FAST);
      assert.deepEqual(result, { attempted: true, inside: false });
    });

    test('a server that ignores returnIdsOnly and answers with features is still understood', async () => {
      const result = await isInsidePortlandMetro(45.51224, -122.6587, json({ features: [{}] }), FAST);
      assert.equal(result.inside, true);
    });

    test('an unreachable service is attempted: false — distinct from "outside the district"', async () => {
      const result = await isInsidePortlandMetro(45.51224, -122.6587, throws, FAST);
      assert.deepEqual(result, { attempted: false, inside: false });
    });
  });

  describe("oregonTransitDistrictAtPoint — ODOT's unified statewide jurisdictions layer", () => {
    /** The real shape ODOT's own service answers with — a point can be inside more than one nested jurisdiction at once (e.g. a county AND a transit district), so the payroll-tax lookup has to scan every feature, not just trust features[0]. */
    const withNames = (...names: string[]) =>
      json({ features: names.map((JRSDCT_NM) => ({ attributes: { JRSDCT_NM } })) });

    test('a Portland point maps to TriMet by name', async () => {
      const result = await oregonTransitDistrictAtPoint(
        45.5152,
        -122.6784,
        withNames('Portland', 'Multnomah County', 'Tri County Metropolitan Mass Transit District of Oregon'),
        FAST,
      );
      assert.deepEqual(result, { attempted: true, locality: 'TriMet' });
    });

    test('a Eugene point maps to LTD by name', async () => {
      const result = await oregonTransitDistrictAtPoint(44.0521, -123.0868, withNames('Eugene', 'Lane Transit District'), FAST);
      assert.deepEqual(result, { attempted: true, locality: 'LTD' });
    });

    test('a Molalla point maps to SCTD, not to the OTHER real feature (Molalla River School District) also returned', async () => {
      const result = await oregonTransitDistrictAtPoint(
        45.1487,
        -122.5762,
        withNames('Molalla', 'Clackamas County', 'South Clackamas Transit District', 'Molalla River School District'),
        FAST,
      );
      assert.deepEqual(result, { attempted: true, locality: 'SCTD' });
    });

    test('a point inside a PROPERTY-tax-funded district (Rogue Valley) correctly answers no payroll-tax locality, not unknown', async () => {
      const result = await oregonTransitDistrictAtPoint(42.3265, -122.8756, withNames('Medford', 'Rogue Valley Transportation District'), FAST);
      assert.deepEqual(result, { attempted: true, locality: null });
    });

    test('a point inside no jurisdiction at all answers no locality', async () => {
      const result = await oregonTransitDistrictAtPoint(45.51224, -122.6784, json({ features: [] }), FAST);
      assert.deepEqual(result, { attempted: true, locality: null });
    });

    test('an unreachable service is attempted: false — distinct from "no payroll-tax district here"', async () => {
      const result = await oregonTransitDistrictAtPoint(45.5152, -122.6784, throws, FAST);
      assert.deepEqual(result, { attempted: false, locality: null });
    });
  });

  describe("isInsideCanbyTransitDistrict — Oregon's own statewide UGB layer (DLCD)", () => {
    test("a point inside Canby's own UGB comes back inside", async () => {
      const result = await isInsideCanbyTransitDistrict(45.2607, -122.6903, json({ features: [{ attributes: { NAME: 'Canby' } }] }), FAST);
      assert.deepEqual(result, { attempted: true, inside: true });
    });

    test("a point inside a DIFFERENT city's UGB (not Canby's) comes back outside, not a false positive", async () => {
      const result = await isInsideCanbyTransitDistrict(45.5152, -122.6784, json({ features: [{ attributes: { NAME: 'Metro' } }] }), FAST);
      assert.deepEqual(result, { attempted: true, inside: false });
    });

    test('a point inside no UGB at all comes back outside', async () => {
      const result = await isInsideCanbyTransitDistrict(44.0582, -121.3153, json({ features: [] }), FAST);
      assert.deepEqual(result, { attempted: true, inside: false });
    });

    test('an unreachable service is attempted: false — distinct from "outside the district"', async () => {
      const result = await isInsideCanbyTransitDistrict(45.2607, -122.6903, throws, FAST);
      assert.deepEqual(result, { attempted: false, inside: false });
    });
  });
});

describe('PA PSD codes are keyed on municipality AND school district', () => {
  // Lancaster City is split across three school districts, so it has three
  // PSD codes -- 360399 (Conestoga Valley), 360999 (Lampeter-Strasburg) and
  // 361001 (Lancaster SD) -- all sharing the same 1.60% resident / 1.00%
  // nonresident rates. County + municipality alone cannot choose between
  // them, and before this the whole address resolved to NO PSD, so PA local
  // tax silently could not be computed from an address there.
  test('the census school-district name matches PA DCED\'s "S D" spelling', () => {
    const census = schoolDistrictKeyFromCensusName('Lancaster School District');
    assert.equal(census.base, schoolDistrictKeyFromDataFileName('LANCASTER S D').base);
    assert.ok(
      schoolDistrictKeysMatch(census, schoolDistrictKeyFromDataFileName('LANCASTER S D')),
      'Census "Lancaster School District" must match DCED "LANCASTER S D"',
    );
  });

  test('a different district in the same city does NOT match', () => {
    const census = schoolDistrictKeyFromCensusName('Lancaster School District');
    assert.equal(
      schoolDistrictKeysMatch(census, schoolDistrictKeyFromDataFileName('CONESTOGA VALLEY S D')),
      false,
      'the tie-break must not collapse two genuinely different districts',
    );
  });

  test('the "S D" strip only fires on a trailing pair, not mid-name', () => {
    // A district whose name merely CONTAINS an S or D token keeps it.
    assert.equal(schoolDistrictKeyFromDataFileName('SOUTH S D').base, 'SOUTH');
    assert.equal(schoolDistrictKeyFromDataFileName('BIG SPRING').base, 'BIG SPRING');
  });
});
