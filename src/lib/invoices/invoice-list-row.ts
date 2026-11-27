import type { Invoice } from '@/types'
import type { RotRutListItem } from './rot-rut-list-status'

/**
 * One row of the invoice list (/invoices and /quotes): the columns the list
 * reads and nothing else.
 *
 * The list holds every invoice of the company in memory (tabs, counts,
 * search and sort all run on the client), so what a row carries is what the
 * browser downloads once per invoice. The list used to select `*`: 1.7 kB
 * of JSON per invoice (notes, addresses, payment details, FX and VAT fields
 * the list never shows) against the 0.56 kB of the columns below, measured
 * on the largest register in production (31 600 invoices: 54 MB against
 * 18 MB).
 *
 * The page's select string lists exactly these columns; a helper the list
 * calls can only read a field that is picked here, because the row is typed
 * as this Pick and not as Invoice.
 */
export type InvoiceListRow = Pick<
  Invoice,
  | 'id'
  | 'customer_id'
  | 'invoice_number'
  | 'external_invoice_number'
  | 'is_self_billed'
  | 'document_type'
  | 'status'
  | 'quote_status'
  | 'invoice_date'
  | 'due_date'
  | 'valid_until'
  | 'subtotal'
  | 'total'
  | 'total_sek'
  | 'currency'
  | 'ore_rounding'
  | 'credited_invoice_id'
  | 'credit_undone_at'
  | 'remaining_amount'
  | 'paid_at'
  | 'deduction_total'
  | 'journal_entry_id'
> & {
  customer: { name: string } | null
} & InvoiceDeductionFacts

/**
 * What the skattereduktion column reads beyond the row: the begäran an
 * invoice sits in and the kinds of its deduction lines. Few invoices have
 * either, so they are read once for the company (its begäran with their
 * invoices, and the deduction lines of the invoices whose deduction_total
 * is above zero, a partial index) and joined onto the rows by id, instead of
 * as two embeds evaluated for every invoice of the register on every page
 * of the list read.
 */
export interface InvoiceDeductionFacts {
  rot_rut_items?: RotRutListItem[] | null
  deduction_lines?: Array<{ deduction_type: string | null }> | null
}

/** The facts joined onto their rows; a row without a deduction is returned as it is. */
export function withDeductionFacts<T extends { id: string }>(
  rows: readonly T[],
  factsByInvoiceId: ReadonlyMap<string, InvoiceDeductionFacts>,
): Array<T & InvoiceDeductionFacts> {
  if (factsByInvoiceId.size === 0) return rows as Array<T & InvoiceDeductionFacts>
  return rows.map((row) => {
    const facts = factsByInvoiceId.get(row.id)
    return facts ? { ...row, ...facts } : row
  })
}
