import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import {
  companyDefaultFramework,
  listFiscalYearFrameworks,
  pickCurrentFiscalYear,
} from '@/lib/company/accounting-framework'
import { todayIsoStockholm } from '@/lib/dates/iso'

/**
 * GET /api/company/accounting-framework
 *
 * The K2/K3 framework of every räkenskapsår of the active company (oldest
 * first), the year a change applies to by default (the one running today) and
 * the company default the next new year starts from. The settings form reads
 * it; changes go through PATCH /api/company/current.
 */
export const GET = withRouteContext('company.accounting_framework.list', async (_request, { supabase, companyId }) => {
  const [years, companyFramework] = await Promise.all([
    listFiscalYearFrameworks(supabase, companyId),
    companyDefaultFramework(supabase, companyId),
  ])
  const current = pickCurrentFiscalYear(years, todayIsoStockholm())
  return NextResponse.json({
    data: {
      years,
      current_fiscal_period_id: current?.id ?? null,
      company_framework: companyFramework,
    },
  })
})
