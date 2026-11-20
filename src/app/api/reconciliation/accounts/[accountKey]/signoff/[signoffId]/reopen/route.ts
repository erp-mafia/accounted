import { NextResponse } from 'next/server'
import { z } from 'zod'
import { withRouteContext } from '@/lib/api/with-route-context'
import { AccountKeySchema } from '@/lib/reconciliation/schemas'
import { ReconciliationSignoffError, reopenSignoff } from '@/lib/reconciliation/signoff'
import { getErrorMessage } from '@/lib/errors/get-error-message'

const ReopenBodySchema = z.object({ reason: z.string().max(2000).nullable().optional() })

/**
 * POST /api/reconciliation/accounts/{accountKey}/signoff/{signoffId}/reopen
 *
 * The undo of a sign-off: stamps it reopened (the row stays as history).
 * Body { reason? }; an empty body is fine.
 */
export const POST = withRouteContext<{ params: Promise<{ accountKey: string; signoffId: string }> }>(
  'reconciliation.accounts.signoff.reopen',
  async (request, { supabase, user, companyId }, { params }) => {
    const { accountKey, signoffId } = await params
    if (!AccountKeySchema.safeParse(accountKey).success || !z.string().uuid().safeParse(signoffId).success) {
      return NextResponse.json({ error: 'Okänd signering' }, { status: 404 })
    }
    let body: unknown = {}
    try {
      const text = await request.text()
      body = text ? JSON.parse(text) : {}
    } catch {
      return NextResponse.json({ error: 'Ogiltig JSON' }, { status: 400 })
    }
    const parsed = ReopenBodySchema.safeParse(body)
    if (!parsed.success) {
      return NextResponse.json({ error: 'Ogiltig body' }, { status: 400 })
    }
    try {
      const result = await reopenSignoff(supabase, companyId, user.id, accountKey, signoffId, {
        reason: parsed.data.reason ?? null,
      })
      if (!result) {
        return NextResponse.json({ error: 'Okänt konto för det här företaget' }, { status: 404 })
      }
      return NextResponse.json({ data: { signoff: result } })
    } catch (err) {
      if (err instanceof ReconciliationSignoffError) {
        const status = err.code === 'SIGNOFF_NOT_FOUND' ? 404 : err.code === 'SIGNOFF_RACE' ? 409 : 400
        return NextResponse.json({ error: getErrorMessage(err), code: err.code }, { status })
      }
      throw err
    }
  },
  { requireWrite: true },
)
