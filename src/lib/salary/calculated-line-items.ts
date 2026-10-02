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
 *
 * The absence and shift-premium types below are the other case: the engine
 * owns the type itself, and a hand-entered line of it is refused (#3185).
 */
import type { SalaryLineItemType, ShiftPremiumItemType } from '@/types'

export const VACATION_COMPENSATION_SOURCE = 'vacation_compensation'

/** True for the semesterersättning row the engine itself derived. */
export function isAutomaticVacationLine(line: {
  item_type?: unknown
  calculation_source?: unknown
}): boolean {
  return line.item_type === 'semesterersattning' && line.calculation_source === VACATION_COMPENSATION_SOURCE
}

/** Item types the calculator derives from per-day absence records. */
export const DERIVED_ABSENCE_TYPES: SalaryLineItemType[] = [
  'sick_karens',
  'sick_day2_14',
  'sick_day15_plus',
  'vab',
  'parental_leave',
  'unpaid_leave',
]

/**
 * Item types the calculator derives from shift_premium_rules + worked days.
 * These are wiped at the start of each per-employee pass and regenerated so
 * the displayed line items always match the latest rules.
 */
export const DERIVED_PREMIUM_TYPES: ShiftPremiumItemType[] = [
  'overtime_50',
  'overtime_100',
  'ob_weekday_evening',
  'ob_weekend',
  'ob_night',
  'ob_holiday',
]

/**
 * Line types only the calculation writes. Unlike semesterersättning, whose
 * hand-entered line has no substitute and so gets provenance instead, a
 * hand-entered line of these types is refused: every calculation deletes the
 * type wholesale, and the same pay goes on 'overtime' or 'other', which carry
 * the same flags and account.
 */
export function isCalculatedLineType(itemType: unknown): boolean {
  return (
    DERIVED_ABSENCE_TYPES.includes(itemType as SalaryLineItemType) ||
    DERIVED_PREMIUM_TYPES.includes(itemType as ShiftPremiumItemType)
  )
}

/**
 * A line the calculation deletes and writes again on every run: a calculated
 * type, a förmån or recurring-line row, the engine's own semesterersättning
 * row, or the öresavrundning row. Editing or deleting one by hand is undone by
 * the next calculation, which every run needs before it can be booked; the
 * change belongs in the source (absence, worked hours and premium rules, the
 * förmån, the recurring line). run-calculation.ts reads its manual lines as
 * exactly the lines this rejects.
 */
export function isCalculatedLine(line: {
  item_type?: unknown
  calculation_source?: unknown
  source_benefit_id?: unknown
  source_recurring_line_id?: unknown
}): boolean {
  return (
    isCalculatedLineType(line.item_type) ||
    Boolean(line.source_benefit_id) ||
    Boolean(line.source_recurring_line_id) ||
    isAutomaticVacationLine(line) ||
    line.item_type === 'oresavrundning'
  )
}
