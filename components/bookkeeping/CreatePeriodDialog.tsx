'use client'

import { useState, useMemo } from 'react'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { useToast } from '@/components/ui/use-toast'
import { Loader2, Lock } from 'lucide-react'
import { computeSuggestedPeriod } from '@/lib/bookkeeping/suggest-fiscal-period'
import type { FiscalPeriod } from '@/types'

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
  entryDate: string
  periods: FiscalPeriod[]
  onCreated: () => void
}

/** A prior period that must be locked before a new fiscal year can be created. */
interface BlockingPeriod {
  id: string
  name: string
  period_start: string
  period_end: string
}

/** Read a user-facing message from either a legacy string error or the
 *  canonical { code, message } envelope. */
function errorMessage(err: unknown, fallback = 'Ett oväntat fel uppstod.'): string {
  if (typeof err === 'string') return err
  if (err && typeof err === 'object' && typeof (err as { message?: unknown }).message === 'string') {
    return (err as { message: string }).message
  }
  return fallback
}

export default function CreatePeriodDialog({ open, onOpenChange, entryDate, periods, onCreated }: Props) {
  const { toast } = useToast()
  const suggested = useMemo(() => computeSuggestedPeriod(entryDate, periods), [entryDate, periods])

  const [name, setName] = useState(suggested.name)
  const [periodStart, setPeriodStart] = useState(suggested.period_start)
  const [periodEnd, setPeriodEnd] = useState(suggested.period_end)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [isLocking, setIsLocking] = useState(false)
  // Set when creation is blocked because a prior räkenskapsår is still open.
  // The user can lock these inline and retry without leaving the dialog.
  const [blockingPeriods, setBlockingPeriods] = useState<BlockingPeriod[]>([])

  // Reset form when suggested values change (dialog reopened with new date)
  const [lastSuggested, setLastSuggested] = useState(suggested)
  if (suggested.name !== lastSuggested.name || suggested.period_start !== lastSuggested.period_start) {
    setName(suggested.name)
    setPeriodStart(suggested.period_start)
    setPeriodEnd(suggested.period_end)
    setLastSuggested(suggested)
    setBlockingPeriods([])
  }

  const handleCreate = async () => {
    setIsSubmitting(true)
    try {
      const res = await fetch('/api/bookkeeping/fiscal-periods', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, period_start: periodStart, period_end: periodEnd }),
      })

      const result = await res.json()

      if (!res.ok) {
        const err = result?.error
        // Blocked by an open prior year: surface an inline "lås och försök
        // igen" path instead of a dead-end toast.
        if (
          err &&
          typeof err === 'object' &&
          err.code === 'PERIOD_CREATE_BLOCKED_BY_OPEN_PERIODS'
        ) {
          const blocking = (err.details?.blockingPeriods ?? []) as BlockingPeriod[]
          setBlockingPeriods(blocking)
          return
        }
        toast({
          title: 'Kunde inte skapa räkenskapsår',
          description: errorMessage(err),
          variant: 'destructive',
        })
        return
      }

      toast({ title: 'Räkenskapsår skapat', description: `${name} har skapats.` })
      setBlockingPeriods([])
      onOpenChange(false)
      onCreated()
    } catch {
      toast({
        title: 'Kunde inte skapa räkenskapsår',
        description: 'Ett nätverksfel uppstod. Försök igen.',
        variant: 'destructive',
      })
    } finally {
      setIsSubmitting(false)
    }
  }

  // Lock each blocking prior year (reversible locked_at), then retry creation.
  const handleLockAndRetry = async () => {
    setIsLocking(true)
    try {
      for (const p of blockingPeriods) {
        const res = await fetch(`/api/bookkeeping/fiscal-periods/${p.id}/lock`, {
          method: 'POST',
        })
        if (!res.ok) {
          const body = await res.json().catch(() => ({}))
          // An already-locked period is fine: keep going.
          if (body?.error?.code === 'PERIOD_LOCK_ALREADY_LOCKED') continue
          toast({
            title: `Kunde inte låsa ${p.name}`,
            description: errorMessage(body?.error),
            variant: 'destructive',
          })
          return
        }
      }
      setBlockingPeriods([])
      await handleCreate()
    } catch {
      toast({
        title: 'Kunde inte låsa räkenskapsåret',
        description: 'Ett nätverksfel uppstod. Försök igen.',
        variant: 'destructive',
      })
    } finally {
      setIsLocking(false)
    }
  }

  const isBlocked = blockingPeriods.length > 0
  const busy = isSubmitting || isLocking

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Skapa räkenskapsår</DialogTitle>
          <DialogDescription>
            Det finns inget räkenskapsår som täcker datumet {entryDate}. Skapa ett nytt nedan.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div>
            <Label>Namn</Label>
            <Input value={name} onChange={(e) => setName(e.target.value)} className="mt-1" />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label>Startdatum</Label>
              <Input type="date" value={periodStart} onChange={(e) => setPeriodStart(e.target.value)} className="mt-1" />
            </div>
            <div>
              <Label>Slutdatum</Label>
              <Input type="date" value={periodEnd} onChange={(e) => setPeriodEnd(e.target.value)} className="mt-1" />
            </div>
          </div>

          {isBlocked && (
            <div className="rounded-lg border border-warning/20 bg-warning/5 p-3 text-sm flex gap-2">
              <Lock className="h-4 w-4 text-warning flex-shrink-0 mt-0.5" />
              <div className="space-y-2">
                <div className="space-y-1">
                  <p className="font-medium">Föregående räkenskapsår är öppet</p>
                  <p className="text-muted-foreground">
                    Du måste låsa föregående räkenskapsår innan du kan skapa ett nytt.
                    Låsningen är vändbar: du kan låsa upp året igen för att bokföra
                    bokslutsposter.
                  </p>
                </div>
                <ul className="space-y-0.5 text-muted-foreground">
                  {blockingPeriods.map((p) => (
                    <li key={p.id} className="tabular-nums">
                      {p.name} ({p.period_start} till {p.period_end})
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
            Avbryt
          </Button>
          {isBlocked ? (
            <Button onClick={handleLockAndRetry} disabled={busy}>
              {busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {blockingPeriods.length > 1 ? 'Lås åren och skapa' : 'Lås året och skapa'}
            </Button>
          ) : (
            <Button onClick={handleCreate} disabled={busy || !name || !periodStart || !periodEnd}>
              {isSubmitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Skapa
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
