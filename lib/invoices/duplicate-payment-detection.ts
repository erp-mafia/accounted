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
import { findExactCoveringSet } from '@/lib/reconciliation/covering-set'
import { roundOre } from '@/lib/money'

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

// ============================================================
// Explaining voucher SET: one bank row, one or several vouchers
// ============================================================

/** ± days around the bank row considered "the same payment" for a set. */
const SET_DATE_WINDOW_DAYS = 7

/** Largest set of vouchers offered as the explanation of one bank row. */
export const EXPLAINING_SET_MAX_VOUCHERS = 4

export interface ExplainingVoucher {
  journal_entry_id: string
  voucher_label: string
  entry_date: string
  description: string | null
  source_type: string | null
  /** The voucher's bank leg in SEK, positive, in the bank row's direction. */
  amount: number
  bank_account_number: string
}

export interface ExplainingVoucherSet {
  /** One to EXPLAINING_SET_MAX_VOUCHERS vouchers, closest in date first. */
  vouchers: ExplainingVoucher[]
  /** SEK sum of the legs: equals the bank row stated in SEK, to the öre. */
  total: number
  bank_account_number: string
  /** True when every voucher is dated on the bank row's date. */
  same_date: boolean
}

export interface DetectSetArgs extends DetectArgs {
  /**
   * The settlement account the bank row belongs to (cash_accounts.ledger_account)
   * when known. Narrows the scan to that account, so a 1940 leg can never be
   * summed into a 1930 row. Null or omitted scans the whole 19xx range, the
   * legacy shape for rows with no resolvable cash account.
   */
  bankAccountNumber?: string | null
}

/**
 * Find the vouchers that already book this bank row, allowing the row to be
 * explained by SEVERAL of them.
 *
 * The 1:1 detector above answers "is there one voucher of this amount?". A
 * bank feed regularly delivers one row for several affärshändelser (a
 * Bankgirot daily aggregate: two customers' invoices, one "BGGIRERING" row
 * with no payer and no reference), and each of those may already be booked on
 * its own: "Markera som betald" per invoice, one salary voucher per employee.
 * Nothing on the account then equals the row, the 1:1 check passes, and the
 * next door (a batch allocation, a fresh categorisation) books the same
 * money a second time. That is exactly the double booking this catches.
 *
 * Deterministic on purpose: the only signal is an exact öre sum of unlinked
 * bank legs in the row's direction, on the row's account, within ±7 days.
 * No counterparty text is consulted: the bank rows this exists for carry
 * none. A voucher counts as linked (and drops out) when a transaction points
 * at it, a payment row with a bank transaction references it, or a
 * transaction_voucher_links row anchors it: the same three storage
 * locations isTransactionBooked reads, seen from the voucher side. A payment
 * row WITHOUT a bank transaction is a manual settlement (#2019) and keeps the
 * voucher in play: its bank line is precisely what has not been matched yet.
 *
 * Returns null when the row cannot be stated in SEK (a foreign row with no
 * stored rate): a set cannot be summed in an unknown unit, and the 1:1
 * detector's `amount_verified: false` path already surfaces that case.
 */
export async function detectExplainingVoucherSet(
  supabase: SupabaseClient,
  args: DetectSetArgs,
): Promise<ExplainingVoucherSet | null> {
  const { companyId, transactionId, transactionDate, transactionAmount } = args
  if (Math.round(Math.abs(transactionAmount) * 100) === 0) return null

  const signedSek = resolveTransactionAmountSek({
    amount: transactionAmount,
    currency: args.transactionCurrency,
    amount_sek: args.transactionAmountSek,
    exchange_rate: args.transactionExchangeRate,
  })
  if (signedSek === null) return null
  const targetSek = roundOre(Math.abs(signedSek))
  if (targetSek === 0) return null

  const dateMs = new Date(transactionDate).getTime()
  if (Number.isNaN(dateMs)) return null
  const lowDate = new Date(dateMs - SET_DATE_WINDOW_DAYS * 24 * 3600 * 1000)
    .toISOString()
    .split('T')[0]
  const highDate = new Date(dateMs + SET_DATE_WINDOW_DAYS * 24 * 3600 * 1000)
    .toISOString()
    .split('T')[0]

  // Money in: the voucher DEBITS the bank account. Money out: it CREDITS it.
  const inbound = transactionAmount > 0
  const account = args.bankAccountNumber?.trim() || null

  type SetLineRow = {
    account_number: string
    debit_amount: number | string | null
    credit_amount: number | string | null
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

  let lines: SetLineRow[]
  try {
    lines = await fetchEntryLines<SetLineRow>({
      supabase,
      entryColumns:
        'id, entry_date, description, voucher_series, voucher_number, status, source_type, company_id',
      lineColumns: 'account_number, debit_amount, credit_amount',
      filterEntries: (q: EntryLinesQuery) =>
        q
          .eq('company_id', companyId)
          .eq('status', 'posted')
          .gte('entry_date', lowDate)
          .lte('entry_date', highDate),
      filterLines: (q: EntryLinesQuery) => {
        const scoped = account
          ? q.eq('account_number', account)
          : q.gte('account_number', String(BANK_ACCOUNT_LOW)).lte('account_number', String(BANK_ACCOUNT_HIGH))
        return inbound ? scoped.gt('debit_amount', 0) : scoped.gt('credit_amount', 0)
      },
      attachEntriesAs: 'journal_entry',
    })
  } catch {
    // Fail-open like the 1:1 detector: a detection failure must not block a
    // booking. Callers log the miss.
    return null
  }
  if (lines.length === 0) return null

  // Reversals, corrections and opening balances are bookkeeping scaffolding,
  // never the payment itself (the reconciliation RPCs drop the same three).
  const legs = lines.filter(
    (l) =>
      l.journal_entry.source_type !== 'storno' &&
      l.journal_entry.source_type !== 'correction' &&
      l.journal_entry.source_type !== 'opening_balance',
  )
  if (legs.length === 0) return null

  // One candidate per voucher and account: a voucher with two legs on the
  // same account (a split payment line) is summed, a voucher touching two
  // bank accounts (a transfer) keeps its largest leg so it can appear once.
  type Candidate = ExplainingVoucher & { dateDistanceDays: number; id: string }
  const byEntry = new Map<string, Candidate>()
  for (const leg of legs) {
    const raw = inbound ? leg.debit_amount : leg.credit_amount
    const amount = roundOre(Number(raw))
    if (!(amount > 0)) continue
    const entry = leg.journal_entry
    const existing = byEntry.get(entry.id)
    if (existing && existing.bank_account_number === leg.account_number) {
      existing.amount = roundOre(existing.amount + amount)
      continue
    }
    if (existing && existing.amount >= amount) continue
    const entryMs = new Date(entry.entry_date).getTime()
    byEntry.set(entry.id, {
      id: entry.id,
      journal_entry_id: entry.id,
      voucher_label: `${entry.voucher_series ?? 'A'}${entry.voucher_number ?? ''}`,
      entry_date: entry.entry_date,
      description: entry.description,
      source_type: entry.source_type,
      amount,
      bank_account_number: leg.account_number,
      dateDistanceDays: Number.isNaN(entryMs)
        ? SET_DATE_WINDOW_DAYS
        : Math.round(Math.abs(entryMs - dateMs) / (24 * 3600 * 1000)),
    })
  }
  if (byEntry.size === 0) return null

  // Drop vouchers a bank transaction already explains, through any of the
  // three anchors. All four lookups are company-scoped (defense in depth).
  const entryIds = Array.from(byEntry.keys())
  const [paymentLinksRes, supplierPaymentLinksRes, txLinksRes, junctionLinksRes] =
    await Promise.all([
      supabase
        .from('invoice_payments')
        .select('journal_entry_id, transaction_id')
        .eq('company_id', companyId)
        .in('journal_entry_id', entryIds),
      supabase
        .from('supplier_invoice_payments')
        .select('journal_entry_id, transaction_id')
        .eq('company_id', companyId)
        .in('journal_entry_id', entryIds),
      supabase
        .from('transactions')
        .select('id, journal_entry_id')
        .eq('company_id', companyId)
        .in('journal_entry_id', entryIds),
      supabase
        .from('transaction_voucher_links')
        .select('journal_entry_id')
        .eq('company_id', companyId)
        .in('journal_entry_id', entryIds),
    ])
  // A PostgREST failure resolves with { data: null, error } rather than
  // throwing. Reading that as "no links" would offer a voucher a bank row
  // already settles, so a failed lookup fails open (null) like a thrown one:
  // the guard stays advisory and the booking RPC keeps the last word.
  if (paymentLinksRes.error || supplierPaymentLinksRes.error || txLinksRes.error || junctionLinksRes.error) {
    return null
  }
  const paymentLinks = paymentLinksRes.data
  const supplierPaymentLinks = supplierPaymentLinksRes.data
  const txLinks = txLinksRes.data
  const junctionLinks = junctionLinksRes.data

  const linkedIds = new Set<string>()
  for (const row of [...((paymentLinks ?? []) as PaymentLinkRow[]), ...((supplierPaymentLinks ?? []) as PaymentLinkRow[])]) {
    if (row.journal_entry_id && row.transaction_id) linkedIds.add(row.journal_entry_id)
  }
  for (const row of (txLinks ?? []) as { id: string; journal_entry_id: string | null }[]) {
    // The caller's own row is never a link: the guard runs before it is linked.
    if (row.journal_entry_id && row.id !== transactionId) linkedIds.add(row.journal_entry_id)
  }
  for (const row of (junctionLinks ?? []) as { journal_entry_id: string | null }[]) {
    if (row.journal_entry_id) linkedIds.add(row.journal_entry_id)
  }

  const pool = Array.from(byEntry.values()).filter((c) => !linkedIds.has(c.journal_entry_id))
  if (pool.length === 0) return null

  // Sets never mix accounts: the link that resolves the warning is made on
  // one settlement account. Search per account, closest account first.
  const accounts = Array.from(new Set(pool.map((c) => c.bank_account_number))).sort()
  for (const accountNumber of accounts) {
    const set = findExactCoveringSet(
      targetSek,
      pool.filter((c) => c.bank_account_number === accountNumber),
      { maxSize: EXPLAINING_SET_MAX_VOUCHERS },
    )
    if (!set) continue
    const vouchers = [...set]
      .sort((a, b) => a.dateDistanceDays - b.dateDistanceDays || a.entry_date.localeCompare(b.entry_date))
      .map(({ id: _id, dateDistanceDays: _distance, ...voucher }) => voucher)
    return {
      vouchers,
      total: targetSek,
      bank_account_number: accountNumber,
      same_date: vouchers.every((v) => v.entry_date === transactionDate),
    }
  }
  return null
}

type PaymentLinkRow = { journal_entry_id: string | null; transaction_id: string | null }

/** The transaction columns the set detector needs; a caller that already holds the row passes it. */
export interface TransactionForExplaining {
  id: string
  date: string
  amount: number
  currency: string | null
  amount_sek?: number | null
  exchange_rate?: number | null
  cash_account_id?: string | null
  journal_entry_id?: string | null
}

/**
 * Convenience for the routes: resolve the row's settlement account from its
 * cash account and run the set detector. Accepts the transaction id (one
 * fetch) or a row a caller already holds. A row that already carries a live
 * pointer returns null: the booking RPCs refuse it on their own terms.
 */
export async function detectExplainingVoucherSetForTransaction(
  supabase: SupabaseClient,
  companyId: string,
  transaction: string | TransactionForExplaining,
): Promise<ExplainingVoucherSet | null> {
  let row: TransactionForExplaining | null
  if (typeof transaction === 'string') {
    const { data, error } = await supabase
      .from('transactions')
      .select('id, date, amount, currency, amount_sek, exchange_rate, cash_account_id, journal_entry_id')
      .eq('id', transaction)
      .eq('company_id', companyId)
      .maybeSingle()
    if (error) return null
    row = (data as TransactionForExplaining | null) ?? null
  } else {
    row = transaction
  }
  if (!row || row.journal_entry_id) return null

  let bankAccountNumber: string | null = null
  if (row.cash_account_id) {
    const { data: cashAccount, error } = await supabase
      .from('cash_accounts')
      .select('ledger_account')
      .eq('id', row.cash_account_id)
      .eq('company_id', companyId)
      .maybeSingle()
    // Without the account the scan would widen to every 19xx account: an
    // unverified answer, so a failed lookup is a pass, not a wider guess.
    if (error) return null
    bankAccountNumber = (cashAccount?.ledger_account as string | null) ?? null
  }

  return detectExplainingVoucherSet(supabase, {
    companyId,
    transactionId: row.id,
    transactionDate: row.date,
    transactionAmount: Number(row.amount),
    transactionCurrency: row.currency ?? null,
    transactionAmountSek: row.amount_sek ?? null,
    transactionExchangeRate: row.exchange_rate ?? null,
    bankAccountNumber,
  })
}
