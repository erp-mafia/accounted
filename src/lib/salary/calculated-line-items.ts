/**
 * Provenance of engine-written payslip rows.
 *
 * run-calculation re-derives the semesterersättning row (vacation_rule =
 * 'semesterersattning') on every :calculate. Matching that row by item_type
 * alone also swept away semesterersättning lines an operator entered by hand
 * (a final settlement, a variable-pay top-up, a line carrying engångsskatt),
 * and those manual lines never reached the engine. The wage type cannot carry
 * provenance because operators legitimately enter the same type, so the
 * engine stamps its own rows with salary_line_items.calculation_source
 * (migration 20260919120000). NULL means manual.
 */

export const VACATION_COMPENSATION_SOURCE = 'vacation_compensation'

/** True for the semesterersättning row the engine itself derived. */
export function isAutomaticVacationLine(line: {
  item_type?: unknown
  calculation_source?: unknown
}): boolean {
  return line.item_type === 'semesterersattning' && line.calculation_source === VACATION_COMPENSATION_SOURCE
}
