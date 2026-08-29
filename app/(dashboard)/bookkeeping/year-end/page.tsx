'use client'

import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { useFiscalPeriods } from '@/lib/reference-data/hooks'
import { invalidateReferenceData } from '@/lib/reference-data/invalidate'
import { useRouter, useSearchParams } from 'next/navigation'
import { Card, CardContent } from '@/components/ui/card'
import { EmptyState } from '@/components/ui/empty-state'
import { AttnLine } from '@/components/ui/attn-line'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { ContextPicker } from '@/components/common/ContextPicker'
import { Skeleton } from '@/components/ui/skeleton'
import { CalendarPlus, Check, Lock } from 'lucide-react'
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
  /**
   * True when the period can actually be closed here (open, ended, no closing
   * entry). The dropdown can also hold a known-but-ineligible period from the
   * URL; the klarmarkera affordance must not render for that one.
   */
  eligible: boolean
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
  const [navigationBlocked, setNavigationBlocked] = useState(false)

  // ---- Eligible periods, from the session-cached list (lib/reference-data) ----
  // Recomputed whenever the cached list changes: the close actions below
  // invalidate it, which is what drops a just-closed year out of the picker.
  const { periods: allPeriods, isLoading: periodsLoading, error: periodsFetchError } = useFiscalPeriods()
  useEffect(() => {
    if (periodsLoading) return
    if (periodsFetchError) {
      setPeriodsError('Kunde inte hämta perioder')
      return
    }
    const all: FiscalPeriod[] = allPeriods
    const today = new Date().toISOString().split('T')[0]
    const eligible: PeriodOption[] = all
      .filter((p) => !p.is_closed && !p.closing_entry_id && p.period_end <= today)
      .map((p) => ({ ...p, eligible: true }))
    // Oldest first: accountants close in order.
    eligible.sort((a, b) => a.period_start.localeCompare(b.period_start))
    setHasAnyPeriods(all.length > 0)

    // The URL ?period= param may point anywhere: at an ineligible period
    // (e.g. a year that has not ended) or, after a company switch, at a
    // period that does not exist in this company at all. An unknown id is
    // reset to the first eligible period; a known-but-ineligible one is
    // kept selectable in the dropdown so the user can navigate away from
    // it instead of being stuck (the readiness step explains why it
    // cannot be closed).
    let options = eligible
    if (selectedPeriodId) {
      const known = all.find((p) => p.id === selectedPeriodId)
      if (!known) {
        setSelectedPeriodId(eligible.length > 0 ? eligible[0].id : null)
      } else if (!eligible.some((p) => p.id === selectedPeriodId)) {
        options = [...eligible, { ...known, eligible: false }].sort((a, b) =>
          a.period_start.localeCompare(b.period_start),
        )
      }
    } else if (eligible.length > 0) {
      setSelectedPeriodId(eligible[0].id)
    }
    setPeriods(options)
  }, [selectedPeriodId, allPeriods, periodsLoading, periodsFetchError])

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
          setReportError(getErrorMessage(body?.error) ?? 'Kunde inte ladda bokslutskontroll')
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
        setPreviewError(getErrorMessage(body?.error) ?? 'Kunde inte hämta förhandsgranskning')
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
        // here: they can contain DB-sourced strings (V2.3 finding).
        setExecuteError(getErrorMessage(body?.error) ?? 'Bokslutet kunde inte verkställas')
        return
      }
      setResult(body.data as YearEndResult)
      setStep('result')
      // The period is now closed: every picker and form reads the cached list.
      void invalidateReferenceData('ref:fiscal-periods')
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

  const showWizard = useMemo(
    () => selectedPeriodId !== null && (periods?.length ?? 0) > 0,
    [selectedPeriodId, periods],
  )

  // ---- Klarmarkera: year already closed in a previous bookkeeping system ----
  // Imported historical years (SIE) land here as "pending bokslut" even though
  // the bokslut was done in the old software. The confirm dialog POSTs
  // close-external, which closes + locks the period without a closing entry.
  const [confirmExternalOpen, setConfirmExternalOpen] = useState(false)
  const selectedOption = periods?.find((p) => p.id === selectedPeriodId) ?? null

  const markClosedExternally = useCallback(async () => {
    if (!selectedPeriodId) return
    try {
      const res = await fetch(
        `/api/bookkeeping/fiscal-periods/${selectedPeriodId}/close-external`,
        { method: 'POST' },
      )
      const body = await res.json()
      if (!res.ok) {
        toast({
          title: 'Kunde inte klarmarkera perioden',
          description: getErrorMessage(body?.error),
          variant: 'destructive',
        })
        return
      }
      toast({
        title: 'Perioden klarmarkerad',
        description: `${selectedOption?.name ?? 'Perioden'} är nu markerad som avslutad i tidigare program.`,
      })
      // Drop back to "no selection" and refresh the cached list: the effect
      // above picks the next eligible period (the marked one no longer
      // qualifies).
      setPeriods(null)
      setSelectedPeriodId(null)
      setStep('preflight')
      await invalidateReferenceData('ref:fiscal-periods')
    } catch (err) {
      toast({
        title: 'Kunde inte klarmarkera perioden',
        description: getErrorMessage(err),
        variant: 'destructive',
      })
    }
  }, [selectedPeriodId, selectedOption?.name, toast])

  return (
    <div className="space-y-8">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <h1 className="font-display text-2xl leading-8 tracking-tight">Årsbokslut</h1>
        <div className="flex items-center gap-2">
          {showWizard && periods && periods.length > 0 && step !== 'result' && (
            <ContextPicker
              items={periods.map((p) => ({
                id: p.id,
                label: p.name,
                annotation: `${p.period_start} till ${p.period_end}`,
              }))}
              value={selectedPeriodId}
              disabled={navigationBlocked}
              onChange={(value) => {
                setSelectedPeriodId(value)
                setStep('preflight')
                setPreview(null)
                setResult(null)
                setExecuteError(null)
              }}
              triggerLabel={
                periods.find((p) => p.id === selectedPeriodId)?.name ?? 'Välj period'
              }
              ariaLabel="Period"
            />
          )}
        </div>
      </div>

      {showWizard && step === 'preflight' && selectedOption?.eligible && !navigationBlocked && (
        <AttnLine
          action={{ label: 'Klarmarkera perioden', onClick: () => setConfirmExternalOpen(true) }}
        >
          Är bokslutet för {selectedOption.name} redan gjort i ett tidigare bokföringsprogram?
        </AttnLine>
      )}

      <ConfirmDialog
        open={confirmExternalOpen}
        onOpenChange={setConfirmExternalOpen}
        title="Klarmarkera perioden?"
        description={
          <>
            {selectedOption?.name ?? 'Perioden'} markeras som avslutad i ett tidigare
            bokföringsprogram. Perioden stängs och låses: inga nya verifikat kan bokföras i den,
            och inget bokslutsverifikat skapas här eftersom bokslutet redan finns i det gamla
            programmet. Rapporter som bygger på periodens bokslut (t.ex. jämförelseår i nästa
            årsredovisning och INK2 för perioden) kan sakna uppgifter och behöver i så fall
            hämtas från det tidigare programmet. Åtgärden loggas i behandlingshistoriken.
          </>
        }
        confirmLabel="Klarmarkera"
        onConfirm={markClosedExternally}
      />

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

      {/* Stegen (concept scene 34): dots walk check -> filled -> number.
          Steps behind the current one are clickable for going back; forward
          navigation stays with each step's own continue action. */}
      {showWizard && step !== 'result' && (
        <div
          className="mx-auto flex w-full max-w-4xl items-center gap-3 overflow-x-auto px-1"
          role="tablist"
          aria-label="Bokslutets steg"
        >
          {STEP_ORDER.map((s, i) => (
            <React.Fragment key={s}>
              {i > 0 && <span className="h-px min-w-4 flex-1 bg-border" aria-hidden="true" />}
              <button
                type="button"
                role="tab"
                aria-selected={s === step}
                disabled={navigationBlocked || i >= currentStepIndex}
                onClick={() => {
                  if (!navigationBlocked && i < currentStepIndex) setStep(s)
                }}
                className={cn(
                  'group flex shrink-0 items-center gap-2 text-left',
                  (navigationBlocked || i >= currentStepIndex) && 'cursor-default',
                )}
              >
                <span
                  className={cn(
                    'flex h-7 w-7 shrink-0 items-center justify-center rounded-full border text-xs tabular-nums transition-colors duration-150',
                    i < currentStepIndex
                      ? 'border-success/40 text-success'
                      : s === step
                        ? 'border-foreground bg-foreground text-background'
                        : 'border-border text-muted-foreground',
                  )}
                >
                  {i < currentStepIndex ? <Check className="h-3.5 w-3.5" aria-hidden="true" /> : i + 1}
                </span>
                <span
                  className={cn(
                    'text-[12.5px] transition-colors duration-150',
                    s === step
                      ? 'font-medium'
                      : i < currentStepIndex
                        ? 'text-muted-foreground group-hover:text-foreground'
                        : 'text-muted-foreground',
                  )}
                >
                  {STEP_LABELS[s]}
                </span>
              </button>
            </React.Fragment>
          ))}
        </div>
      )}

      {showWizard && step === 'preflight' && (
        <div className="mx-auto w-full max-w-3xl"><PreflightStep
          report={report}
          isLoading={reportLoading}
          error={reportError}
          onContinue={() => setStep('accruals')}
        /></div>
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
          onNavigationBlockedChange={setNavigationBlocked}
        />
      )}

      {showWizard && step === 'preview' && (
        <div className="mx-auto w-full max-w-3xl"><PreviewStep
          preview={preview}
          isLoading={previewLoading}
          error={previewError}
          onBack={() => setStep('dispositions')}
          onContinue={() => setStep('execute')}
        /></div>
      )}

      {showWizard && step === 'execute' && report && (
        <div className="mx-auto w-full max-w-3xl"><ExecuteStep
          periodName={report.period.name}
          isRunning={executing}
          error={executeError}
          bolagsskattMissing={preview?.bolagsskattMissing ?? false}
          onBack={() => setStep('preview')}
          onExecute={executeYearEnd}
        /></div>
      )}

      {step === 'result' && result && (
        <div className="mx-auto w-full max-w-3xl"><ResultStep result={result} /></div>
      )}
    </div>
  )
}
