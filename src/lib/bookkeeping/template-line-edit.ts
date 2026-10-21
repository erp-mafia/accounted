import { formatAmountInput, parseAmountInput, roundOre } from '@/lib/money'

/**
 * Editing the lines a mall produced before they are booked (crm#1351).
 *
 * A mall is a starting point for a verifikat, not a lock: it turns one total
 * into lines by fixed shares (applyTemplate), and a share that varies from
 * one booking to the next (a payment provider's fee taken off a payout) is
 * right only by chance. "Bokför från mall" showed those lines as text, so
 * the person could change the total and nothing else. These helpers are the
 * decisions behind the editable lines there: which lines are shown, what one
 * typed figure changes, the amount that balances a line, and whether the
 * lines can be booked. The mall itself is never written: edits live only in
 * the dialog until it posts.
 */

/** One line as the kontering editor holds it: the amounts stay the typed strings. */
export interface TemplateEditLine {
  account_number: string
  debit_amount: string
  credit_amount: string
  line_description?: string
}

export type TemplateLineAmountField = 'debit_amount' | 'credit_amount'

/**
 * What a set of lines was computed from: the mall and the total. Edits belong
 * to one seed; another mall or another total computes the lines from the
 * mall again, so a figure typed for yesterday's total never rides along on a
 * new one.
 */
export function templateLinesSeed(templateId: string, total: number): string {
  return `${templateId}:${roundOre(total)}`
}

/** The person's edits, and the seed they were made on. */
export interface TemplateLinesEdits<L extends TemplateEditLine> {
  seed: string
  lines: L[]
}

/** The lines to show and book: the edits while they belong to this seed, else the mall's own. */
export function shownTemplateLines<L extends TemplateEditLine>(
  computed: L[],
  edits: TemplateLinesEdits<L> | null,
  seed: string,
): L[] {
  return edits && edits.seed === seed ? edits.lines : computed
}

/**
 * One figure typed on a line. A line carries one side: a figure on one side
 * clears the other, as in the verifikat form.
 */
export function withLineAmount<L extends TemplateEditLine>(
  lines: readonly L[],
  index: number,
  field: TemplateLineAmountField,
  value: string,
): L[] {
  return lines.map((line, i) => {
    if (i !== index) return line
    const other: TemplateLineAmountField = field === 'debit_amount' ? 'credit_amount' : 'debit_amount'
    return { ...line, [field]: value, ...(value ? { [other]: '' } : {}) }
  })
}

/**
 * Another account on a line; its text follows the account, the mall's label
 * belonged to the old one. The same account again keeps the line as it is.
 */
export function withLineAccount<L extends TemplateEditLine>(
  lines: readonly L[],
  index: number,
  accountNumber: string,
  lineDescription: string,
): L[] {
  return lines.map((line, i) =>
    i === index && line.account_number !== accountNumber
      ? { ...line, account_number: accountNumber, line_description: lineDescription }
      : line,
  )
}

/** A figure on a line, or 0 when the field is empty; null when it is not a usable amount. */
function lineFigure(text: string): number | null {
  if (!text.trim()) return 0
  const n = parseAmountInput(text)
  return n === null || n < 0 ? null : n
}

/**
 * The amount on this line's side that makes the verifikat balance, from
 * every other line: what a double-click on the field fills in. Null when the
 * others already balance or the gap belongs on the other side.
 */
export function balancingAmount(
  lines: readonly TemplateEditLine[],
  index: number,
  field: TemplateLineAmountField,
): number | null {
  let debit = 0
  let credit = 0
  lines.forEach((line, i) => {
    if (i === index) return
    debit = roundOre(debit + (lineFigure(line.debit_amount) ?? 0))
    credit = roundOre(credit + (lineFigure(line.credit_amount) ?? 0))
  })
  const fill = roundOre(field === 'debit_amount' ? credit - debit : debit - credit)
  return fill > 0 ? fill : null
}

/** The balancing amount as the field's text, or null as balancingAmount answers. */
export function balancingAmountInput(
  lines: readonly TemplateEditLine[],
  index: number,
  field: TemplateLineAmountField,
): string | null {
  const fill = balancingAmount(lines, index, field)
  return fill === null ? null : formatAmountInput(fill, '.')
}

/** A line as it is posted: öre amounts, one side above zero. */
export interface TemplatePostLine {
  account_number: string
  debit_amount: number
  credit_amount: number
  line_description?: string
}

export interface TemplateLinesCheck {
  totalDebit: number
  totalCredit: number
  /** Debit minus credit, to the öre: 0 when the lines balance. */
  difference: number
  /**
   * Lines the person has to finish first: an amount without an account, an
   * amount that is not a figure (or below zero), or a figure on both sides.
   */
  incomplete: number
  /**
   * The lines that are booked: an account and an amount. A line with an
   * account and no amount, such as a mall's share-0 line left at 0 (a fee
   * that was not taken this time), and an empty added row are left out
   * rather than posted as a 0/0 row.
   */
  postLines: TemplatePostLine[]
  /** Balanced (debit equals credit, above zero, Hard Rule 3), two lines or more, none incomplete. */
  bookable: boolean
}

/** Balance and bookability of the lines, in öre-safe steps. */
export function checkTemplateLines(lines: readonly TemplateEditLine[]): TemplateLinesCheck {
  let totalDebit = 0
  let totalCredit = 0
  let incomplete = 0
  const postLines: TemplatePostLine[] = []

  for (const line of lines) {
    const debit = lineFigure(line.debit_amount)
    const credit = lineFigure(line.credit_amount)
    const account = line.account_number.trim()
    if (debit === null || credit === null || (debit > 0 && credit > 0)) {
      incomplete++
      continue
    }
    if (debit === 0 && credit === 0) continue
    if (!account) {
      incomplete++
      continue
    }
    totalDebit = roundOre(totalDebit + debit)
    totalCredit = roundOre(totalCredit + credit)
    postLines.push({
      account_number: account,
      debit_amount: debit,
      credit_amount: credit,
      ...(line.line_description ? { line_description: line.line_description } : {}),
    })
  }

  const difference = roundOre(totalDebit - totalCredit)
  return {
    totalDebit,
    totalCredit,
    difference,
    incomplete,
    postLines,
    bookable: difference === 0 && totalDebit > 0 && postLines.length >= 2 && incomplete === 0,
  }
}
