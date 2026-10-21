'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { useRouter, useSearchParams } from 'next/navigation'
import { useLocale, useTranslations } from 'next-intl'
import { Banknote } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { EmptyState } from '@/components/ui/empty-state'
import { HelpPopover } from '@/components/ui/help-popover'
import { PageHeader } from '@/components/ui/page-header'
import { Skeleton } from '@/components/ui/skeleton'
import { TD_CLASS, TH_CLASS } from '@/components/ui/dry-table'
import { ToastAction } from '@/components/ui/toast'
import { useToast } from '@/components/ui/use-toast'
import { capitalizeFirst, providerWords } from '@/components/collections/collections-client'
import { SettlementDetailSheet } from '@/components/collections/SettlementDetailSheet'
import { settlementsCall } from '@/components/collections/settlements-client'
import { getErrorMessage } from '@/lib/errors/get-error-message'
import { useCanWrite } from '@/lib/hooks/use-can-write'
import {
  attentionCount,
  PAYMENT_STATUS_KEYS,
  PAYMENT_STATUS_VARIANTS,
  paymentBookable,
  paymentRebookable,
  paymentReviewKey,
  SETTLEMENT_STATUS_KEYS,
  SETTLEMENT_STATUS_VARIANTS,
  settlementReasonKey,
  type CollectedPaymentListItem,
  formatSettlementAmount,
  type SettlementsOverview,
} from '@/lib/collections/settlements-ui'
import { cn, formatDate } from '@/lib/utils'

type PaymentAnswer = { outcome: 'booked' | 'needs_review'; journal_entry_id?: string; reason?: string }

/**
 * Avräkningar: what customers paid to the collections provider (booked
 * against the clearing account on the day they paid) and the provider's
 * payouts (one voucher each, the settlement PDF as underlag). An obligation
 * view: it serves whatever the start gates say, so a company can always
 * finish booking what the provider already paid. Linked from the invoice
 * list's collections view, Att göra and the refused storno of a collected
 * payment. `?settlement=<id>` opens a payout, `?payment=<id>` marks a payment.
 */
export default function SettlementsPage() {
  const t = useTranslations('settlements')
  const locale = useLocale() === 'en' ? 'en' : 'sv'
  const router = useRouter()
  const searchParams = useSearchParams()
  const { canWrite } = useCanWrite()
  const { toast } = useToast()
  const [overview, setOverview] = useState<SettlementsOverview | null>(null)
  const [loadFailed, setLoadFailed] = useState(false)
  const [confirm, setConfirm] = useState<{ kind: 'book' | 'rebook'; payment: CollectedPaymentListItem } | { kind: 'book_all' } | null>(null)

  const words = useMemo(() => providerWords(overview?.provider, locale), [overview?.provider, locale])
  const tw = useCallback((key: string, values: Record<string, string | number> = {}) => capitalizeFirst(t(key, { ...words, ...values })), [t, words])

  const openSettlementId = searchParams.get('settlement')
  const markedPaymentId = searchParams.get('payment')

  const load = useCallback(async () => {
    const result = await settlementsCall<SettlementsOverview>('/api/collections/settlements')
    setLoadFailed(!result.ok)
    if (result.ok) setOverview(result.data)
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const bookable = useMemo(() => overview?.collectedPayments.filter(paymentBookable) ?? [], [overview])

  const showVoucherAction = (journalEntryId: string | undefined) =>
    journalEntryId ? (
      <ToastAction altText={t('toast_show_voucher')} asChild>
        <Link href={`/bookkeeping/${journalEntryId}`}>{t('toast_show_voucher')}</Link>
      </ToastAction>
    ) : undefined

  const reviewText = (reason: string | undefined | null) => {
    const key = paymentReviewKey(reason ?? null)
    if (key) return t(key)
    return reason ? getErrorMessage({ error: { code: reason } }, { locale }) : t('review_default')
  }

  const bookPayment = async (payment: CollectedPaymentListItem) => {
    const result = await settlementsCall<PaymentAnswer>(`/api/collections/payments/${payment.id}/book`, 'POST')
    await load()
    if (!result.ok) {
      toast({ title: t('toast_failed'), description: getErrorMessage(result.body, { locale }), variant: 'destructive' })
    } else if (result.data.outcome === 'booked') {
      toast({ title: t('toast_payment_booked'), action: showVoucherAction(result.data.journal_entry_id) })
    } else {
      toast({ title: t('toast_payment_needs_review'), description: reviewText(result.data.reason), variant: 'destructive' })
    }
  }

  const bookAll = async () => {
    let booked = 0
    let failed = 0
    for (const payment of bookable) {
      const result = await settlementsCall<PaymentAnswer>(`/api/collections/payments/${payment.id}/book`, 'POST')
      if (result.ok && result.data.outcome === 'booked') booked += 1
      else failed += 1
    }
    await load()
    toast({
      title: booked > 0 ? t('toast_payments_booked', { count: booked }) : t('toast_payment_needs_review'),
      description: failed > 0 ? t('toast_payments_not_booked', { count: failed }) : undefined,
      variant: failed > 0 ? 'destructive' : undefined,
    })
  }

  const rebookPayment = async (payment: CollectedPaymentListItem) => {
    const result = await settlementsCall<PaymentAnswer>(`/api/collections/payments/${payment.id}/rebook`, 'POST')
    await load()
    if (!result.ok) {
      toast({ title: t('toast_failed'), description: getErrorMessage(result.body, { locale }), variant: 'destructive' })
    } else if (result.data.outcome === 'booked') {
      toast({ title: t('toast_rebooked'), action: showVoucherAction(result.data.journal_entry_id) })
    } else {
      toast({ title: t('toast_payment_needs_review'), description: reviewText(result.data.reason), variant: 'destructive' })
    }
  }

  const openSettlement = (id: string | null) => {
    const params = new URLSearchParams(searchParams.toString())
    if (id) params.set('settlement', id)
    else params.delete('settlement')
    const query = params.toString()
    router.replace(query ? `/invoices/settlements?${query}` : '/invoices/settlements', { scroll: false })
  }

  const attention = overview ? attentionCount(overview) : 0
  const empty = overview && overview.collectedPayments.length === 0 && overview.settlements.length === 0
  // The voucher column only once a payout is booked: until then it is an empty column.
  const settlementVouchers = overview?.settlements.some((s) => s.journalEntryId && s.voucher) ?? false

  return (
    <div className="space-y-8">
      <PageHeader
        title={overview ? tw('title') : t('nav_title')}
        help={<HelpPopover>{tw('help')}</HelpPopover>}
        action={
          canWrite && bookable.length > 0 ? (
            <Button size="sm" onClick={() => setConfirm({ kind: 'book_all' })}>
              {t('payment_book_all', { count: bookable.length })}
            </Button>
          ) : undefined
        }
      />

      {loadFailed && (
        <div className="flex items-center gap-3 text-[13px] text-muted-foreground">
          <span>{t('load_failed')}</span>
          <Button variant="outline" size="sm" onClick={() => void load()}>
            {t('retry')}
          </Button>
        </div>
      )}

      {!overview && !loadFailed && (
        <div className="space-y-3">
          <Skeleton className="h-4 w-56" />
          <Skeleton className="h-32 w-full" />
        </div>
      )}

      {overview && attention > 0 && <p className="attn text-[12.5px]">{t('attention', { count: attention })}</p>}

      {empty && <EmptyState icon={Banknote} title={t('empty_title')} description={tw('empty_description')} />}

      {overview && !empty && (
        <>
          {/* A provider that has collected nothing yet: no section, the payouts below are all there is. */}
          {overview.collectedPayments.length > 0 && (
            <section className="space-y-3">
              <h2 className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">{tw('payments_heading')}</h2>
              <div className="overflow-x-auto">
                <table className="stagger-enter w-full border-collapse text-[13px]">
                  <thead>
                    <tr>
                      <th className={TH_CLASS}>{t('col_paid')}</th>
                      <th className={TH_CLASS}>{t('col_invoice')}</th>
                      <th className={TH_CLASS}>{t('col_customer')}</th>
                      <th className={cn(TH_CLASS, 'text-right')}>{t('col_amount')}</th>
                      <th className={TH_CLASS}>{t('col_status')}</th>
                      <th className={TH_CLASS}>{t('col_voucher')}</th>
                      <th className={TH_CLASS} />
                    </tr>
                  </thead>
                  <tbody>
                    {overview.collectedPayments.map((payment) => {
                      const variant = PAYMENT_STATUS_VARIANTS[payment.status]
                      const status = t(PAYMENT_STATUS_KEYS[payment.status])
                      return (
                        <tr key={payment.id} className={cn('hover:bg-secondary/35', markedPaymentId === payment.id && 'bg-secondary/35')}>
                          <td className={cn(TD_CLASS, 'tabular-nums')}>{formatDate(payment.paidAt)}</td>
                          <td className={TD_CLASS}>
                            <Link href={`/invoices/${payment.invoiceId}`} className="underline-offset-4 hover:underline">
                              {payment.invoiceNumber ?? '-'}
                            </Link>
                          </td>
                          <td className={cn(TD_CLASS, 'max-w-[220px] truncate')} data-ph-mask>
                            {payment.customerName ?? ''}
                          </td>
                          <td className={cn(TD_CLASS, 'text-right tabular-nums')}>{formatSettlementAmount(payment.capitalPaid)}</td>
                          <td className={TD_CLASS}>
                            {variant ? <Badge variant={variant}>{status}</Badge> : <span className="text-xs text-muted-foreground">{status}</span>}
                            {payment.status === 'needs_review' && (
                              <p className="mt-1 max-w-[260px] whitespace-normal text-xs text-muted-foreground">{reviewText(payment.reviewReason)}</p>
                            )}
                          </td>
                          <td className={cn(TD_CLASS, 'tabular-nums')}>
                            {payment.journalEntryId && payment.voucher ? (
                              <Link href={`/bookkeeping/${payment.journalEntryId}`} className="underline-offset-4 hover:underline">
                                {payment.voucher}
                              </Link>
                            ) : null}
                          </td>
                          <td className={cn(TD_CLASS, 'text-right')}>
                            {canWrite && paymentBookable(payment) && (
                              <Button variant="outline" size="sm" onClick={() => setConfirm({ kind: 'book', payment })}>
                                {t('row_book')}
                              </Button>
                            )}
                            {canWrite && paymentRebookable(payment) && (
                              <Button variant="ghost" size="sm" onClick={() => setConfirm({ kind: 'rebook', payment })}>
                                {t('payment_rebook')}
                              </Button>
                            )}
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            </section>
          )}

          <section className="space-y-3">
            {/* Alone on the page the payouts need no heading: the page title names them. */}
            {overview.collectedPayments.length > 0 && (
              <h2 className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">{t('payouts_heading')}</h2>
            )}
            {overview.settlements.length === 0 ? (
              <p className="text-[13px] text-muted-foreground">{t('payouts_empty')}</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="stagger-enter w-full border-collapse text-[13px]">
                  <thead>
                    <tr>
                      <th className={TH_CLASS}>{t('col_date')}</th>
                      <th className={TH_CLASS}>{t('col_reference')}</th>
                      <th className={cn(TH_CLASS, 'text-right')}>{t('col_amount')}</th>
                      <th className={TH_CLASS}>{t('col_status')}</th>
                      {settlementVouchers && <th className={TH_CLASS}>{t('col_voucher')}</th>}
                    </tr>
                  </thead>
                  <tbody>
                    {overview.settlements.map((settlement) => {
                      const variant = SETTLEMENT_STATUS_VARIANTS[settlement.status]
                      const status = t(SETTLEMENT_STATUS_KEYS[settlement.status])
                      const reasonKey = settlement.status === 'needs_mapping' ? settlementReasonKey(settlement.needsMappingReason) : null
                      return (
                        <tr
                          key={settlement.id}
                          className="cursor-pointer hover:bg-secondary/35"
                          onClick={() => openSettlement(settlement.id)}
                          title={reasonKey ? tw(reasonKey) : undefined}
                        >
                          <td className={cn(TD_CLASS, 'tabular-nums')}>{formatDate(settlement.paymentDate)}</td>
                          <td className={TD_CLASS}>
                            <button
                              type="button"
                              className="underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                              onClick={(event) => {
                                event.stopPropagation()
                                openSettlement(settlement.id)
                              }}
                            >
                              {settlement.providerSettlementRef}
                            </button>
                          </td>
                          <td className={cn(TD_CLASS, 'text-right tabular-nums')}>{formatSettlementAmount(settlement.amount)}</td>
                          <td className={TD_CLASS}>
                            {variant ? <Badge variant={variant}>{status}</Badge> : <span className="text-xs text-muted-foreground">{status}</span>}
                          </td>
                          {settlementVouchers && (
                            <td className={cn(TD_CLASS, 'tabular-nums')}>
                              {settlement.journalEntryId && settlement.voucher ? (
                                <Link
                                  href={`/bookkeeping/${settlement.journalEntryId}`}
                                  className="underline-offset-4 hover:underline"
                                  onClick={(event) => event.stopPropagation()}
                                >
                                  {settlement.voucher}
                                </Link>
                              ) : null}
                            </td>
                          )}
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </>
      )}

      <SettlementDetailSheet
        key={openSettlementId ?? 'closed'}
        settlementId={openSettlementId}
        words={words}
        canWrite={canWrite}
        onClose={() => openSettlement(null)}
        onChanged={() => void load()}
      />

      <ConfirmDialog
        open={confirm?.kind === 'book'}
        onOpenChange={(open) => !open && setConfirm(null)}
        title={t('confirm_payment_title')}
        description={
          confirm?.kind === 'book'
            ? tw('confirm_payment_body', {
                amount: formatSettlementAmount(confirm.payment.capitalPaid),
                invoice: confirm.payment.invoiceNumber ?? '-',
                date: formatDate(confirm.payment.paidAt),
              })
            : undefined
        }
        confirmLabel={t('payment_book')}
        onConfirm={() => (confirm?.kind === 'book' ? bookPayment(confirm.payment) : undefined)}
      />
      <ConfirmDialog
        open={confirm?.kind === 'rebook'}
        onOpenChange={(open) => !open && setConfirm(null)}
        title={t('confirm_rebook_title')}
        description={
          confirm?.kind === 'rebook'
            ? t('confirm_rebook_body', {
                voucher: confirm.payment.voucher ? t('voucher_link', { number: confirm.payment.voucher }) : t('the_voucher'),
                date: formatDate(confirm.payment.paidAt),
              })
            : undefined
        }
        confirmLabel={t('payment_rebook')}
        onConfirm={() => (confirm?.kind === 'rebook' ? rebookPayment(confirm.payment) : undefined)}
      />
      <ConfirmDialog
        open={confirm?.kind === 'book_all'}
        onOpenChange={(open) => !open && setConfirm(null)}
        title={t('confirm_payment_all_title')}
        description={t('confirm_payment_all_body', { count: bookable.length })}
        confirmLabel={t('payment_book_all', { count: bookable.length })}
        onConfirm={bookAll}
      />
    </div>
  )
}
