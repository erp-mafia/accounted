import { createClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'
import { requireCompanyId } from '@/lib/company/context'
import { fetchAllRows } from '@/lib/supabase/fetch-all'

/**
 * Returns the set of journal_entry IDs in the active company that the user has
 * flagged as "no underlag required". The client uses this set to:
 *   - exclude exempted entries from the "Saknade underlag" filter
 *   - show a muted "no doc needed" indicator instead of the warning triangle
 */
export async function GET() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const companyId = await requireCompanyId(supabase, user.id)

  const rows = await fetchAllRows<{ journal_entry_id: string; reason: string | null }>(
    ({ from, to }) =>
      supabase
        .from('journal_entry_no_doc_required')
        .select('journal_entry_id, reason')
        .eq('company_id', companyId)
        .range(from, to)
  )

  return NextResponse.json({ data: rows })
}
