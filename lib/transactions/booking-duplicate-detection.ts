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
 *
 * Units: every amount comparison in this file happens in SEK. See
 * {@link resolveTransactionAmountSek} for why, and for what happens when a bank
 * line cannot be expressed in SEK at all.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { roundOre } from '@/lib/money'
import { resolveSekAmountOrNull } from '@/lib/bookkeeping/currency-utils'
import { fetchEntryLines, type EntryLinesQuery } from '@/lib/bookkeeping/entry-lines'
import { getPrimaryJournalEntryId } from '@/lib/transactions/is-booked'

/** Integer öre: representation-agnostic amount key (mirrors the ingest dedup). */
function toOre(amount: number | string): number {
  return Math.round(Number(amount) * 100)
}

/** The `transactions` columns needed to state a bank line's amount in SEK. */
export interface TransactionAmountFields {
  /** `transactions.amount`, denominated in `currency`: NOT necessarily SEK. */
  amount: number | string
  /**
   * `transactions.currency`. REQUIRED, not optional, on purpose: an optional
   * field reads as `undefined` for any caller that projects a narrow column
   * list instead of `select('*')`, `undefined` would have to be defaulted to
   * SEK, and that default silently switches off the FX half of this guard for
   * exactly the rows it exists to catch. Required turns that mistake into a
   * compile error at every call site. Null is fine and means SEK: it is
   * PostgREST's shape for the column's 'SEK' default.
   */
  currency: string | null
  /** `transactions.amount_sek`: `amount` converted at ingest. Null = no rate stored. */
  amount_sek?: number | string | null
  /** `transactions.exchange_rate`: SEK per 1 unit of `currency`. */
  exchange_rate?: number | string | null
}

/**
 * A bank line's magnitude in SEK, or null when it cannot be established.
 *
 * WHY THIS EXISTS. `transactions.amount` is denominated in
 * `transactions.currency`, while `journal_entry_lines.debit_amount` /
 * `credit_amount` are ALWAYS SEK: lib/bookkeeping/currency-utils.ts converts the
 * foreign figure to SEK for those columns and then stamps `currency` +
 * `amount_in_currency` onto the SAME line as metadata describing the source
 * DOCUMENT. So `journal_entry_lines.currency` is a label, never evidence that
 * the debit/credit figure is in that currency, and any guard shaped like "the
 * currencies match, so the amounts are comparable" passes on precisely the FX
 * rows it exists to catch. Comparing a raw EUR `transactions.amount` against a
 * leg got it wrong twice over: it never matched the real EUR twin (so a foreign
 * affärshändelse could be booked a second time with nothing objecting, BFL 5 kap
 * 1-2 §: one affärshändelse, one verifikation), and it did match unrelated SEK
 * vouchers of the same magnitude.
 *
 * BASIS: SEK, for both halves of this file, because it is the only unit both
 * sides can always reach. Note the deliberate asymmetry with
 * `ledgerLineAmountIn()` in lib/reconciliation/bank-reconciliation.ts, which
 * resolves ledger lines in the ACCOUNT's currency: there the whole statement
 * being reconciled is foreign, whereas here the twin being hunted is usually an
 * ordinary SEK verifikat (an invoice marked paid, a salary payout, a
 * hand-posted entry) that carries no `amount_in_currency` at all. Comparing in
 * EUR would resolve every one of those to null and reopen the double-booking
 * hole this guard exists to close.
 *
 * Returning null rather than falling back to the raw foreign number (which is
 * what `resolveSekAmount()` in currency-utils does, tolerably, for a line
 * amount that only has to balance against itself) is the whole point: guessing
 * the unit IS the bug. Mirrors `resolveSekAmountOrNull()` in
 * lib/bookkeeping/mapping-engine.ts, which draws the same line for the same
 * reason. Callers must treat null as "could not verify", never as "no match".
 */
export function resolveTransactionAmountSek(tx: TransactionAmountFields): number | null {
  const amount = Number(tx.amount)
  if (!Number.isFinite(amount)) return null

  // SEK rows short-circuit before any FX field is read, so a SEK-only company
  // behaves exactly as it did before this guard learned about currencies.
  const currency = (tx.currency || 'SEK').toUpperCase()
  if (currency === 'SEK') return roundOre(Math.abs(amount))

  if (tx.amount_sek != null) {
    const sek = Number(tx.amount_sek)
    if (Number.isFinite(sek)) return roundOre(Math.abs(sek))
  }
  if (tx.exchange_rate != null) {
    const rate = Number(tx.exchange_rate)
    if (Number.isFinite(rate) && rate > 0) return roundOre(Math.abs(amount) * rate)
  }

  // Non-SEK row carrying neither a converted amount nor a rate: the shape a row
  // gets when the Riksbanken lookup failed at ingest (lib/currency/riksbanken.ts
  // deliberately inserts without amount_sek rather than inventing a rate).
  return null
}

/** An already-booked transaction OR voucher that looks like the same real movement. */
export interface BookedDuplicateCandidate {
  /**
   * The already-booked twin TRANSACTION, or `null` when the duplicate is a
   * ledger-only voucher (a payment/payout booked straight to the cash account
   * with no transaction row behind it: see detectLedgerDuplicateVoucher). Set
   * by the sibling detector, and ALSO by the ledger detector when the matched
   * voucher's linking transaction is itself the target's twin (the
   * date-drifted duplicate-import shape): consumers must branch on this field,
   * not on which detector produced the candidate.
   */
  transaction_id: string | null
  /** Its verifikat. */
  journal_entry_id: string
  /** Human label, e.g. "A142" (voucher_series + voucher_number). */
  voucher_label: string
  entry_date: string
  description: string | null
  /**
   * ALWAYS a SEK figure or null, NEVER a foreign number: every consumer labels
   * this field "kr" (DuplicateBookingDialog renders it through the SEK-default
   * `formatCurrency()`, and the agent-path messages append "kr" verbatim).
   *
   * Ledger-voucher candidate: the matched 19xx leg's debit/credit column,
   * which is SEK by construction, so always present.
   *
   * Sibling-transaction candidate: the sibling row's OWN SEK value via the
   * strict `resolveSekAmountOrNull()` ladder (amount as-is when SEK, else
   * amount_sek, else amount * exchange_rate), signed like the row. NULL when
   * the sibling is foreign and carries neither: a foreign amount with no
   * stored rate has no SEK value, and refusing beats fabricating one on the
   * exact screen whose only question is "is this the same event?". Renderers
   * must fall back to `amount_in_currency` + `currency` and say the kr value
   * is unavailable, never print a foreign number as kronor.
   */
  amount: number | null
  /**
   * The 19xx settlement account of the voucher leg that matched, set for
   * every ledger-detected candidate (twin-linked or not) so the match action
   * can link on the exact account the voucher was booked to (a legacy
   * transaction without cash_account_id would otherwise resolve by currency
   * and can pick the wrong 19xx). Null for sibling-transaction candidates,
   * whose legs are not fetched.
   */
  account_number: string | null
  /**
   * The sibling row's own denomination when it is not SEK: uppercased ISO code
   * plus `transactions.amount` as stored (öre-rounded, signed). Both null for
   * SEK siblings and for ledger-voucher candidates (whose matched leg is SEK
   * and carries no foreign context of its own). Naming mirrors the
   * journal-entry-line currency metadata (`currency` / `amount_in_currency`,
   * lib/bookkeeping/currency-utils.ts).
   */
  currency: string | null
  amount_in_currency: number | null
  /**
   * Whether the candidate's kr figure is fully established: the two amounts
   * were brought to a common unit AND `amount` above holds a real SEK figure.
   * True for every SEK candidate and for a foreign sibling whose own stored
   * conversion states it in kronor.
   *
   * False in two shapes, both surfaced rather than silently passed: staying
   * silent would let a second verifikat be minted for one affärshändelse (BFL
   * 5 kap 1-2 §: one affärshändelse, one verifikation), while hard-blocking
   * would refuse a booking the software cannot judge, and an unbooked
   * affärshändelse breaks löpande bokföring just as surely. So the guard warns
   * and leaves the call to the user.
   *
   * - Ledger-voucher candidate: the TARGET bank line could not be stated in
   *   SEK, so no amount comparison was possible at all; the candidate matches
   *   on date + bank account + direction alone (`amount` still holds the
   *   leg's SEK figure).
   * - Sibling-transaction candidate: the öre comparison DID hold, exactly, in
   *   the shared foreign currency, but the sibling row cannot state that
   *   figure in kronor, so `amount` is null and only `amount_in_currency` +
   *   `currency` may be shown.
   */
  amount_verified: boolean
  /**
   * Why the kr figure could not be fully established. Null whenever
   * `amount_verified`. `transaction_missing_sek_value`: a non-SEK
   * `transactions` row (the target bank line for a ledger-voucher candidate,
   * the already-booked sibling for a sibling-transaction candidate) carrying
   * neither `amount_sek` nor `exchange_rate` (see
   * {@link resolveTransactionAmountSek}).
   */
  unverified_reason: 'transaction_missing_sek_value' | null
}

/** Minimal shape of the transaction about to be booked. */
export interface BookingTarget extends TransactionAmountFields {
  id: string
  date: string
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
 * ± days around the target's date an already-booked SIBLING TRANSACTION may
 * sit and still be "the same" movement. A duplicate import of one real
 * movement often carries a drifted date (CSV bokföringsdag vs PSD2 valutadag,
 * a weekend in between), so an exact-date match missed exactly the twin this
 * guard exists to catch. Deliberately tighter than the voucher window below:
 * a sibling match additionally requires the exact öre amount in the same
 * currency, but adjacent-day repeated payments (Swish, weekly SaaS charges)
 * are common enough that a wide window would over-warn.
 */
const SIBLING_DUPLICATE_DATE_WINDOW_DAYS = 3

/**
 * Find an already-booked sibling transaction sharing (date-window, amount,
 * account). Returns the single best candidate, or null.
 *
 * Booked-ness uses the full is_transaction_booked semantics
 * (lib/transactions/is-booked.ts): a bare `transactions.journal_entry_id`
 * check misses bulk-booked rows (anchored via transaction_voucher_links) and
 * multi-allocated rows (anchored via invoice_payments /
 * supplier_invoice_payments), which read as "unbooked" and made the guard
 * blind to their twins. The anchor rows are batch-fetched for the windowed
 * candidates and the candidate's verifikat resolves via
 * getPrimaryJournalEntryId.
 *
 * Account guard mirrors the import dedup bridge: when BOTH sides know their
 * cash_account_id they must match; a null on either side is treated as
 * compatible (single-account companies and un-backfilled rows behave as before).
 *
 * Currency guard: both sides are `transactions.amount`, each denominated in its
 * own row's `transactions.currency` (which, unlike journal_entry_lines.currency,
 * really does label the adjacent amount). The öre comparison is only
 * like-with-like once those labels agree, so a mismatch is skipped outright: a
 * 100 EUR line and a 100 SEK line on the same day are not the same
 * affärshändelse. No SEK conversion is needed or wanted for the COMPARISON;
 * comparing in the shared currency is exact, whereas routing both through
 * amount_sek would make a 100 EUR row collide with an unrelated 1150 SEK row.
 * The REPORTED `amount` is a different matter: consumers label it "kr", so it
 * is the sibling's SEK figure (or null when that cannot be established), never
 * the raw foreign number: see the resolution at the bottom.
 *
 * Fail-open: a query error returns null rather than throwing: a detection
 * failure must never block a legitimate booking. The pick is deterministic:
 * smallest date distance first (an exact-date sibling always outranks a
 * drifted one), then earliest date, then lowest id, so a re-detection under
 * force=true returns the same candidate the user reviewed.
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
  // selected, not duplicates: never flag one against another. Same for
  // vouchers minted earlier in the run: a bulk-booked sibling resolves its
  // verifikat via transaction_voucher_links below, so the entry-id exclusion
  // applies here too.
  const excludeTransactionIds = new Set(opts?.excludeTransactionIds ?? [])
  const excludeJournalEntryIds = new Set(opts?.excludeJournalEntryIds ?? [])
  const targetCurrency = (target.currency || 'SEK').toUpperCase()

  const targetDateMs = new Date(target.date).getTime()
  if (Number.isNaN(targetDateMs)) return null
  const siblingWindowMs = SIBLING_DUPLICATE_DATE_WINDOW_DAYS * 24 * 3600 * 1000
  const siblingLowDate = new Date(targetDateMs - siblingWindowMs).toISOString().split('T')[0]
  const siblingHighDate = new Date(targetDateMs + siblingWindowMs).toISOString().split('T')[0]

  // Same company, date inside the sibling window, not the target row itself.
  // The amount, currency and account match is applied in JS so a
  // numeric-string amount from PostgREST ("-1616.00") collapses to the same
  // öre as the number (-1616). Booked-ness is resolved AFTER the fetch (see
  // below): filtering on journal_entry_id here would drop bulk-booked and
  // multi-allocated siblings whose column is NULL. Ordered so the row set is
  // deterministic even at the limit.
  const { data, error } = await supabase
    .from('transactions')
    .select('id, date, amount, currency, amount_sek, exchange_rate, description, cash_account_id, journal_entry_id')
    .eq('company_id', companyId)
    .gte('date', siblingLowDate)
    .lte('date', siblingHighDate)
    .neq('id', target.id)
    .order('id', { ascending: true })
    .limit(500)

  if (error || !data || data.length === 0) return null

  type Row = {
    id: string
    date: string
    amount: number | string
    currency: string | null
    amount_sek: number | string | null
    exchange_rate: number | string | null
    description: string | null
    cash_account_id: string | null
    journal_entry_id: string | null
  }
  const targetAccount = target.cash_account_id ?? null
  const matches = (data as unknown as Row[]).filter((r) => {
    if (excludeTransactionIds.has(r.id)) return false
    // Currency guard first: `amount` is only comparable to `amount` when both
    // rows are denominated in the same currency. Null normalises to SEK (the
    // column default), so SEK-only companies see no behaviour change.
    if ((r.currency || 'SEK').toUpperCase() !== targetCurrency) return false
    if (toOre(r.amount) !== targetOre) return false
    // Account guard: both-known must match; a null on either side is compatible.
    if (targetAccount !== null && r.cash_account_id !== null && r.cash_account_id !== targetAccount) {
      return false
    }
    // Window re-check in JS (the query already ranged on date): keeps the
    // window authoritative in one place and drops rows with unparseable dates.
    const rowMs = new Date(r.date).getTime()
    return Number.isFinite(rowMs) && Math.abs(rowMs - targetDateMs) <= siblingWindowMs
  })
  if (matches.length === 0) return null

  // Resolve booked-ness with the full is_transaction_booked semantics: the
  // anchor may live on the row itself (journal_entry_id), in
  // transaction_voucher_links (bulk-book), or in invoice_payments /
  // supplier_invoice_payments (multi-allocation). Batch-fetched only for the
  // rows whose own column is NULL. All lookups filter by company_id (defense
  // in depth alongside RLS).
  const unanchoredIds = matches.filter((r) => r.journal_entry_id == null).map((r) => r.id)
  let paymentRows: { transaction_id: string | null; journal_entry_id: string | null }[] = []
  let voucherLinkRows: { transaction_id: string; journal_entry_id: string }[] = []
  if (unanchoredIds.length > 0) {
    const [vl, ip, sp] = await Promise.all([
      supabase
        .from('transaction_voucher_links')
        .select('transaction_id, journal_entry_id')
        .eq('company_id', companyId)
        .in('transaction_id', unanchoredIds),
      supabase
        .from('invoice_payments')
        .select('transaction_id, journal_entry_id')
        .eq('company_id', companyId)
        .in('transaction_id', unanchoredIds),
      supabase
        .from('supplier_invoice_payments')
        .select('transaction_id, journal_entry_id')
        .eq('company_id', companyId)
        .in('transaction_id', unanchoredIds),
    ])
    voucherLinkRows = (vl.data ?? []) as { transaction_id: string; journal_entry_id: string }[]
    paymentRows = [...(ip.data ?? []), ...(sp.data ?? [])] as {
      transaction_id: string | null
      journal_entry_id: string | null
    }[]
  }

  const booked = matches
    .map((r) => ({
      row: r,
      journalEntryId: getPrimaryJournalEntryId(r, paymentRows, voucherLinkRows),
    }))
    .filter(
      (x): x is { row: Row; journalEntryId: string } =>
        x.journalEntryId != null && !excludeJournalEntryIds.has(x.journalEntryId),
    )
  if (booked.length === 0) return null

  // Deterministic pick, and exact-date candidates MUST outrank drifted ones:
  // force=true re-detection is bound to the candidate the user reviewed
  // (TRANSACTION_BOOK_FORCE_CANDIDATE_MISMATCH otherwise), so the ranking has
  // explicit total-order tiebreakers.
  booked.sort((a, b) => {
    const ad = Math.abs(new Date(a.row.date).getTime() - targetDateMs)
    const bd = Math.abs(new Date(b.row.date).getTime() - targetDateMs)
    if (ad !== bd) return ad - bd
    if (a.row.date !== b.row.date) return a.row.date < b.row.date ? -1 : 1
    return a.row.id.localeCompare(b.row.id)
  })
  const best = booked[0].row
  const bestJournalEntryId = booked[0].journalEntryId

  // Resolve the voucher label for the warning (best-effort: a missing label
  // still yields a usable candidate the UI can render by date/amount).
  let voucherLabel = ''
  let entryDate = best.date
  const { data: je } = await supabase
    .from('journal_entries')
    .select('voucher_series, voucher_number, entry_date')
    .eq('id', bestJournalEntryId)
    .maybeSingle()
  if (je) {
    const j = je as { voucher_series: string | null; voucher_number: number | null; entry_date: string | null }
    voucherLabel = `${j.voucher_series ?? 'A'}${j.voucher_number ?? ''}`
    entryDate = j.entry_date ?? best.date
  }

  // The reported amount must be SEK: every consumer labels it "kr" (the ledger
  // branch below returns the 19xx leg's SEK figure for exactly this reason;
  // the two branches must agree). The öre comparison above was exact in the
  // shared currency, so the MATCH stands either way; what can be missing is
  // only the sibling row's statement of that figure in kronor.
  // resolveSekAmountOrNull() is the strict ladder (SEK as-is, else amount_sek,
  // else amount * exchange_rate) and refuses with null rather than inventing a
  // rate. The TARGET's rate is deliberately not borrowed for the sibling: the
  // sibling's verifikat was booked at the sibling's own rate, and a kr figure
  // the user cannot find on that verifikat would mislead on the exact screen
  // whose only question is "is this the same event?".
  const rowCurrency = (best.currency || 'SEK').toUpperCase()
  // PostgREST numerics may arrive as strings; a non-numeric value collapses to
  // null here so the strict ladder refuses instead of propagating NaN (same
  // Number.isFinite discipline as resolveTransactionAmountSek above).
  const bestAmountSek = best.amount_sek != null && Number.isFinite(Number(best.amount_sek))
    ? Number(best.amount_sek)
    : null
  const bestRate = best.exchange_rate != null && Number.isFinite(Number(best.exchange_rate))
    ? Number(best.exchange_rate)
    : null
  const bestSek = resolveSekAmountOrNull(Number(best.amount), bestAmountSek, rowCurrency, bestRate)

  return {
    transaction_id: best.id,
    journal_entry_id: bestJournalEntryId,
    voucher_label: voucherLabel,
    entry_date: entryDate,
    description: best.description,
    // Always SEK or null, never the raw foreign number: a foreign amount in
    // this field gets printed with "kr" after it (the original bug).
    amount: bestSek != null ? roundOre(bestSek) : null,
    account_number: null,
    currency: rowCurrency === 'SEK' ? null : rowCurrency,
    amount_in_currency: rowCurrency === 'SEK' ? null : roundOre(Number(best.amount)),
    // Both sides passed the currency guard above, so the öre comparison that
    // selected this row was made in one unit. amount_verified additionally
    // requires the kr figure itself: a rateless foreign sibling matched
    // exactly but cannot be stated in kronor, and saying so beats fabricating.
    amount_verified: bestSek != null,
    unverified_reason: bestSek != null ? null : 'transaction_missing_sek_value',
  }
}

/** ± days around the bank-tx date a voucher may be dated and still be "the same" movement. */
const VOUCHER_DUPLICATE_DATE_WINDOW_DAYS = 7

/**
 * ± days a voucher may be dated from a bank line whose amount CANNOT be
 * verified (rateless foreign target) and still be NAMED as a candidate. When
 * the amount test is skipped, date + account + direction are the only
 * remaining evidence, and the full ±7 day window is far too wide for that:
 * the closest-date pick would attribute an arbitrary unrelated voucher to the
 * bank line in the user-facing "Möjlig dubblettbokföring: verifikat ..."
 * message. One day keeps the honest "beloppen kunde inte jämföras" warning
 * for a genuinely adjacent booking without pointing at the wrong verifikat.
 */
const UNVERIFIED_VOUCHER_DATE_WINDOW_DAYS = 1

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
 * Direction reads off the sign of `target.amount`, which is unit-independent.
 *
 * Amounts are compared in SEK (see {@link resolveTransactionAmountSek}): the
 * 19xx leg's debit/credit column already IS the SEK figure, so it is used
 * as-is, and `line.currency` is deliberately never consulted (it labels the
 * source document, not the leg). A bank line whose SEK value cannot be
 * established does not silently pass: see `amount_verified` on the result,
 * and note the tighter ±1 day naming window that applies to exactly that
 * case ({@link UNVERIFIED_VOUCHER_DATE_WINDOW_DAYS}).
 *
 * Account-aware: when the bank line knows its cash account, the matching leg
 * must be on that account's ledger account; otherwise any 19xx leg matches
 * (single-account companies, legacy rows with no cash_account_id).
 *
 * Excludes vouchers already linked to a transaction or an invoice_payment
 * (those are reconciled, not orphans) and storno/correction entries (valid
 * second vouchers, not duplicates): EXCEPT a voucher whose linking transaction
 * itself matches the target (same öre in the same currency, compatible
 * account, date in the window), which is returned as the twin with
 * `transaction_id` set. Fail-open: a query error returns null so a detection
 * failure never blocks a legitimate booking. The pick is deterministic
 * (closest date, then lowest journal_entry id, then account) so a force
 * re-detect is stable.
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
  // Null when this is a non-SEK bank line with no rate: the amounts then cannot
  // be compared at all, which is handled below rather than swept under a pass.
  const targetSek = resolveTransactionAmountSek(target)
  const inbound = targetOre > 0
  // For the linked-transaction twin test in the exclusion block below: the
  // linking transaction's `amount` is denominated in ITS OWN currency, so the
  // öre comparison is only like-with-like when the labels agree (same guard
  // as the sibling detector).
  const targetCurrency = (target.currency || 'SEK').toUpperCase()
  const targetAccount = target.cash_account_id ?? null

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

  // Two-step fetch instead of a `journal_entries!inner` embed: PostgREST
  // compiles that embed into a correlated LATERAL join that walks the ENTIRE
  // journal_entry_lines table across all tenants (see
  // lib/bookkeeping/entry-lines.ts). The scope is the same as before: this
  // company's posted entries inside the date window, with the 19xx leg picked
  // on the line side. The old `.limit(50)` is gone with the embed: the window
  // is ±7 days of one company's vouchers, and an arbitrary 50-row cap could
  // hide the real twin behind unrelated bank legs.
  let lines: LineRow[]
  try {
    lines = await fetchEntryLines<LineRow>({
      supabase,
      entryColumns: 'id, entry_date, description, voucher_series, voucher_number, status, source_type, company_id',
      lineColumns: 'account_number, debit_amount, credit_amount',
      filterEntries: (q: EntryLinesQuery) =>
        q
          .eq('company_id', companyId)
          .eq('status', 'posted')
          .gte('entry_date', lowDate)
          .lte('entry_date', highDate),
      filterLines: (q: EntryLinesQuery) => {
        const scoped = q.gt(amountColumn, 0)
        return settlementAccount
          ? scoped.eq('account_number', settlementAccount)
          : scoped
              .gte('account_number', String(BANK_ACCOUNT_LOW))
              .lte('account_number', String(BANK_ACCOUNT_HIGH))
      },
      // The old embed was aliased: journal_entry:journal_entries!inner(...).
      attachEntriesAs: 'journal_entry',
    })
  } catch {
    // Fail-open, as before: a detection failure must never block a booking.
    return null
  }
  if (lines.length === 0) return null

  const sameMovement = lines
    // Same-batch vouchers are this run's own fresh bookings, never duplicates.
    .filter((l) => !excludeJournalEntryIds.has(l.journal_entry.id))
    // Reversals/corrections are valid second vouchers, not duplicate bookings.
    .filter((l) => l.journal_entry.source_type !== 'storno' && l.journal_entry.source_type !== 'correction')

  // The amount test compares the bank line's SEK value against the leg's
  // debit/credit column, which is already SEK. When the bank line has no SEK
  // value there is nothing to test with, so the test is SKIPPED rather than
  // failed: failing it would drop every survivor and return null, and a null
  // here reads as "go ahead", which is how one affärshändelse ends up with two
  // verifikationer. The survivors are reported as unverified instead: BUT only
  // those within ±1 day of the bank line. Without an amount comparison, date
  // proximity is the only evidence left, and naming the closest voucher in a
  // ±7 day window would attribute an unrelated verifikat to this bank line in
  // the user-facing warning (the lowest-id pick is deterministic, not right).
  //
  // The EXISTENCE half of the question still holds without any currency: the
  // direction, settlement-account, date-window and posted filters above are all
  // unit-free, so an empty `sameMovement` really does mean there is no ledger
  // twin, and returning null there is a verified pass, not a silent one.
  const unverifiedWindowMs = UNVERIFIED_VOUCHER_DATE_WINDOW_DAYS * 24 * 3600 * 1000
  const candidates =
    targetSek === null
      ? sameMovement.filter((l) => {
          const legMs = new Date(l.journal_entry.entry_date).getTime()
          return Number.isFinite(legMs) && Math.abs(legMs - dateMs) <= unverifiedWindowMs
        })
      : sameMovement.filter((l) => {
          const legSek = roundOre(Number(inbound ? l.debit_amount : l.credit_amount))
          return Math.abs(legSek - targetSek) < 0.01
        })

  if (candidates.length === 0) return null

  // Drop vouchers already reconciled to a transaction or an invoice payment:
  // those aren't orphans. Both lookups are filtered by company_id (defense in
  // depth alongside RLS).
  //
  // EXCEPTION: a voucher whose linking transaction ITSELF looks like the
  // target's twin (same öre in the same currency, compatible cash account,
  // date inside the window) is NOT "reconciled to something else": that shape
  // is a date-drifted duplicate import row whose copy is already booked.
  // Excluding it made the guard blind to exactly that double-booking (the
  // sibling scan missed on date, this scan dropped the voucher as linked).
  // Such a voucher is returned as the twin WITH transaction_id set so the UI
  // can offer match/ignore instead of a blind second booking.
  const entryIds = candidates.map((l) => l.journal_entry.id)
  const [{ data: txLinks }, { data: payLinks }] = await Promise.all([
    supabase
      .from('transactions')
      .select('id, date, amount, currency, cash_account_id, journal_entry_id')
      .eq('company_id', companyId)
      .in('journal_entry_id', entryIds),
    supabase
      .from('invoice_payments')
      .select('journal_entry_id, transaction_id')
      .eq('company_id', companyId)
      .in('journal_entry_id', entryIds),
  ])

  type LinkedTxRow = {
    id: string
    date: string
    amount: number | string
    currency: string | null
    cash_account_id: string | null
    journal_entry_id: string | null
  }
  const linkedTxMatchesTarget = (r: LinkedTxRow): boolean => {
    if (r.id === target.id) return false
    if ((r.currency || 'SEK').toUpperCase() !== targetCurrency) return false
    if (toOre(r.amount) !== targetOre) return false
    if (targetAccount !== null && r.cash_account_id !== null && r.cash_account_id !== targetAccount) {
      return false
    }
    const linkedMs = new Date(r.date).getTime()
    return Number.isFinite(linkedMs) && Math.abs(linkedMs - dateMs) <= windowMs
  }

  const linkedTxByEntry = new Map<string, LinkedTxRow[]>()
  for (const r of (txLinks ?? []) as LinkedTxRow[]) {
    if (!r.journal_entry_id) continue
    const arr = linkedTxByEntry.get(r.journal_entry_id) ?? []
    arr.push(r)
    linkedTxByEntry.set(r.journal_entry_id, arr)
  }
  // Only a payment row that carries a bank transaction means "reconciled to
  // a bank line". A row with transaction_id NULL is a manual / Stripe
  // settlement (#2019): the bank line for that money is still to come, and
  // this voucher must stay a twin candidate so the user is offered a link
  // instead of a blind second booking.
  const paymentLinked = new Set<string>()
  for (const r of (payLinks ?? []) as { journal_entry_id: string | null; transaction_id: string | null }[]) {
    if (r.journal_entry_id && r.transaction_id) paymentLinked.add(r.journal_entry_id)
  }

  const survivors: { line: (typeof candidates)[number]; twinTransactionId: string | null }[] = []
  for (const l of candidates) {
    const entryId = l.journal_entry.id
    const links = linkedTxByEntry.get(entryId) ?? []
    // Deterministic twin pick within one voucher: lowest matching tx id.
    const matchingTwinIds = links
      .filter(linkedTxMatchesTarget)
      .map((r) => r.id)
      .sort((a, b) => a.localeCompare(b))
    if (matchingTwinIds.length > 0) {
      survivors.push({ line: l, twinTransactionId: matchingTwinIds[0] })
      continue
    }
    // Linked to a non-matching transaction or to an invoice payment: genuinely
    // reconciled to something else, not an orphan. Excluded as before.
    if (links.length > 0 || paymentLinked.has(entryId)) continue
    survivors.push({ line: l, twinTransactionId: null })
  }
  if (survivors.length === 0) return null

  survivors.sort((a, b) => {
    const ad = Math.abs(new Date(a.line.journal_entry.entry_date).getTime() - dateMs)
    const bd = Math.abs(new Date(b.line.journal_entry.entry_date).getTime() - dateMs)
    if (ad !== bd) return ad - bd
    if (a.line.journal_entry.id !== b.line.journal_entry.id) {
      return a.line.journal_entry.id.localeCompare(b.line.journal_entry.id)
    }
    // Same entry can expose two 19xx legs (own-account transfer): total order
    // keeps the force re-detect stable.
    return a.line.account_number.localeCompare(b.line.account_number)
  })
  const best = survivors[0].line

  return {
    // Set when the voucher's linking transaction is itself the target's twin
    // (the de-excluded shape above); null for a true ledger-only orphan.
    transaction_id: survivors[0].twinTransactionId,
    journal_entry_id: best.journal_entry.id,
    voucher_label: `${best.journal_entry.voucher_series ?? 'A'}${best.journal_entry.voucher_number ?? ''}`,
    entry_date: best.journal_entry.entry_date,
    description: best.journal_entry.description,
    // Always the leg's SEK figure, matched or not, so the UI never prints a
    // foreign number with "kr" after it.
    amount: roundOre(Number(inbound ? best.debit_amount : best.credit_amount)),
    account_number: best.account_number,
    // The matched leg is SEK by construction, so there is no foreign context
    // to carry (line.currency labels the source document, not the leg).
    currency: null,
    amount_in_currency: null,
    amount_verified: targetSek !== null,
    unverified_reason: targetSek === null ? 'transaction_missing_sek_value' : null,
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
