/**
 * Text rows on the payslip (item_type 'text', "Textrad").
 *
 * A text row carries words and nothing else: amount 0, no quantity, no
 * à-pris, no account, every flag false. It explains the payslip (how the
 * salary is built up, a collective agreement's itemisation) without touching
 * the pay: the engine, the booking, the AGI and the year-to-date totals never
 * see it. It is stored per run in salary_line_items like every other row, so
 * an issued payslip keeps the text it was issued with (BFL 7 kap. 1 §); a
 * standing text comes from a recurring line and is copied into each run.
 *
 * This module is the one rule set for every door (dashboard, v1, MCP, the
 * recurring-line derivation): validatePayslipLineContent below is what the
 * line commands run, and validateTextRow mirrors the salary_line_items_text_row
 * CHECK so a bad row is a 400 with a Swedish reason, not a 23514.
 *
 * The same validator closes the 0 kr loophole (crm#1076): a money row needs a
 * non-zero amount from every door, not only from the dialog, because a 0 kr
 * row printed "0,00" on the payslip. Vacation-day rows are the exception:
 * they carry days in quantity and may have no amount.
 */

export const TEXT_ROW_ITEM_TYPE = 'text'

/** Longest text a row may carry after normalisation. */
export const TEXT_ROW_MAX_LENGTH = 200

/**
 * Stored sort_order of a recurring text row (plus its index): after the base
 * salary row (0), before the engine's semesterersättning (50) and the derived
 * bands (100+). The display order itself comes from comparePayslipLines.
 */
export const RECURRING_TEXT_SORT_ORDER = 10

/** Display bands, in payslip order. */
export const PAYSLIP_LINE_BAND = {
  baseSalary: 0,
  recurringText: 1,
  manualText: 2,
  other: 3,
} as const

/** Every flag a text row carries: none. */
export const TEXT_ROW_FLAGS = {
  is_taxable: false,
  is_avgift_basis: false,
  is_vacation_basis: false,
  is_gross_deduction: false,
  is_net_deduction: false,
} as const

export const TEXT_ROW_AMOUNT_MESSAGE =
  'En textrad har inget belopp. Lägg beloppet på en egen rad.'
export const TEXT_ROW_QUANTITY_MESSAGE =
  'En textrad har inget antal eller á-pris.'
export const TEXT_ROW_BLANK_MESSAGE = 'En textrad måste ha en text.'
export const TEXT_ROW_TOO_LONG_MESSAGE = `En textrad får vara högst ${TEXT_ROW_MAX_LENGTH} tecken.`
export const TEXT_ROW_RETYPE_MESSAGE =
  'En rad kan inte göras om till eller från en textrad. Ta bort raden och lägg till en ny.'
export const ZERO_AMOUNT_MESSAGE =
  'Raden behöver ett belopp som inte är 0 kr. Välj Textrad för en rad med bara text.'

export function isTextRow(line: { item_type?: unknown }): boolean {
  return line.item_type === TEXT_ROW_ITEM_TYPE
}

/**
 * The text as it is stored and printed: trimmed, every line break (with the
 * spaces around it) collapsed to one space. The payslip prints a text row on
 * one line across the table, so a pasted paragraph keeps its words.
 */
export function normalizeTextRow(text: string): string {
  return text.replace(/\s*[\r\n]+\s*/g, ' ').trim()
}

export interface TextRowShape {
  description?: string | null
  amount?: number | null
  quantity?: number | null
  unit_price?: number | null
}

export interface LineContentIssue {
  field: 'description' | 'amount' | 'quantity' | 'unit_price' | 'item_type'
  message: string
}

/**
 * Null when the text row is acceptable. Mirrors the salary_line_items text-row
 * CHECK for what a caller can set: words present, no amount, no quantity, no
 * à-pris. Flags and account are not checked here because the commands force
 * them (a text row has none to choose).
 */
export function validateTextRow(line: TextRowShape): LineContentIssue | null {
  const text = normalizeTextRow(line.description ?? '')
  if (text === '') return { field: 'description', message: TEXT_ROW_BLANK_MESSAGE }
  if (text.length > TEXT_ROW_MAX_LENGTH) return { field: 'description', message: TEXT_ROW_TOO_LONG_MESSAGE }
  if (line.amount !== null && line.amount !== undefined && line.amount !== 0) {
    return { field: 'amount', message: TEXT_ROW_AMOUNT_MESSAGE }
  }
  if (line.quantity !== null && line.quantity !== undefined) {
    return { field: 'quantity', message: TEXT_ROW_QUANTITY_MESSAGE }
  }
  if (line.unit_price !== null && line.unit_price !== undefined) {
    return { field: 'unit_price', message: TEXT_ROW_QUANTITY_MESSAGE }
  }
  return null
}

/**
 * The one content rule for a payslip row, run by the line commands for every
 * door: a text row carries words and no amount; any other row needs a
 * non-zero amount, except a vacation row that carries days.
 */
export function validatePayslipLineContent(
  line: TextRowShape & { item_type: string },
): LineContentIssue | null {
  if (isTextRow(line)) return validateTextRow(line)
  if (line.amount === null || line.amount === undefined || !Number.isFinite(line.amount)) {
    return { field: 'amount', message: ZERO_AMOUNT_MESSAGE }
  }
  if (line.amount !== 0) return null
  if (line.item_type === 'vacation' && (line.quantity ?? 0) > 0) return null
  return { field: 'amount', message: ZERO_AMOUNT_MESSAGE }
}

export interface OrderedPayslipLine {
  item_type?: unknown
  sort_order?: unknown
  source_recurring_line_id?: unknown
}

/** Which display band a row belongs to (PAYSLIP_LINE_BAND). */
export function payslipLineBand(line: OrderedPayslipLine): number {
  if (line.item_type === 'monthly_salary' || line.item_type === 'hourly_salary') {
    return PAYSLIP_LINE_BAND.baseSalary
  }
  if (isTextRow(line)) {
    return line.source_recurring_line_id ? PAYSLIP_LINE_BAND.recurringText : PAYSLIP_LINE_BAND.manualText
  }
  return PAYSLIP_LINE_BAND.other
}

/**
 * The payslip order, shared by the PDF and the run-employee page: the base
 * salary row first, the recurring text rows directly under it, manual text
 * rows next, then every other row by sort_order. Array.prototype.sort is
 * stable, so rows that tie keep the order they were read in.
 */
export function comparePayslipLines(a: OrderedPayslipLine, b: OrderedPayslipLine): number {
  const band = payslipLineBand(a) - payslipLineBand(b)
  if (band !== 0) return band
  return (Number(a.sort_order) || 0) - (Number(b.sort_order) || 0)
}
