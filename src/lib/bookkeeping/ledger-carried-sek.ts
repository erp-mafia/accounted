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
import type { CompanySettings } from '@/types'
import { isKronorCurrency, sekOfForeign } from '@/lib/bookkeeping/currency-utils'
import { bookedOreRounding } from '@/lib/bookkeeping/ore-rounding'
import { hasOreToRound } from '@/lib/bookkeeping/invoice-rounding'
import { issueOreRoundingDelta } from '@/lib/bookkeeping/invoice-lines'
import { dbError } from '@/lib/errors/db-error'
import { ORE_ROUNDING_ACCOUNT, ORE_TOLERANCE, equalOre, roundOre } from '@/lib/money'
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
 * remainder. Only a customer invoice with an issue verifikat and öre in its
 * remainder or its total costs a read (hasOreToRound): the total too, since a
 * part payment can leave whole kronor open while 151x still carries the
 * issue's öre, and the payment of those kronor would leave them there. A
 * supplier document costs none: its rounding is an item of the invoice,
 * inside its total (supplier-invoice-rounding-item.ts).
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
    const remaining = kronorRemaining(document)
    if (remaining === null) return null
    if (Number.isInteger(remaining) && !hasOreToRound({ currency: document.currency, total: document.total ?? remaining })) return null
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

/** How many invoice ids one invoice_issue_receivable_sek call carries; the batches are read one after another. */
const ISSUE_RECEIVABLE_BATCH = 200

/** One row of invoice_issue_receivable_sek: what the issue put on 151x and the invoice facts it is compared with. */
interface IssueReceivableRow {
  invoice_id: string
  sek: number | string
  currency: string | null
  total: number | string | null
  deduction_total: number | string | null
  payments?: Array<{
    id: string
    journal_entry_id: string | null
    amount: number | string | null
    voucher_before?: number | string | null
  }> | null
}

/**
 * The öresavrundning a SEK document's own issue verifikat booked: what that
 * verifikat put on 151x (1513 aside) beyond its total, when the gap is inside
 * the öre band (bookedOreRounding).
 *
 *   > 0  1510 carries more than the total: rounded up (999,75 issued as 1 000)
 *   < 0  1510 carries less: rounded down (1 000,40 as 1 000), or a
 *        kreditfaktura that mirrored a rounding up (-999,75 as -1 000)
 *   0    the exact total (every document issued before the issue verifikat
 *        booked the öre), a foreign document, no issue verifikat, a gap of a
 *        krona or more, which is never rounding, or a ROT/RUT document
 *
 * A ROT/RUT document reads 0 whatever its verifikat booked: its issue keeps
 * the exact total (issueOreRoundingDelta), and a refused deduction moves part
 * of 1513 onto 1510 in a verifikat of its own, which neither the settlement
 * doors' read of what 1510 carries nor the reskontra's open share follows. So
 * such a document reads as it did before the issue booked the öre.
 */
export function issueBookedOre(
  document: { currency?: string | null; total: number | string | null; deduction_total?: number | string | null },
  issueReceivableSek: number | null | undefined,
): number {
  if (!isKronorCurrency(document.currency) || issueReceivableSek == null) return 0
  if (Math.abs(Number(document.deduction_total) || 0) > 0) return 0
  const booked = bookedOreRounding(Number(document.total) || 0, issueReceivableSek)
  return booked === 0 ? 0 : -booked
}

/** What a document's issue verifikat booked of the öre, with the facts a credit link is read against. */
export interface IssueBookedFacts {
  /** issueBookedOre: never 0 in a fetchIssueBookedFacts answer. */
  ore: number
  /** The document's total: the customer's share, as a ROT/RUT document never books öre. */
  total: number
  /**
   * Its payment rows, oldest first: the verifikat each names, the amount it
   * paid, and what the rows made before it on that verifikat took of it.
   */
  payments: Array<{ id: string; journal_entry_id: string | null; amount: number; voucher_before: number }>
}

/**
 * The öre each document's own issue verifikat booked (issueBookedOre), with
 * its total and its payment rows, keyed by invoice id, read through
 * public.invoice_issue_receivable_sek: the issue verifikat followed through a
 * storno to its correction, 151x without 1513. Documents whose issue booked
 * no öre, or that have no live issue verifikat, are absent. Works with the
 * browser client (RLS) and the server's. Throws on a read error.
 */
export async function fetchIssueBookedFacts(
  supabase: Pick<SupabaseClient, 'rpc'>,
  companyId: string,
  invoiceIds: readonly string[],
): Promise<Map<string, IssueBookedFacts>> {
  const out = new Map<string, IssueBookedFacts>()
  for (const batch of chunk([...new Set(invoiceIds)], ISSUE_RECEIVABLE_BATCH)) {
    const { data, error } = await supabase.rpc('invoice_issue_receivable_sek', {
      p_company_id: companyId,
      p_invoice_ids: batch,
    })
    if (error) throw dbError(error, 'issue receivable')
    for (const row of (Array.isArray(data) ? data : []) as IssueReceivableRow[]) {
      const ore = issueBookedOre(row, roundOre(Number(row.sek)))
      if (ore === 0) continue
      out.set(row.invoice_id, {
        ore,
        total: roundOre(Number(row.total) || 0),
        payments: (row.payments ?? []).map((payment) => ({
          id: payment.id,
          journal_entry_id: payment.journal_entry_id,
          amount: roundOre(Number(payment.amount) || 0),
          voucher_before: roundOre(Number(payment.voucher_before) || 0),
        })),
      })
    }
  }
  return out
}

/** fetchIssueBookedFacts, the öre alone. */
export async function fetchIssueBookedOre(
  supabase: Pick<SupabaseClient, 'rpc'>,
  companyId: string,
  invoiceIds: readonly string[],
): Promise<Map<string, number>> {
  const facts = await fetchIssueBookedFacts(supabase, companyId, invoiceIds)
  return new Map([...facts].map(([id, fact]) => [id, fact.ore]))
}

/**
 * The öresavrundning a kreditfaktura mirrors (buildCreditNoteLines'
 * { mirror }): exactly what its original's own issue verifikat booked on
 * 1510 (issueBookedOre: 0,25 for 999,75 booked at 1 000, -0,50 for 1 000,50
 * booked at 1 000), so the pair nets to zero on 1510 and 3740. Only for a
 * full credit, whose total is the original's negated: a credit of part of
 * the original cannot say which part of the öre is its own, so it reverses
 * its exact amounts and the öre stays with the original until its settlement
 * clears what 1510 carries. 0 for an original booked at the exact total
 * (issued before the issue verifikat booked the öre, or imported that way):
 * the credit reverses the exact total, as before. Read from the ledger, never
 * from a flag or the company setting of today. A credit without öre in its
 * total costs no read. Throws on a read error.
 */
export async function creditNoteIssueOre(
  supabase: Pick<SupabaseClient, 'rpc'>,
  companyId: string,
  credit: { credited_invoice_id?: string | null; currency?: string | null; total?: number | string | null },
): Promise<number> {
  const originalId = credit.credited_invoice_id
  if (!originalId || !hasOreToRound(credit)) return 0
  const original = (await fetchIssueBookedFacts(supabase, companyId, [originalId])).get(originalId)
  if (!original || !equalOre(-(Number(credit.total) || 0), original.total)) return 0
  return original.ore
}

/**
 * The company has switched 3740 off in its kontoplan: an issue then books the
 * exact total (the engine refuses an inactive account, and the invoice must
 * still issue). A 3740 not yet in the kontoplan is not off: the engine seeds
 * it (standard BAS). The one rule the issue door and the previews read, from
 * the account row (`is_active`).
 */
export function oreRoundingAccountOff(account: { is_active?: boolean | null } | null | undefined): boolean {
  return account?.is_active === false
}

/** oreRoundingAccountOff, read from the company's kontoplan. Throws on a read error. */
export async function fetchOreRoundingAccountOff(
  supabase: Pick<SupabaseClient, 'from'>,
  companyId: string,
): Promise<boolean> {
  const { data, error } = await supabase
    .from('chart_of_accounts')
    .select('is_active')
    .eq('company_id', companyId)
    .eq('account_number', ORE_ROUNDING_ACCOUNT)
    .maybeSingle()
  if (error) throw dbError(error, 'öresavrundning account')
  return oreRoundingAccountOff(data as { is_active?: boolean | null } | null)
}

/**
 * creditNoteIssueOre for a preview of a credit of `original` whose total is
 * `creditTotal` (negative). When the credit books the original first (a
 * deferred original never booked, creditBooksOriginalFirst), the original's
 * verifikat does not exist yet: it will round as its own issue does
 * (issueOreRoundingDelta with the invoice's choice, else the company
 * setting, and none when 3740 is switched off: oreRoundingAccountOff), and a
 * full credit mirrors that. Otherwise the ledger answers. A failed read
 * previews no rounding row; the credit decides again when it books.
 */
export async function creditPreviewIssueOre(
  supabase: Pick<SupabaseClient, 'rpc' | 'from'>,
  companyId: string,
  original: {
    id: string
    currency: string
    total: number
    deduction_total?: number | null
    ore_rounding?: boolean | null
    is_self_billed?: boolean | null
  },
  creditTotal: number,
  booksOriginalFirst: boolean,
  company: Pick<CompanySettings, 'ore_rounding'> | null,
): Promise<number> {
  if (booksOriginalFirst) {
    if (!equalOre(-creditTotal, original.total)) return 0
    const exact = roundOre(original.total - Math.max(0, Number(original.deduction_total) || 0))
    const ore = issueOreRoundingDelta(original, exact, { company })
    if (ore === 0) return 0
    try {
      return (await fetchOreRoundingAccountOff(supabase, companyId)) ? 0 : ore
    } catch {
      // A preview only: the original's issue reads the account again when it
      // books, and refuses on a failed read there.
      return 0
    }
  }
  try {
    return await creditNoteIssueOre(supabase, companyId, {
      credited_invoice_id: original.id,
      currency: original.currency,
      total: creditTotal,
    })
  } catch {
    // A preview only: the credit door reads the ledger again when it books,
    // and refuses on a failed read there.
    return 0
  }
}
