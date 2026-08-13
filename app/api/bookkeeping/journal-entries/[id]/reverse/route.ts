import { NextResponse } from 'next/server'
import { reverseEntry } from '@/lib/bookkeeping/engine'
import { ensureInitialized } from '@/lib/init'
import { withRouteContext } from '@/lib/api/with-route-context'

ensureInitialized()

export const POST = withRouteContext<{ params: Promise<{ id: string }> }>(
  'bookkeeping.journal-entry.reverse',
  async (request, { supabase, companyId, user }, { params }) => {
    const { id } = await params
    // Body is optional (existing callers POST with none): the only accepted
    // field is the chain-depth guard override from the "Återför ändå" confirm.
    const body = (await request.json().catch(() => null)) as { allow_deep_chain?: unknown } | null
    const reversalEntry = await reverseEntry(supabase, companyId, user.id, id, undefined, {
      allowDeepChain: body?.allow_deep_chain === true,
    })
    return NextResponse.json({ data: reversalEntry })
  },
  { requireWrite: true },
)
