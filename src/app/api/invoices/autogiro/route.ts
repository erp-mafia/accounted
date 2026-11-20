import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { todayIsoStockholm } from '@/lib/dates/iso'
import { isAutogiroEnabled } from '@/lib/invoices/autogiro/flag'
import { loadAutogiroOverview } from '@/lib/invoices/autogiro/service'

/**
 * GET /api/invoices/autogiro: the Autogiro page. The company's agreement,
 * its mandates, the issued invoices that announced Autogiro and can go into
 * the next debit file (each with its payment day, amount, or why not), the
 * latest debits and files. `enabled`: whether the company may start new
 * Autogiro work (AUTOGIRO_COMPANY_IDS); what it already holds is shown
 * either way.
 */
export const GET = withRouteContext('autogiro.overview', async (_request, { supabase, companyId }) => {
  const overview = await loadAutogiroOverview(supabase, companyId, todayIsoStockholm())
  return NextResponse.json({ data: { enabled: isAutogiroEnabled(companyId), overview } })
})
