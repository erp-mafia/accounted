'use client'

import { useCallback, useEffect, useState } from 'react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Skeleton } from '@/components/ui/skeleton'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { ArrowRight, AlertTriangle, Loader2 } from 'lucide-react'
import { formatCurrency } from '@/lib/utils'
import { useToast } from '@/components/ui/use-toast'
import { DepreciationPanel } from './DepreciationPanel'
import { EfDeclarationSection } from './EfDeclarationSection'
import type {
  DispositionsProposal,
  ProposedDisposition,
  DispositionKind,
} from '@/lib/bokslut/types'

interface DispositionsStepProps {
  periodId: string
  onBack: () => void
  onContinue: () => void
}

interface UiState {
  /** kind → user-controlled selection state */
  selections: Record<string, { accept: boolean; overrideAmount?: number; lockedSkip: boolean }>
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
        setFetchError(body?.error?.message ?? 'Kunde inte ladda dispositioner')
        return
      }
      const data = body.data as DispositionsProposal
      setProposal(data)
      const selections: UiState['selections'] = {}
      data.proposals.forEach((p, index) => {
        // Key must match the render loop and buildPostItems, which both pass
        // the array index: omitting it here defaulted every non-ateforing
        // key to ":0", so only the first proposal card ever rendered.
        const key = proposalKey(p, index)
        selections[key] = {
          accept: true,
          overrideAmount: p.amount,
          lockedSkip: Boolean(p.required),
        }
      })
      setUi({ selections })
    } catch {
      setFetchError('Kunde inte ladda dispositioner')
    } finally {
      setLoading(false)
    }
  }, [periodId])

  useEffect(() => {
    void loadProposals()
  }, [loadProposals])

  // ---- POST accepted dispositions ----
  const handleCommit = useCallback(async () => {
    if (!proposal) return
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
        setPostError(body?.error?.message ?? 'Kunde inte bokföra dispositioner')
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
      setPostError(err instanceof Error ? err.message : 'Okänt fel')
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
          <Button variant="outline" onClick={onBack}>Tillbaka</Button>
          <Button onClick={onContinue}>
            Fortsätt <ArrowRight className="ml-1 h-4 w-4" />
          </Button>
        </div>
      </div>
    )
  }

  if (proposal.proposals.length === 0) {
    return (
      <div className="space-y-6">
        <DepreciationPanel periodId={periodId} onPosted={() => void loadProposals()} />
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Inga dispositioner föreslagna</CardTitle>
          </CardHeader>
          <CardContent className="text-sm text-muted-foreground">
            Bolaget har varken pensionskostnader, periodiseringsfonder att hantera, vinst att skatta
            på, eller skattemässiga avskrivningar att boka.
          </CardContent>
        </Card>
        <div className="flex justify-between">
          <Button variant="outline" onClick={onBack}>Tillbaka</Button>
          <Button onClick={onContinue}>
            Fortsätt <ArrowRight className="ml-1 h-4 w-4" />
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
        <Button variant="outline" onClick={onBack} disabled={posting}>
          Tillbaka
        </Button>
        <Button onClick={handleCommit} disabled={posting}>
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
  const overridable = isOverridable(proposal.kind)
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

function isOverridable(kind: DispositionKind): boolean {
  // Bolagsskatt and SLP are derived from posted entries: overriding the amount
  // would silently break the journal posting (the calculator would still
  // recompute server-side). p-fond avsättning and överavskrivningar take a
  // desired amount as input, so editing is meaningful. p-fond återföring is
  // composed of mandatory cohorts and isn't safely editable from a single
  // amount field.
  return kind === 'periodiseringsfond_avsattning' || kind === 'overavskrivningar'
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
        items.push({ kind: 'bolagsskatt', manualAdjustments: {} })
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
      case 'overavskrivningar':
        items.push({
          kind: 'overavskrivningar',
          additionalAmount: sel.overrideAmount ?? p.amount,
        })
        break
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
