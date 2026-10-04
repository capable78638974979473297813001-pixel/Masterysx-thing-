/**
 * Shared input-validation helpers for optional caller-supplied fields that
 * flow in as loosely-typed data (a state's own `certificate: Record<string,
 * unknown>`, or a top-level field that TypeScript types but a JSON API
 * caller can still send anything for — this engine is served over HTTP by
 * supabase/functions/calculate-paycheck, where no compiler stands between
 * the wire and this code).
 */

/**
 * Read a field that must be a real boolean or absent — never a string,
 * number, or anything else that merely LOOKS like one. A caller-supplied
 * STRING "false" is truthy under a bare `if` check, which is exactly
 * backwards, and `Boolean("false")` doesn't help either (also true) — the
 * specific anti-pattern this function replaces everywhere it's used.
 * Absent/null defaults to false, the same "missing input changes nothing"
 * convention every optional field in this engine already follows.
 *
 * Originally two near-identical functions scoped to one field each
 * (certificate.exempt, certificate.nonresident) inside src/taxes/state.ts;
 * generalized here, in a file both state.ts and federal.ts can import
 * without a circular dependency (state.ts already imports federalIncomeTax
 * from federal.ts), once the same gap turned up in federal.ts's own
 * w4.exempt check — the highest-stakes instance of this bug class, since it
 * silently zeroes FEDERAL income tax on every paycheck it misreads, not
 * just one state's.
 */
export function resolveCertBoolean(cert: Record<string, unknown>, field: string): boolean {
  const raw = cert[field];
  if (raw === undefined || raw === null) return false;
  if (raw === true || raw === false) return raw;
  throw new Error(
    `Unrecognized certificate.${field} ${JSON.stringify(raw)} — expected a real boolean (true/false), not a ` +
      `string or other value that merely LOOKS like one.`,
  );
}
