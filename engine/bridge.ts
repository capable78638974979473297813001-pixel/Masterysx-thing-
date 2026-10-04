/**
 * MasteryTax <-> tax engine bridge.
 *
 * Reads a JSON batch of paychecks on stdin, runs each through
 * calculatePaycheck() in check-date order per employee while keeping the
 * year-to-date ledger the engine needs between checks (wage bases,
 * thresholds, deferral limits), and writes the tax lines back as JSON.
 *
 *   stdin:  { "paychecks": [ { "key", "companyId", "employeeId", "seq", "input": PaycheckInput-without-ytd } ] }
 *   stdout: { "results":   [ { "key", "taxes", "notices", "warnings", "netPay" } | { "key", "error", "errorType" } ] }
 *
 * The bridge never moves money and never calls the network.
 */
import { readFileSync } from 'node:fs';
import { calculatePaycheck } from './src/calculate.ts';
import type { PaycheckInput } from './src/types.ts';
import { accumulateYtd, freshYearToDate } from './payroll/ytd.ts';
import type { ExtendedYearToDate } from './payroll/types.ts';

interface Paycheck {
  key: string;
  companyId: string;
  employeeId: string;
  seq: number;
  input: Omit<PaycheckInput, 'ytd'>;
}

const DEFERRAL_BUCKET: Record<string, 'section402gAggregate' | 'deferral457' | 'simple'> = {
  deferral_401k: 'section402gAggregate',
  deferral_403b: 'section402gAggregate',
  deferral_457: 'deferral457',
  deferral_simple: 'simple',
};

const batch = JSON.parse(readFileSync(0, 'utf8')) as { paychecks: Paycheck[] };
const ordered = [...batch.paychecks].sort(
  (a, b) =>
    a.companyId.localeCompare(b.companyId) ||
    a.employeeId.localeCompare(b.employeeId) ||
    a.input.checkDate.localeCompare(b.input.checkDate) ||
    a.seq - b.seq,
);

const ledgers = new Map<string, ExtendedYearToDate>();
const results: unknown[] = [];

for (const pc of ordered) {
  const ledgerKey = `${pc.companyId}\u0000${pc.employeeId}\u0000${pc.input.checkDate.slice(0, 4)}`;
  const ytd = ledgers.get(ledgerKey) ?? freshYearToDate();
  try {
    const result = calculatePaycheck({ ...pc.input, ytd } as PaycheckInput);
    const next = accumulateYtd(ytd, {
      checkDate: pc.input.checkDate,
      employmentCategory: pc.input.employmentCategory,
      grossPay: result.grossPay,
      taxLines: result.taxes,
    });
    const deferrals = { ...(ytd.electiveDeferrals ?? {}) };
    for (const d of pc.input.deductions) {
      const bucket = d.category ? DEFERRAL_BUCKET[d.category] : undefined;
      if (bucket) deferrals[bucket] = (deferrals[bucket] ?? 0) + d.amount;
    }
    next.electiveDeferrals = deferrals;
    ledgers.set(ledgerKey, next);
    results.push({
      key: pc.key,
      taxes: result.taxes,
      notices: result.notices ?? [],
      warnings: result.warnings ?? [],
      netPay: result.netPay,
    });
  } catch (err) {
    const e = err as Error;
    results.push({ key: pc.key, error: e.message, errorType: e.constructor?.name ?? 'Error' });
  }
}

process.stdout.write(JSON.stringify({ results }));
