import { notFound, redirect } from 'next/navigation'
import { getReport } from '@/lib/reports/catalog'
import { FocusedReport } from '@/components/reports/FocusedReport'

/**
 * Focused single-report route. Unknown slugs 404; reports that own a dedicated
 * route (cash flow, annual report, KPI, SIE) redirect there. Everything else
 * renders inside the shared focused-report shell.
 */
export default async function ReportSlugPage({
  params,
}: {
  params: Promise<{ slug: string }>
}) {
  const { slug } = await params
  const report = getReport(slug)
  if (!report) notFound()
  if (report.route) redirect(report.route)
  return <FocusedReport slug={slug} />
}
