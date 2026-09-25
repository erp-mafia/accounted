import { NextResponse } from 'next/server'
import { z } from 'zod'
import { ensureInitialized } from '@/lib/init'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateBody } from '@/lib/api/validate'
import { bokforSkattekontoTransactionsBatch } from '@/lib/skatteverket/skattekonto-booking'

ensureInitialized()

const Schema = z.object({
  ids: z.array(z.string().uuid()).min(1).max(500),
})

/**
 * Book skattekonto rows into journal entries, from the core.
 *
 * The counterpart of the core read route beside this one, and core for the
 * same reason: the rows come from a file import that needs no Skatteverket
 * connection, and the booking itself reads only core things (the rule table,
 * the chart, the fiscal periods) and writes through the bookkeeping engine.
 * Nothing here touches Skatteverket's API. Leaving it in the extension meant
 * the page could show a company its own imported rows and then answer 503
 * when it pressed Bokför, which is the worse half of the bug the read route
 * fixed.
 */
export const POST = withRouteContext(
  'skattekonto.transactions.book_batch',
  async (request, { supabase, companyId, user }) => {
    const validation = await validateBody(request, Schema)
    if (!validation.success) return validation.response

    const result = await bokforSkattekontoTransactionsBatch(
      supabase,
      companyId,
      user.id,
      validation.data.ids,
    )
    return NextResponse.json({ data: result })
  },
  { requireWrite: true },
)
