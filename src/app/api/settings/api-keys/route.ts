import { NextResponse } from 'next/server'
import { z } from 'zod'
import {
  generateApiKey,
  DEFAULT_SCOPES,
  OAUTH_MCP_KEY_NAME,
  validateScopes,
  findStageApproveConflict,
} from '@/lib/auth/api-keys'
import { withRouteContext } from '@/lib/api/with-route-context'
import { createServiceClient } from '@/lib/supabase/server'
import { errorResponse, errorResponseFromCode } from '@/lib/errors/get-structured-error'
import type { ApiKeyMode, ApiKeyScope } from '@/lib/auth/api-keys'
import { getErrorMessage as getUserErrorMessage } from '@/lib/errors/get-error-message'
import { listUserCompaniesForPicker, resolveCompanySelection } from '@/lib/company/company-picker'

/**
 * Optional per-key company allowlist on create. Absent or empty means the
 * key reaches every company the caller belongs to (today's behaviour).
 */
// At least one id: an explicit empty list is refused rather than read as
// unrestricted. Omit company_ids (or send null) for a key that reaches every
// company.
const companyIdsSchema = z.array(z.string().uuid()).min(1).max(200)

/**
 * GET /api/settings/api-keys: list the company's API keys (key value never
 * returned). Each row carries `company_ids` (null = unrestricted) and the
 * response adds `meta.companies`, the caller's companies for the picker, so
 * the panel needs no second endpoint.
 */
export const GET = withRouteContext(
  'api_key.list',
  async (_request, ctx) => {
    const { user, supabase, companyId, log, requestId } = ctx

    // Both live and test keys for the active company. (Test keys are bound to the
    // active company too: they're simulation-only, so they never write real data.)
    const { data, error } = await supabase
      .from('api_keys')
      .select('id, key_prefix, name, scopes, mode, rate_limit_rpm, unattended_commit_limit, last_used_at, revoked_at, created_at')
      .eq('company_id', companyId)
      .order('created_at', { ascending: false })

    if (error) {
      log.error('api_keys list failed', error)
      return errorResponse(error, log, { requestId })
    }

    // api_key_companies is service-role only: the session client would read
    // zero rows and every key would look unrestricted.
    const keys = data ?? []
    const allowlists = new Map<string, string[]>()
    if (keys.length > 0) {
      const { data: rows, error: allowlistError } = await createServiceClient()
        .from('api_key_companies')
        .select('api_key_id, company_id')
        .in('api_key_id', keys.map((key) => key.id))
      if (allowlistError) {
        log.error('api_key_companies list failed', allowlistError)
        return errorResponse(allowlistError, log, { requestId })
      }
      for (const row of rows ?? []) {
        const list = allowlists.get(row.api_key_id) ?? []
        list.push(row.company_id)
        allowlists.set(row.api_key_id, list)
      }
    }

    let companies
    try {
      companies = await listUserCompaniesForPicker(supabase, user.id, { activeCompanyId: companyId })
    } catch (err) {
      log.error('company picker list failed', err)
      return errorResponse(err, log, { requestId })
    }

    return NextResponse.json({
      data: keys.map((key) => ({ ...key, company_ids: allowlists.get(key.id) ?? null })),
      meta: {
        companies: companies.map((company) => ({
          company_id: company.company_id,
          name: company.name,
          is_active: company.company_id === companyId,
        })),
      },
    })
  },
)

/**
 * POST /api/settings/api-keys: create a new API key.
 *
 * Returns the full key exactly once; after this the prefix is the only
 * stored representation.
 */
export const POST = withRouteContext(
  'api_key.create',
  async (request, ctx) => {
    const { user, supabase, companyId, log, requestId } = ctx

    let name = 'Unnamed key'
    let scopes: ApiKeyScope[] = DEFAULT_SCOPES
    let acknowledgeSod = false
    let mode: ApiKeyMode = 'live'
    let requestedCompanyIds: string[] | undefined
    try {
      const body = await request.json()
      if (body.name && typeof body.name === 'string') {
        name = body.name.slice(0, 100)
      }
      acknowledgeSod = body.acknowledge_sod === true
      if (body.mode === 'test') mode = 'test'
      const parsed = validateScopes(body.scopes)
      if (parsed) {
        scopes = parsed
      } else if (body.scopes !== undefined) {
        return errorResponseFromCode('API_KEY_SCOPE_INVALID', log, {
          requestId,
          details: { received: body.scopes },
        })
      }
      if (body.company_ids !== undefined && body.company_ids !== null) {
        const companyIds = companyIdsSchema.safeParse(body.company_ids)
        if (!companyIds.success) {
          return errorResponseFromCode('VALIDATION_ERROR', log, {
            requestId,
            details: { field: 'company_ids', reason: 'invalid', received: body.company_ids },
          })
        }
        requestedCompanyIds = companyIds.data
      }
    } catch {
      // Empty body: use defaults.
    }

    // The OAuth token route's key name is the marker the Hem checklist reads
    // as "connected to Claude" (there is no source column). A hand-minted key
    // with that name would tick the step without any connection, so the name
    // is reserved for the OAuth path.
    if (name.trim() === OAUTH_MCP_KEY_NAME) {
      return errorResponseFromCode('VALIDATION_ERROR', log, {
        requestId,
        details: { field: 'name', reason: 'reserved', reserved: OAUTH_MCP_KEY_NAME },
      })
    }

    // The caller's live memberships, with roles: the allowlist below is
    // validated against them, and the key's company must be one the caller
    // administers.
    let memberships
    try {
      memberships = await listUserCompaniesForPicker(supabase, user.id, { activeCompanyId: companyId })
    } catch (err) {
      log.error('company picker list failed', err)
      return errorResponse(err, log, { requestId })
    }

    // Company allowlist. Every id must be a live membership of the caller
    // (403 otherwise: a key must never reach a company its creator cannot).
    // Keeping every company selected means an unrestricted key, so rows are
    // written only for a strict subset. The key's default company is the
    // active one when it is in the set, otherwise the first selected in
    // picker order.
    let keyCompanyId = companyId
    let allowlist: string[] | null = null
    if (requestedCompanyIds && requestedCompanyIds.length > 0) {
      const memberIds = new Set(memberships.map((company) => company.company_id))
      const foreign = requestedCompanyIds.filter((id) => !memberIds.has(id))
      if (foreign.length > 0) {
        return errorResponseFromCode('FORBIDDEN', log, {
          requestId,
          details: { field: 'company_ids', reason: 'not_a_member', company_ids: foreign },
        })
      }
      const selection = resolveCompanySelection(requestedCompanyIds, memberships, companyId)
      if (selection) {
        keyCompanyId = selection.defaultCompanyId
        allowlist = selection.companyIds
      }
    }

    // Only an owner or admin of the key's company may mint a key for it.
    // This was the api_keys_insert policy's job while the row was inserted
    // through the session client; the atomic RPC below runs as the service
    // role, so the gate lives here. requireWrite only excludes viewers.
    const keyMembership = memberships.find((company) => company.company_id === keyCompanyId)
    if (!keyMembership || (keyMembership.role !== 'owner' && keyMembership.role !== 'admin')) {
      return errorResponseFromCode('FORBIDDEN', log, {
        requestId,
        details: { field: 'company_id', reason: 'admin_required', company_id: keyCompanyId },
      })
    }

    // Both live and test keys bind to the active company. A test key is
    // simulation-only (the v1 wrapper forces dry-run on every write) so it can
    // safely point at the real company without ever persisting anything.

    // Segregation of duties: warn + require explicit acknowledgement (not block)
    // when a single key both stages bookkeeping AND can approve it. Surfacing a
    // 409 lets the UI raise an explicit confirm dialog and the agent inform the
    // user before re-POSTing with acknowledge_sod: true.
    const conflictingScope = findStageApproveConflict(scopes)
    if (conflictingScope && !acknowledgeSod) {
      return errorResponseFromCode('API_KEY_SOD_CONFLICT', log, {
        requestId,
        details: {
          conflicting_scope: conflictingScope,
          approve_scope: 'pending_operations:approve',
        },
      })
    }
    const sodAcknowledgedAt = conflictingScope ? new Date().toISOString() : null

    const { count } = await supabase
      .from('api_keys')
      .select('id', { count: 'exact', head: true })
      .eq('company_id', companyId)
      .is('revoked_at', null)

    if (count !== null && count >= 10) {
      return errorResponseFromCode('API_KEY_QUOTA_EXCEEDED', log, {
        requestId,
        details: { activeCount: count, limit: 10 },
      })
    }

    const { key, hash, prefix } = generateApiKey(mode)

    // The key row and its allowlist rows (strict subset only) are written by
    // one SECURITY DEFINER RPC in one transaction (migration 20260923160200).
    // A key with no rows reaches every company, so a key insert that lands
    // without its allowlist would reach more than the caller selected, and a
    // compensating revoke is a second request that can itself fail. The RPC
    // re-checks membership and the default company as the backstop to the
    // 403 above; the service client is the only role allowed to execute it.
    const serviceClient = createServiceClient()
    const { data: createdKeyId, error: createError } = await serviceClient.rpc(
      'create_api_key_with_allowlist',
      {
        p_user_id: user.id,
        p_company_id: keyCompanyId,
        p_key_hash: hash,
        p_key_prefix: prefix,
        p_name: name,
        p_scopes: scopes,
        p_mode: mode,
        p_client: null,
        p_refresh_token_hash: null,
        p_sod_acknowledged_at: sodAcknowledgedAt,
        p_sod_acknowledged_by: sodAcknowledgedAt ? user.id : null,
        p_unattended_commit_limit: null,
        p_company_ids: allowlist,
      },
    )

    if (createError || typeof createdKeyId !== 'string') {
      log.error('api_key create failed', createError ?? { message: 'create_api_key_with_allowlist returned no id' })
      return errorResponseFromCode('API_KEY_CREATE_FAILED', log, {
        requestId,
        details: { reason: createError ? getUserErrorMessage(createError) : 'no id' },
      })
    }

    // Read the stored row back for the response (created_at is set by the
    // database). The key exists at this point, so a failed read is logged
    // and the response falls back to what the route already knows.
    const { data: storedKey, error: readError } = await serviceClient
      .from('api_keys')
      .select('id, key_prefix, name, scopes, mode, created_at')
      .eq('id', createdKeyId)
      .eq('user_id', user.id)
      .maybeSingle()
    if (readError || !storedKey) {
      log.error('api_key read-back after create failed', readError ?? { message: 'no row' })
    }
    const data = storedKey ?? { id: createdKeyId, key_prefix: prefix, name, scopes, mode, created_at: null }

    if (sodAcknowledgedAt) {
      // High-risk security event: the creator self-attested the stage+approve
      // combination. The durable record is the sod_acknowledged_* pair on the
      // key row; this structured entry additionally lands the acceptance in
      // the logging pipeline (ASVS V16.1.1 / SOC 2 CC6.1).
      log.warn('api_key.sod_acknowledged', {
        keyId: data.id,
        keyPrefix: data.key_prefix,
        conflictingScope,
        scopes,
        acknowledgedBy: user.id,
        companyId: keyCompanyId,
      })
    }

    return NextResponse.json({
      data: {
        ...data,
        company_ids: allowlist,
        key, // only time the full key is returned
      },
    })
  },
  { requireWrite: true },
)
