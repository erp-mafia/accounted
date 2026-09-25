'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { PageHeader } from '@/components/ui/page-header'
import { HelpPopover } from '@/components/ui/help-popover'
import { EmptyState } from '@/components/ui/empty-state'
import { useCompany } from '@/contexts/CompanyContext'
import { useCompanySettings } from '@/components/settings/useSettings'
import { FyPicker } from '@/components/common/FyPicker'
import { ReportLibrary } from '@/components/reports/ReportLibrary'
import { useRecentReports } from '@/components/reports/useRecentReports'
import { getReport } from '@/lib/reports/catalog'

/**
 * Reports catalog landing (concept "Tabellen"): one dry table grouped by
 * accounting taxonomy, with a "Senast öppnad" column instead of a separate
 * recents shelf. Selecting a report opens the focused /reports/[slug] route.
 * The fiscal year picked here persists (FyPicker localStorage) and is
 * restored on the focused page, so the choice carries across without URL
 * plumbing.
 */
export default function ReportsPage() {
  const router = useRouter()
  const [selectedPeriod, setSelectedPeriod] = useState('')
  // The catalog itself is static; only the "no fiscal year" empty state has
  // to wait for the picker to finish restoring its scope (one effect tick
  // when the periods are seeded, see FyPicker).
  const [fyReady, setFyReady] = useState(false)
  const { company } = useCompany()
  const { settings } = useCompanySettings()
  const t = useTranslations('reports')
  const { openedAt, pushRecent } = useRecentReports(company?.id)

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
        title={t('title')}
        help={
          <HelpPopover>
            <p>{t('help_text')}</p>
            {/* Was a footnote under the catalog: help belongs behind the "?"
                (convention 7), not in the page flow. */}
            <p className="mt-2">{t('catalog_footnote')}</p>
          </HelpPopover>
        }
        action={
          <FyPicker
            value={selectedPeriod || null}
            onChange={(id) => setSelectedPeriod(id || '')}
            includeAllOption={false}
            hideFuturePeriods
            onReady={() => setFyReady(true)}
          />
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
          dimensionsEnabled={settings?.dimensions_enabled === true}
          openedAt={openedAt}
          onOpen={openReport}
        />
      )}
    </div>
  )
}
