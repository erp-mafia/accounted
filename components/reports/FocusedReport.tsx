'use client'

import { Suspense, useState } from 'react'
import dynamic from 'next/dynamic'
import Link from 'next/link'
import { useRouter, useSearchParams } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { ChevronLeft } from 'lucide-react'
import { PageHeader } from '@/components/ui/page-header'
import { EmptyState } from '@/components/ui/empty-state'
import { Card, CardContent } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { useCompany } from '@/contexts/CompanyContext'
import { FyPicker } from '@/components/common/FyPicker'
import { ReportDateRange, type DateRangeValue } from '@/components/common/ReportDateRange'
import { DimensionFilter, type DimensionFilterValue } from '@/components/reports/DimensionFilter'
import { DATE_RANGE_SLUGS, DIMENSION_FILTER_SLUGS, getReport } from '@/lib/reports/catalog'
import type { FiscalPeriod } from '@/types'

function ReportViewLoading() {
  return (
    <Card>
      <CardContent className="space-y-4 p-6">
        <Skeleton className="h-5 w-32" />
        <Skeleton className="h-64" />
      </CardContent>
    </Card>
  )
}

const TrialBalanceView = dynamic(() => import('./lazy-views/TrialBalanceView'), { loading: ReportViewLoading })
const IncomeStatementView = dynamic(() => import('./lazy-views/IncomeStatementView'), { loading: ReportViewLoading })
const BalanceSheetView = dynamic(() => import('./lazy-views/BalanceSheetView'), { loading: ReportViewLoading })
const ResultatrapportView = dynamic(() => import('./lazy-views/ResultatrapportView'), { loading: ReportViewLoading })
const BalansrapportView = dynamic(() => import('./lazy-views/BalansrapportView'), { loading: ReportViewLoading })
const VatDeclarationView = dynamic(() => import('./lazy-views/VatDeclarationView'), { loading: ReportViewLoading })
const SupplierLedgerView = dynamic(() => import('./lazy-views/SupplierLedgerView'), { loading: ReportViewLoading })
const GeneralLedgerView = dynamic(() => import('./lazy-views/GeneralLedgerView'), { loading: ReportViewLoading })
const JournalRegisterView = dynamic(() => import('./lazy-views/JournalRegisterView'), { loading: ReportViewLoading })
const ARLedgerView = dynamic(() => import('./lazy-views/ARLedgerView'), { loading: ReportViewLoading })
const DimensionPnlView = dynamic(() => import('./lazy-views/DimensionPnlView'), { loading: ReportViewLoading })
const NEDeclarationView = dynamic(() =>
  import('./NEDeclarationView').then((module) => ({ default: module.NEDeclarationView })),
  { loading: ReportViewLoading },
)
const PeriodiskSammanstallningView = dynamic(() =>
  import('./PeriodiskSammanstallningView').then((module) => ({ default: module.PeriodiskSammanstallningView })),
  { loading: ReportViewLoading },
)
const INK2DeclarationView = dynamic(() =>
  import('./INK2DeclarationView').then((module) => ({ default: module.INK2DeclarationView })),
  { loading: ReportViewLoading },
)
const BehandlingshistorikView = dynamic(() =>
  import('./BehandlingshistorikView').then((module) => ({ default: module.BehandlingshistorikView })),
  { loading: ReportViewLoading },
)

/**
 * The focused single-report experience at /reports/[slug]. Carries one report:
 * a back link to the library, the shared fiscal-year selector (restored from
 * localStorage so it matches the year picked on the landing), the report's
 * optional date-range control, and the report body. Drilling into an account
 * navigates to /reports/huvudbok?account=…: drill state lives in the URL.
 */
function FocusedReportInner({
  slug,
  initialPeriods,
  initialCompanyId,
}: {
  slug: string
  initialPeriods: FiscalPeriod[]
  initialCompanyId: string | null
}) {
  const router = useRouter()
  const searchParams = useSearchParams()
  const { company } = useCompany()
  const t = useTranslations('reports')

  const [selectedPeriod, setSelectedPeriod] = useState('')
  const [selectedPeriodBounds, setSelectedPeriodBounds] = useState<{ start: string; end: string } | null>(null)
  const [dateRange, setDateRange] = useState<DateRangeValue>({})
  const [dimensionFilter, setDimensionFilter] = useState<DimensionFilterValue | null>(null)
  const [isReady, setIsReady] = useState(false)

  const report = getReport(slug)
  // Calendar (VAT family) and param-less reports don't need a fiscal period.
  const isPeriodless = report?.params === 'calendar' || report?.params === 'none'
  // Nav-promoted pages (Momsdeklaration) drop the library chrome: no back
  // link, no shell fiscal-year selector — the view owns its period controls.
  const isStandalone = !!report?.standalone
  const reportName = report ? t(report.labelKey) : slug
  const accountFilter = searchParams.get('account')

  const isEnskildFirma = company?.entity_type === 'enskild_firma'
  const isAktiebolag = company?.entity_type === 'aktiebolag'

  // Drilling from a report into the general ledger is a route change, so the
  // account lands in the URL and the browser back button returns to the report.
  const navigateToAccount = (accountNumber: string) => {
    router.push(`/reports/huvudbok?account=${encodeURIComponent(accountNumber)}`)
  }

  return (
    <div className="space-y-8">
      {!isStandalone && (
        <Link
          href="/reports"
          className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground transition-colors"
        >
          <ChevronLeft className="h-4 w-4" />
          {t('back_to_library')}
        </Link>
      )}

      {/* Standalone pages (Momsdeklaration) render their own PageHeader so
          the primary action can live on the title row; the view receives the
          title via pageTitle instead. */}
      {!isStandalone && (
        <PageHeader
          title={reportName}
          // Page help behind a "?" (UI-migration convention 7): the report
          // bodies carry no instructional copy in the page flow.
          help={
            undefined
          }
          action={
            <FyPicker
              value={selectedPeriod || null}
              onChange={(id, period) => {
                setSelectedPeriod(id || '')
                setSelectedPeriodBounds(
                  period ? { start: period.period_start, end: period.period_end } : null,
                )
                setDateRange({})
              }}
              includeAllOption={false}
              hideFuturePeriods
              onReady={() => setIsReady(true)}
              initialPeriods={initialPeriods}
              initialCompanyId={initialCompanyId}
            />
          }
        />
      )}

      {DATE_RANGE_SLUGS.has(slug) && selectedPeriodBounds && (
        <ReportDateRange
          periodStart={selectedPeriodBounds.start}
          periodEnd={selectedPeriodBounds.end}
          value={dateRange}
          onChange={setDateRange}
        />
      )}

      {DIMENSION_FILTER_SLUGS.has(slug) && selectedPeriod && (
        <DimensionFilter value={dimensionFilter} onChange={setDimensionFilter} />
      )}

      {!isReady && !isPeriodless ? (
        <Card>
          <CardContent className="p-6 space-y-4">
            <Skeleton className="h-5 w-32" />
            <Skeleton className="h-64" />
          </CardContent>
        </Card>
      ) : isPeriodless || selectedPeriod ? (
        <FocusedView
          slug={slug}
          reportName={reportName}
          periodId={selectedPeriod}
          dateRange={dateRange}
          dimensionFilter={dimensionFilter}
          accountFilter={accountFilter}
          isEnskildFirma={isEnskildFirma}
          isAktiebolag={isAktiebolag}
          onNavigateToAccount={navigateToAccount}
        />
      ) : (
        <EmptyState
          title="Inget räkenskapsår valt"
          description="Skapa ett räkenskapsår för att kunna se rapporter."
          actionLabel="Gå till inställningar"
          actionHref="/settings"
        />
      )}
    </div>
  )
}

function FocusedView({
  slug,
  reportName,
  periodId,
  dateRange,
  dimensionFilter,
  accountFilter,
  isEnskildFirma,
  isAktiebolag,
  onNavigateToAccount,
}: {
  slug: string
  reportName: string
  periodId: string
  dateRange: DateRangeValue
  dimensionFilter: DimensionFilterValue | null
  accountFilter: string | null
  isEnskildFirma: boolean
  isAktiebolag: boolean
  onNavigateToAccount: (account: string) => void
}) {
  switch (slug) {
    case 'resultatrapport':
      return <ResultatrapportView periodId={periodId} dateRange={dateRange} dimensionFilter={dimensionFilter} onNavigateToAccount={onNavigateToAccount} />
    case 'dimension-pnl':
      return <DimensionPnlView periodId={periodId} dateRange={dateRange} />
    case 'balansrapport':
      return <BalansrapportView periodId={periodId} dateRange={dateRange} onNavigateToAccount={onNavigateToAccount} />
    case 'trial-balance':
      return <TrialBalanceView periodId={periodId} onNavigateToAccount={onNavigateToAccount} />
    case 'income-statement':
      return <IncomeStatementView periodId={periodId} dateRange={dateRange} dimensionFilter={dimensionFilter} onNavigateToAccount={onNavigateToAccount} />
    case 'balance-sheet':
      return <BalanceSheetView periodId={periodId} dateRange={dateRange} onNavigateToAccount={onNavigateToAccount} />
    case 'vat-declaration':
      return <VatDeclarationView pageTitle={reportName} />
    case 'periodisk-sammanstallning':
      return <PeriodiskSammanstallningView />
    case 'ne-declaration':
      return isEnskildFirma ? <NEDeclarationView periodId={periodId} /> : null
    case 'ink2-declaration':
      return isAktiebolag ? <INK2DeclarationView periodId={periodId} /> : null
    case 'huvudbok':
      return <GeneralLedgerView periodId={periodId} initialAccountFilter={accountFilter} dimensionFilter={dimensionFilter} dateRange={dateRange} />
    case 'grundbok':
      return <JournalRegisterView periodId={periodId} />
    case 'kundreskontra':
      return <ARLedgerView periodId={periodId} />
    case 'supplier-ledger':
      return <SupplierLedgerView periodId={periodId} />
    case 'behandlingshistorik':
      return <BehandlingshistorikView periodId={periodId} dateRange={dateRange} />
    default:
      return null
  }
}

export function FocusedReport({
  slug,
  initialPeriods,
  initialCompanyId,
}: {
  slug: string
  initialPeriods: FiscalPeriod[]
  initialCompanyId: string | null
}) {
  return (
    <Suspense fallback={<div className="space-y-8" />}>
      <FocusedReportInner
        slug={slug}
        initialPeriods={initialPeriods}
        initialCompanyId={initialCompanyId}
      />
    </Suspense>
  )
}
