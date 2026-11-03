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
