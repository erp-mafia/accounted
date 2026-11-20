'use client'

import { useEffect, useState, useCallback } from 'react'
import { useLocale, useTranslations } from 'next-intl'
import { PageHeader } from '@/components/ui/page-header'
import { HelpPopover } from '@/components/ui/help-popover'
import { useFiscalScope } from '@/components/providers/FiscalScopeProvider'
import { ReportPrintHeader } from '@/components/reports/ReportPrintHeader'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Skeleton, LateReveal } from '@/components/ui/skeleton'
import { EmptyState, LoadError } from '@/components/ui/empty-state'
import { useToast } from '@/components/ui/use-toast'
import { ArrowDownTrayIcon, CheckCircleIcon, ExclamationTriangleIcon } from '@/components/icons'
import { formatAmount } from '@/lib/utils'
import { downloadFile } from '@/lib/browser/download-file'
import { failureDescription } from '@/lib/browser/action-failure'
import type { KassaflodesanalysFullReport } from '@/lib/reports/kassaflodesanalys'
import {
  KASSAFLODESANALYS_LAYOUT,
  type KassaflodesanalysLayoutRow,
  type KassaflodesanalysYear,
} from '@/lib/reports/kassaflodesanalys-layout'
import {
  getErrorMessage as getUserErrorMessage,
  type ErrorLocale,
} from '@/lib/errors/get-error-message'

interface CashRowProps {
  label: string
  amount: number
}

function CashRow({ label, amount }: CashRowProps) {
  return (
    <div className="flex items-center justify-between py-1 text-sm">
      <span className="text-foreground">{label}</span>
      <span className="tabular-nums text-right">{formatAmount(amount)}</span>
    </div>
  )
}

export function KassaflodesanalysClient() {
  const t = useTranslations('reports')
  const tNav = useTranslations('nav')
  const locale = useLocale() as ErrorLocale
  const { toast } = useToast()
  // The fiscal year is app-wide context (the sidebar); a report needs one started year.
  const { periodId: selectedPeriod, ready: periodsReady } = useFiscalScope({ allowAll: false, hideFuture: true })
  const [report, setReport] = useState<KassaflodesanalysFullReport | null>(null)
  const isLoadingPeriods = !periodsReady
  const [isLoadingReport, setIsLoadingReport] = useState(false)
  const [isDownloadingPdf, setIsDownloadingPdf] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const loadReport = useCallback(async (periodId: string) => {
    setIsLoadingReport(true)
    setError(null)
    try {
      const res = await fetch(`/api/reports/kassaflodesanalys?period_id=${periodId}`)
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(getUserErrorMessage(body, { locale: locale, fallback: t('cash_flow_load_failed') }))
      }
      const { data } = await res.json()
      setReport(data)
    } catch (err) {
      setError(err instanceof Error ? getUserErrorMessage(err, { locale }) : t('cash_flow_load_failed'))
      setReport(null)
    } finally {
      setIsLoadingReport(false)
    }
  }, [t, locale])

  useEffect(() => {
    if (selectedPeriod) {
      loadReport(selectedPeriod)
    } else {
      setReport(null)
    }
  }, [selectedPeriod, loadReport])

  /**
   * Fetch the statutory kassaflödesanalys PDF and save it only if the server
   * actually produced one.
   *
   * This used to be `window.location.href = <pdf route>`, which has no seam for
   * either half of the problem. On success the browser cancels the navigation
   * (the route answers Content-Disposition: attachment) and the click gives no
   * feedback at all, so nothing marks the render as in flight: a second click
   * starts a second full report query plus renderToBuffer. On failure the route
   * answers a JSON error envelope with no Content-Disposition, so the browser
   * navigates the whole app away and the user is left staring at raw JSON with
   * their report page gone. There is no `res` to check and no promise to catch
   * on a location assignment; the only fix is to make the download a bounded
   * fetch.
   *
   * The filename mirrors the route's Content-Disposition
   * (kassaflodesanalys-<period_start>.pdf): both sides derive it from the same
   * fiscal period, and the button is disabled until that report is loaded.
   *
   * No success toast: the saved file is the feedback. On failure nothing was
   * written to disk and exactly one toast says why. Never two, TOAST_LIMIT is 1
   * (components/ui/use-toast.tsx), so a second toast in the same tick evicts the
   * first and only the last is rendered.
   */
  const handleDownloadPdf = useCallback(async () => {
    // The button is disabled while a render is in flight; this guard closes the
    // double-click / Enter-repeat race before React has re-rendered it.
    if (!selectedPeriod || !report || isDownloadingPdf) return
    setIsDownloadingPdf(true)
    try {
      // The shared 15s deadline applies: this is one fiscal year of aggregation
      // plus a single-page render with stock fonts, so the realistic worst case
      // is a cold start and one round trip. If a healthy render ever needs
      // longer, the answer is maxDuration on the route plus a matching
      // timeoutMs here, never an unbounded fetch that spins forever.
      const result = await downloadFile({
        url: `/api/reports/kassaflodesanalys/pdf?period_id=${selectedPeriod}`,
        filename: `kassaflodesanalys-${report.period_start}.pdf`,
        locale,
      })
      if (!result.ok) {
        toast({
          title: t('pdf_download_failed_title'),
          description: failureDescription(result, {
            timeout: t('pdf_download_timeout'),
            network: t('pdf_download_network'),
          }),
          variant: 'destructive',
        })
      }
    } finally {
      setIsDownloadingPdf(false)
    }
  }, [selectedPeriod, report, isDownloadingPdf, locale, toast, t])

  // The shell every report page shares: title, "?" and the top bar's
  // actions (download, then the year picker far right, convention 8). No
  // back link over the title (the nav names Rapporter), no period line (the
  // picker names the year; ReportPrintHeader states it on paper) and no
  // permanently disabled Excel button.
  return (
    <div className="space-y-8">
      <PageHeader
        title={t('name_kassaflodesanalys')}
        // Reached from Fler rapporter: the quiet way back sits before the title.
        parent={{ label: tNav('v3_more_reports'), href: '/reports' }}
        help={<HelpPopover>{t('cash_flow_help')}</HelpPopover>}
        action={
          <div className="flex items-center gap-2">
            <Button
              size="toolbar"
              variant="outline"
              onClick={handleDownloadPdf}
              disabled={!report || isLoadingReport}
              loading={isDownloadingPdf}
            >
              {!isDownloadingPdf && <ArrowDownTrayIcon className="h-4 w-4" />}
              {t('download_pdf')}
            </Button>
          </div>
        }
      />
      <ReportPrintHeader
        period={report ? { start: report.period_start, end: report.period_end } : null}
      />

      {isLoadingPeriods ? (
        <LateReveal className="space-y-4">
          <Skeleton className="h-48" />
          <Skeleton className="h-32" />
          <Skeleton className="h-32" />
        </LateReveal>
      ) : !selectedPeriod ? (
        <EmptyState
          title={t('cash_flow_choose_year_title')}
          description={t('cash_flow_choose_year_description')}
        />
      ) : isLoadingReport ? (
        <LateReveal className="space-y-4">
          <Skeleton className="h-48" />
          <Skeleton className="h-32" />
          <Skeleton className="h-32" />
        </LateReveal>
      ) : error ? (
        <LoadError title={error} onRetry={() => void loadReport(selectedPeriod)} />
      ) : report ? (
        <KassaflodesanalysStatementView report={report} />
      ) : null}
    </div>
  )
}

/** A financial year's column heading: 2026, or 2025/26 for a broken year. */
function yearLabel(year: KassaflodesanalysYear): string {
  const start = year.period_start.slice(0, 4)
  const end = year.period_end.slice(0, 4)
  return start === end ? end : `${start}/${end.slice(2)}`
}

const SECTION_TITLE_KEYS = {
  lopande: 'cash_flow_section_operating',
  investering: 'cash_flow_section_investing',
  finansiering: 'cash_flow_section_financing',
} as const

const LIQUIDITY_PARTS = [
  ['kassamedel', 'cash_flow_liquid_cash'],
  ['bank', 'cash_flow_liquid_bank'],
  ['kortfristiga_placeringar', 'cash_flow_liquid_placements'],
  ['koncernkonto', 'cash_flow_liquid_group_account'],
] as const

/**
 * The K3 chapter 7 statement: the lines of KASSAFLODESANALYS_LAYOUT in their
 * order, the comparative year beside the year when there is one, then
 * likvida medel by part (7.18) and the reconciliation.
 */
function KassaflodesanalysStatementView({ report }: { report: KassaflodesanalysFullReport }) {
  const t = useTranslations('reports')
  const { current, previous } = report.statement
  const recon = current.reconciliation
  const shown = KASSAFLODESANALYS_LAYOUT.filter((row) => row.alwaysShow
    || current.amounts[row.key] !== 0
    || (previous !== null && previous.amounts[row.key] !== 0))
  const unclassified = [...new Set([...current.unclassified_accounts, ...(previous?.unclassified_accounts ?? [])])]
  const labelOf = (row: KassaflodesanalysLayoutRow) => row.key === 'ovriga_poster'
    ? t('cash_flow_other_items', { accounts: unclassified.join(', ') })
    : t(`cash_flow_lines.${row.key}`)

  const amountRow = (
    key: string,
    label: string,
    pick: (year: KassaflodesanalysYear) => number,
    emphasis: boolean,
  ) => (
    <div
      key={key}
      className={
        emphasis
          ? 'flex flex-wrap items-center justify-between gap-x-4 gap-y-1 border-t-hairline pt-3 mt-2 text-sm font-medium'
          : 'flex flex-wrap items-center justify-between gap-x-4 gap-y-1 py-1 text-sm'
      }
    >
      <span className="text-foreground">{label}</span>
      <span className="ml-auto flex shrink-0 gap-6">
        <span className="w-28 tabular-nums text-right">{formatAmount(pick(current))}</span>
        {previous && (
          <span className="w-28 tabular-nums text-right text-muted-foreground">{formatAmount(pick(previous))}</span>
        )}
      </span>
    </div>
  )
  const yearHeader = (
    <div className="ml-auto flex justify-end gap-6 text-xs font-medium text-muted-foreground">
      <span className="w-28 text-right">{yearLabel(current)}</span>
      {previous && <span className="w-28 text-right">{yearLabel(previous)}</span>}
    </div>
  )

  return (
    <div className="space-y-6 stagger-enter">
      {(['lopande', 'investering', 'finansiering'] as const).map((section) => (
        <Card key={section}>
          <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-4">
            <CardTitle className="text-base">{t(SECTION_TITLE_KEYS[section])}</CardTitle>
            {yearHeader}
          </CardHeader>
          <CardContent className="space-y-1">
            {shown
              .filter((row) => row.section === section)
              .map((row) => amountRow(row.key, labelOf(row), (year) => year.amounts[row.key], row.kind !== 'line'))}
          </CardContent>
        </Card>
      ))}

      <Card>
        <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-4">
          <CardTitle className="text-base">{t('cash_flow_section_liquidity')}</CardTitle>
          {yearHeader}
        </CardHeader>
        <CardContent className="space-y-1">
          {shown
            .filter((row) => row.section === 'likvida_medel')
            .map((row) => amountRow(row.key, labelOf(row), (year) => year.amounts[row.key], row.kind !== 'line'))}
          <div className="pt-4">
            {LIQUIDITY_PARTS
              .filter(([part]) => current.likvida_medel.ub[part] !== 0
                || (previous !== null && previous.likvida_medel.ub[part] !== 0))
              .map(([part, labelKey]) => amountRow(part, t(labelKey), (year) => year.likvida_medel.ub[part], false))}
          </div>
        </CardContent>
      </Card>

      <Card className={recon.is_reconciled ? 'border-border bg-muted/30' : 'border-destructive'}>
        <CardContent className="space-y-3">
          <div className="flex items-center gap-2">
            {recon.is_reconciled ? (
              <CheckCircleIcon className="h-5 w-5 text-success" />
            ) : (
              <ExclamationTriangleIcon className="h-5 w-5 text-destructive" />
            )}
            <span className="font-medium">
              {recon.is_reconciled ? t('cash_flow_reconciled') : t('cash_flow_not_reconciled')}
            </span>
          </div>
          <div className="space-y-1 text-sm">
            <CashRow label={t('cash_flow_delta_actual')} amount={recon.delta_actual} />
            <CashRow label={t('cash_flow_delta_calculated')} amount={recon.delta_calculated} />
            {!recon.is_reconciled && (
              <div className="flex items-center justify-between border-t border-destructive pt-2 mt-2 text-sm font-medium text-destructive">
                <span>{t('cash_flow_mismatch')}</span>
                <span className="tabular-nums text-right">{formatAmount(recon.mismatch_amount)}</span>
              </div>
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
