'use client'

import { useEffect, useRef, useState } from 'react'
import { useTranslations } from 'next-intl'
import { CheckIcon, Square2StackIcon } from '@/components/icons'
import { Button } from '@/components/ui/button'
import { AttnLine } from '@/components/ui/attn-line'
import { Skeleton } from '@/components/ui/skeleton'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { copyToClipboard } from '@/lib/browser/copy-to-clipboard'
import { payInBankDetails, plainAmount, type PayInBankDetails, type PayInBankInvoice } from '@/lib/inkorg/pay-in-bank'
import { formatDate } from '@/lib/utils'

/** The invoice just registered from an inbox item; its id when the registration answered one. */
export interface PayInBankTarget {
  inboxItemId: string
  supplierInvoiceId: string | null
}

type Load =
  | { status: 'loading' }
  | { status: 'failed'; supplierInvoiceId: string | null }
  | { status: 'ready'; supplierInvoiceId: string; details: PayInBankDetails }

async function readJson<T>(url: string): Promise<T> {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`${url}: ${res.status}`)
  return ((await res.json()) as { data: T }).data
}

/**
 * "Jag betalar i banken", after the registration: what to type in the bank's
 * app, read off the invoice as it was registered, each with a copy button.
 * A changed or new account on the invoice is never handed over to copy while
 * it waits for a person; the line sends them to the invoice instead.
 *
 * Lives on the page, not in the focus stage: the registered item leaves the
 * queue (and its stage) while this is still open.
 */
export function PayInBankDialog({ target, onClose }: { target: PayInBankTarget | null; onClose: () => void }) {
  const t = useTranslations('inkorg')
  // Keyed by the target, so a new one reads as loading without a reset in the effect.
  const [answer, setAnswer] = useState<{ target: PayInBankTarget; load: Load } | null>(null)
  const load: Load = answer && answer.target === target ? answer.load : { status: 'loading' }

  useEffect(() => {
    if (!target) return
    let cancelled = false
    const setLoad = (next: Load) => {
      if (!cancelled) setAnswer({ target, load: next })
    }
    ;(async () => {
      let invoiceId = target.supplierInvoiceId
      try {
        // An enskild firma's registration answers no id: the item says what it became.
        invoiceId ??= (await readJson<{ created_supplier_invoice_id: string | null }>(
          `/api/extensions/ext/invoice-inbox/items/${target.inboxItemId}`,
        )).created_supplier_invoice_id
        if (!invoiceId) throw new Error('not registered')
        const [invoice, payee] = await Promise.all([
          readJson<PayInBankInvoice>(`/api/supplier-invoices/${invoiceId}`),
          readJson<{ hold: string | null }>(`/api/supplier-invoices/${invoiceId}/payee`),
        ])
        setLoad({ status: 'ready', supplierInvoiceId: invoiceId, details: payInBankDetails(invoice, payee) })
      } catch {
        setLoad({ status: 'failed', supplierInvoiceId: invoiceId })
      }
    })()
    return () => {
      cancelled = true
    }
  }, [target])

  const details = load.status === 'ready' ? load.details : null
  const invoiceHref = load.status !== 'loading' && load.supplierInvoiceId ? `/supplier-invoices/${load.supplierInvoiceId}` : null

  return (
    <Dialog open={!!target} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle data-ph-mask="">
            {details?.supplierName ? t('pay_title_named', { name: details.supplierName }) : t('pay_title')}
          </DialogTitle>
          <DialogDescription>{t('pay_intro')}</DialogDescription>
        </DialogHeader>

        {load.status === 'loading' && (
          <div className="space-y-3" aria-hidden="true">
            {[0, 1, 2, 3].map((i) => (
              <Skeleton key={i} className="h-8 w-full rounded-sm" />
            ))}
          </div>
        )}

        {load.status === 'failed' && (
          <AttnLine action={invoiceHref ? { label: t('pay_open_invoice'), href: invoiceHref } : undefined}>
            {t('pay_load_failed')}
          </AttnLine>
        )}

        {details?.settled && <p className="text-[13px] text-muted-foreground">{t('pay_nothing_left')}</p>}

        {details && !details.settled && (
          <dl className="divide-y divide-border border-y border-border">
            {details.held ? (
              <div className="py-3">
                <dt className="sr-only">{t('pay_account')}</dt>
                <dd>
                  <AttnLine action={invoiceHref ? { label: t('pay_open_invoice'), href: invoiceHref } : undefined}>
                    {t('pay_account_held')}
                  </AttnLine>
                </dd>
              </div>
            ) : details.account ? (
              <CopyRow label={t(`pay_${details.account.kind}`)} value={details.account.value} />
            ) : (
              <div className="py-3">
                <dt className="sr-only">{t('pay_account')}</dt>
                <dd className="text-[13px] text-muted-foreground">{t('pay_account_missing')}</dd>
              </div>
            )}
            {details.reference && (
              <CopyRow label={details.reference.kind === 'ocr' ? t('pay_ocr') : t('pay_message')} value={details.reference.value} />
            )}
            {/* As a bank's amount field takes it; the currency beside it is not copied. */}
            <CopyRow label={t('pay_amount')} value={plainAmount(details.amount)} suffix={details.currency} />
            {details.dueDate && <CopyRow label={t('pay_due')} value={formatDate(details.dueDate)} />}
          </dl>
        )}

        {details && !details.settled && <p className="text-[12.5px] text-muted-foreground">{t('pay_after')}</p>}

        <DialogFooter>
          <Button onClick={onClose}>{t('done')}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/**
 * One value to type in the bank, with its copy button. The clipboard write is
 * the click's first await (after another it runs outside the click's user
 * activation and is refused); when it is refused the value is selected, so
 * Cmd+C or Ctrl+C takes it, and the line says so.
 */
export function CopyRow({ label, value, suffix }: { label: string; value: string; suffix?: string }) {
  const t = useTranslations('inkorg')
  const valueRef = useRef<HTMLElement | null>(null)
  const [state, setState] = useState<'idle' | 'copied' | 'selected'>('idle')

  async function copy() {
    const result = await copyToClipboard(value)
    if (result === 'copied') {
      setState('copied')
      return
    }
    const el = valueRef.current
    if (el) {
      const range = document.createRange()
      range.selectNodeContents(el)
      const selection = window.getSelection()
      selection?.removeAllRanges()
      selection?.addRange(range)
    }
    setState('selected')
  }

  return (
    <div className="flex items-center gap-3 py-2">
      <dt className="w-28 shrink-0 text-[12.5px] text-muted-foreground">{label}</dt>
      <dd className="min-w-0 flex-1">
        <span ref={valueRef} data-ph-mask="" className="select-all break-all text-[13px] tabular-nums">
          {value}
        </span>
        {suffix && <span className="ml-1 text-[13px] text-muted-foreground">{suffix}</span>}
        {state === 'selected' && <span className="block text-[12.5px] text-muted-foreground">{t('pay_copy_selected')}</span>}
      </dd>
      <Button variant="ghost" size="sm" onClick={() => void copy()} aria-label={t('pay_copy_aria', { label })}>
        {state === 'copied' ? <CheckIcon aria-hidden="true" className="mr-1 h-3.5 w-3.5" /> : <Square2StackIcon aria-hidden="true" className="mr-1 h-3.5 w-3.5" />}
        {state === 'copied' ? t('copied') : t('copy')}
      </Button>
      <span className="sr-only" aria-live="polite">
        {state === 'copied' ? t('copied') : ''}
      </span>
    </div>
  )
}
