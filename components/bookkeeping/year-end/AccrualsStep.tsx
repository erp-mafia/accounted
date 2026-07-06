'use client'

import { useCallback, useEffect, useState } from 'react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Skeleton } from '@/components/ui/skeleton'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { ArrowRight, Loader2, Plus, Trash2 } from 'lucide-react'
import { formatCurrency } from '@/lib/utils'
import { useToast } from '@/components/ui/use-toast'
import type { AccrualsProposal } from '@/lib/bokslut/accruals/types'

interface AccrualsStepProps {
  periodId: string
  onBack: () => void
  onContinue: () => void
}

interface AutoState {
  vacation: { accept: boolean }
}

interface ManualEntry {
  id: string
  kind: 'audit_fee' | 'manual_prepaid_expense' | 'manual_accrued_expense'
  amount: string
  description: string
  expenseAccount: string
  prepaidAccount: string
  accruedAccount: string
  liabilityAccount: '2991' | '2992'
}

function makeId() {
  return Math.random().toString(36).slice(2, 10)
}

export function AccrualsStep({ periodId, onBack, onContinue }: AccrualsStepProps) {
  const { toast } = useToast()
  const [proposal, setProposal] = useState<AccrualsProposal | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [auto, setAuto] = useState<AutoState>({ vacation: { accept: true } })
  const [manual, setManual] = useState<ManualEntry[]>([])
  const [posting, setPosting] = useState(false)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    fetch(`/api/bookkeeping/fiscal-periods/${periodId}/accruals`)
      .then(async (res) => {
        const body = await res.json()
        if (cancelled) return
        if (!res.ok) {
          setError(body?.error?.message ?? 'Kunde inte ladda periodiseringar')
          return
        }
        setProposal(body.data as AccrualsProposal)
      })
      .catch(() => {
        if (!cancelled) setError('Kunde inte ladda periodiseringar')
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [periodId])

  const addManual = useCallback((kind: ManualEntry['kind']) => {
    setManual((prev) => [
      ...prev,
      {
        id: makeId(),
        kind,
        amount: '',
        description: '',
        expenseAccount: kind === 'audit_fee' ? '6420' : '',
        prepaidAccount: '',
        accruedAccount: '',
        liabilityAccount: '2992',
      },
    ])
  }, [])

  const removeManual = useCallback((id: string) => {
    setManual((prev) => prev.filter((m) => m.id !== id))
  }, [])

  const updateManual = useCallback((id: string, patch: Partial<ManualEntry>) => {
    setManual((prev) => prev.map((m) => (m.id === id ? { ...m, ...patch } : m)))
  }, [])

  const handleCommit = useCallback(async () => {
    if (!proposal) return
    setPosting(true)
    try {
      const items: unknown[] = []
      if (proposal.proposals.find((p) => p.kind === 'vacation_liability_change') && auto.vacation.accept) {
        items.push({ kind: 'vacation_liability_change' })
      }
      for (const m of manual) {
        const amount = parseFloat(m.amount)
        if (!Number.isFinite(amount) || amount <= 0) continue
        if (m.kind === 'audit_fee') {
          items.push({ kind: 'audit_fee', amount, liability_account: m.liabilityAccount })
        } else if (m.kind === 'manual_prepaid_expense') {
          if (!m.expenseAccount || !m.prepaidAccount || !m.description) continue
          items.push({
            kind: 'manual_prepaid_expense',
            amount,
            expense_account: m.expenseAccount,
            prepaid_account: m.prepaidAccount,
            description: m.description,
          })
        } else if (m.kind === 'manual_accrued_expense') {
          if (!m.expenseAccount || !m.accruedAccount || !m.description) continue
          items.push({
            kind: 'manual_accrued_expense',
            amount,
            expense_account: m.expenseAccount,
            accrued_account: m.accruedAccount,
            description: m.description,
          })
        }
      }
      if (items.length === 0) {
        onContinue()
        return
      }
      const res = await fetch(`/api/bookkeeping/fiscal-periods/${periodId}/accruals`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ items }),
      })
      const body = await res.json()
      if (!res.ok) {
        setError(body?.error?.message ?? 'Kunde inte bokföra periodiseringarna')
        return
      }
      const created = body.data?.created?.length ?? 0
      toast({
        title: `${created} periodisering${created === 1 ? '' : 'ar'} bokförd${
          created === 1 ? '' : 'a'
        }`,
        description: 'Vänd dem första dagen i nästa räkenskapsår.',
      })
      onContinue()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Okänt fel')
    } finally {
      setPosting(false)
    }
  }, [proposal, auto, manual, periodId, onContinue, toast])

  if (loading) {
    return (
      <Card>
        <CardContent className="p-6 space-y-2">
          <Skeleton className="h-6 w-1/3" />
          <Skeleton className="h-20 w-full" />
        </CardContent>
      </Card>
    )
  }

  if (error && !proposal) {
    return (
      <Card>
        <CardContent className="p-6 text-destructive">{error}</CardContent>
      </Card>
    )
  }

  if (!proposal) return null

  const vacation = proposal.proposals.find((p) => p.kind === 'vacation_liability_change')

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Periodiseringar</CardTitle>
          <p className="text-sm text-muted-foreground">
            Förutbetalda kostnader (17xx) och upplupna kostnader (29xx). Posteringarna
            ska vändas på första dagen av nästa räkenskapsår: datumet visas per
            verifikation. Automatisk omvändning är planerad till en kommande version.
          </p>
        </CardHeader>
      </Card>

      {vacation && (
        <Card>
          <CardHeader>
            <div className="flex items-start justify-between gap-4">
              <div className="flex-1">
                <CardTitle className="text-base">{vacation.label}</CardTitle>
                <p className="text-sm text-muted-foreground mt-1">{vacation.description}</p>
                {vacation.reverses_on ? (
                  <Badge variant="outline" className="mt-2">
                    Vänds {vacation.reverses_on}
                  </Badge>
                ) : (
                  <Badge variant="outline" className="mt-2">
                    Rullas vidare (ingen vändning)
                  </Badge>
                )}
              </div>
              <p className="font-display text-2xl tabular-nums shrink-0">
                {formatCurrency(vacation.amount)}
              </p>
            </div>
          </CardHeader>
          <CardContent>
            <div className="flex items-center gap-2">
              <Checkbox
                id="accept-vacation"
                checked={auto.vacation.accept}
                onCheckedChange={(c) => setAuto({ vacation: { accept: Boolean(c) } })}
              />
              <Label htmlFor="accept-vacation" className="text-sm cursor-pointer select-none">
                Boka denna justering
              </Label>
            </div>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Manuella periodiseringar</CardTitle>
          <p className="text-sm text-muted-foreground">
            Lägg till revisionsarvode, hyra som löper över årsskiftet, förutbetalda
            försäkringar m.m.
          </p>
        </CardHeader>
        <CardContent className="space-y-4">
          {manual.length === 0 && (
            <p className="text-sm text-muted-foreground italic">Inga manuella periodiseringar tillagda än.</p>
          )}
          {manual.map((m) => (
            <ManualEntryEditor
              key={m.id}
              entry={m}
              onChange={(patch) => updateManual(m.id, patch)}
              onRemove={() => removeManual(m.id)}
            />
          ))}
          <div className="flex flex-wrap gap-2 pt-2">
            <Button variant="outline" size="sm" onClick={() => addManual('audit_fee')}>
              <Plus className="mr-1 h-3.5 w-3.5" /> Revisions-/bokslutsarvode
            </Button>
            <Button variant="outline" size="sm" onClick={() => addManual('manual_prepaid_expense')}>
              <Plus className="mr-1 h-3.5 w-3.5" /> Förutbetald kostnad
            </Button>
            <Button variant="outline" size="sm" onClick={() => addManual('manual_accrued_expense')}>
              <Plus className="mr-1 h-3.5 w-3.5" /> Upplupen kostnad
            </Button>
          </div>
        </CardContent>
      </Card>

      {error && (
        <Card>
          <CardContent className="p-4 text-sm text-destructive">{error}</CardContent>
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
              Fortsätt <ArrowRight className="ml-1 h-4 w-4" />
            </>
          )}
        </Button>
      </div>
    </div>
  )
}

function ManualEntryEditor({
  entry,
  onChange,
  onRemove,
}: {
  entry: ManualEntry
  onChange: (patch: Partial<ManualEntry>) => void
  onRemove: () => void
}) {
  return (
    <div className="rounded-md border border-border p-3 space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-sm font-medium">
          {entry.kind === 'audit_fee' && 'Revisions-/bokslutsarvode'}
          {entry.kind === 'manual_prepaid_expense' && 'Förutbetald kostnad'}
          {entry.kind === 'manual_accrued_expense' && 'Upplupen kostnad'}
        </p>
        <Button variant="ghost" size="sm" aria-label="Ta bort post" onClick={onRemove} className="h-7 px-2">
          <Trash2 className="h-3.5 w-3.5" />
        </Button>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1">
          <Label className="text-xs">Belopp (kr)</Label>
          <Input
            type="number"
            step="1"
            min="0"
            value={entry.amount}
            onChange={(e) => onChange({ amount: e.target.value })}
            className="tabular-nums h-8"
          />
        </div>
        {entry.kind === 'audit_fee' && (
          <div className="space-y-1">
            <Label className="text-xs">Konto</Label>
            <select
              className="border border-border rounded-md h-8 text-sm px-2 w-full bg-background"
              value={entry.liabilityAccount}
              onChange={(e) =>
                onChange({ liabilityAccount: e.target.value as '2991' | '2992' })
              }
            >
              <option value="2992">2992: Revision</option>
              <option value="2991">2991: Bokslut</option>
            </select>
          </div>
        )}
        {entry.kind !== 'audit_fee' && (
          <>
            <div className="space-y-1">
              <Label className="text-xs">Kostnadskonto</Label>
              <Input
                value={entry.expenseAccount}
                onChange={(e) => onChange({ expenseAccount: e.target.value })}
                placeholder="t.ex. 6310"
                className="tabular-nums h-8"
              />
            </div>
            {entry.kind === 'manual_prepaid_expense' && (
              <div className="space-y-1">
                <Label className="text-xs">17xx-konto</Label>
                <Input
                  value={entry.prepaidAccount}
                  onChange={(e) => onChange({ prepaidAccount: e.target.value })}
                  placeholder="t.ex. 1730"
                  className="tabular-nums h-8"
                />
              </div>
            )}
            {entry.kind === 'manual_accrued_expense' && (
              <div className="space-y-1">
                <Label className="text-xs">29xx-konto</Label>
                <Input
                  value={entry.accruedAccount}
                  onChange={(e) => onChange({ accruedAccount: e.target.value })}
                  placeholder="t.ex. 2990"
                  className="tabular-nums h-8"
                />
              </div>
            )}
            <div className="space-y-1 col-span-2">
              <Label className="text-xs">Beskrivning</Label>
              <Input
                value={entry.description}
                onChange={(e) => onChange({ description: e.target.value })}
                placeholder="t.ex. Försäkring 2026"
                className="h-8"
              />
            </div>
          </>
        )}
      </div>
    </div>
  )
}
