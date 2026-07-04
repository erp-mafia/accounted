import { NextResponse } from 'next/server'
import {
  generateApiKey,
  DEFAULT_SCOPES,
  validateScopes,
  findStageApproveConflict,
} from '@/lib/auth/api-keys'
import { withRouteContext } from '@/lib/api/with-route-context'
import { errorResponse, errorResponseFromCode } from '@/lib/errors/get-structured-error'
import type { ApiKeyMode, ApiKeyScope } from '@/lib/auth/api-keys'

/** GET /api/settings/api-keys: list the company's API keys (key value never returned). */
export const GET = withRouteContext(
  'api_key.list',
  async (_request, ctx) => {
    const { supabase, companyId, log, requestId } = ctx

    // Both live and test keys for the active company. (Test keys are bound to the
    // active company too: they're simulation-only, so they never write real data.)
    const { data, error } = await supabase
      .from('api_keys')
      .select('id, key_prefix, name, scopes, mode, rate_limit_rpm, last_used_at, revoked_at, created_at')
      .eq('company_id', companyId)
      .order('created_at', { ascending: false })

    if (error) {
      log.error('api_keys list failed', error)
      return errorResponse(error, log, { requestId })
    }

    return NextResponse.json({ data })
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
    } catch {
      // Empty body: use defaults.
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

    const { data, error } = await supabase
      .from('api_keys')
      .insert({
        user_id: user.id,
        company_id: companyId,
        key_hash: hash,
        key_prefix: prefix,
        name,
        scopes,
        mode,
        ...(sodAcknowledgedAt
          ? { sod_acknowledged_at: sodAcknowledgedAt, sod_acknowledged_by: user.id }
          : {}),
      })
      .select('id, key_prefix, name, scopes, mode, created_at')
      .single()

    if (error) {
      log.error('api_key insert failed', error)
      return errorResponseFromCode('API_KEY_CREATE_FAILED', log, {
        requestId,
        details: { reason: error.message },
      })
    }

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
        companyId,
      })
    }

    return NextResponse.json({
      data: {
        ...data,
        key, // only time the full key is returned
      },
    })
  },
  { requireWrite: true },
)
