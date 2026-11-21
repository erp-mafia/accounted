/**
 * Begränsat momsavdrag on a supplier invoice row (crm#1617).
 *
 * Some purchases carry full Swedish moms on the invoice but give only part of
 * it as ingående moms (ML 2023:200 13 kap.): half the moms on leasing or
 * hiring a personbil, the moms on at most 300 kr per person on
 * representation. The part that cannot be deducted is a cost, so it belongs
 * on the row's cost account, not on 2641, and the payable stays the invoice
 * total.
 *
 * The editor keeps the row as the invoice states it (net amount, moms sats)
 * plus the share of its moms the person deducts (`vat_deduction_share`, a
 * share so that a corrected amount or moms sats keeps the deduction in
 * proportion; the editor shows and takes it in kronor). The registration takes
 * the shape every create path already books (CreateSupplierInvoiceItemSchema
 * `vat_amount`, rowInputVat): the row's amount grows by the non-deductible
 * moms and its vat_amount is the deductible part. A row whose moms is not
 * deductible at all goes at 0 % with the moms in its amount, because a stored
 * vat_amount of 0 reads as "nothing stored" and would be recomputed from the
 * rate. Pure, so the editor, its review dialog and the payload agree, and the
 * MCP inbox door (deductStagedLines) books a row the way the editor does.
 */

import { BOOKING_TEMPLATES } from '@/lib/bookkeeping/booking-templates'
import { netVat } from '@/lib/bookkeeping/gross-split'
import { roundOre } from '@/lib/money'

export interface LimitedDeductionRow {
  amount: number
  vat_rate: number
  /** The moms the row books: set only by bookLimitedDeduction, the deductible part. */
  vat_amount?: number
  /**
   * The row's moms as the invoice states it, when the door has the figure
   * (the MCP inbox door: the row's part of the document's moms). The editor's
   * rows carry none: their moms is amount × moms sats.
   */
  invoiced_vat?: number
  /** The share (0 to 1) of the row's moms the person deducts; undefined means all of it. */
  vat_deduction_share?: number
}

export interface BookedLimitedDeduction<T> {
  /** The rows as the registration books them, without vat_deduction_share. */
  items: T[]
  /** Per row, the moms booked as cost instead of ingående moms. */
  nonDeductibleVat: number[]
}

/** The row's moms as the invoice states it: its invoiced_vat, else amount × moms sats. */
export function invoicedRowVat(row: Pick<LimitedDeductionRow, 'amount' | 'vat_rate' | 'invoiced_vat'>): number {
  if (typeof row.invoiced_vat === 'number' && Number.isFinite(row.invoiced_vat)) return roundOre(row.invoiced_vat)
  return netVat(roundOre(row.amount || 0), row.vat_rate || 0)
}

/** The moms deducted on a row at a share of its moms, in whole öre. */
export function deductibleRowVat(row: Pick<LimitedDeductionRow, 'amount' | 'vat_rate' | 'invoiced_vat'>, share: number): number {
  const full = invoicedRowVat(row)
  return Math.min(Math.max(roundOre(full * share), 0), full)
}

/**
 * The accounts personbil leasing and hire are booked on, read from the
 * booking templates: the vehicle templates whose moms is conditionally
 * deductible (Billeasing on 5615, Hyrbil on 5820: "max 50 % momsavdrag för
 * personbil"). Half the moms is the rule on these rows, so the editor shows
 * their deduction control at rest.
 */
export const PERSONBIL_LEASE_HIRE_ACCOUNTS: ReadonlySet<string> = new Set(
  BOOKING_TEMPLATES
    .filter((template) => template.group === 'vehicle' && template.deductibility === 'conditional')
    .flatMap((template) => [template.debit_account, template.debit_account_ab ?? template.debit_account]),
)

export function isPersonbilLeaseOrHireAccount(account: string | null | undefined): boolean {
  return account != null && PERSONBIL_LEASE_HIRE_ACCOUNTS.has(account)
}

/**
 * Whether an invoice's rows can carry a limited deduction: not under reverse
 * charge (self-assessed moms is not the supplier's moms) and not on a
 * self-billing invoice, which we issue in the supplier's name and which must
 * state the supply's own net and moms.
 */
export function limitedDeductionApplies(invoice: { reverse_charge: boolean; is_self_billed?: boolean }): boolean {
  return !invoice.reverse_charge && invoice.is_self_billed !== true
}

/**
 * The rows the registration books. A deduction only applies to a row with
 * moms on a positive amount, on an invoice where limitedDeductionApplies; it
 * is held between 0 and the row's moms.
 */
export function bookLimitedDeduction<T extends LimitedDeductionRow>(
  items: readonly T[],
  applies: boolean,
): BookedLimitedDeduction<T> {
  const nonDeductibleVat: number[] = []
  const booked = items.map((item) => {
    const { vat_deduction_share: share, ...row } = item
    const full = invoicedRowVat(item)
    if (!applies || share == null || full <= 0) {
      nonDeductibleVat.push(0)
      return row as T
    }
    const deductible = deductibleRowVat(item, share)
    const nonDeductible = roundOre(full - deductible)
    nonDeductibleVat.push(nonDeductible)
    if (nonDeductible === 0) return row as T
    const amount = roundOre(roundOre(item.amount) + nonDeductible)
    if (deductible === 0) return { ...row, amount, vat_rate: 0, vat_amount: undefined } as T
    return { ...row, amount, vat_amount: deductible } as T
  })
  return { items: booked, nonDeductibleVat }
}

export interface StatedVatDeduction {
  /** The moms the change books as cost: what the rows deduct now less the stated moms. */
  nonDeductibleVat: number
  /** The rows the change touches: the share each then deducts and that moms in kronor. */
  rows: Array<{ index: number; share: number; deductibleVat: number }>
}

/**
 * Begränsat momsavdrag from the invoice's Moms field (crm#1954): a person who
 * types the moms they deduct, lower than the moms the rows carry, gets the
 * rest booked as cost, so the ingående moms booked is the moms they typed.
 *
 * The whole difference goes on one row where it fits: a personbil leasing or
 * hire row first (isPersonbilLeaseOrHireAccount), else the row with the most
 * moms still deducted. A difference larger than that row's moms takes the
 * next row in the same order. A row's existing deduction counts: only what
 * the rows still deduct beyond the stated moms is moved. Shares come from the
 * row's own moms (invoicedRowVat) so deductibleRowVat gives each figure back
 * to the öre.
 *
 * Null when there is nothing to book: no limited deduction applies, or the
 * stated moms is negative or not below what the rows deduct. A stated moms
 * of 0 or more never asks for more than the rows deduct, so no row goes
 * below 0.
 */
export function deductionForStatedVat<T extends LimitedDeductionRow & { account_number?: string }>(
  items: readonly T[],
  statedVat: number,
  applies: boolean,
): StatedVatDeduction | null {
  if (!applies || !Number.isFinite(statedVat) || statedVat < 0) return null
  const toOre = (kronor: number) => Math.round(roundOre(kronor) * 100)
  const rows = items.map((item, index) => {
    const fullOre = toOre(invoicedRowVat(item))
    // As bookLimitedDeduction books it: a share only moves moms on a row that has some.
    const deductibleOre = fullOre > 0 && item.vat_deduction_share != null
      ? toOre(deductibleRowVat(item, item.vat_deduction_share))
      : fullOre
    return { index, fullOre, deductibleOre, personbil: isPersonbilLeaseOrHireAccount(item.account_number) }
  })
  const gapOre = rows.reduce((sum, row) => sum + row.deductibleOre, 0) - toOre(statedVat)
  if (gapOre <= 0) return null
  const order = rows
    .filter((row) => row.fullOre > 0 && row.deductibleOre > 0)
    .sort((a, b) => Number(b.personbil) - Number(a.personbil) || b.deductibleOre - a.deductibleOre || a.index - b.index)
  let leftOre = gapOre
  const touched: StatedVatDeduction['rows'] = []
  for (const row of order) {
    if (leftOre === 0) break
    const takeOre = Math.min(leftOre, row.deductibleOre)
    const deductibleOre = row.deductibleOre - takeOre
    touched.push({ index: row.index, share: deductibleOre / row.fullOre, deductibleVat: deductibleOre / 100 })
    leftOre -= takeOre
  }
  return { nonDeductibleVat: gapOre / 100, rows: touched }
}

/** A line as the MCP inbox door stages it: vat_amount is its part of the document's moms. */
export interface StagedDeductionLine {
  line_number: number
  line_total: number
  vat_rate: number
  vat_amount: number
}

export interface StagedLineDeduction<T> {
  /** The lines to stage: a deducted line keeps its share, its amount grown by the moms booked as cost. */
  lines: Array<T & { vat_deduction_share?: number }>
  /** Per deducted line: the moms the invoice states, the part deducted and the part booked as cost. */
  deducted: Array<{ line_number: number; invoiced_vat: number; deductible_vat: number; vat_as_cost: number }>
  /** Line numbers given a share that the invoice does not have or that carry no moms. */
  invalidLines: number[]
}

/**
 * Begränsat momsavdrag on the MCP inbox door's staged lines, by line number:
 * each line is booked as bookLimitedDeduction books the editor's row, from the
 * moms the line carries, so the lines incl. moms stay the invoice total.
 */
export function deductStagedLines<T extends StagedDeductionLine>(
  lines: readonly T[],
  shares: ReadonlyMap<number, number>,
): StagedLineDeduction<T> {
  const invalidLines = [...shares.keys()].filter(
    (lineNumber) => !((lines.find((line) => line.line_number === lineNumber)?.vat_amount ?? 0) > 0),
  )
  const booked = bookLimitedDeduction<LimitedDeductionRow>(
    lines.map((line) => ({
      amount: line.line_total,
      vat_rate: line.vat_rate,
      invoiced_vat: line.vat_amount,
      vat_deduction_share: shares.get(line.line_number),
    })),
    true,
  )
  const deducted: StagedLineDeduction<T>['deducted'] = []
  const staged = lines.map((line, idx) => {
    const share = shares.get(line.line_number)
    const vatAsCost = booked.nonDeductibleVat[idx]
    if (share === undefined || vatAsCost === 0) return line
    const row = booked.items[idx]
    const deductible = row.vat_amount ?? 0
    deducted.push({ line_number: line.line_number, invoiced_vat: line.vat_amount, deductible_vat: deductible, vat_as_cost: vatAsCost })
    return { ...line, line_total: row.amount, vat_rate: row.vat_rate, vat_amount: deductible, vat_deduction_share: share }
  })
  return { lines: staged, deducted, invalidLines }
}
