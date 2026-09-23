'use client'

import { useState, useMemo } from 'react'
import { useTranslations } from 'next-intl'
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
import { AttnLine } from '@/components/ui/attn-line'
import { useToast } from '@/components/ui/use-toast'
import { Loader2 } from 'lucide-react'
import { computeSuggestedPeriod, fiscalYearName } from '@/lib/bookkeeping/suggest-fiscal-period'
import { fiscalPeriodAdvisoryText } from '@/lib/bookkeeping/fiscal-period-warnings'
import type { FiscalPeriod } from '@/types'
import { invalidateReferenceData } from '@/lib/reference-data/invalidate'

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
  entryDate: string
  periods: FiscalPeriod[]
  onCreated: () => void
}

/** A räkenskapsår that was just created, together with the non-blocking
 *  advisory the route attached to the 200. Only set when there is one. */
interface CreatedWithAdvisory {
  name: string
  periodStart: string
  periodEnd: string
  advisory: string
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
  // The form copy below is pre-existing hardcoded Swedish and is left as it
  // stands (out of scope here). Every string added for the created-state is
  // keyed in both messages/sv.json and messages/en.json. The advisory itself is
  // not keyed: the route emits one Swedish sentence and no English twin, and
  // bokslut/räkenskapsår domain copy stays Swedish in both locales anyway
  // (.claude/rules/i18n.md).
  const t = useTranslations('bookkeeping')
  const tCommon = useTranslations('common')
  const suggested = useMemo(() => computeSuggestedPeriod(entryDate, periods), [entryDate, periods])

  const [name, setName] = useState(suggested.name)
  // The name follows the dates until the user types a name of their own.
  // Without this the seed suggestion (the next forward year, e.g.
  // "Räkenskapsår 2027") survived the user re-dating the form to a backfilled
  // first year and was saved verbatim.
  const [nameEdited, setNameEdited] = useState(false)
  const [periodStart, setPeriodStart] = useState(suggested.period_start)
  const [periodEnd, setPeriodEnd] = useState(suggested.period_end)
  const [isSubmitting, setIsSubmitting] = useState(false)
  // Set when the period was created AND the route attached an advisory. The
  // dialog then holds on a done-state so the sentence is actually read.
  const [created, setCreated] = useState<CreatedWithAdvisory | null>(null)

  // Reset form when suggested values change (dialog reopened with new date)
  const [lastSuggested, setLastSuggested] = useState(suggested)
  if (suggested.name !== lastSuggested.name || suggested.period_start !== lastSuggested.period_start) {
    setName(suggested.name)
    setNameEdited(false)
    setPeriodStart(suggested.period_start)
    setPeriodEnd(suggested.period_end)
    setLastSuggested(suggested)
    setCreated(null)
  }

  // A date input yields '' while incomplete and a full YYYY-MM-DD otherwise:
  // only derive a name once both ends are known.
  const updateDates = (start: string, end: string) => {
    setPeriodStart(start)
    setPeriodEnd(end)
    if (!nameEdited && start && end) setName(fiscalYearName(start, end))
  }

  // Close, and refetch in the parent if this session created a period. The
  // refetch is deferred to here on the advisory path on purpose: it swaps the
  // `periods` prop, which resets the form above, and that would pull the
  // advisory off screen before it was read.
  const handleClose = () => {
    const didCreate = created !== null
    setCreated(null)
    onOpenChange(false)
    if (didCreate) onCreated()
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
        toast({
          title: 'Kunde inte skapa räkenskapsår',
          description: errorMessage(result?.error),
          variant: 'destructive',
        })
        return
      }

      // Every picker and form reads periods from the session cache
      // (lib/reference-data): refresh it now so the new year is selectable
      // everywhere at once, not only in the caller that gets onCreated.
      void invalidateReferenceData('ref:fiscal-periods')

      // The 200 may carry non-blocking advisories (today: a prior räkenskapsår
      // still open, which is the normal state while the bokslut runs). The
      // period WAS created, so this is information, never a failure: show the
      // done-state with one ochre sentence rather than flashing a toast past.
      const advisory = fiscalPeriodAdvisoryText(result)
      if (advisory) {
        setCreated({ name, periodStart, periodEnd, advisory })
        return
      }

      toast({ title: 'Räkenskapsår skapat', description: `${name} har skapats.` })
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

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? onOpenChange(true) : handleClose())}>
      <DialogContent>
        {created ? (
          <>
            <DialogHeader>
              <DialogTitle>{t('period_created_title')}</DialogTitle>
              <DialogDescription className="tabular-nums">
                {t('period_created_range', {
                  name: created.name,
                  start: created.periodStart,
                  end: created.periodEnd,
                })}
              </DialogDescription>
            </DialogHeader>

            {/* Attention is one ochre sentence, not a banner (UI-migration
                convention 6). The text is the route's own Swedish domain copy,
                which stays Swedish in both locales. */}
            <AttnLine>{created.advisory}</AttnLine>

            <DialogFooter>
              <Button onClick={handleClose}>{tCommon('close')}</Button>
            </DialogFooter>
          </>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle>Skapa räkenskapsår</DialogTitle>
              <DialogDescription>
                Det finns inget räkenskapsår som täcker datumet {entryDate}. Skapa ett nytt nedan.
              </DialogDescription>
            </DialogHeader>

            <div className="space-y-3">
              <div>
                <Label>Namn</Label>
                <Input
                  value={name}
                  onChange={(e) => {
                    setName(e.target.value)
                    setNameEdited(true)
                  }}
                  className="mt-1"
                />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <Label>Startdatum</Label>
                  <Input type="date" value={periodStart} onChange={(e) => updateDates(e.target.value, periodEnd)} className="mt-1" />
                </div>
                <div>
                  <Label>Slutdatum</Label>
                  <Input type="date" value={periodEnd} onChange={(e) => updateDates(periodStart, e.target.value)} className="mt-1" />
                </div>
              </div>
            </div>

            <DialogFooter>
              <Button variant="outline" onClick={() => onOpenChange(false)} disabled={isSubmitting}>
                Avbryt
              </Button>
              <Button onClick={handleCreate} disabled={isSubmitting || !name || !periodStart || !periodEnd}>
                {isSubmitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                Skapa
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}
