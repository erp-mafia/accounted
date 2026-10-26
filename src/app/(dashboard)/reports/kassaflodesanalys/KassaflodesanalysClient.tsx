'use client'

import { useEffect, useState, useCallback } from 'react'
import { useLocale, useTranslations } from 'next-intl'
import { PageHeader } from '@/components/ui/page-header'
import { HelpPopover } from '@/components/ui/help-popover'
import { FyPicker } from '@/components/common/FyPicker'
import { ReportPrintHeader } from '@/components/reports/ReportPrintHeader'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { EmptyState } from '@/components/ui/empty-state'
import { useToast } from '@/components/ui/use-toast'
import { ArrowDownTrayIcon, CheckCircleIcon, ExclamationTriangleIcon } from '@/components/icons'
import { formatAmount } from '@/lib/utils'
import { downloadFile } from '@/lib/browser/download-file'
import { failureDescription } from '@/lib/browser/action-failure'
import type { KassaflodesanalysReport } from '@/lib/reports/kassaflodesanalys'
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

interface SubtotalRowProps {
  label: string
  amount: number
}

function SubtotalRow({ label, amount }: SubtotalRowProps) {
  return (
    <div className="flex items-center justify-between border-t border-border pt-3 mt-2 text-sm font-medium">
      <span>{label}</span>
      <span className="tabular-nums text-right">{formatAmount(amount)}</span>
    </div>
  )
}

export function KassaflodesanalysClient() {
  const t = useTranslations('reports')
  const locale = useLocale() as ErrorLocale
  const { toast } = useToast()
  const [selectedPeriod, setSelectedPeriod] = useState<string | null>(null)
  const [report, setReport] = useState<KassaflodesanalysReport | null>(null)
  const [isLoadingPeriods, setIsLoadingPeriods] = useState(true)
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
        help={<HelpPopover>{t('cash_flow_help')}</HelpPopover>}
        action={
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              variant="outline"
              onClick={handleDownloadPdf}
              disabled={!report || isLoadingReport}
              loading={isDownloadingPdf}
            >
              {!isDownloadingPdf && <ArrowDownTrayIcon className="mr-2 h-4 w-4" />}
              {t('download_pdf')}
            </Button>
            <FyPicker
              value={selectedPeriod}
              onChange={(id) => setSelectedPeriod(id)}
              includeAllOption={false}
              hideFuturePeriods
              onReady={() => setIsLoadingPeriods(false)}
            />
          </div>
        }
      />
      <ReportPrintHeader
        period={report ? { start: report.period_start, end: report.period_end } : null}
      />

      {isLoadingPeriods ? (
        <div className="space-y-4">
          <Skeleton className="h-48" />
          <Skeleton className="h-32" />
          <Skeleton className="h-32" />
        </div>
      ) : !selectedPeriod ? (
        <EmptyState
          title={t('cash_flow_choose_year_title')}
          description={t('cash_flow_choose_year_description')}
        />
      ) : isLoadingReport ? (
        <div className="space-y-4">
          <Skeleton className="h-48" />
          <Skeleton className="h-32" />
          <Skeleton className="h-32" />
        </div>
      ) : error ? (
        <Card className="border-destructive">
          <CardContent className="p-6 text-sm text-destructive">{error}</CardContent>
        </Card>
      ) : report ? (
        <div className="space-y-6">
          {/* Section 1: Löpande verksamhet. One heading per section, the
              statutory one the PDF uses. */}
          <Card>
            <CardHeader>
              <CardTitle className="text-base">{t('cash_flow_section_operating')}</CardTitle>
            </CardHeader>
            <CardContent className="space-y-1">
              <CashRow
                label={t('cash_flow_result_after_financial')}
                amount={report.lopande.resultat_efter_finansiella_poster}
              />
              <CashRow label={t('cash_flow_depreciation')} amount={report.lopande.avskrivningar} />
              <CashRow
                label={t('cash_flow_other_non_cash')}
                amount={report.lopande.ovriga_ej_kassaflodesposter}
              />
              <CashRow
                label={t('cash_flow_delta_receivables')}
                amount={report.lopande.delta_kortfristiga_fordringar}
              />
              <CashRow
                label={t('cash_flow_delta_inventory')}
                amount={report.lopande.delta_varulager}
              />
              <CashRow
                label={t('cash_flow_delta_payables')}
                amount={report.lopande.delta_kortfristiga_skulder}
              />
              <CashRow label={t('cash_flow_tax_paid')} amount={report.lopande.skatt_betald} />
              {report.lopande.koncernbidrag !== 0 && (
                <CashRow
                  label={t('cash_flow_group_contributions')}
                  amount={report.lopande.koncernbidrag}
                />
              )}
              {report.lopande.ovriga_poster !== 0 && (
                <CashRow
                  label={t('cash_flow_other_items', {
                    accounts: report.unclassified_accounts.join(', '),
                  })}
                  amount={report.lopande.ovriga_poster}
                />
              )}
              <SubtotalRow
                label={t('cash_flow_total_operating')}
                amount={report.lopande.total}
              />
            </CardContent>
          </Card>

          {/* Section 2: Investeringsverksamhet */}
          <Card>
            <CardHeader>
              <CardTitle className="text-base">{t('cash_flow_section_investing')}</CardTitle>
            </CardHeader>
            <CardContent className="space-y-1">
              <CashRow
                label={t('cash_flow_acquisitions')}
                amount={report.investerings.forvarv_anlaggningar}
              />
              <CashRow
                label={t('cash_flow_disposals')}
                amount={report.investerings.avyttring_anlaggningar}
              />
              {report.investerings.kortfristiga_placeringar !== 0 && (
                <CashRow
                  label={t('cash_flow_short_term_investments')}
                  amount={report.investerings.kortfristiga_placeringar}
                />
              )}
              <SubtotalRow
                label={t('cash_flow_total_investing')}
                amount={report.investerings.total}
              />
            </CardContent>
          </Card>

          {/* Section 3: Finansieringsverksamhet */}
          <Card>
            <CardHeader>
              <CardTitle className="text-base">{t('cash_flow_section_financing')}</CardTitle>
            </CardHeader>
            <CardContent className="space-y-1">
              <CashRow
                label={t('cash_flow_delta_loans')}
                amount={report.finansierings.delta_lan}
              />
              <CashRow label={t('cash_flow_dividends')} amount={report.finansierings.utdelningar} />
              <CashRow label={t('cash_flow_new_issue')} amount={report.finansierings.nyemission} />
              <CashRow
                label={t('cash_flow_shareholder_contributions')}
                amount={report.finansierings.erhallna_aktieagartillskott}
              />
              <SubtotalRow
                label={t('cash_flow_total_financing')}
                amount={report.finansierings.total}
              />
            </CardContent>
          </Card>

          {/* Total */}
          <Card>
            <CardContent className="p-6">
              <div className="flex items-center justify-between">
                <span className="font-display text-lg">{t('cash_flow_year_total')}</span>
                <span className="font-display text-lg tabular-nums">
                  {formatAmount(report.total_cash_flow)}
                </span>
              </div>
            </CardContent>
          </Card>

          {/* Reconciliation banner */}
          <Card
            className={
              report.reconciliation.is_reconciled
                ? 'border-border bg-muted/30'
                : 'border-destructive'
            }
          >
            <CardContent className="p-6 space-y-3">
              <div className="flex items-center gap-2">
                {report.reconciliation.is_reconciled ? (
                  <CheckCircleIcon className="h-5 w-5 text-success" />
                ) : (
                  <ExclamationTriangleIcon className="h-5 w-5 text-destructive" />
                )}
                <span className="font-medium">
                  {report.reconciliation.is_reconciled
                    ? t('cash_flow_reconciled')
                    : t('cash_flow_not_reconciled')}
                </span>
              </div>
              <div className="space-y-1 text-sm">
                <CashRow
                  label={t('cash_flow_opening_cash')}
                  amount={report.reconciliation.opening_cash_1xxx}
                />
                <CashRow
                  label={t('cash_flow_closing_cash')}
                  amount={report.reconciliation.closing_cash_1xxx}
                />
                <CashRow
                  label={t('cash_flow_delta_actual')}
                  amount={report.reconciliation.delta_actual}
                />
                <CashRow
                  label={t('cash_flow_delta_calculated')}
                  amount={report.reconciliation.delta_calculated}
                />
                {!report.reconciliation.is_reconciled && (
                  <div className="flex items-center justify-between border-t border-destructive pt-2 mt-2 text-sm font-medium text-destructive">
                    <span>{t('cash_flow_mismatch')}</span>
                    <span className="tabular-nums text-right">
                      {formatAmount(report.reconciliation.mismatch_amount)}
                    </span>
                  </div>
                )}
              </div>
            </CardContent>
          </Card>
        </div>
      ) : null}
    </div>
  )
}
