import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { errorResponse } from '@/lib/errors/get-structured-error'
import { readAvailableInboxDocs } from '@/lib/documents/inbox-available'

/**
 * GET /api/documents/inbox-available: list invoice-inbox documents that are
 * available to attach as underlag to a verifikat.
 *
 * Returns only *unconsumed* inbox items: those that have a file but have not
 * yet become a supplier invoice, a direct journal entry, or been matched to a
 * bank transaction, and whose underlying document is not already linked to a
 * verifikation. This mirrors the inbox's own "Att göra" set, narrowed to items
 * with an attachable file. The read is lib/documents/inbox-available.ts, which
 * the booking screen shares for the receipt found for a bank row.
 *
 * `invoice_inbox_items` is a core table, so a core route may read it directly
 * without importing from @/extensions. When the invoice-inbox extension is not
 * in use the table is simply empty and this returns [].
 */
export const GET = withRouteContext('document.inbox_available', async (_request, ctx) => {
  const { supabase, companyId, log, requestId } = ctx

  const read = await readAvailableInboxDocs(supabase, companyId)
  if (read.error !== null) {
    log.error(read.stage === 'items' ? 'inbox-available item query failed' : 'inbox-available document query failed', read.error)
    return errorResponse(read.error, log, { requestId })
  }
  return NextResponse.json({ data: read.data })
})
