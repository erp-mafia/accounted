import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { postingPort } from '@/lib/posting/port'

export const POST = withRouteContext<{ params: Promise<{ id: string }> }>(
  'bookkeeping.journal-entry.commit',
  async (_request, { supabase, companyId, user }, { params }) => {
    const { id } = await params
    // Posting port (step 2i): a draft made through the port carries its
    // event link already, so the commit records nothing in any mode.
    const posted = await postingPort.commitJournalEntry({ supabase, companyId, userId: user.id, entryId: id, commitMethod: 'user_accept' })
    return NextResponse.json({ data: posted })
  },
  { requireWrite: true },
)
