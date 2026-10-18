import { NextResponse } from 'next/server'
import { correctionBusinessEvents } from '@/lib/bookkeeping/ledger-business-events'
import { todayIsoStockholm } from '@/lib/dates/iso'
import { linkBasisColumns } from '@/lib/links/stamp'
import { postingPort } from '@/lib/posting/port'
import { validateBody } from '@/lib/api/validate'
import { CorrectJournalEntrySchema } from '@/lib/api/schemas'
import { withRouteContext } from '@/lib/api/with-route-context'

export const POST = withRouteContext<{ params: Promise<{ id: string }> }>(
  'bookkeeping.journal-entry.correct',
  async (request, { supabase, companyId, user }, { params }) => {
    const { id } = await params
    const validation = await validateBody(request, CorrectJournalEntrySchema)
    if (!validation.success) return validation.response
    // Posting port (step 2i): while POSTING_EVENTS is on, ledger.storno and
    // ledger.correction of the verifikat, which the person asked for
    // (user_created), each linked to its own new verifikat.
    const result = await postingPort.correctJournalEntry({
      supabase,
      companyId,
      userId: user.id,
      entryId: id,
      ...correctionBusinessEvents({ entryId: id, occurredOn: todayIsoStockholm, linkBasis: () => linkBasisColumns('user_created') }),
      correction: {
        lines: validation.data.lines,
        options: {
          description: validation.data.description,
          allowDeepChain: validation.data.allow_deep_chain,
        },
      },
    })
    return NextResponse.json({ data: result })
  },
  { requireWrite: true },
)
