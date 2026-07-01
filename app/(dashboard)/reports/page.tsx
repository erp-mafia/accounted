'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { Skeleton } from '@/components/ui/skeleton'
import { Card, CardContent } from '@/components/ui/card'
import { PageHeader } from '@/components/ui/page-header'
import { EmptyState } from '@/components/ui/empty-state'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { useCompany } from '@/contexts/CompanyContext'
import { FiscalYearSelector } from '@/components/common/FiscalYearSelector'
import { ReportLibrary } from '@/components/reports/ReportLibrary'
import { ReportSectionList } from '@/components/reports/ReportSectionList'
import { RecentReportsShelf } from '@/components/reports/RecentReportsShelf'
import { useRecentReports } from '@/components/reports/useRecentReports'
import { KpiDashboard } from '@/components/kpi/KpiDashboard'
import { getReport, getReadingSections } from '@/lib/reports/catalog'

/**
 * The Rapporter surface — one home for the numbers, arranged as tabs:
 *  - Översikt: the KPI glance (canonical KPI home; Hem deep-links here).
 *  - Analys: readable P&L / balance reports.
 *  - Underlag: raw ledger detail, reconciliation, payroll.
 *  - Alla rapporter: the complete catalog index; statutory filings appear as
 *    deep-links into their owning Skatt & bokslut context.
 *
 * The fiscal year picked in the header persists (FiscalYearSelector
 * localStorage) and is restored on focused /reports/[slug] views.
 */
export default function ReportsPage() {
  const router = useRouter()
  const [selectedPeriod, setSelectedPeriod] = useState('')
  const [isLoadingInit, setIsLoadingInit] = useState(true)
  const { company } = useCompany()
  const t = useTranslations('reports')
  const { recents, pushRecent } = useRecentReports(company?.id)
  const entityType = company?.entity_type

  // Open a report. Route-owning reports (cash flow, annual report, KPI, SIE,
  // filings) navigate to their own page; the rest open the focused
  // /reports/[slug] route.
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
        <Tabs defaultValue="oversikt" className="space-y-8">
          <TabsList>
            <TabsTrigger value="oversikt">{t('tab_oversikt')}</TabsTrigger>
            <TabsTrigger value="analys">{t('tab_analys')}</TabsTrigger>
            <TabsTrigger value="underlag">{t('tab_underlag')}</TabsTrigger>
            <TabsTrigger value="alla">{t('tab_alla')}</TabsTrigger>
          </TabsList>

          <TabsContent value="oversikt">
            <KpiDashboard periodId={selectedPeriod} />
          </TabsContent>

          <TabsContent value="analys">
            <ReportSectionList
              sections={getReadingSections('analys', entityType)}
              onOpen={openReport}
            />
          </TabsContent>

          <TabsContent value="underlag">
            <ReportSectionList
              sections={getReadingSections('underlag', entityType)}
              onOpen={openReport}
            />
          </TabsContent>

          <TabsContent value="alla" className="space-y-8">
            <RecentReportsShelf
              slugs={recents}
              entityType={entityType}
              onOpen={openReport}
            />
            <ReportLibrary entityType={entityType} onOpen={openReport} />
          </TabsContent>
        </Tabs>
      )}
    </div>
  )
}
