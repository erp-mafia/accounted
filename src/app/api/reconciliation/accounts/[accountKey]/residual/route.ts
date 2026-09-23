import { NextResponse } from 'next/server'
import { z } from 'zod'
import { withRouteContext } from '@/lib/api/with-route-context'
import { AccountKeySchema } from '@/lib/reconciliation/schemas'
import { bookResidualAndLink, ReconciliationResidualError } from '@/lib/reconciliation/residual'
import { getErrorMessage } from '@/lib/errors/get-error-message'
import { ISO_DATE_RE } from '@/lib/invariants'
import { ensureInitialized } from '@/lib/init'

// Booking a residual commits a verifikat; the engine emits journal_entry
// events that extension handlers subscribe to.
ensureInitialized()

const ResidualBodySchema = z.object({
  external_ids: z.array(z.string().uuid()).min(1).max(50),
  journal_entry_id: z.string().uuid(),
  kind: z.enum(['bank_fee', 'rounding', 'interest_income', 'interest_expense']),
  entry_date: z.string().regex(ISO_DATE_RE).optional(),
  description: z.string().max(200).optional(),
  dry_run: z.boolean().optional(),
})

/**
 * POST /api/reconciliation/accounts/{accountKey}/residual
 *
 * The worksheet's "bokför mellanskillnaden och koppla": books the remainder
 * of a selection (bank rows vs one verifikat) as a bank fee / interest /
 * rounding verifikat and links the selection. Bank accounts only.
 */
export const POST = withRouteContext<{ params: Promise<{ accountKey: string }> }>(
  'reconciliation.accounts.residual',
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
    const parsed = ResidualBodySchema.safeParse(body)
    if (!parsed.success) {
      return NextResponse.json({ error: 'Ogiltig body: external_ids, journal_entry_id och kind krävs' }, { status: 400 })
    }
    try {
      const result = await bookResidualAndLink(
        supabase,
        companyId,
        user.id,
        accountKey,
        {
          external_ids: parsed.data.external_ids,
          journal_entry_id: parsed.data.journal_entry_id,
          kind: parsed.data.kind,
          entry_date: parsed.data.entry_date,
          description: parsed.data.description,
        },
        { dryRun: parsed.data.dry_run === true },
      )
      if (!result) {
        return NextResponse.json({ error: 'Okänt konto för det här företaget' }, { status: 404 })
      }
      return NextResponse.json({ data: result })
    } catch (err) {
      if (err instanceof ReconciliationResidualError) {
        const status =
          err.code === 'RESIDUAL_ROWS_NOT_FOUND' || err.code === 'RESIDUAL_ENTRY_NOT_FOUND' ? 404 : 400
        return NextResponse.json({ error: getErrorMessage(err), code: err.code }, { status })
      }
      throw err
    }
  },
  { requireWrite: true },
)
