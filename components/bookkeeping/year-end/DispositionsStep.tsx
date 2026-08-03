'use client'

import { useCallback, useEffect, useState } from 'react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Skeleton } from '@/components/ui/skeleton'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { ArrowRight, AlertTriangle, CheckCircle2, Loader2 } from 'lucide-react'
import { formatCurrency } from '@/lib/utils'
import { useToast } from '@/components/ui/use-toast'
import { DepreciationPanel } from './DepreciationPanel'
import { EfDeclarationSection } from './EfDeclarationSection'
import type {
  DispositionsProposal,
  ProposedDisposition,
  DispositionKind,
  TaxAdjustmentSnapshot,
} from '@/lib/bokslut/types'
import { getErrorMessage as getUserErrorMessage } from '@/lib/errors/get-error-message'

interface DispositionsStepProps {
  periodId: string
  onBack: () => void
  onContinue: () => void
}

interface UiState {
  /** kind → user-controlled selection state */
  selections: Record<string, { accept: boolean; overrideAmount?: number; lockedSkip: boolean }>
}

interface TaxAdjustmentDraft {
  nonDeductibleExpenses: string
  nonTaxableIncome: string
  detectedAccounts: { '6992': boolean; '8423': boolean }
}

/**
 * Phase 2 bokslutsdispositioner step. Fetches proposals from the dispositions
 * API, lets the user adjust amounts (or skip) per proposal, then POSTs the
 * accepted ones. Mandatory p-fond reversals (cohort ≥ 6 years old) cannot be
 * skipped: checkbox stays disabled-on.
 *
 * EF companies get an empty `proposals` array from the server, so this step
 * renders a short pass-through note and lets the user continue.
 */
export function DispositionsStep({ periodId, onBack, onContinue }: DispositionsStepProps) {
  const { toast } = useToast()
  const [proposal, setProposal] = useState<DispositionsProposal | null>(null)
  const [loading, setLoading] = useState(true)
  const [fetchError, setFetchError] = useState<string | null>(null)
  const [ui, setUi] = useState<UiState>({ selections: {} })
  const [posting, setPosting] = useState(false)
  const [postError, setPostError] = useState<string | null>(null)
  const [savingAdjustments, setSavingAdjustments] = useState(false)
  const [adjustmentError, setAdjustmentError] = useState<string | null>(null)
  const [taxAdjustmentDraft, setTaxAdjustmentDraft] = useState<TaxAdjustmentDraft>(emptyTaxDraft)

  // ---- Fetch proposals ----
  const loadProposals = useCallback(async () => {
    setLoading(true)
    setFetchError(null)
    try {
      const res = await fetch(
        `/api/bookkeeping/fiscal-periods/${periodId}/bokslutsdispositioner`,
      )
      const body = await res.json()
      if (!res.ok) {
        setFetchError(getUserErrorMessage(body?.error) ?? 'Kunde inte ladda dispositioner')
        return
      }
      const data = body.data as DispositionsProposal
      setProposal(data)
      setUi(createUiState(data))
      setTaxAdjustmentDraft(createTaxAdjustmentDraft(data.taxAdjustments))
    } catch {
      setFetchError('Kunde inte ladda dispositioner')
    } finally {
      setLoading(false)
    }
  }, [periodId])

  const handleSaveAdjustments = useCallback(async () => {
    setSavingAdjustments(true)
    setAdjustmentError(null)
    try {
      const res = await fetch(
        `/api/bookkeeping/fiscal-periods/${periodId}/bokslutsdispositioner`,
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            manualAdjustments: {
              nonDeductibleExpenses: parseNonNegativeAmount(
                taxAdjustmentDraft.nonDeductibleExpenses,
              ),
              nonTaxableIncome: parseNonNegativeAmount(taxAdjustmentDraft.nonTaxableIncome),
            },
            detectedAccounts: taxAdjustmentDraft.detectedAccounts,
          }),
        },
      )
      const body = await res.json()
      if (!res.ok) {
        setAdjustmentError(
          getUserErrorMessage(body?.error) ?? 'Kunde inte spara skattemässiga justeringar',
        )
        return
      }
      const data = body.data as DispositionsProposal
      setProposal(data)
      setUi(createUiState(data))
      setTaxAdjustmentDraft(createTaxAdjustmentDraft(data.taxAdjustments))
      toast({
        title: 'Skatteunderlaget är uppdaterat',
        description: 'Bolagsskatten har räknats om utan att ändra periodiseringsfonden.',
      })
    } catch (err) {
      setAdjustmentError(
        err instanceof Error
          ? getUserErrorMessage(err)
          : 'Kunde inte spara skattemässiga justeringar',
      )
    } finally {
      setSavingAdjustments(false)
    }
  }, [periodId, taxAdjustmentDraft, toast])

  useEffect(() => {
    void loadProposals()
  }, [loadProposals])

  // ---- POST accepted dispositions ----
  const handleCommit = useCallback(async () => {
    if (!proposal) return
    if (proposal.completedDispositions?.some((item) => item.status === 'needs_correction')) {
      setPostError('Rätta den bokförda bolagsskatten och ladda om sidan innan du fortsätter.')
      return
    }
    setPosting(true)
    setPostError(null)
    try {
      const items = buildPostItems(proposal, ui)
      if (items.length === 0) {
        // Nothing selected: just move on
        onContinue()
        return
      }
      const res = await fetch(`/api/bookkeeping/fiscal-periods/${periodId}/bokslutsdispositioner`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ items }),
      })
      const body = await res.json()
      if (!res.ok) {
        setPostError(getUserErrorMessage(body?.error) ?? 'Kunde inte bokföra dispositioner')
        return
      }
      const created = body.data?.created ?? []
      toast({
        title: `${created.length} verifikation${created.length === 1 ? '' : 'er'} bokförd${
          created.length === 1 ? '' : 'a'
        }`,
        description: 'Dispositionerna ligger nu i bokföringen.',
      })
      onContinue()
    } catch (err) {
      setPostError(err instanceof Error ? getUserErrorMessage(err) : 'Okänt fel')
    } finally {
      setPosting(false)
    }
  }, [proposal, ui, periodId, onContinue, toast])

  // ---- Render branches ----
  if (loading) {
    return (
      <Card>
        <CardContent className="p-6 space-y-3">
          <Skeleton className="h-6 w-1/3" />
          <Skeleton className="h-20 w-full" />
          <Skeleton className="h-20 w-full" />
        </CardContent>
      </Card>
    )
  }

  if (fetchError) {
    return (
      <Card>
        <CardContent className="p-6">
          <p className="text-destructive">{fetchError}</p>
        </CardContent>
      </Card>
    )
  }

  if (!proposal) return null

  const hasCorrectionRequired = proposal.completedDispositions?.some(
    (item) => item.status === 'needs_correction',
  ) ?? false

  // EF: depreciation can apply (skattemässig hanteras separat); replace the
  // AB-only dispositioner with a NE-bilaga declaration section.
  if (proposal.entityType !== 'aktiebolag') {
    const fiscalYear = parseInt(proposal.fiscalPeriod.period_end.slice(0, 4), 10)
    return (
      <div className="space-y-6">
        <DepreciationPanel periodId={periodId} onPosted={() => void loadProposals()} />
        <EfDeclarationSection
          fiscalPeriodId={periodId}
          bookedSurplus={proposal.netResultBefore}
          fiscalYear={fiscalYear}
        />
        <div className="flex justify-between">
          <Button variant="outline" size="sm" onClick={onBack}>
            ← Tillbaka
          </Button>
          <Button variant="outline" size="sm" onClick={onContinue}>
            Nästa: Förhandsgranska →
          </Button>
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <DepreciationPanel periodId={periodId} onPosted={() => void loadProposals()} />
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Bokslutsdispositioner</CardTitle>
          <p className="text-sm text-muted-foreground">
            Resultat före dispositioner:{' '}
            <span className="tabular-nums font-medium">
              {formatCurrency(proposal.netResultBefore)}
            </span>
            . Justera beloppen och bocka av de dispositioner du vill boka.
          </p>
        </CardHeader>
      </Card>

      {proposal.taxAdjustments && (
        <TaxAdjustmentsCard
          snapshot={proposal.taxAdjustments}
          draft={taxAdjustmentDraft}
          taxProposal={proposal.proposals.find((item) => item.kind === 'bolagsskatt')}
          saving={savingAdjustments}
          error={adjustmentError}
          onChange={setTaxAdjustmentDraft}
          onSave={() => void handleSaveAdjustments()}
        />
      )}

      {proposal.warnings?.map((warning) => (
        <Card key={warning}>
          <CardContent className="p-4 text-sm text-warning-foreground flex items-start gap-2">
            <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" />
            <span>{warning}</span>
          </CardContent>
        </Card>
      ))}

      {(proposal.completedDispositions ?? []).map((completed) => (
        <Card key={`completed-${completed.kind}`}>
          <CardHeader>
            <div className="flex items-start justify-between gap-4">
              <div>
                <CardTitle className="text-base">{completed.label}</CardTitle>
                <Badge
                  variant={completed.status === 'booked' ? 'success' : 'warning'}
                  className="mt-2 gap-1"
                >
                  {completed.status === 'booked' ? (
                    <CheckCircle2 className="h-3.5 w-3.5" />
                  ) : (
                    <AlertTriangle className="h-3.5 w-3.5" />
                  )}
                  {completed.status === 'booked' ? 'Redan bokförd' : 'Behöver rättas'}
                </Badge>
              </div>
              <p className="font-display text-2xl tabular-nums shrink-0">
                {formatCurrency(completed.amount)}
              </p>
            </div>
          </CardHeader>
          {completed.warnings.length > 0 && (
            <CardContent className="space-y-2">
              {completed.warnings.map((warning) => (
                <p key={warning} className="text-sm text-warning-foreground">{warning}</p>
              ))}
            </CardContent>
          )}
        </Card>
      ))}

      {proposal.proposals.length === 0
        && (proposal.completedDispositions ?? []).length === 0 && (
          <Card>
            <CardContent className="p-6 text-sm text-muted-foreground">
              Inga bokslutsdispositioner behöver bokföras utifrån det aktuella underlaget.
            </CardContent>
          </Card>
        )}

      {proposal.proposals.map((p, i) => {
        const key = proposalKey(p, i)
        const sel = ui.selections[key]
        if (!sel) return null
        return (
          <ProposalCard
            key={key}
            proposal={p}
            accept={sel.accept}
            overrideAmount={sel.overrideAmount}
            lockedSkip={sel.lockedSkip}
            onChange={(next) => {
              setUi((prev) => ({
                selections: { ...prev.selections, [key]: { ...sel, ...next } },
              }))
            }}
          />
        )
      })}

      {postError && (
        <Card>
          <CardContent className="p-4 text-sm text-destructive">{postError}</CardContent>
        </Card>
      )}

      <div className="flex justify-between">
        <Button variant="outline" size="sm" onClick={onBack} disabled={posting}>
          ← Tillbaka
        </Button>
        <Button onClick={handleCommit} disabled={posting || hasCorrectionRequired}>
          {posting ? (
            <>
              <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Bokför…
            </>
          ) : (
            <>
              Bokför valda dispositioner <ArrowRight className="ml-1 h-4 w-4" />
            </>
          )}
        </Button>
      </div>
    </div>
  )
}

function TaxAdjustmentsCard({
  snapshot,
  draft,
  taxProposal,
  saving,
  error,
  onChange,
  onSave,
}: {
  snapshot: TaxAdjustmentSnapshot
  draft: TaxAdjustmentDraft
  taxProposal?: ProposedDisposition
  saving: boolean
  error: string | null
  onChange: (draft: TaxAdjustmentDraft) => void
  onSave: () => void
}) {
  const detected = snapshot.items.filter(
    (item) => item.source === 'detected' && item.accountNumber && item.amount > 0,
  )
  const computation = taxProposal?.computation

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Skattemässiga justeringar</CardTitle>
        <p className="text-sm text-muted-foreground">
          Återläggningar påverkar skatten och INK2, men skapar ingen egen verifikation och ändrar
          inte en redan bokförd periodiseringsfond.
        </p>
      </CardHeader>
      <CardContent className="space-y-5">
        {detected.length > 0 && (
          <div className="space-y-3">
            <Label>Upptäckt i bokföringen</Label>
            {detected.map((item) => {
              const account = item.accountNumber as '6992' | '8423'
              return (
                <div key={item.sourceKey} className="flex items-center justify-between gap-4">
                  <div className="flex items-center gap-3">
                    <Checkbox
                      id={`tax-adjustment-${account}`}
                      checked={draft.detectedAccounts[account]}
                      onCheckedChange={(checked) =>
                        onChange({
                          ...draft,
                          detectedAccounts: {
                            ...draft.detectedAccounts,
                            [account]: Boolean(checked),
                          },
                        })
                      }
                    />
                    <Label htmlFor={`tax-adjustment-${account}`} className="cursor-pointer">
                      Konto {account}: {item.description}
                    </Label>
                  </div>
                  <span className="tabular-nums font-medium">{formatCurrency(item.amount)}</span>
                </div>
              )
            })}
          </div>
        )}

        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="manual-non-deductible">Ytterligare ej avdragsgilla kostnader</Label>
            <Input
              id="manual-non-deductible"
              type="number"
              min="0"
              step="0.01"
              value={draft.nonDeductibleExpenses}
              onChange={(event) =>
                onChange({ ...draft, nonDeductibleExpenses: event.target.value })
              }
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="manual-non-taxable">Ej skattepliktiga intäkter</Label>
            <Input
              id="manual-non-taxable"
              type="number"
              min="0"
              step="0.01"
              value={draft.nonTaxableIncome}
              onChange={(event) => onChange({ ...draft, nonTaxableIncome: event.target.value })}
            />
          </div>
        </div>

        {computation && (
          <div className="rounded-lg bg-muted/50 p-4 text-sm space-y-1">
            <CalculationRow label="Resultat efter dispositioner" amount={numberValue(computation.resultBeforeTax)} />
            <CalculationRow label="Ej avdragsgilla kostnader" amount={numberValue(computation.nonDeductibleExpenses)} prefix="+" />
            <CalculationRow label="Ej skattepliktiga intäkter" amount={numberValue(computation.nonTaxableIncome)} prefix="-" />
            <CalculationRow label="Skattemässigt resultat" amount={numberValue(computation.taxableResultClamped)} strong />
            <CalculationRow label="Bolagsskatt 20,6 %" amount={numberValue(computation.taxAmount)} strong />
          </div>
        )}

        {error && <p className="text-sm text-destructive">{error}</p>}
        <Button type="button" variant="outline" onClick={onSave} disabled={saving}>
          {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
          Spara och räkna om
        </Button>
      </CardContent>
    </Card>
  )
}

function CalculationRow({
  label,
  amount,
  prefix = '',
  strong = false,
}: {
  label: string
  amount: number
  prefix?: string
  strong?: boolean
}) {
  return (
    <div className={`flex justify-between gap-4 ${strong ? 'font-medium' : ''}`}>
      <span>{label}</span>
      <span className="tabular-nums">{prefix}{formatCurrency(amount)}</span>
    </div>
  )
}

function ProposalCard({
  proposal,
  accept,
  overrideAmount,
  lockedSkip,
  onChange,
}: {
  proposal: ProposedDisposition
  accept: boolean
  overrideAmount: number | undefined
  lockedSkip: boolean
  onChange: (next: { accept?: boolean; overrideAmount?: number }) => void
}) {
  const overridable = isOverridable(proposal)
  const displayedAmount = overridable ? overrideAmount ?? proposal.amount : proposal.amount

  return (
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between gap-4">
          <div className="flex-1">
            <CardTitle className="text-base">{proposal.label}</CardTitle>
            <p className="text-sm text-muted-foreground mt-1">{proposal.description}</p>
            {proposal.required && (
              <Badge variant="warning" className="mt-2 gap-1">
                <AlertTriangle className="h-3.5 w-3.5" /> Obligatorisk
              </Badge>
            )}
          </div>
          <p className="font-display text-2xl tabular-nums shrink-0">
            {formatCurrency(displayedAmount)}
          </p>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {proposal.warnings.map((w, i) => (
          <p key={i} className="text-sm text-warning-foreground">
            {w}
          </p>
        ))}
        {overridable && (
          <div className="flex items-center gap-3">
            <Label htmlFor={`amount-${proposal.kind}`} className="text-sm shrink-0">
              Belopp (kr)
            </Label>
            <Input
              id={`amount-${proposal.kind}`}
              type="number"
              step="1"
              className="max-w-[180px] tabular-nums"
              value={overrideAmount ?? proposal.amount}
              onChange={(e) => {
                const value = parseInt(e.target.value, 10)
                onChange({ overrideAmount: Number.isFinite(value) ? value : 0 })
              }}
            />
          </div>
        )}
        <div className="flex items-center gap-2 pt-1">
          <Checkbox
            id={`accept-${proposal.kind}`}
            checked={accept}
            disabled={lockedSkip}
            onCheckedChange={(checked) => onChange({ accept: Boolean(checked) })}
          />
          <Label
            htmlFor={`accept-${proposal.kind}`}
            className="text-sm cursor-pointer select-none"
          >
            {accept ? 'Boka denna disposition' : 'Hoppa över'}
            {lockedSkip && (
              <span className="text-muted-foreground ml-2 text-xs">(kan inte hoppas över)</span>
            )}
          </Label>
        </div>
      </CardContent>
    </Card>
  )
}

function isOverridable(proposal: ProposedDisposition): boolean {
  // Bolagsskatt and SLP are derived from posted entries: overriding the amount
  // would silently break the journal posting (the calculator would still
  // recompute server-side). p-fond avsättning and överavskrivningar take a
  // desired amount as input, so editing is meaningful. p-fond återföring is
  // composed of mandatory cohorts and isn't safely editable from a single
  // amount field.
  return (
    proposal.kind === 'periodiseringsfond_avsattning'
    || (
      proposal.kind === 'overavskrivningar'
      && (proposal.signedAmount ?? proposal.amount) > 0
    )
  )
}

function proposalKey(p: ProposedDisposition, index = 0): string {
  // For återföring there can be multiple cards (one per cohort): disambiguate
  // by including the line account in the key. For other kinds, the kind is unique.
  if (p.kind === 'periodiseringsfond_ateforing') {
    return `${p.kind}:${p.lines[0]?.account_number ?? index}`
  }
  return `${p.kind}:${index}`
}

interface PostItem {
  kind: DispositionKind
  [key: string]: unknown
}

function buildPostItems(proposal: DispositionsProposal, ui: UiState): PostItem[] {
  const items: PostItem[] = []
  // Group återföring entries: server expects a single item with a `returns`
  // map keyed by cohort account.
  const ateforingReturns: Record<string, number> = {}
  for (const p of proposal.proposals) {
    const key = proposalKey(p, proposal.proposals.indexOf(p))
    const sel = ui.selections[key]
    if (!sel || !sel.accept) continue

    switch (p.kind) {
      case 'bolagsskatt':
        items.push({ kind: 'bolagsskatt' })
        break
      case 'sarskild_loneskatt':
        items.push({ kind: 'sarskild_loneskatt' })
        break
      case 'periodiseringsfond_avsattning':
        items.push({
          kind: 'periodiseringsfond_avsattning',
          desiredAmount: sel.overrideAmount ?? p.amount,
        })
        break
      case 'periodiseringsfond_ateforing': {
        const account = p.lines[0]?.account_number
        if (account) ateforingReturns[account] = p.amount
        break
      }
      case 'overavskrivningar': {
        const signedDefault = p.signedAmount ?? p.amount
        const selectedAmount = sel.overrideAmount ?? p.amount
        items.push({
          kind: 'overavskrivningar',
          additionalAmount:
            signedDefault < 0 ? -Math.abs(selectedAmount) : selectedAmount,
        })
        break
      }
      case 'uppskjuten_skatt':
        // K3 only: server recomputes the amount; client just signals intent.
        items.push({ kind: 'uppskjuten_skatt' })
        break
    }
  }
  if (Object.keys(ateforingReturns).length > 0) {
    items.push({ kind: 'periodiseringsfond_ateforing', returns: ateforingReturns })
  }
  return items
}

const emptyTaxDraft: TaxAdjustmentDraft = {
  nonDeductibleExpenses: '0',
  nonTaxableIncome: '0',
  detectedAccounts: { '6992': false, '8423': false },
}

function createUiState(proposal: DispositionsProposal): UiState {
  const selections: UiState['selections'] = {}
  proposal.proposals.forEach((item, index) => {
    const key = proposalKey(item, index)
    selections[key] = {
      accept: true,
      overrideAmount: item.amount,
      lockedSkip: Boolean(item.required),
    }
  })
  return { selections }
}

function createTaxAdjustmentDraft(
  snapshot: TaxAdjustmentSnapshot | undefined,
): TaxAdjustmentDraft {
  if (!snapshot) return emptyTaxDraft
  const manualNonDeductible = snapshot.items.find(
    (item) => item.sourceKey === 'manual:non_deductible_expenses',
  )
  const manualNonTaxable = snapshot.items.find(
    (item) => item.sourceKey === 'manual:non_taxable_income',
  )
  const account6992 = snapshot.items.find((item) => item.sourceKey === 'account:6992')
  const account8423 = snapshot.items.find((item) => item.sourceKey === 'account:8423')
  return {
    nonDeductibleExpenses: String(manualNonDeductible?.amount ?? 0),
    nonTaxableIncome: String(manualNonTaxable?.amount ?? 0),
    detectedAccounts: {
      '6992': Boolean(account6992?.included),
      '8423': Boolean(account8423?.included),
    },
  }
}

function parseNonNegativeAmount(value: string): number {
  const parsed = Number(value.replace(',', '.'))
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0
}

function numberValue(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}
