import type { SupabaseClient } from '@supabase/supabase-js'
import { normalizeIban } from '@/lib/cash-accounts/service'
import { fetchAllRows } from '@/lib/supabase/fetch-all'
import { createLogger } from '@/lib/logger'
import { ENABLE_BANKING_AGGREGATOR } from '@/lib/bank-sync/aggregator'
import type { StoredAccount } from '../types'

const log = createLogger('enable-banking/session-sharing')

/**
 * Cross-company PSD2 session reuse.
 *
 * Several ASPSPs (SEB most visibly) allow only one active AIS session per PSU.
 * A user who signs for company A, then company B, then company C at the same
 * bank ends up with only the newest session alive: each authorization revokes
 * the previous one bank-side, without telling us. Prod bears this out: every
 * SEB customer holding connections for more than one company has had an
 * earlier company stop syncing at the moment the next one was authorized,
 * usually while its consent was still formally valid for weeks.
 *
 * The fix is to stop minting one session per company. Enable Banking's
 * authorization is per-PSU, not per-company: POST /auth carries no account
 * restriction, so the returned session already covers every account the user
 * ticked at the bank, and GET /accounts/{uid}/transactions takes no session id
 * at all. So a second company can simply point at the first company's session
 * and sync its own accounts from it, with no second BankID and nothing revoked.
 *
 * What is shared is exactly the consent: `session_id` and `consent_expires`.
 * Everything else stays per-company - its own bank_connections row, its own
 * accounts_data subset, its own cash_accounts and transactions. Company B's
 * row never carries an account company A already claimed, so the shared
 * session is not a window into another company's books.
 */

/** A live session belonging to one of the user's other companies. */
export interface ReusableSession {
  /** The source connection whose session would be shared. */
  connectionId: string
  companyId: string
  companyName: string | null
  bankName: string | null
  provider: string
  sessionId: string
  psuType: string | null
  consentExpires: string | null
  /** Accounts in that session no company has mapped to a ledger yet. */
  availableAccounts: StoredAccount[]
}

/**
 * Accounts in a session that no cash_accounts row has claimed.
 *
 * Identity is the IBAN, matching resolvePsd2LedgerAccount: the provider's
 * account uid does not survive a re-authorization at every ASPSP, so it cannot
 * decide ownership. Accounts WITHOUT an IBAN are deliberately never offered.
 * We cannot prove such an account is unclaimed, and handing one to a second
 * company risks two companies booking the same physical account, which is a
 * far worse outcome than making the user authorize separately for it.
 */
export function unclaimedAccountsFor(
  accounts: readonly StoredAccount[],
  claimedIbans: ReadonlySet<string>,
): StoredAccount[] {
  const out: StoredAccount[] = []
  const seen = new Set<string>()
  for (const account of accounts) {
    const iban = normalizeIban(account.iban)
    if (!iban) continue
    if (claimedIbans.has(iban)) continue
    // One session can list the same IBAN twice (some ASPSPs return a separate
    // resource per balance type). Offering it twice would let the picker map
    // two rows onto one ledger and trip the UNIQUE constraint on save.
    if (seen.has(iban)) continue
    seen.add(iban)
    // The source company's enable/disable choice is its own; company B starts
    // with everything on and unchecks in the picker. Drop the source's ledger
    // mapping too: that number belongs to the other company's chart. The
    // claimed_by_* flags are likewise the source row's history: everything
    // offered here is unclaimed by definition, so a stale flag must not
    // render a "synkas i annat bolag" note on a genuinely free account.
    const {
      ledger_account: _ledger,
      claimed_by_company_id: _claimedId,
      claimed_by_company_name: _claimedName,
      deselected_elsewhere: _deselected,
      ...rest
    } = account
    out.push({ ...rest, enabled: true })
  }
  return out
}

/**
 * Connection statuses that let go of the attaching company's OWN account: a
 * session the bank ended ('expired') or a connection the user removed
 * ('revoked') feeds nothing. Any other status may still feed the account, so
 * attaching it to a second session would book its movements twice. The same
 * rule as attach_shared_bank_session.
 */
const OWN_ACCOUNT_RELEASING_STATUSES: ReadonlySet<string> = new Set(['expired', 'revoked'])

/**
 * Every IBAN a company is actually syncing. RLS scopes cash_accounts to
 * user_company_ids(), which is exactly the set that could collide, so no
 * explicit company filter is needed here.
 *
 * Only ENABLED rows count as claimed, and that distinction is what makes this
 * feature work at all. The connect callback mirrors every account in the
 * consent into cash_accounts, deselected ones included, so treating any row as
 * a claim would mean a bank's whole consent is spoken for the moment the first
 * company connects and no account is ever free to offer.
 *
 * Enabled-only also matches how people actually work: signing once at the bank
 * returns every account the user can see, and they uncheck the other
 * companies' accounts in the picker precisely because those do not belong in
 * this company's books. Those are the accounts the next company should get.
 *
 * The attaching company's own account is not a claim against itself unless a
 * connection may still feed it. At a one-session bank (SEB) a sibling's new
 * login ends this company's session, and the sibling's session then covers
 * this company's account too: reusing it is the only way back that does not
 * end the sibling's feed in turn. The picker then promotes the existing row
 * by IBAN, the same way a renewal does.
 */
/**
 * Returns null when the claimed set could not be read. An empty Set would be
 * indistinguishable from "nothing is claimed", which makes every IBAN in the
 * session offerable: the one outcome this feature must never produce. The
 * caller turns null into an empty offer list.
 */
async function fetchClaimedIbans(
  supabase: SupabaseClient,
  activeCompanyId: string,
): Promise<Set<string> | null> {
  const { data, error } = await supabase
    .from('cash_accounts')
    .select('iban, company_id, bank_connection_id, bank_connection:bank_connections(status)')
    .eq('enabled', true)
    .not('iban', 'is', null)

  if (error) {
    // Fail closed: without the claimed set we cannot tell a free account from
    // one another company already books to, and offering a claimed account is
    // the one outcome this feature must never produce.
    log.warn('claimed iban lookup failed, offering nothing', { error: error.message })
    return null
  }

  const claimed = new Set<string>()
  for (const row of (data ?? []) as unknown as Array<{
    iban: string | null
    company_id?: string | null
    bank_connection_id?: string | null
    bank_connection?: { status: string | null } | null
  }>) {
    if (row.company_id === activeCompanyId && ownAccountIsReleased(row)) continue
    const iban = normalizeIban(row.iban)
    if (iban) claimed.add(iban)
  }
  return claimed
}

/**
 * Whether the active company's own enabled cash account is free to move onto
 * a shared session: no connection holds it, or the one that does feeds
 * nothing any more. A bound row whose connection cannot be read stays a claim
 * (fail closed).
 */
function ownAccountIsReleased(row: {
  bank_connection_id?: string | null
  bank_connection?: { status: string | null } | null
}): boolean {
  if (!row.bank_connection_id) return true
  const status = row.bank_connection?.status
  return typeof status === 'string' && OWN_ACCOUNT_RELEASING_STATUSES.has(status)
}

/**
 * Live sessions the user holds in OTHER companies that still have accounts to
 * give. Returns an empty list, not an error, whenever nothing qualifies: the
 * caller renders an offer only when there is something to offer.
 *
 * Sources are restricted to status 'active'. A 'pending_selection' source is
 * authorized and alive, but its owner has not finished picking accounts yet,
 * so every account would read as unclaimed and company B could take one
 * company A is seconds away from choosing.
 */
export async function findReusableSessions(
  supabase: SupabaseClient,
  userId: string,
  activeCompanyId: string,
): Promise<ReusableSession[]> {
  const nowIso = new Date().toISOString()

  const { data: rows, error } = await supabase
    .from('bank_connections')
    .select('id, company_id, bank_name, provider, session_id, psu_type, consent_expires, accounts_data')
    .eq('user_id', userId)
    // Only an Enable Banking session is shareable; an Open Payments consent is
    // bound to the one company that signed it.
    .eq('aggregator', ENABLE_BANKING_AGGREGATOR)
    .eq('status', 'active')
    .neq('company_id', activeCompanyId)
    .not('session_id', 'is', null)
    .gt('consent_expires', nowIso)

  if (error) {
    log.warn('reusable session lookup failed', { activeCompanyId, error: error.message })
    return []
  }
  if (!rows || rows.length === 0) return []

  const claimedIbans = await fetchClaimedIbans(supabase, activeCompanyId)
  if (claimedIbans === null) {
    // Offer nothing rather than everything: see fetchClaimedIbans.
    return []
  }
  const ibanCarriers = await fetchIbanCarriers(supabase, userId)

  const typed = rows as Array<{
    id: string
    company_id: string
    bank_name: string | null
    provider: string
    session_id: string
    psu_type: string | null
    consent_expires: string | null
    accounts_data: StoredAccount[] | null
  }>

  const companyNames = await fetchCompanyNames(
    supabase,
    [...new Set(typed.map(r => r.company_id))],
  )

  const sessions: ReusableSession[] = []
  for (const row of typed) {
    // A cash_accounts row is not the only way an account gets taken. Between
    // attaching a company and finishing its picker, the account is carried in
    // that company's accounts_data and nothing has claimed a ledger yet. Offer
    // it again in that window and two companies end up booking one physical
    // account, which is the failure this feature is supposed to prevent.
    const unavailable = new Set(claimedIbans)
    for (const [iban, carrierCompanyIds] of ibanCarriers) {
      for (const carrierCompanyId of carrierCompanyIds) {
        if (carrierCompanyId !== row.company_id) {
          unavailable.add(iban)
          break
        }
      }
    }

    const availableAccounts = unclaimedAccountsFor(row.accounts_data ?? [], unavailable)
    if (availableAccounts.length === 0) continue
    sessions.push({
      connectionId: row.id,
      companyId: row.company_id,
      companyName: companyNames.get(row.company_id) ?? null,
      bankName: row.bank_name,
      provider: row.provider,
      sessionId: row.session_id,
      psuType: row.psu_type,
      consentExpires: row.consent_expires,
      availableAccounts,
    })
  }
  return sessions
}

/**
 * Which companies currently carry each IBAN in their connection metadata,
 * whether or not a ledger has been mapped yet. This is what closes the window
 * between attaching a company and that company finishing its account picker.
 */
async function fetchIbanCarriers(
  supabase: SupabaseClient,
  userId: string,
): Promise<Map<string, Set<string>>> {
  const { data, error } = await supabase
    .from('bank_connections')
    .select('company_id, accounts_data')
    .eq('user_id', userId)
    .in('status', ['active', 'pending_selection'])

  const carriers = new Map<string, Set<string>>()
  if (error) {
    log.warn('iban carrier lookup failed', { error: error.message })
    return carriers
  }

  for (const row of (data ?? []) as Array<{ company_id: string; accounts_data: StoredAccount[] | null }>) {
    for (const account of row.accounts_data ?? []) {
      // Deselected accounts are not held. Freshly attached rows carry
      // everything as enabled, so the attach-to-picker window is still closed;
      // but once a company unchecks an account, it has to become available
      // again or the first company to look at it would block it forever.
      if (account.enabled === false) continue
      const iban = normalizeIban(account.iban)
      if (!iban) continue
      const existing = carriers.get(iban)
      if (existing) existing.add(row.company_id)
      else carriers.set(iban, new Set([row.company_id]))
    }
  }
  return carriers
}

/** The claimant companies' names and whether each is archived; empty when the lookup fails. */
async function fetchClaimantCompanies(
  supabase: SupabaseClient,
  companyIds: readonly string[],
): Promise<Map<string, { name: string | null; archived: boolean }>> {
  if (companyIds.length === 0) return new Map()
  const { data, error } = await supabase
    .from('companies')
    .select('id, name, archived_at')
    .in('id', [...companyIds])
  if (error) {
    log.warn('claimant company lookup failed', { error: error.message })
    return new Map()
  }
  return new Map(
    ((data ?? []) as Array<{ id: string; name: string | null; archived_at?: string | null }>).map(c => [
      c.id,
      { name: c.name || null, archived: Boolean(c.archived_at) },
    ]),
  )
}

async function fetchCompanyNames(
  supabase: SupabaseClient,
  companyIds: readonly string[],
): Promise<Map<string, string>> {
  if (companyIds.length === 0) return new Map()
  const { data, error } = await supabase
    .from('companies')
    .select('id, name')
    .in('id', [...companyIds])
  if (error) {
    log.warn('company name lookup failed', { error: error.message })
    return new Map()
  }
  return new Map(
    ((data ?? []) as Array<{ id: string; name: string | null }>)
      .filter((c): c is { id: string; name: string } => !!c.name)
      .map(c => [c.id, c.name]),
  )
}

/** The company whose books an IBAN is already synced into. */
export interface ForeignIbanClaim {
  companyId: string
  companyName: string | null
}

export interface CrossCompanyAccountContext {
  /**
   * Normalized IBAN → the OTHER company of this user that already books it
   * (enabled cash_accounts row, or an enabled account on a live-ish
   * connection). First claimant wins; which sibling is named is cosmetic.
   * Never contains an IBAN the ACTIVE company itself already books: the
   * active company's standing state outranks a sibling's claim, whatever row
   * the callback happens to be finalizing (a bank-list renewal arrives on a
   * FRESH row with no priors, and must not switch a working feed off).
   */
  claims: Map<string, ForeignIbanClaim>
  /**
   * Normalized IBANs the user has deselected ("Synkas ej") on other
   * connection rows, in any company, so a fresh connection row does not
   * resurrect an account the user already opted out of (the recurring
   * came-back-pre-checked complaint). Only rows whose selection the user has
   * actually SAVED contribute ('active'/'expired'/'error'):
   * a 'pending_selection' row's flags are unconfirmed callback output,
   * including this guard's own fail-closed writes, and treating them as user
   * intent would make one abandoned picker (or one transient lookup error)
   * poison every later connect. Cleared of anything the active company
   * books or a sibling claims (both outrank a remembered deselection).
   */
  deselectedIbans: Set<string>
  /**
   * Normalized IBANs the ACTIVE company already books: enabled cash_accounts
   * rows, plus enabled accounts on its own live-ish connection rows. Exposed
   * for the callers/tests; claims and deselectedIbans are already cleaned
   * against it.
   */
  activeCompanyIbans: Set<string>
}

/**
 * What the user's OTHER companies already do with each IBAN, for the OAuth
 * callback's cross-company guard. At one-session banks (SEB) the PSU's single
 * consent can cover accounts that belong in a sibling company's books, and the
 * callback stores whatever the session returns: without this lookup those
 * accounts land pre-enabled in the wrong company.
 *
 * Runs on the callback's SERVICE-ROLE client, so nothing is RLS-scoped:
 * every query below filters on the user's own rows explicitly
 * (bank_connections.user_id, cash_accounts.company_id via company_members),
 * and "the user's companies" is the set RLS would give: memberships in
 * companies that are not archived, as user_company_ids() and
 * attach_shared_bank_session define it. An archived company books nothing,
 * so it claims nothing (crm#1241).
 *
 * Returns null when any lookup failed. The caller must fail closed (treat
 * every unrecognized account as not-safe-to-pre-check): an empty result is
 * indistinguishable from "nothing is claimed", which is the one answer this
 * guard must never invent.
 */
export async function fetchCrossCompanyAccountContext(
  serviceSupabase: SupabaseClient,
  userId: string,
  activeCompanyId: string,
  excludeConnectionId: string,
): Promise<CrossCompanyAccountContext | null> {
  const claims = new Map<string, ForeignIbanClaim>()
  const deselectedIbans = new Set<string>()
  const activeCompanyIbans = new Set<string>()

  // Statuses whose accounts count: a revoked row's accounts are released
  // territory; 'expired'/'error' still count (a sibling whose feed
  // momentarily died at a one-session bank has NOT given its accounts up).
  // 'pending_selection' rows count ASYMMETRICALLY: their enabled accounts
  // still claim, because an attach-created row holds deliberately-offered
  // accounts with no cash_accounts rows until its picker is saved, and
  // ignoring that window lets a second company take the same physical
  // account (the exact failure fetchIbanCarriers documents). Their DISABLED
  // flags are unconfirmed callback output though - including this guard's
  // own fail-closed writes - so they never feed the deselection memory:
  // one abandoned picker or transient lookup error must not poison every
  // later connect.
  let connectionRows: Array<{
    id: string
    company_id: string
    status: string
    accounts_data: StoredAccount[] | null
  }>
  try {
    connectionRows = await fetchAllRows(range =>
      serviceSupabase
        .from('bank_connections')
        .select('id, company_id, status, accounts_data')
        .eq('user_id', userId)
        .neq('id', excludeConnectionId)
        .in('status', ['active', 'pending_selection', 'expired', 'error'])
        // Unique-column order: fetchAllRows pages with .range(), and an
        // unordered paged read can silently SKIP rows at page boundaries:
        // a skipped row here is a missed claim, which fails open.
        .order('id')
        .range(range.from, range.to),
    )
  } catch (connectionError) {
    log.error('cross-company claim lookup failed (bank_connections)', {
      activeCompanyId,
      error: connectionError instanceof Error ? connectionError.message : String(connectionError),
    })
    return null
  }

  // The user's live companies: archived ones are filtered out in PostgREST,
  // the same set user_company_ids() gives RLS. cash_accounts is read for
  // these below, and a connection row counts only when its company is one.
  const { data: membershipRows, error: membershipError } = await serviceSupabase
    .from('company_members')
    .select('company_id, companies!inner(archived_at)')
    .eq('user_id', userId)
    .is('companies.archived_at', null)

  if (membershipError) {
    log.error('cross-company claim lookup failed (company_members)', {
      activeCompanyId,
      error: membershipError.message,
    })
    return null
  }

  const memberCompanyIds = [
    ...new Set(
      ((membershipRows ?? []) as Array<{ company_id: string }>).map(r => r.company_id),
    ),
  ]
  const liveCompanyIds = new Set(memberCompanyIds)

  for (const row of connectionRows) {
    // An archived company's row (or one in a company the user has left) is
    // neither a claim nor a remembered deselection.
    if (!liveCompanyIds.has(row.company_id)) continue
    for (const account of row.accounts_data ?? []) {
      const iban = normalizeIban(account.iban)
      if (!iban) continue
      if (account.enabled === false) {
        if (row.status !== 'pending_selection') deselectedIbans.add(iban)
      } else if (row.company_id === activeCompanyId) {
        activeCompanyIbans.add(iban)
      } else if (!claims.has(iban)) {
        claims.set(iban, { companyId: row.company_id, companyName: null })
      }
    }
  }

  // cash_accounts catches standing state the connection rows no longer carry
  // (older connects, CSV-era rows promoted onto a feed, a row a supersede is
  // about to demote). ALL of the user's live companies are read: sibling rows
  // become claims, the active company's rows become its own standing set.
  // Scoped via memberships, since the service client sees everything.
  if (memberCompanyIds.length > 0) {
    let cashRows: Array<{ company_id: string; iban: string | null }>
    try {
      // fetchAllRows, not a bare select: PostgREST silently caps at 1000
      // rows, and a silently truncated claim set fails OPEN for exactly the
      // multi-company consultants this guard exists for.
      cashRows = await fetchAllRows(range =>
        serviceSupabase
          .from('cash_accounts')
          .select('company_id, iban')
          .in('company_id', memberCompanyIds)
          .eq('enabled', true)
          .not('iban', 'is', null)
          // Unique-column order: see the bank_connections page above.
          .order('id')
          .range(range.from, range.to),
      )
    } catch (cashError) {
      log.error('cross-company claim lookup failed (cash_accounts)', {
        activeCompanyId,
        error: cashError instanceof Error ? cashError.message : String(cashError),
      })
      return null
    }

    for (const row of cashRows) {
      const iban = normalizeIban(row.iban)
      if (!iban) continue
      if (row.company_id === activeCompanyId) {
        activeCompanyIbans.add(iban)
      } else if (!claims.has(iban)) {
        claims.set(iban, { companyId: row.company_id, companyName: null })
      }
    }
  }

  // Precedence, strongest first: the active company's own standing state
  // (a renewal must never switch a working feed off, whichever row it
  // arrives on), then a sibling's claim, then a remembered deselection (the
  // picker note "synkas i X" is strictly more information than a bare
  // unchecked box).
  for (const iban of activeCompanyIbans) {
    claims.delete(iban)
    deselectedIbans.delete(iban)
  }
  for (const iban of claims.keys()) deselectedIbans.delete(iban)

  if (claims.size > 0) {
    const claimants = await fetchClaimantCompanies(serviceSupabase, [
      ...new Set([...claims.values()].map(c => c.companyId)),
    ])
    for (const [iban, claim] of claims) {
      const company = claimants.get(claim.companyId)
      // An archived company reads and books nothing: its accounts are
      // released territory, like a revoked row's. A company made anew (Gör
      // om migrering archives the old one) otherwise found every account
      // locked to its archived copy. An unknown claimant (the lookup
      // failed) keeps its claim: this guard fails closed.
      if (company?.archived) {
        claims.delete(iban)
        continue
      }
      claim.companyName = company?.name ?? null
    }
  }

  return { claims, deselectedIbans, activeCompanyIbans }
}

export interface SessionRenewalResult {
  /** Sibling rows moved onto the new session. */
  movedCount: number
}

/**
 * Carry a renewed consent across to every company sharing the old session.
 *
 * One re-authorization is what the user performed, so one re-authorization is
 * what every sharing company gets. Without this the other companies would keep
 * pointing at the session the bank just replaced and would fail on their next
 * sync, which is the original problem wearing a different hat.
 *
 * Siblings parked in 'expired'/'error' are revived to 'active' (a live session
 * is exactly what they were missing); 'active' and 'pending_selection' rows
 * keep their status, since pending_selection means the user still owes that
 * company an account selection.
 */
export async function fanOutSessionRenewal(
  supabase: SupabaseClient,
  input: {
    oldSessionId: string
    newSessionId: string
    consentExpires: string | null
    excludeConnectionId: string
    /** Accounts the renewed session returned, for remapping sibling uids. */
    sessionAccounts: readonly { uid: string; iban?: string | null; currency: string }[]
  },
): Promise<SessionRenewalResult> {
  const { oldSessionId, newSessionId, consentExpires, excludeConnectionId, sessionAccounts } = input
  if (!oldSessionId || oldSessionId === newSessionId) return { movedCount: 0 }

  let siblings: Array<{ id: string; company_id: string }>
  try {
    siblings = await fetchAllRows(range => supabase
      .from('bank_connections')
      .select('id, company_id')
      .eq('aggregator', ENABLE_BANKING_AGGREGATOR)
      .eq('session_id', oldSessionId)
      .neq('id', excludeConnectionId)
      .neq('status', 'revoked')
      .order('id')
      .range(range.from, range.to))
  } catch (error) {
    log.error('failed to load siblings for session renewal', { error: error instanceof Error ? error.message : String(error) })
    return { movedCount: 0 }
  }
  if (siblings.length === 0) return { movedCount: 0 }

  let movedCount = 0
  for (const sibling of siblings) {
    const { data, error } = await supabase.rpc('renew_shared_bank_connection', {
      p_company_id: sibling.company_id,
      p_connection_id: sibling.id,
      p_source_connection_id: excludeConnectionId,
      p_old_session_id: oldSessionId,
      p_new_session_id: newSessionId,
      p_consent_expires: consentExpires,
      p_session_accounts: sessionAccounts,
    })
    if (error || !data?.applied) {
      log.warn('shared session renewal was not applied', {
        connectionId: sibling.id,
        error: error?.message,
        reason: data?.reason,
      })
      continue
    }
    movedCount += 1
    if (data.unmatched > 0) {
      log.warn('renewed session does not cover every account a company uses', {
        connectionId: sibling.id,
        unmatched: data.unmatched,
      })
    }
  }

  if (movedCount > 0) {
    log.info('renewed session carried to sibling connections', {
      movedCount,
      excludeConnectionId,
    })
  }
  return { movedCount }
}
