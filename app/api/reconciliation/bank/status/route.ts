import { createClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'
import { getReconciliationStatus } from '@/lib/reconciliation/bank-reconciliation'
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

  // Look up the cash account so we can pair the bank account with the right
  // currency. Comparing EUR GL movements against SEK transactions silently
  // produces nonsense.
  const { data: cashAccount } = await supabase
    .from('cash_accounts')
    .select('currency')
    .eq('company_id', companyId)
    .eq('ledger_account', accountNumber)
    .maybeSingle()

  if (!cashAccount && accountNumber !== '1930') {
    return NextResponse.json(
      { error: 'Okänt kassakonto för det här företaget' },
      { status: 400 },
    )
  }

  const currency = (cashAccount?.currency as string | undefined) ?? 'SEK'

  const status = await getReconciliationStatus(
    supabase,
    companyId,
    dateFrom,
    dateTo,
    accountNumber,
    currency,
  )

  return NextResponse.json({ data: status })
}
