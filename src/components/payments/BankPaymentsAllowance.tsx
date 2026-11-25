'use client'

import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { useLocale, useTranslations } from 'next-intl'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { AttnLine } from '@/components/ui/attn-line'
import { getErrorMessage, type ErrorLocale } from '@/lib/errors/get-error-message'
import { useFormat } from '@/lib/hooks/use-format'
import { formatCurrency } from '@/lib/utils'
import {
  fetchPaymentPacks,
  PaymentsClientError,
  remainingBankPayments,
  requestMoreBankPayments,
  setPaymentPacks,
  type BankPaymentsAllowanceRefusal,
  type BankPaymentsUsage,
  type PaymentPacksSet,
  type PaymentPacksView,
} from './payments-client'

const MESSAGE_MAX = 2000

/** "oktober" for 2026-10, in the person's language. */
export function usageMonthName(period: string, locale: string): string {
  return new Date(`${period}-15T12:00:00Z`).toLocaleDateString(locale, { month: 'long', timeZone: 'UTC' })
}

/**
 * Begär fler betalningar: how many payments a month the company needs and an
 * optional message. The request is mailed to support and an operator raises
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
      <DialogContent size="confirm">
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
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
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

/**
 * The company's packs and whether this person may buy more
 * (GET /api/billing/payment-packs), read while `enabled`: a screen with
 * nothing to offer asks the server nothing. null while it is read, 'failed'
 * when it could not be (the caller then offers Begär fler, the way that
 * always works); `reload` after a purchase.
 */
export function usePaymentPacks(enabled: boolean): { view: PaymentPacksView | 'failed' | null; reload: () => void } {
  const [view, setView] = useState<PaymentPacksView | 'failed' | null>(null)
  const [reloadKey, setReloadKey] = useState(0)
  useEffect(() => {
    if (!enabled) return
    let cancelled = false
    fetchPaymentPacks().then(
      (next) => {
        if (!cancelled) setView(next)
      },
      () => {
        if (!cancelled) setView('failed')
      },
    )
    return () => {
      cancelled = true
    }
  }, [enabled, reloadKey])
  const reload = useCallback(() => setReloadKey((k) => k + 1), [])
  return { view, reload }
}

/**
 * Köp fler betalningar: the owner sets how many packs the company holds,
 * each pack_size more bank payments a month on the subscription. Opened with
 * the view that offered it (can_buy). The dialog says what happens before it
 * happens (convention 10): more packs take effect now and the rest of the
 * period is charged now; fewer take effect at the period end. `onChanged`
 * hears what the purchase did.
 */
export function BuyPaymentPacksDialog({
  view,
  onOpenChange,
  onChanged,
}: {
  view: PaymentPacksView
  onOpenChange: (open: boolean) => void
  onChanged?: (result: PaymentPacksSet) => void
}) {
  const t = useTranslations('bank_payments_allowance')
  const locale = useLocale() as ErrorLocale
  const { formatDateLong } = useFormat()
  const [wanted, setWanted] = useState(() => String(Math.min(view.max_packs, view.packs + 1)))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState<PaymentPacksSet | null>(null)

  const price = view.can_buy ? view.pack_price_ex_vat : null
  const packs = Number(wanted)
  const valid = price !== null && /^\d+$/.test(wanted.trim()) && packs <= view.max_packs
  const direction: 'up' | 'down' | 'keep' | null = !valid
    ? null
    : packs > view.packs
      ? 'up'
      : packs < view.packs
        ? 'down'
        : view.scheduled
          ? 'keep'
          : null

  async function submit() {
    if (!direction) return
    setBusy(true)
    setError(null)
    try {
      const result = await setPaymentPacks(packs)
      setDone(result)
      onChanged?.(result)
    } catch (err) {
      const body = err instanceof PaymentsClientError ? err.body : null
      setError(getErrorMessage(body, { locale, fallback: t('buy_failed') }))
    } finally {
      setBusy(false)
    }
  }

  let body: ReactNode
  if (done) {
    body = (
      <div className="space-y-4">
        <p className="text-[13px] leading-relaxed">
          {done.scheduled
            ? t('buy_done_later', { packs: done.scheduled.packs, date: formatDateLong(done.scheduled.at) })
            : t('buy_done_now', { included: done.included_payments })}
        </p>
        <DialogFooter>
          <Button onClick={() => onOpenChange(false)}>{t('close')}</Button>
        </DialogFooter>
      </div>
    )
  } else if (price === null) {
    body = (
      <div className="space-y-4">
        <AttnLine>{t('buy_unavailable')}</AttnLine>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t('close')}
          </Button>
        </DialogFooter>
      </div>
    )
  } else {
    const periodEnd = view.period_end ? formatDateLong(view.period_end) : null
    body = (
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault()
          void submit()
        }}
      >
        {(view.packs > 0 || view.scheduled) && (
          <p className="text-[13px]">
            {t('buy_current', { packs: view.packs })}
            {view.scheduled ? ` ${t('buy_scheduled', { packs: view.scheduled.packs, date: formatDateLong(view.scheduled.at) })}` : ''}
          </p>
        )}
        <label className="block space-y-2 text-[13px]">
          <span className="text-muted-foreground">{t('buy_packs_label')}</span>
          <Input
            inputMode="numeric"
            autoComplete="off"
            value={wanted}
            onChange={(e) => setWanted(e.target.value)}
            className="w-[160px] tabular-nums"
            aria-invalid={(wanted.trim() !== '' && !valid) || undefined}
          />
        </label>
        {valid && (
          <div className="space-y-1 text-xs tabular-nums text-muted-foreground">
            <p>{t('buy_total', { total: view.base_payments + packs * view.pack_size })}</p>
            {direction === 'up' && <p>{t('buy_effect_now', { amount: formatCurrency(packs * price) })}</p>}
            {direction === 'down' && (
              <p>{periodEnd ? t('buy_effect_later', { date: periodEnd, packs: view.packs }) : t('buy_effect_later_plain', { packs: view.packs })}</p>
            )}
            {direction === 'keep' && view.scheduled && <p>{t('buy_effect_keep', { packs: view.scheduled.packs })}</p>}
          </div>
        )}
        {error && <AttnLine>{error}</AttnLine>}
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
            {t('cancel')}
          </Button>
          <Button type="submit" loading={busy} disabled={busy || !direction}>
            {direction === 'down' ? t('buy_confirm_lower') : direction === 'keep' ? t('buy_confirm_keep') : t('buy_confirm')}
          </Button>
        </DialogFooter>
      </form>
    )
  }

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent size="confirm">
        <DialogHeader>
          <DialogTitle>{t('buy_title')}</DialogTitle>
          <DialogDescription>
            {price !== null
              ? t('buy_description', { base: view.base_payments, size: view.pack_size, price: formatCurrency(price) })
              : t('buy_description_plain')}
          </DialogDescription>
        </DialogHeader>
        {body}
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
  /** The cap an owner just raised by buying packs, for the dialog's own counter. */
  onIncluded?: (included: number) => void
}

/**
 * The monthly cap where payments are picked and signed: a quiet line with
 * what the month still takes, one attention line when the selection is more
 * than that or the server refused a signing at the cap, with Köp fler
 * betalningar for an owner who can buy packs and Begär fler for everyone else.
 */
export function BankPaymentsAllowanceLine({ usage, count, refusal = null, canRequest, onIncluded }: BankPaymentsAllowanceLineProps) {
  const t = useTranslations('bank_payments_allowance')
  const locale = useLocale()
  const [requesting, setRequesting] = useState(false)
  const [buying, setBuying] = useState(false)

  const over = refusal !== null || (usage !== null && count > remainingBankPayments(usage))
  // More than what is included is on offer and not open yet: the way on is to ask for it (Begär fler).
  const acceptable = (refusal ? refusal.extra_offered && !refusal.billed : usage?.extra_offered === true && !usage.billed_above_included)
  // More would be on offer with a subscription of its own: the way on is to start one.
  const needsSubscription = refusal ? refusal.subscription_required : usage?.subscription_required === true
  // The subscription is started and waits for its first charge: more opens then, and there is nothing to do now.
  const startingSubscription = refusal ? refusal.subscription_starting : usage?.subscription_starting === true
  const unitPriceOre = refusal?.unit_price_ore ?? usage?.unit_price_ore ?? 0
  const { view: packs } = usePaymentPacks(canRequest && over && !acceptable && !needsSubscription && !startingSubscription)
  const buyable = packs !== null && packs !== 'failed' && packs.can_buy ? packs : null
  // No action until the offer is known, so the link does not change under the cursor.
  const action =
    !canRequest || startingSubscription
      ? undefined
      : acceptable
        ? { label: t('request_more'), onClick: () => setRequesting(true) }
        : needsSubscription
          ? { label: t('start_subscription'), href: '/settings/billing' }
          : packs === null
          ? undefined
          : buyable
            ? { label: t('buy_more'), onClick: () => setBuying(true) }
            : { label: t('request_more'), onClick: () => setRequesting(true) }
  const dialog =
    buying && buyable ? (
      <BuyPaymentPacksDialog
        view={buyable}
        onOpenChange={setBuying}
        onChanged={(result) => {
          if (!result.scheduled) onIncluded?.(result.included_payments)
        }}
      />
    ) : requesting ? (
    <RequestMorePaymentsDialog included={refusal?.included ?? usage?.included_payments ?? null} onOpenChange={setRequesting} />
  ) : null

  if (refusal) {
    const month = usageMonthName(refusal.period, locale)
    const price = formatCurrency(unitPriceOre / 100)
    const numbers = { used: refusal.used, included: refusal.included, cap: refusal.cap, remaining: refusal.remaining, month, price }
    // Billed above what is included: the stop is the safety ceiling, said as such.
    const text = acceptable
      ? t('offered_none_left', numbers)
      : startingSubscription
      ? t('subscription_starting_none_left', numbers)
      : needsSubscription
      ? t('subscription_none_left', numbers)
      : refusal.billed
      ? refusal.remaining > 0
        ? t('refused_cap', numbers)
        : t('refused_cap_none_left', numbers)
      : !canRequest
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
  const cap = usage.cap_payments ?? usage.included_payments
  if (count > remaining) {
    const price = formatCurrency(unitPriceOre / 100)
    return (
      <>
        <AttnLine action={action}>
          {acceptable
            ? t('offered_none_left', { used: usage.payments_sent, included: usage.included_payments, month, price })
            : startingSubscription
            ? t('subscription_starting_none_left', { used: usage.payments_sent, included: usage.included_payments, month, price })
            : needsSubscription
            ? t('subscription_none_left', { used: usage.payments_sent, included: usage.included_payments, month, price })
            : remaining > 0
              ? t('too_many', { remaining, included: cap, month })
              : t('none_left', { included: cap, month })}
        </AttnLine>
        {dialog}
      </>
    )
  }
  if (usage.billed_above_included) {
    // Said before signing: how many of these go above what the month includes, and what each costs.
    const price = formatCurrency((usage.unit_price_ore ?? 0) / 100)
    const alreadyAbove = Math.max(0, usage.payments_sent - usage.included_payments)
    const extra = Math.max(0, usage.payments_sent + count - usage.included_payments) - alreadyAbove
    const left = Math.max(0, usage.included_payments - usage.payments_sent)
    return (
      <p className="text-xs text-muted-foreground">
        {extra > 0 ? t('billed_extra', { extra, price, month }) : t('billed_within', { left, included: usage.included_payments, price, month })}
      </p>
    )
  }
  return <p className="text-xs text-muted-foreground">{t('remaining', { remaining, included: usage.included_payments, month })}</p>
}
