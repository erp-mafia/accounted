'use client'

import { useEffect, useState } from 'react'
import { useTranslations } from 'next-intl'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { formatCurrency } from '@/lib/utils'

/**
 * "Markera som avstämd": date, optional note, and (only when the engine
 * reports an unexplained difference) the explicit "sign anyway" choice that
 * makes the note mandatory. The policy lives in lib/reconciliation/signoff.ts;
 * this dialog only collects the input and shows the server's refusal verbatim.
 */
interface SignoffDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  accountName: string
  /** Default through-date (the window end, clamped to today). */
  defaultDate: string
  /** Latest possible date (today, or the skattekonto snapshot date). */
  maxDate: string
  unexplained: number | null
  currency: string
  /** Returns an error message to show inline, or null on success. */
  onSubmit: (input: { through_date: string; note: string | null; force: boolean }) => Promise<string | null>
}

export function SignoffDialog({
  open,
  onOpenChange,
  accountName,
  defaultDate,
  maxDate,
  unexplained,
  currency,
  onSubmit,
}: SignoffDialogProps) {
  const t = useTranslations('reconciliation')
  const [date, setDate] = useState(defaultDate)
  const [note, setNote] = useState('')
  const [force, setForce] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const needsForce = unexplained == null || Math.abs(unexplained) >= 0.005

  // Reset per opening so a second sign-off does not inherit the last one's
  // note or override choice.
  useEffect(() => {
    if (open) {
      setDate(defaultDate)
      setNote('')
      setForce(false)
      setError(null)
    }
  }, [open, defaultDate])

  const canSubmit = !busy && date.length === 10 && (!needsForce || (force && note.trim().length > 0))

  async function submit() {
    setBusy(true)
    setError(null)
    try {
      const message = await onSubmit({ through_date: date, note: note.trim() || null, force: needsForce && force })
      if (message) setError(message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[440px]">
        <DialogHeader>
          <DialogTitle>{t('signoff_title')}</DialogTitle>
          <DialogDescription>{t('signoff_body', { account: accountName })}</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="signoff-date">{t('signoff_date')}</Label>
            <Input
              id="signoff-date"
              type="date"
              value={date}
              max={maxDate}
              onChange={(e) => setDate(e.target.value)}
              className="tabular-nums"
            />
          </div>
          {needsForce && (
            <div className="space-y-2 rounded-lg bg-warning/10 px-3 py-2.5 text-[13px] text-foreground">
              <p>
                {unexplained == null
                  ? t('tile_unknown')
                  : t('signoff_unexplained_warning', { amount: formatCurrency(unexplained, currency) })}
              </p>
              <label className="flex items-center gap-2 text-[13px]">
                <Checkbox checked={force} onCheckedChange={(v) => setForce(v === true)} />
                {t('signoff_force')}
              </label>
            </div>
          )}
          <div className="space-y-1.5">
            <Label htmlFor="signoff-note">{t('signoff_note')}</Label>
            <Textarea
              id="signoff-note"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder={t('signoff_note_placeholder')}
              rows={3}
            />
          </div>
          {error && (
            <p role="alert" className="text-[13px] text-destructive">
              {error}
            </p>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
            {t('signoff_cancel')}
          </Button>
          <Button onClick={() => void submit()} disabled={!canSubmit} aria-busy={busy}>
            {t('signoff_confirm')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
