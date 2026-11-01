/**
 * Detect a "soft duplicate" payment voucher for a bank transaction.
 *
 * Scenario: the user manually booked the receipt as a verifikation
 * (Dr 19xx / Cr 1510 or Cr 30xx) *outside* the match-invoice flow. The
 * invoice's status stays 'sent', no `invoice_payments` row exists, and the
 * matcher would happily propose a second payment voucher: double-booking
 * the bank receipt.
 *
 * Heuristic: a posted journal entry within a tight date window that books
 * the same amount on the row's bank account in the row's direction, and
 * which is not already linked to any transaction or invoice payment, is
 * almost certainly the manual booking. We surface it as a candidate; the
 * API refuses the match unless the caller passes `force: true`. The 1:1
 * detector is the booking guard's ledger detector, adapted to this door's
 * candidate shape (one rule for "a voucher already books this movement").
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
import { formatVoucher } from '@/lib/bookkeeping/voucher-series-resolver'
import type { SupabaseClient } from '@supabase/supabase-js'
import { fetchEntryLines, type EntryLinesQuery } from '@/lib/bookkeeping/entry-lines'
import { detectLedgerDuplicateVoucher, resolveTransactionAmountSek } from '@/lib/transactions/booking-duplicate-detection'
import { findExactCoveringSet } from '@/lib/reconciliation/covering-set'
import { roundOre } from '@/lib/money'

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
  /**
   * The settlement account the bank row belongs to (cash_accounts.ledger_account)
   * when known. Narrows the scan to that account: money that arrived on a
   * PSP clearing account (1686) cannot be a duplicate of a 1930 voucher of
   * the same amount, and a 1930 row cannot be one of a 1940 voucher. Null or
   * omitted scans the whole 19xx range, the legacy shape for rows with no
   * resolvable cash account. Wins over `cashAccountId` when both are given.
   */
  bankAccountNumber?: string | null
  /**
   * `transactions.cash_account_id`: the detector resolves its ledger_account
   * into `bankAccountNumber` (resolveCashAccountLedger). Every door that holds
   * the row passes it. A failed lookup throws rather than widening the scan to
   * every 19xx account or answering "no duplicate": the callers' detection-
   * failure path then runs (fail open without force, the "check did not run"
   * warning on the MCP approval card, a refused force).
   */
  cashAccountId?: string | null
}

/** Most vouchers the supplier reading skips as claimed before it stops looking. */
const CLAIMED_SKIP_LIMIT = 5

export interface DetectOptions {
  /**
   * The supplier match's reading (accounted#58). A voucher that is already
   * the payment or registration verifikat of a supplier invoice, pays a
   * customer invoice, or is linked to any bank row (the twin rule below
   * included) is that booking, not a hand booking of this payment: it is
   * skipped and the next candidate looked for. Without it the content-only
   * twin rule named the payment of one invoice as the duplicate of an equal
   * payment of another invoice the same week. A failed claim read throws.
   */
  skipClaimed?: boolean
}

/**
 * Find the single most likely verifikation that already books this bank
 * transaction. Returns null when no candidate is found.
 *
 * The question is the booking guard's ("does a voucher already book this bank
 * movement?"), so the answer is the booking guard's ledger detector
 * (detectLedgerDuplicateVoucher in lib/transactions/booking-duplicate-
 * detection.ts), adapted to this door's candidate shape. Its rules:
 *  - posted entries within ±7 days of transaction.date, storno and correction
 *    entries excluded;
 *  - a leg on the row's own settlement account (`bankAccountNumber`, else
 *    resolved from `cashAccountId`), or any BAS 19xx account when that is
 *    unknown, in the row's direction: a DEBIT for money in, a CREDIT for
 *    money out;
 *  - the same SEK amount within 0.01 (the leg's column is always SEK). When
 *    the bank line has no SEK value the amount test is skipped, the
 *    candidate must lie within ±1 day, and it comes back with
 *    `amount_verified: false`, an explicit "could not verify";
 *  - not already linked to another transaction or to an invoice payment that
 *    carries one, EXCEPT a voucher whose linking transaction is this row's
 *    twin (same öre, same currency, compatible account, date in the window):
 *    the date-drifted duplicate import whose copy is already booked.
 *
 * This door resolves the settlement account itself and fails closed: a
 * failed cash-account lookup throws, so the caller's detection-failure path
 * runs instead of a scan widened to every 19xx account.
 */
export async function detectDuplicatePaymentVoucher(
  supabase: SupabaseClient,
  args: DetectArgs,
  opts?: DetectOptions,
): Promise<DuplicateVoucherCandidate | null> {
  const { companyId, transactionId, transactionDate, transactionAmount } = args

  let bankAccountNumber = args.bankAccountNumber?.trim() || null
  if (args.bankAccountNumber === undefined && args.cashAccountId) {
    const ledger = await resolveCashAccountLedger(supabase, companyId, args.cashAccountId)
    if (!ledger.ok) throw new Error('duplicate-payment check: cash account lookup failed')
    bankAccountNumber = ledger.accountNumber?.trim() || null
  }

  const target = {
    id: transactionId,
    date: transactionDate,
    amount: transactionAmount,
    currency: args.transactionCurrency,
    amount_sek: args.transactionAmountSek ?? null,
    exchange_rate: args.transactionExchangeRate ?? null,
    cash_account_id: args.cashAccountId ?? null,
    settlement_account: bankAccountNumber,
  }
  let candidate = await detectLedgerDuplicateVoucher(supabase, companyId, target)
  const skipped: string[] = []
  while (
    candidate &&
    opts?.skipClaimed &&
    (candidate.transaction_id !== null || (await isClaimedVoucher(supabase, companyId, candidate.journal_entry_id)))
  ) {
    if (skipped.length >= CLAIMED_SKIP_LIMIT) return null
    skipped.push(candidate.journal_entry_id)
    candidate = await detectLedgerDuplicateVoucher(supabase, companyId, target, { excludeJournalEntryIds: skipped })
  }
  if (!candidate) return null

  return {
    journal_entry_id: candidate.journal_entry_id,
    voucher_label: candidate.voucher_label,
    entry_date: candidate.entry_date,
    description: candidate.description,
    // A ledger candidate's amount is the matched leg's SEK figure, always set.
    amount: candidate.amount ?? 0,
    bank_account_number: candidate.account_number ?? bankAccountNumber ?? '',
    // When the amount test never ran, the reason must say so: labelling a
    // date-only survivor 'exact_amount_*' made the UI claim an amount match
    // that was never made.
    reason: !candidate.amount_verified
      ? 'date_window_only'
      : candidate.entry_date === transactionDate
        ? 'exact_amount_same_date'
        : 'exact_amount_within_window',
    amount_verified: candidate.amount_verified,
    unverified_reason: candidate.unverified_reason,
  }
}

/**
 * Whether a verifikat is already claimed as an invoice's booking: the payment
 * (supplier_invoice_payments, supplier_invoices.payment_journal_entry_id) or
 * registration verifikat of a supplier invoice, or a customer invoice payment.
 * Throws when a read fails, so the caller's detection-failure path runs.
 */
async function isClaimedVoucher(supabase: SupabaseClient, companyId: string, journalEntryId: string): Promise<boolean> {
  const reads = await Promise.all([
    supabase
      .from('supplier_invoice_payments')
      .select('id')
      .eq('company_id', companyId)
      .eq('journal_entry_id', journalEntryId)
      .limit(1),
    supabase
      .from('supplier_invoices')
      .select('id')
      .eq('company_id', companyId)
      .eq('payment_journal_entry_id', journalEntryId)
      .limit(1),
    supabase
      .from('supplier_invoices')
      .select('id')
      .eq('company_id', companyId)
      .eq('registration_journal_entry_id', journalEntryId)
      .limit(1),
    supabase
      .from('invoice_payments')
      .select('id')
      .eq('company_id', companyId)
      .eq('journal_entry_id', journalEntryId)
      .limit(1),
  ])
  if (reads.some((read) => read.error)) throw new Error('duplicate-payment check: voucher claim lookup failed')
  return reads.some((read) => Array.isArray(read.data) && read.data.length > 0)
}

// ============================================================
// Explaining voucher SET: one bank row, one or several vouchers
// ============================================================

/** ± days around the bank row considered "the same payment" for a set. */
const SET_DATE_WINDOW_DAYS = 7

/** Largest set of vouchers offered as the explanation of one bank row. */
export const EXPLAINING_SET_MAX_VOUCHERS = 4

const DAY_MS = 24 * 3600 * 1000

/** Max journal_entry ids per link-anchor `.in()` filter: keeps the request URL short. */
const LINK_LOOKUP_CHUNK = 100

export interface ExplainingVoucher {
  journal_entry_id: string
  voucher_label: string
  voucher_series: string | null
  voucher_number: number | null
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

/** One row of get_unexplained_bank_legs: a leg flattened with its entry. */
interface UnexplainedLegRow {
  journal_entry_id: string
  entry_date: string
  description: string | null
  voucher_series: string | null
  voucher_number: number | null
  status: string
  source_type: string | null
  account_number: string
  debit_amount: number | string | null
  credit_amount: number | string | null
}

/** A bank leg with its parent entry, as {@link fetchBankLegs} returns it. */
interface BankLegRow {
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

type SetCandidate = ExplainingVoucher & { dateDistanceDays: number; id: string }

type PaymentLinkRow = { journal_entry_id: string | null; transaction_id: string | null }

/** The row's SEK target, direction and ±window; null when it cannot take part. */
interface SetTarget {
  targetSek: number
  /** Money in: the voucher DEBITS the bank account. Money out: it CREDITS it. */
  inbound: boolean
  dateMs: number
  lowDate: string
  highDate: string
}

function isoDateOffset(dateMs: number, days: number): string {
  return new Date(dateMs + days * DAY_MS).toISOString().split('T')[0]
}

/**
 * Reversals, corrections and opening balances are bookkeeping scaffolding,
 * never the payment itself (the reconciliation RPCs drop the same three).
 */
function isScaffoldingEntry(sourceType: string | null): boolean {
  return sourceType === 'storno' || sourceType === 'correction' || sourceType === 'opening_balance'
}

/**
 * Returns null when the row cannot be stated in SEK (a foreign row with no
 * stored rate): a set cannot be summed in an unknown unit, and the 1:1
 * detector's `amount_verified: false` path already surfaces that case.
 */
function prepareSetTarget(args: {
  transactionDate: string
  transactionAmount: number
  transactionCurrency: string | null
  transactionAmountSek?: number | null
  transactionExchangeRate?: number | null
}): SetTarget | null {
  if (Math.round(Math.abs(args.transactionAmount) * 100) === 0) return null
  const signedSek = resolveTransactionAmountSek({
    amount: args.transactionAmount,
    currency: args.transactionCurrency,
    amount_sek: args.transactionAmountSek,
    exchange_rate: args.transactionExchangeRate,
  })
  if (signedSek === null) return null
  const targetSek = roundOre(Math.abs(signedSek))
  if (targetSek === 0) return null
  const dateMs = new Date(args.transactionDate).getTime()
  if (Number.isNaN(dateMs)) return null
  return {
    targetSek,
    inbound: args.transactionAmount > 0,
    dateMs,
    lowDate: isoDateOffset(dateMs, -SET_DATE_WINDOW_DAYS),
    highDate: isoDateOffset(dateMs, SET_DATE_WINDOW_DAYS),
  }
}

/**
 * Posted legs on the settlement account (or the whole 19xx range) dated
 * within [lowDate, highDate]. `inbound` true fetches debits, false credits,
 * null both (the batch path filters direction per row in memory). Throws
 * when the read fails; callers fail open.
 */
async function fetchBankLegs(
  supabase: SupabaseClient,
  args: {
    companyId: string
    lowDate: string
    highDate: string
    bankAccountNumber: string | null
    inbound: boolean | null
  },
): Promise<BankLegRow[]> {
  const account = args.bankAccountNumber?.trim() || null
  return fetchEntryLines<BankLegRow>({
    supabase,
    entryColumns:
      'id, entry_date, description, voucher_series, voucher_number, status, source_type, company_id',
    lineColumns: 'account_number, debit_amount, credit_amount',
    filterEntries: (q: EntryLinesQuery) =>
      q
        .eq('company_id', args.companyId)
        .eq('status', 'posted')
        .gte('entry_date', args.lowDate)
        .lte('entry_date', args.highDate),
    filterLines: (q: EntryLinesQuery) => {
      const scoped = account
        ? q.eq('account_number', account)
        : q.gte('account_number', String(BANK_ACCOUNT_LOW)).lte('account_number', String(BANK_ACCOUNT_HIGH))
      if (args.inbound === null) return scoped
      return args.inbound ? scoped.gt('debit_amount', 0) : scoped.gt('credit_amount', 0)
    },
    attachEntriesAs: 'journal_entry',
  })
}

/**
 * Pure: the candidates for ONE bank row from legs already fetched. One
 * candidate per voucher and account: a voucher with two legs on the same
 * account (a split payment line) is summed, a voucher touching two bank
 * accounts (a transfer) keeps its largest leg so it can appear once. Legs
 * outside the row's window, in the wrong direction, or on scaffolding
 * entries never take part.
 */
function collectSetCandidates(legs: BankLegRow[], target: SetTarget): Map<string, SetCandidate> {
  const byEntry = new Map<string, SetCandidate>()
  for (const leg of legs) {
    const entry = leg.journal_entry
    if (isScaffoldingEntry(entry.source_type)) continue
    if (entry.entry_date < target.lowDate || entry.entry_date > target.highDate) continue
    const raw = target.inbound ? leg.debit_amount : leg.credit_amount
    const amount = roundOre(Number(raw))
    if (!(amount > 0)) continue
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
      voucher_label: formatVoucher(entry),
      voucher_series: entry.voucher_series,
      voucher_number: entry.voucher_number,
      entry_date: entry.entry_date,
      description: entry.description,
      source_type: entry.source_type,
      amount,
      bank_account_number: leg.account_number,
      dateDistanceDays: Number.isNaN(entryMs)
        ? SET_DATE_WINDOW_DAYS
        : Math.round(Math.abs(entryMs - target.dateMs) / DAY_MS),
    })
  }
  return byEntry
}

/**
 * Voucher ids a bank transaction already explains, through any of the three
 * anchors isTransactionBooked reads (transactions.journal_entry_id, a payment
 * row carrying a bank transaction, a transaction_voucher_links row). A payment
 * row WITHOUT a bank transaction is a manual settlement (#2019) and keeps the
 * voucher in play: its bank line is precisely what has not been matched yet.
 * Rows in `ownTransactionIds` never count as links: the guard runs before the
 * caller's row is linked, and the batch path passes the very rows it is
 * explaining. Every lookup is company-scoped (defense in depth) and chunked
 * so a wide window never pushes the .in() past URL limits.
 *
 * Returns null when a lookup resolves with an error: a PostgREST failure
 * resolves with { data: null, error } rather than throwing, and reading that
 * as "no links" would offer a voucher a bank row already settles. Null fails
 * open like a thrown scan: the guard stays advisory and the booking RPC
 * keeps the last word.
 */
async function fetchExplainedVoucherIds(
  supabase: SupabaseClient,
  companyId: string,
  entryIds: string[],
  ownTransactionIds: ReadonlySet<string>,
): Promise<Set<string> | null> {
  const linkedIds = new Set<string>()
  for (let i = 0; i < entryIds.length; i += LINK_LOOKUP_CHUNK) {
    const chunk = entryIds.slice(i, i + LINK_LOOKUP_CHUNK)
    const [paymentLinksRes, supplierPaymentLinksRes, txLinksRes, junctionLinksRes] =
      await Promise.all([
        supabase
          .from('invoice_payments')
          .select('journal_entry_id, transaction_id')
          .eq('company_id', companyId)
          .in('journal_entry_id', chunk),
        supabase
          .from('supplier_invoice_payments')
          .select('journal_entry_id, transaction_id')
          .eq('company_id', companyId)
          .in('journal_entry_id', chunk),
        supabase
          .from('transactions')
          .select('id, journal_entry_id')
          .eq('company_id', companyId)
          .in('journal_entry_id', chunk),
        supabase
          .from('transaction_voucher_links')
          .select('journal_entry_id')
          .eq('company_id', companyId)
          .in('journal_entry_id', chunk),
      ])
    if (paymentLinksRes.error || supplierPaymentLinksRes.error || txLinksRes.error || junctionLinksRes.error) {
      return null
    }
    for (const row of [
      ...((paymentLinksRes.data ?? []) as PaymentLinkRow[]),
      ...((supplierPaymentLinksRes.data ?? []) as PaymentLinkRow[]),
    ]) {
      if (row.journal_entry_id && row.transaction_id) linkedIds.add(row.journal_entry_id)
    }
    for (const row of (txLinksRes.data ?? []) as { id: string; journal_entry_id: string | null }[]) {
      if (row.journal_entry_id && !ownTransactionIds.has(row.id)) linkedIds.add(row.journal_entry_id)
    }
    for (const row of (junctionLinksRes.data ?? []) as { journal_entry_id: string | null }[]) {
      if (row.journal_entry_id) linkedIds.add(row.journal_entry_id)
    }
  }
  return linkedIds
}

/**
 * Pure: the best set on one settlement account. Sets never mix accounts: the
 * link that resolves the warning is made on one account. Closest account
 * first, then findExactCoveringSet's order (smallest set, then closest in
 * date).
 */
function pickExplainingSet(
  pool: SetCandidate[],
  targetSek: number,
  transactionDate: string,
): ExplainingVoucherSet | null {
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
 * locations isTransactionBooked reads, seen from the voucher side
 * (fetchExplainedVoucherIds).
 *
 * Composed of the same steps the batch form (detectExplainingVoucherSets)
 * runs per row, so the booking doors and the reconciliation view share one
 * definition of "explained by the ledger".
 */
export async function detectExplainingVoucherSet(
  supabase: SupabaseClient,
  args: DetectSetArgs,
): Promise<ExplainingVoucherSet | null> {
  const target = prepareSetTarget(args)
  if (!target) return null

  let legs: BankLegRow[]
  try {
    legs = await fetchBankLegs(supabase, {
      companyId: args.companyId,
      lowDate: target.lowDate,
      highDate: target.highDate,
      bankAccountNumber: args.bankAccountNumber ?? null,
      inbound: target.inbound,
    })
  } catch {
    // Fail-open like the 1:1 detector: a detection failure must not block a
    // booking. Callers log the miss.
    return null
  }
  if (legs.length === 0) return null

  const candidates = collectSetCandidates(legs, target)
  if (candidates.size === 0) return null

  const linkedIds = await fetchExplainedVoucherIds(
    supabase,
    args.companyId,
    Array.from(candidates.keys()),
    new Set([args.transactionId]),
  )
  if (!linkedIds) return null

  const pool = Array.from(candidates.values()).filter((c) => !linkedIds.has(c.journal_entry_id))
  if (pool.length === 0) return null
  return pickExplainingSet(pool, target.targetSek, args.transactionDate)
}

/** The transaction columns the batch detector needs. */
export interface ExplainingSetBatchRow {
  id: string
  date: string
  amount: number
  currency: string | null
  amount_sek?: number | null
  exchange_rate?: number | null
}

/**
 * The set detector over MANY rows of one settlement account with one ledger
 * scan: the read path's form (#2293). The bridge table asks "is any open row
 * explained by the ledger?" for every row it lists; running the single
 * detector per row would cost five queries a row. This fetches the account's
 * legs once over the union of the rows' windows and the link anchors once,
 * then evaluates each row exactly as detectExplainingVoucherSet does (same
 * candidates, same anchors, same search).
 *
 * A voucher explains at most ONE row per call. The 1:N link that confirms a
 * proposal does not refuse a voucher another row already settles (manualLink
 * documents why N:1 is allowed), so two rows proposing the same voucher would
 * both confirm cleanly and settle it twice. Rows are assigned greedily:
 * same-date sets first, then smaller sets, then older rows; a row whose set
 * was partly consumed is searched again against what is left.
 *
 * Rows that cannot be stated in SEK or carry no amount are skipped. Fails
 * open (empty map) when the scan or a link lookup fails, like the single
 * detector; callers log the miss.
 */
export async function detectExplainingVoucherSets(
  supabase: SupabaseClient,
  args: { companyId: string; bankAccountNumber: string | null; transactions: ExplainingSetBatchRow[] },
): Promise<Map<string, ExplainingVoucherSet>> {
  const result = new Map<string, ExplainingVoucherSet>()

  const prepared: Array<{ row: ExplainingSetBatchRow; target: SetTarget }> = []
  for (const row of args.transactions) {
    const target = prepareSetTarget({
      transactionDate: row.date,
      transactionAmount: Number(row.amount),
      transactionCurrency: row.currency,
      transactionAmountSek: row.amount_sek ?? null,
      transactionExchangeRate: row.exchange_rate ?? null,
    })
    if (target) prepared.push({ row, target })
  }
  if (prepared.length === 0) return result

  let lowDate = prepared[0].target.lowDate
  let highDate = prepared[0].target.highDate
  for (const { target } of prepared) {
    if (target.lowDate < lowDate) lowDate = target.lowDate
    if (target.highDate > highDate) highDate = target.highDate
  }

  // The legs nothing explains yet, in one read: get_unexplained_bank_legs
  // (20261023094100) applies fetchBankLegs' window and account filter, drops
  // the scaffolding verifikat and every verifikat fetchExplainedVoucherIds
  // would report as explained, and keeps the legs' line order. The single
  // detector keeps its own reads.
  let legRows: UnexplainedLegRow[]
  try {
    const { data, error } = await supabase.rpc('get_unexplained_bank_legs', {
      p_company_id: args.companyId,
      p_account_number: args.bankAccountNumber?.trim() || null,
      p_low: lowDate,
      p_high: highDate,
      p_own_transaction_ids: prepared.map((p) => p.row.id),
    })
    if (error) return result
    legRows = (data ?? []) as UnexplainedLegRow[]
  } catch {
    return result
  }
  const legs: BankLegRow[] = legRows.map((r) => ({
    account_number: r.account_number,
    debit_amount: r.debit_amount,
    credit_amount: r.credit_amount,
    journal_entry: {
      id: r.journal_entry_id,
      entry_date: r.entry_date,
      description: r.description,
      voucher_series: r.voucher_series,
      voucher_number: r.voucher_number,
      status: r.status,
      source_type: r.source_type,
    },
  }))
  if (legs.length === 0) return result
  const linkedIds = new Set<string>()

  const consumed = new Set<string>()
  const search = ({ row, target }: { row: ExplainingSetBatchRow; target: SetTarget }) => {
    const pool = Array.from(collectSetCandidates(legs, target).values()).filter(
      (c) => !linkedIds.has(c.journal_entry_id) && !consumed.has(c.journal_entry_id),
    )
    return pool.length === 0 ? null : pickExplainingSet(pool, target.targetSek, row.date)
  }

  // Every row against the whole pool first, then the strongest claims settle first.
  const claims: Array<{ row: ExplainingSetBatchRow; target: SetTarget; set: ExplainingVoucherSet }> = []
  for (const p of prepared) {
    const set = search(p)
    if (set) claims.push({ ...p, set })
  }
  claims.sort(
    (a, b) =>
      Number(b.set.same_date) - Number(a.set.same_date) ||
      a.set.vouchers.length - b.set.vouchers.length ||
      a.row.date.localeCompare(b.row.date) ||
      a.row.id.localeCompare(b.row.id),
  )
  for (const claim of claims) {
    const set = claim.set.vouchers.some((v) => consumed.has(v.journal_entry_id)) ? search(claim) : claim.set
    if (!set) continue
    result.set(claim.row.id, set)
    for (const v of set.vouchers) consumed.add(v.journal_entry_id)
  }
  return result
}

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
 * The ledger account a bank row settles on: its cash account's
 * ledger_account. `accountNumber` is null when the row has no cash account
 * (or the account names no ledger), and the detectors then scan the whole
 * 19xx range as before. `ok: false` when the lookup failed: without the
 * account a scan would widen to every 19xx account, an unverified answer, so
 * both detectors throw on it and their callers' failure path decides.
 */
export async function resolveCashAccountLedger(
  supabase: SupabaseClient,
  companyId: string,
  cashAccountId: string | null | undefined,
): Promise<{ ok: true; accountNumber: string | null } | { ok: false }> {
  if (!cashAccountId) return { ok: true, accountNumber: null }
  const { data, error } = await supabase
    .from('cash_accounts')
    .select('ledger_account')
    .eq('id', cashAccountId)
    .eq('company_id', companyId)
    .maybeSingle()
  if (error) return { ok: false }
  return { ok: true, accountNumber: (data?.ledger_account as string | null) ?? null }
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

  // Without the account the scan would widen to every 19xx account: an
  // unverified answer. A failed lookup throws, like the 1:1 detector, so the
  // caller's detection-failure path runs instead of a silent "no set".
  const ledger = await resolveCashAccountLedger(supabase, companyId, row.cash_account_id)
  if (!ledger.ok) throw new Error('explaining-voucher check: cash account lookup failed')
  const bankAccountNumber = ledger.accountNumber

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
