import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { requireCompanyId } from '@/lib/company/context'
import { listWorkspaceItems } from '@/lib/workspace/list-items'

/**
 * GET /api/workspace/items — Att bokföra aggregator (pending_ops + JE drafts).
 */
export async function GET() {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const companyId = await requireCompanyId(supabase, user.id)

  try {
    const data = await listWorkspaceItems(supabase, companyId)
    return NextResponse.json({ data })
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Failed to list workspace items' },
      { status: 500 },
    )
  }
}
