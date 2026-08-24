import { NextResponse } from 'next/server'
import { z } from 'zod'
import { withRouteContext } from '@/lib/api/with-route-context'
import { AccountKeySchema } from '@/lib/reconciliation/schemas'
import { setItemIgnored } from '@/lib/reconciliation/actions'
import { SkattekontoLinkError } from '@/lib/skatteverket/skattekonto-link'
import { getErrorMessage } from '@/lib/errors/get-error-message'

const IgnoreBodySchema = z.object({ ignored: z.boolean().optional() })

/**
 * POST /api/reconciliation/accounts/{accountKey}/items/{itemId}/ignore
 *
 * The page's "Ignorera" / "Återställ" on one outside row. Body
 * { ignored: boolean } (default true).
 */
export const POST = withRouteContext<{ params: Promise<{ accountKey: string; itemId: string }> }>(
  'reconciliation.accounts.items.ignore',
  async (request, { supabase, companyId }, { params }) => {
    const { accountKey, itemId } = await params
    if (!AccountKeySchema.safeParse(accountKey).success || !z.string().uuid().safeParse(itemId).success) {
      return NextResponse.json({ error: 'Okänd rad' }, { status: 404 })
    }
    // Empty body = ignore; `{ ignored: false }` restores.
    let body: unknown = {}
    try {
      const text = await request.text()
      body = text ? JSON.parse(text) : {}
    } catch {
      return NextResponse.json({ error: 'Ogiltig JSON' }, { status: 400 })
    }
    const parsed = IgnoreBodySchema.safeParse(body)
    if (!parsed.success) {
      return NextResponse.json({ error: 'Ogiltig body' }, { status: 400 })
    }
    const ignored = parsed.data.ignored ?? true
    try {
      const result = await setItemIgnored(supabase, companyId, accountKey, itemId, ignored)
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
