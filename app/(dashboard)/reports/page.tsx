'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { Skeleton } from '@/components/ui/skeleton'
import { Card, CardContent } from '@/components/ui/card'
import { PageHeader } from '@/components/ui/page-header'
import { EmptyState } from '@/components/ui/empty-state'
import { useCompany } from '@/contexts/CompanyContext'
import { useCompanySettings } from '@/components/settings/useSettings'
import { FiscalYearSelector } from '@/components/common/FiscalYearSelector'
import { ReportLibrary } from '@/components/reports/ReportLibrary'
import { RecentReportsShelf } from '@/components/reports/RecentReportsShelf'
import { useRecentReports } from '@/components/reports/useRecentReports'
import { getReport } from '@/lib/reports/catalog'

/**
 * Reports library landing. A calm, grouped index of every report: selecting
 * one opens the focused /reports/[slug] route. The fiscal year picked here
 * persists (FiscalYearSelector localStorage) and is restored on the focused
 * page, so the choice carries across without URL plumbing.
 */
export default function ReportsPage() {
  const router = useRouter()
  const [selectedPeriod, setSelectedPeriod] = useState('')
  const [isLoadingInit, setIsLoadingInit] = useState(true)
  const { company } = useCompany()
  const { settings } = useCompanySettings()
  const t = useTranslations('reports')
  const { recents, pushRecent } = useRecentReports(company?.id)

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
        action={
          <FiscalYearSelector
            value={selectedPeriod || null}
            onChange={(id) => setSelectedPeriod(id || '')}
            includeAllOption={false}
            hideFuturePeriods
            onReady={() => setIsLoadingInit(false)}
          />
        }
      />

      {isLoadingInit ? (
        <div className="space-y-6">
          <Skeleton className="h-4 w-40" />
          <Card>
            <CardContent className="p-6 space-y-4">
              <Skeleton className="h-5 w-32" />
              <Skeleton className="h-64" />
            </CardContent>
          </Card>
        </div>
      ) : !selectedPeriod ? (
        <EmptyState
          title="Inget räkenskapsår valt"
          description="Skapa ett räkenskapsår för att kunna se rapporter."
          actionLabel="Gå till inställningar"
          actionHref="/settings"
        />
      ) : (
        <div className="space-y-8">
          <RecentReportsShelf
            slugs={recents}
            entityType={company?.entity_type}
            onOpen={openReport}
          />
          <ReportLibrary
            entityType={company?.entity_type}
            dimensionsEnabled={settings?.dimensions_enabled === true}
            onOpen={openReport}
          />
        </div>
      )}
    </div>
  )
}
