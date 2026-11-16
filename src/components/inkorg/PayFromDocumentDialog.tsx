'use client'

import { useEffect, useState } from 'react'
import { useTranslations } from 'next-intl'
import { Button } from '@/components/ui/button'
import { AttnLine } from '@/components/ui/attn-line'
import { LateReveal, Skeleton } from '@/components/ui/skeleton'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { classifyPayeeChange, type CardPayeeSource } from '@/lib/payments/payee-change'
import { payFromDocumentDetails, plainAmount, statedPayeeOfDocument, type PayFromDocumentReading } from '@/lib/inkorg/pay-in-bank'
import { formatDate } from '@/lib/utils'
import { CopyRow } from './PayInBankDialog'

/** The supplier card as far as the payee rules read it; unknown while it loads, or when it could not be read. */
type Card = { status: 'none' } | { status: 'loading' } | { status: 'failed' } | { status: 'ready'; card: CardPayeeSource }

/**
 * "Jag betalar i banken" without Leverantörsfakturor (kontantmetoden): what
 * to type in the bank's app, read off the document itself, each with a copy
 * button, as the registered invoice's panel shows it. Nothing is registered:
 * the payment is booked with the document when it reaches the bank, where
 * the Inkorg's bank check offers the row.
 *
 * A document that asks to be paid to another account than the company's
 * supplier card holds for the counterpart is how invoice fraud pays the
 * wrong party (lib/payments/payee-change.ts): then the number is not handed
 * over, the line says to check it with the supplier. When the card could
 * not be read, the number is shown with a line asking to check it.
 *
 * Klart closes back to the list (onDone); Esc or a click outside only
 * closes the panel.
 */
export function PayFromDocumentDialog({
  open,
  reading,
  matchedSupplierId,
  onClose,
  onDone,
}: {
  open: boolean
  reading: PayFromDocumentReading | null
  /** The supplier card the reading matched (the item detail's matched_supplier_id). */
  matchedSupplierId: string | null
  onClose: () => void
  onDone: () => void
}) {
  const t = useTranslations('inkorg')
  const [answer, setAnswer] = useState<{ id: string; card: Card } | null>(null)
  const card: Card = !matchedSupplierId
    ? { status: 'none' }
    : answer?.id === matchedSupplierId
      ? answer.card
      : { status: 'loading' }

  useEffect(() => {
    if (!open || !matchedSupplierId) return
    let cancelled = false
    ;(async () => {
      try {
        const res = await fetch(`/api/suppliers/${matchedSupplierId}`)
        if (!res.ok) throw new Error(String(res.status))
        const data = ((await res.json()) as { data?: CardPayeeSource | null }).data
        if (!cancelled) setAnswer({ id: matchedSupplierId, card: data ? { status: 'ready', card: data } : { status: 'failed' } })
      } catch {
        if (!cancelled) setAnswer({ id: matchedSupplierId, card: { status: 'failed' } })
      }
    })()
    return () => {
      cancelled = true
    }
  }, [open, matchedSupplierId])

  const held = card.status === 'ready' && classifyPayeeChange({ invoice: statedPayeeOfDocument(reading), card: card.card }).kind === 'changed'
  const details = payFromDocumentDetails(reading, { held })

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent size="confirm">
        <DialogHeader>
          <DialogTitle data-ph-mask="">
            {details.supplierName ? t('pay_title_named', { name: details.supplierName }) : t('pay_title')}
          </DialogTitle>
          <DialogDescription>{t('pay_doc_intro')}</DialogDescription>
        </DialogHeader>

        {card.status === 'loading' ? (
          <LateReveal className="space-y-3">
            {[0, 1, 2, 3].map((i) => (
              <Skeleton key={i} className="h-8 w-full rounded-sm" />
            ))}
          </LateReveal>
        ) : (
          <dl className="divide-y divide-border border-y border-border">
            {details.held ? (
              <div className="py-3">
                <dt className="sr-only">{t('pay_account')}</dt>
                <dd>
                  <AttnLine>{t('pay_doc_account_held')}</AttnLine>
                </dd>
              </div>
            ) : details.account ? (
              <CopyRow label={t(`pay_${details.account.kind}`)} value={details.account.value} />
            ) : (
              <div className="py-3">
                <dt className="sr-only">{t('pay_account')}</dt>
                <dd className="text-[13px] text-muted-foreground">{t('pay_doc_account_missing')}</dd>
              </div>
            )}
            {details.reference && (
              <CopyRow label={details.reference.kind === 'ocr' ? t('pay_ocr') : t('pay_message')} value={details.reference.value} />
            )}
            {/* As a bank's amount field takes it; the currency beside it is not copied. */}
            {details.amount != null && <CopyRow label={t('pay_amount')} value={plainAmount(details.amount)} suffix={details.currency} />}
            {details.dueDate && <CopyRow label={t('pay_due')} value={formatDate(details.dueDate)} />}
          </dl>
        )}

        {/* The card could not be read, so nothing says the account is the supplier's. */}
        {card.status === 'failed' && details.account && <AttnLine>{t('pay_doc_account_check')}</AttnLine>}

        <p className="text-xs text-muted-foreground">{t('pay_doc_after')}</p>

        <DialogFooter>
          <Button onClick={onDone}>{t('done')}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
