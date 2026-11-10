'use client'

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { useTranslations } from 'next-intl'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Skeleton } from '@/components/ui/skeleton'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { ArrowRightIcon, CheckCircleIcon, ExclamationTriangleIcon } from '@/components/icons'
import { formatCurrency } from '@/lib/utils'
import { useToast } from '@/components/ui/use-toast'
import { AttnLine } from '@/components/ui/attn-line'
import { DepreciationPanel } from './DepreciationPanel'
import { EfDeclarationSection } from './EfDeclarationSection'
import { DeferredTaxCard } from './DeferredTaxCard'
import { LossCarryforwardRegister, LossRegisterDeficitHint } from './LossCarryforwardRegister'
import type {
  BolagsskattBasis,
  DispositionsProposal,
  ProposedDisposition,
  DispositionKind,
  TaxAdjustmentSnapshot,
} from '@/lib/bokslut/types'
import { getErrorMessage as getUserErrorMessage } from '@/lib/errors/get-error-message'
import { filesIncomeReturn, supportsCorporateTaxDispositions } from '@/lib/company/entity-type'
import { parseAmountInput } from '@/lib/money'
import { explainZeroedTax } from '@/lib/bokslut/zeroed-tax'

interface DispositionsStepProps {
  periodId: string
  onBack: () => void
  onContinue: () => void
  onNavigationBlockedChange?: (blocked: boolean) => void
}

interface UiState {
  /** kind → user-controlled selection state */
  selections: Record<string, { accept: boolean; overrideAmount?: number; lockedSkip: boolean }>
}

interface TaxAdjustmentDraft {
  nonDeductibleExpenses: string
  nonTaxableIncome: string
  /** INK2S 4.14 a: outnyttjat underskott från föregående beskattningsår. */
  deficitCarryforward: string
  /** Keyed by account number; the detected list depends on the legal form. */
  detectedAccounts: Record<string, boolean>
}

/**
 * Phase 2 bokslutsdispositioner step. Fetches proposals from the dispositions
 * API, lets the user adjust amounts (or skip) per proposal, then POSTs the
 * accepted ones. Mandatory p-fond reversals (cohort ≥ 6 years old) cannot be
 * skipped: checkbox stays disabled-on.
 *
 * A form without corporate tax dispositions gets an empty `proposals` array
 * from the server; this step then renders the form's own section (the
 * NE-bilaga inputs when it files an NE return, otherwise a short note) and
 * lets the user continue.
 */
export function DispositionsStep({
  periodId,
  onBack,
  onContinue,
  onNavigationBlockedChange,
}: DispositionsStepProps) {
  const { toast } = useToast()
  const t = useTranslations('dispositions_tax_basis')
  const [proposal, setProposal] = useState<DispositionsProposal | null>(null)
  const [loading, setLoading] = useState(true)
  const [fetchError, setFetchError] = useState<string | null>(null)
  const [ui, setUi] = useState<UiState>({ selections: {} })
  const [posting, setPosting] = useState(false)
  const [postError, setPostError] = useState<string | null>(null)
  const [savingAdjustments, setSavingAdjustments] = useState(false)
  const [adjustmentError, setAdjustmentError] = useState<string | null>(null)
  const [taxAdjustmentDraft, setTaxAdjustmentDraft] = useState<TaxAdjustmentDraft>(emptyTaxDraft)
  const [taxDepreciationDirty, setTaxDepreciationDirty] = useState(false)

  useEffect(() => {
    onNavigationBlockedChange?.(taxDepreciationDirty)
  }, [onNavigationBlockedChange, taxDepreciationDirty])

  useEffect(() => () => onNavigationBlockedChange?.(false), [onNavigationBlockedChange])

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
              deficitCarryforward: parseNonNegativeAmount(
                taxAdjustmentDraft.deficitCarryforward,
              ),
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
    if (taxDepreciationDirty) {
      setPostError('Spara eller återställ ändringarna i skattemässig avskrivning innan du fortsätter.')
      return
    }
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
  }, [proposal, ui, periodId, onContinue, toast, taxDepreciationDirty])

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

  // By capability, never by form name. Depreciation applies to every form
  // (skattemässig hanteras separat). A form that files an NE return replaces
  // the corporate dispositioner with the NE-bilaga declaration section; a
  // form that files INK3 (ideell förening) is pointed at the INK3 underlag,
  // where its tax adjustments and taxable/exempt split are prepared; a form
  // with neither gets a note that nothing further is prepared for it yet.
  if (!supportsCorporateTaxDispositions(proposal.entityType)) {
    const fiscalYear = parseInt(proposal.fiscalPeriod.period_end.slice(0, 4), 10)
    const incomeReturn = filesIncomeReturn(proposal.entityType)
    return (
      <div className="space-y-6">
        <DepreciationPanel
          periodId={periodId}
          onPosted={() => void loadProposals()}
          onTaxDirtyChange={setTaxDepreciationDirty}
        />
        {incomeReturn === 'NE' ? (
          <EfDeclarationSection
            fiscalPeriodId={periodId}
            bookedSurplus={proposal.netResultBefore}
            fiscalYear={fiscalYear}
          />
        ) : incomeReturn === 'INK3' ? (
          <Card>
            <CardContent className="p-6 text-sm text-muted-foreground">
              Inga bokslutsdispositioner bokförs för den här företagsformen. Skattemässiga
              justeringar och fördelningen mellan skattefri och skattepliktig verksamhet görs i
              underlaget för inkomstdeklaration 3, som också visar vad som ska skrivas in i
              Skatteverkets e-tjänst. Avskrivningarna ovan bokförs som vanligt; gå vidare för att
              förhandsgranska bokslutet.{' '}
              <Link
                href="/reports/ink3-declaration"
                className="text-foreground underline underline-offset-2"
              >
                Öppna INK3-underlaget
              </Link>
            </CardContent>
          </Card>
        ) : (
          <Card>
            <CardContent className="p-6 text-sm text-muted-foreground">
              Inga bokslutsdispositioner eller deklarationsjusteringar förbereds för den här
              företagsformen ännu. Avskrivningarna ovan bokförs som vanligt; gå vidare för att
              förhandsgranska bokslutet.
            </CardContent>
          </Card>
        )}
        {taxDepreciationDirty && (
          <p className="text-sm text-attn" role="status">
            Spara eller återställ ändringarna i skattemässig avskrivning innan du lämnar steget.
          </p>
        )}
        <div className="flex justify-between">
          <Button
            variant="outline"
            size="sm"
            onClick={onBack}
            disabled={taxDepreciationDirty}
          >
            ← Tillbaka
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={onContinue}
            disabled={taxDepreciationDirty}
            title={
              taxDepreciationDirty
                ? 'Spara ändringarna i skattemässig avskrivning innan du fortsätter.'
                : undefined
            }
          >
            Nästa: Förhandsgranska →
          </Button>
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <DepreciationPanel
        periodId={periodId}
        onPosted={() => void loadProposals()}
        onTaxDirtyChange={setTaxDepreciationDirty}
      />
      {/* The figure the dispositions start from, as one meta line; the
          instructions live behind the wizard's "?". */}
      <p className="px-1 text-[12.5px] text-muted-foreground">
        Resultat före dispositioner:{' '}
        <span className="tabular-nums text-foreground">
          {formatCurrency(proposal.netResultBefore)}
        </span>
      </p>

      {proposal.taxAdjustments && (
        <TaxAdjustmentsCard
          snapshot={proposal.taxAdjustments}
          draft={taxAdjustmentDraft}
          taxProposal={proposal.proposals.find((item) => item.kind === 'bolagsskatt')}
          taxBasis={proposal.taxBasis}
          saving={savingAdjustments}
          error={adjustmentError}
          onChange={setTaxAdjustmentDraft}
          onSave={() => void handleSaveAdjustments()}
        />
      )}

      {/* The underskottsregister (IL 40 kap.) next to the 4.14 a it
          prefills: present only while BOLAGET_COMPANY_IDS opens it. */}
      {proposal.taxAdjustments?.lossRegister && (
        <LossCarryforwardRegister periodId={periodId} onSaved={() => void loadProposals()} />
      )}

      {proposal.deferredTax && (
        <DeferredTaxCard
          periodId={periodId}
          snapshot={proposal.deferredTax}
          onSaved={(next) => {
            setProposal(next)
            setUi(createUiState(next))
          }}
        />
      )}

      {/* Attention is ochre sentences, not cards (conventions 6 and 12):
          every disposition warning in one block. */}
      {proposal.warnings && proposal.warnings.length > 0 && (
        <div role="status" className="space-y-1 px-1">
          {proposal.warnings.map((warning) => (
            <AttnLine key={warning}>{warning}</AttnLine>
          ))}
        </div>
      )}

      {(proposal.completedDispositions ?? []).map((completed) => (
        <Card key={`completed-${completed.kind}`}>
          <CardHeader>
            <div className="flex items-start justify-between gap-4">
              <div>
                <CardTitle className="text-base">{completed.label}</CardTitle>
                {completed.status === 'booked' ? (
                  <span className="mt-2 inline-flex items-center gap-1 text-xs text-muted-foreground">
                    <CheckCircleIcon className="h-3.5 w-3.5" />
                    Redan bokförd
                  </span>
                ) : (
                  <Badge variant="warning" className="mt-2 gap-1">
                    <ExclamationTriangleIcon className="h-3.5 w-3.5" />
                    Behöver rättas
                  </Badge>
                )}
              </div>
              <p className="font-display text-2xl tabular-nums shrink-0">
                {formatCurrency(completed.amount)}
              </p>
            </div>
          </CardHeader>
          {completed.warnings.length > 0 && (
            <CardContent className="space-y-2">
              {completed.warnings.map((warning) => (
                <p key={warning} className="text-sm text-attn">{warning}</p>
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
            description={
              p.kind === 'bolagsskatt' ? zeroedTaxDescription(proposal.taxBasis, t) : undefined
            }
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

      {taxDepreciationDirty && (
        <p className="text-sm text-attn" role="status">
          Spara eller återställ ändringarna i skattemässig avskrivning innan du lämnar steget.
        </p>
      )}

      <div className="flex justify-between">
        <Button
          variant="outline"
          size="sm"
          onClick={onBack}
          disabled={posting || taxDepreciationDirty}
        >
          ← Tillbaka
        </Button>
        <Button
          onClick={handleCommit}
          disabled={hasCorrectionRequired || taxDepreciationDirty}
          loading={posting}
          title={
            taxDepreciationDirty
              ? 'Spara ändringarna i skattemässig avskrivning innan du fortsätter.'
              : undefined
          }
        >
          {posting ? (
            'Bokför…'
          ) : (
            <>
              Bokför valda dispositioner <ArrowRightIcon className="ml-1 h-4 w-4" />
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
  taxBasis,
  saving,
  error,
  onChange,
  onSave,
}: {
  snapshot: TaxAdjustmentSnapshot
  draft: TaxAdjustmentDraft
  taxProposal?: ProposedDisposition
  taxBasis?: BolagsskattBasis
  saving: boolean
  error: string | null
  onChange: (draft: TaxAdjustmentDraft) => void
  onSave: () => void
}) {
  const detected = snapshot.items.filter(
    (item) => item.source === 'detected' && item.accountNumber && item.amount > 0,
  )
  const t = useTranslations('dispositions_tax_basis')
  const computation = taxProposal?.computation
  // The proposals the preview counts on but has not booked: they lead from
  // the result in the books to the result after dispositions (accounted#180).
  const pending = taxBasis?.pending ?? []

  return (
    <Card>
      <CardHeader>
        {/* What återläggningar do (and do not) touch lives behind the
            wizard's "?" on this step. */}
        <CardTitle className="text-base">Skattemässiga justeringar</CardTitle>
      </CardHeader>
      <CardContent className="space-y-5">
        {detected.length > 0 && (
          <div className="space-y-3">
            <Label>Upptäckt i bokföringen</Label>
            {detected.map((item) => {
              const account = item.accountNumber as string
              return (
                <div key={item.sourceKey} className="flex items-center justify-between gap-4">
                  <div className="flex items-center gap-3">
                    <Checkbox
                      id={`tax-adjustment-${account}`}
                      checked={draft.detectedAccounts[account] ?? false}
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
          {/* INK2S 4.14 a. The only way in for a company whose earlier years
              live in another system: the deficit is not in these books. */}
          <div className="space-y-2">
            <Label htmlFor="manual-deficit-carryforward">
              Outnyttjat underskott från föregående beskattningsår
            </Label>
            <Input
              id="manual-deficit-carryforward"
              type="number"
              min="0"
              step="0.01"
              value={draft.deficitCarryforward}
              onChange={(event) =>
                onChange({ ...draft, deficitCarryforward: event.target.value })
              }
            />
            <p className="text-xs text-muted-foreground">
              Underskott från tidigare år som inte redan finns i bokföringen här, till exempel
              efter en flytt från ett annat system. Dras av från årets skattemässiga resultat
              (INK2S punkt 4.14 a).
            </p>
            <LossRegisterDeficitHint register={snapshot.lossRegister} />
          </div>
        </div>

        {computation && (
          <div className="rounded-lg bg-muted/50 p-4 text-sm space-y-1">
            {taxBasis && pending.length > 0 && (
              <>
                <CalculationRow label={t('booked_result')} amount={taxBasis.bookedResultBeforeTax} />
                {pending.map((item) => (
                  <CalculationRow
                    key={`${item.kind}:${item.label}`}
                    label={item.label}
                    amount={Math.abs(item.resultEffect)}
                    prefix={item.resultEffect > 0 ? '+' : '-'}
                  />
                ))}
              </>
            )}
            <CalculationRow label="Resultat efter dispositioner" amount={numberValue(computation.resultBeforeTax)} />
            <CalculationRow label="Ej avdragsgilla kostnader" amount={numberValue(computation.nonDeductibleExpenses)} prefix="+" />
            <CalculationRow label="Ej skattepliktiga intäkter" amount={numberValue(computation.nonTaxableIncome)} prefix="-" />
            {numberValue(computation.deficitCarryforward) > 0 && (
              <CalculationRow label="Underskott från tidigare år" amount={numberValue(computation.deficitCarryforward)} prefix="-" />
            )}
            <CalculationRow label="Skattemässigt resultat" amount={numberValue(computation.taxableResultClamped)} strong />
            <CalculationRow label="Bolagsskatt 20,6 %" amount={numberValue(computation.taxAmount)} strong />
          </div>
        )}

        {error && <p className="text-sm text-destructive">{error}</p>}
        <Button type="button" variant="outline" onClick={onSave} loading={saving}>
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
  description,
  accept,
  overrideAmount,
  lockedSkip,
  onChange,
}: {
  proposal: ProposedDisposition
  /** Replaces the server's description (the 0 kr bolagsskatt, in the user's language). */
  description?: string
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
            <p className="text-sm text-muted-foreground mt-1">{description ?? proposal.description}</p>
            {proposal.required && (
              <Badge variant="warning" className="mt-2 gap-1">
                <ExclamationTriangleIcon className="h-3.5 w-3.5" /> Obligatorisk
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
          <p key={i} className="text-sm text-attn">
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

/**
 * The 0 kr bolagsskatt card in the user's language: the proposals that take
 * the tax to 0 kr, with what each takes off the result, the tax without them
 * and the way to pay tax this year. Undefined when no proposal zeroes it.
 */
function zeroedTaxDescription(
  basis: BolagsskattBasis | undefined,
  t: ReturnType<typeof useTranslations<'dispositions_tax_basis'>>,
): string | undefined {
  const zeroed = explainZeroedTax(basis)
  if (!zeroed) return undefined
  const list = zeroed.zeroedBy
    .map((item) => `${item.label} (${item.resultEffect > 0 ? '+' : '-'}${formatCurrency(Math.abs(item.resultEffect))})`)
    .join(', ')
  const sentences = [t('zeroed_by', { list })]
  if (zeroed.taxWithout !== null) {
    sentences.push(t('zeroed_without', { amount: formatCurrency(zeroed.taxWithout) }))
  }
  if (zeroed.canSkip) sentences.push(t('zeroed_skip'))
  return sentences.join(' ')
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
      case 'uppskjuten_skatt_kap29':
        items.push({ kind: 'uppskjuten_skatt_kap29' })
        break
      case 'fond_for_utvecklingsutgifter':
        items.push({ kind: 'fond_for_utvecklingsutgifter' })
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
  deficitCarryforward: '0',
  detectedAccounts: {},
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
  const manualDeficit = snapshot.items.find(
    (item) => item.sourceKey === 'manual:deficit_carryforward',
  )
  const detectedAccounts: Record<string, boolean> = {}
  for (const item of snapshot.items) {
    if (item.source === 'detected' && item.accountNumber) {
      detectedAccounts[item.accountNumber] = Boolean(item.included)
    }
  }
  return {
    nonDeductibleExpenses: String(manualNonDeductible?.amount ?? 0),
    nonTaxableIncome: String(manualNonTaxable?.amount ?? 0),
    deficitCarryforward: String(manualDeficit?.amount ?? 0),
    detectedAccounts,
  }
}

function parseNonNegativeAmount(value: string): number {
  const parsed = parseAmountInput(value)
  return parsed !== null && parsed >= 0 ? parsed : 0
}

function numberValue(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}
