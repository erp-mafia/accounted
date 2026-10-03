import { createServiceClient } from '@/lib/supabase/server'
import { createLogger } from '@/lib/logger'
import type { SkvAuth } from './api-client'

const log = createLogger('skatteverket-audit')

/** Who an outbound call is recorded against. */
export interface SkvAuditActor {
  companyId: string
  /** The user who caused the call; null for a call the system made with no user. */
  userId: string | null
}

/**
 * Who an audit row names when no person asked for the call (crons,
 * background refreshes): the user whose personal token made it, or null for
 * a call on Accounted's own system credentials. Never a stand-in such as the
 * company's creator. A person who asked passes their own id instead.
 */
export function auditUserIdFor(auth: SkvAuth): string | null {
  return auth.mode === 'user' ? auth.userId : null
}

export type SkvAuditOutcome = 'ok' | 'validation_error' | 'skv_error' | 'auth_error' | 'internal_error'

/**
 * Append an immutable row to skatteverket_api_audit_log. Errors are
 * swallowed (logged only) so an audit-table outage does not break the
 * regulator flow, but a successful primary call without an audit row
 * shows up as an error log line for ops to investigate.
 *
 * The transport (api-client.ts, skvRequestWithAuth) calls this for every
 * outbound call, exactly once, so no route can forget to audit and none can
 * audit twice. The only other caller is the AGI kontrollera routes, for the
 * 'validation_error' rows they write when they refuse a payload themselves,
 * before any call is made: an outcome the transport never sees.
 */
export async function writeSkatteverketAudit(
  actor: SkvAuditActor,
  fields: {
    endpoint: string
    agRegistreradId?: string | null
    redovisningsperiod?: string | null
    outcome: SkvAuditOutcome
    responseStatus?: number | null
    skvStatus?: string | null
    requestSizeBytes?: number | null
    correlationId?: string | null
    errorMessage?: string | null
  },
): Promise<void> {
  try {
    // This table intentionally has no authenticated INSERT policy. Use the
    // server-only service client so callers cannot fabricate regulator audit
    // rows through their user session.
    const auditClient = createServiceClient()
    const { error } = await auditClient
      .from('skatteverket_api_audit_log')
      .insert({
        company_id: actor.companyId,
        user_id: actor.userId,
        endpoint: fields.endpoint,
        ag_registered_id: fields.agRegistreradId ?? null,
        redovisningsperiod: fields.redovisningsperiod ?? null,
        outcome: fields.outcome,
        response_status: fields.responseStatus ?? null,
        skv_status: fields.skvStatus ?? null,
        request_size_bytes: fields.requestSizeBytes ?? null,
        correlation_id: fields.correlationId ?? null,
        error_message: fields.errorMessage ?? null,
      })
    if (error) {
      log.error('skatteverket_api_audit_log insert failed', {
        companyId: actor.companyId,
        endpoint: fields.endpoint,
        outcome: fields.outcome,
        correlationId: fields.correlationId ?? null,
        error: error.message,
      })
    }
  } catch (err) {
    log.error('skatteverket_api_audit_log insert threw', {
      companyId: actor.companyId,
      endpoint: fields.endpoint,
      correlationId: fields.correlationId ?? null,
      error: err instanceof Error ? err.message : String(err),
    })
  }
}
