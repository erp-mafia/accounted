import { NextResponse } from 'next/server'
import { commitEntry } from '@/lib/bookkeeping/engine'
import { ensureInitialized } from '@/lib/init'
import { withRouteContext } from '@/lib/api/with-route-context'

ensureInitialized()

export const POST = withRouteContext<{ params: Promise<{ id: string }> }>(
  'bookkeeping.journal-entry.commit',
  async (_request, { supabase, companyId, user }, { params }) => {
    const { id } = await params
    const posted = await commitEntry(supabase, companyId, user.id, id, 'user_accept')
    return NextResponse.json({ data: posted })
  },
  { requireWrite: true },
)
