import { createClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'
import { fetchUnlinkedGLLines } from '@/lib/reconciliation/bank-reconciliation'
import { requireCompanyId } from '@/lib/company/context'

export async function GET(request: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const companyId = await requireCompanyId(supabase, user.id)

  const { searchParams } = new URL(request.url)
  const dateFrom = searchParams.get('date_from') || undefined
  const dateTo = searchParams.get('date_to') || undefined
  const accountNumber = searchParams.get('account_number') || '1930'

  // Defense-in-depth: only allow account numbers that the company has actually
  // registered as a cash account. Without this, a curious caller could probe
  // arbitrary GL accounts for posted-but-unmatched amounts. Applies uniformly
  // including '1930' — the cash_accounts backfill seeds 1930 for every company
  // that had a SEK PSD2 account, and the AccountPickerDialog seeds it for new
  // companies on first connection.
  const { data: cashAccount } = await supabase
    .from('cash_accounts')
    .select('id')
    .eq('company_id', companyId)
    .eq('ledger_account', accountNumber)
    .maybeSingle()

  if (!cashAccount) {
    return NextResponse.json(
      { error: 'Okänt kassakonto för det här företaget' },
      { status: 400 },
    )
  }

  const lines = await fetchUnlinkedGLLines(supabase, companyId, accountNumber, dateFrom, dateTo)

  return NextResponse.json({ data: lines })
}
