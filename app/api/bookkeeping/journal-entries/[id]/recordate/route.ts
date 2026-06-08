import { NextResponse } from 'next/server'
import { recordateEntry } from '@/lib/core/bookkeeping/storno-service'
import { ensureInitialized } from '@/lib/init'
import { validateBody } from '@/lib/api/validate'
import { RecordateJournalEntrySchema } from '@/lib/api/schemas'
import { withRouteContext } from '@/lib/api/with-route-context'

ensureInitialized()

export const POST = withRouteContext<{ params: Promise<{ id: string }> }>(
  'bookkeeping.journal-entry.recordate',
  async (request, { supabase, companyId, user }, { params }) => {
    const { id } = await params
    const validation = await validateBody(request, RecordateJournalEntrySchema)
    if (!validation.success) return validation.response
    const result = await recordateEntry(supabase, companyId, user.id, id, validation.data.new_entry_date)
    return NextResponse.json({ data: result })
  },
  { requireWrite: true },
)
