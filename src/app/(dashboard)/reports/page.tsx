'use client'

import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { useEmployees } from '@/lib/reference-data/hooks'
import { PageHeader } from '@/components/ui/page-header'
import { HelpPopover } from '@/components/ui/help-popover'
import { EmptyState } from '@/components/ui/empty-state'
import { useCompany } from '@/contexts/CompanyContext'
import { useCompanySettings } from '@/components/settings/useSettings'
import { useFiscalScope } from '@/components/providers/FiscalScopeProvider'
import { ReportLibrary } from '@/components/reports/ReportLibrary'
import { useRecentReports } from '@/components/reports/useRecentReports'
import { getReport } from '@/lib/reports/catalog'

/**
 * Reports catalog landing (concept "Tabellen"): one dry table grouped by
 * accounting taxonomy, with a "Senast öppnad" column instead of a separate
 * recents shelf. Selecting a report opens the focused /reports/[slug] route.
 * The fiscal year is app-wide context (the sidebar chip, useFiscalScope),
 * so the focused page shows the same year without URL plumbing.
 */
export default function ReportsPage() {
  const router = useRouter()
  // The catalog itself is static; only the "no fiscal year" empty state has
  // to wait for the app-wide scope to restore.
  const { periodId, ready: fyReady } = useFiscalScope({ allowAll: false, hideFuture: true })
  const selectedPeriod = periodId ?? ''
  const { company } = useCompany()
  const { settings } = useCompanySettings()
  const t = useTranslations('reports')
  // The top bar says what the menu row says (design.md convention 2).
  const tNav = useTranslations('nav')
  const { openedAt, pushRecent } = useRecentReports(company?.id)
  // Payroll reports (catalog needsEmployees) show only for a company that
  // has employees, former ones included. Best effort: a failed read keeps
  // them hidden.
  const { employees } = useEmployees({ includeInactive: true })
  const hasEmployees = employees.length > 0

  // Open a report. Route-owning reports (cash flow, annual report, KPI, SIE)
  // navigate to their own page; the rest open the focused /reports/[slug] route.
  const openReport = (slug: string) => {
    const report = getReport(slug)
    if (report?.route) {
      const href =
        slug === 'arsredovisning' && selectedPeriod
          ? `${report.route}?period=${selectedPeriod}`
          : report.route
      router.push(href)
      return
    }
    pushRecent(slug)
    router.push(`/reports/${slug}`)
  }

  return (
    <div className="space-y-8">
      <PageHeader
        title={tNav('v3_more_reports')}
        help={
          <HelpPopover>
            <p>{t('help_text')}</p>
            {/* Was a footnote under the catalog: help belongs behind the "?"
                (convention 7), not in the page flow. */}
            <p className="mt-2">{t('catalog_footnote')}</p>
          </HelpPopover>
        }
      />

      {fyReady && !selectedPeriod ? (
        <EmptyState
          title={t('no_fiscal_year_title')}
          description={t('no_fiscal_year_description')}
          actionLabel={t('no_fiscal_year_action')}
          actionHref="/settings"
        />
      ) : (
        <ReportLibrary
          entityType={company?.entity_type}
          hasEmployees={hasEmployees}
          dimensionsEnabled={settings?.dimensions_enabled === true}
          openedAt={openedAt}
          onOpen={openReport}
        />
      )}
    </div>
  )
}
