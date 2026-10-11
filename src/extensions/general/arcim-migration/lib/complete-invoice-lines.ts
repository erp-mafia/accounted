/**
 * Finish a migrated sales-invoice register: fetch the rows (and the VAT split)
 * for the invoices that were imported without them.
 *
 * The migration maps invoices from the provider's LIST payload and hydrates
 * the detail form inside a fixed budget (see lib/providers/provider-data-
 * fetcher.ts). Fortnox, Briox and Björn Lundén ship no rows in a list
 * response, so every invoice the budget did not reach lands as a header with
 * a total and no invoice_items behind it: Profilio (384 of 384, migrated
 * before hydration existed), Loftux (311 of 672), Damac (182 of 542),
 * Clearstoq (1 125 of 1 125). Nothing ever came back for them, and the wizard
 * had not said so.
 *
 * The follow-up is the hourly cron (invoice-completion-worker.ts): it pages
 * the provider's register, joins each page to OUR row-less invoices on
 * invoice number AND date, hydrates only those, and writes an invoice's rows
 * once the provider's detail total agrees with the stored total to the öre.
 * This module holds the per-invoice planner it uses: what to write for one
 * stored row and one hydrated detail form, or why to leave the row alone.
 *
 * What it writes, and only this:
 *   - invoice_items for an invoice that has none;
 *   - the header VAT split (subtotal, vat_amount, vat_rate, vat_treatment and
 *     their SEK twins) when the stored split is the "unknown" shape the old
 *     import left behind (no rate, or 0 kr VAT beside subtotal = total).
 * Never the total, the status, the customer, payments or any journal entry:
 * momsdeklaration and every report read the ledger, not these columns, so
 * filling them changes what the invoice page shows and nothing that was
 * filed (see the 2026-08-22 verification in DECISIONS.md).
 *
 * Both are written by one call to the complete_invoice_rows RPC per invoice
 * (migration 20260906135730), the write path the migration wizard shares: it
 * locks the invoice, inserts the rows only when the invoice still has none
 * and applies the header split in the same transaction, so an invoice's rows
 * are written at most once whichever writer gets there first, and "rows
 * landed, header did not" is not a reachable state. The call goes through
 * completeInvoiceRows (lib/invoices/complete-invoice-rows.ts), which also
 * writes the behandlingshistorik event for every invoice the RPC filled: one
 * InvoiceRowsCompleted per invoice, with the header split before and after
 * (BFL 5 kap 11 §, BFNAR 2013:2 p. 9.16).
 */

import type { InvoiceHeaderVatSplit } from '@/lib/invoices/complete-invoice-rows'
import { createLogger } from '@/lib/logger'
import { equalOre, roundOre } from '@/lib/money'
import type { SalesInvoiceDto } from '@/lib/providers/dto'
import { mapSalesInvoice } from './entity-mapper'

const log = createLogger('extensions/arcim-migration/complete-invoice-lines')

/** The writer named in the trail; also the default actor id (the hourly cron). */
export const COMPLETE_INVOICE_LINES_SOURCE = 'complete-invoice-lines'

export interface CandidateRow {
  id: string
  user_id: string
  customer_id: string
  invoice_number: string | null
  invoice_date: string
  total: number
  subtotal: number | null
  vat_amount: number | null
  vat_rate: number | null
  vat_treatment: string | null
  currency: string | null
  exchange_rate: number | null
  invoice_items: { id: string }[] | null
}

/**
 * How far the rows may disagree with the header before the invoice is left
 * alone. Öresavrundning puts up to 0.50 kr between a Fortnox `Total` and the
 * unrounded net plus VAT, and per-row VAT rounding adds öre per row; a real
 * disagreement (rows priced with VAT inside, a header-level freight or
 * discount the rows do not carry) is kronor, not öre. A row set that fails
 * this is a mapper or payload problem to be understood, not stored: rows that
 * contradict their own header are worse than no rows.
 */
const ROWS_TOLERANCE_KR = 1

/**
 * Is the stored VAT split the shape the old import left behind?
 *
 * A null rate is the post-#1745 "the source did not say". A non-zero rate
 * label beside 0 kr of VAT and subtotal = total is what the pre-#1745 mapper
 * wrote for every Fortnox invoice (25 % on top of nothing): a contradiction,
 * not a fact. Both mean the columns hold no evidence, so the detail form may
 * overwrite them. A split that is consistent with itself, including a
 * genuinely momsfri one (rate 0, 0 kr VAT, subtotal = total), is evidence
 * and is left as it is; the rows are still written.
 */
function headerHoldsNoVatEvidence(row: CandidateRow): boolean {
  if (row.vat_rate === null) return true
  if (row.vat_rate === 0) return false
  const subtotal = row.subtotal ?? row.total
  const vat = row.vat_amount ?? 0
  return equalOre(vat, 0) && equalOre(subtotal, row.total)
}

/** SEK twin of an amount on this row, or null when the row has no rate. */
function toRowSek(amount: number, row: CandidateRow): number | null {
  if (!row.currency || row.currency.toUpperCase() === 'SEK') return roundOre(amount)
  return row.exchange_rate != null ? roundOre(amount * row.exchange_rate) : null
}

interface PlannedWrite {
  row: CandidateRow
  /** The invoice_items columns per row; the RPC stamps invoice_id itself. */
  items: Record<string, unknown>[]
  /** The header VAT split the detail form established, as the RPC's p_header. */
  header: InvoiceHeaderVatSplit | null
}

/** What to write for one stored row and its hydrated detail form, or why to leave it alone. */
export function planInvoiceLineCompletion(row: CandidateRow, dto: SalesInvoiceDto, companyId: string):
  | { reason: 'noLinesAtProvider' | 'totalMismatch' | 'rowsMismatch' }
  | { plan: PlannedWrite; vatUnresolved: boolean } {
  if (dto.lines.length === 0) {
    return { reason: 'noLinesAtProvider' }
  }

  // The same mapper the migration used, so a row written here is
  // indistinguishable from one written by a fully hydrated import. No FX
  // index: the SEK twins are derived from the rate the row already carries.
  const mapped = mapSalesInvoice(dto, row.user_id, companyId, row.customer_id)
  const mappedTotal = mapped.invoice.total as number
  if (!equalOre(mappedTotal, row.total)) {
    log.warn('detail total differs from the stored total; invoice left untouched', {
      companyId, invoiceId: row.id, invoiceNumber: row.invoice_number, stored: row.total, provider: mappedTotal,
    })
    return { reason: 'totalMismatch' }
  }

  if (!mapped.vatUnresolved) {
    const rowsNet = mapped.items.reduce((sum, item) => sum + Number(item.line_total ?? 0), 0)
    const rowsVat = mapped.items.reduce((sum, item) => sum + Number(item.vat_amount ?? 0), 0)
    const headerNet = mapped.invoice.subtotal as number
    const headerVat = mapped.invoice.vat_amount as number
    if (Math.abs(rowsNet - headerNet) > ROWS_TOLERANCE_KR || Math.abs(rowsVat - headerVat) > ROWS_TOLERANCE_KR) {
      log.warn('mapped rows do not add up to the header; invoice left untouched', {
        companyId, invoiceId: row.id, invoiceNumber: row.invoice_number,
        headerNet, rowsNet: roundOre(rowsNet), headerVat, rowsVat: roundOre(rowsVat), rows: mapped.items.length,
      })
      return { reason: 'rowsMismatch' }
    }
  }

  let header: InvoiceHeaderVatSplit | null = null
  if (!mapped.vatUnresolved && headerHoldsNoVatEvidence(row)) {
    const subtotal = mapped.invoice.subtotal as number
    const vatAmount = mapped.invoice.vat_amount as number
    header = {
      subtotal,
      subtotal_sek: toRowSek(subtotal, row),
      vat_amount: vatAmount,
      vat_amount_sek: toRowSek(vatAmount, row),
      vat_rate: mapped.invoice.vat_rate as number | null,
      vat_treatment: mapped.invoice.vat_treatment as string,
    }
  }

  return { plan: { row, items: mapped.items, header }, vatUnresolved: mapped.vatUnresolved }
}
