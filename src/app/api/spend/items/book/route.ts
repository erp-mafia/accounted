import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateBody } from '@/lib/api/validate'
import { sessionFailureResponse } from '@/lib/operations/session'
import { bookSpendItems } from '@/lib/spend/book-item'
import { SpendBookManyBodySchema } from '@/lib/spend/schemas'

// Up to fifty verifikat, each with its receipts linked.
export const maxDuration = 300

/**
 * Book several ready expenses, each as its own verifikat. Expenses that
 * need a person's look are reported back, never booked here. Rules in
 * lib/spend/book-item.ts, shared with the operation spend.items-book.
 */
export const POST = withRouteContext(
  'spend.items.book',
  async (request, ctx) => {
    const { supabase, companyId, user, log, requestId } = ctx
    const body = await validateBody(request, SpendBookManyBodySchema, { log, operation: 'spend.items.book' })
    if (!body.success) return body.response
    const outcome = await bookSpendItems({ supabase, companyId: companyId!, userId: user.id, log }, body.data)
    if (!outcome.ok) return sessionFailureResponse(outcome, log, requestId)
    if (outcome.dryRun) throw new Error('unreachable: no dry run on the dashboard')
    return NextResponse.json({ data: outcome.data })
  },
  { requireWrite: true },
)
