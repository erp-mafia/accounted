import { NextResponse } from 'next/server'
import { z } from 'zod'
import { withRouteContext } from '@/lib/api/with-route-context'
import { AccountKeySchema } from '@/lib/reconciliation/schemas'
import { unmatchLink } from '@/lib/reconciliation/actions'
import { SkattekontoLinkError } from '@/lib/skatteverket/skattekonto-link'
import { getErrorMessage } from '@/lib/errors/get-error-message'

/**
 * DELETE /api/reconciliation/accounts/{accountKey}/links/{linkId}
 *
 * The page's "Koppla bort": clears the link on one outside row (linkId = the
 * row id). The verifikat is untouched.
 */
export const DELETE = withRouteContext<{ params: Promise<{ accountKey: string; linkId: string }> }>(
  'reconciliation.accounts.links.delete',
  async (_request, { supabase, user, companyId }, { params }) => {
    const { accountKey, linkId } = await params
    if (!AccountKeySchema.safeParse(accountKey).success || !z.string().uuid().safeParse(linkId).success) {
      return NextResponse.json({ error: 'Okänd koppling' }, { status: 404 })
    }
    try {
      const result = await unmatchLink(supabase, companyId, user.id, accountKey, linkId)
      if (!result) {
        return NextResponse.json({ error: 'Okänt konto för det här företaget' }, { status: 404 })
      }
      return NextResponse.json({ data: result })
    } catch (err) {
      if (err instanceof SkattekontoLinkError) {
        const status = err.code === 'TRANSACTION_NOT_FOUND' ? 404 : 400
        return NextResponse.json({ error: getErrorMessage(err), code: err.code }, { status })
      }
      throw err
    }
  },
  { requireWrite: true },
)
