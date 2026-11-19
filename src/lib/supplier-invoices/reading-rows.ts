import { netVat } from '@/lib/bookkeeping/gross-split'
import { foldSellerVatIntoCost, sellerVatIsCost } from '@/lib/bookkeeping/vat-registration'
import { roundOre, sumOre } from '@/lib/money'
import { isLegalVatRate } from '@/lib/vat/supplier-invoice-line-checks'
import { normalizeVatRateToFraction } from '@/lib/vat/vat-rate-unit'
import type { InvoiceExtractionResult } from '@/types'
import { vatRateFromAi, type SupplierInvoiceLineItem } from './form-payload'
import { reverseChargeRateDefault } from './reverse-charge-rate'
import {
  invoiceTotalsCrosscheck,
  invoiceVatIsBooked,
  rowNetFromInvoiceTotals,
  rowsAgainstInvoiceTotals,
} from './total-first'

/** A kontering row a reading proposes: its text, its net in the document's currency and its moms sats. */
export interface ReadingRow {
  description: string
  amount: number
  vat_rate: number
}

export interface ReadingRows {
  /** The document's total incl. moms, for Fakturabelopp. Null when it was not read. */
  invoiceTotal: number | null
  /** The document's own moms, for the Moms field. Null when it states none. */
  invoiceVat: number | null
  /** The rows the editor opens with. */
  rows: ReadingRow[]
  /**
   * The amount of a single row when it is what the editor's total-first fill
   * gives (rowNetFromInvoiceTotals): the editor then keeps that row in step
   * with Fakturabelopp, Moms and the sats. Null for any other rows, and
   * always under reverse charge, where the rows stand as read.
   */
  filledNet: number | null
  /**
   * The invoice's own rows, one per read line, where they are more than
   * `rows` and no worse than them: the editor offers them as a split. Null
   * when the rows had to come from the totals because the lines do not add
   * up, and when there are no rows to split.
   */
  invoiceRows: ReadingRow[] | null
}

function ore(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? roundOre(value) : null
}

/**
 * The rows the document's own moms specification gives: one per sats, on the
 * net it prints for that sats. None when the reading has no specification,
 * or one that names a sats that is not Swedish, a sats twice or no net:
 * nothing is guessed from it.
 */
function rowsOfVatSpecification(
  specification: InvoiceExtractionResult['vatBreakdown'] | null | undefined,
  rowAt: (rate: number, amount: number) => ReadingRow,
): ReadingRow[] {
  const rows: ReadingRow[] = []
  for (const entry of specification ?? []) {
    const rate = roundOre(normalizeVatRateToFraction(entry?.rate))
    const net = ore(entry?.base)
    if (net == null || !isLegalVatRate(rate) || rows.some((row) => row.vat_rate === rate)) return []
    rows.push(rowAt(rate, net))
  }
  return rows.filter((row) => row.amount !== 0)
}

/** The rows with each one's moms booked as cost: its gross at 0 % (foldSellerVatIntoCost). */
function asCost(rows: ReadingRow[]): ReadingRow[] {
  const { lines } = foldSellerVatIntoCost(
    rows.map((row) => ({
      ...row,
      line_total: row.amount,
      unit_price: row.amount,
      vat_amount: netVat(row.amount, row.vat_rate),
    })),
  )
  return lines.map((line) => ({ description: line.description, amount: line.line_total, vat_rate: line.vat_rate }))
}

/**
 * The rows a read supplier invoice opens with in the editor, and what its
 * Fakturabelopp and Moms fields get: the one definition of which rows a
 * reading proposes.
 *
 * One row per moms sats, never one per read line. The read lines are the
 * least certain part of a reading (a line missed, a line read incl. moms),
 * and a row per read line left the person to find the difference: 13 % of
 * the readings with several lines did not add up to their own total.
 *
 * The rows are the read lines summed per sats unless the invoice's totals
 * give better ones. The totals are asked only where the invoice's own moms
 * is booked (a momsregistrerad company, no reverse charge), the reading
 * states a moms, and the lines and the total have the same sign. Then the
 * first of these that the editor's own cross-check accepts (to the öre, or
 * to the whole krona an öresavrundning explains):
 *
 * 1. the read lines summed per sats;
 * 2. the read lines themselves, which alone can carry a moms the seller
 *    rounded line by line;
 * 3. the invoice's own moms specification, one row per sats on the net it
 *    prints (rowsOfVatSpecification), unless it states fewer satser than
 *    the lines charge;
 * 4. where the lines charge one sats, the net the totals give beside the
 *    lines' 0 % part: the invoice's own net (its subtotal), else
 *    Fakturabelopp minus Moms, else moms / sats (rowNetFromInvoiceTotals,
 *    the öresavrundning case).
 *
 * When none is accepted the rows stay the summed lines and the cross-check
 * says what is left, with one exception: where the lines charge at most one
 * sats and a single row from the totals comes closer to the Fakturabelopp
 * than they do (a line was lost), that row. So a reading never opens with
 * fewer satser than its lines charge, and never further from its total than
 * a row per line was.
 *
 * Nothing is taken from the totals:
 * - under reverse charge: the rows are the lines' sums as a row per line
 *   showed them, none of them the total-first fill's, and whatever the
 *   seller charged on top stays a difference for a person to settle (not
 *   so for a company that is not momsregistrerad, see below);
 * - when the lines and the total have opposite signs (a credit note printed
 *   with negative lines above a positive amount): which sign holds is not
 *   the reading's to decide;
 * - without a moms: the totals carry no split. A moms of zero beside lines
 *   that charge moms is a figure the reading did not find;
 * - for a moms no line carries at a Swedish sats (a foreign seller's VAT):
 *   it is put on no row.
 *
 * A company that is not momsregistrerad books a seller's moms as cost
 * (sellerVatIsCost): its rows are gross at 0 %, and with a total the whole
 * Fakturabelopp is one row. Not under reverse charge, where sellerVatIsCost
 * does not hold: there its rows keep the sats they were read with, like
 * anyone's, and are not what the editor ends on. The editor's own zeroing
 * effect grosses every row with a sats up by it, reverse charge or not, as
 * it did to a row per line, so the seller's moms ends in the row. Without a
 * total, or with a total of zero, there is nothing to add up to: a row per
 * read line, as read.
 *
 * A row takes the text of its largest read line, so it is never without a
 * text when its lines had one (the API requires one, and an account's name
 * is not always known).
 */
export function rowsFromReading(
  reading: Pick<InvoiceExtractionResult, 'lineItems' | 'totals' | 'vatBreakdown' | 'invoice'> | null | undefined,
  editor: { vatRegistered: boolean; reverseCharge: boolean },
): ReadingRows {
  const lines: ReadingRow[] = (reading?.lineItems ?? []).map((line) => ({
    description: line.description || '',
    amount: typeof line.lineTotal === 'number' && Number.isFinite(line.lineTotal) ? line.lineTotal : 0,
    // A line without a sats starts on 25 %, as a row typed by hand does.
    vat_rate: vatRateFromAi(line.vatRate),
  }))
  const rates = [...new Set(lines.map((line) => line.vat_rate))]
  const chargingRates = rates.filter((rate) => rate > 0)
  // A total of zero is a total the reading did not find: no door registers one.
  const total = ore(reading?.totals?.total) || null
  const readVat = ore(reading?.totals?.vatAmount)
  // A moms of zero beside lines that charge moms is a figure the reading did
  // not find, not the invoice saying it charges none.
  const vat = readVat === 0 && chargingRates.length > 0 ? null : readVat
  const { reverseCharge, vatRegistered } = editor
  const booked = (rows: ReadingRow[]) => (sellerVatIsCost(vatRegistered, reverseCharge) ? asCost(rows) : rows)

  if (total == null || lines.length === 0) {
    return { invoiceTotal: total, invoiceVat: vat, rows: booked(lines), filledNet: null, invoiceRows: null }
  }

  const currency = reading?.invoice?.currency || 'SEK'
  // The editor checks the rows against a Moms only where it has the field.
  const checkedVat = invoiceVatIsBooked(vatRegistered, reverseCharge) ? vat : null
  const crosscheck = (rows: ReadingRow[]) => {
    const { amounts } = rowsAgainstInvoiceTotals({
      items: rows.map((row) => ({ amount: row.amount, account_number: '', vat_rate: row.vat_rate })),
      currency,
      reverseCharge,
      invoiceTotal: total,
      invoiceVat: checkedVat,
    })
    return invoiceTotalsCrosscheck({
      invoiceTotal: total,
      invoiceVat: checkedVat,
      toPay: amounts.figures.toPay,
      totalVat: amounts.totalVat,
    })
  }
  const addsUp = (rows: ReadingRow[]) => {
    const check = crosscheck(rows)
    return check.totalMatches && check.vatMatches
  }

  const at = (rate: number) => lines.filter((line) => line.vat_rate === rate)
  const netAt = (rate: number) => sumOre(at(rate).map((line) => line.amount))
  const textOf = (of: ReadingRow[]) =>
    of.reduce<ReadingRow | null>(
      (largest, line) =>
        line.description && (!largest || Math.abs(line.amount) > Math.abs(largest.amount)) ? line : largest,
      null,
    )?.description ?? ''
  const rowAt = (rate: number, amount: number): ReadingRow => ({
    description: textOf(at(rate)) || textOf(lines),
    amount,
    vat_rate: rate,
  })
  const summed = rates.map((rate) => rowAt(rate, netAt(rate))).filter((row) => row.amount !== 0)
  const oppositeSigns = Math.sign(sumOre(lines.map((line) => line.amount))) === -Math.sign(total)

  // The rows, and whether the read lines are no worse than them: the editor
  // then offers the lines as a split.
  let rows = summed
  let linesNoWorse = true
  if (reverseCharge || oppositeSigns) {
    // Nothing is taken from the totals.
  } else if (!vatRegistered) {
    rows = [{ description: textOf(lines), amount: total, vat_rate: 0 }]
    linesNoWorse = addsUp(booked(lines))
  } else if (vat != null) {
    const mixed = chargingRates.length > 1
    const totalsRow = (rate: number) =>
      rowAt(rate, rowNetFromInvoiceTotals({ total, vat, rate, reverseCharge }))
    const candidates = [summed, lines]
    const specified = rowsOfVatSpecification(reading?.vatBreakdown, rowAt)
    if (!mixed || chargingRates.every((rate) => specified.some((row) => row.vat_rate === rate))) {
      candidates.push(specified)
    }
    if (chargingRates.length === 1) {
      const rate = chargingRates[0]
      const zeroPart = summed.filter((row) => row.vat_rate === 0)
      const subtotal = ore(reading?.totals?.subtotal)
      const nets = [...(subtotal == null ? [] : [subtotal]), roundOre(total - vat)]
      candidates.push(
        ...nets.map((net) => [rowAt(rate, roundOre(net - netAt(0))), ...zeroPart]),
        [totalsRow(rate), ...zeroPart],
      )
    }
    // One row from the totals only where the lines charge at most one sats,
    // never for a moms no line carries at a Swedish sats, and only when it
    // comes closer to the Fakturabelopp than the lines do.
    const single = mixed || (vat !== 0 && chargingRates.length === 0) ? null : [totalsRow(chargingRates[0] ?? 0)]
    const off = (of: ReadingRow[]) => Math.abs(crosscheck(of).totalDiff ?? 0)
    rows = candidates.find(addsUp) ?? (single && off(single) < off(summed) ? single : summed)
    linesNoWorse = rows === summed
  }

  const shown = booked(rows)
  const fillNet = rowNetFromInvoiceTotals({ total, vat: checkedVat, rate: shown[0]?.vat_rate ?? 0, reverseCharge })
  return {
    invoiceTotal: total,
    invoiceVat: vat,
    rows: shown,
    filledNet: !reverseCharge && shown.length === 1 && shown[0].amount === fillNet ? fillNet : null,
    invoiceRows: shown.length > 0 && lines.length > shown.length && linesNoWorse ? booked(lines) : null,
  }
}

/**
 * What the editor does to a row by itself once a reading has put it there,
 * with nobody touching it. Named here, once, so that rowsStandAsPut asks only
 * about what a person changed: a field the editor comes to derive later is
 * one more entry below, not a new way for the editor to take its own doing
 * for an edit. Each entry says when the value on screen (`row`) is the
 * editor's, given the row as it was put (`was`).
 */
const EDITORS_OWN: {
  [Field in keyof SupplierInvoiceLineItem]?: (
    row: SupplierInvoiceLineItem,
    was: SupplierInvoiceLineItem,
    accountName: (accountNumber: string) => string,
  ) => boolean
} = {
  // A supplier's default or the company's own history fills it, often after
  // the reading; it travels with the rows when they are swapped
  // (accountCarriedFrom).
  account_number: () => true,
  // A row put without a text is named after that account.
  description: (row, was, accountName) => !was.description && row.description === accountName(row.account_number),
  // When reverse charge is switched on after the row was put, the editor
  // gives the row its default reverse-charge sats (reverseChargeRateDefault).
  // Any other sats there is the person's choice.
  reverse_charge_rate: (row, was) =>
    was.reverse_charge_rate == null && row.reverse_charge_rate === reverseChargeRateDefault(was.vat_rate),
}

/**
 * Whether a field of a row on screen holds what the editor put there by
 * itself (EDITORS_OWN), given the row as it was put (`was`): a difference
 * there is then no edit by the person. Also asked about the rows a
 * supplier's default plants (plantedRowTouched).
 */
export function editorsOwnValue(
  field: keyof SupplierInvoiceLineItem,
  row: SupplierInvoiceLineItem,
  was: SupplierInvoiceLineItem,
  accountName: (accountNumber: string) => string = () => '',
): boolean {
  return EDITORS_OWN[field]?.(row, was, accountName) ?? false
}

/**
 * A row as it was put, and as the editor's zeroing leaves it for a company
 * that is not momsregistrerad: its moms booked as cost, the gross at 0 %
 * (asCost). The one thing the editor does to a row's amount and sats by
 * itself, and to both at once, so it is a second form of the whole row.
 */
function asTheEditorLeavesIt(was: SupplierInvoiceLineItem, vatRegistered: boolean): SupplierInvoiceLineItem[] {
  if (vatRegistered) return [was]
  const [cost] = asCost([{ description: was.description, amount: was.amount, vat_rate: was.vat_rate }])
  return [was, { ...was, amount: cost.amount, vat_rate: cost.vat_rate }]
}

/**
 * Whether the rows on screen are still what a reading or its toggle put
 * there (`put`): only then can the editor swap them for the reading's other
 * rows without dropping something the person changed (an amount, a text,
 * the sats, periodisering, a dimension, särskild löneskatt, a limited
 * deduction, a reverse-charge sats of their own choosing). A field that is
 * absent and one that is undefined are the same.
 *
 * What the editor does to a row by itself does not count (EDITORS_OWN, and
 * its zeroing for a company that is not momsregistrerad: `vatRegistered` is
 * the company's, as the editor has it now). The account not counting holds
 * as long as the rows of one sats share it: accounts set apart line by line
 * would be merged away by a swap.
 */
export function rowsStandAsPut(
  onScreen: ReadonlyArray<SupplierInvoiceLineItem>,
  put: ReadonlyArray<SupplierInvoiceLineItem>,
  accountName: (accountNumber: string) => string,
  vatRegistered = true,
): boolean {
  if (onScreen.length !== put.length) return false
  const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null)
  const untouched = onScreen.every((row, index) =>
    asTheEditorLeavesIt(put[index], vatRegistered).some((left) => {
      const keys = new Set([...Object.keys(row), ...Object.keys(left)] as Array<keyof SupplierInvoiceLineItem>)
      return [...keys].every((key) => editorsOwnValue(key, row, put[index], accountName) || same(row[key], left[key]))
    }),
  )
  const accountsOf = (rate: number) =>
    new Set(onScreen.filter((row) => row.vat_rate === rate && row.account_number).map((row) => row.account_number))
  return untouched && onScreen.every((row) => accountsOf(row.vat_rate).size <= 1)
}

/**
 * The account a row of the reading starts on when it replaces the rows the
 * editor holds (a split into the invoice's lines, or back): the account its
 * moms sats has there, else the first account chosen there, else `fallback`.
 * A split then starts on the account already picked, not on empty rows.
 */
export function accountCarriedFrom(
  current: ReadonlyArray<{ account_number: string; vat_rate: number }>,
  fallback: string | null,
): (row: ReadingRow) => string {
  const chosen = current.filter((item) => item.account_number)
  return (row) =>
    (chosen.find((item) => item.vat_rate === row.vat_rate) ?? chosen[0])?.account_number ?? fallback ?? ''
}
