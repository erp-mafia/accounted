import { createClient, type SupabaseClient } from '@supabase/supabase-js'
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
  _serviceClient = createClient(url, key, { auth: { persistSession: false } })
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

/** Test hook: reset the memoized service client. */
export function __resetConnectionStoreForTests(): void {
  _serviceClient = null
}
