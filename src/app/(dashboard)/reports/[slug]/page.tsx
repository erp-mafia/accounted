import { notFound, redirect } from 'next/navigation'
import { getReport } from '@/lib/reports/catalog'
import { FocusedReport } from '@/components/reports/FocusedReport'
import { getDashboardCompanyId, getDashboardFiscalPeriods } from '../../request-context'
import type { FiscalPeriod } from '@/types'

/**
 * Focused single-report route. Unknown slugs 404; reports that own a dedicated
 * route (cash flow, annual report, KPI, SIE) redirect there. Everything else
 * renders inside the shared focused-report shell.
 */
export default async function ReportSlugPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>
}) {
  const [{ slug }, query] = await Promise.all([params, searchParams])
  const report = getReport(slug)
  if (!report) notFound()
  if (report.route) {
    // The old bankavstämning deep link (?autorun=1 from the transactions
    // inbox) keeps working on the page that absorbed it.
    redirect(slug === 'bank-reconciliation' && query.autorun === '1' ? `${report.route}?autorun=1` : report.route)
  }

  const companyId = await getDashboardCompanyId()
  const needsFiscalPeriod = report.params !== 'calendar' && report.params !== 'none'
  // Request-cached: the dashboard layout already read the same list.
  const { data: periods } = companyId && needsFiscalPeriod
    ? await getDashboardFiscalPeriods()
    : { data: [] }

  return (
    <FocusedReport
      slug={slug}
      initialPeriods={(periods ?? []) as FiscalPeriod[]}
      initialCompanyId={companyId}
    />
  )
}
