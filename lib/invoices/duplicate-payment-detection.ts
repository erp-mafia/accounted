/**
 * Detect a "soft duplicate" payment voucher for a bank transaction.
 *
 * Scenario: the user manually booked the receipt as a verifikation
 * (Dr 19xx / Cr 1510 or Cr 30xx) *outside* the match-invoice flow. The
 * invoice's status stays 'sent', no `invoice_payments` row exists, and the
 * matcher would happily propose a second payment voucher: double-booking
 * the bank receipt.
 *
 * Heuristic: a posted journal entry within a tight date window whose lines
 * debit a bank/cash account (BAS 19xx) for the same amount, and which is
 * not already linked to any transaction or invoice payment, is almost
 * certainly the manual booking. We surface it as a candidate; the API
 * refuses the match unless the caller passes `force: true`.
 *
 * Mirrors `findDuplicatePaymentCandidatesForInvoice` (which scans for the
 * reverse direction: unlinked transactions that look like a manually-marked
 * invoice payment).
 *
 * Units: the comparison happens in SEK. `resolveTransactionAmountSek` (shared
 * with the booking-side twin of this guard, deliberately one definition rather
 * than two that can drift) carries the full explanation of why the ledger side
 * is always SEK and why `journal_entry_lines.currency` must never be read as
 * evidence that a debit/credit figure is foreign.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { fetchEntryLines, type EntryLinesQuery } from '@/lib/bookkeeping/entry-lines'
import { resolveTransactionAmountSek } from '@/lib/transactions/booking-duplicate-detection'

/** ± days around the transaction date considered "the same payment". */
const DATE_WINDOW_DAYS = 7

/** BAS "kassa och bank" range. 1910-1919 = kassa, 1920-1949 = bank/giro. */
const BANK_ACCOUNT_LOW = 1910
const BANK_ACCOUNT_HIGH = 1949

export interface DuplicateVoucherCandidate {
  journal_entry_id: string
  voucher_label: string
  entry_date: string
  description: string | null
  /** The voucher leg's SEK debit. Never the bank line's own (possibly foreign) amount. */
  amount: number
  bank_account_number: string
  /**
   * How the candidate was selected. The `exact_amount_*` values mean the SEK
   * amounts really were compared and matched within 0.01; `date_window_only`
   * means the amount test never ran (the bank line has no SEK value, see
   * `amount_verified` below) and the candidate rests on date + bank account +
   * unlinked-ness alone. Renderers must never phrase a `date_window_only`
   * candidate as an amount match.
   */
  reason: 'exact_amount_same_date' | 'exact_amount_within_window' | 'date_window_only'
  /**
   * Whether the bank line's SEK value could be established and actually matched
   * the leg. False means the amounts were never compared and the candidate rests
   * on date + bank account alone: a "could not verify", not a confirmed
   * duplicate. Surfaced rather than swallowed because a silent pass here is what
   * mints a second verifikat for one affärshändelse (BFL 5 kap 1-2 §), and a
   * hard block would refuse a booking the software cannot actually judge.
   */
  amount_verified: boolean
  /**
   * Why the amounts could not be compared. Null whenever `amount_verified`.
   * `transaction_missing_sek_value`: a non-SEK bank line carrying neither
   * `amount_sek` nor `exchange_rate`.
   */
  unverified_reason: 'transaction_missing_sek_value' | null
}

interface DetectArgs {
  companyId: string
  transactionId: string
  transactionDate: string
  /** `transactions.amount`, denominated in `transactionCurrency`: NOT necessarily SEK. */
  transactionAmount: number
  /**
   * `transactions.currency`. Required, not optional, for the reason spelled out
   * on `TransactionAmountFields.currency`: an optional field silently reads as
   * SEK for any caller that projects a narrow column list, which switches this
   * guard off for precisely the FX rows it exists to catch. Null means SEK.
   */
  transactionCurrency: string | null
  /** `transactions.amount_sek`. */
  transactionAmountSek?: number | null
  /** `transactions.exchange_rate`. */
  transactionExchangeRate?: number | null
}

/**
 * Find the single most likely manual verifikation that already books this
 * bank transaction. Returns null when no candidate is found.
 *
 * Filters applied:
 *  - posted status (drafts cannot be a duplicate by definition)
 *  - entry date within ±DATE_WINDOW_DAYS of transaction.date
 *  - has a line that debits a BAS 19xx (kassa/bank) account for the same
 *    rounded amount (within 0.01 SEK), the bank line's SEK value against the
 *    leg's debit column, which is always SEK. When the bank line has no SEK
 *    value (a foreign row with no stored rate) the amount test is skipped and
 *    the candidate comes back with `amount_verified: false`: skipping is not a
 *    pass, it is an explicit "could not verify" the caller must surface.
 *  - not already linked from `transactions.journal_entry_id` (for any row)
 *  - not already referenced by `invoice_payments.journal_entry_id`
 *  - not the storno/correction entry for any prior original (source_type
 *    excluded: those are valid second-line vouchers, not duplicates)
 */
export async function detectDuplicatePaymentVoucher(
  supabase: SupabaseClient,
  args: DetectArgs,
): Promise<DuplicateVoucherCandidate | null> {
  const { companyId, transactionId, transactionDate, transactionAmount } = args
  if (Math.round(Math.abs(transactionAmount) * 100) === 0) return null

  // The bank line stated in SEK, or null when it cannot be: a non-SEK row with
  // neither amount_sek nor exchange_rate. Null disables the amount test below,
  // it does not short-circuit to "no duplicate".
  const targetSek = resolveTransactionAmountSek({
    amount: transactionAmount,
    currency: args.transactionCurrency,
    amount_sek: args.transactionAmountSek,
    exchange_rate: args.transactionExchangeRate,
  })

  const dateMs = new Date(transactionDate).getTime()
  if (Number.isNaN(dateMs)) return null
  const lowDate = new Date(dateMs - DATE_WINDOW_DAYS * 24 * 3600 * 1000)
    .toISOString()
    .split('T')[0]
  const highDate = new Date(dateMs + DATE_WINDOW_DAYS * 24 * 3600 * 1000)
    .toISOString()
    .split('T')[0]

  type LineRow = {
    account_number: string
    debit_amount: number | string
    journal_entry: {
      id: string
      entry_date: string
      description: string | null
      voucher_series: string | null
      voucher_number: number | null
      status: string
      source_type: string | null
    }
  }

  // Find bank-account debits within the window. The scope filters live on
  // journal_entries and the query is driven from there: the old
  // `journal_entries!inner` embed made PostgREST compile a correlated LATERAL
  // join that walked the ENTIRE journal_entry_lines table across all tenants
  // (see lib/bookkeeping/entry-lines.ts). RLS handles isolation; the
  // company_id filter is defense-in-depth. The old `.limit(50)` is gone with
  // the embed: it capped a ±7-day window of one company's bank legs and could
  // hide the real duplicate behind unrelated ones.
  let lines: LineRow[]
  try {
    lines = await fetchEntryLines<LineRow>({
      supabase,
      entryColumns: 'id, entry_date, description, voucher_series, voucher_number, status, source_type, company_id',
      lineColumns: 'account_number, debit_amount',
      filterEntries: (q: EntryLinesQuery) =>
        q
          .eq('company_id', companyId)
          .eq('status', 'posted')
          .gte('entry_date', lowDate)
          .lte('entry_date', highDate),
      filterLines: (q: EntryLinesQuery) =>
        q
          .gte('account_number', String(BANK_ACCOUNT_LOW))
          .lte('account_number', String(BANK_ACCOUNT_HIGH))
          .gt('debit_amount', 0),
      // The old embed was aliased: journal_entry:journal_entries!inner(...).
      attachEntriesAs: 'journal_entry',
    })
  } catch {
    // Fail-open, as before: a detection failure must not block the match.
    return null
  }
  if (lines.length === 0) return null

  // System-generated payment vouchers (invoice_paid etc.) ARE valid
  // duplicates to surface: those are exactly the case where the user
  // already booked through a different flow. Only exclude reversals
  // and corrections, which are bookkeeping noise rather than payment
  // candidates the user would want to link to.
  const bankDebits = lines.filter(
    (l) => l.journal_entry.source_type !== 'storno' && l.journal_entry.source_type !== 'correction',
  )

  // Narrow to lines whose SEK debit matches the bank line's SEK value within
  // 0.01. With no SEK value on the bank side the test cannot run: keep the
  // survivors and flag them unverified rather than returning null, which would
  // read as "not a duplicate, go ahead". The existence half of the question is
  // unit-free (posted, 19xx, in-window, unlinked), so an empty list here is
  // still a genuine "no duplicate".
  const candidates =
    targetSek === null
      ? bankDebits
      : bankDebits.filter((l) => {
          const debitSek = Math.round(Number(l.debit_amount) * 100) / 100
          return Math.abs(debitSek - targetSek) < 0.01
        })

  if (candidates.length === 0) return null

  // Exclude entries already linked to a bank transaction, directly or through
  // an invoice_payments row that carries one. A payment row with
  // transaction_id NULL is a manual / Stripe settlement (#2019): its bank line
  // has not been matched yet, so the voucher stays a duplicate candidate.
  const entryIds = candidates.map((l) => l.journal_entry.id)

  const [{ data: paymentLinks }, { data: txLinks }] = await Promise.all([
    supabase
      .from('invoice_payments')
      .select('journal_entry_id, transaction_id')
      .eq('company_id', companyId)
      .in('journal_entry_id', entryIds),
    supabase
      .from('transactions')
      .select('id, journal_entry_id')
      .eq('company_id', companyId)
      .in('journal_entry_id', entryIds),
  ])

  const linkedIds = new Set<string>()
  for (const row of (paymentLinks ?? []) as {
    journal_entry_id: string | null
    transaction_id: string | null
  }[]) {
    if (row.journal_entry_id && row.transaction_id) linkedIds.add(row.journal_entry_id)
  }
  for (const row of (txLinks ?? []) as { id: string; journal_entry_id: string | null }[]) {
    // A transaction can link to its own JE via the current match flow: but
    // we're called *before* that link is created, so the caller's own
    // transactionId shouldn't appear. Guard anyway in case of a retry.
    if (row.journal_entry_id && row.id !== transactionId) {
      linkedIds.add(row.journal_entry_id)
    }
  }

  const unlinked = candidates.filter((l) => !linkedIds.has(l.journal_entry.id))
  if (unlinked.length === 0) return null

  // Pick the best candidate: same-date beats within-window; otherwise pick
  // the closest by date difference.
  const targetDateMs = new Date(transactionDate).getTime()
  unlinked.sort((a, b) => {
    const aDiff = Math.abs(new Date(a.journal_entry.entry_date).getTime() - targetDateMs)
    const bDiff = Math.abs(new Date(b.journal_entry.entry_date).getTime() - targetDateMs)
    return aDiff - bDiff
  })

  const best = unlinked[0]
  const sameDate = best.journal_entry.entry_date === transactionDate

  return {
    journal_entry_id: best.journal_entry.id,
    voucher_label: `${best.journal_entry.voucher_series ?? 'A'}${best.journal_entry.voucher_number ?? ''}`,
    entry_date: best.journal_entry.entry_date,
    description: best.journal_entry.description,
    amount: Math.round(Number(best.debit_amount) * 100) / 100,
    bank_account_number: best.account_number,
    // When the amount test never ran, the reason must say so: labelling a
    // date-only survivor 'exact_amount_*' made the UI claim an amount match
    // that was never made.
    reason:
      targetSek === null
        ? 'date_window_only'
        : sameDate
          ? 'exact_amount_same_date'
          : 'exact_amount_within_window',
    amount_verified: targetSek !== null,
    unverified_reason: targetSek === null ? 'transaction_missing_sek_value' : null,
  }
}
