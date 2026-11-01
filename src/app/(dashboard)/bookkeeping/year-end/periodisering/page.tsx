'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useFiscalPeriods } from '@/lib/reference-data/hooks'
import Link from 'next/link'
import { useSearchParams } from 'next/navigation'
import { ArrowLeftIcon, ArrowRightIcon, LockClosedIcon } from '@/components/icons'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Progress } from '@/components/ui/progress'
import { Skeleton } from '@/components/ui/skeleton'
import { PageHeader } from '@/components/ui/page-header'
import { EmptyState } from '@/components/ui/empty-state'
import { useToast } from '@/components/ui/use-toast'
import { useCanWrite } from '@/lib/hooks/use-can-write'
import { useCompany } from '@/contexts/CompanyContext'
import { cn, formatCurrency } from '@/lib/utils'
import {
  buildAccrualItems,
  manualEntryToItem,
  templateOf,
  type AuditFeeState,
  type ManualAccrualEntry,
} from '@/lib/bokslut/accruals/manual-items'
import { ManualAccrualsEditor } from '@/components/bookkeeping/year-end/ManualAccrualsEditor'
import { parseAmountInput } from '@/lib/money'
import type { AccrualsProposal } from '@/lib/bokslut/accruals/types'
import type {
  PeriodiseringSuggestion,
  PeriodiseringConfidence,
} from '@/lib/bokslut/accruals/auto-detect'
import { getErrorMessage as getUserErrorMessage } from '@/lib/errors/get-error-message'
import { hasEnded, todayIsoStockholm } from '@/lib/dates/iso'

type Step = 'vacation' | 'audit' | 'auto' | 'manual' | 'review'

const STEP_ORDER: Step[] = ['vacation', 'audit', 'auto', 'manual', 'review']

/** An enskild firma has no revisor, so its step 2 is the bokslutsarvode. */
function stepLabels(isEnskildFirma: boolean): Record<Step, string> {
  return {
    vacation: 'Semester',
    audit: isEnskildFirma ? 'Bokslutsarvode' : 'Revisionsarvode',
    auto: 'Auto-detektering',
    manual: 'Manuella tillägg',
    review: 'Granska & posta',
  }
}

interface PeriodOption {
  id: string
  name: string
  period_start: string
  period_end: string
}

type ProposalResponse = AccrualsProposal & { autoDetected: PeriodiseringSuggestion[] }

interface AutoState {
  /** key = source_invoice_id + '|' + source_type, value = accepted */
  selections: Record<string, boolean>
}

function suggestionKey(s: PeriodiseringSuggestion): string {
  return `${s.source_invoice_id}|${s.source_type}`
}

// High confidence is the normal case and renders as muted text, not a chip.
function confidenceVariant(c: PeriodiseringConfidence): 'secondary' | 'outline' {
  if (c === 'medium') return 'secondary'
  return 'outline'
}

function confidenceLabel(c: PeriodiseringConfidence): string {
  if (c === 'high') return 'Hög säkerhet'
  if (c === 'medium') return 'Medel säkerhet'
  return 'Låg säkerhet'
}

export default function PeriodiseringWizardPage() {
  const searchParams = useSearchParams()
  const { toast } = useToast()
  const { canWrite } = useCanWrite()
  const { company } = useCompany()
  // Entity-aware copy: an enskild firma has no revision and normally closes
  // under K1 (BFNAR 2006:1, förenklat årsbokslut). entity_type is a proxy:
  // no stored flag distinguishes förenklat from full årsbokslut, so all
  // K1 wording stays advisory ("behöver normalt inte").
  const isEF = company?.entity_type === 'enskild_firma'

  const [periods, setPeriods] = useState<PeriodOption[] | null>(null)
  const [periodsError, setPeriodsError] = useState<string | null>(null)
  const [selectedPeriodId, setSelectedPeriodId] = useState<string | null>(
    searchParams.get('period') ?? null,
  )

  const [step, setStep] = useState<Step>('vacation')
  const [proposal, setProposal] = useState<ProposalResponse | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  const [vacationAccepted, setVacationAccepted] = useState(true)
  const [auditState, setAuditState] = useState<AuditFeeState>({
    enabled: false,
    amount: '',
    liabilityAccount: '2992',
  })

  // Default the liability account per entity: 2991 (bokslut) for enskild
  // firma, 2992 (revision) for aktiebolag. The company row loads async, so
  // adjust once it arrives, but never override a state the user has touched.
  useEffect(() => {
    if (!isEF) return
    setAuditState((prev) =>
      prev.enabled || prev.amount !== '' ? prev : { ...prev, liabilityAccount: '2991' },
    )
  }, [isEF])
  const [autoState, setAutoState] = useState<AutoState>({ selections: {} })
  const [manualEntries, setManualEntries] = useState<ManualAccrualEntry[]>([])

  const [posting, setPosting] = useState(false)
  const [postError, setPostError] = useState<string | null>(null)
  const [postSummary, setPostSummary] = useState<{ created: number; skipped: number } | null>(null)

  // ---- Eligible periods, from the session-cached list (lib/reference-data) ----
  const { periods: allPeriods, isLoading: periodsLoading, error: periodsFetchError } = useFiscalPeriods()
  useEffect(() => {
    if (periodsLoading) return
    if (periodsFetchError) {
      setPeriodsError('Kunde inte hämta perioder')
      return
    }
    const today = todayIsoStockholm()
    const eligible = allPeriods.filter(
      (p) => !p.is_closed && !p.closing_entry_id && hasEnded(p.period_end, today),
    )
    eligible.sort((a, b) => a.period_start.localeCompare(b.period_start))
    setPeriods(eligible)
    if (!selectedPeriodId && eligible.length > 0) {
      setSelectedPeriodId(eligible[0].id)
    }
  }, [selectedPeriodId, allPeriods, periodsLoading, periodsFetchError])

  // ---- Fetch accruals snapshot once period chosen ----
  useEffect(() => {
    if (!selectedPeriodId) return
    let cancelled = false
    setLoading(true)
    setLoadError(null)
    setProposal(null)
    fetch(`/api/bookkeeping/fiscal-periods/${selectedPeriodId}/accruals`)
      .then(async (res) => {
        const body = await res.json()
        if (cancelled) return
        if (!res.ok) {
          setLoadError(getUserErrorMessage(body?.error) ?? 'Kunde inte ladda periodiseringar')
          return
        }
        const data = body.data as ProposalResponse
        setProposal(data)
        // Default-check all high-confidence suggestions.
        const initial: Record<string, boolean> = {}
        for (const s of data.autoDetected ?? []) {
          initial[suggestionKey(s)] = s.confidence === 'high'
        }
        setAutoState({ selections: initial })
      })
      .catch(() => {
        if (!cancelled) setLoadError('Kunde inte ladda periodiseringar')
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [selectedPeriodId])

  const vacationProposal = useMemo(
    () => proposal?.proposals.find((p) => p.kind === 'vacation_liability_change') ?? null,
    [proposal],
  )
  const notices = useMemo(() => proposal?.notices ?? [], [proposal])

  const currentStepIndex = STEP_ORDER.indexOf(step)
  const labels = stepLabels(isEF)
  const progressValue = ((currentStepIndex + 1) / STEP_ORDER.length) * 100
  const showWizard = selectedPeriodId !== null && (periods?.length ?? 0) > 0 && !loading && !loadError

  // ---- Final post ----
  const handlePost = useCallback(async () => {
    if (!selectedPeriodId) return
    setPosting(true)
    setPostError(null)
    try {
      // The vacation change, the fee and the manual entries through the one
      // builder the bokslut wizard uses too (lib/bokslut/accruals/manual-items).
      const shared = buildAccrualItems({
        vacation: !!vacationProposal && vacationAccepted,
        auditFee: auditState,
        manual: [],
      })
      const items: unknown[] = [...shared]
      for (const s of proposal?.autoDetected ?? []) {
        if (!autoState.selections[suggestionKey(s)]) continue
        if (s.source_type === 'supplier_invoice') {
          items.push({
            kind: 'manual_prepaid_expense',
            amount: s.periodisering_amount,
            expense_account: '5800', // safe fallback; user can override in manual list
            prepaid_account: s.suggested_prepaid_account ?? '1710',
            description: s.source_label,
          })
        } else {
          items.push({
            kind: 'deferred_revenue',
            amount: s.periodisering_amount,
            revenue_account: '3001',
            deferred_account: s.suggested_deferred_account ?? '2970',
            description: s.source_label,
          })
        }
      }
      for (const m of manualEntries) {
        const item = manualEntryToItem(m)
        if (item) items.push(item)
      }

      if (items.length === 0) {
        toast({
          title: 'Inga periodiseringar att bokföra',
          description: 'Markera minst en post innan du postar.',
        })
        return
      }

      const res = await fetch(`/api/bookkeeping/fiscal-periods/${selectedPeriodId}/accruals`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ items }),
      })
      const body = await res.json()
      if (!res.ok) {
        setPostError(getUserErrorMessage(body?.error) ?? 'Kunde inte bokföra periodiseringarna')
        return
      }
      const created = body.data?.created?.length ?? 0
      const skipped = body.data?.skipped?.length ?? 0
      setPostSummary({ created, skipped })
      toast({
        title: `${created} verifikation${created === 1 ? '' : 'er'} bokförd${created === 1 ? '' : 'a'}`,
        description: skipped > 0 ? `${skipped} hoppades över (redan postade).` : undefined,
      })
    } catch (err) {
      setPostError(err instanceof Error ? getUserErrorMessage(err) : 'Okänt fel')
    } finally {
      setPosting(false)
    }
  }, [
    selectedPeriodId,
    vacationProposal,
    vacationAccepted,
    auditState,
    autoState,
    manualEntries,
    proposal,
    toast,
  ])

  const closingYear = useMemo(() => {
    if (!proposal) return null
    return proposal.fiscalPeriod.period_end.slice(0, 4)
  }, [proposal])

  return (
    <div className="space-y-8">
      <PageHeader
        title={closingYear ? `Periodisering: Bokslut ${closingYear}` : 'Periodisering'}
        action={
          <Button size="sm" variant="outline" asChild>
            <Link href="/bookkeeping/year-end">
              <ArrowLeftIcon className="mr-2 h-4 w-4" /> Tillbaka till bokslut
            </Link>
          </Button>
        }
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
        <EmptyState
          icon={LockClosedIcon}
          title="Inga perioder att periodisera"
          description="Periodiseringar görs efter att räkenskapsperiodens slutdatum har passerat. Det finns ingen sådan öppen period."
        />
      )}

      {loadError && (
        <Card>
          <CardContent className="p-6 text-destructive">{loadError}</CardContent>
        </Card>
      )}

      {loading && (
        <Card>
          <CardContent className="p-6 space-y-2">
            <Skeleton className="h-6 w-1/3" />
            <Skeleton className="h-20 w-full" />
          </CardContent>
        </Card>
      )}

      {showWizard && proposal && (
        <>
          <Card>
            <CardContent className="p-4 space-y-2">
              <div className="flex justify-between text-sm">
                <span className="sm:hidden text-primary font-medium">
                  Steg {currentStepIndex + 1}/{STEP_ORDER.length}: {labels[step]}
                </span>
                {STEP_ORDER.map((s, i) => (
                  <span
                    key={s}
                    className={cn(
                      'hidden sm:inline',
                      i <= currentStepIndex ? 'text-primary font-medium' : 'text-muted-foreground',
                    )}
                  >
                    {labels[s]}
                  </span>
                ))}
              </div>
              <Progress value={progressValue} className="h-2" />
            </CardContent>
          </Card>

          {step === 'vacation' && (
            <VacationStep
              proposal={vacationProposal}
              notices={notices}
              accepted={vacationAccepted}
              onChange={setVacationAccepted}
              onNext={() => setStep('audit')}
            />
          )}
          {step === 'audit' && (
            <AuditStep
              isEF={isEF}
              state={auditState}
              onChange={setAuditState}
              onBack={() => setStep('vacation')}
              onNext={() => setStep('auto')}
            />
          )}
          {step === 'auto' && (
            <AutoStep
              isEF={isEF}
              suggestions={proposal.autoDetected ?? []}
              selections={autoState.selections}
              onToggle={(key, val) =>
                setAutoState({ selections: { ...autoState.selections, [key]: val } })
              }
              onBack={() => setStep('audit')}
              onNext={() => setStep('manual')}
            />
          )}
          {step === 'manual' && (
            <ManualStep
              entries={manualEntries}
              onChange={setManualEntries}
              onBack={() => setStep('auto')}
              onNext={() => setStep('review')}
            />
          )}
          {step === 'review' && (
            <ReviewStep
              vacationProposal={vacationProposal}
              vacationAccepted={vacationAccepted}
              auditState={auditState}
              suggestions={proposal.autoDetected ?? []}
              selections={autoState.selections}
              manualEntries={manualEntries}
              postError={postError}
              postSummary={postSummary}
              posting={posting}
              canWrite={canWrite}
              onBack={() => setStep('manual')}
              onPost={handlePost}
            />
          )}
        </>
      )}
    </div>
  )
}

// ============================================================
// Step components
// ============================================================

function VacationStep({
  proposal,
  notices,
  accepted,
  onChange,
  onNext,
}: {
  proposal: AccrualsProposal['proposals'][number] | null
  notices: string[]
  accepted: boolean
  onChange: (v: boolean) => void
  onNext: () => void
}) {
  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Steg 1: Semesterlöneskuld</CardTitle>
          <p className="text-sm text-muted-foreground">
            Justering av 2920 mot 7090 plus 31,42 % sociala avgifter (2940 / 7519).
            Saldot rullas vidare till nästa år.
          </p>
        </CardHeader>
        <CardContent>
          {proposal ? (
            <div className="flex items-start justify-between gap-4 rounded-lg border border-border p-4">
              <div className="flex-1 space-y-2">
                <p className="text-sm font-medium">{proposal.label}</p>
                <p className="text-xs text-muted-foreground">{proposal.description}</p>
                <div className="flex items-center gap-2 pt-1">
                  <Checkbox
                    id="accept-vacation"
                    checked={accepted}
                    onCheckedChange={(c) => onChange(Boolean(c))}
                  />
                  <Label htmlFor="accept-vacation" className="text-sm cursor-pointer select-none">
                    Boka denna justering
                  </Label>
                </div>
              </div>
              <p className="font-display text-2xl tabular-nums shrink-0">
                {formatCurrency(proposal.amount)}
              </p>
            </div>
          ) : notices.length > 0 ? (
            <div className="space-y-2">
              {notices.map((notice) => (
                <p key={notice} className="text-sm text-muted-foreground">
                  {notice}
                </p>
              ))}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground italic">
              Ingen justering behövs: semesterlöneskulden ligger redan rätt.
            </p>
          )}
        </CardContent>
      </Card>
      <div className="flex justify-end">
        <Button onClick={onNext}>
          Nästa <ArrowRightIcon className="ml-1 h-4 w-4" />
        </Button>
      </div>
    </div>
  )
}

function AuditStep({
  isEF,
  state,
  onChange,
  onBack,
  onNext,
}: {
  isEF: boolean
  state: AuditFeeState
  onChange: (s: AuditFeeState) => void
  onBack: () => void
  onNext: () => void
}) {
  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">
            {isEF ? 'Steg 2: Bokslutsarvode' : 'Steg 2: Revisions- / bokslutsarvode'}
          </CardTitle>
          <p className="text-sm text-muted-foreground">
            {isEF
              ? 'Periodisera arvode för bokslut (2991). Posten vänds första dagen i nästa räkenskapsår när fakturan kommer.'
              : 'Periodisera arvode för revision (2992) eller bokslut (2991). Posten vänds första dagen i nästa räkenskapsår när fakturan kommer.'}
          </p>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center gap-2">
            <Checkbox
              id="audit-enabled"
              checked={state.enabled}
              onCheckedChange={(c) => onChange({ ...state, enabled: Boolean(c) })}
            />
            <Label htmlFor="audit-enabled" className="text-sm cursor-pointer select-none">
              Periodisera arvode för detta bokslut
            </Label>
          </div>
          {state.enabled && (
            <div className="grid grid-cols-2 gap-4 rounded-lg border border-border p-4">
              <div className="space-y-1">
                <Label className="text-xs">Belopp (kr)</Label>
                <Input
                  type="number"
                  step="1"
                  min="0"
                  value={state.amount}
                  onChange={(e) => onChange({ ...state, amount: e.target.value })}
                  className="tabular-nums h-9"
                />
              </div>
              <div className="space-y-1">
                <Label className="text-xs">Konto</Label>
                <select
                  className="border border-border rounded-lg h-9 text-sm px-2 w-full bg-background"
                  value={state.liabilityAccount}
                  onChange={(e) =>
                    onChange({ ...state, liabilityAccount: e.target.value as '2991' | '2992' })
                  }
                >
                  <option value="2992">2992: Revision</option>
                  <option value="2991">2991: Bokslut</option>
                </select>
              </div>
            </div>
          )}
        </CardContent>
      </Card>
      <div className="flex justify-between">
        <Button variant="outline" onClick={onBack}>
          Tillbaka
        </Button>
        <Button onClick={onNext}>
          Nästa <ArrowRightIcon className="ml-1 h-4 w-4" />
        </Button>
      </div>
    </div>
  )
}

function AutoStep({
  isEF,
  suggestions,
  selections,
  onToggle,
  onBack,
  onNext,
}: {
  isEF: boolean
  suggestions: PeriodiseringSuggestion[]
  selections: Record<string, boolean>
  onToggle: (key: string, val: boolean) => void
  onBack: () => void
  onNext: () => void
}) {
  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Steg 3: Auto-detekterade periodiseringar</CardTitle>
          <p className="text-sm text-muted-foreground">
            Fakturor (kund och leverantör) i den stängda perioden vars beskrivning
            innehåller en datumintervall som sträcker sig in i nästa räkenskapsår.
            Granska och bekräfta: högst säkra förslag är förvalda.
          </p>
          {isEF && (
            <p className="text-xs text-muted-foreground">
              Enskild firma med förenklat årsbokslut (K1) behöver normalt inte
              periodisera poster under 5 000 kr. Förslag under gränsen är avmarkerade.
            </p>
          )}
        </CardHeader>
        <CardContent className="space-y-3">
          {suggestions.length === 0 && (
            <p className="text-sm text-muted-foreground italic">
              Inga fakturor med tydlig datumintervall hittades. Du kan ändå lägga
              till manuella periodiseringar i nästa steg.
            </p>
          )}
          {suggestions.map((s) => {
            const key = suggestionKey(s)
            return (
              <div
                key={key}
                className="flex items-start gap-3 rounded-lg border border-border p-3"
              >
                <Checkbox
                  id={`auto-${key}`}
                  checked={!!selections[key]}
                  onCheckedChange={(c) => onToggle(key, Boolean(c))}
                  className="mt-1"
                />
                <div className="flex-1 space-y-1.5">
                  <div className="flex items-center justify-between gap-2">
                    {/* data-ph-mask: source_label is counterparty name + invoice number */}
                    <Label
                      data-ph-mask=""
                      htmlFor={`auto-${key}`}
                      className="text-sm font-medium cursor-pointer select-none"
                    >
                      {s.source_label}
                    </Label>
                    {s.confidence === 'high' ? (
                      <span className="text-xs text-muted-foreground">{confidenceLabel(s.confidence)}</span>
                    ) : (
                      <Badge variant={confidenceVariant(s.confidence)}>
                        {confidenceLabel(s.confidence)}
                      </Badge>
                    )}
                  </div>
                  <p className="text-xs text-muted-foreground">{s.reason}</p>
                  <div className="flex items-center gap-4 pt-1 text-xs">
                    <span className="text-muted-foreground">
                      {s.source_type === 'supplier_invoice'
                        ? 'Förutbetald kostnad → 1710'
                        : 'Förutbetald intäkt → 2970'}
                    </span>
                    <span className="ml-auto font-display tabular-nums text-base">
                      {formatCurrency(s.periodisering_amount)}
                    </span>
                  </div>
                </div>
              </div>
            )
          })}
        </CardContent>
      </Card>
      <div className="flex justify-between">
        <Button variant="outline" onClick={onBack}>
          Tillbaka
        </Button>
        <Button onClick={onNext}>
          Nästa <ArrowRightIcon className="ml-1 h-4 w-4" />
        </Button>
      </div>
    </div>
  )
}

function ManualStep({
  entries,
  onChange,
  onBack,
  onNext,
}: {
  entries: ManualAccrualEntry[]
  onChange: (entries: ManualAccrualEntry[]) => void
  onBack: () => void
  onNext: () => void
}) {
  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Steg 4: Manuella periodiseringar</CardTitle>
          <p className="text-sm text-muted-foreground">
            Använd mallarna nedan för vanliga fall, eller hoppa direkt till granskning.
          </p>
        </CardHeader>
        <CardContent>
          <ManualAccrualsEditor entries={entries} onChange={onChange} />
        </CardContent>
      </Card>
      <div className="flex justify-between">
        <Button variant="outline" onClick={onBack}>
          Tillbaka
        </Button>
        <Button onClick={onNext}>
          Granska <ArrowRightIcon className="ml-1 h-4 w-4" />
        </Button>
      </div>
    </div>
  )
}

function ReviewStep({
  vacationProposal,
  vacationAccepted,
  auditState,
  suggestions,
  selections,
  manualEntries,
  postError,
  postSummary,
  posting,
  canWrite,
  onBack,
  onPost,
}: {
  vacationProposal: AccrualsProposal['proposals'][number] | null
  vacationAccepted: boolean
  auditState: AuditFeeState
  suggestions: PeriodiseringSuggestion[]
  selections: Record<string, boolean>
  manualEntries: ManualAccrualEntry[]
  postError: string | null
  postSummary: { created: number; skipped: number } | null
  posting: boolean
  canWrite: boolean
  onBack: () => void
  onPost: () => void
}) {
  const auditAmount = parseAmountInput(auditState.amount) ?? NaN
  const auditValid = auditState.enabled && Number.isFinite(auditAmount) && auditAmount > 0
  const selectedSuggestions = suggestions.filter((s) => selections[suggestionKey(s)])
  // What the post will book: the entries the shared builder takes.
  const validManual = manualEntries.filter((m) => manualEntryToItem(m) !== null)

  const totalCount =
    (vacationProposal && vacationAccepted ? 1 : 0) +
    (auditValid ? 1 : 0) +
    selectedSuggestions.length +
    validManual.length

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Steg 5: Granska & posta</CardTitle>
          <p className="text-sm text-muted-foreground">
            {totalCount === 0
              ? 'Inga periodiseringar valda. Gå tillbaka och välj minst en.'
              : `${totalCount} periodisering${totalCount === 1 ? '' : 'ar'} kommer att bokföras som separata verifikationer.`}
          </p>
        </CardHeader>
        <CardContent className="space-y-3">
          {vacationProposal && vacationAccepted && (
            <ReviewLine label={vacationProposal.label} amount={vacationProposal.amount} note="Rullas vidare" />
          )}
          {auditValid && (
            <ReviewLine
              label={
                auditState.liabilityAccount === '2991'
                  ? 'Beräknat arvode för bokslut'
                  : 'Beräknat arvode för revision'
              }
              amount={auditAmount}
              note="Vänds 1 januari"
            />
          )}
          {selectedSuggestions.map((s) => (
            <ReviewLine
              key={suggestionKey(s)}
              label={`Auto: ${s.source_label}`}
              amount={s.periodisering_amount}
              note={s.source_type === 'supplier_invoice' ? 'Förutbetald kostnad' : 'Förutbetald intäkt'}
            />
          ))}
          {validManual.map((m) => {
            const tpl = templateOf(m.templateKind)
            // The tags the result leg will carry, e.g. "KS01 · P001".
            const dims = Object.entries(m.dimensions ?? {})
              .filter(([, v]) => v)
              .sort(([a], [b]) => Number(a) - Number(b))
              .map(([, v]) => v)
              .join(' · ')
            return (
              <ReviewLine
                key={m.id}
                label={`${tpl?.name ?? 'Periodisering'}: ${m.description}`}
                amount={parseAmountInput(m.amount) ?? 0}
                note={[tpl?.name, dims].filter(Boolean).join(' · ')}
              />
            )
          })}
        </CardContent>
      </Card>

      {postError && (
        <Card>
          <CardContent className="p-4 text-sm text-destructive">{postError}</CardContent>
        </Card>
      )}

      {postSummary && (
        <Card>
          <CardContent className="p-4 text-sm">
            {postSummary.created} verifikation{postSummary.created === 1 ? '' : 'er'} bokförd
            {postSummary.created === 1 ? '' : 'a'}.
            {postSummary.skipped > 0 && ` ${postSummary.skipped} hoppades över (redan postade).`}
          </CardContent>
        </Card>
      )}

      <div className="flex justify-between">
        <Button variant="outline" onClick={onBack} disabled={posting}>
          Tillbaka
        </Button>
        <Button
          onClick={onPost}
          disabled={!canWrite || totalCount === 0 || postSummary !== null}
          loading={canWrite && posting}
          title={!canWrite ? 'Endast användare med skrivrättigheter kan posta periodiseringar.' : undefined}
        >
          {!canWrite ? (
            <>
              <LockClosedIcon className="mr-2 h-4 w-4" /> Posta alla
            </>
          ) : posting ? (
            'Bokför…'
          ) : (
            'Posta alla'
          )}
        </Button>
      </div>
    </div>
  )
}

function ReviewLine({ label, amount, note }: { label: string; amount: number; note?: string }) {
  return (
    <div className="flex items-center justify-between gap-4 rounded-lg border border-border px-3 py-2">
      <div className="min-w-0">
        <p className="text-sm font-medium truncate">{label}</p>
        {note && <p className="text-xs text-muted-foreground">{note}</p>}
      </div>
      <p className="font-display text-base tabular-nums shrink-0">{formatCurrency(amount)}</p>
    </div>
  )
}
