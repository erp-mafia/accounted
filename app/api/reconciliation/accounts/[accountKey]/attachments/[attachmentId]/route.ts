import { NextResponse } from 'next/server'
import { z } from 'zod'
import { withRouteContext } from '@/lib/api/with-route-context'
import { createServiceClient } from '@/lib/supabase/server'
import { contentDisposition } from '@/lib/api/content-disposition'
import { AccountKeySchema } from '@/lib/reconciliation/schemas'
import { getAttachmentRow } from '@/lib/reconciliation/attachments-store'
import { downloadUnderlag, ReconciliationAttachmentError, removeUnderlag } from '@/lib/reconciliation/attachments'
import { getErrorMessage } from '@/lib/errors/get-error-message'

const UUID = z.string().uuid()

/**
 * GET    /api/reconciliation/accounts/{accountKey}/attachments/{attachmentId}
 *        streams the file inline (same shape as /api/documents/{id}/inline:
 *        the caller's client authorizes the row, the service role reads the
 *        non-public bucket).
 * DELETE /api/reconciliation/accounts/{accountKey}/attachments/{attachmentId}
 *        stamps the attachment removed; body { reason? }. The file and the
 *        row stay (BFL 7 kap.).
 */
export const GET = withRouteContext<{ params: Promise<{ accountKey: string; attachmentId: string }> }>(
  'reconciliation.accounts.attachments.file',
  async (_request, { supabase, companyId, log }, { params }) => {
    const { accountKey, attachmentId } = await params
    if (!AccountKeySchema.safeParse(accountKey).success || !UUID.safeParse(attachmentId).success) {
      return NextResponse.json({ error: 'Okänt underlag' }, { status: 404 })
    }
    const row = await getAttachmentRow(supabase, companyId, accountKey, attachmentId)
    if (!row) {
      return NextResponse.json({ error: 'Okänt underlag' }, { status: 404 })
    }
    const { blob, error } = await downloadUnderlag(createServiceClient(), row)
    if (error || !blob) {
      log.error('underlag download failed', error, { companyId, accountKey, attachmentId })
      return NextResponse.json({ error: 'Kunde inte hämta underlaget. Försök igen om en stund.' }, { status: 500 })
    }
    return new NextResponse(blob, {
      status: 200,
      headers: {
        'Content-Type': row.mime_type,
        'Content-Disposition': contentDisposition('inline', row.file_name),
        'Cache-Control': 'private, no-store',
        'X-Content-Type-Options': 'nosniff',
      },
    })
  },
)

const RemoveBodySchema = z.object({ reason: z.string().max(500).nullable().optional() })

export const DELETE = withRouteContext<{ params: Promise<{ accountKey: string; attachmentId: string }> }>(
  'reconciliation.accounts.attachments.remove',
  async (request, { supabase, user, companyId }, { params }) => {
    const { accountKey, attachmentId } = await params
    if (!AccountKeySchema.safeParse(accountKey).success || !UUID.safeParse(attachmentId).success) {
      return NextResponse.json({ error: 'Okänt underlag' }, { status: 404 })
    }
    let reason: string | null = null
    const raw = await request.text()
    if (raw.trim()) {
      let parsed: unknown
      try {
        parsed = JSON.parse(raw)
      } catch {
        return NextResponse.json({ error: 'Ogiltig JSON' }, { status: 400 })
      }
      const body = RemoveBodySchema.safeParse(parsed)
      if (!body.success) return NextResponse.json({ error: 'Ogiltig body' }, { status: 400 })
      reason = body.data.reason ?? null
    }
    try {
      const attachment = await removeUnderlag(supabase, companyId, user.id, accountKey, attachmentId, { reason })
      if (!attachment) return NextResponse.json({ error: 'Okänt underlag' }, { status: 404 })
      return NextResponse.json({ data: { attachment } })
    } catch (err) {
      if (err instanceof ReconciliationAttachmentError) {
        return NextResponse.json({ error: getErrorMessage(err), code: err.code }, { status: err.code === 'ALREADY_REMOVED' ? 409 : 400 })
      }
      throw err
    }
  },
  { requireWrite: true },
)
