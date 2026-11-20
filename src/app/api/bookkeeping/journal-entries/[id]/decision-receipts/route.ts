import { NextResponse } from 'next/server'
import { z } from 'zod'
import { withRouteContext } from '@/lib/api/with-route-context'
import { PRIVATE_NO_STORE_HEADERS } from '@/lib/api/private-no-store'
import { errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { createServiceClient } from '@/lib/supabase/server'
import { getBookingWhyData } from '@/lib/suggestion-log/receipt-display-data'

/**
 * GET /api/bookkeeping/journal-entries/[id]/decision-receipts
 *
 * What "Därför bokades den så" renders for one verifikat: the entry's commit
 * actor (committed_actor_*, commit_method, the entry's user), its decisions
 * (the newest receipt from lib/suggestion-log/receipts.ts in full, up to 10
 * others as when, who and source, and the total; null when they could not
 * be read) and the people the view names, resolved through the
 * service client because `profiles` RLS is self-only. The verifikat page and
 * the Inkorg read it; lib/suggestion-log/receipt-display.ts turns it into
 * the summary line and rows. Read-only: nothing is written to the entry.
 *
 * Private, no-store: the payload carries names and accounts.
 */
export const GET = withRouteContext<{ params: Promise<{ id: string }> }>(
  'bookkeeping.journal_entry.decision_receipts',
  async (_request, { supabase, companyId, log, requestId }, { params }) => {
    const { id } = await params
    if (!z.string().uuid().safeParse(id).success) {
      return errorResponseFromCode('VALIDATION_ERROR', log, {
        requestId,
        details: { field: 'id', message: 'Journal entry id must be a UUID.' },
      })
    }

    const data = await getBookingWhyData(supabase, companyId, id, {
      profilesClient: () => createServiceClient(),
      log,
    })
    if (!data) return errorResponseFromCode('JOURNAL_ENTRY_NOT_FOUND', log, { requestId })
    return NextResponse.json({ data }, { headers: PRIVATE_NO_STORE_HEADERS })
  },
)
