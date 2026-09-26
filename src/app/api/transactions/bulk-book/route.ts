import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateBody } from '@/lib/api/validate'
import { BulkBookSchema } from '@/lib/api/schemas'
import { ensureInitialized } from '@/lib/init'
import { sessionFailureResponse } from '@/lib/operations/session'
import { bulkBookTransactions } from '@/lib/transactions/bulk-book'

ensureInitialized()

/**
 * POST /api/transactions/bulk-book
 *
 * Bulk-book N bank transactions on the same date into one combined
 * verifikat (samlingsverifikation per BFL 5 kap 6§): link them to an
 * existing voucher, expand a booking template, or pass manual lines. The
 * rules (currency, duplicate guard, chart allowlist, template visibility,
 * dimension rules, the RPC, underlag propagation and events) live in
 * lib/transactions/bulk-book.ts, shared with
 * POST /api/v1/companies/{companyId}/transactions/bulk-book.
 */
export const POST = withRouteContext(
  'transaction.bulk_book',
  async (request, ctx) => {
    const { user, supabase, companyId, log, requestId } = ctx

    const validation = await validateBody(request, BulkBookSchema, {
      log,
      operation: 'transaction.bulk_book',
    })
    if (!validation.success) return validation.response

    const outcome = await bulkBookTransactions(
      { supabase, companyId: companyId!, userId: user.id, log },
      validation.data,
      { via: 'bulk_book_force' },
    )
    if (!outcome.ok) return sessionFailureResponse(outcome, log, requestId)
    if (outcome.dryRun) return NextResponse.json({ data: outcome.preview })

    return NextResponse.json({ data: outcome.data })
  },
  { requireWrite: true },
)
