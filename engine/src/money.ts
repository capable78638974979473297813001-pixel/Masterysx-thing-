/**
 * All money in this engine is integer cents. Never floats.
 *
 * Payroll is one of the few domains where a half-cent error is a compliance
 * problem, not a rounding nit: withheld amounts must tie out to the penny
 * against quarterly 941 filings. Floating point `0.1 + 0.2` bugs surface as
 * unbalanced tax deposits months later, so we keep an integer representation
 * everywhere and round only at explicit, named boundaries.
 */

export type Cents = number;

/** Parse a dollar figure from a data file into cents. */
export function dollars(amount: number): Cents {
  return Math.round(amount * 100);
}

/** Format cents for display / logging. */
export function fmt(cents: Cents): string {
  const neg = cents < 0;
  const abs = Math.abs(cents);
  const s = `${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
  return neg ? `-$${s}` : `$${s}`;
}

/**
 * BUG FIX (found auditing this engine for a different class of bug — see
 * taxes/state.ts's own resolveCertBoolean() history): a malformed numeric
 * certificate field (a typo, a wrong type from a JSON API caller, an
 * upstream bug) commonly reaches here as `Number(cert.someField ?? 0)`,
 * which produces NaN rather than throwing for anything non-numeric —
 * `Number("abc")` is NaN, not an error. NaN then propagated through this
 * engine's two universal arithmetic chokepoints in two different, both
 * dangerous ways: roundHalfUp() let it flow straight through (`raw >= 0` is
 * false for NaN, so the false branch ran and returned NaN, eventually
 * surfacing as `null` once a TaxLine.amount serializes to JSON — a
 * confusing failure, but at least a visible one) — while atLeastZero() was
 * FAR worse: `cents > 0` is ALSO false for NaN, so it silently returned 0,
 * meaning a single malformed field (say, certificate.exemptions: "two"
 * instead of 2) could make a whole state's income tax line report a
 * confident-looking $0 with no error at all. Verified live: a Wisconsin
 * calculation with certificate.exemptions set to a non-numeric string
 * produced a $0 WI_SIT line with a detail string reading "less $NaN.NaN
 * exemptions (NaN x $400)" — visible on close inspection, but the actual
 * `amount` field gave no indication anything was wrong. Guarding these two
 * functions closes the gap at its single highest-leverage point: every
 * numeric certificate field in this engine eventually flows through one or
 * both on its way to becoming a TaxLine, so this is enforced once here
 * rather than needing a parallel fix at every individual `Number(cert.x ??
 * 0)` call site (there are dozens).
 */
function assertFiniteMoney(value: number, fnName: string): void {
  if (!Number.isFinite(value)) {
    // Deliberately String(value), not JSON.stringify(value) — JSON has no
    // way to represent NaN or Infinity and silently renders both as the
    // string "null", which would make this very error message claim the
    // value was null when it was actually NaN, the far more likely case.
    throw new Error(
      `${fnName}(${String(value)}) — expected a finite number of cents, got ${String(value)}. ` +
        `This almost always means a caller-supplied certificate field that should be numeric ` +
        `(allowances, exemptions, dependents, etc.) arrived as something Number() cannot parse — ` +
        `check the input, not this engine's arithmetic.`,
    );
  }
}

/**
 * Round a raw cents figure half away from zero.
 *
 * Half-up is what the IRS and every state agency assume in their worked
 * examples; banker's rounding would drift against published answers. This is
 * THE rounding boundary — see docs/rounding-and-precision.md rule 3.
 */
export function roundHalfUp(raw: number): Cents {
  assertFiniteMoney(raw, 'roundHalfUp');
  return raw >= 0 ? Math.round(raw) : -Math.round(-raw);
}

/** Apply a single rate to a base, rounding once at emission. */
export function applyRate(base: Cents, rate: number): Cents {
  return roundHalfUp(base * rate);
}

/** Clamp to non-negative. Withholding is never negative. */
export function atLeastZero(cents: Cents): Cents {
  assertFiniteMoney(cents, 'atLeastZero');
  return cents > 0 ? cents : 0;
}

/**
 * Remaining room under a wage base cap, given year-to-date wages already
 * counted toward it. Returns the portion of `current` that is still taxable.
 */
export function underCap(current: Cents, ytd: Cents, cap: Cents | null): Cents {
  if (cap === null) return current;
  const room = atLeastZero(cap - ytd);
  return Math.min(current, room);
}

/**
 * Portion of `current` that falls ABOVE a threshold, given YTD wages.
 * Mirror image of `underCap` — used for Additional Medicare.
 */
export function overThreshold(current: Cents, ytd: Cents, threshold: Cents): Cents {
  const totalAfter = ytd + current;
  if (totalAfter <= threshold) return 0;
  const excess = totalAfter - threshold;
  return Math.min(current, excess);
}

/** Round to whole dollars (IRS permits this for withheld income tax). */
export function toWholeDollars(cents: Cents): Cents {
  assertFiniteMoney(cents, 'toWholeDollars');
  return Math.round(cents / 100) * 100;
}

/**
 * Round DOWN (floor) to the nearest whole cent — the opposite direction
 * from roundHalfUp. Pennsylvania's Local Services Tax is the first tax in
 * this project whose own governing rule (Act 32) explicitly requires this:
 * "prorated across pay periods, rounded DOWN to the nearest $0.01." Kept as
 * a distinct, named function rather than an inline Math.floor so the
 * direction is unmistakable at every call site — the same discipline this
 * file already applies to roundHalfUp vs. toWholeDollars.
 */
export function roundDownToCent(raw: number): Cents {
  assertFiniteMoney(raw, 'roundDownToCent');
  return Math.floor(raw);
}
