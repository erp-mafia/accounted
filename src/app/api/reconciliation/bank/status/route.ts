import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { getReconciliationStatus } from '@/lib/reconciliation/bank-reconciliation'

export const GET = withRouteContext(
  'reconciliation.bank.status',
  async (request, { supabase, companyId }) => {
    const { searchParams } = new URL(request.url)
    const dateFrom = searchParams.get('date_from') || undefined
    const dateTo = searchParams.get('date_to') || undefined
    const accountNumber = searchParams.get('account_number') || '1930'

    // Look up the cash account so we can pair the bank account with the right
    // currency. Comparing EUR GL movements against SEK transactions silently
    // produces nonsense.
    const { data: cashAccount } = await supabase
      .from('cash_accounts')
      .select('id, currency, is_primary')
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
    const cashAccountId = cashAccount?.id as string | undefined
    // Only the primary account claims unassigned (NULL cash_account_id) rows.
    // A secondary same-currency account (e.g. a 1931 savings account) must not, or
    // 1930's unassigned rows inflate its bank total and show a bogus difference.
    const includeUnassigned = Boolean(cashAccount?.is_primary)

    const status = await getReconciliationStatus(
      supabase,
      companyId,
      dateFrom,
      dateTo,
      accountNumber,
      currency,
      cashAccountId,
      includeUnassigned,
    )

    return NextResponse.json({ data: status })
  },
)
