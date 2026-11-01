import { NextResponse } from 'next/server'
import { generateARLedger } from '@/lib/reports/ar-ledger'
import { parseLedgerAsOfDate } from '@/lib/reports/ledger-as-of'
import { ledgerAsOfRefusal } from '@/lib/reports/ledger-as-of-refusal'
import { generateARReconciliation } from '@/lib/reports/ar-reconciliation'
import { withRouteContext } from '@/lib/api/with-route-context'

export const GET = withRouteContext('report.ar_ledger', async (request, { supabase, companyId, log, requestId }) => {
  const { searchParams } = new URL(request.url)
  const asOf = parseLedgerAsOfDate(searchParams.get('as_of_date'))
  if (!asOf.ok) return ledgerAsOfRefusal(asOf, log, requestId)
  const periodId = searchParams.get('period_id') || undefined

  // Independent reads: run them side by side.
  const [ledger, reconciliation] = await Promise.all([
    generateARLedger(supabase, companyId, asOf.asOfDate),
    periodId ? generateARReconciliation(supabase, companyId, periodId) : null,
  ])

  return NextResponse.json({
    data: {
      ledger,
      reconciliation,
    },
  })
})
