'use client'

import Link from 'next/link'
import { useEffect, useState, useCallback } from 'react'
import { useLocale, useTranslations } from 'next-intl'
import { PageHeader } from '@/components/ui/page-header'
import { FyPicker } from '@/components/common/FyPicker'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { EmptyState } from '@/components/ui/empty-state'
import { useToast } from '@/components/ui/use-toast'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/info-tooltip'
import {
  ArrowLeft,
  Download,
  FileSpreadsheet,
  AlertTriangle,
  CheckCircle2,
  Loader2,
} from 'lucide-react'
import { formatDate } from '@/lib/utils'
import { downloadFile } from '@/lib/browser/download-file'
import { failureDescription } from '@/lib/browser/action-failure'
import type { KassaflodesanalysReport } from '@/lib/reports/kassaflodesanalys'
import {
  getErrorMessage as getUserErrorMessage,
  type ErrorLocale,
} from '@/lib/errors/get-error-message'

function formatAmount(n: number): string {
  return n.toLocaleString('sv-SE', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })
}

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
        throw new Error(body.error || 'Kunde inte hämta kassaflödesanalys')
      }
      const { data } = await res.json()
      setReport(data)
    } catch (err) {
      setError(err instanceof Error ? getUserErrorMessage(err) : 'Okänt fel')
      setReport(null)
    } finally {
      setIsLoadingReport(false)
    }
  }, [])

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

  return (
    <div className="space-y-8">
      <Link
        href="/reports"
        className="inline-flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground transition-colors"
      >
        <ArrowLeft className="h-4 w-4" />
        Rapporter
      </Link>
      <PageHeader title="Kassaflödesanalys" />

      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <FyPicker
          value={selectedPeriod}
          onChange={(id) => setSelectedPeriod(id)}
          includeAllOption={false}
          hideFuturePeriods
          onReady={() => setIsLoadingPeriods(false)}
        />
        <div className="flex gap-2">
          <Button
            variant="outline"
            onClick={handleDownloadPdf}
            disabled={!report || isLoadingReport || isDownloadingPdf}
          >
            {isDownloadingPdf ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <Download className="mr-2 h-4 w-4" />
            )}
            Ladda ner PDF
          </Button>
            <Tooltip>
              <TooltipTrigger asChild>
                <span>
                  <Button variant="outline" disabled>
                    <FileSpreadsheet className="mr-2 h-4 w-4" />
                    Ladda ner Excel
                  </Button>
                </span>
              </TooltipTrigger>
              <TooltipContent>Snart tillgänglig</TooltipContent>
            </Tooltip>
        </div>
      </div>

      <p className="text-sm text-muted-foreground">
        Indirekt metod enligt BFNAR 2012:1 kap 7. Totalsumman ska överensstämma
        med förändringen i likvida medel (kontoklass 19) under perioden.
      </p>

      {isLoadingPeriods ? (
        <div className="space-y-4">
          <Skeleton className="h-48" />
          <Skeleton className="h-32" />
          <Skeleton className="h-32" />
        </div>
      ) : !selectedPeriod ? (
        <EmptyState
          title="Välj räkenskapsår"
          description="Välj ett räkenskapsår ovan för att generera kassaflödesanalys."
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
          <p className="text-sm text-muted-foreground">
            Period: {formatDate(report.period_start)} till {formatDate(report.period_end)}
          </p>

          {/* Section 1: Löpande verksamhet */}
          <Card>
            <CardHeader>
              <h2 className="text-sm uppercase tracking-wider text-muted-foreground">
                Den löpande verksamheten
              </h2>
              <CardTitle className="text-base">
                Kassaflöde från löpande verksamhet
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-1">
              <CashRow
                label="Resultat efter finansiella poster"
                amount={report.lopande.resultat_efter_finansiella_poster}
              />
              <CashRow label="Avskrivningar" amount={report.lopande.avskrivningar} />
              <CashRow
                label="Övriga ej-kassaflödespåverkande poster"
                amount={report.lopande.ovriga_ej_kassaflodesposter}
              />
              <CashRow
                label="Förändring av kortfristiga fordringar"
                amount={report.lopande.delta_kortfristiga_fordringar}
              />
              <CashRow
                label="Förändring av varulager"
                amount={report.lopande.delta_varulager}
              />
              <CashRow
                label="Förändring av kortfristiga skulder"
                amount={report.lopande.delta_kortfristiga_skulder}
              />
              <CashRow label="Betald inkomstskatt" amount={report.lopande.skatt_betald} />
              <SubtotalRow
                label="Summa kassaflöde löpande verksamhet"
                amount={report.lopande.total}
              />
            </CardContent>
          </Card>

          {/* Section 2: Investeringsverksamhet */}
          <Card>
            <CardHeader>
              <h2 className="text-sm uppercase tracking-wider text-muted-foreground">
                Investeringsverksamheten
              </h2>
              <CardTitle className="text-base">
                Kassaflöde från investeringsverksamhet
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-1">
              <CashRow
                label="Förvärv av anläggningstillgångar"
                amount={report.investerings.forvarv_anlaggningar}
              />
              <CashRow
                label="Avyttring av anläggningstillgångar"
                amount={report.investerings.avyttring_anlaggningar}
              />
              <SubtotalRow
                label="Summa kassaflöde investeringsverksamhet"
                amount={report.investerings.total}
              />
            </CardContent>
          </Card>

          {/* Section 3: Finansieringsverksamhet */}
          <Card>
            <CardHeader>
              <h2 className="text-sm uppercase tracking-wider text-muted-foreground">
                Finansieringsverksamheten
              </h2>
              <CardTitle className="text-base">
                Kassaflöde från finansieringsverksamhet
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-1">
              <CashRow
                label="Förändring av lån (långfristiga skulder)"
                amount={report.finansierings.delta_lan}
              />
              <CashRow label="Utdelningar" amount={report.finansierings.utdelningar} />
              <CashRow label="Nyemission" amount={report.finansierings.nyemission} />
              <CashRow
                label="Erhållna aktieägartillskott"
                amount={report.finansierings.erhallna_aktieagartillskott}
              />
              <SubtotalRow
                label="Summa kassaflöde finansieringsverksamhet"
                amount={report.finansierings.total}
              />
            </CardContent>
          </Card>

          {/* Total */}
          <Card>
            <CardContent className="p-6">
              <div className="flex items-center justify-between">
                <span className="font-display text-lg">Årets kassaflöde</span>
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
                  <CheckCircle2 className="h-5 w-5 text-success" />
                ) : (
                  <AlertTriangle className="h-5 w-5 text-destructive" />
                )}
                <span className="font-medium">
                  {report.reconciliation.is_reconciled
                    ? 'Avstämning OK: kassaflödet stämmer med 19xx'
                    : 'Avstämning misslyckades: kontrollera bokföringen'}
                </span>
              </div>
              <div className="space-y-1 text-sm">
                <CashRow
                  label="Ingående saldo (19xx)"
                  amount={report.reconciliation.opening_cash_1xxx}
                />
                <CashRow
                  label="Utgående saldo (19xx)"
                  amount={report.reconciliation.closing_cash_1xxx}
                />
                <CashRow
                  label="Faktisk förändring i likvida medel"
                  amount={report.reconciliation.delta_actual}
                />
                <CashRow
                  label="Beräknad förändring (summa kassaflöden)"
                  amount={report.reconciliation.delta_calculated}
                />
                {!report.reconciliation.is_reconciled && (
                  <div className="flex items-center justify-between border-t border-destructive pt-2 mt-2 text-sm font-medium text-destructive">
                    <span>Avvikelse</span>
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
