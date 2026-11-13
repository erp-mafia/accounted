import { type SupabaseClient } from '@supabase/supabase-js'
import { parseEntityType } from '@/lib/company/entity-type'
import { createServiceRoleClient } from '@/lib/supabase/service-client'
import { fetchAllRows } from '@/lib/supabase/fetch-all'
import { toRedovisare12 } from '@/lib/invariants/org-number'
import { createLogger } from '@/lib/logger'
import { chunk } from '@/lib/utils'
import { isMissingColumnError } from '@/lib/pending-operations/agent-reason'
import { todayIsoStockholm } from '@/lib/dates/iso'
import { SKATTEKONTO_AUDIT_ENDPOINTS } from './skattekonto-client'

const log = createLogger('skatteverket-connection-store')

/**
 * Accessor for skatteverket_company_connections: the per-company system-auth
 * (ombud grant) state.
 *
 * All writes route through a service-role client (mirrors token-store.ts):
 * probes run with system credentials server-side and the calling routes
 * enforce user identity and role before reaching this module. User sessions
 * can only SELECT (RLS).
 */

let _serviceClient: SupabaseClient | null = null
function getServiceClient(): SupabaseClient {
  if (_serviceClient) return _serviceClient
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) {
    throw new Error(
      'skatteverket connection-store requires NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY'
    )
  }
  _serviceClient = createServiceRoleClient(url, key)
  return _serviceClient
}

export type SkvEnvironment = 'test' | 'production'
export type SkvBehorighet = 'lasombud' | 'moms_ombud'
export type GrantStatus = 'unknown' | 'granted' | 'denied' | 'error'
export type ConnectionStatus = 'pending' | 'partial' | 'verified' | 'revoked' | 'error'

export interface SkvCompanyConnection {
  id: string
  company_id: string
  environment: SkvEnvironment
  org_number: string
  status: ConnectionStatus
  lasombud_status: GrantStatus
  lasombud_checked_at: string | null
  moms_ombud_status: GrantStatus
  moms_ombud_checked_at: string | null
  verified_at: string | null
  last_probe_at: string | null
  last_probe_detail: Record<string, unknown> | null
  last_error: string | null
  /**
   * The company's opt-in for THIS org number: the first check or deep link
   * on it, both from the appoint button (reset when the org number changes,
   * see recordProbeResult). A grant only counts when it was signed on or after
   * this day (ombudGrantCounts in ombud-client.ts).
   */
  created_at: string
}

const CONNECTION_COLUMNS =
  'id, company_id, environment, org_number, status, lasombud_status, lasombud_checked_at, ' +
  'moms_ombud_status, moms_ombud_checked_at, verified_at, last_probe_at, last_probe_detail, last_error, created_at'

/**
 * The company's connection row, null when it has none. A read failure THROWS:
 * callers that decide or write grant state must not mistake a failed read for
 * "no row" (that would move the opt-in day to today, or overwrite a granted
 * row as if it were new).
 */
export async function getConnectionOrThrow(
  companyId: string,
  environment: SkvEnvironment
): Promise<SkvCompanyConnection | null> {
  const { data, error } = await getServiceClient()
    .from('skatteverket_company_connections')
    .select(CONNECTION_COLUMNS)
    .eq('company_id', companyId)
    .eq('environment', environment)
    .maybeSingle()
  if (error) {
    throw new Error(`skatteverket_company_connections read failed: ${error.message}`)
  }
  return (data as SkvCompanyConnection | null) ?? null
}

/** getConnectionOrThrow for display and read-auth paths: a failed read is "no row". */
export async function getConnection(
  companyId: string,
  environment: SkvEnvironment
): Promise<SkvCompanyConnection | null> {
  try {
    return await getConnectionOrThrow(companyId, environment)
  } catch (err) {
    log.warn('getConnection failed', {
      companyId,
      environment,
      error: err instanceof Error ? err.message : String(err),
    })
    return null
  }
}

/** Aggregate status from the per-behorighet grant states. */
function aggregateStatus(
  lasombud: GrantStatus,
  momsOmbud: GrantStatus
): ConnectionStatus {
  const states = [lasombud, momsOmbud]
  const grantedCount = states.filter((s) => s === 'granted').length
  if (grantedCount === states.length) return 'verified'
  if (grantedCount > 0) return 'partial'
  if (states.every((s) => s === 'denied')) return 'pending'
  if (states.some((s) => s === 'error')) return 'error'
  return 'pending'
}

export interface ProbeResultInput {
  companyId: string
  environment: SkvEnvironment
  orgNumber: string
  createdBy?: string
  /** `reason` is stored with the detail for the settings panel (e.g. predates_opt_in). */
  lasombud?: { status: GrantStatus; detail?: unknown; reason?: string }
  momsOmbud?: { status: GrantStatus; detail?: unknown; reason?: string }
  error?: string | null
  /**
   * The company opened the deep link again: a grant Skatteverket withdrew is
   * awaited anew from now on, so its 'withdrawn' mark goes (see storedDetail).
   */
  reopened?: boolean
}

type StoredDetail = { status?: GrantStatus; detail?: unknown; reason?: string } | null

/**
 * The detail stored for one behorighet. A grant that was there on this opt-in
 * and is not any more is marked `reason: 'withdrawn'`, and the mark stays
 * while the behorighet is not granted. The register answers a withdrawn grant
 * and one it has not registered yet the same way (nothing listed), so the
 * mark is what tells them apart: red in settings, against a wait
 * (lib/skatteverket/ombud-appointment.ts). A grant the sync holds back on a
 * contested org number is marked the same way: it no longer counts either. A
 * grant clears the mark, and so does a new deep link (`reopened`); a reason
 * the probe gives itself (predates_opt_in) wins.
 */
function storedDetail(
  previous: { status: GrantStatus; detail: StoredDetail },
  next: GrantStatus,
  probe: ProbeResultInput['lasombud'],
  reopened: boolean
): StoredDetail {
  const kept: StoredDetail = probe ?? previous.detail ?? null
  if (!kept) return null
  const wasGranted = previous.status === 'granted' || previous.detail?.reason === 'withdrawn'
  if (wasGranted && next !== 'granted' && !reopened && !probe?.reason) {
    return { ...kept, reason: 'withdrawn' }
  }
  if (kept.reason !== 'withdrawn') return kept
  const { reason: _withdrawn, ...rest } = kept
  return rest
}

/**
 * Persist a probe outcome. Transient errors never downgrade a previously
 * granted behorighet: only an explicit 'denied' classification does.
 */
export async function recordProbeResult(
  input: ProbeResultInput
): Promise<SkvCompanyConnection | null> {
  const supabase = getServiceClient()
  let stored: SkvCompanyConnection | null
  try {
    stored = await getConnectionOrThrow(input.companyId, input.environment)
  } catch (err) {
    // Writing blind could turn a granted row into 'error' or reset its
    // opt-in: record nothing, report the failure like a failed upsert.
    log.error('recordProbeResult: connection read failed; nothing recorded', err as Error, {
      companyId: input.companyId,
      environment: input.environment,
    })
    return null
  }
  const now = new Date().toISOString()
  // A row is the opt-in for ONE org number. When the company now answers for
  // another number, nothing recorded for the old one carries over: grant
  // states, verification time and the opt-in day all start again, so a grant
  // the previous number's owner signed can never be inherited.
  const orgNumberChanged = stored !== null && stored.org_number !== input.orgNumber
  const existing = orgNumberChanged ? null : stored

  const nextGrant = (
    previous: GrantStatus,
    probe: { status: GrantStatus } | undefined
  ): GrantStatus => {
    if (!probe) return previous
    if (probe.status === 'error' && previous === 'granted') return 'granted'
    return probe.status
  }

  const lasombudStatus = nextGrant(existing?.lasombud_status ?? 'unknown', input.lasombud)
  const momsOmbudStatus = nextGrant(existing?.moms_ombud_status ?? 'unknown', input.momsOmbud)
  const status = aggregateStatus(lasombudStatus, momsOmbudStatus)
  const previousDetail = (key: SkvBehorighet): StoredDetail =>
    (existing?.last_probe_detail?.[key] as StoredDetail | undefined) ?? null

  const row: Record<string, unknown> = {
    company_id: input.companyId,
    environment: input.environment,
    org_number: input.orgNumber,
    status,
    lasombud_status: lasombudStatus,
    moms_ombud_status: momsOmbudStatus,
    last_probe_at: now,
    // A behorighet this probe did not ask about keeps its detail, as it keeps its status.
    last_probe_detail: {
      lasombud: storedDetail(
        { status: existing?.lasombud_status ?? 'unknown', detail: previousDetail('lasombud') },
        lasombudStatus,
        input.lasombud,
        input.reopened === true
      ),
      moms_ombud: storedDetail(
        { status: existing?.moms_ombud_status ?? 'unknown', detail: previousDetail('moms_ombud') },
        momsOmbudStatus,
        input.momsOmbud,
        input.reopened === true
      ),
    },
    last_error: input.error ?? null,
  }
  if (input.lasombud) row.lasombud_checked_at = now
  if (input.momsOmbud) row.moms_ombud_checked_at = now
  if (input.createdBy && !existing) row.created_by = input.createdBy
  if (status === 'verified' && !existing?.verified_at) row.verified_at = now
  if (orgNumberChanged) {
    row.created_at = now
    if (status !== 'verified') row.verified_at = null
  }

  const { data, error } = await supabase
    .from('skatteverket_company_connections')
    .upsert(row, { onConflict: 'company_id,environment' })
    .select(CONNECTION_COLUMNS)
    .single()

  if (error) {
    log.error('recordProbeResult failed', error, {
      companyId: input.companyId,
      environment: input.environment,
    })
    return null
  }
  return data as unknown as SkvCompanyConnection
}

/** Set the whole connection revoked (explicit user disconnect). */
export async function markConnectionRevoked(
  companyId: string,
  environment: SkvEnvironment
): Promise<void> {
  const { error } = await getServiceClient()
    .from('skatteverket_company_connections')
    .update({
      status: 'revoked',
      lasombud_status: 'unknown',
      moms_ombud_status: 'unknown',
    })
    .eq('company_id', companyId)
    .eq('environment', environment)
  if (error) {
    log.warn('markConnectionRevoked failed', { companyId, error: error.message })
  }
}

/**
 * Companies whose given behorighet is granted, for cron enumeration.
 */
export async function listVerifiedCompanies(
  environment: SkvEnvironment,
  behorighet: SkvBehorighet
): Promise<Array<{ company_id: string; org_number: string; created_by: string | null }>> {
  type Row = { company_id: string; org_number: string; created_by: string | null }
  const column = behorighet === 'lasombud' ? 'lasombud_status' : 'moms_ombud_status'
  try {
    const client = getServiceClient()
    // Every granted company, not a first page: a fixed cap here silently
    // left companies past it on personal tokens (the sync cron orders and
    // caps its own work list).
    const rows = await fetchAllRows<Row>(({ from, to }) =>
      client
        .from('skatteverket_company_connections')
        .select('company_id, org_number, created_by')
        .eq('environment', environment)
        .in('status', ['verified', 'partial'])
        .eq(column, 'granted')
        .order('company_id', { ascending: true })
        .range(from, to)
    )
    return await keepRowsOnCurrentOrgNumber(rows)
  } catch (error) {
    log.warn('listVerifiedCompanies failed', {
      environment,
      behorighet,
      error: error instanceof Error ? error.message : String(error),
    })
    return []
  }
}

/**
 * The rows whose company STILL answers for the org number the row was
 * verified on (company_settings, 12-digit redovisare form). System reads
 * address Skatteverket by the company's current org number, so a grant
 * recorded for another number must not serve them: a tenant could otherwise
 * verify its own number, then switch its settings to a number whose owner
 * appointed Accounted. Fails closed: a settings read error keeps nothing.
 */
export async function keepRowsOnCurrentOrgNumber<T extends { company_id: string; org_number: string }>(
  rows: T[]
): Promise<T[]> {
  if (rows.length === 0) return []
  const current = new Map<string, string>()
  const ids = [...new Set(rows.map((row) => row.company_id))]
  const client = getServiceClient()
  for (let i = 0; i < ids.length; i += 200) {
    const { data, error } = await client
      .from('company_settings')
      .select('company_id, org_number, entity_type')
      .in('company_id', ids.slice(i, i + 200))
    if (error) {
      log.warn('org-number binding check failed; no row kept', { error: error.message })
      return []
    }
    for (const settings of (data ?? []) as Array<{ company_id: string; org_number: string | null; entity_type: string | null }>) {
      if (!settings.org_number) continue
      try {
        current.set(settings.company_id, toRedovisare12(settings.org_number, parseEntityType(settings.entity_type)))
      } catch {
        // An unparsable org number binds to nothing.
      }
    }
  }
  return rows.filter((row) => current.get(row.company_id) === row.org_number)
}

/**
 * Every connection row for an environment, for the ombudsregister sync. The
 * caller decides what a row's status means ('revoked' rows are the tenant's
 * own disconnect and are skipped there). Paginated through fetchAllRows on a
 * stable (created_at, id) order so nothing past PostgREST's 1000-row page is
 * silently left stale. The select is spelled out rather than reusing
 * CONNECTION_COLUMNS so the phantom-column scanner can check it.
 */
export async function listConnections(environment: SkvEnvironment): Promise<SkvCompanyConnection[]> {
  try {
    const client = getServiceClient()
    return await fetchAllRows<SkvCompanyConnection>(({ from, to }) =>
      client
        .from('skatteverket_company_connections')
        .select('id, company_id, environment, org_number, status, lasombud_status, lasombud_checked_at, moms_ombud_status, moms_ombud_checked_at, verified_at, last_probe_at, last_probe_detail, last_error, created_at')
        .eq('environment', environment)
        .order('created_at', { ascending: true })
        .order('id', { ascending: true })
        .range(from, to)
    )
  } catch (error) {
    log.warn('listConnections failed', {
      environment,
      error: error instanceof Error ? error.message : String(error),
    })
    return []
  }
}

/**
 * Where a company stands on the org number it asks Accounted's ombud
 * connection for (the appoint button's check and deep link, the check on
 * return from signing, the hourly register sync):
 *
 *   'clear'        : it may hold the connection. Either no other live
 *                    company claims the number, or it is the ONE claimant a
 *                    current member proved with their own BankID.
 *   'unproven'     : other live companies claim the number too and no member
 *                    of this one has proven it, or the company does not
 *                    (or no longer) claim the number at all.
 *   'proven_twice' : this company has proven it, and so has another claimant.
 */
export type OmbudClaimStanding = 'clear' | 'unproven' | 'proven_twice'

/**
 * The one definition of who may hold the ombud connection on an org number
 * (founder decision 2026-11-08). Org-number reuse is allowed in the product
 * and org numbers are public, but the ombud path binds Skatteverket's
 * system-credential access to the number: a tenant that typed a victim's
 * number must never inherit the victim's grant. Only a live claimant of the
 * number can pass: a connection row a company left on a number it no longer
 * answers for (or an archived company's row) never does, whoever claims the
 * number now. A sole claimant passes as before. Among several, only the
 * company with ownership proof passes (see
 * findCompaniesWithOwnershipProof): something only a person Skatteverket
 * lets represent the number can produce, recorded against that one company.
 * Two proven claimants are both held back: the grant cannot follow either.
 *
 * `claimants` are the live companies whose current org number this is;
 * `proven` the companies with ownership proof on it.
 */
export function ombudClaimStanding(
  companyId: string,
  claimants: readonly string[],
  proven: ReadonlySet<string>
): OmbudClaimStanding {
  if (!claimants.includes(companyId)) return 'unproven'
  if (claimants.length === 1) return 'clear'
  const provenClaimants = claimants.filter((id) => proven.has(id))
  if (!provenClaimants.includes(companyId)) return 'unproven'
  return provenClaimants.length === 1 ? 'clear' : 'proven_twice'
}

/** Live (non-archived) companies per org number, in 12-digit redovisare form. */
async function findLiveClaimants(): Promise<Map<string, string[]>> {
  const client = getServiceClient()
  type SettingsRow = { company_id: string; org_number: string | null; entity_type: string | null }
  type ArchivedRow = { id: string }
  const [settings, archived] = await Promise.all([
    fetchAllRows<SettingsRow>(({ from, to }) =>
      client
        .from('company_settings')
        .select('company_id, org_number, entity_type')
        .not('org_number', 'is', null)
        .order('company_id', { ascending: true })
        .range(from, to)
    ),
    fetchAllRows<ArchivedRow>(({ from, to }) =>
      client
        .from('companies')
        .select('id')
        .not('archived_at', 'is', null)
        .order('id', { ascending: true })
        .range(from, to)
    ),
  ])
  const archivedIds = new Set(archived.map((row) => row.id))
  const claimants = new Map<string, string[]>()
  for (const row of settings) {
    if (!row.org_number || archivedIds.has(row.company_id)) continue
    let redovisare: string
    try {
      redovisare = toRedovisare12(row.org_number, parseEntityType(row.entity_type))
    } catch {
      continue
    }
    const ids = claimants.get(redovisare)
    if (ids) ids.push(row.company_id)
    else claimants.set(redovisare, [row.company_id])
  }
  return claimants
}

/**
 * The own-BankID reads that prove a person may see one behörighet's data for
 * a number: the skattekonto reads for läsombud; for momsombud the filed VAT
 * views (fetchDeclarationView in declaration-status labels each call by its
 * view) and the VAT draft read (the /declaration/draft route).
 */
const PROOF_ENDPOINTS: Record<SkvBehorighet, readonly string[]> = {
  lasombud: Object.values(SKATTEKONTO_AUDIT_ENDPOINTS),
  moms_ombud: ['inlamnat', 'beslutat', 'declaration/draft'],
}

/**
 * The claims (company on its current org number) with ownership proof, each
 * with the Swedish day of its latest proof: a read of `behorighet`'s data
 * (PROOF_ENDPOINTS; the skattekonto by default, which the contested-number
 * standing uses) for exactly that number, recorded against that company,
 * that Skatteverket answered (2xx) on the own BankID session of a person who
 * is still a member of the company. Skatteverket shows a tax account only to
 * someone who may represent its holder, so a tenant that typed another
 * company's number cannot produce it. Per company, never per person: the
 * session is stored per (person, company) and the row names the company the
 * read was made for, so a member of two companies on one number proves only
 * the one they connected. A read on Accounted's own certificate
 * (auth_mode 'system') is no proof, and neither is a row from before
 * auth_mode was recorded. Throws on a read failure: the callers fail closed.
 * The day is what lets a grant signed before the opt-in count
 * (grantCountsFor).
 */
export async function findCompaniesWithOwnershipProof(
  claims: Array<{ companyId: string; orgNumber: string }>,
  behorighet: SkvBehorighet = 'lasombud'
): Promise<Map<string, string>> {
  if (claims.length === 0) return new Map()
  const client = getServiceClient()
  const members = new Map<string, string[]>()
  for (const ids of chunk([...new Set(claims.map((claim) => claim.companyId))], 200)) {
    const rows = await fetchAllRows<{ company_id: string; user_id: string }>(({ from, to }) =>
      client
        .from('company_members')
        .select('company_id, user_id')
        .in('company_id', ids)
        .order('company_id', { ascending: true })
        .order('user_id', { ascending: true })
        .range(from, to)
    )
    for (const row of rows) {
      const userIds = members.get(row.company_id)
      if (userIds) userIds.push(row.user_id)
      else members.set(row.company_id, [row.user_id])
    }
  }
  const memberClaims = claims.filter((claim) => members.has(claim.companyId))
  const answers = await Promise.all(
    memberClaims.map((claim) =>
      client
        .from('skatteverket_api_audit_log')
        .select('created_at')
        .eq('company_id', claim.companyId)
        .eq('ag_registered_id', claim.orgNumber)
        .eq('auth_mode', 'user')
        .eq('outcome', 'ok')
        .in('endpoint', PROOF_ENDPOINTS[behorighet])
        // 'ok' is a 2xx for these reads today; the range keeps it so should
        // they ever list okStatuses (a 404 "no skattekonto" proves nothing).
        .gte('response_status', 200)
        .lt('response_status', 300)
        .in('user_id', members.get(claim.companyId)!)
        .order('created_at', { ascending: false })
        .limit(1)
    )
  )
  const proven = new Map<string, string>()
  for (const [i, { data, error }] of answers.entries()) {
    // Before migration 20261108074117 reaches the database there is no
    // auth_mode to read, and so no proof yet: every contested claim stays
    // held back, and uncontested ones are not dragged into a failure.
    if (isMissingColumnError(error)) return new Map()
    if (error) throw new Error(`ownership proof read failed: ${error.message}`)
    const latest = (data as Array<{ created_at: string }> | null)?.[0]
    if (latest) proven.set(memberClaims[i]!.companyId, todayIsoStockholm(new Date(latest.created_at)))
  }
  return proven
}

/**
 * ombudClaimStanding for each claim (a company and the 12-digit org number it
 * asks the connection for), keyed by company id. Proof is only read for the
 * claimants of contested numbers. Throws when a read fails, so no caller
 * mistakes a failed read for a clear claim.
 */
export async function getOmbudClaimStandings(
  claims: Array<{ companyId: string; orgNumber: string }>
): Promise<Map<string, OmbudClaimStanding>> {
  if (claims.length === 0) return new Map()
  const claimants = await findLiveClaimants()
  const contested = [...new Set(claims.map((claim) => claim.orgNumber))].filter(
    (orgNumber) => (claimants.get(orgNumber)?.length ?? 0) > 1
  )
  const proofs = await findCompaniesWithOwnershipProof(
    contested.flatMap((orgNumber) =>
      (claimants.get(orgNumber) ?? []).map((companyId) => ({ companyId, orgNumber }))
    )
  )
  const proven = new Set(proofs.keys())
  return new Map(
    claims.map((claim) => [
      claim.companyId,
      ombudClaimStanding(claim.companyId, claimants.get(claim.orgNumber) ?? [], proven),
    ])
  )
}

/** getOmbudClaimStandings for one company. */
export async function getOmbudClaimStanding(
  companyId: string,
  orgNumber: string
): Promise<OmbudClaimStanding> {
  return (await getOmbudClaimStandings([{ companyId, orgNumber }])).get(companyId) ?? 'unproven'
}
