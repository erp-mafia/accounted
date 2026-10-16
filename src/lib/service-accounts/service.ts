/**
 * Service accounts: a non-human principal a company owns, with a human
 * sponsor who answers for it (migration 20261016120000).
 *
 * A service account belongs to one company and has a name and a sponsor, an
 * owner or admin member of that company. It acts through its own API keys
 * (gnubok_sk_, api_keys.service_account_id). Such a key keeps user_id = the
 * sponsor, so RLS and every path that reads api_keys.user_id treat it as the
 * sponsor, and the database pins it to the account's company. Everything it
 * writes records the actor `service_account` labelled with the account's
 * name, acting for the sponsor (the user the rows carry).
 *
 * The database holds the rules every door must agree on: the sponsor check,
 * the single change a row takes (its revocation, which revokes the keys),
 * the caps, the key binding, and the active-account predicate the key
 * validation reads. This module is the application half for the v1 doors:
 * the owner/admin gate for reads (writes are re-checked in their RPCs), the
 * scope cap of a minted key, the secret shown once, and the views.
 *
 * Imports nothing that reaches lib/init (v1 routes import this module).
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { fetchAllRows } from '@/lib/supabase/fetch-all'
import {
  API_KEY_SCOPES,
  findStageApproveConflict,
  generateApiKey,
  type ApiKeyMode,
  type ApiKeyScope,
  type ApiKeyServiceAccount,
} from '@/lib/auth/api-keys'

/** Roles that may manage service accounts and that a sponsor must hold. */
export const SERVICE_ACCOUNT_ADMIN_ROLES = ['owner', 'admin'] as const

/** The scope a v1 key needs to manage service accounts. Never granted to a service account's own key. */
export const SERVICE_ACCOUNTS_MANAGE_SCOPE: ApiKeyScope = 'service_accounts:manage'

/**
 * active: may act. suspended: its sponsor is not an owner or admin of the
 * company (or the company is archived), so its keys are refused until that
 * changes. revoked: final; its keys are revoked with it.
 */
export type ServiceAccountStatus = 'active' | 'suspended' | 'revoked'

export interface ServiceAccountKeyView {
  id: string
  name: string
  key_prefix: string
  scopes: string[]
  mode: ApiKeyMode
  /** read_only when minted with read_only: only read scopes apply in the company. */
  access: 'read_write' | 'read_only'
  created_at: string
  last_used_at: string | null
  revoked_at: string | null
}

export interface ServiceAccountView {
  id: string
  company_id: string
  name: string
  sponsor_user_id: string
  status: ServiceAccountStatus
  created_by: string
  created_at: string
  revoked_at: string | null
  revoked_by: string | null
}

export interface ServiceAccountDetailView extends ServiceAccountView {
  keys: ServiceAccountKeyView[]
}

/** One account for an overview: its view, who sponsors it by name, and how many keys it has. */
export interface ServiceAccountSummary extends ServiceAccountView {
  /** The sponsor's name, else their email; null when neither is on file. */
  sponsor_name: string | null
  /** Keys that work (not revoked); 0 for a revoked account. */
  live_key_count: number
  revoked_key_count: number
}

/** A domain refusal: a structured error code (lib/errors/structured-errors.ts) and its details. */
export interface ServiceAccountFailure {
  ok: false
  code: string
  details?: Record<string, unknown>
}

export type ServiceAccountResult<T> = { ok: true; value: T } | ServiceAccountFailure

/** Who is calling, through which key: a v1 route builds it from its context. */
export interface ServiceAccountCaller {
  userId: string
  /** The calling key's scopes: a minted key can never hold more. */
  scopes: ApiKeyScope[]
  /** The calling key's own service account, or null for a person's key. */
  serviceAccount: ApiKeyServiceAccount | null
  /** The acting credential, stamped into the audit rows the writes leave. */
  actor: { type: string; label?: string }
}

interface ServiceAccountRow {
  id: string
  company_id: string
  name: string
  sponsor_user_id: string
  created_by: string
  created_at: string
  revoked_at: string | null
  revoked_by: string | null
}

interface KeyRow {
  id: string
  name: string
  key_prefix: string
  scopes: string[] | null
  mode: string | null
  created_at: string
  last_used_at: string | null
  revoked_at: string | null
  service_account_id: string
}


/** The refusals the database raises with the code as the message prefix (migration 20261016120000). */
const DATABASE_CODES = new Set([
  'SERVICE_ACCOUNT_ADMIN_REQUIRED',
  'SERVICE_ACCOUNT_SPONSOR_INVALID',
  'SERVICE_ACCOUNT_LIMIT',
  'SERVICE_ACCOUNT_KEY_LIMIT',
  'SERVICE_ACCOUNT_NOT_FOUND',
  'SERVICE_ACCOUNT_REVOKED',
  'SERVICE_ACCOUNT_SUSPENDED',
])

function failure(code: string, details?: Record<string, unknown>): ServiceAccountFailure {
  return { ok: false, code, ...(details ? { details } : {}) }
}

/**
 * A database refusal mapped to its structured code, or null for anything
 * else (which the caller rethrows as an internal error).
 */
export function serviceAccountDatabaseFailure(
  error: { code?: string; message?: string } | null | undefined,
): ServiceAccountFailure | null {
  if (!error) return null
  const prefix = (error.message ?? '').split(':', 1)[0]!.trim()
  if (DATABASE_CODES.has(prefix)) return failure(prefix)
  // The live-name unique index (service_accounts_live_name_key).
  if (error.code === '23505') return failure('SERVICE_ACCOUNT_NAME_TAKEN')
  return null
}

function isAdminRole(role: string | null | undefined): boolean {
  return (SERVICE_ACCOUNT_ADMIN_ROLES as readonly string[]).includes(role ?? '')
}

/**
 * The gate for every service-account door: a person's key (a service account
 * never manages service accounts, its own or another), held by an owner or
 * admin of the company. The write RPCs re-check the role in the database.
 */
export async function assertCanManageServiceAccounts(
  supabase: SupabaseClient,
  companyId: string,
  caller: Pick<ServiceAccountCaller, 'userId' | 'serviceAccount'>,
): Promise<ServiceAccountFailure | null> {
  if (caller.serviceAccount) {
    return failure('SERVICE_ACCOUNT_KEY_NOT_PERMITTED', { service_account_id: caller.serviceAccount.id })
  }
  const { data, error } = await supabase
    .from('company_members')
    .select('role')
    .eq('company_id', companyId)
    .eq('user_id', caller.userId)
    .maybeSingle()
  if (error) throw error
  if (!isAdminRole((data as { role?: string } | null)?.role)) {
    return failure('SERVICE_ACCOUNT_ADMIN_REQUIRED', { required_roles: [...SERVICE_ACCOUNT_ADMIN_ROLES] })
  }
  return null
}

/**
 * Status of each account, the application mirror of
 * service_account_is_active() (migration 20261016120000): revoked when
 * revoked; suspended when the company is archived or the sponsor is not an
 * owner or admin member; active otherwise. The database decides whether a
 * key is let through; this only reports it.
 */
async function withStatus(
  supabase: SupabaseClient,
  companyId: string,
  rows: ServiceAccountRow[],
): Promise<ServiceAccountView[]> {
  if (rows.length === 0) return []
  const sponsors = [...new Set(rows.map((row) => row.sponsor_user_id))]
  const [members, company] = await Promise.all([
    supabase.from('company_members').select('user_id, role').eq('company_id', companyId).in('user_id', sponsors),
    supabase.from('companies').select('archived_at').eq('id', companyId).maybeSingle(),
  ])
  if (members.error) throw members.error
  if (company.error) throw company.error
  const archived = Boolean((company.data as { archived_at?: string | null } | null)?.archived_at)
  const roles = new Map(
    ((members.data ?? []) as Array<{ user_id: string; role: string }>).map((m) => [m.user_id, m.role]),
  )
  return rows.map((row) => ({
    ...toView(row),
    status: row.revoked_at
      ? 'revoked'
      : archived || !isAdminRole(roles.get(row.sponsor_user_id))
        ? 'suspended'
        : 'active',
  }))
}

function toView(row: ServiceAccountRow): Omit<ServiceAccountView, 'status'> {
  return {
    id: row.id,
    company_id: row.company_id,
    name: row.name,
    sponsor_user_id: row.sponsor_user_id,
    created_by: row.created_by,
    created_at: row.created_at,
    revoked_at: row.revoked_at,
    revoked_by: row.revoked_by,
  }
}

function toKeyView(row: KeyRow, readOnlyKeyIds: Set<string>): ServiceAccountKeyView {
  return {
    id: row.id,
    name: row.name,
    key_prefix: row.key_prefix,
    scopes: row.scopes ?? [],
    mode: row.mode === 'test' ? 'test' : 'live',
    access: readOnlyKeyIds.has(row.id) ? 'read_only' : 'read_write',
    created_at: row.created_at,
    last_used_at: row.last_used_at,
    revoked_at: row.revoked_at,
  }
}

/** The company's service accounts, live first by creation, then the revoked ones. */
export async function listServiceAccounts(
  supabase: SupabaseClient,
  companyId: string,
): Promise<ServiceAccountView[]> {
  const { data, error } = await supabase
    .from('service_accounts')
    .select('id, company_id, name, sponsor_user_id, created_by, created_at, revoked_at, revoked_by')
    .eq('company_id', companyId)
    .order('created_at', { ascending: false })
    .order('id', { ascending: true })
  if (error) throw error
  const views = await withStatus(supabase, companyId, (data ?? []) as ServiceAccountRow[])
  return [...views.filter((v) => v.status !== 'revoked'), ...views.filter((v) => v.status === 'revoked')]
}

/**
 * The company's service accounts for an overview (the MCP list tool): each
 * account's view with its sponsor's name and its live and revoked key counts.
 * Never a secret: keys are only counted.
 */
export async function summarizeServiceAccounts(
  supabase: SupabaseClient,
  companyId: string,
): Promise<ServiceAccountSummary[]> {
  const accounts = await listServiceAccounts(supabase, companyId)
  if (accounts.length === 0) return []
  const ids = accounts.map((account) => account.id)
  const sponsors = [...new Set(accounts.map((account) => account.sponsor_user_id))]
  const [keys, profiles] = await Promise.all([
    // Revoked keys accumulate for as long as the accounts are kept: paged.
    fetchAllRows<{ id: string; service_account_id: string; revoked_at: string | null }>(({ from, to }) =>
      supabase
        .from('api_keys')
        .select('id, service_account_id, revoked_at')
        .eq('company_id', companyId)
        .in('service_account_id', ids)
        .order('id', { ascending: true })
        .range(from, to),
    ),
    supabase.from('profiles').select('id, full_name, email').in('id', sponsors),
  ])
  if (profiles.error) throw profiles.error
  const names = new Map(
    ((profiles.data ?? []) as Array<{ id: string; full_name: string | null; email: string | null }>).map((p) => [
      p.id,
      p.full_name?.trim() || p.email?.trim() || null,
    ]),
  )
  const live = new Map<string, number>()
  const revoked = new Map<string, number>()
  for (const key of keys) {
    const counts = key.revoked_at ? revoked : live
    counts.set(key.service_account_id, (counts.get(key.service_account_id) ?? 0) + 1)
  }
  return accounts.map((account) => ({
    ...account,
    sponsor_name: names.get(account.sponsor_user_id) ?? null,
    live_key_count: live.get(account.id) ?? 0,
    revoked_key_count: revoked.get(account.id) ?? 0,
  }))
}

async function loadAccount(
  supabase: SupabaseClient,
  companyId: string,
  serviceAccountId: string,
): Promise<ServiceAccountRow | null> {
  const { data, error } = await supabase
    .from('service_accounts')
    .select('id, company_id, name, sponsor_user_id, created_by, created_at, revoked_at, revoked_by')
    .eq('company_id', companyId)
    .eq('id', serviceAccountId)
    .maybeSingle()
  if (error) throw error
  return (data as ServiceAccountRow | null) ?? null
}

async function loadKeys(
  supabase: SupabaseClient,
  companyId: string,
  serviceAccountId: string,
  keyId?: string,
): Promise<ServiceAccountKeyView[]> {
  let query = supabase
    .from('api_keys')
    .select('id, name, key_prefix, scopes, mode, created_at, last_used_at, revoked_at, service_account_id')
    .eq('company_id', companyId)
    .eq('service_account_id', serviceAccountId)
  if (keyId) query = query.eq('id', keyId)
  const { data, error } = await query.order('created_at', { ascending: false })
  if (error) throw error
  const rows = (data ?? []) as KeyRow[]
  if (rows.length === 0) return []
  const { data: access, error: accessError } = await supabase
    .from('api_key_companies')
    .select('api_key_id')
    .in('api_key_id', rows.map((row) => row.id))
    .eq('company_id', companyId)
    .eq('access', 'read')
  if (accessError) throw accessError
  const readOnly = new Set(((access ?? []) as Array<{ api_key_id: string }>).map((row) => row.api_key_id))
  return rows.map((row) => toKeyView(row, readOnly))
}

/** One account with its keys (never their secrets), or null when it is not the company's. */
export async function getServiceAccount(
  supabase: SupabaseClient,
  companyId: string,
  serviceAccountId: string,
): Promise<ServiceAccountDetailView | null> {
  const row = await loadAccount(supabase, companyId, serviceAccountId)
  if (!row) return null
  const [[view], keys] = await Promise.all([
    withStatus(supabase, companyId, [row]),
    loadKeys(supabase, companyId, serviceAccountId),
  ])
  return { ...view!, keys }
}

/**
 * Create a service account. The sponsor defaults to the calling key's user,
 * who is an owner or admin (the gate); a named sponsor must be one too, which
 * the database checks.
 */
export async function createServiceAccount(
  supabase: SupabaseClient,
  companyId: string,
  caller: ServiceAccountCaller,
  input: { name: string; sponsorUserId?: string },
): Promise<ServiceAccountResult<ServiceAccountView>> {
  const { data, error } = await supabase.rpc('create_service_account', {
    p_company_id: companyId,
    p_name: input.name,
    p_sponsor_user_id: input.sponsorUserId ?? caller.userId,
    p_created_by: caller.userId,
    p_actor_type: caller.actor.type,
    p_actor_label: caller.actor.label ?? null,
  })
  if (error) {
    const refusal = serviceAccountDatabaseFailure(error)
    if (refusal) return refusal
    throw error
  }
  const row = (Array.isArray(data) ? data[0] : data) as ServiceAccountRow | null
  if (!row?.id) throw new Error('create_service_account returned no row')
  const [view] = await withStatus(supabase, companyId, [row])
  return { ok: true, value: view! }
}

/**
 * Revoke an account and with it every key it has. Idempotent. The database
 * re-checks that `caller.userId` is an owner or admin: the v1 door, the MCP
 * approval and an approval in the app all reach the same RPC.
 */
export async function revokeServiceAccount(
  supabase: SupabaseClient,
  companyId: string,
  caller: Pick<ServiceAccountCaller, 'userId' | 'actor'>,
  serviceAccountId: string,
): Promise<ServiceAccountResult<ServiceAccountView>> {
  const { data, error } = await supabase.rpc('revoke_service_account', {
    p_company_id: companyId,
    p_service_account_id: serviceAccountId,
    p_revoked_by: caller.userId,
    p_actor_type: caller.actor.type,
    p_actor_label: caller.actor.label ?? null,
  })
  if (error) {
    const refusal = serviceAccountDatabaseFailure(error)
    if (refusal) return refusal
    throw error
  }
  const row = (Array.isArray(data) ? data[0] : data) as ServiceAccountRow | null
  // The function answers a NULL composite for an account that is not the
  // company's, which PostgREST hands back as an object of nulls.
  if (!row?.id) return failure('SERVICE_ACCOUNT_NOT_FOUND', { service_account_id: serviceAccountId })
  const [view] = await withStatus(supabase, companyId, [row])
  return { ok: true, value: view! }
}

export interface MintKeyInput {
  name?: string
  scopes: ApiKeyScope[]
  mode?: ApiKeyMode
  /** Only read scopes apply in the company (api_key_companies.access = 'read'). */
  readOnly?: boolean
  /** The caller saw the stage+approve segregation-of-duties warning and goes ahead. */
  acknowledgeSod?: boolean
}

/**
 * Scopes a minted key may not get: anything the calling key does not hold
 * itself. The sponsor is an owner or admin, which every scope is within, so
 * the cap that bites is the caller's own grant: no key can hand out more
 * than it has. service_accounts:manage is refused before this, by the schema.
 */
export function scopesNotHeld(requested: readonly ApiKeyScope[], held: readonly ApiKeyScope[]): ApiKeyScope[] {
  const grant = new Set(held)
  return requested.filter((scope) => !grant.has(scope))
}

/**
 * Mint a key for an active account. Answers the key's view and its secret,
 * which is shown this once and stored only as its SHA-256.
 */
export async function mintServiceAccountKey(
  supabase: SupabaseClient,
  companyId: string,
  caller: ServiceAccountCaller,
  serviceAccountId: string,
  input: MintKeyInput,
): Promise<ServiceAccountResult<{ key: ServiceAccountKeyView; secret: string; sodAcknowledged: boolean }>> {
  const scopes = [...new Set(input.scopes)].filter((scope) => scope in API_KEY_SCOPES)
  if (scopes.length === 0 || scopes.length !== new Set(input.scopes).size) {
    return failure('API_KEY_SCOPE_INVALID', { received: input.scopes })
  }
  if (scopes.includes(SERVICE_ACCOUNTS_MANAGE_SCOPE)) {
    return failure('SERVICE_ACCOUNT_KEY_NOT_PERMITTED', { scope: SERVICE_ACCOUNTS_MANAGE_SCOPE })
  }
  const notHeld = scopesNotHeld(scopes, caller.scopes)
  if (notHeld.length > 0) return failure('SERVICE_ACCOUNT_SCOPE_NOT_HELD', { not_held: notHeld })

  const conflictingScope = findStageApproveConflict(scopes)
  if (conflictingScope && !input.acknowledgeSod) {
    return failure('API_KEY_SOD_CONFLICT', {
      conflicting_scope: conflictingScope,
      approve_scope: 'pending_operations:approve',
    })
  }

  const mode: ApiKeyMode = input.mode === 'test' ? 'test' : 'live'
  const { key, hash, prefix } = generateApiKey(mode)
  const { data: keyId, error } = await supabase.rpc('create_service_account_key', {
    p_company_id: companyId,
    p_service_account_id: serviceAccountId,
    p_key_hash: hash,
    p_key_prefix: prefix,
    p_name: input.name ?? null,
    p_scopes: scopes,
    p_mode: mode,
    p_read_only: input.readOnly === true,
    p_sod_acknowledged_at: conflictingScope ? new Date().toISOString() : null,
    p_created_by: caller.userId,
    p_actor_type: caller.actor.type,
    p_actor_label: caller.actor.label ?? null,
  })
  if (error) {
    const refusal = serviceAccountDatabaseFailure(error)
    if (refusal) return refusal
    throw error
  }
  if (typeof keyId !== 'string') throw new Error('create_service_account_key returned no id')

  const [view] = await loadKeys(supabase, companyId, serviceAccountId, keyId)
  // The key exists: a failed read-back still answers what the call knows.
  const fallback: ServiceAccountKeyView = {
    id: keyId,
    name: input.name ?? '',
    key_prefix: prefix,
    scopes,
    mode,
    access: input.readOnly ? 'read_only' : 'read_write',
    created_at: new Date().toISOString(),
    last_used_at: null,
    revoked_at: null,
  }
  return { ok: true, value: { key: view ?? fallback, secret: key, sodAcknowledged: Boolean(conflictingScope) } }
}

/** Revoke one key of an account. Idempotent. */
export async function revokeServiceAccountKey(
  supabase: SupabaseClient,
  companyId: string,
  caller: ServiceAccountCaller,
  serviceAccountId: string,
  keyId: string,
): Promise<ServiceAccountResult<ServiceAccountKeyView>> {
  const { data, error } = await supabase.rpc('revoke_service_account_key', {
    p_company_id: companyId,
    p_service_account_id: serviceAccountId,
    p_api_key_id: keyId,
    p_revoked_by: caller.userId,
    p_actor_type: caller.actor.type,
    p_actor_label: caller.actor.label ?? null,
  })
  if (error) {
    const refusal = serviceAccountDatabaseFailure(error)
    if (refusal) return refusal
    throw error
  }
  if (!data) {
    return failure('SERVICE_ACCOUNT_KEY_NOT_FOUND', { service_account_id: serviceAccountId, key_id: keyId })
  }
  const [view] = await loadKeys(supabase, companyId, serviceAccountId, keyId)
  if (!view) throw new Error('revoked key not readable')
  return { ok: true, value: view }
}
