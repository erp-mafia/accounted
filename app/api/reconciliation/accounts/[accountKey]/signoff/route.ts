import { NextResponse } from 'next/server'
import { z } from 'zod'
import { withRouteContext } from '@/lib/api/with-route-context'
import { AccountKeySchema } from '@/lib/reconciliation/schemas'
import { listSignoffs } from '@/lib/reconciliation/signoff-store'
import { ReconciliationSignoffError, signOffAccount } from '@/lib/reconciliation/signoff'
import { getErrorMessage } from '@/lib/errors/get-error-message'
import { ISO_DATE_RE } from '@/lib/invariants'

const SignoffBodySchema = z.object({
  through_date: z.string().regex(ISO_DATE_RE),
  note: z.string().max(2000).nullable().optional(),
  force: z.boolean().optional(),
  dry_run: z.boolean().optional(),
})

/**
 * GET /api/reconciliation/accounts/{accountKey}/signoff
 *
 * Sign-off history for one account, newest first (?include_reopened=1 to
 * see reopened ones too, ?limit).
 */
export const GET = withRouteContext<{ params: Promise<{ accountKey: string }> }>(
  'reconciliation.accounts.signoff.list',
  async (request, { supabase, companyId }, { params }) => {
    const { accountKey } = await params
    if (!AccountKeySchema.safeParse(accountKey).success) {
      return NextResponse.json({ error: 'Okänt konto' }, { status: 404 })
    }
    const { searchParams } = new URL(request.url)
    const limit = Math.min(Number(searchParams.get('limit') ?? 50) || 50, 200)
    const includeReopened = searchParams.get('include_reopened') === '1'
    const signoffs = await listSignoffs(supabase, companyId, accountKey, { limit, includeReopened })
    return NextResponse.json({ data: { signoffs } })
  },
)

/**
 * POST /api/reconciliation/accounts/{accountKey}/signoff
 *
 * "Markera som avstämd t.o.m. <datum>". Body { through_date, note?, force?,
 * dry_run? }. Refused (400 + code) unless the account is reconciled through
 * the date, or force + note is given.
 */
export const POST = withRouteContext<{ params: Promise<{ accountKey: string }> }>(
  'reconciliation.accounts.signoff.create',
  async (request, { supabase, user, companyId }, { params }) => {
    const { accountKey } = await params
    if (!AccountKeySchema.safeParse(accountKey).success) {
      return NextResponse.json({ error: 'Okänt konto' }, { status: 404 })
    }
    let body: unknown
    try {
      body = await request.json()
    } catch {
      return NextResponse.json({ error: 'Ogiltig JSON' }, { status: 400 })
    }
    const parsed = SignoffBodySchema.safeParse(body)
    if (!parsed.success) {
      return NextResponse.json({ error: 'Ogiltig body: through_date (ÅÅÅÅ-MM-DD) krävs' }, { status: 400 })
    }
    try {
      const result = await signOffAccount(
        supabase,
        companyId,
        user.id,
        accountKey,
        { through_date: parsed.data.through_date, note: parsed.data.note ?? null, force: parsed.data.force },
        { dryRun: parsed.data.dry_run === true },
      )
      if (!result) {
        return NextResponse.json({ error: 'Okänt konto för det här företaget' }, { status: 404 })
      }
      return NextResponse.json({ data: result })
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
