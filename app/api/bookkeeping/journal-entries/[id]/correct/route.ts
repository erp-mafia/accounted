import { NextResponse } from 'next/server'
import { correctEntry } from '@/lib/core/bookkeeping/storno-service'
import { ensureInitialized } from '@/lib/init'
import { validateBody } from '@/lib/api/validate'
import { CorrectJournalEntrySchema } from '@/lib/api/schemas'
import { withRouteContext } from '@/lib/api/with-route-context'

ensureInitialized()

export const POST = withRouteContext<{ params: Promise<{ id: string }> }>(
  'bookkeeping.journal-entry.correct',
  async (request, { supabase, companyId, user }, { params }) => {
    const { id } = await params
    const validation = await validateBody(request, CorrectJournalEntrySchema)
    if (!validation.success) return validation.response
    const result = await correctEntry(supabase, companyId, user.id, id, validation.data.lines)
    return NextResponse.json({ data: result })
  },
  { requireWrite: true },
)
