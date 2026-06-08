import { NextResponse } from 'next/server'
import { reverseEntry } from '@/lib/bookkeeping/engine'
import { ensureInitialized } from '@/lib/init'
import { withRouteContext } from '@/lib/api/with-route-context'

ensureInitialized()

export const POST = withRouteContext<{ params: Promise<{ id: string }> }>(
  'bookkeeping.journal-entry.reverse',
  async (_request, { supabase, companyId, user }, { params }) => {
    const { id } = await params
    const reversalEntry = await reverseEntry(supabase, companyId, user.id, id)
    return NextResponse.json({ data: reversalEntry })
  },
  { requireWrite: true },
)
