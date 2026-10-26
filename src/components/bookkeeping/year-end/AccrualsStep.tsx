'use client'

import { useCallback, useEffect, useState } from 'react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Skeleton } from '@/components/ui/skeleton'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { ArrowRightIcon } from '@/components/icons'
import { formatCurrency } from '@/lib/utils'
import { useToast } from '@/components/ui/use-toast'
import { useCompany } from '@/contexts/CompanyContext'
import type { AccrualsProposal } from '@/lib/bokslut/accruals/types'
import { buildAccrualItems, type AuditFeeState, type ManualAccrualEntry } from '@/lib/bokslut/accruals/manual-items'
import { ManualAccrualsEditor } from './ManualAccrualsEditor'
import { getErrorMessage as getUserErrorMessage } from '@/lib/errors/get-error-message'

interface AccrualsStepProps {
  periodId: string
  onBack: () => void
  onContinue: () => void
}

interface AutoState {
  vacation: { accept: boolean }
}

export function AccrualsStep({ periodId, onBack, onContinue }: AccrualsStepProps) {
  const { toast } = useToast()
  const { company } = useCompany()
  // An enskild firma has no revisor and normally closes under K1 (BFNAR
  // 2006:1, förenklat årsbokslut): its arvode row is the bokslutsarvode
  // (2991), and posts under 5 000 kr normally need not be accrued.
  const isEF = company?.entity_type === 'enskild_firma'
  const [proposal, setProposal] = useState<AccrualsProposal | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [auto, setAuto] = useState<AutoState>({ vacation: { accept: true } })
  // The fee and the manual entries share the periodisering page's model and
  // editor (lib/bokslut/accruals/manual-items, ManualAccrualsEditor): every
  // template kind and kostnadsställe/projekt on the result leg.
  const [auditFee, setAuditFee] = useState<AuditFeeState>({ enabled: false, amount: '', liabilityAccount: '2992' })
  const [manual, setManual] = useState<ManualAccrualEntry[]>([])
  // EF defaults the fee to 2991 (bokslut): it has no revision to accrue for.
  // The company row loads async, so follow it until the user touches the fee.
  const feeAccount = auditFee.enabled || auditFee.amount !== '' ? auditFee.liabilityAccount : isEF ? '2991' : '2992'
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
          setError(getUserErrorMessage(body?.error) ?? 'Kunde inte ladda periodiseringar')
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

  const handleCommit = useCallback(async () => {
    if (!proposal) return
    setPosting(true)
    try {
      const items = buildAccrualItems({
        vacation: !!proposal.proposals.find((p) => p.kind === 'vacation_liability_change') && auto.vacation.accept,
        auditFee: { ...auditFee, liabilityAccount: feeAccount },
        manual,
      })
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
        setError(getUserErrorMessage(body?.error) ?? 'Kunde inte bokföra periodiseringarna')
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
      setError(err instanceof Error ? getUserErrorMessage(err) : 'Okänt fel')
    } finally {
      setPosting(false)
    }
  }, [proposal, auto, auditFee, feeAccount, manual, periodId, onContinue, toast])

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
      {/* The step's instructions (17xx/29xx, reversal on day one of the next
          räkenskapsår, the K1 5 000 kr relief) live behind the wizard's "?". */}
      {!vacation && proposal.notices?.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Semesterlöneskuld</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {proposal.notices.map((notice) => (
              <p key={notice} className="text-sm text-muted-foreground">
                {notice}
              </p>
            ))}
          </CardContent>
        </Card>
      )}

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
            {isEF
              ? 'Lägg till bokslutsarvode, hyra som löper över årsskiftet, förutbetalda försäkringar m.m.'
              : 'Lägg till revisionsarvode, hyra som löper över årsskiftet, förutbetalda försäkringar m.m.'}
          </p>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="rounded-lg border border-border p-3 space-y-3">
            <div className="flex items-center gap-2">
              <Checkbox
                id="accrue-audit-fee"
                checked={auditFee.enabled}
                onCheckedChange={(c) => setAuditFee({ ...auditFee, enabled: Boolean(c), liabilityAccount: feeAccount })}
              />
              <Label htmlFor="accrue-audit-fee" className="text-sm cursor-pointer select-none">
                {isEF ? 'Bokslutsarvode' : 'Revisions-/bokslutsarvode'}
              </Label>
            </div>
            {auditFee.enabled && (
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1">
                  <Label className="text-xs">Belopp (kr)</Label>
                  <Input
                    type="number"
                    step="1"
                    min="0"
                    value={auditFee.amount}
                    onChange={(e) => setAuditFee({ ...auditFee, amount: e.target.value, liabilityAccount: feeAccount })}
                    className="tabular-nums h-8"
                  />
                </div>
                <div className="space-y-1">
                  <Label className="text-xs">Konto</Label>
                  <select
                    className="border border-border rounded-lg h-8 text-sm px-2 w-full bg-background"
                    value={feeAccount}
                    onChange={(e) => setAuditFee({ ...auditFee, liabilityAccount: e.target.value as '2991' | '2992' })}
                  >
                    <option value="2992">2992: Revision</option>
                    <option value="2991">2991: Bokslut</option>
                  </select>
                </div>
              </div>
            )}
          </div>
          <ManualAccrualsEditor entries={manual} onChange={setManual} />
        </CardContent>
      </Card>

      {error && (
        <Card>
          <CardContent className="p-4 text-sm text-destructive">{error}</CardContent>
        </Card>
      )}

      <div className="flex justify-between">
        <Button variant="outline" size="sm" onClick={onBack} disabled={posting}>
          ← Tillbaka
        </Button>
        <Button onClick={handleCommit} loading={posting}>
          {posting ? (
            'Bokför…'
          ) : (
            <>
              Fortsätt <ArrowRightIcon className="ml-1 h-4 w-4" />
            </>
          )}
        </Button>
      </div>
    </div>
  )
}
