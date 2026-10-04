import { calculatePaycheck } from '../calculate.ts';
import { buildAlabamaEngineInput } from './input.ts';
import { buildAlabamaOutput } from './output.ts';
import type { AlabamaPaycheckInput, AlabamaPaycheckOutput } from './types.ts';

/**
 * Calculate one Alabama paycheck, gross to net.
 *
 * Three steps and nothing hidden between them: validate and translate the
 * Alabama-shaped input into the engine's own PaycheckInput, run the same
 * calculatePaycheck() every other state runs, then present the result the
 * way an Alabama payroll would read it. No tax is computed here — the
 * arithmetic lives in src/taxes/, the rates live in data/, and this module
 * is the door between them and a person with an Alabama payroll to run.
 *
 * Throws AlabamaInputError on an input that cannot be calculated correctly
 * (a bad A-4 code, a negative amount, a year with no ruleset). Returns
 * `warnings` for the cases that CAN be calculated but deserve a second
 * look — a standalone bonus cheque, an unrecognised work city, a
 * nonresident with no day count.
 */
export function calculateAlabamaPaycheck(input: AlabamaPaycheckInput): AlabamaPaycheckOutput {
  const built = buildAlabamaEngineInput(input);
  const result = calculatePaycheck(built.engineInput);
  return buildAlabamaOutput(input, built, result);
}

export { AlabamaInputError, buildAlabamaEngineInput } from './input.ts';
export { buildAlabamaOutput, formatAlabamaPaystub } from './output.ts';
export { ALABAMA_SCENARIOS, alabamaScenario } from './scenarios.ts';
export type { AlabamaScenario } from './scenarios.ts';
export type * from './types.ts';
