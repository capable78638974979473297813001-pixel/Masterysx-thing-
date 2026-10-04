import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { jeddAtPoint } from '../geocode/districts.ts';
import { ohioJeddDecision, requiredFieldReasons } from '../geocode/index.ts';
import { resolveJurisdiction } from '../geocode/resolve.ts';
import { allOHJEDDs, ohJEDDBoundaryGaps } from '../src/registry.ts';

/**
 * The review signals that decide `fullyResolved`: overlapping or missing
 * JEDD boundaries, a JEDD lookup that failed, and a no_match on a local
 * registry that covers the whole state. All offline — the boundary
 * service is faked, the geographies are plain objects.
 */

const CHECK_DATE = '2026-08-15';
const FAST = { retries: 0, baseDelayMs: 0 };
const json = (body: unknown) => (async () => ({ ok: true, json: async () => body })) as unknown as typeof fetch;

describe('jeddAtPoint with overlapping polygons', () => {
  test('two active zones at one point: no zone is picked, both are reported', async () => {
    const r = await jeddAtPoint(41, -81, json({
      features: [
        { attributes: { name: 'ZONE A', jedd_id: 9004, active: 'Y' } },
        { attributes: { name: 'ZONE B', jedd_id: 9005, active: 'Y' } },
      ],
    }), FAST);
    assert.equal(r.attempted, true);
    assert.equal(r.ambiguous, true);
    assert.equal(r.jedd, null);
    assert.deepEqual(r.candidates!.map((c) => c.jeddId), ['9004', '9005']);
  });

  test('feature order does not decide the answer: an active zone beats an inactive one listed first', async () => {
    const r = await jeddAtPoint(41, -81, json({
      features: [
        { attributes: { name: 'OLD', jedd_id: 9999, active: 'N' } },
        { attributes: { name: 'LIVE', jedd_id: 9004, active: 'Y' } },
      ],
    }), FAST);
    assert.equal(r.ambiguous, false);
    assert.equal(r.jedd?.jeddId, '9004');
  });

  test('the same zone returned twice is one zone, not an overlap', async () => {
    const f = { attributes: { name: 'ZONE A', jedd_id: 9004, active: 'Y' } };
    const r = await jeddAtPoint(41, -81, json({ features: [f, f] }), FAST);
    assert.equal(r.ambiguous, false);
    assert.equal(r.jedd?.jeddId, '9004');
  });
});

describe('ohioJeddDecision', () => {
  const known = allOHJEDDs(CHECK_DATE).find((z) => !ohJEDDBoundaryGaps(CHECK_DATE).some((g) => g.jeddId === z.jeddId))!;
  const base = { checkDate: CHECK_DATE, counties: ['Franklin County'], places: ['Columbus city'], municipalityMatched: true };

  test('a zone with a rate on file sets workJEDDId and raises nothing', () => {
    const d = ohioJeddDecision({ ...base, found: { attempted: true, jedd: { name: known.name, jeddId: known.jeddId, active: true } } });
    assert.equal(d.workJEDDId, known.jeddId);
    assert.deepEqual(d.reasons, []);
  });

  test('a failed lookup is a review reason, never a silent "no JEDD"', () => {
    const d = ohioJeddDecision({ ...base, found: { attempted: false, jedd: null } });
    assert.equal(d.workJEDDId, null);
    assert.match(d.reasons[0], /could not be reached/);
  });

  test('overlapping zones are a review reason and set no zone', () => {
    const d = ohioJeddDecision({
      ...base,
      found: { attempted: true, jedd: null, ambiguous: true, candidates: [
        { name: 'ZONE A', jeddId: '9004', active: true }, { name: 'ZONE B', jeddId: '9005', active: true },
      ] },
    });
    assert.equal(d.workJEDDId, null);
    assert.match(d.reasons[0], /more than one active/);
  });

  test('a polygon whose id has no rate row is flagged instead of computing no tax', () => {
    const d = ohioJeddDecision({ ...base, found: { attempted: true, jedd: { name: 'NEW ZONE', jeddId: '0000001', active: true } } });
    assert.equal(d.workJEDDId, null);
    assert.match(d.reasons[0], /no rate on file/);
  });

  test('every live polygon from the 2026-09-28 diff now resolves to a rate row', () => {
    for (const id of ['9022', '9069', '9098', '9123', '9142', '9143', '9155']) {
      const d = ohioJeddDecision({ ...base, found: { attempted: true, jedd: { name: `ZONE ${id}`, jeddId: id, active: true } } });
      assert.equal(d.workJEDDId, id, id);
      assert.deepEqual(d.reasons, [], id);
    }
  });

  test('no polygon, but inside a hinted county/place of a boundary-gap zone: flagged for review', () => {
    const gaps = ohJEDDBoundaryGaps(CHECK_DATE);
    assert.equal(gaps.length, 15);
    const d = ohioJeddDecision({
      ...base, counties: ['Cuyahoga County'], places: ['Cleveland city'],
      found: { attempted: true, jedd: null, candidates: [], ambiguous: false },
    });
    assert.equal(d.workJEDDId, null);
    assert.match(d.reasons[0], /Shaker Square \(9074\)/);
    assert.match(d.reasons[0], /Gateway \(9072\)/);
  });

  test('unincorporated land in a hinted county is flagged; an unrelated city is not', () => {
    const township = ohioJeddDecision({
      ...base, counties: ['Stark County'], places: [], municipalityMatched: false,
      found: { attempted: true, jedd: null, candidates: [], ambiguous: false },
    });
    assert.match(township.reasons[0], /Perry Township-Navarre/);
    const elsewhere = ohioJeddDecision({ ...base, found: { attempted: true, jedd: null, candidates: [], ambiguous: false } });
    assert.deepEqual(elsewhere.reasons, []);
  });
});

describe('requiredFieldReasons — no_match only counts where the registry covers the whole state', () => {
  test('a Pennsylvania address with no PSD match is not fully resolved', () => {
    const resolved = resolveJurisdiction({ state: 'PA', incorporatedPlaces: [], countySubdivisions: ['Nowhere township'], counties: ['Imaginary County'] }, CHECK_DATE);
    assert.equal(resolved.paJurisdiction?.confidence, 'no_match');
    assert.match(requiredFieldReasons(resolved)[0], /Pennsylvania local jurisdiction/);
  });

  test('a matched Pennsylvania address raises nothing', () => {
    const resolved = resolveJurisdiction({ state: 'PA', incorporatedPlaces: [], countySubdivisions: ['Abington township'], counties: ['Montgomery County'] }, CHECK_DATE);
    assert.deepEqual(requiredFieldReasons(resolved), []);
  });

  test('Indiana and Maryland counties are required too', () => {
    const inRes = resolveJurisdiction({ state: 'IN', incorporatedPlaces: [], countySubdivisions: [], counties: ['Atlantis County'] }, CHECK_DATE);
    assert.equal(requiredFieldReasons(inRes).length, 1);
    const mdRes = resolveJurisdiction({ state: 'MD', incorporatedPlaces: [], countySubdivisions: [], counties: ['Atlantis County'] }, CHECK_DATE);
    assert.equal(requiredFieldReasons(mdRes).length, 1);
  });

  test('a Michigan city outside the taxing list is a correct no_match, not a failure', () => {
    const resolved = resolveJurisdiction({ state: 'MI', incorporatedPlaces: ['Ann Arbor city'], countySubdivisions: [], counties: ['Washtenaw County'] }, CHECK_DATE);
    assert.equal(resolved.miCity?.confidence, 'no_match');
    assert.deepEqual(requiredFieldReasons(resolved), []);
  });
});
