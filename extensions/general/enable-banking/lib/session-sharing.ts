import type { SupabaseClient } from '@supabase/supabase-js'
import { normalizeIban } from '@/lib/cash-accounts/service'
import { createLogger } from '@/lib/logger'
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
 * Everything else stays per-company — its own bank_connections row, its own
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
      ...rest
    } = account
    out.push({ ...rest, enabled: true })
  }
  return out
}

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
 */
/**
 * Returns null when the claimed set could not be read. An empty Set would be
 * indistinguishable from "nothing is claimed", which makes every IBAN in the
 * session offerable: the one outcome this feature must never produce. The
 * caller turns null into an empty offer list.
 */
async function fetchClaimedIbans(supabase: SupabaseClient): Promise<Set<string> | null> {
  const { data, error } = await supabase
    .from('cash_accounts')
    .select('iban')
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
  for (const row of (data ?? []) as Array<{ iban: string | null }>) {
    const iban = normalizeIban(row.iban)
    if (iban) claimed.add(iban)
  }
  return claimed
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
    .eq('status', 'active')
    .neq('company_id', activeCompanyId)
    .not('session_id', 'is', null)
    .gt('consent_expires', nowIso)

  if (error) {
    log.warn('reusable session lookup failed', { activeCompanyId, error: error.message })
    return []
  }
  if (!rows || rows.length === 0) return []

  const claimedIbans = await fetchClaimedIbans(supabase)
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
   */
  claims: Map<string, ForeignIbanClaim>
  /**
   * Normalized IBANs the user has deselected ("Synkas ej") on ANY of their
   * other connection rows, in any company. A per-row memory only: the OAuth
   * callback consults this so a fresh connection row does not resurrect an
   * account the user already opted out of elsewhere (the recurring
   * came-back-pre-checked complaint).
   */
  deselectedIbans: Set<string>
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
 * (bank_connections.user_id, cash_accounts.company_id via company_members).
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

  // Live-ish statuses only: a revoked row's accounts are released territory.
  // 'expired'/'error' still claim: a sibling whose feed momentarily died (the
  // common state at one-session banks right after another company authorized)
  // has NOT given its accounts up.
  const { data: connectionRows, error: connectionError } = await serviceSupabase
    .from('bank_connections')
    .select('id, company_id, accounts_data')
    .eq('user_id', userId)
    .neq('id', excludeConnectionId)
    .in('status', ['active', 'pending_selection', 'expired', 'error'])

  if (connectionError) {
    log.error('cross-company claim lookup failed (bank_connections)', {
      activeCompanyId,
      error: connectionError.message,
    })
    return null
  }

  for (const row of (connectionRows ?? []) as Array<{
    id: string
    company_id: string
    accounts_data: StoredAccount[] | null
  }>) {
    for (const account of row.accounts_data ?? []) {
      const iban = normalizeIban(account.iban)
      if (!iban) continue
      if (account.enabled === false) {
        deselectedIbans.add(iban)
      } else if (row.company_id !== activeCompanyId && !claims.has(iban)) {
        claims.set(iban, { companyId: row.company_id, companyName: null })
      }
    }
  }

  // cash_accounts catches claims the connection rows no longer carry (older
  // connects, CSV-era rows promoted onto a feed). Scoped to the user's other
  // companies via their memberships, since the service client sees everything.
  const { data: membershipRows, error: membershipError } = await serviceSupabase
    .from('company_members')
    .select('company_id')
    .eq('user_id', userId)

  if (membershipError) {
    log.error('cross-company claim lookup failed (company_members)', {
      activeCompanyId,
      error: membershipError.message,
    })
    return null
  }

  const otherCompanyIds = [
    ...new Set(
      ((membershipRows ?? []) as Array<{ company_id: string }>)
        .map(r => r.company_id)
        .filter(id => id !== activeCompanyId),
    ),
  ]

  if (otherCompanyIds.length > 0) {
    const { data: cashRows, error: cashError } = await serviceSupabase
      .from('cash_accounts')
      .select('company_id, iban')
      .in('company_id', otherCompanyIds)
      .eq('enabled', true)
      .not('iban', 'is', null)

    if (cashError) {
      log.error('cross-company claim lookup failed (cash_accounts)', {
        activeCompanyId,
        error: cashError.message,
      })
      return null
    }

    for (const row of (cashRows ?? []) as Array<{ company_id: string; iban: string | null }>) {
      const iban = normalizeIban(row.iban)
      if (iban && !claims.has(iban)) {
        claims.set(iban, { companyId: row.company_id, companyName: null })
      }
    }
  }

  // A claim outranks a remembered deselection: the picker note ("synkas i X")
  // is strictly more information than a bare unchecked box.
  for (const iban of claims.keys()) deselectedIbans.delete(iban)

  if (claims.size > 0) {
    const names = await fetchCompanyNames(serviceSupabase, [
      ...new Set([...claims.values()].map(c => c.companyId)),
    ])
    for (const claim of claims.values()) {
      claim.companyName = names.get(claim.companyId) ?? null
    }
  }

  return { claims, deselectedIbans }
}

/**
 * How many OTHER connections still depend on this session.
 *
 * Must run on a service-role client. RLS would hide a sibling living in a
 * company the user has since left, and an invisible sibling reads as zero,
 * which is precisely the case where revoking kills a feed that is still in use.
 *
 * Counts every non-revoked sibling, including ones parked in 'expired' or
 * 'error'. The asymmetry is deliberate: leaving a consent un-revoked costs us
 * nothing but a row at Enable Banking that lapses on its own within 90 days,
 * while revoking one that another company is still syncing from takes down a
 * working bank feed with no warning.
 */
export async function countLiveSiblings(
  serviceSupabase: SupabaseClient,
  sessionId: string,
  excludeConnectionId: string,
): Promise<number> {
  const { count, error } = await serviceSupabase
    .from('bank_connections')
    .select('id', { count: 'exact', head: true })
    .eq('session_id', sessionId)
    .neq('id', excludeConnectionId)
    .neq('status', 'revoked')

  if (error) {
    log.error('sibling count failed, treating session as shared', {
      sessionId: '[REDACTED]',
      error: error.message,
    })
    // Fail closed again: pretend a sibling exists rather than revoke a session
    // we could not prove is unshared.
    return 1
  }
  return count ?? 0
}

export interface SessionRenewalResult {
  /** Sibling rows moved onto the new session. */
  movedCount: number
}

/**
 * Point a company's stored accounts at the uids the renewed session issued.
 *
 * Several ASPSPs mint fresh account uids on every re-authorization. The company
 * that clicked "renew" gets remapped by the callback's own IBAN matching, but a
 * sibling still holds the previous session's uids, and
 * GET /accounts/{uid}/transactions against a superseded uid fails. So the
 * quarterly renewal would keep breaking exactly the companies this feature
 * exists to keep alive, one layer further down.
 *
 * The sibling's own choices (which accounts are enabled, which ledger each
 * books to) are preserved: only the uid moves. An account whose IBAN is absent
 * from the new session is left untouched rather than dropped, since silently
 * discarding a mapped account is worse than a visible sync error.
 */
export function remapAccountUids(
  accounts: readonly StoredAccount[],
  sessionAccounts: readonly { uid: string; iban?: string | null }[],
): { accounts: StoredAccount[]; remapped: number; unmatched: number } {
  const uidByIban = new Map<string, string>()
  for (const account of sessionAccounts) {
    const iban = normalizeIban(account.iban)
    if (iban) uidByIban.set(iban, account.uid)
  }

  let remapped = 0
  let unmatched = 0
  const out = accounts.map(account => {
    const iban = normalizeIban(account.iban)
    const newUid = iban ? uidByIban.get(iban) : undefined
    if (!newUid) {
      unmatched += 1
      return account
    }
    if (newUid === account.uid) return account
    remapped += 1
    return { ...account, uid: newUid }
  })

  return { accounts: out, remapped, unmatched }
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
    sessionAccounts?: readonly { uid: string; iban?: string | null }[]
  },
): Promise<SessionRenewalResult> {
  const { oldSessionId, newSessionId, consentExpires, excludeConnectionId, sessionAccounts } = input
  if (!oldSessionId || oldSessionId === newSessionId) return { movedCount: 0 }

  const { data: siblings, error: siblingError } = await supabase
    .from('bank_connections')
    .select('id, status, accounts_data')
    .eq('session_id', oldSessionId)
    .neq('id', excludeConnectionId)
    .neq('status', 'revoked')

  if (siblingError) {
    log.error('failed to load siblings for session renewal', { error: siblingError.message })
    return { movedCount: 0 }
  }
  if (!siblings || siblings.length === 0) return { movedCount: 0 }

  let movedCount = 0
  for (const sibling of siblings as Array<{
    id: string
    status: string
    accounts_data: StoredAccount[] | null
  }>) {
    // Payloads stay object literals (never a built-up Record) so the
    // no-phantom-columns guard can actually verify the column names.
    // A session was the only thing a dead sibling was missing, so bring it
    // back. 'pending_selection' is left alone: that company still owes an
    // account selection, and flipping it to active would skip the picker.
    const isDead = sibling.status === 'expired' || sibling.status === 'error'
    const { error: updateError } = isDead
      ? await supabase
          .from('bank_connections')
          .update({
            session_id: newSessionId,
            consent_expires: consentExpires,
            status: 'active',
            error_message: null,
          })
          .eq('id', sibling.id)
      : await supabase
          .from('bank_connections')
          .update({ session_id: newSessionId, consent_expires: consentExpires })
          .eq('id', sibling.id)

    if (updateError) {
      log.error('failed to move sibling onto renewed session', {
        connectionId: sibling.id,
        error: updateError.message,
      })
      continue
    }
    movedCount += 1

    // Re-pointing the uids is a separate write, and deliberately so: it only
    // happens when the ASPSP actually reissued them, and keeping it out of the
    // payload above means neither write needs a dynamically built object.
    if (sessionAccounts && sessionAccounts.length > 0) {
      const { accounts, remapped, unmatched } = remapAccountUids(
        sibling.accounts_data ?? [],
        sessionAccounts,
      )
      if (unmatched > 0) {
        // The renewed consent no longer covers an account this company books
        // to. Worth surfacing: it usually means the user unticked it at the
        // bank, and that company's next sync will report the gap.
        log.warn('renewed session does not cover every account a company uses', {
          connectionId: sibling.id,
          unmatched,
        })
      }
      if (remapped > 0) {
        const { error: remapError } = await supabase
          .from('bank_connections')
          .update({ accounts_data: accounts })
          .eq('id', sibling.id)
        if (remapError) {
          log.error('failed to re-point sibling accounts at the renewed session', {
            connectionId: sibling.id,
            error: remapError.message,
          })
        }
      }
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
