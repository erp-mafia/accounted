import type { SupabaseClient } from '@supabase/supabase-js'
import type { CashAccount, CashAccountSource, MappingResult } from '@/types'
import { createLogger } from '@/lib/logger'
import { syncMappedAccounts } from '@/lib/import/account-sync'
import { getBASReference } from '@/lib/bookkeeping/bas-reference'
import { fetchAllRows } from '@/lib/supabase/fetch-all'

const log = createLogger('cash-accounts')

/**
 * Suggested BAS account per currency. Single source — the enable-banking
 * callback and the AccountPickerDialog both key off these.
 */
export const CURRENCY_LEDGER_DEFAULTS: Record<string, string> = {
  SEK: '1930',
  EUR: '1932',
  USD: '1933',
  GBP: '1934',
}

export function defaultLedgerForCurrency(currency: string): string {
  return CURRENCY_LEDGER_DEFAULTS[currency.toUpperCase()] ?? '1930'
}

/**
 * Canonical read/write surface for cash_accounts.
 *
 * Replaces ad-hoc reads of bank_connections.accounts_data for routing decisions.
 * UI panels that just display balances may still read accounts_data until the
 * follow-up migration drops that column.
 *
 * All methods accept an authenticated SupabaseClient and rely on RLS for tenancy
 * isolation. Defense-in-depth filter by company_id is applied regardless.
 */

export interface ListCashAccountsOptions {
  enabledOnly?: boolean
}

export interface UpsertFromPsd2Input {
  bank_connection_id: string
  external_uid: string
  currency: string
  ledger_account: string
  iban?: string | null
  name?: string | null
  balance?: number | null
  available_balance?: number | null
  balance_updated_at?: string | null
  enabled?: boolean
  /**
   * Existing cash_accounts row this PSD2 account was matched to by IBAN
   * (see resolvePsd2LedgerAccount). The row is promoted in place: it keeps its
   * id, its ledger_account and its linked transactions, and is re-pointed at
   * this connection + external_uid. Without this the reconnect path would try
   * to INSERT a second row on the same ledger and trip the
   * (company_id, ledger_account) UNIQUE constraint.
   */
  reuse_cash_account_id?: string | null
}

/**
 * Normalize an IBAN for comparison: ASPSPs format the same account both as
 * "SE45 5000 0000 0583 9825 7466" and "SE4550000000058398257466", and a plain
 * string compare would read those as two different accounts. Mirrors the
 * normalization the sync path already applies when deriving external_ids.
 */
export function normalizeIban(iban: string | null | undefined): string | null {
  if (!iban) return null
  const normalized = iban.replace(/\s+/g, '').toUpperCase()
  return normalized || null
}

export async function listForCompany(
  supabase: SupabaseClient,
  companyId: string,
  opts: ListCashAccountsOptions = {},
): Promise<CashAccount[]> {
  let q = supabase
    .from('cash_accounts')
    .select('*')
    .eq('company_id', companyId)
    .order('is_primary', { ascending: false })
    .order('ledger_account', { ascending: true })

  if (opts.enabledOnly) q = q.eq('enabled', true)

  const { data, error } = await q
  if (error) {
    log.error('listForCompany failed', { companyId, error: error.message })
    return []
  }
  return (data ?? []) as CashAccount[]
}

/**
 * Primary cash account for a company. Filters by currency when provided. Falls
 * back to the global primary (`is_primary = true`) when no currency-specific
 * match exists.
 *
 * Used by skattekonto-booking's __PRIMARY_SEK__ sentinel and by transfer-pairing
 * to identify the company's default settlement account.
 */
export async function getPrimary(
  supabase: SupabaseClient,
  companyId: string,
  currency?: string,
): Promise<CashAccount | null> {
  let q = supabase
    .from('cash_accounts')
    .select('*')
    .eq('company_id', companyId)
    .eq('is_primary', true)
    .limit(1)

  if (currency) q = q.eq('currency', currency.toUpperCase())

  const { data, error } = await q.maybeSingle()
  if (error) {
    log.warn('getPrimary failed', { companyId, currency, error: error.message })
  }
  if (data) return data as CashAccount

  if (currency) {
    // Fall back to any-currency primary so a company without a SEK account still
    // resolves the sentinel: rare but possible (manual cash-on-hand only).
    const { data: anyPrimary } = await supabase
      .from('cash_accounts')
      .select('*')
      .eq('company_id', companyId)
      .eq('is_primary', true)
      .maybeSingle()
    if (anyPrimary) return anyPrimary as CashAccount
  }

  return null
}

/**
 * One in-memory picture of the company's cash_accounts rows and the status of
 * the bank connections holding them. Every #1643 helper below derives from it,
 * so "orphaned", "live" and "same physical account" mean the same thing in the
 * transfer detector, the match/link flows and the commit guards.
 */
interface CashAccountTopology {
  rows: CashAccount[]
  /** bank_connection_id -> bank_connections.status */
  statuses: Map<string, string>
  /** Ledger accounts that must never be PROPOSED or accepted as a counter leg. */
  orphaned: Set<string>
  /** A row on an ACTIVE connection: the live claim on that physical account. */
  isLive: (row: CashAccount) => boolean
  /**
   * A row no connection holds a claim on any more: demoted to manual
   * (bank_connection_id null) or still pointing at a REVOKED connection.
   * Distinct from "not live": an expired/error/pending connection still
   * holds the row and can come back through re-auth.
   */
  isReleased: (row: CashAccount) => boolean
}

function currencyKey(currency: string | null | undefined): string {
  return String(currency ?? '').toUpperCase()
}

/**
 * Load the topology, or null when the row lookup fails. A failed connection
 * lookup degrades to "no connection is known to be active": nothing is
 * flagged orphaned (the conservative pre-fix behavior) and no row ranks as
 * live.
 */
async function loadCashAccountTopology(
  supabase: SupabaseClient,
  companyId: string,
): Promise<CashAccountTopology | null> {
  const { data, error } = await supabase
    .from('cash_accounts')
    .select('*')
    .eq('company_id', companyId)
  if (error) {
    log.warn('cash_accounts topology lookup failed', { companyId, error: error.message })
    return null
  }
  const rows = (data ?? []) as CashAccount[]
  const connectionIds = [
    ...new Set(rows.map((r) => r.bank_connection_id).filter((id): id is string => id !== null)),
  ]
  const statuses = await getConnectionStatuses(supabase, companyId, connectionIds)

  // Two enabled rows on ONE active connection sharing (IBAN, currency) are
  // deliberately BOTH live: no liveness signal has held up on prod (see
  // DECISIONS.md, #1643), so nothing ranks them here.
  const isLive = (r: CashAccount): boolean =>
    r.enabled && r.bank_connection_id !== null && statuses.get(r.bank_connection_id) === 'active'
  const isReleased = (r: CashAccount): boolean =>
    r.bank_connection_id === null || statuses.get(r.bank_connection_id) === 'revoked'

  const orphaned = new Set<string>()
  // Stale IBAN twins of a live row: the live row IS that physical account
  // now, so a demoted-to-manual, disabled, revoked-held, or expired/error-
  // connection row carrying the same IBAN in the same currency is a leftover
  // of a broken reconnect. A row held by a REVOKED connection is NOT orphaned
  // on its own: the disconnect and supersede paths demote such rows to
  // manual holders (bank_connection_id null, #916), and a row revoked bank-
  // side or before that demotion existed is the same thing with the stale
  // FK kept, i.e. a real account the user still tracks (commonly the
  // company's only 1930). The key is (IBAN, currency), never the IBAN alone: multi-
  // currency accounts (Revolut, Wise) copy one IBAN onto every currency
  // pocket, and a manual or deselected GBP pocket beside a live SEK pocket is
  // a distinct account the user still tracks, not an orphan.
  const liveByAccount = new Map<string, CashAccount>()
  for (const row of rows) {
    const key = physicalAccountKey(row)
    if (key && isLive(row)) liveByAccount.set(key, row)
  }
  for (const row of rows) {
    if (isLive(row)) continue
    const key = physicalAccountKey(row)
    if (!key) continue
    const live = liveByAccount.get(key)
    if (live && live.ledger_account !== row.ledger_account) orphaned.add(row.ledger_account)
  }

  return { rows, statuses, orphaned, isLive, isReleased }
}

/**
 * Identity of the physical bank account a row represents: normalized IBAN
 * plus currency, or null for rows without an IBAN (manual, CSV, kassa).
 */
function physicalAccountKey(row: Pick<CashAccount, 'iban' | 'currency'>): string | null {
  const iban = normalizeIban(row.iban)
  return iban ? `${iban}|${currencyKey(row.currency)}` : null
}

/**
 * Ledger accounts of the OTHER rows that represent the same physical account
 * as `own` (same normalized IBAN, same currency), whatever their liveness.
 * The row on `settlementAccount` is never a twin of itself.
 */
function twinLedgersOf(
  topology: CashAccountTopology,
  own: CashAccount | null,
  settlementAccount: string,
): Set<string> {
  const twins = new Set<string>()
  const ownKey = own ? physicalAccountKey(own) : null
  if (!own || !ownKey) return twins
  for (const row of topology.rows) {
    if (row.id === own.id || row.ledger_account === settlementAccount) continue
    if (physicalAccountKey(row) !== ownKey) continue
    twins.add(row.ledger_account)
  }
  return twins
}

/**
 * Find the cash account an own-account TRANSFER may pair with, by IBAN.
 *
 * Replaces the old findByIban for this purpose (issue #1643): a broken reconnect
 * can leave several rows carrying the same IBAN (the live account plus orphans
 * held by a revoked connection, or demoted to manual), and proposing an orphan
 * as the transfer's counter-account books real money onto a junk balance-sheet
 * ledger. This finder therefore:
 *   - tolerates multiple rows on one IBAN (the old single-row lookup errored),
 *   - drops disabled rows and every row in the orphaned set (the same
 *     definition the commit guards use, so a proposal is never rejected later),
 *   - treats the transaction's OWN IBAN as "not a transfer": when the bank
 *     stamps the account's own IBAN as counterparty (interest, fees) every
 *     row on that IBAN in the same currency is the same physical account,
 *     whichever of them happens to be live. Only a pocket in ANOTHER currency
 *     on that IBAN (a multi-currency account exchanging between pockets) can
 *     still pair.
 * When more than one candidate survives (two active twins of one account, or
 * several currency pockets with nothing to pick between them) the finder
 * returns null rather than guessing by ledger number: no proposal beats a
 * wrong one, and that is also what the single-row lookup did before.
 */
export async function findPairableCashAccountByIban(
  supabase: SupabaseClient,
  companyId: string,
  iban: string,
  opts: { excludeCashAccountId?: string | null } = {},
): Promise<CashAccount | null> {
  const wanted = normalizeIban(iban)
  if (!wanted) return null
  const topology = await loadCashAccountTopology(supabase, companyId)
  if (!topology) return null

  const onIban = topology.rows.filter((row) => normalizeIban(row.iban) === wanted)
  if (onIban.length === 0) return null

  const ownId = opts.excludeCashAccountId ?? null
  const own = ownId ? (onIban.find((row) => row.id === ownId) ?? null) : null

  let rows = onIban.filter(
    (row) => row.enabled && row.id !== ownId && !topology.orphaned.has(row.ledger_account),
  )
  if (own) {
    const ownCurrency = currencyKey(own.currency)
    rows = rows.filter((row) => currencyKey(row.currency) !== ownCurrency)
  }
  if (rows.length === 0) return null
  if (rows.length > 1) {
    log.warn('several pairable cash accounts share the counterparty IBAN: not pairing', {
      companyId,
      ledgers: rows.map((row) => row.ledger_account),
    })
    return null
  }
  return rows[0]
}

export interface SiblingCashAccount {
  id: string
  ledger_account: string
  currency: string | null
  /** Held by an ACTIVE bank connection and enabled. */
  live: boolean
  /**
   * No connection holds the row any more (bank_connection_id null or the
   * connection is revoked). False for an expired/error/pending connection,
   * which can still be renewed onto this row.
   */
  released: boolean
}

export interface CashAccountSiblings {
  own: SiblingCashAccount
  siblings: SiblingCashAccount[]
}

/**
 * The transaction's own cash_accounts row plus the OTHER rows that carry the
 * same (normalized) IBAN in the same currency, i.e. the same physical bank
 * account on a different ledger. Multi-currency accounts (Revolut, Wise) copy
 * one IBAN onto every currency pocket, so an IBAN match alone would present a
 * EUR pocket as a sibling of the SEK pocket; the currency key keeps those
 * apart.
 *
 * A broken reconnect strands transactions on an orphaned row (e.g. 1931) while
 * the live claim on the same underlying account sits on another row (e.g.
 * 1940). Matching and linking against "the transaction's own ledger" then
 * permanently misses vouchers booked on the live ledger; this helper names the
 * sibling rows such flows may additionally consider, and lets manualLink
 * re-point a stranded row at the live sibling (issue #1643).
 *
 * Returns null when the row cannot be found or on any lookup failure, and an
 * empty sibling list when the row has no IBAN (manual/CSV accounts):
 * broadening is an enhancement, never a requirement.
 */
export async function describeCashAccountSiblings(
  supabase: SupabaseClient,
  companyId: string,
  cashAccountId: string,
): Promise<CashAccountSiblings | null> {
  const topology = await loadCashAccountTopology(supabase, companyId)
  if (!topology) return null
  const ownRow = topology.rows.find((row) => row.id === cashAccountId)
  if (!ownRow) return null
  return describeSiblingsFromTopology(topology, ownRow)
}

function describeSiblingsFromTopology(
  topology: CashAccountTopology,
  ownRow: CashAccount,
): CashAccountSiblings {
  const toSibling = (row: CashAccount): SiblingCashAccount => ({
    id: row.id,
    ledger_account: row.ledger_account,
    currency: row.currency ?? null,
    live: topology.isLive(row),
    released: topology.isReleased(row),
  })
  const own = toSibling(ownRow)
  const wanted = normalizeIban(ownRow.iban)
  if (!wanted) return { own, siblings: [] }

  const ownCurrency = currencyKey(ownRow.currency)
  const seenLedgers = new Set<string>()
  const siblings: SiblingCashAccount[] = []
  for (const row of topology.rows) {
    if (row.id === ownRow.id) continue
    if (row.ledger_account === ownRow.ledger_account) continue
    // A row the user deselected is never a destination (round 5): an
    // automatic move must not land on a row the transactions page hides.
    // A voucher booked only there is then refused as a cross-account link.
    if (!row.enabled) continue
    if (normalizeIban(row.iban) !== wanted) continue
    if (currencyKey(row.currency) !== ownCurrency) continue
    // UNIQUE (company_id, ledger_account) makes this a no-op in practice;
    // kept so a duplicate row can never yield two siblings on one ledger.
    if (seenLedgers.has(row.ledger_account)) continue
    seenLedgers.add(row.ledger_account)
    siblings.push(toSibling(row))
  }
  return { own, siblings }
}

/**
 * Whether a link against a voucher booked on `sibling` should MOVE the
 * transaction's cash_account_id there (manualLink) and, equivalently, whether
 * that sibling's vouchers should be offered to the row at all
 * (unmatched-entries). The decision is about the destination: move onto a
 * live sibling always; onto a dead one only when the own row's holder is
 * definitively gone (released) and no sibling is live. An own row on an
 * expired/error/pending connection is still the syncing account, so its
 * transactions never leave it for a dead twin (issue #1643, round 3).
 */
export function shouldRepointToSibling(
  described: CashAccountSiblings,
  sibling: SiblingCashAccount,
): boolean {
  if (sibling.live) return true
  if (!described.own.released) return false
  return !described.siblings.some((row) => row.live)
}

/**
 * The sibling rows of `cashAccountId` (see describeCashAccountSiblings), or []
 * when the row has no IBAN or the lookup fails.
 */
export async function listSiblingCashAccounts(
  supabase: SupabaseClient,
  companyId: string,
  cashAccountId: string,
): Promise<SiblingCashAccount[]> {
  const described = await describeCashAccountSiblings(supabase, companyId, cashAccountId)
  return described?.siblings ?? []
}

/**
 * Ledger accounts of the sibling rows returned by listSiblingCashAccounts.
 */
export async function listSiblingLedgerAccounts(
  supabase: SupabaseClient,
  companyId: string,
  cashAccountId: string,
): Promise<string[]> {
  const siblings = await listSiblingCashAccounts(supabase, companyId, cashAccountId)
  return siblings.map((row) => row.ledger_account)
}

/**
 * Ledger accounts that must never be PROPOSED (or accepted) as the
 * counter-account of a booking, because their cash_accounts row is orphaned
 * (issue #1643): a row that is not live (demoted-to-manual, disabled, held
 * by a REVOKED connection, or by an expired/error connection) whose (IBAN,
 * currency) also belongs to a row on an ACTIVE connection. The active row IS
 * that physical account now, so the stale twin is a leftover of a broken
 * reconnect.
 * A manual/CSV account without a live twin is NOT orphaned, and neither is a
 * row held by a revoked connection without a live twin (a disconnected but
 * real account, often the company's only 1930): transfers to such an account
 * are legitimate, and so is another currency pocket of a multi-currency
 * account that shares the live pocket's IBAN.
 */
export async function getOrphanedCounterLedgers(
  supabase: SupabaseClient,
  companyId: string,
): Promise<Set<string>> {
  const topology = await loadCashAccountTopology(supabase, companyId)
  return topology?.orphaned ?? new Set()
}

/**
 * The first account in a mapping result that would book the COUNTER leg onto
 * an orphaned cash-account ledger, or null when the result is clean. The
 * settlement account itself is exempt: a transaction stranded on an orphaned
 * row still books its own bank leg there (the only leg that belongs there).
 */
export function findOrphanedCounterLedger(
  accounts: Array<string | null | undefined>,
  settlementAccount: string,
  orphanedLedgers: ReadonlySet<string>,
): string | null {
  for (const account of accounts) {
    if (!account || account === settlementAccount) continue
    if (!/^19\d{2}$/.test(account)) continue
    if (orphanedLedgers.has(account)) return account
  }
  return null
}

export interface CounterLegGuardResult {
  mappingResult: MappingResult
  /** The 19xx ledger the result must not book its counter leg on, or null. */
  refusedLedger: string | null
}

/**
 * Commit-time guard shared by every categorize path (issue #1643 problem 4).
 * Runs after applySettlementAccount, on the legs that are NOT the settlement
 * account:
 *   1. A 19xx leg that is a twin of the settlement row (same IBAN, same
 *      currency) is that same physical account's bank leg learned on another
 *      ledger (a counterparty template learned while the account sat on 1931,
 *      replayed after the reconnect moved it to 1940). It is rewritten to the
 *      settlement account rather than refused: the business account is fine,
 *      only the bank side is stale.
 *   2. If that leaves the result booking the settlement account against
 *      itself (a "transfer" between two ledgers of one physical account, e.g.
 *      interest whose counterparty IBAN is the account's own), the twin is
 *      refused: no revenue or expense would reach the P&L.
 *   3. Any remaining 19xx counter leg in the orphaned set is refused.
 * The cash_accounts lookup only runs when a non-settlement 19xx leg is
 * present, so ordinary bookings pay nothing.
 */
export async function guardCounterLegs(
  supabase: SupabaseClient,
  companyId: string,
  mappingResult: MappingResult,
  settlementAccount: string,
  settlementCashAccountId: string | null | undefined,
): Promise<CounterLegGuardResult> {
  const isCounterCashLeg = (a: string | null | undefined): a is string =>
    !!a && a !== settlementAccount && /^19\d{2}$/.test(a)
  const legs = [
    mappingResult.debit_account,
    mappingResult.credit_account,
    ...mappingResult.vat_lines.map((l) => l.account_number),
  ].filter(isCounterCashLeg)
  if (legs.length === 0) return { mappingResult, refusedLedger: null }

  const topology = await loadCashAccountTopology(supabase, companyId)
  if (!topology) return { mappingResult, refusedLedger: null }

  const own = settlementCashAccountId
    ? (topology.rows.find((row) => row.id === settlementCashAccountId) ?? null)
    : null
  const twins = twinLedgersOf(topology, own, settlementAccount)

  let result = mappingResult
  const rewrittenTwin = legs.find((leg) => twins.has(leg)) ?? null
  if (rewrittenTwin) {
    const rewrite = (a: string): string => (twins.has(a) ? settlementAccount : a)
    result = {
      ...mappingResult,
      debit_account: rewrite(mappingResult.debit_account),
      credit_account: rewrite(mappingResult.credit_account),
      vat_lines: mappingResult.vat_lines.map((l) => ({
        ...l,
        account_number: rewrite(l.account_number),
      })),
    }
    if (result.debit_account === settlementAccount && result.credit_account === settlementAccount) {
      return { mappingResult, refusedLedger: rewrittenTwin }
    }
  }

  const remaining = [
    result.debit_account,
    result.credit_account,
    ...result.vat_lines.map((l) => l.account_number),
  ].filter(isCounterCashLeg)
  const orphaned = findOrphanedCounterLedger(remaining, settlementAccount, topology.orphaned)
  return { mappingResult: result, refusedLedger: orphaned }
}

export interface CounterLegContext {
  /** Ledger of the transaction's own cash_accounts row, or null when unknown. */
  settlementLedger: string | null
  /** Other ledgers of the same physical account (same IBAN, same currency). */
  twins: ReadonlySet<string>
}

export interface CounterLegTopology {
  /** Ledgers that must never be PROPOSED or accepted as a counter leg. */
  orphaned: ReadonlySet<string>
  contextFor: (cashAccountId: string | null | undefined) => CounterLegContext
}

/**
 * One topology load for a batch of transactions (the suggest-categories
 * route), exposing the same twin and orphan rules guardCounterLegs applies at
 * commit: a learned 19xx leg that is a twin of the transaction's own row is
 * that account's stale BANK leg (rewrite it to the settlement ledger, never
 * withhold), and only a true counter-position orphan disqualifies a
 * suggestion. Returns null when the lookup fails (nothing is withheld).
 */
export async function loadCounterLegTopology(
  supabase: SupabaseClient,
  companyId: string,
): Promise<CounterLegTopology | null> {
  const topology = await loadCashAccountTopology(supabase, companyId)
  if (!topology) return null
  const cache = new Map<string, CounterLegContext>()
  return {
    orphaned: topology.orphaned,
    contextFor: (cashAccountId) => {
      if (!cashAccountId) return { settlementLedger: null, twins: new Set() }
      const cached = cache.get(cashAccountId)
      if (cached) return cached
      const own = topology.rows.find((row) => row.id === cashAccountId) ?? null
      const context: CounterLegContext = own
        ? { settlementLedger: own.ledger_account, twins: twinLedgersOf(topology, own, own.ledger_account) }
        : { settlementLedger: null, twins: new Set() }
      cache.set(cashAccountId, context)
      return context
    },
  }
}

/**
 * Line-level counterpart of guardCounterLegs for the free-form booking
 * dialog (POST /api/transactions/[id]/book), which submits explicit lines
 * instead of a mapping result. Two shapes are covered:
 *   - Two or more distinct 19xx ledgers, one of them the transaction's own
 *     settlement ledger: a 19xx line that is a same-IBAN same-currency twin
 *     of the own row or an orphaned ledger is refused, since such a
 *     "transfer" books one physical account against itself or onto a junk
 *     ledger.
 *   - A single 19xx line that is NOT the own ledger (the user typed the bank
 *     leg where the money physically is, e.g. the live 1940 for a row
 *     stranded on the orphaned 1931): when that ledger is a sibling the row
 *     should move to (shouldRepointToSibling), the caller re-points
 *     transactions.cash_account_id there in the same locked UPDATE that
 *     links the voucher, exactly as manualLink does for the identical
 *     voucher reached through "Matcha mot befintlig verifikation". A twin
 *     the row may not move to (a dead or disabled twin) is refused, since
 *     posting would strand the only bank leg on a ledger no connection
 *     feeds (round 5); a non-twin foreign 19xx line posts as typed.
 * An ordinary booking (single 19xx line on the own ledger) pays one PK read
 * of the own row and nothing more; the topology is only loaded when a twin
 * or foreign 19xx leg is present. Both fields are null when clean, not
 * covered, or when the transaction has no cash_accounts row.
 */
export interface BookedLinesGuardResult {
  /** The 19xx ledger the booking must not put in the counter position, or null. */
  refusedLedger: string | null
  /** cash_accounts row the transaction should be moved to on booking, or null. */
  repointCashAccountId: string | null
}

const CLEAN_BOOKED_LINES: BookedLinesGuardResult = { refusedLedger: null, repointCashAccountId: null }

export async function guardBookedCounterLines(
  supabase: SupabaseClient,
  companyId: string,
  accountNumbers: readonly string[],
  settlementCashAccountId: string | null | undefined,
): Promise<BookedLinesGuardResult> {
  const cashLegs = [...new Set(accountNumbers.filter((a) => /^19\d{2}$/.test(a)))]
  if (cashLegs.length === 0 || !settlementCashAccountId) return CLEAN_BOOKED_LINES

  if (cashLegs.length === 1) {
    const { data: ownRow, error } = await supabase
      .from('cash_accounts')
      .select('ledger_account')
      .eq('id', settlementCashAccountId)
      .eq('company_id', companyId)
      .maybeSingle()
    if (error) {
      log.warn('cash_accounts own-row lookup failed', { companyId, error: error.message })
      return CLEAN_BOOKED_LINES
    }
    const ownLedger = (ownRow as { ledger_account?: string } | null)?.ledger_account ?? null
    if (!ownLedger || ownLedger === cashLegs[0]) return CLEAN_BOOKED_LINES

    const topology = await loadCashAccountTopology(supabase, companyId)
    const own = topology?.rows.find((row) => row.id === settlementCashAccountId) ?? null
    if (!topology || !own) return CLEAN_BOOKED_LINES
    // A foreign 19xx line that is NOT a twin of the own row (a transfer to
    // another physical account) posts as typed.
    if (!twinLedgersOf(topology, own, ownLedger).has(cashLegs[0])) return CLEAN_BOOKED_LINES
    const described = describeSiblingsFromTopology(topology, own)
    const sibling = described.siblings.find((row) => row.ledger_account === cashLegs[0]) ?? null
    if (sibling && shouldRepointToSibling(described, sibling)) {
      return { refusedLedger: null, repointCashAccountId: sibling.id }
    }
    // A twin the row may not move to (a dead or disabled twin of a live or
    // still-held row): posting would put the only bank leg on a ledger no
    // connection feeds while the transaction stays here (issue #1643
    // problem 4), the shape the categorize paths rewrite and manualLink
    // refuses. Refuse it (round 5).
    return { refusedLedger: cashLegs[0], repointCashAccountId: null }
  }

  const topology = await loadCashAccountTopology(supabase, companyId)
  if (!topology) return CLEAN_BOOKED_LINES
  const own = topology.rows.find((row) => row.id === settlementCashAccountId) ?? null
  if (!own) return CLEAN_BOOKED_LINES
  const settlementAccount = own.ledger_account
  if (!cashLegs.includes(settlementAccount)) return CLEAN_BOOKED_LINES

  const twins = twinLedgersOf(topology, own, settlementAccount)
  const counterLegs = cashLegs.filter((a) => a !== settlementAccount)
  const twin = counterLegs.find((a) => twins.has(a)) ?? null
  if (twin) return { refusedLedger: twin, repointCashAccountId: null }
  return {
    refusedLedger: findOrphanedCounterLedger(counterLegs, settlementAccount, topology.orphaned),
    repointCashAccountId: null,
  }
}

/**
 * bank_connections.status for the given connection ids. Missing ids (and a
 * failed lookup, which returns an empty map) read as "status unknown".
 */
async function getConnectionStatuses(
  supabase: SupabaseClient,
  companyId: string,
  connectionIds: readonly string[],
): Promise<Map<string, string>> {
  if (connectionIds.length === 0) return new Map()

  const { data, error } = await supabase
    .from('bank_connections')
    .select('id, status')
    .eq('company_id', companyId)
    .in('id', [...connectionIds])

  if (error) {
    log.warn('bank_connections status lookup failed', { companyId, error: error.message })
    return new Map()
  }

  return new Map(
    ((data ?? []) as Array<{ id: string; status: string }>).map((c) => [c.id, c.status]),
  )
}

/**
 * Of the given bank_connection ids, return the subset whose connection row has
 * status 'revoked'. A revoked connection no longer holds a live claim on its
 * cash_accounts rows: the allocator, the picker-save collision guard, and
 * upsertFromPsd2's promote-in-place path all treat those rows like manual
 * holders so a reconnect can land back on its original ledger account.
 *
 * On lookup failure this returns an empty set (treat every connection as
 * active): the conservative pre-fix behavior.
 */
export async function getRevokedConnectionIds(
  supabase: SupabaseClient,
  companyId: string,
  connectionIds: readonly string[],
): Promise<Set<string>> {
  const statuses = await getConnectionStatuses(supabase, companyId, connectionIds)
  return new Set([...statuses.entries()].filter(([, status]) => status === 'revoked').map(([id]) => id))
}

/**
 * Find a free BAS class-19 slot for a new PSD2 cash account, respecting the
 * UNIQUE (company_id, ledger_account) constraint. A bank returning N
 * same-currency accounts must not map them all to the currency default —
 * that's exactly the collision this prevents.
 *
 * Rules:
 *   - The currency default (1930/1932/1933/1934) is available when no
 *     PSD2-backed row holds it. A manual holder (the seeded 1930 row) does
 *     not block it — upsertFromPsd2 promotes that row in place.
 *     Rows held by a REVOKED connection count as manual too: disconnecting a
 *     bank releases its ledger claims, so reconnecting the same bank gets its
 *     original slot back instead of overflowing to 1939.
 *   - Overflow walks the free-use 1931–1959 sub-account slots, skipping the
 *     four currency defaults (reserved as suggestions for their currencies)
 *     and any slot held by ANY existing row — promoting an unrelated manual
 *     account (SIE-imported, kassa) would silently steal it.
 *   - Overflow ALSO skips 19xx numbers that already exist in the company's
 *     chart of accounts, even when no cash_accounts row holds them. A chart
 *     imported from SIE carries the company's real bank accounts by name
 *     ("1942 Nordnet", "1938 Danske eSett Settlement") without any PSD2 row
 *     behind them, and handing one of those out as "free" is how a SEK
 *     företagskonto ended up proposed as 1942 Nordnet. Only when every
 *     chart-free slot is exhausted do we fall back to chart-occupied numbers,
 *     so a company with a fully populated 19xx chart still gets an answer.
 *   - `exclude` carries slots already assigned earlier in the caller's loop
 *     but not yet visible in the table.
 *
 * Returns null when no slot is free (or the lookup fails) — callers fall back
 * to their previous behavior and surface the error.
 */
export async function findFreeLedgerAccount(
  supabase: SupabaseClient,
  companyId: string,
  currency: string,
  exclude: ReadonlySet<string> = new Set(),
): Promise<string | null> {
  const preferred = defaultLedgerForCurrency(currency)

  const { data: rows, error } = await supabase
    .from('cash_accounts')
    .select('ledger_account, bank_connection_id')
    .eq('company_id', companyId)

  if (error) {
    log.error('findFreeLedgerAccount lookup failed', { companyId, error: error.message })
    return null
  }

  // Chart accounts are advisory here: a failed lookup must not block
  // allocation, it just costs us the "don't steal a named bank account" guard.
  const { data: chartRows, error: chartError } = await supabase
    .from('chart_of_accounts')
    .select('account_number')
    .eq('company_id', companyId)
    .like('account_number', '19%')

  if (chartError) {
    log.warn('findFreeLedgerAccount chart lookup failed', {
      companyId,
      error: chartError.message,
    })
  }
  const chartTaken = new Set(
    ((chartRows ?? []) as Array<{ account_number: string }>).map(r => r.account_number),
  )

  const typedRows = (rows ?? []) as Array<{ ledger_account: string; bank_connection_id: string | null }>
  const revokedConnectionIds = await getRevokedConnectionIds(
    supabase,
    companyId,
    [...new Set(typedRows.map(r => r.bank_connection_id).filter((id): id is string => id !== null))],
  )

  const anyTaken = new Set<string>()
  const connectedTaken = new Set<string>()
  for (const row of typedRows) {
    anyTaken.add(row.ledger_account)
    if (row.bank_connection_id !== null && !revokedConnectionIds.has(row.bank_connection_id)) {
      connectedTaken.add(row.ledger_account)
    }
  }

  if (!exclude.has(preferred) && !connectedTaken.has(preferred)) return preferred

  const reserved = new Set(Object.values(CURRENCY_LEDGER_DEFAULTS))
  const candidates: string[] = []
  for (let n = 1931; n <= 1959; n++) {
    const candidate = String(n)
    if (reserved.has(candidate)) continue
    if (exclude.has(candidate) || anyTaken.has(candidate)) continue
    candidates.push(candidate)
  }

  // First pass: slots the chart has never heard of, so we can create them
  // cleanly. Second pass: chart-occupied slots, the pre-fix behavior, only
  // once nothing unnamed is left.
  const unnamed = candidates.find(c => !chartTaken.has(c))
  if (unnamed) return unnamed
  if (candidates.length > 0) {
    log.warn('findFreeLedgerAccount fell back to a chart-occupied slot', {
      companyId,
      currency,
      ledger: candidates[0],
    })
    return candidates[0]
  }

  log.warn('findFreeLedgerAccount exhausted 1931–1959', { companyId, currency })
  return null
}

/**
 * Allocate a ledger slot for a new PSD2 account AND make sure that account
 * number exists in the company's chart of accounts — cash_accounts has no FK
 * to the chart, but booking (and the AccountPicker, which only lists chart
 * accounts) breaks on numbers the chart doesn't know. Sub-accounts outside
 * the BAS reference (1931, …) are created with metadata derived from the
 * account number; standard numbers get their BAS name.
 */
export async function allocatePsd2LedgerAccount(
  supabase: SupabaseClient,
  companyId: string,
  userId: string,
  // accountName is accepted for caller compatibility but no longer names the
  // chart account: see the BAS-style naming note in the function body (#1643).
  input: { currency: string; accountName?: string | null; exclude?: ReadonlySet<string> },
): Promise<string | null> {
  const ledger = await findFreeLedgerAccount(supabase, companyId, input.currency, input.exclude ?? new Set())
  if (!ledger) return null

  // The CHART account always gets a BAS-style name: the BAS reference name
  // when the slot is a standard account (1930 Företagskonto, 1940 Övriga
  // bankkonton, ...), otherwise "Bankkonto <CUR>" for a free-use sub-account
  // (1931, 1935, ...). ASPSPs report the account holder (i.e. the company) as
  // the account name, and every failed reconnect used to persist another 19xx
  // chart account named after the company (issue #1643 problem 3). The bank's
  // display name still lands on cash_accounts.name via upsertFromPsd2, which
  // is what the pickers show; input.accountName is deliberately ignored here.
  const name = getBASReference(ledger)?.account_name ?? `Bankkonto ${input.currency.toUpperCase()}`
  const sync = await syncMappedAccounts(
    supabase,
    companyId,
    userId,
    [
      {
        sourceAccount: ledger,
        sourceName: name,
        targetAccount: ledger,
        targetName: name,
        confidence: 1,
        matchType: 'exact',
        isOverride: false,
      },
    ],
    false,
  )
  if (sync.error) {
    log.error('allocatePsd2LedgerAccount chart sync failed', {
      companyId,
      ledger,
      error: sync.error,
    })
    return null
  }
  return ledger
}

export interface Psd2LedgerResolution {
  ledgerAccount: string
  /**
   * Existing row to promote in place, when the IBAN was already known. Null
   * when the ledger was freshly allocated.
   */
  reuseCashAccountId: string | null
  source: 'iban' | 'allocated'
}

/**
 * Decide which BAS account a PSD2 account should book to, IBAN first.
 *
 * The IBAN identifies the physical bank account; the provider's account `uid`
 * does not survive a re-authorization at every ASPSP, and a fresh connect to
 * an already-connected bank mints a new bank_connection row regardless. Both
 * cases used to look like "an account we have never seen", so the allocator
 * handed out the next free 19xx slot and the user's mapping (1930/1940/1941)
 * silently moved to 1942-1946 on every consent renewal.
 *
 * Matching on the IBAN instead means a known account keeps its ledger, its
 * cash_accounts row id and therefore its linked transactions. The previous
 * holder's connection status is deliberately NOT considered: one IBAN is one
 * physical account, so the connection that just authorized it is the one that
 * owns it. This matters for the case that motivated the fix, where the old
 * connection still reads 'active' because its session was killed bank-side
 * without telling us.
 *
 * Returns null only when allocation itself fails; callers keep their existing
 * fallback.
 */
export async function resolvePsd2LedgerAccount(
  supabase: SupabaseClient,
  companyId: string,
  userId: string,
  input: {
    iban?: string | null
    currency: string
    accountName?: string | null
    exclude?: ReadonlySet<string>
  },
): Promise<Psd2LedgerResolution | null> {
  const exclude = input.exclude ?? new Set<string>()
  const wanted = normalizeIban(input.iban)

  if (wanted) {
    const { data, error } = await supabase
      .from('cash_accounts')
      .select('id, iban, ledger_account')
      .eq('company_id', companyId)
      .not('iban', 'is', null)

    if (error) {
      // Fall through to allocation: a failed lookup must not block the
      // connection, it just costs us the reuse.
      log.warn('resolvePsd2LedgerAccount iban lookup failed', {
        companyId,
        error: error.message,
      })
    } else {
      const match = ((data ?? []) as Array<{ id: string; iban: string | null; ledger_account: string }>)
        .find(row => normalizeIban(row.iban) === wanted)
      // A ledger already claimed earlier in the caller's loop cannot be handed
      // out twice, even on an IBAN hit: two rows on one ledger violate the
      // (company_id, ledger_account) UNIQUE constraint.
      if (match && !exclude.has(match.ledger_account)) {
        return {
          ledgerAccount: match.ledger_account,
          reuseCashAccountId: match.id,
          source: 'iban',
        }
      }
    }
  }

  const allocated = await allocatePsd2LedgerAccount(supabase, companyId, userId, {
    currency: input.currency,
    accountName: input.accountName,
    exclude,
  })
  if (!allocated) return null
  return { ledgerAccount: allocated, reuseCashAccountId: null, source: 'allocated' }
}

/** Max transaction ids per `.in()` filter when rebinding: keeps the request URL short. */
const REBIND_ID_CHUNK_SIZE = 100

function chunkIds(ids: readonly string[], size: number): string[][] {
  const out: string[][] = []
  for (let i = 0; i < ids.length; i += size) out.push(ids.slice(i, i + size))
  return out
}

/**
 * Rebind the MOVABLE transactions of one cash_accounts row onto another.
 *
 * Movable mirrors PATCH /api/transactions/[id]/cash-account (#1570): NOT
 * booked (journal_entry_id), NOT confirmed-matched (invoice_id /
 * supplier_invoice_id) and NOT anchored to a verifikat through
 * transaction_voucher_links or an invoice/supplier-invoice payment row (both
 * anchor without setting journal_entry_id on the transaction; see
 * lib/transactions/is-booked.ts). An anchored row's voucher carries the 19xx
 * line that records which ledger the money moved on, so its binding stays.
 *
 * The anchor tables cannot be expressed as a NOT EXISTS in a PostgREST update
 * filter, so they are consulted in a pre-check; the column gate is re-asserted
 * on the UPDATE itself against a concurrent book or auto-match.
 *
 * Runs before the target row is promoted and none of rebind / demote-or-delete
 * / promote is transactional (PostgREST calls). Safe because the two rows share
 * (bank_connection_id, external_uid), so their transactions already carry the
 * currency the promote is about to write onto the target.
 *
 * @returns the number of rows rebound
 */
async function rebindMovableTransactions(
  supabase: SupabaseClient,
  companyId: string,
  fromCashAccountId: string,
  toCashAccountId: string,
): Promise<number> {
  const candidates = await fetchAllRows<{ id: string }>(({ from, to }) =>
    supabase
      .from('transactions')
      .select('id')
      .eq('company_id', companyId)
      .eq('cash_account_id', fromCashAccountId)
      .is('journal_entry_id', null)
      .is('invoice_id', null)
      .is('supplier_invoice_id', null)
      .order('id', { ascending: true })
      .range(from, to),
  )
  if (candidates.length === 0) return 0

  const candidateIds = candidates.map((row) => row.id)
  const anchored = new Set<string>()
  for (const chunk of chunkIds(candidateIds, REBIND_ID_CHUNK_SIZE)) {
    const anchorRows = await Promise.all([
      supabase
        .from('transaction_voucher_links')
        .select('transaction_id')
        .eq('company_id', companyId)
        .in('transaction_id', chunk),
      supabase
        .from('invoice_payments')
        .select('transaction_id')
        .eq('company_id', companyId)
        .in('transaction_id', chunk),
      supabase
        .from('supplier_invoice_payments')
        .select('transaction_id')
        .eq('company_id', companyId)
        .in('transaction_id', chunk),
    ])
    for (const { data, error } of anchorRows) {
      if (error) throw new Error(error.message)
      for (const row of (data ?? []) as Array<{ transaction_id: string | null }>) {
        if (row.transaction_id) anchored.add(row.transaction_id)
      }
    }
  }

  const movableIds = candidateIds.filter((id) => !anchored.has(id))
  let moved = 0
  for (const chunk of chunkIds(movableIds, REBIND_ID_CHUNK_SIZE)) {
    const { data, error } = await supabase
      .from('transactions')
      .update({ cash_account_id: toCashAccountId })
      .eq('company_id', companyId)
      .eq('cash_account_id', fromCashAccountId)
      .in('id', chunk)
      .is('journal_entry_id', null)
      .is('invoice_id', null)
      .is('supplier_invoice_id', null)
      .select('id')
    if (error) throw new Error(error.message)
    moved += (data ?? []).length
  }
  return moved
}

/** One account's refreshed balance snapshot, as the sync loop stores it. */
export interface SyncedBalanceInput {
  external_uid: string
  balance?: number | null
  available_balance?: number | null
  balance_updated_at?: string | null
}

/**
 * Mirror freshly-synced balances from bank_connections.accounts_data into
 * cash_accounts. Before this, cash_accounts.balance was written only at
 * connect/selection-save time and then drifted: the transactions-page source
 * picker (which reads cash_accounts) showed a connect-time snapshot as if it
 * were current.
 *
 * Balance-only by design: routing fields (ledger_account, enabled, name) are
 * owned by the picker-save and callback paths via upsertFromPsd2. Rows are
 * matched on (company_id, bank_connection_id, external_uid); accounts without
 * a timestamped balance are skipped (never null out a stored balance because
 * one refresh was skipped or failed). Mirror failures are logged, not thrown:
 * a failed mirror must not fail the sync that produced the data.
 */
export async function updateBalancesFromSync(
  supabase: SupabaseClient,
  companyId: string,
  bankConnectionId: string,
  accounts: SyncedBalanceInput[],
): Promise<void> {
  for (const account of accounts) {
    if (account.balance == null || !account.balance_updated_at) continue
    const { error } = await supabase
      .from('cash_accounts')
      .update({
        balance: account.balance,
        available_balance: account.available_balance ?? null,
        balance_updated_at: account.balance_updated_at,
      })
      .eq('company_id', companyId)
      .eq('bank_connection_id', bankConnectionId)
      .eq('external_uid', account.external_uid)
    if (error) {
      log.error('updateBalancesFromSync failed', {
        companyId,
        bankConnectionId,
        externalUid: account.external_uid,
        error: error.message,
      })
    }
  }
}

/**
 * Upsert a PSD2-sourced cash account during connection callback / sync. Keyed on
 * (company_id, bank_connection_id, external_uid). When the row exists, balance
 * and ledger_account are refreshed; the rest of the metadata stays put.
 *
 * Never sets is_primary: that's owned by the user via the AccountPicker or by
 * the initial-backfill migration.
 */
export async function upsertFromPsd2(
  supabase: SupabaseClient,
  companyId: string,
  input: UpsertFromPsd2Input,
): Promise<void> {
  const payload = {
    company_id: companyId,
    bank_connection_id: input.bank_connection_id,
    external_uid: input.external_uid,
    iban: input.iban ?? null,
    name: input.name ?? null,
    currency: input.currency.toUpperCase(),
    ledger_account: input.ledger_account,
    balance: input.balance ?? null,
    available_balance: input.available_balance ?? null,
    balance_updated_at: input.balance_updated_at ?? null,
    enabled: input.enabled ?? true,
    source: 'enable_banking' as CashAccountSource,
  }

  // create_company_with_owner and the seed_default_cash_account migration plant
  // a manual (bank_connection_id IS NULL) row on the same ledger_account so
  // reconciliation routes work before any PSD2 connection exists, and the
  // disconnect handler demotes a revoked connection's rows to manual the same
  // way. Rows still pointing at a REVOKED connection (orphans from before the
  // disconnect handler released claims) no longer hold a live claim either.
  // In all three cases the PSD2 sync claiming that BAS slot has to promote the
  // holder row in place: a plain upsert on (company_id, bank_connection_id,
  // external_uid) wouldn't match it and the INSERT path then trips the
  // (company_id, ledger_account) UNIQUE constraint. Promoting (instead of
  // inserting) keeps the row id stable so transactions.cash_account_id links
  // and the ledger's history stay attached.
  const { data: holderRow, error: holderLookupError } = await supabase
    .from('cash_accounts')
    .select('id, bank_connection_id')
    .eq('company_id', companyId)
    .eq('ledger_account', input.ledger_account)
    .maybeSingle()

  if (holderLookupError) {
    log.error('upsertFromPsd2 holder lookup failed', {
      companyId,
      bankConnectionId: input.bank_connection_id,
      externalUid: input.external_uid,
      error: holderLookupError.message,
    })
    throw new Error(`cash_accounts upsert failed: ${holderLookupError.message}`)
  }

  const typedHolder = holderRow as { id: string; bank_connection_id: string | null } | null
  let promotableRowId: string | null = null
  if (typedHolder) {
    if (typedHolder.id === input.reuse_cash_account_id) {
      // Matched by IBAN upstream: this row IS this account, whoever held it
      // last. Promoting keeps its id (transactions.cash_account_id stays
      // linked) and re-points it at the connection that just authorized.
      promotableRowId = typedHolder.id
    } else if (typedHolder.bank_connection_id === null) {
      promotableRowId = typedHolder.id
    } else if (typedHolder.bank_connection_id !== input.bank_connection_id) {
      const revoked = await getRevokedConnectionIds(supabase, companyId, [
        typedHolder.bank_connection_id,
      ])
      if (revoked.has(typedHolder.bank_connection_id)) {
        promotableRowId = typedHolder.id
      }
    }
    // Holder owned by the input connection itself (or by another ACTIVE
    // connection): fall through to the plain upsert. For the former the upsert
    // matches on (company_id, bank_connection_id, external_uid) and updates in
    // place; for the latter the UNIQUE constraint rejects the write and the
    // error surfaces to the caller (the picker-save collision guard should
    // have caught it earlier).
  }

  if (promotableRowId) {
    // Promoting the holder makes it THE row for this (bank_connection_id,
    // external_uid). If this connection + uid already has a row on another
    // ledger (the reconnect callback mirrored it onto an overflow slot while
    // the target slot was still wrongly blocked by a revoked connection), that
    // duplicate must be resolved first or the promote trips the UNIQUE
    // (company_id, bank_connection_id, external_uid) constraint.
    const { data: ownRow, error: ownLookupError } = await supabase
      .from('cash_accounts')
      .select('id, is_primary')
      .eq('company_id', companyId)
      .eq('bank_connection_id', input.bank_connection_id)
      .eq('external_uid', input.external_uid)
      .neq('id', promotableRowId)
      .maybeSingle()

    if (ownLookupError) {
      log.error('upsertFromPsd2 duplicate lookup failed', {
        companyId,
        bankConnectionId: input.bank_connection_id,
        externalUid: input.external_uid,
        error: ownLookupError.message,
      })
      throw new Error(`cash_accounts upsert failed: ${ownLookupError.message}`)
    }

    const typedOwn = ownRow as { id: string; is_primary: boolean } | null
    let transferPrimary = false
    if (typedOwn) {
      // The duplicate is the overflow mirror (e.g. 1931) a broken reconnect
      // left behind; the promoted holder (e.g. 1930) is the ledger the user
      // mapped. Movable transactions (unbooked, unmatched, not anchored to a
      // verifikat) rebind onto the promoted row so categorize/booking proposes
      // that ledger. Booked or anchored rows keep their binding: their
      // vouchers carry the old 19xx line.
      let movedCount = 0
      try {
        movedCount = await rebindMovableTransactions(
          supabase,
          companyId,
          typedOwn.id,
          promotableRowId,
        )
      } catch (rebindError) {
        const message = rebindError instanceof Error ? rebindError.message : String(rebindError)
        log.error('upsertFromPsd2 duplicate transaction rebind failed', {
          companyId,
          bankConnectionId: input.bank_connection_id,
          externalUid: input.external_uid,
          error: message,
        })
        throw new Error(`cash_accounts upsert failed: ${message}`)
      }
      if (movedCount > 0) {
        // Behandlingshistorik (BFNAR 2013:2 kap 8): light-touch for a
        // pre-verifikat staging binding, the same weight as the single-row
        // move in PATCH /api/transactions/[id]/cash-account.
        log.info('upsertFromPsd2 rebound movable transactions to promoted cash account', {
          companyId,
          fromCashAccountId: typedOwn.id,
          toCashAccountId: promotableRowId,
          movedCount,
        })
      }

      // Rows still bound after the rebind are booked or anchored: the
      // duplicate then survives as a demoted manual row (deleting it would SET
      // NULL those transactions' cash_account_id links; the #1643 orphan
      // guards handle the released twin). With nothing bound it is a leftover
      // mirror and is deleted outright so its overflow slot frees up.
      const { data: linkedTx, error: linkedTxError } = await supabase
        .from('transactions')
        .select('id')
        .eq('company_id', companyId)
        .eq('cash_account_id', typedOwn.id)
        .limit(1)

      if (linkedTxError) {
        log.error('upsertFromPsd2 duplicate transaction check failed', {
          companyId,
          bankConnectionId: input.bank_connection_id,
          externalUid: input.external_uid,
          error: linkedTxError.message,
        })
        throw new Error(`cash_accounts upsert failed: ${linkedTxError.message}`)
      }

      if ((linkedTx ?? []).length > 0) {
        const { error: demoteError } = await supabase
          .from('cash_accounts')
          .update({ bank_connection_id: null, external_uid: null })
          .eq('id', typedOwn.id)
        if (demoteError) {
          throw new Error(`cash_accounts upsert failed: ${demoteError.message}`)
        }
      } else {
        const { error: deleteError } = await supabase
          .from('cash_accounts')
          .delete()
          .eq('id', typedOwn.id)
        if (deleteError) {
          throw new Error(`cash_accounts upsert failed: ${deleteError.message}`)
        }
      }
      // A primary duplicate must hand the flag to the promoted row either way:
      // deleted, it would leave the __PRIMARY_SEK__ sentinel unresolvable;
      // demoted, the sentinel would keep resolving to the stale manual row.
      transferPrimary = typedOwn.is_primary
    }

    // .select() so we can detect a 0-row UPDATE: Supabase's update().eq() returns
    // { error: null, data: [] } if the row was deleted between the SELECT above
    // and this UPDATE (rare but theoretically possible under concurrent ops).
    // If that happens, fall through to the normal upsert path instead of
    // silently returning success without persisting anything.
    const { data: promoted, error: promoteError } = await supabase
      .from('cash_accounts')
      .update(payload)
      .eq('id', promotableRowId)
      .select('id')
    if (promoteError) {
      log.error('upsertFromPsd2 promote-holder failed', {
        companyId,
        bankConnectionId: input.bank_connection_id,
        externalUid: input.external_uid,
        error: promoteError.message,
      })
      throw new Error(`cash_accounts upsert failed: ${promoteError.message}`)
    }
    if (promoted && promoted.length > 0) {
      if (transferPrimary) {
        try {
          await setPrimary(supabase, companyId, promotableRowId)
        } catch (primaryError) {
          // The promote itself succeeded; losing the primary flag is
          // recoverable via the AccountPicker, so log instead of unwinding.
          log.error('upsertFromPsd2 primary transfer failed', {
            companyId,
            cashAccountId: promotableRowId,
            error: primaryError instanceof Error ? primaryError.message : String(primaryError),
          })
        }
      }
      return
    }
    // Holder row vanished between SELECT and UPDATE: fall through to upsert.
    // Any rows the rebind above already moved onto it were SET NULL by the
    // transactions.cash_account_id FK when it went; the next sync re-ingests
    // them under the fresh row (the same self-heal as a deleted twin).
  }

  const { error } = await supabase
    .from('cash_accounts')
    .upsert(payload, { onConflict: 'company_id,bank_connection_id,external_uid' })

  if (error) {
    log.error('upsertFromPsd2 failed', {
      companyId,
      bankConnectionId: input.bank_connection_id,
      externalUid: input.external_uid,
      error: error.message,
    })
    throw new Error(`cash_accounts upsert failed: ${error.message}`)
  }
}

/**
 * Find (or create) a manual cash account for a BAS ledger slot, so transactions
 * ingested outside the PSD2 flow (create_transactions / CSV) can carry a real
 * cash_account_id instead of NULL. Without the link, reconciliation 404s on the
 * account and the match dialog falls back to 1930 (issue #1016).
 *
 * Manual rows (source='manual', bank_connection_id=null) are already first-class:
 * every company is seeded a manual 1930 the same way, and upsertFromPsd2 promotes
 * a manual holder in place if a bank later claims the slot. So pre-creating one
 * here does NOT race the PSD2 sync (the concern noted in lib/transactions/ingest.ts):
 * the worst case is a later connection promoting this row, which is the intended flow.
 *
 * Keyed on the (company_id, ledger_account) UNIQUE constraint: a concurrent
 * insert surfaces as 23505, which we treat as "someone else won the race" and
 * re-read. The row's currency follows the first transaction that created it; a
 * ledger account holds one currency by that same constraint.
 */
export async function ensureManualCashAccount(
  supabase: SupabaseClient,
  companyId: string,
  ledgerAccount: string,
  currency: string,
  name?: string | null,
): Promise<string> {
  const existing = await supabase
    .from('cash_accounts')
    .select('id, currency')
    .eq('company_id', companyId)
    .eq('ledger_account', ledgerAccount)
    .maybeSingle()
  if (existing.error) {
    throw new Error(`ensureManualCashAccount lookup failed: ${existing.error.message}`)
  }
  if (existing.data) {
    const row = existing.data as { id: string; currency: string | null }
    // (company_id, ledger_account) is UNIQUE, so a ledger holds exactly one
    // currency. A different-currency transaction pointing at the same ledger is
    // a real conflict (e.g. a SEK row landing on a ledger already claimed for
    // USD): fail loudly instead of binding it to the wrong-currency account.
    if (row.currency && row.currency.toUpperCase() !== currency.toUpperCase()) {
      throw new Error(
        `Cash account ${ledgerAccount} is denominated in ${row.currency}, not ${currency.toUpperCase()}`,
      )
    }
    return row.id
  }

  const insert = await supabase
    .from('cash_accounts')
    .insert({
      company_id: companyId,
      ledger_account: ledgerAccount,
      currency: currency.toUpperCase(),
      name: name?.trim() || `Bankkonto ${currency.toUpperCase()}`,
      enabled: true,
      is_primary: false,
      source: 'manual' as CashAccountSource,
    })
    .select('id')
    .single()

  if (insert.error) {
    // Lost the (company_id, ledger_account) race: re-read the winner's row.
    if (insert.error.code === '23505') {
      const reread = await supabase
        .from('cash_accounts')
        .select('id')
        .eq('company_id', companyId)
        .eq('ledger_account', ledgerAccount)
        .maybeSingle()
      if (reread.data) return (reread.data as { id: string }).id
    }
    log.error('ensureManualCashAccount insert failed', {
      companyId,
      ledgerAccount,
      error: insert.error.message,
    })
    throw new Error(`ensureManualCashAccount insert failed: ${insert.error.message}`)
  }

  return (insert.data as { id: string }).id
}

/**
 * Toggle a cash account's enabled flag. Used by the AccountPicker when a user
 * opts in or out of syncing a particular PSD2 account.
 */
export async function setEnabled(
  supabase: SupabaseClient,
  companyId: string,
  cashAccountId: string,
  enabled: boolean,
): Promise<void> {
  const { error } = await supabase
    .from('cash_accounts')
    .update({ enabled })
    .eq('company_id', companyId)
    .eq('id', cashAccountId)
  if (error) throw new Error(`cash_accounts setEnabled failed: ${error.message}`)
}

/**
 * Remap a cash account to a different BAS ledger account. Triggers RLS + the
 * (company_id, ledger_account) UNIQUE constraint: surface conflict errors so
 * the UI can prompt the user to resolve.
 */
export async function setLedgerAccount(
  supabase: SupabaseClient,
  companyId: string,
  cashAccountId: string,
  ledgerAccount: string,
): Promise<void> {
  const { error } = await supabase
    .from('cash_accounts')
    .update({ ledger_account: ledgerAccount })
    .eq('company_id', companyId)
    .eq('id', cashAccountId)
  if (error) throw new Error(`cash_accounts setLedgerAccount failed: ${error.message}`)
}

/**
 * Mark a cash account as the primary for its company. Delegates to the
 * `set_cash_account_primary` RPC so the clear-old-primary and set-new-primary
 * updates happen inside a single transaction. The intermediate "no primary"
 * state is never visible to concurrent readers: important because
 * skattekonto-booking's __PRIMARY_SEK__ resolver runs through getPrimary() and
 * would otherwise see null in the gap and mis-route the counter account.
 */
export async function setPrimary(
  supabase: SupabaseClient,
  companyId: string,
  cashAccountId: string,
): Promise<void> {
  const { error } = await supabase.rpc('set_cash_account_primary', {
    p_company_id: companyId,
    p_cash_account_id: cashAccountId,
  })
  if (error) {
    throw new Error(`cash_accounts setPrimary failed: ${error.message}`)
  }
}
