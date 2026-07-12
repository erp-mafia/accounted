'use client'

import { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { useToast } from '@/components/ui/use-toast'
import { getErrorMessage } from '@/lib/errors/get-error-message'
import { AlertTriangle, Lock, ArrowRight } from 'lucide-react'
import { formatDate } from '@/lib/utils'
import { formatVoucher } from '@/lib/bookkeeping/voucher-series-resolver'
import type { JournalEntry } from '@/types'

interface Props {
  entry: JournalEntry
  open: boolean
  onOpenChange: (open: boolean) => void
  onMoved: () => void
}

type PeriodStatus = {
  status: 'open' | 'locked' | 'closed'
  period_id: string | null
  lock_date: string | null
  period_name: string | null
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

export default function RecordateEntryDialog({ entry, open, onOpenChange, onMoved }: Props) {
  const { toast } = useToast()
  const router = useRouter()
  const [newDate, setNewDate] = useState(entry.entry_date)
  const [preview, setPreview] = useState<PeriodStatus | null>(null)
  const [previewLoading, setPreviewLoading] = useState(false)
  const [previewError, setPreviewError] = useState<string | null>(null)
  const [isSubmitting, setIsSubmitting] = useState(false)

  // Reset to the original date each time the dialog opens.
  useEffect(() => {
    if (open) {
      setNewDate(entry.entry_date)
      setPreview(null)
      setPreviewError(null)
    }
  }, [open, entry.entry_date])

  // Resolve the target period status whenever a valid, changed date is entered.
  useEffect(() => {
    if (!open) return
    if (!ISO_DATE.test(newDate) || newDate === entry.entry_date) {
      setPreview(null)
      setPreviewError(null)
      return
    }
    let cancelled = false
    setPreviewLoading(true)
    setPreviewError(null)
    const handle = setTimeout(async () => {
      try {
        const res = await fetch(
          `/api/bookkeeping/fiscal-periods/period-status?date=${encodeURIComponent(newDate)}`
        )
        if (!res.ok) throw new Error('period_status_failed')
        const { data } = await res.json()
        if (!cancelled) {
          setPreview((data as PeriodStatus) ?? null)
          setPreviewError(null)
        }
      } catch {
        if (!cancelled) {
          setPreview(null)
          setPreviewError('Kunde inte kontrollera perioden. Försök igen.')
        }
      } finally {
        if (!cancelled) setPreviewLoading(false)
      }
    }, 250)
    return () => {
      cancelled = true
      clearTimeout(handle)
    }
  }, [newDate, open, entry.entry_date])

  const dateChanged = ISO_DATE.test(newDate) && newDate !== entry.entry_date
  const targetOpen = preview?.status === 'open' && !!preview?.period_id
  const noCoveringPeriod = preview?.status === 'open' && !preview?.period_id
  // Soft, non-blocking advisory when moving into a past date: the moms for
  // that period may already have been filed.
  const today = new Date().toISOString().slice(0, 10)
  const movingIntoPast = dateChanged && newDate < today

  const canSubmit = dateChanged && targetOpen && !isSubmitting

  async function handleSubmit() {
    if (!canSubmit) return
    setIsSubmitting(true)
    try {
      const res = await fetch(`/api/bookkeeping/journal-entries/${entry.id}/recordate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ new_entry_date: newDate }),
      })
      const result = await res.json()
      if (!res.ok) {
        const error = new Error('Failed to move entry') as Error & { body?: unknown; status?: number }
        error.body = result
        error.status = res.status
        throw error
      }
      const correctedId = result.data?.corrected?.id
      toast({
        title: 'Verifikationen flyttad',
        description: 'En storno och en rättelse med rätt datum har bokförts.',
        action: correctedId ? (
          <Button variant="outline" size="sm" onClick={() => router.push(`/bookkeeping/${correctedId}`)}>
            Visa rättelsen
          </Button>
        ) : undefined,
      })
      onOpenChange(false)
      onMoved()
    } catch (err) {
      const anyErr = err as { body?: unknown; status?: number }
      toast({
        title: 'Kunde inte flytta verifikationen',
        description: getErrorMessage(anyErr.body ?? err, { context: 'journal_entry', statusCode: anyErr.status }),
        variant: 'destructive',
      })
    } finally {
      setIsSubmitting(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Rätta datum</DialogTitle>
        </DialogHeader>

        {/* Explanation */}
        <div className="rounded-lg bg-muted/50 border p-3 text-sm text-muted-foreground">
          <p className="font-medium text-foreground mb-1">Flytta verifikationen till rätt datum</p>
          <p>
            En bokförd verifikation kan inte ändras direkt. Raderna behålls oförändrade: istället
            skapas automatiskt:
          </p>
          <ol className="list-decimal list-inside mt-1 space-y-0.5">
            <li>En <strong>stornoverifikation</strong> som nollställer originalet i sin period</li>
            <li>En ny verifikation med samma rader, bokförd på det nya datumet</li>
          </ol>
        </div>

        {/* Original */}
        <div className="space-y-1">
          <div className="flex items-center gap-2 text-sm text-muted-foreground flex-wrap">
            <span className="font-mono">{formatVoucher(entry)}</span>
            <span className="tabular-nums">{formatDate(entry.entry_date)}</span>
            <Badge variant="outline" className="text-xs">Original</Badge>
          </div>
          <p className="text-sm">{entry.description}</p>
        </div>

        {/* New date */}
        <div className="space-y-2">
          <label htmlFor="recordate-date" className="text-sm font-medium">
            Nytt datum
          </label>
          <Input
            id="recordate-date"
            type="date"
            value={newDate}
            onChange={(e) => setNewDate(e.target.value)}
            className="tabular-nums"
          />

          {/* Target period feedback */}
          {dateChanged && (
            <div className="text-sm" aria-live="polite">
              {previewLoading && <span className="text-muted-foreground">Kontrollerar period…</span>}

              {!previewLoading && previewError && (
                <span className="inline-flex items-center gap-1.5 text-destructive">
                  <AlertTriangle className="h-4 w-4" />
                  {previewError}
                </span>
              )}

              {!previewLoading && !previewError && targetOpen && (
                <span className="inline-flex items-center gap-1.5 text-muted-foreground">
                  <ArrowRight className="h-4 w-4" />
                  Flyttas till {preview?.period_name ?? 'rätt räkenskapsår'}
                </span>
              )}

              {!previewLoading && noCoveringPeriod && (
                <span className="text-destructive">
                  Det finns ingen räkenskapsperiod som täcker datumet. Skapa eller öppna räkenskapsåret först.
                </span>
              )}

              {!previewLoading && preview?.status === 'closed' && (
                <span className="text-destructive">
                  Räkenskapsåret är stängt (bokslut) och kan inte återöppnas. Bokför rättelsen i innevarande period istället.
                </span>
              )}

              {!previewLoading && preview?.status === 'locked' && (
                <span className="inline-flex items-center gap-1.5 text-destructive">
                  <Lock className="h-4 w-4" />
                  Perioden är låst{preview?.lock_date ? ` t.o.m. ${formatDate(preview.lock_date)}` : ''}. Lås upp perioden för att flytta verifikationen dit.
                </span>
              )}
            </div>
          )}

          {/* Soft advisory: moving into a past period */}
          {targetOpen && movingIntoPast && (
            <p className="inline-flex items-start gap-1.5 text-sm text-muted-foreground">
              <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
              <span>
                Om momsen för perioden redan är inlämnad kan du behöva lämna en rättad momsdeklaration.
              </span>
            </p>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={isSubmitting}>
            Avbryt
          </Button>
          <Button onClick={handleSubmit} disabled={!canSubmit}>
            {isSubmitting ? 'Flyttar…' : 'Flytta verifikationen'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
