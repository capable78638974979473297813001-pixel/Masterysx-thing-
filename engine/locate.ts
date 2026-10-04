/**
 * MasteryTax tax locator: work + residence address -> the state/local
 * certificate fields the engine needs (PSD codes, Ohio city and school
 * district, NYC/Yonkers residency, JEDDs, transit districts ...), via the
 * vendored geocode/ module (Census geocoder + TIGERweb + agency boundary
 * services). Needs network access to those public services.
 *
 *   stdin:  { "employees": [ { "key", "work"?, "residence"?, "checkDate" } ] }
 *   stdout: { "results": [ { "key", "certificateFields", "fullyResolved", "notResolvable",
 *                            "lowConfidenceReasons", "lookupFailures" } | { "key", "error" } ] }
 */
import { readFileSync } from 'node:fs';
import { resolveEmployee } from './geocode/index.ts';

interface Request {
  key: string;
  work?: string;
  residence?: string;
  checkDate: string;
}

const { employees } = JSON.parse(readFileSync(0, 'utf8')) as { employees: Request[] };
const results: unknown[] = [];
for (const e of employees) {
  try {
    const r = await resolveEmployee({ work: e.work, residence: e.residence }, e.checkDate);
    results.push({
      key: e.key,
      certificateFields: r.certificateFields,
      fullyResolved: r.fullyResolved,
      notResolvable: r.notResolvable,
      lowConfidenceReasons: r.lowConfidenceReasons,
      lookupFailures: r.lookupFailures,
    });
  } catch (err) {
    results.push({ key: e.key, error: (err as Error).message });
  }
}
process.stdout.write(JSON.stringify({ results }));
