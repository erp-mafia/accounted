/**
 * What a foreign document still carries on the ledger, and what a payment of
 * it clears.
 *
 * A foreign invoice sits on 1510 or 2440 at the SEK its registration booked,
 * and that is the sum of its per-line SEK, not the total times the rate: 141.36
 * + 35.34 EUR at 11.123 registers 1965.44 while 176.70 x 11.123 is 1965.43. A
 * full settlement computed at the rate leaves that öre on a paid invoice, and a
 * rättelse or an earlier part payment moves the figure further. So a settlement
 * clears what the ledger carries: nothing is left on the account and the whole
 * difference to the SEK that moved lands on 3960/7960.
 *
 * The rule lives in one place, public.document_carried_sek, because
 * match_batch_allocate needs it inside its transaction: the live registration's
 * 1510 debit or 244x credit less what the document's own payment vouchers
 * cleared, each followed through a storno to its correction. It answers a
 * reason, not a figure, when the links contradict each other (a voucher shared
 * with another document, payment rows that do not add up to paid_amount, a
 * voucher reversed with no single correction) or when the ledger strays from
 * the document's own rate past the limit, which is a rättelse of the debt and
 * not a rate movement. A door that can fall back to the rate does (carriedSekOf);
 * the manual supplier door refuses and names the reason (carriedSek).
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { isKronorCurrency, sekOfForeign } from '@/lib/bookkeeping/currency-utils'
import { invoiceCustomerShare } from '@/lib/bookkeeping/customer-share'
import { bookedOreRounding } from '@/lib/bookkeeping/ore-rounding'
import { dbError } from '@/lib/errors/db-error'
import { ORE_TOLERANCE, equalOre, roundOre } from '@/lib/money'
import { chunk } from '@/lib/utils'

/** Which ledger carries the document: 1510 or 244x. */
export type LedgerSide = 'customer' | 'supplier'

/** Why the SEK a document carries could not be read off its linked vouchers. */
export type CarriedSekUnresolvedReason =
  /** No document with this id in this company. */
  | 'document_not_found'
  /** No registration verifikat is linked to the document. */
  | 'no_registration_voucher'
  /** Reversed with no single correction, or never posted. */
  | 'registration_voucher_not_live'
  /** Another document names the same registration verifikat. */
  | 'registration_voucher_shared'
  /** Payment rows without a voucher, or not adding up to paid_amount. */
  | 'payment_history_mismatch'
  /** A payment voucher that is missing, or reversed with no single correction. */
  | 'payment_voucher_not_posted'
  /** A payment voucher that also settles another document. */
  | 'payment_voucher_shared'
  /** The ledger carries nothing for a document the reskontra says is open. */
  | 'no_liability_left'
  /** The ledger is past the limit from remaining x exchange_rate. */
  | 'ledger_rate_mismatch'
  /** More than 50 payment rows, or a storno chain of more than ten hops. */
  | 'ledger_history_too_long'

export type CarriedSek =
  | { ok: true; sek: number }
  | { ok: false; reason: CarriedSekUnresolvedReason; expected_sek?: number; ledger_sek?: number }

/**
 * The SEK this document still carries on 151x or 244x, as the ledger has it,
 * or the reason it cannot say. Throws only on a read error.
 */
export async function carriedSek(
  supabase: Pick<SupabaseClient, 'rpc'>,
  companyId: string,
  side: LedgerSide,
  documentId: string,
): Promise<CarriedSek> {
  const { data, error } = await supabase.rpc('document_carried_sek', {
    p_company_id: companyId,
    p_side: side,
    p_document_id: documentId,
  })
  if (error) throw dbError(error, 'carried SEK')
  return (data as CarriedSek | null) ?? { ok: false, reason: 'document_not_found' }
}

/**
 * The ledger's figure for a foreign document, for a door that clears at the
 * rate when the ledger cannot say.
 *
 * A kronor document's remainder is its figure, with one exception: a customer
 * invoice whose issue verifikat booked its öresavrundning (1510 at the rounded
 * "Att betala", the öre on 3740) carries the rounded figure, and a payment
 * that clears the remainder would book the öre a second time. For that
 * invoice the ledger's figure is answered (bookedOreRounding non-zero); for
 * every other kronor document null, as before, so its doors keep clearing the
 * remainder. Only a customer invoice with an issue verifikat and öre left to
 * pay costs a read. A supplier document costs none: its rounding is an item
 * of the invoice, inside its total (supplier-invoice-rounding-item.ts).
 */
export async function carriedSekOf(
  supabase: Pick<SupabaseClient, 'rpc'>,
  companyId: string,
  side: LedgerSide,
  document: {
    id: string
    currency?: string | null
    remaining_amount?: number | null
    total?: number | null
    paid_amount?: number | null
    /** The issue verifikat; null (not absent) means none, so nothing to read. */
    journal_entry_id?: string | null
  },
): Promise<number | null> {
  if (isKronorCurrency(document.currency)) {
    if (side !== 'customer' || document.journal_entry_id === null) return null
    // Rounding to whole kronor leaves a gap only when the remainder has öre:
    // a whole-krona remainder costs no read.
    const remaining = kronorRemaining(document)
    if (remaining === null || Number.isInteger(remaining)) return null
    const carried = await carriedSek(supabase, companyId, side, document.id)
    return carried.ok && bookedOreRounding(remaining, carried.sek) !== 0 ? carried.sek : null
  }
  const carried = await carriedSek(supabase, companyId, side, document.id)
  return carried.ok ? carried.sek : null
}

/** What a kronor document still owes, or null when the row cannot say. */
function kronorRemaining(document: {
  remaining_amount?: number | null
  total?: number | null
  paid_amount?: number | null
}): number | null {
  // A numeric column can arrive as a string from some readers.
  const num = (v: unknown): number | null =>
    typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : null
  const stored = num(document.remaining_amount)
  const total = num(document.total)
  const remaining = stored !== null ? stored : total !== null ? total - (num(document.paid_amount) ?? 0) : null
  return remaining !== null && Number.isFinite(remaining) && remaining > ORE_TOLERANCE ? roundOre(remaining) : null
}

/**
 * The SEK a payment of `amount` clears off a document that owes `remaining` in
 * its own currency: all of what the ledger carries on a full settlement, so no
 * öre is stranded, its share on a part payment. Without a ledger figure, the
 * amount at the booking rate.
 */
export function clearedSek(opts: { amount: number; remaining: number; carried: number | null; rate: number }): number {
  const { amount, remaining, carried, rate } = opts
  if (carried === null) return sekOfForeign(amount, rate)
  if (amount >= remaining - ORE_TOLERANCE) return roundOre(carried)
  return roundOre((carried * amount) / remaining)
}

/**
 * clearedSek read backwards: how much of a document that owes `remaining` in its
 * own currency a figure of `sek` off the ledger pays. The whole remainder when it
 * is what the ledger carries, its share of that otherwise: at the rate, the öre
 * between the two reads as an overpayment or leaves a cent open on a paid invoice.
 */
export function paidOfClearedSek(opts: { sek: number; remaining: number; carried: number | null; rate: number }): number {
  const { sek, remaining, carried, rate } = opts
  if (carried === null) return roundOre(sek / rate)
  if (equalOre(sek, carried)) return remaining
  return roundOre((sek * remaining) / carried)
}

/**
 * The bank leg and the kursdifferens of a settlement that clears `cleared`, when
 * the caller states what moved as `difference` from the rate's figure: a caller
 * cannot read the ledger, so that figure plus the difference is what the bank
 * took whatever the ledger carries, and the gap to what is cleared is 3960/7960's,
 * never the bank's. With nothing stated the debt was paid as it stands.
 */
export function statedSettlement(opts: { cleared: number; sekAtRate: number; difference?: number }): {
  bankSek: number
  gainSek: number
} {
  const { cleared, sekAtRate, difference } = opts
  const bankSek = roundOre(difference === undefined ? cleared : sekAtRate + difference)
  return { bankSek, gainSek: roundOre(bankSek - cleared) }
}

/** How many invoice ids one invoice_issue_receivable_sek call carries. */
const ISSUE_RECEIVABLE_BATCH = 200

/** One row of invoice_issue_receivable_sek: the figure and the invoice facts it is compared with. */
interface IssueReceivableRow {
  invoice_id: string
  sek: number | string
  currency: string | null
  total: number | string | null
  deduction_total: number | string | null
}

/** invoice_issue_receivable_sek over the ids, in batches. Throws on a read error. */
async function readIssueReceivables(
  supabase: Pick<SupabaseClient, 'rpc'>,
  companyId: string,
  invoiceIds: readonly string[],
): Promise<IssueReceivableRow[]> {
  const rows: IssueReceivableRow[] = []
  for (const batch of chunk([...new Set(invoiceIds)], ISSUE_RECEIVABLE_BATCH)) {
    const { data, error } = await supabase.rpc('invoice_issue_receivable_sek', {
      p_company_id: companyId,
      p_invoice_ids: batch,
    })
    if (error) throw dbError(error, 'issue receivable')
    rows.push(...((data ?? []) as IssueReceivableRow[]))
  }
  return rows
}

/**
 * What each invoice's own issue verifikat put on 151x (1513, Skatteverket's
 * ROT/RUT share, excluded), keyed by invoice id: public.invoice_issue_receivable_sek
 * (crm#2283), the issue followed through a storno to its correction. An
 * invoice without a live issue verifikat is absent. Throws on a read error.
 */
export async function fetchIssueReceivableSek(
  supabase: Pick<SupabaseClient, 'rpc'>,
  companyId: string,
  invoiceIds: readonly string[],
): Promise<Map<string, number>> {
  const rows = await readIssueReceivables(supabase, companyId, invoiceIds)
  return new Map(rows.map((row) => [row.invoice_id, roundOre(Number(row.sek))]))
}

/**
 * The öresavrundning a SEK invoice's issue verifikat booked (crm#2283): the
 * customer's share at issue (the total less a ROT/RUT deduction; a later
 * reclaim is a verifikat of its own) against what that verifikat put on 151x,
 * by the band of bookedOreRounding. Below zero 151x carries more than the
 * share (a total rounded up), above less (rounded down), zero when the issue
 * booked no öre, the invoice is foreign or there is no issue verifikat. A
 * kreditfaktura's figures are negative, so its sign is the other way round.
 */
export function issueBookedOre(
  invoice: { currency?: string | null; total: number | string | null; deduction_total?: number | string | null },
  issueReceivableSek: number | null | undefined,
): number {
  if (!isKronorCurrency(invoice.currency) || issueReceivableSek == null) return 0
  const share = invoiceCustomerShare({ total: Number(invoice.total) || 0, deduction_total: Number(invoice.deduction_total) || 0 })
  return bookedOreRounding(share, issueReceivableSek)
}

/**
 * Whether a kreditfaktura of the invoice `originalId` books the
 * öresavrundning (buildCreditNoteLines' options.oreRounding): when the
 * original's own issue verifikat booked its öre, the credit mirrors it so the
 * pair nets to zero on 1510 and 3740. An original issued without one (before
 * crm#2283, or imported that way) is credited without, as before. One read:
 * the function answers the original's facts beside its figure. Throws on a
 * read error.
 */
export async function creditMirrorsIssueOre(
  supabase: Pick<SupabaseClient, 'rpc'>,
  companyId: string,
  originalId: string,
): Promise<boolean> {
  const [original] = await readIssueReceivables(supabase, companyId, [originalId])
  return original ? issueBookedOre(original, roundOre(Number(original.sek))) !== 0 : false
}
