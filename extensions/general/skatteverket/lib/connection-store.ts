import { type SupabaseClient } from '@supabase/supabase-js'
import { createServiceRoleClient } from '@/lib/supabase/service-client'
import { fetchAllRows } from '@/lib/supabase/fetch-all'
import { toRedovisare12 } from '@/lib/invariants/org-number'
import { createLogger } from '@/lib/logger'

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
}

const CONNECTION_COLUMNS =
  'id, company_id, environment, org_number, status, lasombud_status, lasombud_checked_at, ' +
  'moms_ombud_status, moms_ombud_checked_at, verified_at, last_probe_at, last_probe_detail, last_error'

export async function getConnection(
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
    log.warn('getConnection failed', { companyId, environment, error: error.message })
    return null
  }
  return (data as SkvCompanyConnection | null) ?? null
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
  lasombud?: { status: GrantStatus; detail?: unknown }
  momsOmbud?: { status: GrantStatus; detail?: unknown }
  error?: string | null
}

/**
 * Persist a probe outcome. Transient errors never downgrade a previously
 * granted behorighet: only an explicit 'denied' classification does.
 */
export async function recordProbeResult(
  input: ProbeResultInput
): Promise<SkvCompanyConnection | null> {
  const supabase = getServiceClient()
  const existing = await getConnection(input.companyId, input.environment)
  const now = new Date().toISOString()

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

  const row: Record<string, unknown> = {
    company_id: input.companyId,
    environment: input.environment,
    org_number: input.orgNumber,
    status,
    lasombud_status: lasombudStatus,
    moms_ombud_status: momsOmbudStatus,
    last_probe_at: now,
    last_probe_detail: {
      lasombud: input.lasombud ?? null,
      moms_ombud: input.momsOmbud ?? null,
    },
    last_error: input.error ?? null,
  }
  if (input.lasombud) row.lasombud_checked_at = now
  if (input.momsOmbud) row.moms_ombud_checked_at = now
  if (input.createdBy && !existing) row.created_by = input.createdBy
  if (status === 'verified' && !existing?.verified_at) row.verified_at = now

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

/**
 * Downgrade a behorighet after a company-level OMBUD_GRANT_MISSING observed
 * during background work (companies can withdraw the grant at any time).
 */
export async function markGrantRevoked(
  companyId: string,
  environment: SkvEnvironment,
  behorighet: SkvBehorighet,
  errorCode?: string
): Promise<void> {
  const existing = await getConnection(companyId, environment)
  if (!existing) return

  const now = new Date().toISOString()
  const lasombudStatus = behorighet === 'lasombud' ? 'denied' : existing.lasombud_status
  const momsOmbudStatus = behorighet === 'moms_ombud' ? 'denied' : existing.moms_ombud_status
  const anyGranted = lasombudStatus === 'granted' || momsOmbudStatus === 'granted'

  const { error } = await getServiceClient()
    .from('skatteverket_company_connections')
    .update({
      lasombud_status: lasombudStatus,
      moms_ombud_status: momsOmbudStatus,
      ...(behorighet === 'lasombud'
        ? { lasombud_checked_at: now }
        : { moms_ombud_checked_at: now }),
      status: anyGranted ? 'partial' : 'revoked',
      last_error: errorCode ?? 'OMBUD_GRANT_MISSING',
    })
    .eq('id', existing.id)
  if (error) {
    log.warn('markGrantRevoked failed', { companyId, behorighet, error: error.message })
  }
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
  behorighet: SkvBehorighet,
  limit = 200
): Promise<Array<{ company_id: string; org_number: string; created_by: string | null }>> {
  const column = behorighet === 'lasombud' ? 'lasombud_status' : 'moms_ombud_status'
  const { data, error } = await getServiceClient()
    .from('skatteverket_company_connections')
    .select('company_id, org_number, created_by')
    .eq('environment', environment)
    .in('status', ['verified', 'partial'])
    .eq(column, 'granted')
    .limit(limit)
  if (error) {
    log.warn('listVerifiedCompanies failed', { environment, behorighet, error: error.message })
    return []
  }
  return (data ?? []) as Array<{ company_id: string; org_number: string; created_by: string | null }>
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
        .select('id, company_id, environment, org_number, status, lasombud_status, lasombud_checked_at, moms_ombud_status, moms_ombud_checked_at, verified_at, last_probe_at, last_probe_detail, last_error')
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
 * Org numbers (12-digit redovisare form) claimed by MORE than one live
 * (non-archived) company. Org-number reuse is allowed in the product and
 * tenant isolation is the boundary, but the ombud path binds Skatteverket's
 * system-credential access to an org number: while two tenants claim the
 * same one, neither may be marked granted, or a tenant that typed a victim's
 * public org number would inherit the victim's grant. Verify, deep link and
 * the nightly sync all consult this.
 */
export async function findContestedOrgNumbers(): Promise<Set<string>> {
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
  const claimants = new Map<string, number>()
  for (const row of settings) {
    if (!row.org_number || archivedIds.has(row.company_id)) continue
    let redovisare: string
    try {
      redovisare = toRedovisare12(row.org_number, row.entity_type === 'enskild_firma' ? 'enskild_firma' : 'aktiebolag')
    } catch {
      continue
    }
    claimants.set(redovisare, (claimants.get(redovisare) ?? 0) + 1)
  }
  const contested = new Set<string>()
  for (const [orgNumber, count] of claimants) if (count > 1) contested.add(orgNumber)
  return contested
}

/** True when more than one live company claims this 12-digit org number. */
export async function isOrgNumberContested(orgNumber: string): Promise<boolean> {
  return (await findContestedOrgNumbers()).has(orgNumber)
}
