import { createClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'
import { requireWritePermission } from '@/lib/auth/require-write'
import { requireCompanyId } from '@/lib/company/context'
import { appendProcessingHistory } from '@/lib/processing-history/append'
import { createLogger } from '@/lib/logger'

const log = createLogger('oauth-clients:delete')

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
export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const supabase = await createClient()
  const { id } = await params
  const { data: { user } } = await supabase.auth.getUser()

  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const writeCheck = await requireWritePermission(supabase, user.id)
  if (!writeCheck.ok) return writeCheck.response

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
    const companyId = await requireCompanyId(supabase, user.id)
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
}
