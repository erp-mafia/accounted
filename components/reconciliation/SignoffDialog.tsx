'use client'

import { useEffect, useRef, useState } from 'react'
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
 *
 * Whether the override is needed comes from the server, not from the page
 * tile: on open and on every date change the dialog previews the exact
 * sign-off (dry run), because the server judges its own window (fiscal
 * period start to the date) while the tile is scoped to whatever period or
 * range the page has picked. Judging from the tile let the signer press
 * Signera on a sign-off the server then refused.
 */
export interface SignoffSubmitInput {
  through_date: string
  note: string | null
  force: boolean
  external_balance?: number | null
}

export type SignoffPreviewResult =
  /** The server would sign as-is; `unexplained` is what it would record. */
  | { kind: 'ok'; unexplained: number | null }
  /** The server refuses without the override: an unexplained difference (null = the outside balance is unknown). */
  | { kind: 'needs_force'; unexplained: number | null }
  /** Refused for a reason the override does not lift (already signed through a later date, date in the future, ...). */
  | { kind: 'blocked'; message: string }

interface SignoffDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  accountName: string
  /** Default through-date (the window end, clamped to today). */
  defaultDate: string
  /** Latest possible date (today, or the skattekonto snapshot date). */
  maxDate: string
  /** The page tile's number: the starting point until the preview answers. */
  unexplained: number | null
  currency: string
  /** Ask for the balance per underlag (manual accounts without a system specification). */
  askExternalBalance?: boolean
  /** The booked balance the stated one is compared with. */
  ledgerBalance?: number | null
  /** Dry-run the sign-off for a date; the verdict decides whether the override is asked for. */
  onPreview?: (input: SignoffSubmitInput) => Promise<SignoffPreviewResult>
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
  onPreview,
  onSubmit,
}: SignoffDialogProps) {
  const t = useTranslations('reconciliation')
  const [date, setDate] = useState(defaultDate)
  const [note, setNote] = useState('')
  const [force, setForce] = useState(false)
  const [external, setExternal] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [preview, setPreview] = useState<SignoffPreviewResult | null>(null)
  const [previewing, setPreviewing] = useState(false)
  // Only the latest preview may land: a quick date edit fires two requests
  // and the slower one must not overwrite the newer verdict.
  const previewSeq = useRef(0)
  // The parent passes a fresh function each render; reading it through a ref
  // keeps the preview effect keyed on the date alone.
  const onPreviewRef = useRef(onPreview)
  onPreviewRef.current = onPreview

  // Reset per opening so a second sign-off does not inherit the last one's
  // note or override choice.
  useEffect(() => {
    if (open) {
      setDate(defaultDate)
      setNote('')
      setForce(false)
      setExternal('')
      setError(null)
      setPreview(null)
    }
  }, [open, defaultDate])

  // Ask the server what it would do with this exact date. A manual account
  // that takes a stated balance is judged locally against the booked balance
  // below, so it is not previewed (the preview would only say "unknown").
  useEffect(() => {
    const previewFn = onPreviewRef.current
    if (!open || !previewFn || askExternalBalance || date.length !== 10) return
    const seq = ++previewSeq.current
    setPreviewing(true)
    previewFn({ through_date: date, note: null, force: false })
      .then((result) => {
        if (seq === previewSeq.current) setPreview(result)
      })
      .catch(() => {
        // Network failure: fall back to the tile's number rather than block.
        if (seq === previewSeq.current) setPreview(null)
      })
      .finally(() => {
        if (seq === previewSeq.current) setPreviewing(false)
      })
  }, [open, date, askExternalBalance])

  // With a stated balance the difference is against the booked balance;
  // otherwise the server's preview decides, and until it has answered the
  // engine's number from the page tile (or "unknown") stands in.
  const stated = askExternalBalance ? parseAmount(external) : null
  const blocked = preview?.kind === 'blocked' ? preview.message : null
  const previewUnexplained = preview && preview.kind !== 'blocked' ? preview.unexplained : unexplained
  const effectiveUnexplained =
    stated != null && ledgerBalance != null ? roundOre(ledgerBalance - stated) : previewUnexplained
  const needsForce =
    preview?.kind === 'ok' && stated == null
      ? false
      : effectiveUnexplained == null || Math.abs(effectiveUnexplained) >= 0.005

  const canSubmit =
    !busy &&
    !previewing &&
    blocked === null &&
    date.length === 10 &&
    (!needsForce || (force && note.trim().length > 0))

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
            {previewing && <p className="text-[12px] text-muted-foreground">{t('signoff_preview_pending')}</p>}
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
          {blocked === null && needsForce && (
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
          {(error ?? blocked) && (
            <p role="alert" className="text-[13px] text-destructive">
              {error ?? blocked}
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
