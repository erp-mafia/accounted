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
import { InfoTooltip } from '@/components/ui/info-tooltip'
import { formatCurrency, formatDate } from '@/lib/utils'
import { roundOre, parseAmountInput } from '@/lib/money'
import type { SignoffBankBalance, SignoffWarningCode } from '@/lib/reconciliation/signoff'

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
 *
 * On a bank account the preview also carries the bank's own balance against
 * the books on the date, and the server's warning when they differ or the
 * bank has none for the date. The dialog shows it before Signera and never
 * blocks on it. A bank account no bank connection feeds may also take the
 * statement's balance, held against the booked balance on the date that the
 * preview reads, as a manual account's underlag is.
 */
export interface SignoffSubmitInput {
  through_date: string
  note: string | null
  force: boolean
  external_balance?: number | null
}

/** The bank's balance against the books on the date, with the server's warning code (null when they agree). */
export interface SignoffPreviewBank {
  balance: SignoffBankBalance
  warning: SignoffWarningCode | null
}

export type SignoffPreviewResult =
  /** The server would sign as-is; `unexplained` is what it would record. */
  | { kind: 'ok'; unexplained: number | null; bank?: SignoffPreviewBank | null }
  /** The server refuses without the override: an unexplained difference (null = the outside balance is unknown). */
  | { kind: 'needs_force'; unexplained: number | null; bank?: SignoffPreviewBank | null }
  /** Refused for a reason the override does not lift (already signed through a later date, date in the future, ...). */
  | { kind: 'blocked'; message: string }

interface SignoffDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  accountName: string
  /** The ledger account the bank balance is compared with (bank accounts). */
  accountNumber?: string
  /** Default through-date (the window end, clamped to today). */
  defaultDate: string
  /** Latest possible date (today, or the skattekonto snapshot date). */
  maxDate: string
  /** The page tile's number: the starting point until the preview answers. */
  unexplained: number | null
  currency: string
  /** Ask for the balance per underlag (manual accounts without a system specification). */
  askExternalBalance?: boolean
  /** Offer the statement's balance (bank accounts without a bank connection); optional. */
  askStatementBalance?: boolean
  /** The booked balance the stated one is compared with. */
  ledgerBalance?: number | null
  /** Dry-run the sign-off for a date; the verdict decides whether the override is asked for. */
  onPreview?: (input: SignoffSubmitInput) => Promise<SignoffPreviewResult>
  /** Returns an error message to show inline, or null on success. */
  onSubmit: (input: SignoffSubmitInput) => Promise<string | null>
}

export function SignoffDialog({
  open,
  onOpenChange,
  accountName,
  accountNumber = '',
  defaultDate,
  maxDate,
  unexplained,
  currency,
  askExternalBalance = false,
  askStatementBalance = false,
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
  const asksBalance = askExternalBalance || askStatementBalance
  const stated = asksBalance ? parseAmountInput(external) : null
  // Typed but not a number: never signed as if nothing were typed.
  const statedUnreadable = asksBalance && external.trim() !== '' && stated == null
  const blocked = preview?.kind === 'blocked' ? preview.message : null
  const previewUnexplained = preview && preview.kind !== 'blocked' ? preview.unexplained : unexplained
  const previewBank = !previewing && preview && preview.kind !== 'blocked' ? (preview.bank ?? null) : null
  // A bank account's booked balance at the end of the date is the preview's
  // (its page figure is the period's movement); unknown until it answers.
  const bookedForStated = askStatementBalance ? (previewBank?.balance.booked_balance ?? null) : ledgerBalance
  const effectiveUnexplained =
    stated != null && bookedForStated != null
      ? roundOre(bookedForStated - stated)
      : stated != null && askStatementBalance
        ? null
        : previewUnexplained
  // A stated statement balance is the one the bank had none of.
  const bank = stated != null && previewBank?.warning === 'NO_BANK_BALANCE' ? null : previewBank
  // The parts of a difference, named as on the account page; they sum to it.
  const bankParts =
    bank?.warning === 'BANK_BALANCE_DIFFERS'
      ? [
          bank.balance.unbooked && bank.balance.unbooked.count > 0
            ? t('balance_check_part_unbooked', {
                count: bank.balance.unbooked.count,
                amount: formatCurrency(bank.balance.unbooked.total, currency),
              })
            : null,
          bank.balance.before_history && Math.abs(bank.balance.before_history.difference) >= 0.005
            ? t('balance_check_part_before', {
                date: formatDate(bank.balance.before_history.history_start),
                amount: formatCurrency(bank.balance.before_history.difference, currency),
              })
            : null,
          bank.balance.rest != null && Math.abs(bank.balance.rest) >= 0.005
            ? t('balance_check_part_rest', { amount: formatCurrency(bank.balance.rest, currency) })
            : null,
        ].filter((part): part is string => part !== null)
      : []
  const needsForce =
    preview?.kind === 'ok' && stated == null
      ? false
      : effectiveUnexplained == null || Math.abs(effectiveUnexplained) >= 0.005

  const canSubmit =
    !busy &&
    !previewing &&
    blocked === null &&
    !statedUnreadable &&
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
        ...(asksBalance ? { external_balance: stated } : {}),
      })
      if (message) setError(message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="confirm">
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
            {previewing && <p className="text-xs text-muted-foreground">{t('signoff_preview_pending')}</p>}
          </div>
          {blocked === null && bank && (bank.warning !== null || bank.balance.bank_balance !== null) && (
            <div
              className={
                bank.warning === null
                  ? 'text-xs text-muted-foreground'
                  : 'space-y-1 rounded-lg bg-warning/10 px-3 py-2.5 text-[13px] text-foreground'
              }
              data-ph-mask
            >
              <p>
                {bank.warning === null && bank.balance.bank_balance !== null
                  ? t('balance_check_ok', {
                      date: formatDate(bank.balance.as_of),
                      amount: formatCurrency(bank.balance.bank_balance, currency),
                    })
                  : bank.warning === 'BANK_BALANCE_DIFFERS' &&
                      bank.balance.bank_balance !== null &&
                      bank.balance.booked_balance !== null &&
                      bank.balance.difference !== null
                    ? t('balance_check_diff', {
                        bank: formatCurrency(bank.balance.bank_balance, currency),
                        date: formatDate(bank.balance.as_of),
                        account: accountNumber,
                        booked: formatCurrency(bank.balance.booked_balance, currency),
                        difference: formatCurrency(bank.balance.difference, currency),
                      })
                    : bank.balance.booked_balance !== null
                      ? t('signoff_bank_balance_missing', {
                          date: formatDate(bank.balance.as_of),
                          account: accountNumber,
                          booked: formatCurrency(bank.balance.booked_balance, currency),
                        })
                      : t('signoff_bank_balance_missing_short', {
                          date: formatDate(bank.balance.as_of),
                          account: accountNumber,
                        })}
              </p>
              {bankParts.length > 0 && (
                <div className="flex items-center gap-1">
                  <span>{t('balance_check_parts', { parts: bankParts.join(' · ') })}</span>
                  <InfoTooltip content={t('balance_check_help', { account: accountNumber })} iconClassName="h-3 w-3" />
                </div>
              )}
              {bank.warning !== null && <p className="text-muted-foreground">{t('signoff_bank_balance_hint')}</p>}
            </div>
          )}
          {asksBalance && (
            <div className="space-y-1.5">
              <Label htmlFor="signoff-external">
                {askStatementBalance ? t('signoff_statement_balance') : t('signoff_external_balance')}
              </Label>
              <Input
                id="signoff-external"
                inputMode="decimal"
                value={external}
                onChange={(e) => setExternal(e.target.value)}
                placeholder="0,00"
                className="tabular-nums"
              />
              {statedUnreadable && (
                <p role="alert" className="text-xs text-destructive">
                  {t('signoff_balance_unreadable')}
                </p>
              )}
              <p className="text-xs text-muted-foreground">
                {askStatementBalance
                  ? bookedForStated != null
                    ? t('signoff_statement_balance_help', {
                        account: accountNumber,
                        amount: formatCurrency(bookedForStated, currency),
                      })
                    : t('signoff_statement_balance_optional')
                  : ledgerBalance != null
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
