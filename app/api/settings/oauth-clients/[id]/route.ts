import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { appendProcessingHistory } from '@/lib/processing-history/append'

/**
 * DELETE /api/settings/oauth-clients/[id]: revoke a redirect URI
 * registration. Soft-delete via revoked_at so the audit trail survives
 * and the same URI can be re-registered later.
 *
 * Emits an audit event so revocations are visible in processing_history:
 * revoking an OAuth client is a security-relevant access-control change
 * (SOC 2 CC7.2). Returns 404 when the row is unknown or already revoked
 * so callers can surface failures rather than treating "no-op" as success.
 */
export const DELETE = withRouteContext<{ params: Promise<{ id: string }> }>(
  'oauth_client.delete',
  async (_request, { supabase, user, companyId, log }, { params }) => {
    const { id } = await params

    const { data: rows, error } = await supabase
      .from('oauth_client_registrations')
      .update({ revoked_at: new Date().toISOString() })
      .eq('id', id)
      .eq('user_id', user.id)
      .is('revoked_at', null)
      .select('id, redirect_uri, client_name')

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 })
    }

    if (!rows || rows.length === 0) {
      return NextResponse.json(
        { error: 'OAuth-klient hittades inte eller är redan återkallad.' },
        { status: 404 }
      )
    }

    // Audit the revocation. Failure to append must not break the user flow:
    // the revocation has already happened in the DB. We log the appendError
    // so a systematic outage is visible in operations rather than silently
    // degraded.
    try {
      await appendProcessingHistory({
        companyId,
        correlationId: id,
        aggregateType: 'System',
        aggregateId: id,
        eventType: 'OAuthClientRevoked',
        payload: {
          client_id: id,
          // Note: redirect_uri may contain a host the user identifies with their
          // own infrastructure but is not PII per Art. 4(1). Stored to satisfy
          // SOC 2 CC7.2 "what was revoked" evidence trail.
          redirect_uri: rows[0].redirect_uri,
        },
        actor: { type: 'user', id: user.id },
        occurredAt: new Date(),
      })
    } catch (auditErr) {
      log.warn('Failed to append OAuthClientRevoked audit event', auditErr)
    }

    return NextResponse.json({ success: true })
  },
  { requireWrite: true },
)
