/**
 * Booking-time duplicate guard for bank transactions.
 *
 * Why this exists
 * ---------------
 * A bank account's transactions can land in the `transactions` table twice: a
 * CSV import on top of a PSD2 sync, or a re-sync whose external_id drifted (see
 * the import dedup in lib/transactions/ingest.ts). Import-time dedup is
 * best-effort and can miss. The cosmetic cost of a missed duplicate is a second
 * row in the "Att bokföra" list. The REAL cost is booking BOTH copies: that
 * creates two verifikationer for one affärshändelse, double-counts the
 * cost/income, and is felaktig bokföring under BFL (the second verifikat has no
 * underlying event). Rättelse would then require storno, not deletion.
 *
 * This guard runs at booking time. Before a transaction becomes a verifikat it
 * looks for ANOTHER transaction in the same company that is already booked and
 * shares this one's (date, amount, cash account). If found, the caller surfaces
 * it as a WARNING: never a hard block, because genuinely repeated
 * same-(date,amount) payments do occur (e.g. several identical Swish transfers
 * in one day). The user confirms with force=true after reviewing the candidate.
 *
 * Mirrors the invoice-side `detectDuplicatePaymentVoucher`
 * (lib/invoices/duplicate-payment-detection.ts), but keyed on an already-booked
 * sibling TRANSACTION rather than a manually-posted journal entry.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { roundOre } from '@/lib/money'

/** Integer öre: representation-agnostic amount key (mirrors the ingest dedup). */
function toOre(amount: number | string): number {
  return Math.round(Number(amount) * 100)
}

/** An already-booked transaction OR voucher that looks like the same real movement. */
export interface BookedDuplicateCandidate {
  /**
   * The sibling transaction that is already booked, or `null` when the duplicate
   * is a ledger-only voucher (a payment/payout booked straight to the cash
   * account with no transaction row behind it: see detectLedgerDuplicateVoucher).
   */
  transaction_id: string | null
  /** Its verifikat. */
  journal_entry_id: string
  /** Human label, e.g. "A142" (voucher_series + voucher_number). */
  voucher_label: string
  entry_date: string
  description: string | null
  amount: number
}

/** Minimal shape of the transaction about to be booked. */
export interface BookingTarget {
  id: string
  date: string
  amount: number | string
  cash_account_id?: string | null
}

/**
 * Same-batch siblings to exclude from booking-time duplicate detection.
 *
 * When a bulk run books several DISTINCT bank movements that happen to share a
 * (date, amount, cash account): several identical Swish transfers the user
 * explicitly selected: the second booking must NOT dedupe against the first
 * booking's freshly-created verifikat: they are separate affärshändelser. The
 * bulk driver accumulates the ids it has booked so far in THIS batch and passes
 * them here so intra-batch siblings never flag one another.
 *
 * CRITICAL: only ids created within the current batch belong here. A duplicate
 * that existed BEFORE the batch has neither its transaction id nor its voucher
 * id in these lists, so it is STILL detected and skipped. Both fields are
 * optional; the default (no exclusion) keeps single-booking callers unaffected.
 */
export interface BookingDuplicateExclusions {
  /** Sibling transaction ids booked earlier in the same bulk run. */
  excludeTransactionIds?: string[]
  /** Journal-entry ids minted earlier in the same bulk run. */
  excludeJournalEntryIds?: string[]
}

/**
 * Find an already-booked sibling transaction sharing (date, amount, account).
 * Returns the single best candidate, or null.
 *
 * Account guard mirrors the import dedup bridge: when BOTH sides know their
 * cash_account_id they must match; a null on either side is treated as
 * compatible (single-account companies and un-backfilled rows behave as before).
 *
 * Fail-open: a query error returns null rather than throwing: a detection
 * failure must never block a legitimate booking. The pick is deterministic
 * (lowest id) so a re-detection under force=true returns the same candidate the
 * user reviewed.
 */
export async function detectBookedDuplicateTransaction(
  supabase: SupabaseClient,
  companyId: string,
  target: BookingTarget,
  opts?: BookingDuplicateExclusions,
): Promise<BookedDuplicateCandidate | null> {
  const targetOre = toOre(target.amount)
  if (targetOre === 0 || Number.isNaN(targetOre)) return null
  // Siblings booked earlier in this same bulk run are distinct events the user
  // selected, not duplicates: never flag one against another.
  const excludeTransactionIds = new Set(opts?.excludeTransactionIds ?? [])

  // Same company, same date, already booked, not the target row itself. The
  // amount and account match is applied in JS so a numeric-string amount from
  // PostgREST ("-1616.00") collapses to the same öre as the number (-1616).
  const { data, error } = await supabase
    .from('transactions')
    .select('id, date, amount, description, cash_account_id, journal_entry_id')
    .eq('company_id', companyId)
    .eq('date', target.date)
    .not('journal_entry_id', 'is', null)
    .neq('id', target.id)
    .limit(100)

  if (error || !data || data.length === 0) return null

  type Row = {
    id: string
    date: string
    amount: number | string
    description: string | null
    cash_account_id: string | null
    journal_entry_id: string
  }
  const targetAccount = target.cash_account_id ?? null
  const matches = (data as unknown as Row[]).filter((r) => {
    if (excludeTransactionIds.has(r.id)) return false
    if (toOre(r.amount) !== targetOre) return false
    // Account guard: both-known must match; a null on either side is compatible.
    if (targetAccount !== null && r.cash_account_id !== null && r.cash_account_id !== targetAccount) {
      return false
    }
    return r.journal_entry_id != null
  })
  if (matches.length === 0) return null

  matches.sort((a, b) => a.id.localeCompare(b.id))
  const best = matches[0]

  // Resolve the voucher label for the warning (best-effort: a missing label
  // still yields a usable candidate the UI can render by date/amount).
  let voucherLabel = ''
  let entryDate = best.date
  const { data: je } = await supabase
    .from('journal_entries')
    .select('voucher_series, voucher_number, entry_date')
    .eq('id', best.journal_entry_id)
    .maybeSingle()
  if (je) {
    const j = je as { voucher_series: string | null; voucher_number: number | null; entry_date: string | null }
    voucherLabel = `${j.voucher_series ?? 'A'}${j.voucher_number ?? ''}`
    entryDate = j.entry_date ?? best.date
  }

  return {
    transaction_id: best.id,
    journal_entry_id: best.journal_entry_id,
    voucher_label: voucherLabel,
    entry_date: entryDate,
    description: best.description,
    amount: roundOre(Number(best.amount)),
  }
}

/** ± days around the bank-tx date a voucher may be dated and still be "the same" movement. */
const VOUCHER_DUPLICATE_DATE_WINDOW_DAYS = 7

/** BAS "kassa och bank" range. 1910-1919 = kassa, 1920-1949 = bank/giro. */
const BANK_ACCOUNT_LOW = 1910
const BANK_ACCOUNT_HIGH = 1949

/**
 * Find an unlinked posted voucher whose bank/cash (19xx) leg already books this
 * exact bank movement: the ledger-only twin of the bank line.
 *
 * This is the second half of the booking-time duplicate guard. The first half
 * (detectBookedDuplicateTransaction) only finds an already-booked SIBLING
 * TRANSACTION. But the most damaging orphan has NO sibling transaction at all:
 * the affärshändelse was booked through a flow that posts straight to the ledger
 * and never creates or links a bank-transaction row: invoice "markera som
 * betald" (Dr 19xx / Cr 1510), the salary run's net-wage payout (Cr 19xx), a
 * hand-posted verifikat. Booking the bank line on top of that double-counts the
 * movement on the cash account: two verifikationer for one affärshändelse,
 * felaktig bokföring per BFL. Because the import dedup and the sibling guard
 * both only see the `transactions` table, neither catches this: only matching
 * the bank line against the ledger does.
 *
 * Direction-aware so it works both ways:
 *   - inbound  (target.amount > 0, money in)  → a 19xx DEBIT of the same amount
 *   - outbound (target.amount < 0, money out) → a 19xx CREDIT of the same amount
 *
 * Account-aware: when the bank line knows its cash account, the matching leg
 * must be on that account's ledger account; otherwise any 19xx leg matches
 * (single-account companies, legacy rows with no cash_account_id).
 *
 * Excludes vouchers already linked to a transaction or an invoice_payment (those
 * are reconciled, not orphans) and storno/correction entries (valid second
 * vouchers, not duplicates). Fail-open: a query error returns null so a
 * detection failure never blocks a legitimate booking. The pick is deterministic
 * (closest date, then lowest journal_entry id) so a force re-detect is stable.
 */
export async function detectLedgerDuplicateVoucher(
  supabase: SupabaseClient,
  companyId: string,
  target: BookingTarget,
  opts?: BookingDuplicateExclusions,
): Promise<BookedDuplicateCandidate | null> {
  const targetOre = toOre(target.amount)
  if (targetOre === 0 || Number.isNaN(targetOre)) return null
  // Vouchers minted earlier in this same bulk run are this batch's own fresh
  // bookings: a subsequent sibling must not dedupe against them.
  const excludeJournalEntryIds = new Set(opts?.excludeJournalEntryIds ?? [])
  const targetAmount = roundOre(Math.abs(Number(target.amount)))
  const inbound = targetOre > 0

  const dateMs = new Date(target.date).getTime()
  if (Number.isNaN(dateMs)) return null
  const windowMs = VOUCHER_DUPLICATE_DATE_WINDOW_DAYS * 24 * 3600 * 1000
  const lowDate = new Date(dateMs - windowMs).toISOString().split('T')[0]
  const highDate = new Date(dateMs + windowMs).toISOString().split('T')[0]

  // Resolve the bank line's settlement ledger account, when known, so a movement
  // on one bank account never deduplicates a voucher on a different account of
  // the same company (the 19xx leg below is matched against it).
  let settlementAccount: string | null = null
  if (target.cash_account_id) {
    const { data: ca } = await supabase
      .from('cash_accounts')
      .select('ledger_account')
      .eq('company_id', companyId)
      .eq('id', target.cash_account_id)
      .maybeSingle()
    settlementAccount = ((ca as { ledger_account?: string } | null)?.ledger_account) ?? null
  }

  const amountColumn = inbound ? 'debit_amount' : 'credit_amount'
  let query = supabase
    .from('journal_entry_lines')
    .select(
      `account_number,
       debit_amount,
       credit_amount,
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
    .gt(amountColumn, 0)

  query = settlementAccount
    ? query.eq('account_number', settlementAccount)
    : query.gte('account_number', String(BANK_ACCOUNT_LOW)).lte('account_number', String(BANK_ACCOUNT_HIGH))

  const { data: lines, error } = await query.limit(50)
  if (error || !lines || lines.length === 0) return null

  type LineRow = {
    account_number: string
    debit_amount: number | string
    credit_amount: number | string
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
    // Same-batch vouchers are this run's own fresh bookings, never duplicates.
    .filter((l) => !excludeJournalEntryIds.has(l.journal_entry.id))
    .filter((l) => {
      const legAmount = roundOre(Number(inbound ? l.debit_amount : l.credit_amount))
      return Math.abs(legAmount - targetAmount) < 0.01
    })
    // Reversals/corrections are valid second vouchers, not duplicate bookings.
    .filter((l) => l.journal_entry.source_type !== 'storno' && l.journal_entry.source_type !== 'correction')

  if (candidates.length === 0) return null

  // Drop vouchers already reconciled to a transaction or an invoice payment:
  // those aren't orphans. Both lookups are filtered by company_id (defense in
  // depth alongside RLS).
  const entryIds = candidates.map((l) => l.journal_entry.id)
  const [{ data: txLinks }, { data: payLinks }] = await Promise.all([
    supabase.from('transactions').select('journal_entry_id').eq('company_id', companyId).in('journal_entry_id', entryIds),
    supabase.from('invoice_payments').select('journal_entry_id').eq('company_id', companyId).in('journal_entry_id', entryIds),
  ])
  const linked = new Set<string>()
  for (const r of (txLinks ?? []) as { journal_entry_id: string | null }[]) {
    if (r.journal_entry_id) linked.add(r.journal_entry_id)
  }
  for (const r of (payLinks ?? []) as { journal_entry_id: string | null }[]) {
    if (r.journal_entry_id) linked.add(r.journal_entry_id)
  }

  const unlinked = candidates.filter((l) => !linked.has(l.journal_entry.id))
  if (unlinked.length === 0) return null

  unlinked.sort((a, b) => {
    const ad = Math.abs(new Date(a.journal_entry.entry_date).getTime() - dateMs)
    const bd = Math.abs(new Date(b.journal_entry.entry_date).getTime() - dateMs)
    if (ad !== bd) return ad - bd
    return a.journal_entry.id.localeCompare(b.journal_entry.id)
  })
  const best = unlinked[0]

  return {
    transaction_id: null,
    journal_entry_id: best.journal_entry.id,
    voucher_label: `${best.journal_entry.voucher_series ?? 'A'}${best.journal_entry.voucher_number ?? ''}`,
    entry_date: best.journal_entry.entry_date,
    description: best.journal_entry.description,
    amount: roundOre(Number(inbound ? best.debit_amount : best.credit_amount)),
  }
}

/**
 * Unified booking-time duplicate guard. Returns the single best already-booked
 * candidate for this bank line: a sibling transaction first (the cheaper,
 * higher-confidence signal), then a ledger-only voucher. Null when neither
 * fires. This is the function every booking chokepoint should call (web /book +
 * /categorize routes and the agent commit executors) so all paths reject the
 * same double-bookings.
 */
export async function detectBookingDuplicate(
  supabase: SupabaseClient,
  companyId: string,
  target: BookingTarget,
  opts?: BookingDuplicateExclusions,
): Promise<BookedDuplicateCandidate | null> {
  const sibling = await detectBookedDuplicateTransaction(supabase, companyId, target, opts)
  if (sibling) return sibling
  return detectLedgerDuplicateVoucher(supabase, companyId, target, opts)
}
