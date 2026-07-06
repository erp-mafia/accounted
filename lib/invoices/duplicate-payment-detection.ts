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
 */
import type { SupabaseClient } from '@supabase/supabase-js'

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
  amount: number
  bank_account_number: string
  reason: 'exact_amount_same_date' | 'exact_amount_within_window'
}

interface DetectArgs {
  companyId: string
  transactionId: string
  transactionDate: string
  transactionAmount: number
}

/**
 * Find the single most likely manual verifikation that already books this
 * bank transaction. Returns null when no candidate is found.
 *
 * Filters applied:
 *  - posted status (drafts cannot be a duplicate by definition)
 *  - entry date within ±DATE_WINDOW_DAYS of transaction.date
 *  - has a line that debits a BAS 19xx (kassa/bank) account for the same
 *    rounded amount (within 0.01 SEK)
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
  const targetAmount = Math.round(Math.abs(transactionAmount) * 100) / 100
  if (targetAmount === 0) return null

  const dateMs = new Date(transactionDate).getTime()
  if (Number.isNaN(dateMs)) return null
  const lowDate = new Date(dateMs - DATE_WINDOW_DAYS * 24 * 3600 * 1000)
    .toISOString()
    .split('T')[0]
  const highDate = new Date(dateMs + DATE_WINDOW_DAYS * 24 * 3600 * 1000)
    .toISOString()
    .split('T')[0]

  // Query journal_entry_lines for bank-account debits within the window.
  // The join filters by company_id at the parent: RLS handles isolation,
  // but we filter explicitly as defense-in-depth.
  const { data: lines, error } = await supabase
    .from('journal_entry_lines')
    .select(
      `account_number,
       debit_amount,
       journal_entry:journal_entries!inner(
         id,
         entry_date,
         description,
         voucher_series,
         voucher_number,
         status,
         source_type,
         company_id
       )`,
    )
    .eq('journal_entry.company_id', companyId)
    .eq('journal_entry.status', 'posted')
    .gte('journal_entry.entry_date', lowDate)
    .lte('journal_entry.entry_date', highDate)
    .gte('account_number', String(BANK_ACCOUNT_LOW))
    .lte('account_number', String(BANK_ACCOUNT_HIGH))
    .gt('debit_amount', 0)
    .limit(50)

  if (error || !lines || lines.length === 0) return null

  // Narrow to lines whose debit matches the transaction amount within 0.01 SEK.
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
  const candidates = (lines as unknown as LineRow[])
    .filter((l) => {
      const debit = Math.round(Number(l.debit_amount) * 100) / 100
      return Math.abs(debit - targetAmount) < 0.01
    })
    // System-generated payment vouchers (invoice_paid etc.) ARE valid
    // duplicates to surface: those are exactly the case where the user
    // already booked through a different flow. Only exclude reversals
    // and corrections, which are bookkeeping noise rather than payment
    // candidates the user would want to link to.
    .filter((l) => l.journal_entry.source_type !== 'storno' && l.journal_entry.source_type !== 'correction')

  if (candidates.length === 0) return null

  // Exclude entries already linked from invoice_payments or any transaction.
  const entryIds = candidates.map((l) => l.journal_entry.id)

  const [{ data: paymentLinks }, { data: txLinks }] = await Promise.all([
    supabase
      .from('invoice_payments')
      .select('journal_entry_id')
      .eq('company_id', companyId)
      .in('journal_entry_id', entryIds),
    supabase
      .from('transactions')
      .select('id, journal_entry_id')
      .eq('company_id', companyId)
      .in('journal_entry_id', entryIds),
  ])

  const linkedIds = new Set<string>()
  for (const row of (paymentLinks ?? []) as { journal_entry_id: string | null }[]) {
    if (row.journal_entry_id) linkedIds.add(row.journal_entry_id)
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
    reason: sameDate ? 'exact_amount_same_date' : 'exact_amount_within_window',
  }
}
