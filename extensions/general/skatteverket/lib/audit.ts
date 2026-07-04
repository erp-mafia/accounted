import type { ExtensionContext } from '@/lib/extensions/types'

/**
 * Append an immutable row to skatteverket_api_audit_log. Errors are
 * swallowed (logged only) so an audit-table outage does not break the
 * regulator flow, but a successful primary call without an audit row
 * shows up as a noisy console.error for ops to investigate.
 *
 * Lives in its own module so the route handlers (which pass a real
 * ExtensionContext), the commit-side services, and the MCP read tools can all
 * share one audit writer. Callers that only hold (supabase, userId, companyId)
 * build a context with `createExtensionContext(supabase, userId, companyId,
 * 'skatteverket')`: cheap, no I/O, and pass it here. The `(ctx, fields)`
 * signature is preserved verbatim so the existing handlers stay byte-identical.
 */
export async function writeSkatteverketAudit(
  ctx: ExtensionContext,
  fields: {
    endpoint: string
    agRegistreradId?: string | null
    redovisningsperiod?: string | null
    outcome: 'ok' | 'validation_error' | 'skv_error' | 'auth_error' | 'internal_error'
    responseStatus?: number | null
    skvStatus?: string | null
    requestSizeBytes?: number | null
    correlationId?: string | null
    errorMessage?: string | null
  },
): Promise<void> {
  try {
    const { error } = await ctx.supabase
      .from('skatteverket_api_audit_log')
      .insert({
        company_id: ctx.companyId,
        user_id: ctx.userId,
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
      ctx.log.error('skatteverket_api_audit_log insert failed', {
        endpoint: fields.endpoint,
        outcome: fields.outcome,
        error: error.message,
      })
    }
  } catch (err) {
    ctx.log.error('skatteverket_api_audit_log insert threw', {
      endpoint: fields.endpoint,
      error: err instanceof Error ? err.message : String(err),
    })
  }
}
