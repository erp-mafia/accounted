import type { SupabaseClient } from '@supabase/supabase-js'
import { checkPeriodLock } from '@/lib/api/v1/check-period-lock'
import { PINNED_JURISDICTION, resolveAccountRole } from '@/lib/bookkeeping/account-roles'
import { isLedgerCurrency } from '@/lib/bookkeeping/currency-utils'
import { fetchEntryLines, type EntryLinesQuery } from '@/lib/bookkeeping/entry-lines'
import { findFiscalPeriod } from '@/lib/bookkeeping/engine'
import { formatVoucher } from '@/lib/bookkeeping/voucher-series-resolver'
import { coerceDimensionsBag } from '@/lib/bookkeeping/dimension-resolver'
import { invoicePaymentBusinessEvent } from '@/lib/bookkeeping/invoice-business-events'
import { isBookkeepingError } from '@/lib/bookkeeping/errors'
import { cancelOrphanedPaymentEntry } from '@/lib/bookkeeping/cancel-orphaned-entry'
import { getErrorEntry } from '@/lib/errors/structured-errors'
import { ORE_TOLERANCE, roundOre, sumOre } from '@/lib/money'
import { lineBalance } from '@/lib/bookkeeping/line-balance'
import { linkBasisColumnsFor, type LinkBasisInput } from '@/lib/links/stamp'
import { postingPort } from '@/lib/posting/port'
import { recordInvoicePaymentRow, removeInvoicePaymentRow } from '@/lib/invoices/invoice-payment-row'
import { paidAtFromDate } from '@/lib/invoices/paid-at'
import { futurePaymentDateRefusal, type FuturePaymentDateRefusal } from '@/lib/invoices/payment-date'
import {
  planCreditNoteRefund,
  RECEIVABLE_ACCOUNT,
  refundLedgerAmount,
  REFUNDABLE_CREDIT_NOTE_STATUSES,
  type CreditNoteRefundPlan,
} from '@/lib/invoices/credit-note-refund-plan'
import { readCreditNoteBookedOre } from '@/lib/invoices/credit-note-booked-ore'
import type { CreateJournalEntryInput, CreateJournalEntryLineInput, Invoice } from '@/types'

/**
 * Record the refund of a kreditfaktura: the company pays the credit back to
 * its customer (follow-up of crm#1435). The doors that mark an invoice paid
 * (dashboard, v1 and the agent's gnubok_mark_invoice_as_paid) call this when
 * the document is a credit note, so a refund is reached where a payment is.
 *
 * The verifikat is the mirror of an invoice payment: Dr 1510 Kundfordringar
 * (the credit the credit note's own verifikat left there) / Cr the account
 * the money left from, in both accounting methods. When that verifikat booked
 * the öresavrundning (Cr 1510 1 000 / Dr 3740 0,25 on a credit of 999,75),
 * the refund that settles the credit pays back what 1510 carries, 1 000, and
 * the credit note still records 999,75 settled (refundLedgerAmount), so the
 * ledger and the kundreskontra both reach zero. Under kontantmetoden the
 * credit note of a paid original already reversed the revenue and the
 * utgående moms in its own period (creditNoteNeedsJournalEntry), so the
 * refund moves money only and books no moms (swedish-invoice-compliance:
 * the seller reduces utgående moms in the credit note's period, ML 2023:200
 * 17 kap 22-23 §§; BFL 5 kap: the refund is an affärshändelse of its own with
 * its own verifikation).
 *
 * Order and compensation follow settleInvoicePayment: the verifikat through
 * the posting port (the engine refuses a locked period), then the
 * invoice_payments row, then a compare-and-set on the credit note's
 * paid_amount. A failed row or a lost race cancels the just-posted voucher
 * and removes the row, so the ledger and the reskontra never disagree.
 */

/** The credit note as the doors read it (select '*' with the customer's name). */
export interface RefundCreditNoteRow {
  id: string
  invoice_number: string | null
  customer_id: Invoice['customer_id']
  credited_invoice_id: string | null
  status: string
  invoice_date?: string | null
  total: number
  paid_amount?: number | null
  currency: Invoice['currency']
  exchange_rate: Invoice['exchange_rate']
  vat_amount: Invoice['vat_amount']
  vat_amount_sek: Invoice['vat_amount_sek']
  vat_treatment: Invoice['vat_treatment']
  journal_entry_id?: string | null
  deduction_total?: number | null
  default_dimensions?: unknown
  /** The account the customer paid to (the original's payee): the refund's default. */
  payment_cash_account_id?: string | null
  customer?: { name?: string | null } | null
}

export interface RefundCustomLine {
  account_number: string
  debit_amount: number
  credit_amount: number
  line_description?: string
  dimensions?: Record<string, string>
}

export interface RefundCreditNoteParams {
  creditNote: RefundCreditNoteRow
  /** The refund's date (YYYY-MM-DD): the verifikat's date. */
  refundDate: string
  /** Where the money left from (Cr). Ignored when customLines carry their own. */
  settlementAccountNumber: string
  /**
   * The person's own rows (v1, or a caller's): debit 1510 for at most what
   * the refund takes off 1510, credit the bank. Absent: the whole amount
   * owed, Dr 1510 / Cr settlementAccountNumber, at what 1510 carries for the
   * credit when its verifikat booked an öresavrundning.
   */
  customLines?: RefundCustomLine[]
  /** Skip the already-booked guard after the person confirmed it is another refund. */
  force?: boolean
  /** Plan only: every check, nothing written. */
  dryRun?: boolean
}

/** A posted verifikat that already looks like this refund (CREDIT_NOTE_REFUND_LIKELY_BOOKED). */
export interface BookedRefundCandidate {
  journal_entry_id: string
  entry_date: string
  voucher: string | null
  source_type: string
}

export type RefundCreditNoteResult =
  | {
      ok: true
      dryRun: boolean
      /** Kronor refunded by this call: what the verifikat takes off 1510. */
      amount: number
      /** Still owed after this call (0 once refunded in full). */
      owedAfter: number
      lines: CreateJournalEntryLineInput[]
      journalEntryId: string | null
      /** The credit note's paid_amount after the refund (negative, like its total). */
      paidAmount: number
      /** Set when this refund settles the credit note in full. */
      refundedAt: string | null
    }
  | Extract<CreditNoteRefundPlan, { ok: false }>
  | { ok: false; code: 'CREDIT_NOTE_REFUND_LIKELY_BOOKED'; details: { candidates: BookedRefundCandidate[]; amount: number } }
  | { ok: false; code: 'CREDIT_NOTE_REFUND_EXCEEDS_OWED'; details: { owed: number; amount: number } }
  | { ok: false; code: 'CREDIT_NOTE_REFUND_ORE_LEFT'; details: { owed: number; amount: number } }
  | { ok: false; code: 'CREDIT_NOTE_REFUND_LINES_INVALID'; details: { reason: 'debit_not_receivable' | 'credit_on_receivable' } }
  | { ok: false; code: 'INVOICE_PAID_LINES_UNBALANCED'; details: { total_debit: number; total_credit: number } }
  | { ok: false; code: 'INVOICE_PAID_NO_FISCAL_PERIOD'; details: { payment_date: string } }
  | { ok: false; code: 'PERIOD_LOCKED'; details: { payment_date: string; reason?: string } }
  | ({ ok: false } & FuturePaymentDateRefusal)
  | { ok: false; code: 'INVOICE_PAID_BOOK_FAILED'; details: Record<string, unknown> }
  | { ok: false; code: 'CREDIT_NOTE_REFUND_RACE' }
  | { ok: false; code: 'BOOKKEEPING_ERROR'; error: unknown }
  | { ok: false; code: 'DB_ERROR'; error: unknown }

/** The receivable the credit note's verifikat credits (buildCreditNoteLines): 1510. */
export { RECEIVABLE_ACCOUNT }
/** Skatteverket's share of a ROT/RUT invoice: never money paid out to the customer. */
const ROT_RUT_RECEIVABLE_ACCOUNT = resolveAccountRole(PINNED_JURISDICTION, 'rot_rut_receivable')

/** A person's statement that the refund was paid. */
const REFUND_LINK_BASIS: LinkBasisInput = { basis: 'user_created' }

/**
 * The credit the credit note's verifikat already paid other invoices with:
 * payment rows naming that verifikat on another invoice (a set-off,
 * link_invoice_to_voucher). Kronor; rows in another currency cannot be read
 * as kronor here and refuse instead of guessing.
 */
async function readCreditUsed(
  supabase: SupabaseClient,
  companyId: string,
  creditNote: RefundCreditNoteRow,
): Promise<{ ok: true; used: number } | { ok: false; error: unknown } | { ok: false; unreadable: true }> {
  if (!creditNote.journal_entry_id) return { ok: true, used: 0 }
  const { data, error } = await supabase
    .from('invoice_payments')
    .select('invoice_id, amount, currency')
    .eq('company_id', companyId)
    .eq('journal_entry_id', creditNote.journal_entry_id)
    .neq('invoice_id', creditNote.id)
  if (error) return { ok: false, error }
  const rows = (data ?? []) as Array<{ amount: number | string | null; currency: string | null }>
  if (rows.some((row) => !isLedgerCurrency(row.currency))) return { ok: false, unreadable: true }
  return { ok: true, used: sumOre(rows.map((row) => Math.abs(Number(row.amount) || 0))) }
}

/**
 * Posted verifikat a person booked by hand (a manual verifikat, or the
 * outgoing bank row categorised to 1510) that debit 1510 with exactly this
 * amount, dated from a week before the credit note, and that no payment row
 * claims: the refund most likely booked already. Read-only; a failed read
 * finds nothing (the guard is advisory, never a reason to refuse a refund).
 */
async function findBookedRefundCandidates(
  supabase: SupabaseClient,
  companyId: string,
  amount: number,
  since: string,
): Promise<BookedRefundCandidate[]> {
  type Row = {
    journal_entry_id: string
    journal_entries:
      | { entry_date: string; source_type: string; voucher_series: string | null; voucher_number: number | null }
      | undefined
  }
  // Entry first (lib/bookkeeping/entry-lines.ts): the company's hand-booked
  // verifikat since the window opened, then their 1510 debits of the amount.
  // A journal_entry_lines read filtered through a journal_entries!inner embed
  // is planned from the line side: every tenant's 1510 lines, one entry probe
  // each, and a timeout here silently switched the guard off.
  let rows: Row[]
  try {
    rows = await fetchEntryLines<Row>({
      supabase,
      entryColumns: 'id, entry_date, source_type, voucher_series, voucher_number',
      lineColumns: 'journal_entry_id',
      filterEntries: (q: EntryLinesQuery) =>
        q
          .eq('company_id', companyId)
          .eq('status', 'posted')
          .in('source_type', ['manual', 'bank_transaction'])
          .gte('entry_date', since),
      filterLines: (q: EntryLinesQuery) =>
        q
          .eq('account_number', RECEIVABLE_ACCOUNT)
          .gte('debit_amount', roundOre(amount - ORE_TOLERANCE))
          .lte('debit_amount', roundOre(amount + ORE_TOLERANCE)),
    })
  } catch {
    // Advisory guard, as documented above: a failed read finds nothing and
    // never refuses a refund, exactly as the error branch here always did.
    return []
  }
  if (rows.length === 0) return []
  // Ten lines are enough to name (the read used to stop there); the guard
  // only asks "already booked?".
  rows = rows.slice(0, 10)

  const entryIds = [...new Set(rows.map((row) => row.journal_entry_id))]
  const { data: claimed, error: claimedError } = await supabase
    .from('invoice_payments')
    .select('journal_entry_id')
    .eq('company_id', companyId)
    .in('journal_entry_id', entryIds)
  if (claimedError) return []
  const claimedIds = new Set(((claimed ?? []) as Array<{ journal_entry_id: string | null }>).map((row) => row.journal_entry_id))

  const seen = new Set<string>()
  const candidates: BookedRefundCandidate[] = []
  for (const row of rows) {
    if (claimedIds.has(row.journal_entry_id) || seen.has(row.journal_entry_id)) continue
    seen.add(row.journal_entry_id)
    const entry = row.journal_entries
    if (!entry) continue
    candidates.push({
      journal_entry_id: row.journal_entry_id,
      entry_date: entry.entry_date,
      voucher: entry.voucher_number ? formatVoucher(entry) : null,
      source_type: entry.source_type,
    })
  }
  return candidates
}

/** A week before the credit note's date: a refund paid out just before the kreditfaktura was written still counts. */
function guardWindowStart(creditNoteDate: string | null | undefined, refundDate: string): string {
  const base = creditNoteDate && creditNoteDate < refundDate ? creditNoteDate : refundDate
  const day = new Date(`${base}T00:00:00Z`)
  day.setUTCDate(day.getUTCDate() - 7)
  return day.toISOString().slice(0, 10)
}

/**
 * The refund's lines and amount: the person's own rows checked against the
 * refund's shape, or the generated pair for the whole amount owed.
 */
export function buildCreditNoteRefundLines(
  creditNote: Pick<RefundCreditNoteRow, 'invoice_number' | 'customer' | 'default_dimensions'>,
  owed: number,
  settlementAccountNumber: string,
  customLines?: RefundCustomLine[],
):
  | { ok: true; amount: number; description: string; lines: CreateJournalEntryLineInput[] }
  | Extract<
      RefundCreditNoteResult,
      { code: 'CREDIT_NOTE_REFUND_EXCEEDS_OWED' | 'CREDIT_NOTE_REFUND_LINES_INVALID' | 'INVOICE_PAID_LINES_UNBALANCED' }
    > {
  const name = creditNote.customer?.name
  const description = name
    ? `Återbetalning kreditfaktura ${creditNote.invoice_number ?? ''}, ${name}`
    : `Återbetalning kreditfaktura ${creditNote.invoice_number ?? ''}`

  if (!customLines) {
    const dimensions = coerceDimensionsBag(creditNote.default_dimensions)
    const tagged = dimensions ? { dimensions } : {}
    return {
      ok: true,
      amount: owed,
      description,
      lines: [
        { account_number: RECEIVABLE_ACCOUNT, debit_amount: owed, credit_amount: 0, line_description: description, ...tagged },
        { account_number: settlementAccountNumber, debit_amount: 0, credit_amount: owed, line_description: description, ...tagged },
      ],
    }
  }

  const { balanced, totalDebit, totalCredit } = lineBalance(customLines)
  if (!balanced) {
    return { ok: false, code: 'INVOICE_PAID_LINES_UNBALANCED', details: { total_debit: totalDebit, total_credit: totalCredit } }
  }
  // The refund clears the customer's credit on 1510 and nothing else: a
  // debit elsewhere would book a cost or a moms change the credit note
  // already made, and a credit on a receivable would not be money paid out.
  if (customLines.some((line) => line.debit_amount > 0 && line.account_number !== RECEIVABLE_ACCOUNT)) {
    return { ok: false, code: 'CREDIT_NOTE_REFUND_LINES_INVALID', details: { reason: 'debit_not_receivable' } }
  }
  const receivables = new Set([RECEIVABLE_ACCOUNT, ROT_RUT_RECEIVABLE_ACCOUNT])
  if (customLines.some((line) => line.credit_amount > 0 && receivables.has(line.account_number))) {
    return { ok: false, code: 'CREDIT_NOTE_REFUND_LINES_INVALID', details: { reason: 'credit_on_receivable' } }
  }
  if (totalDebit > owed + ORE_TOLERANCE) {
    return { ok: false, code: 'CREDIT_NOTE_REFUND_EXCEEDS_OWED', details: { owed, amount: totalDebit } }
  }
  return {
    ok: true,
    amount: totalDebit,
    description,
    lines: customLines.map((line) => ({
      account_number: line.account_number,
      debit_amount: line.debit_amount,
      credit_amount: line.credit_amount,
      line_description: line.line_description || description,
      ...(line.dimensions ? { dimensions: line.dimensions } : {}),
    })),
  }
}

export async function refundCreditNote(
  supabase: SupabaseClient,
  companyId: string,
  userId: string,
  params: RefundCreditNoteParams,
): Promise<RefundCreditNoteResult> {
  const { creditNote, refundDate, settlementAccountNumber, customLines, force, dryRun } = params

  const futureDate = futurePaymentDateRefusal(refundDate)
  if (futureDate) return { ok: false, ...futureDate }

  let original: { total: number; paid_amount: number | null } | null = null
  if (creditNote.credited_invoice_id) {
    const { data, error } = await supabase
      .from('invoices')
      .select('id, total, paid_amount')
      .eq('id', creditNote.credited_invoice_id)
      .eq('company_id', companyId)
      .maybeSingle()
    if (error) return { ok: false, code: 'DB_ERROR', error }
    original = (data as { total: number; paid_amount: number | null } | null) ?? null
  }

  const creditUsed = await readCreditUsed(supabase, companyId, creditNote)
  if (!creditUsed.ok) {
    if ('error' in creditUsed) return { ok: false, code: 'DB_ERROR', error: creditUsed.error }
    return { ok: false, code: 'CREDIT_NOTE_REFUND_UNSUPPORTED', details: { reason: 'foreign_currency' } }
  }

  const plan = planCreditNoteRefund(creditNote, original, creditUsed.used)
  if (!plan.ok) return plan

  let bookedOre: number
  try {
    bookedOre = await readCreditNoteBookedOre(supabase, companyId, creditNote)
  } catch (error) {
    return { ok: false, code: 'DB_ERROR', error }
  }
  // The verifikat takes off 1510 what it carries for the credit; the credit
  // note records the debt settled, so the kundreskontra nets it to zero
  // exactly when 1510 does.
  const ledgerOwed = refundLedgerAmount(plan, bookedOre)
  if (ledgerOwed <= ORE_TOLERANCE) {
    return { ok: false, code: 'CREDIT_NOTE_REFUND_NOTHING_OWED', details: { refunded: plan.refunded, credit_used: creditUsed.used } }
  }

  const built = buildCreditNoteRefundLines(creditNote, ledgerOwed, settlementAccountNumber, customLines)
  if (!built.ok) return built
  const { amount, description, lines } = built
  // Rows that pay back the whole credit at the kundreskontra's figure (999,75
  // where 1510 carries 1 000), or anything between the two, would close the
  // credit note with öre left on 1510: the whole refund is what 1510 carries.
  if (ledgerOwed > plan.owed + ORE_TOLERANCE && amount >= plan.owed - ORE_TOLERANCE && amount < ledgerOwed - ORE_TOLERANCE) {
    return { ok: false, code: 'CREDIT_NOTE_REFUND_ORE_LEFT', details: { owed: ledgerOwed, amount } }
  }
  // What the credit note records settled: its whole open credit for a refund
  // of what 1510 carries, else the refund's own kronor (always less than owed).
  const settled = amount >= ledgerOwed - ORE_TOLERANCE ? plan.owed : amount

  if (!force) {
    const since = guardWindowStart(creditNote.invoice_date, refundDate)
    const candidates = await findBookedRefundCandidates(supabase, companyId, amount, since)
    if (candidates.length > 0) {
      return { ok: false, code: 'CREDIT_NOTE_REFUND_LIKELY_BOOKED', details: { candidates, amount } }
    }
  }

  const priorPaid = roundOre(Number(creditNote.paid_amount ?? 0))
  const paidAmount = roundOre(priorPaid - settled)
  const owedAfter = roundOre(plan.owed - settled)
  const refundedAt = owedAfter <= ORE_TOLERANCE ? paidAtFromDate(refundDate) : null

  // Refused before anything is written, the dry run included: the engine's
  // trigger would refuse the insert, but only after a number was drawn.
  const lock = await checkPeriodLock(supabase, companyId, refundDate)
  if (lock.locked) {
    return { ok: false, code: 'PERIOD_LOCKED', details: { payment_date: refundDate, reason: lock.reason } }
  }
  const fiscalPeriodId = await findFiscalPeriod(supabase, companyId, refundDate)
  if (!fiscalPeriodId) {
    return { ok: false, code: 'INVOICE_PAID_NO_FISCAL_PERIOD', details: { payment_date: refundDate } }
  }

  if (dryRun) {
    return { ok: true, dryRun: true, amount, owedAfter, lines, journalEntryId: null, paidAmount, refundedAt }
  }

  const input: CreateJournalEntryInput = {
    fiscal_period_id: fiscalPeriodId,
    entry_date: refundDate,
    description,
    // A payment voucher on the credit note: its storno restores the credit
    // note's paid_amount (syncInvoiceStatusFromPaymentEntry), as for any
    // invoice payment.
    source_type: 'invoice_paid',
    source_id: creditNote.id,
    lines,
  }

  let journalEntryId: string | null = null
  try {
    const entry = await postingPort.postJournalEntry({
      supabase,
      companyId,
      userId,
      event: () =>
        invoicePaymentBusinessEvent(
          creditNote,
          input,
          { paymentAccount: customLines ? null : settlementAccountNumber, generated: !customLines, bankLine: false },
          { linkBasis: linkBasisColumnsFor(REFUND_LINK_BASIS), settledAmount: settled },
        ),
      input,
    })
    journalEntryId = entry?.id ?? null
  } catch (err) {
    if (isBookkeepingError(err)) return { ok: false, code: 'BOOKKEEPING_ERROR', error: err }
    return {
      ok: false,
      code: 'INVOICE_PAID_BOOK_FAILED',
      details: { reason: err instanceof Error ? err.message : 'unknown' },
    }
  }
  if (!journalEntryId) {
    return { ok: false, code: 'INVOICE_PAID_BOOK_FAILED', details: { reason: 'no_journal_entry_created' } }
  }

  const recorded = await recordInvoicePaymentRow(supabase, {
    userId,
    companyId,
    invoice: { id: creditNote.id, currency: creditNote.currency, exchange_rate: creditNote.exchange_rate, paid_amount: priorPaid },
    paymentDate: refundDate,
    newPaidAmount: paidAmount,
    journalEntryId,
    source: 'manual',
    linkBasis: REFUND_LINK_BASIS,
  })
  if (!recorded.ok) {
    await cancelOrphanedPaymentEntry(
      supabase,
      companyId,
      userId,
      journalEntryId,
      'Automatiskt makulerad: återbetalningsraden kunde inte sparas efter bokförd återbetalning',
    )
    return {
      ok: false,
      code: 'INVOICE_PAID_BOOK_FAILED',
      details: { reason: 'payment_row_insert_failed', error: recorded.error },
    }
  }

  // Compare-and-set on the paid_amount this refund was planned from: a
  // concurrent refund moved it, and this one would refund the credit twice.
  // Literal filters so the schema guard reads the columns.
  let cas = supabase
    .from('invoices')
    .update({ paid_amount: paidAmount, paid_at: refundedAt })
    .eq('id', creditNote.id)
    .eq('company_id', companyId)
    .in('status', [...REFUNDABLE_CREDIT_NOTE_STATUSES])
  cas =
    priorPaid === 0
      ? cas.or('paid_amount.is.null,and(paid_amount.gt.-0.005,paid_amount.lt.0.005)')
      : cas.gt('paid_amount', roundOre(priorPaid - ORE_TOLERANCE)).lt('paid_amount', roundOre(priorPaid + ORE_TOLERANCE))
  const { data: updated, error: updateError } = await cas.select('id')

  if (updateError || !updated || updated.length === 0) {
    await cancelOrphanedPaymentEntry(
      supabase,
      companyId,
      userId,
      journalEntryId,
      updateError
        ? 'Automatiskt makulerad: kreditfakturan kunde inte uppdateras efter bokförd återbetalning'
        : 'Automatiskt makulerad: dubbel återbetalning förhindrad av samtidighetsskydd',
    )
    await removeInvoicePaymentRow(supabase, companyId, recorded.id)
    return updateError ? { ok: false, code: 'DB_ERROR', error: updateError } : { ok: false, code: 'CREDIT_NOTE_REFUND_RACE' }
  }

  return { ok: true, dryRun: false, amount, owedAfter, lines, journalEntryId, paidAmount, refundedAt }
}

/** A refund refusal the agent doors relay: everything but the thrown errors. */
export type CodedRefundFailure = Exclude<
  Extract<RefundCreditNoteResult, { ok: false }>,
  { code: 'BOOKKEEPING_ERROR' | 'DB_ERROR' }
>

/**
 * A refusal as the agent doors (MCP staging and approval) relay it: the
 * registered English message plus what the details add, with its HTTP status.
 */
export function describeRefundFailure(failure: CodedRefundFailure): { code: string; message: string; status: number } {
  const entry = getErrorEntry(failure.code)
  const parts = [`${failure.code}.`, entry?.message_en]
  if ('details' in failure) {
    const details = failure.details as Record<string, unknown>
    if (typeof details.reason === 'string') parts.push(`Reason: ${details.reason}.`)
    if (typeof details.owed === 'number') parts.push(`Owed: ${details.owed} kr.`)
    if (Array.isArray(details.candidates)) {
      const vouchers = (details.candidates as BookedRefundCandidate[]).map((c) => c.voucher ?? c.journal_entry_id)
      parts.push(`Vouchers: ${vouchers.join(', ')}.`)
    }
  }
  return { code: failure.code, message: parts.filter(Boolean).join(' '), status: entry?.httpStatus ?? 409 }
}
