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
import { roundOre } from '@/lib/money'

/**
 * "Markera som avstämd": date, optional note, and (only when the engine
 * reports an unexplained difference) the explicit "sign anyway" choice that
 * makes the note mandatory. A manual account without a system specification
 * also asks for the balance per the signer's underlag; the difference against
 * the booked balance is then what needs explaining. The policy lives in
 * lib/reconciliation/signoff.ts; this dialog only collects the input and
 * shows the server's refusal verbatim.
 */
export interface SignoffSubmitInput {
  through_date: string
  note: string | null
  force: boolean
  external_balance?: number | null
}

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
  /** Ask for the balance per underlag (manual accounts without a system specification). */
  askExternalBalance?: boolean
  /** The booked balance the stated one is compared with. */
  ledgerBalance?: number | null
  /** Returns an error message to show inline, or null on success. */
  onSubmit: (input: SignoffSubmitInput) => Promise<string | null>
}

function parseAmount(raw: string): number | null {
  const normalized = raw.replace(/\s/g, '').replace(',', '.')
  if (normalized === '' || normalized === '-') return null
  const n = Number(normalized)
  return Number.isFinite(n) ? roundOre(n) : null
}

export function SignoffDialog({
  open,
  onOpenChange,
  accountName,
  defaultDate,
  maxDate,
  unexplained,
  currency,
  askExternalBalance = false,
  ledgerBalance = null,
  onSubmit,
}: SignoffDialogProps) {
  const t = useTranslations('reconciliation')
  const [date, setDate] = useState(defaultDate)
  const [note, setNote] = useState('')
  const [force, setForce] = useState(false)
  const [external, setExternal] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  // With a stated balance the difference is against the booked balance;
  // without one the engine's number (or "unknown") decides.
  const stated = askExternalBalance ? parseAmount(external) : null
  const effectiveUnexplained =
    stated != null && ledgerBalance != null ? roundOre(ledgerBalance - stated) : unexplained
  const needsForce = effectiveUnexplained == null || Math.abs(effectiveUnexplained) >= 0.005

  // Reset per opening so a second sign-off does not inherit the last one's
  // note or override choice.
  useEffect(() => {
    if (open) {
      setDate(defaultDate)
      setNote('')
      setForce(false)
      setExternal('')
      setError(null)
    }
  }, [open, defaultDate])

  const canSubmit = !busy && date.length === 10 && (!needsForce || (force && note.trim().length > 0))

  async function submit() {
    setBusy(true)
    setError(null)
    try {
      const message = await onSubmit({
        through_date: date,
        note: note.trim() || null,
        force: needsForce && force,
        ...(askExternalBalance ? { external_balance: stated } : {}),
      })
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
          {askExternalBalance && (
            <div className="space-y-1.5">
              <Label htmlFor="signoff-external">{t('signoff_external_balance')}</Label>
              <Input
                id="signoff-external"
                inputMode="decimal"
                value={external}
                onChange={(e) => setExternal(e.target.value)}
                placeholder="0,00"
                className="tabular-nums"
              />
              <p className="text-[12px] text-muted-foreground">
                {ledgerBalance != null
                  ? t('signoff_external_balance_help', { amount: formatCurrency(ledgerBalance, currency) })
                  : t('signoff_external_balance_optional')}
              </p>
            </div>
          )}
          {needsForce && (
            <div className="space-y-2 rounded-lg bg-warning/10 px-3 py-2.5 text-[13px] text-foreground">
              <p>
                {effectiveUnexplained == null
                  ? askExternalBalance
                    ? t('signoff_external_balance_optional')
                    : t('tile_unknown')
                  : t('signoff_unexplained_warning', { amount: formatCurrency(effectiveUnexplained, currency) })}
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
