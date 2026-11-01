import { isCreditNoteDocument } from '@/lib/bookkeeping/credit-note-state'
import { documentCurrency } from '@/lib/bookkeeping/ledger-line-amount'
import { roundOre } from '@/lib/money'

/**
 * A kreditfaktura's credit used to pay another invoice (crm#1059).
 *
 * A credit note books its credit on its own verifikat (Cr 1510). To set that
 * credit off against a later invoice, the user links the verifikat to the
 * invoice with link_invoice_to_voucher: the invoice gets a payment row naming
 * the verifikat, and no new verifikat is needed because 1510 already nets the
 * two. Nothing on the credit note changes, so read as total - paid_amount it
 * kept its whole credit: the kundreskontra counted the credit twice, as that
 * payment and as an open credit, and fell short of 1510 by the linked amount.
 *
 * The payment row is the record of the set-off. The reskontra readers derive
 * the credit used from it instead of from a stored state on the credit note,
 * so credit notes already linked come out right without a data change. Today
 * a link always uses the whole credit: link_invoice_to_voucher refuses a
 * verifikat whose credit exceeds the invoice's remaining amount.
 */

/**
 * One payment row naming a credit note's verifikat, with the date of the
 * invoice it pays. get_ar_ledger_invoices attaches them to the credit note
 * (lib/reports/ar-ledger-invoices.ts), in id order.
 */
export interface CreditNoteLink {
  invoice_id: string
  journal_entry_id: string
  amount: number | string | null
  currency: string | null
  payment_exchange_rate: number | string | null
  payment_date: string
  invoice: { invoice_date: string | null } | null
}

export interface CreditNoteSettlementRow {
  id: string
  total?: unknown
  currency?: string | null
  exchange_rate?: unknown
  journal_entry_id?: string | null
  /** The payment rows naming this row's verifikat; read only for credit notes. */
  credit_links?: readonly CreditNoteLink[] | null
}

/**
 * The date the credit counts as used on an as-of date: the payment row
 * carries the verifikat's date, the credit note's own, but the set-off cannot
 * come before the invoice it pays exists. Until then 1510 still held the
 * credit.
 */
function usedOn(link: CreditNoteLink): string {
  const invoiceDate = link.invoice?.invoice_date ?? ''
  return invoiceDate > link.payment_date ? invoiceDate : link.payment_date
}

/**
 * The credit one payment row used, in the credit note's currency. The credit
 * sits on the verifikat in kronor (buildCreditNoteLines writes the 1510 line
 * with no other currency), and link_invoice_to_voucher reads it one of three
 * ways:
 *  - the kronor fallback for a foreign invoice (payment_exchange_rate set)
 *    settles with the verifikat's whole kronor side: the whole credit;
 *  - an amount in the credit note's own currency: as it stands;
 *  - kronor against a foreign credit note: at the credit note's own rate.
 * Any other pair cannot be read and uses nothing (null). One link never uses
 * more than the credit note's credit: anything above it is conversion noise.
 */
function creditUsedBy(link: CreditNoteLink, note: CreditNoteSettlementRow): number | null {
  const credit = Math.abs(Number(note.total) || 0)
  if (link.payment_exchange_rate != null) return credit
  const amount = Number(link.amount) || 0
  const linkCurrency = documentCurrency(link.currency)
  if (linkCurrency === documentCurrency(note.currency)) return Math.min(credit, amount)
  const rate = Number(note.exchange_rate)
  return linkCurrency === 'SEK' && rate > 0 ? Math.min(credit, roundOre(amount / rate)) : null
}

/**
 * The credit each credit note in `rows` has used to pay other invoices, in
 * its own currency, keyed by credit note id. Rows that are not credit notes
 * with a verifikat are ignored. With an `asOfDate` only the set-offs made by
 * then count (see usedOn).
 *
 * A verifikat that books more than one credit note cannot say whose credit a
 * link used, so those keep their whole credit, as before. The issuer posts
 * one verifikat per credit note; only imported data could share one.
 */
export function creditNoteCreditUsed(
  rows: readonly CreditNoteSettlementRow[],
  asOfDate?: string
): Map<string, number> {
  const noteByEntry = new Map<string, CreditNoteSettlementRow | null>()
  const linksByEntry = new Map<string, readonly CreditNoteLink[]>()
  for (const row of rows) {
    if (!row.journal_entry_id || !isCreditNoteDocument(row)) continue
    noteByEntry.set(row.journal_entry_id, noteByEntry.has(row.journal_entry_id) ? null : row)
    if (!linksByEntry.has(row.journal_entry_id)) linksByEntry.set(row.journal_entry_id, row.credit_links ?? [])
  }

  const used = new Map<string, number>()
  for (const [entryId, note] of noteByEntry) {
    if (!note) continue
    for (const link of linksByEntry.get(entryId) ?? []) {
      if (note.id === link.invoice_id) continue
      if (asOfDate && usedOn(link) > asOfDate) continue
      const credit = creditUsedBy(link, note)
      if (credit === null) continue
      used.set(note.id, roundOre((used.get(note.id) ?? 0) + credit))
    }
  }
  return used
}

/**
 * A register row's outstanding with the credit it used added back. Rows that
 * used none are returned untouched. There is no clamp at zero: the link only
 * refuses a second link to the same invoice, so one verifikat can pay two
 * invoices. The credit note then reads positive by the credit used twice,
 * which keeps the reskontra equal to 1510 and shows the double use on its row.
 */
export function outstandingWithCreditUsed(outstanding: number, used: number | undefined): number {
  if (!used) return outstanding
  return roundOre(outstanding + used)
}
