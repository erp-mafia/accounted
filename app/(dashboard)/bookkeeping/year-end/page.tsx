'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { useRouter, useSearchParams } from 'next/navigation'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Progress } from '@/components/ui/progress'
import { EmptyState } from '@/components/ui/empty-state'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'
import { ArrowLeft, CalendarPlus, Lock } from 'lucide-react'
import AgentSparkleButton from '@/components/agent/AgentSparkleButton'
import { cn } from '@/lib/utils'
import { useToast } from '@/components/ui/use-toast'
import { getErrorMessage } from '@/lib/errors/get-error-message'
import type { FiscalPeriod, YearEndPreview, YearEndResult } from '@/types'
import type { BokslutReadinessReport } from '@/lib/bokslut/readiness-aggregator'
import { PreflightStep } from '@/components/bookkeeping/year-end/PreflightStep'
import { DispositionsStep } from '@/components/bookkeeping/year-end/DispositionsStep'
import { AccrualsStep } from '@/components/bookkeeping/year-end/AccrualsStep'
import { PreviewStep } from '@/components/bookkeeping/year-end/PreviewStep'
import { ExecuteStep } from '@/components/bookkeeping/year-end/ExecuteStep'
import { ResultStep } from '@/components/bookkeeping/year-end/ResultStep'

type Step = 'preflight' | 'accruals' | 'dispositions' | 'preview' | 'execute' | 'result'

const STEP_ORDER: Step[] = ['preflight', 'accruals', 'dispositions', 'preview', 'execute', 'result']
const STEP_LABELS: Record<Step, string> = {
  preflight: 'Kontroll',
  accruals: 'Periodiseringar',
  dispositions: 'Dispositioner',
  preview: 'Förhandsgranska',
  execute: 'Verkställ',
  result: 'Klart',
}

interface PeriodOption {
  id: string
  name: string
  period_start: string
  period_end: string
}

export default function YearEndPage() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const { toast } = useToast()

  // ---- Period selection ----
  const [periods, setPeriods] = useState<PeriodOption[] | null>(null)
  // Whether the company has ANY fiscal periods (eligible or not) — separates
  // "inget att stänga ännu" from "inget räkenskapsår har skapats".
  const [hasAnyPeriods, setHasAnyPeriods] = useState(true)
  const [periodsError, setPeriodsError] = useState<string | null>(null)
  const [selectedPeriodId, setSelectedPeriodId] = useState<string | null>(
    searchParams.get('period') ?? null,
  )

  // ---- Wizard state ----
  const [step, setStep] = useState<Step>('preflight')
  const [report, setReport] = useState<BokslutReadinessReport | null>(null)
  const [reportLoading, setReportLoading] = useState(false)
  const [reportError, setReportError] = useState<string | null>(null)
  const [preview, setPreview] = useState<YearEndPreview | null>(null)
  const [previewLoading, setPreviewLoading] = useState(false)
  const [previewError, setPreviewError] = useState<string | null>(null)
  const [executing, setExecuting] = useState(false)
  const [executeError, setExecuteError] = useState<string | null>(null)
  const [result, setResult] = useState<YearEndResult | null>(null)

  // ---- Load eligible periods ----
  useEffect(() => {
    let cancelled = false
    const load = async () => {
      try {
        const res = await fetch('/api/bookkeeping/fiscal-periods')
        if (!res.ok) {
          if (!cancelled) setPeriodsError('Kunde inte hämta perioder')
          return
        }
        const { data } = (await res.json()) as { data: FiscalPeriod[] }
        const today = new Date().toISOString().split('T')[0]
        const eligible = (data ?? []).filter(
          (p) => !p.is_closed && !p.closing_entry_id && p.period_end <= today,
        )
        // Oldest first — accountants close in order.
        eligible.sort((a, b) => a.period_start.localeCompare(b.period_start))
        if (cancelled) return
        setPeriods(eligible)
        setHasAnyPeriods((data ?? []).length > 0)
        if (!selectedPeriodId && eligible.length > 0) {
          setSelectedPeriodId(eligible[0].id)
        }
      } catch {
        if (!cancelled) setPeriodsError('Kunde inte hämta perioder')
      }
    }
    void load()
    return () => {
      cancelled = true
    }
  }, [selectedPeriodId])

  // ---- Sync selected period to URL so users can bookmark / share ----
  useEffect(() => {
    if (!selectedPeriodId) return
    const params = new URLSearchParams(searchParams.toString())
    if (params.get('period') === selectedPeriodId) return
    params.set('period', selectedPeriodId)
    router.replace(`/bookkeeping/year-end?${params.toString()}`, { scroll: false })
  }, [selectedPeriodId, router, searchParams])

  // ---- Fetch readiness report whenever selected period changes ----
  useEffect(() => {
    if (!selectedPeriodId) return
    let cancelled = false
    setReportLoading(true)
    setReportError(null)
    setReport(null)
    fetch(`/api/bookkeeping/fiscal-periods/${selectedPeriodId}/bokslut-readiness`)
      .then(async (res) => {
        const body = await res.json()
        if (cancelled) return
        if (!res.ok) {
          setReportError(body?.error?.message ?? 'Kunde inte ladda bokslutskontroll')
          return
        }
        setReport(body.data as BokslutReadinessReport)
      })
      .catch(() => {
        if (!cancelled) setReportError('Kunde inte ladda bokslutskontroll')
      })
      .finally(() => {
        if (!cancelled) setReportLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [selectedPeriodId])

  // ---- Step navigation ----
  const goToPreview = useCallback(async () => {
    if (!selectedPeriodId) return
    setPreviewLoading(true)
    setPreviewError(null)
    setStep('preview')
    try {
      const res = await fetch(`/api/bookkeeping/fiscal-periods/${selectedPeriodId}/year-end`)
      const body = await res.json()
      if (!res.ok) {
        setPreviewError(body?.error?.message ?? 'Kunde inte hämta förhandsgranskning')
        return
      }
      setPreview(body.data.preview as YearEndPreview)
    } catch (err) {
      setPreviewError(getErrorMessage(err))
    } finally {
      setPreviewLoading(false)
    }
  }, [selectedPeriodId])

  const executeYearEnd = useCallback(async () => {
    if (!selectedPeriodId) return
    setExecuting(true)
    setExecuteError(null)
    try {
      const res = await fetch(`/api/bookkeeping/fiscal-periods/${selectedPeriodId}/year-end`, {
        method: 'POST',
      })
      const body = await res.json()
      if (!res.ok) {
        // body.error.message is the localized Swedish message picked by
        // the structured-error registry. Do NOT interpolate raw details
        // here — they can contain DB-sourced strings (V2.3 finding).
        setExecuteError(body?.error?.message ?? 'Bokslutet kunde inte verkställas')
        return
      }
      setResult(body.data as YearEndResult)
      setStep('result')
      toast({
        title: 'Bokslut verkställt',
        description: `${report?.period.name ?? 'Perioden'} är stängd.`,
      })
    } catch (err) {
      setExecuteError(getErrorMessage(err))
    } finally {
      setExecuting(false)
    }
  }, [selectedPeriodId, report?.period.name, toast])

  const currentStepIndex = STEP_ORDER.indexOf(step)
  const progressValue = ((currentStepIndex + 1) / STEP_ORDER.length) * 100

  const showWizard = useMemo(
    () => selectedPeriodId !== null && (periods?.length ?? 0) > 0,
    [selectedPeriodId, periods],
  )

  return (
    <div className="space-y-8">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <h1 className="font-display text-3xl md:text-4xl tracking-tight">Årsbokslut</h1>
        <div className="flex gap-2">
          <AgentSparkleButton
            intentId="bokslut.step"
            intentArgs={{ step_id: null }}
            contextRef="bokslut:overview"
            size="default"
          />
          <Button variant="outline" asChild>
            <Link href="/bookkeeping">
              <ArrowLeft className="mr-2 h-4 w-4" />
              Bokföring
            </Link>
          </Button>
        </div>
      </div>

      {periods === null && !periodsError && (
        <Card>
          <CardContent className="p-6 space-y-2">
            <Skeleton className="h-6 w-1/3" />
            <Skeleton className="h-4 w-full" />
          </CardContent>
        </Card>
      )}

      {periodsError && (
        <Card>
          <CardContent className="p-6 text-destructive">{periodsError}</CardContent>
        </Card>
      )}

      {periods !== null && periods.length === 0 && (
        hasAnyPeriods ? (
          <EmptyState
            icon={Lock}
            title="Inga perioder att stänga"
            description="Det finns ingen öppen räkenskapsperiod vars slutdatum redan har passerat. Bokslut görs efter att periodens slutdatum är passerat."
          />
        ) : (
          <EmptyState
            icon={CalendarPlus}
            title="Inget räkenskapsår ännu"
            description="Bokslut görs per räkenskapsår. Skapa företagets räkenskapsår i bokföringsinställningarna för att komma igång."
            actionLabel="Öppna bokföringsinställningar"
            actionHref="/settings/bookkeeping"
          />
        )
      )}

      {showWizard && periods && periods.length > 1 && step !== 'result' && (
        <Card>
          <CardContent className="p-4 flex items-center gap-4">
            <label className="text-sm font-medium shrink-0">Period</label>
            <Select
              value={selectedPeriodId ?? undefined}
              onValueChange={(value) => {
                setSelectedPeriodId(value)
                setStep('preflight')
                setPreview(null)
                setResult(null)
                setExecuteError(null)
              }}
            >
              <SelectTrigger className="w-full max-w-sm">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {periods.map((p) => (
                  <SelectItem key={p.id} value={p.id}>
                    {p.name} ({p.period_start} – {p.period_end})
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </CardContent>
        </Card>
      )}

      {showWizard && step !== 'result' && (
        <Card>
          <CardContent className="p-4 space-y-2">
            <div className="flex justify-between text-sm">
              <span className="sm:hidden text-primary font-medium">
                Steg {currentStepIndex + 1}/{STEP_ORDER.length}: {STEP_LABELS[step]}
              </span>
              {STEP_ORDER.map((s, i) => (
                <span
                  key={s}
                  className={cn(
                    'hidden sm:inline',
                    i <= currentStepIndex ? 'text-primary font-medium' : 'text-muted-foreground',
                  )}
                >
                  {STEP_LABELS[s]}
                </span>
              ))}
            </div>
            <Progress value={progressValue} className="h-2" />
          </CardContent>
        </Card>
      )}

      {showWizard && step === 'preflight' && (
        <PreflightStep
          report={report}
          isLoading={reportLoading}
          error={reportError}
          onContinue={() => setStep('accruals')}
        />
      )}

      {showWizard && step === 'accruals' && selectedPeriodId && (
        <AccrualsStep
          periodId={selectedPeriodId}
          onBack={() => setStep('preflight')}
          onContinue={() => setStep('dispositions')}
        />
      )}

      {showWizard && step === 'dispositions' && selectedPeriodId && (
        <DispositionsStep
          periodId={selectedPeriodId}
          onBack={() => setStep('accruals')}
          onContinue={goToPreview}
        />
      )}

      {showWizard && step === 'preview' && (
        <PreviewStep
          preview={preview}
          isLoading={previewLoading}
          error={previewError}
          onBack={() => setStep('dispositions')}
          onContinue={() => setStep('execute')}
        />
      )}

      {showWizard && step === 'execute' && report && (
        <ExecuteStep
          periodName={report.period.name}
          isRunning={executing}
          error={executeError}
          onBack={() => setStep('preview')}
          onExecute={executeYearEnd}
        />
      )}

      {step === 'result' && result && <ResultStep result={result} />}
    </div>
  )
}
