import { withRouteContext } from '@/lib/api/with-route-context'
import { NextResponse } from 'next/server'
import { generateSupplierLedger } from '@/lib/reports/supplier-ledger'
import { parseLedgerAsOfDate } from '@/lib/reports/ledger-as-of'
import { ledgerAsOfRefusal } from '@/lib/reports/ledger-as-of-refusal'
import { generateReconciliation } from '@/lib/reports/supplier-reconciliation'

export const GET = withRouteContext('report.supplier_ledger', async (request, { supabase, companyId, log, requestId }) => {
  const { searchParams } = new URL(request.url)
  const asOf = parseLedgerAsOfDate(searchParams.get('as_of_date'))
  if (!asOf.ok) return ledgerAsOfRefusal(asOf, log, requestId)
  const periodId = searchParams.get('period_id') || undefined

  // Independent reads: run them side by side.
  const [ledger, reconciliation] = await Promise.all([
    generateSupplierLedger(supabase, companyId, asOf.asOfDate),
    periodId ? generateReconciliation(supabase, companyId, periodId) : null,
  ])

  return NextResponse.json({
    data: {
      ledger,
      reconciliation,
    },
  })
})
