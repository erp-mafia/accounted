import { notFound, redirect } from 'next/navigation'
import { getReport } from '@/lib/reports/catalog'
import { FocusedReport } from '@/components/reports/FocusedReport'
import { getDashboardAuthContext, getDashboardCompanyId } from '../../request-context'
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

  const [{ supabase }, companyId] = await Promise.all([
    getDashboardAuthContext(),
    getDashboardCompanyId(),
  ])
  const needsFiscalPeriod = report.params !== 'calendar' && report.params !== 'none'
  const { data: periods } = companyId && needsFiscalPeriod
    ? await supabase
        .from('fiscal_periods')
        .select('*')
        .eq('company_id', companyId)
        .order('period_start', { ascending: false })
    : { data: [] }

  return (
    <FocusedReport
      slug={slug}
      initialPeriods={(periods ?? []) as FiscalPeriod[]}
      initialCompanyId={companyId}
    />
  )
}
