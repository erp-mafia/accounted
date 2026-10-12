import { NextResponse } from 'next/server'
import { z } from 'zod'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateQuery } from '@/lib/api/validate'
import { getCollectionsProvider } from '@/lib/collections/catalogue'
import { listCollectionCandidates } from '@/lib/collections/candidates'
import { loadLiveConnection } from '@/lib/collections/connection'
import { readCollectionsEnv } from '@/lib/collections/flags'
import { collectionsRouteGate } from '@/lib/collections/settings-routes'
import { errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { ensureInitialized } from '@/lib/init'
import { createServiceClient } from '@/lib/supabase/server'

// The case modules this route reads through can emit collection events: wire the bus.
ensureInitialized()

const QuerySchema = z.object({
  /** "1" lists the invoices that cannot go too, with the checks they fail. */
  all: z.enum(['0', '1']).optional(),
})

/**
 * GET /api/collections/candidates: overdue invoices that could be handed
 * over to the collections provider, with the checks each one passes. A start
 * path (it exists to begin new work), so it answers only when the company
 * can hand invoices over. The bank check and the consumer's age are checked
 * at handover, not here.
 */
export const GET = withRouteContext('collections.candidates.list', async (request, ctx) => {
  const query = validateQuery(request, QuerySchema, { log: ctx.log, operation: 'collections.candidates.list' })
  if (!query.success) return query.response
  const env = readCollectionsEnv()
  const refused = await collectionsRouteGate(ctx, 'handover', env)
  if (refused) return refused
  const db = createServiceClient()
  const connection = await loadLiveConnection(db, ctx.companyId)
  if (!connection) return errorResponseFromCode('COLLECTIONS_NOT_ACTIVE', ctx.log, { requestId: ctx.requestId })
  const provider = await getCollectionsProvider(connection.route)
  const candidates = await listCollectionCandidates(db, {
    companyId: ctx.companyId,
    connection,
    features: provider?.features ?? null,
    includeIneligible: query.data.all === '1',
  })
  return NextResponse.json({ data: { candidates } }, { headers: { 'Cache-Control': 'no-store' } })
})
