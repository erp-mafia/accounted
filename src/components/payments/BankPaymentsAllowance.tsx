'use client'

import { useState } from 'react'
import { useLocale, useTranslations } from 'next-intl'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { AttnLine } from '@/components/ui/attn-line'
import { getErrorMessage, type ErrorLocale } from '@/lib/errors/get-error-message'
import {
  PaymentsClientError,
  remainingBankPayments,
  requestMoreBankPayments,
  type BankPaymentsAllowanceRefusal,
  type BankPaymentsUsage,
} from './payments-client'

const MESSAGE_MAX = 2000

/** "oktober" for 2026-10, in the person's language. */
export function usageMonthName(period: string, locale: string): string {
  return new Date(`${period}-15T12:00:00Z`).toLocaleDateString(locale, { month: 'long', timeZone: 'UTC' })
}

/**
 * Begär fler betalningar: how many payments a month the company needs and an
 * optional message. The request is mailed to support and a founder raises
 * the cap by hand; the dialog then thanks the person and closes on their word.
 */
export function RequestMorePaymentsDialog({ included, onOpenChange }: { included?: number | null; onOpenChange: (open: boolean) => void }) {
  const t = useTranslations('bank_payments_allowance')
  const locale = useLocale() as ErrorLocale
  const [wanted, setWanted] = useState('')
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [sent, setSent] = useState(false)

  const number = Number(wanted)
  const valid = /^\d+$/.test(wanted.trim()) && number >= 1 && number <= 10000

  async function submit() {
    if (!valid) return
    setBusy(true)
    setError(null)
    try {
      await requestMoreBankPayments({ monthlyPaymentsWanted: number, message: message.trim() || null })
      setSent(true)
    } catch (err) {
      const body = err instanceof PaymentsClientError ? err.body : null
      setError(getErrorMessage(body, { locale, fallback: t('failed') }))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t('title')}</DialogTitle>
          <DialogDescription>{typeof included === 'number' ? t('description', { included }) : t('description_plain')}</DialogDescription>
        </DialogHeader>
        {sent ? (
          <div className="space-y-4">
            <p className="text-[13px] leading-relaxed">{t('thanks')}</p>
            <DialogFooter>
              <Button onClick={() => onOpenChange(false)}>{t('close')}</Button>
            </DialogFooter>
          </div>
        ) : (
          <form
            className="space-y-4"
            onSubmit={(e) => {
              e.preventDefault()
              void submit()
            }}
          >
            <label className="block space-y-2 text-[13px]">
              <span className="text-muted-foreground">{t('wanted_label')}</span>
              <Input
                inputMode="numeric"
                autoComplete="off"
                value={wanted}
                onChange={(e) => setWanted(e.target.value)}
                placeholder={t('wanted_placeholder')}
                className="w-[160px] tabular-nums"
                aria-invalid={(wanted.trim() !== '' && !valid) || undefined}
              />
            </label>
            <label className="block space-y-2 text-[13px]">
              <span className="text-muted-foreground">{t('message_label')}</span>
              <Textarea value={message} maxLength={MESSAGE_MAX} rows={3} onChange={(e) => setMessage(e.target.value)} placeholder={t('message_placeholder')} />
            </label>
            {error && <AttnLine>{error}</AttnLine>}
            <DialogFooter>
              <Button type="button" variant="secondary" onClick={() => onOpenChange(false)} disabled={busy}>
                {t('cancel')}
              </Button>
              <Button type="submit" loading={busy} disabled={busy || !valid}>
                {t('send')}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  )
}

interface BankPaymentsAllowanceLineProps {
  /** This month's usage, when it could be read; null shows nothing unless a refusal came. */
  usage: BankPaymentsUsage | null
  /** The payments about to be signed. */
  count: number
  /** The server's refusal at the cap, when a signing was refused. */
  refusal?: BankPaymentsAllowanceRefusal | null
  /** A session that may ask for more (the payment signing link page may not: no login). */
  canRequest: boolean
}

/**
 * The monthly cap where payments are picked and signed: a quiet line with
 * what the month still takes, one attention line when the selection is more
 * than that or the server refused a signing at the cap, with Begär fler.
 */
export function BankPaymentsAllowanceLine({ usage, count, refusal = null, canRequest }: BankPaymentsAllowanceLineProps) {
  const t = useTranslations('bank_payments_allowance')
  const locale = useLocale()
  const [requesting, setRequesting] = useState(false)

  const action = canRequest ? { label: t('request_more'), onClick: () => setRequesting(true) } : undefined
  const dialog = requesting ? <RequestMorePaymentsDialog included={refusal?.included ?? usage?.included_payments ?? null} onOpenChange={setRequesting} /> : null

  if (refusal) {
    const month = usageMonthName(refusal.period, locale)
    const numbers = { used: refusal.used, included: refusal.included, remaining: refusal.remaining, month }
    const text = !canRequest
      ? t('refused_link', numbers)
      : refusal.remaining > 0
        ? t('refused', numbers)
        : t('refused_none_left', numbers)
    return (
      <>
        <AttnLine action={action}>{text}</AttnLine>
        {dialog}
      </>
    )
  }
  if (!usage) return null
  const remaining = remainingBankPayments(usage)
  const month = usageMonthName(usage.period, locale)
  if (count > remaining) {
    return (
      <>
        <AttnLine action={action}>
          {remaining > 0 ? t('too_many', { remaining, included: usage.included_payments, month }) : t('none_left', { included: usage.included_payments, month })}
        </AttnLine>
        {dialog}
      </>
    )
  }
  return <p className="text-[12.5px] text-muted-foreground">{t('remaining', { remaining, included: usage.included_payments, month })}</p>
}
