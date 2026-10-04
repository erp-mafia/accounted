/**
 * Pure function to compute proposed journal entry lines for sending an invoice.
 * Used by the SendInvoiceDialog to preview the journal entry before committing
 * and, once the user edits a row, to submit it verbatim.
 *
 * The lines are the server's own: buildInvoiceRegistrationLines (what
 * buildInvoiceJournalEntryInput books) or buildCreditNoteLines (what
 * createCreditNoteJournalEntry books), only converted to form rows. A
 * hand-kept copy used to live here and drifted from them: it credited the VAT
 * rate's default account where an item named its own, dropped the goods
 * delivery country and per-item dimension bags, and previewed 30xx where a
 * periodiserad row books 29xx.
 *
 * No DB or Supabase dependency: all inputs are plain data.
 */
import { InvoiceFxRateMissingError } from './invoice-accounts'
import {
  buildCreditNoteLines,
  buildInvoiceRegistrationLines,
  type InvoiceRegistrationLinesSource,
} from './invoice-lines'
import { roundOre } from '@/lib/money'
import type { FormLine } from '@/components/bookkeeping/JournalEntryForm'
import type { CreateJournalEntryLineInput, EntityType } from '@/types'

export interface ProposeSendLinesInput {
  /** The invoice row with its items, as the dialog holds it. */
  invoice: InvoiceRegistrationLinesSource & { credited_invoice_id?: string | null }
  entityType: EntityType
}

function toFormAmount(n: number): string {
  const rounded = Math.round(n * 100) / 100
  return rounded === 0 ? '' : rounded.toString()
}

/**
 * Propose journal entry lines for an invoice send (accrual method), or for a
 * credit note the reversal of them.
 *
 * Debit  1510 Kundfordringar [total incl VAT, minus ROT/RUT]
 * Debit  1513 Skatteverket   [ROT/RUT per item]
 * Credit 30xx Försäljning    [subtotal per rate and account]
 * Credit 26xx Utgående moms  [VAT per rate]
 */
export function proposeSendLines(input: ProposeSendLinesInput): FormLine[] {
  const { invoice, entityType } = input

  // Existing informational rows are never a valid source for an invoice-level
  // amount. Returning no proposal keeps an inconsistent text-only invoice from
  // producing a debit-only entry; the user must correct its economic rows.
  const items = invoice.items ?? []
  if (items.length > 0 && items.every((item) => item.line_type === 'text')) {
    return []
  }

  let lines: CreateJournalEntryLineInput[]
  try {
    lines = invoice.credited_invoice_id
      ? buildCreditNoteLines(invoice, entityType)
      : buildInvoiceRegistrationLines(invoice, entityType)
  } catch (err) {
    // A foreign invoice with no SEK source: the builders refuse rather than
    // relabel the foreign number as kronor, and the send itself is refused
    // with INVOICE_FX_RATE_MISSING. This runs inside a useMemo during the
    // dialog's render, where a throw takes out the page, so return no
    // proposal: the dialog then hides the journal preview instead of showing
    // fabricated amounts. `editable` is SEK-only, so an empty proposal cannot
    // disable the submit button either.
    if (err instanceof InvoiceFxRateMissingError) return []
    throw err
  }

  // A zero row (a 0 kr item, a 0 kr invoice) books nothing anyone can read
  // and must not become a misleading blank row in the preview.
  return lines
    .filter((line) => roundOre(line.debit_amount) !== 0 || roundOre(line.credit_amount) !== 0)
    .map((line) => ({
      account_number: line.account_number,
      debit_amount: toFormAmount(line.debit_amount),
      credit_amount: toFormAmount(line.credit_amount),
      line_description: line.line_description ?? '',
      // A copy per line: editing one row's bag must not leak into another.
      ...(line.dimensions && Object.keys(line.dimensions).length > 0
        ? { dimensions: { ...line.dimensions } }
        : {}),
    }))
}
