'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useLocale, useTranslations } from 'next-intl'
import { Button } from '@/components/ui/button'
import { LateReveal, Skeleton } from '@/components/ui/skeleton'
import { LoadError } from '@/components/ui/empty-state'
import { AttnLine } from '@/components/ui/attn-line'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { useToast } from '@/components/ui/use-toast'
import { DestructiveConfirmDialog, useDestructiveConfirm } from '@/components/ui/destructive-confirm-dialog'
import { getErrorMessage, getResponseErrorMessage } from '@/lib/errors/get-error-message'
import { notifySessionExpired } from '@/lib/auth/session-timeout-shared'
import { readsAsCredit } from '@/lib/documents/inbox-kind'
import type { CreditTargetCandidate, CreditTargetResolution } from '@/lib/supplier-invoices/credit-target'
import { formatCurrency, formatDate } from '@/lib/utils'
import { readBankHeldPaymentSentences } from '@/components/payments/BankHeldPaymentNotes'

/**
 * The Underlag rail for a supplier's credit note (issue #2980). A credit note
 * is never registered as a payable of its own: it credits the invoice it
 * references, through the same Kreditera the invoice page offers, dated on
 * the credit note and with its document as underlag. The panel shows which
 * invoice that is, lets the person pick when several (or none) fit, and says
 * so plainly when the credit note covers only part of the invoice, since
 * Kreditera always takes the whole invoice.
 */
export function InboxCreditNotePanel({
  itemId,
  extracted,
  onCredited,
  onFieldsUpdated,
}: {
  itemId: string
  /** The item's reading: the rail re-asks when it changes (a corrected total). */
  extracted: Record<string, unknown> | null
  onCredited: () => Promise<void> | void
  /** Called with the new reading after "not a credit note". */
  onFieldsUpdated: (data: Record<string, unknown>) => void
}) {
  const t = useTranslations('inbox_workspace')
  const locale = useLocale()
  const tBankHeld = useTranslations('bank_held_payment')
  const { toast } = useToast()
  const { dialogProps, confirm } = useDestructiveConfirm()
  const [target, setTarget] = useState<CreditTargetResolution | null>(null)
  const [loadFailed, setLoadFailed] = useState(false)
  // Bumped by "Försök igen" to read the credit target again.
  const [attempt, setAttempt] = useState(0)
  const [picked, setPicked] = useState<string>('')
  const [busy, setBusy] = useState(false)
  // The item the panel shows now: the panel stays mounted when the rail
  // selects another item, and a credit's bank read must not open the confirm
  // for the earlier item over the next one.
  const shownItemIdRef = useRef(itemId)
  useEffect(() => {
    shownItemIdRef.current = itemId
  }, [itemId])
  const readingKey = JSON.stringify(extracted?.totals ?? null) + JSON.stringify(extracted?.invoice ?? null)

  useEffect(() => {
    let cancelled = false
    setTarget(null)
    setLoadFailed(false)
    setPicked('')
    ;(async () => {
      try {
        const res = await fetch(`/api/extensions/ext/invoice-inbox/items/${itemId}/credit-target`)
        if (!res.ok) throw new Error(String(res.status))
        const json = (await res.json()) as { data?: { credit_target?: CreditTargetResolution | null } }
        if (!cancelled) setTarget(json.data?.credit_target ?? null)
      } catch {
        if (!cancelled) setLoadFailed(true)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [itemId, readingKey, attempt])

  const creditDate =
    typeof (extracted?.invoice as { invoiceDate?: unknown } | undefined)?.invoiceDate === 'string'
      ? ((extracted?.invoice as { invoiceDate: string }).invoiceDate)
      : null

  const credit = useCallback(
    async (invoice: CreditTargetCandidate) => {
      const number = invoice.supplier_invoice_number ?? String(invoice.arrival_number ?? '')
      // A payment the bank holds for the invoice (Betala via banken), said
      // before the confirm: a signed one still goes out, so the credit is
      // refused until it is cancelled; an unsigned one is cancelled at the bank.
      // The read waits up to 2 s: the button shows it working, and a switch
      // to another item meanwhile drops this credit.
      let bankPaymentNotes: string[] = []
      setBusy(true)
      try {
        bankPaymentNotes = await readBankHeldPaymentSentences(
          [invoice.supplier_invoice_id],
          'other',
          locale,
          tBankHeld('check_failed'),
        )
      } finally {
        setBusy(false)
      }
      if (shownItemIdRef.current !== itemId) return
      await confirm(
        {
          title: t('credit_note_confirm_title', { number }),
          description: [
            t('credit_note_confirm_description', {
              number,
              date: creditDate ? formatDate(creditDate) : t('credit_note_date_today'),
            }),
            ...bankPaymentNotes,
          ].join('\n\n'),
          confirmLabel: t('credit_note_confirm_label'),
          variant: 'warning',
        },
        async () => {
          setBusy(true)
          try {
            const res = await fetch(`/api/supplier-invoices/${invoice.supplier_invoice_id}/credit`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ inbox_item_id: itemId }),
            })
            if (!res.ok) {
              notifySessionExpired(res)
              toast({
                title: t('credit_note_failed'),
                description: await getResponseErrorMessage(res),
                variant: 'destructive',
              })
              return
            }
            toast({ title: t('credit_note_success') })
            await onCredited()
          } catch (err) {
            toast({ title: t('credit_note_failed'), description: getErrorMessage(err), variant: 'destructive' })
          } finally {
            setBusy(false)
          }
        },
      )
    },
    [confirm, creditDate, itemId, locale, onCredited, t, tBankHeld, toast],
  )

  const notACreditNote = async () => {
    setBusy(true)
    try {
      const res = await fetch(`/api/extensions/ext/invoice-inbox/items/${itemId}/fields`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ documentKind: 'supplier_invoice' }),
      })
      if (!res.ok) {
        notifySessionExpired(res)
        toast({ title: t('credit_note_failed'), description: await getResponseErrorMessage(res), variant: 'destructive' })
        return
      }
      const json = (await res.json()) as { data?: { extracted_data?: Record<string, unknown> } }
      if (json.data?.extracted_data) onFieldsUpdated(json.data.extracted_data)
    } finally {
      setBusy(false)
    }
  }

  // Negative amounts keep it a credit note whatever the label says: the
  // way out is correcting them, not the label.
  const negativeAmounts = readsAsCredit(extracted as never, { labelled: true })

  const numberOf = (c: CreditTargetCandidate) => c.supplier_invoice_number ?? String(c.arrival_number ?? '')
  const amountOf = (c: CreditTargetCandidate) => formatCurrency(c.total, c.currency)

  let body: React.ReactNode
  if (loadFailed) {
    body = <LoadError title={t('credit_note_load_failed')} onRetry={() => setAttempt((n) => n + 1)} />
  } else if (!target) {
    body = (
      <LateReveal>
        <Skeleton className="h-16 w-full" />
      </LateReveal>
    )
  } else if (target.status === 'matched' && target.invoice) {
    const invoice = target.invoice
    body = (
      <>
        <p className="text-[13px]">
          {t('credit_note_matched', {
            number: numberOf(invoice),
            supplier: invoice.supplier_name ?? '',
            amount: amountOf(invoice),
          })}
        </p>
        <Button className="w-full" loading={busy} onClick={() => credit(invoice)}>
          {t('credit_note_credit_button', { number: numberOf(invoice) })}
        </Button>
      </>
    )
  } else if (target.status === 'partial' && target.invoice) {
    body = (
      <AttnLine>
        {t('credit_note_partial', {
          number: numberOf(target.invoice),
          credit: formatCurrency(target.credit_total ?? 0, target.invoice.currency),
          total: amountOf(target.invoice),
        })}
      </AttnLine>
    )
  } else if (target.status === 'amount_differs' && target.invoice) {
    body = <AttnLine>{t('credit_note_amount_differs', { number: numberOf(target.invoice) })}</AttnLine>
  } else if (target.status === 'already_credited' && target.invoice) {
    body = (
      <AttnLine
        action={{
          label: t('credit_note_open_invoice'),
          href: `/supplier-invoices/${target.invoice.supplier_invoice_id}`,
        }}
      >
        {t('credit_note_already_credited', { number: numberOf(target.invoice) })}
      </AttnLine>
    )
  } else if (target.candidates.length > 0) {
    const chosen = target.candidates.find((c) => c.supplier_invoice_id === picked) ?? null
    body = (
      <>
        <p className="text-[13px]">
          {target.status === 'ambiguous' ? t('credit_note_ambiguous') : t('credit_note_pick')}
        </p>
        <Select value={picked} onValueChange={setPicked}>
          <SelectTrigger aria-label={t('credit_note_pick')}>
            <SelectValue placeholder={t('credit_note_pick_placeholder')} />
          </SelectTrigger>
          <SelectContent>
            {target.candidates.map((c) => (
              <SelectItem key={c.supplier_invoice_id} value={c.supplier_invoice_id}>
                <span className="tabular-nums">
                  {numberOf(c)} · {formatDate(c.invoice_date)} · {amountOf(c)}
                </span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button className="w-full" loading={busy} disabled={!chosen} onClick={() => chosen && credit(chosen)}>
          {t('credit_note_pick_button')}
        </Button>
      </>
    )
  } else {
    body = <p className="text-[13px] text-muted-foreground">{t('credit_note_none')}</p>
  }

  return (
    <div className="space-y-2">
      <p className="text-[13px] font-medium">{t('credit_note_title')}</p>
      {body}
      {negativeAmounts ? (
        <p className="text-xs text-muted-foreground">{t('credit_note_negative_hint')}</p>
      ) : (
        <button
          type="button"
          onClick={notACreditNote}
          disabled={busy}
          className="w-full text-xs text-muted-foreground hover:text-foreground hover:underline"
        >
          {t('credit_note_not_credit')}
        </button>
      )}
      <DestructiveConfirmDialog {...dialogProps} />
    </div>
  )
}
