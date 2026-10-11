'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { useLocale, useTranslations } from 'next-intl'
import { Landmark } from 'lucide-react'
import { PageHeader } from '@/components/ui/page-header'
import { HelpPopover } from '@/components/ui/help-popover'
import { Button } from '@/components/ui/button'
import { BankMark } from '@/components/banks/BankMark'
import { FLOATING_BULK_BAR_CLASS } from '@/components/ui/floating-bulk-bar'
import { Badge } from '@/components/ui/badge'
import { Checkbox } from '@/components/ui/checkbox'
import { Skeleton } from '@/components/ui/skeleton'
import { EmptyState } from '@/components/ui/empty-state'
import { AttnLine } from '@/components/ui/attn-line'
import { UpgradeNote } from '@/components/billing/UpgradeNote'
import { TH_CLASS, TD_CLASS, QUIET_LINK_CLASS, HOVER_REVEAL_CLASS, CHECKBOX_REVEAL_CLASS } from '@/components/ui/dry-table'
import { DestructiveConfirmDialog, useDestructiveConfirm } from '@/components/ui/destructive-confirm-dialog'
import { useToast } from '@/components/ui/use-toast'
import { useCanWrite } from '@/lib/hooks/use-can-write'
import { getErrorMessage, type ErrorLocale } from '@/lib/errors/get-error-message'
import { cn, formatCurrency, formatDate } from '@/lib/utils'
import { ApprovePaymentOrdersDialog } from './ApprovePaymentOrdersDialog'
import { ResolvePaymentOrderDialog } from './ResolvePaymentOrderDialog'
import { SignPaymentOrdersDialog } from './SignPaymentOrdersDialog'
import {
  canCancel,
  needsResolution,
  PAYMENT_ORDER_SECTIONS,
  PAYMENT_ORDER_STATUS_BADGE,
  sectionOf,
  type PaymentOrderSection,
} from './payment-order-status'
import {
  providerCodeText,
  cancelPaymentOrder,
  fetchPaymentsAvailability,
  listPaymentOrders,
  orderInvoiceLabel,
  payeeLabel,
  PaymentsClientError,
  unapprovePaymentOrders,
  type PaymentOrder,
  type PaymentsAvailability,
} from './payments-client'

/**
 * Betalningar: every bank payment the company asked its bank to make, by where
 * it stands, plus the way to the payment files for companies that pay by file.
 * Payments are prepared from Leverantörsfakturor (Betala via banken); here they
 * are approved (Godkänn), signed with one BankID per basket (Signera), followed,
 * cancelled, and the rare one the bank could not settle is resolved by a person.
 */
export function PaymentOrdersPage() {
  const t = useTranslations('payments_page')
  const tStatus = useTranslations('bank_payments')
  const locale = useLocale() as ErrorLocale
  const { toast } = useToast()
  const { canWrite } = useCanWrite()
  const { dialogProps, confirm } = useDestructiveConfirm()

  const [availability, setAvailability] = useState<PaymentsAvailability | null>(null)
  const [orders, setOrders] = useState<PaymentOrder[] | null>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [approving, setApproving] = useState<PaymentOrder[] | null>(null)
  const [signing, setSigning] = useState<PaymentOrder[] | null>(null)
  const [resolving, setResolving] = useState<PaymentOrder | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)

  const fail = useCallback(
    (title: string, error: unknown) => {
      const body = error instanceof PaymentsClientError ? error.body : null
      toast({ title, description: getErrorMessage(body, { locale }), variant: 'destructive' })
    },
    [locale, toast],
  )

  const load = useCallback(async () => {
    const [avail, list] = await Promise.allSettled([fetchPaymentsAvailability(), listPaymentOrders()])
    setAvailability(avail.status === 'fulfilled' ? avail.value : { available: false, reason: null, provider: null, accounts: [], signer_known: false })
    setOrders(list.status === 'fulfilled' ? list.value : [])
  }, [])

  useEffect(() => {
    let cancelled = false
    load().catch(() => {
      if (!cancelled) {
        setAvailability({ available: false, reason: null, provider: null, accounts: [], signer_known: false })
        setOrders([])
      }
    })
    return () => {
      cancelled = true
    }
  }, [load])

  const refresh = useCallback(() => {
    setSelected(new Set())
    load().catch(() => {
      // The list keeps what it had; the next action reloads it.
    })
  }, [load])

  const available = availability?.available ?? false
  const bySection = useMemo(() => {
    const groups = new Map<PaymentOrderSection, PaymentOrder[]>()
    for (const section of PAYMENT_ORDER_SECTIONS) groups.set(section, [])
    for (const order of orders ?? []) groups.get(sectionOf(order))!.push(order)
    return groups
  }, [orders])

  const toSign = bySection.get('to_sign') ?? []
  const selectedOrders = toSign.filter((o) => selected.has(o.id))
  // One signing = one account and one currency (the server refuses a mix):
  // the first selected order decides which others may join.
  const anchor = selectedOrders[0] ?? null
  const selectable = (o: PaymentOrder) => !anchor || (o.cash_account_id === anchor.cash_account_id && o.currency === anchor.currency)
  const selectableToSign = toSign.filter(selectable)
  const allSelected = selectableToSign.length > 0 && selectableToSign.every((o) => selected.has(o.id))

  function toggle(id: string, on: boolean) {
    setSelected((prev) => {
      const next = new Set(prev)
      if (on) next.add(id)
      else next.delete(id)
      return next
    })
  }

  async function unapprove(order: PaymentOrder) {
    setBusyId(order.id)
    try {
      await unapprovePaymentOrders([order.id])
      refresh()
    } catch (error) {
      fail(t('action_failed_title'), error)
    } finally {
      setBusyId(null)
    }
  }

  async function cancel(order: PaymentOrder) {
    const atBank = order.status !== 'draft' && order.status !== 'approved'
    await confirm(
      {
        title: t('cancel_title'),
        description: atBank ? t('cancel_at_bank_description', { label: orderInvoiceLabel(order) }) : t('cancel_description', { label: orderInvoiceLabel(order) }),
        confirmLabel: t('cancel_confirm'),
        cancelLabel: t('cancel_keep'),
        variant: 'warning',
      },
      async () => {
        try {
          const result = await cancelPaymentOrder(order.id)
          if (!result.cancelled) toast({ title: t('cancel_not_confirmed_title'), description: t('cancel_not_confirmed'), variant: 'destructive' })
        } catch (error) {
          fail(t('action_failed_title'), error)
          throw error
        }
      },
    )
    // A refused cancel may still have moved the order (an error event, a
    // status the bank reported): reload either way once the dialog closed.
    refresh()
  }

  const statusLabel = (status: string) => {
    const key = `status_${status}`
    return tStatus.has(key) ? tStatus(key) : status
  }

  const loading = orders === null || availability === null
  const hasOrders = (orders?.length ?? 0) > 0

  const header = (
    <PageHeader
      title={t('title')}
      help={<HelpPopover>{t('help_body')}</HelpPopover>}
    />
  )

  if (loading) {
    return (
      <div className="space-y-8">
        {header}
        <div className="space-y-3">
          {[1, 2, 3].map((i) => (
            <div key={i} className="flex items-center gap-4 px-4 py-3">
              <Skeleton className="h-4 w-28" />
              <Skeleton className="h-4 w-20 flex-1" />
              <Skeleton className="h-4 w-24" />
            </div>
          ))}
        </div>
      </div>
    )
  }

  const filesSection = (
    <section className="space-y-3">
      <h2 className="text-sm font-medium uppercase tracking-wider text-muted-foreground">{t('files_heading')}</h2>
      <p className="text-[13px] text-muted-foreground">
        {t('files_body')}{' '}
        <Link href="/supplier-invoices/payment-files" className={QUIET_LINK_CLASS}>
          {t('files_link')}
        </Link>
      </p>
    </section>
  )

  return (
    <div className="space-y-8">
      {header}

      {available && canWrite && selectedOrders.length > 0 && (
        <div className={FLOATING_BULK_BAR_CLASS}>
          <span className="whitespace-nowrap">
            <strong className="font-semibold tabular-nums">{selectedOrders.length}</strong> {t('selected_count', { count: selectedOrders.length })}
          </span>
          <Button size="sm" onClick={() => setSigning(selectedOrders)}>
            {t('sign_selected', { count: selectedOrders.length })}
          </Button>
          <button type="button" className={QUIET_LINK_CLASS} onClick={() => setSelected(new Set())}>
            {t('clear_selection')}
          </button>
        </div>
      )}

      {!available && !hasOrders && (
        <>
          {filesSection}
          {availability?.reason === 'subscription' ? (
            <UpgradeNote>{t('requires_subscription')}</UpgradeNote>
          ) : (
            <p className="text-[12.5px] text-muted-foreground">{t('not_available')}</p>
          )}
        </>
      )}

      {(available || hasOrders) && !hasOrders && (
        <EmptyState
          icon={Landmark}
          title={t('empty_title')}
          description={t('empty_description')}
          actionLabel={t('empty_action')}
          actionHref="/supplier-invoices"
        />
      )}

      {hasOrders &&
        PAYMENT_ORDER_SECTIONS.map((section) => {
          const rows = bySection.get(section) ?? []
          if (rows.length === 0) return null
          const isToSign = section === 'to_sign'
          const isToApprove = section === 'to_approve'
          return (
            <section key={section} className="space-y-3">
              <div className="flex items-center justify-between gap-4">
                <h2 className="text-sm font-medium uppercase tracking-wider text-muted-foreground">
                  {t(`section_${section}`)} <span className="tabular-nums">({rows.length})</span>
                </h2>
                {isToApprove && canWrite && available && (
                  <Button size="sm" variant="outline" onClick={() => setApproving(rows)}>
                    {t('approve_all', { count: rows.length })}
                  </Button>
                )}
                {isToSign && canWrite && available && selectableToSign.length > 1 && (
                  <button
                    type="button"
                    className={QUIET_LINK_CLASS}
                    onClick={() => setSelected(allSelected ? new Set() : new Set(selectableToSign.map((o) => o.id)))}
                  >
                    {allSelected ? t('clear_selection') : t('select_all', { count: selectableToSign.length })}
                  </button>
                )}
              </div>
              {isToSign && anchor && toSign.some((o) => !selectable(o)) && <AttnLine>{t('mixed_accounts_hint')}</AttnLine>}
              <div className="overflow-x-auto">
                <table className="w-full border-collapse text-[13px]">
                  <thead>
                    <tr>
                      {isToSign && <th className={cn(TH_CLASS, 'w-10')} aria-hidden="true"></th>}
                      <th className={cn(TH_CLASS, 'w-full')}>{t('th_invoice')}</th>
                      <th className={TH_CLASS}>{t('th_payee')}</th>
                      <th className={TH_CLASS}>{t('th_date')}</th>
                      <th className={TH_CLASS}>{t('th_status')}</th>
                      <th className={cn(TH_CLASS, 'text-right')}>{t('th_amount')}</th>
                      <th className={cn(TH_CLASS, 'w-[200px]')} aria-hidden="true"></th>
                    </tr>
                  </thead>
                  <tbody className="stagger-enter">
                    {rows.map((order) => {
                      const variant = PAYMENT_ORDER_STATUS_BADGE[order.status]
                      const held = needsResolution(order)
                      const checked = selected.has(order.id)
                      const canPick = isToSign && canWrite && available && selectable(order)
                      return (
                        <tr
                          key={order.id}
                          className={cn('group transition-colors duration-150 hover:bg-secondary/35', checked && 'bg-secondary/40', canPick && 'cursor-pointer')}
                          onClick={
                            canPick
                              ? (e) => {
                                  // The row is the target; its own controls keep their clicks.
                                  if ((e.target as HTMLElement).closest('button, a, input, label, [role="checkbox"]')) return
                                  toggle(order.id, !checked)
                                }
                              : undefined
                          }
                        >
                          {isToSign && (
                            <td className={cn(TD_CLASS, 'w-10 pr-0')}>
                              <span className={cn(CHECKBOX_REVEAL_CLASS, checked && 'opacity-100')}>
                                <Checkbox
                                  className="border-foreground"
                                  checked={checked}
                                  disabled={!canPick}
                                  onCheckedChange={(v) => toggle(order.id, v === true)}
                                  aria-label={t('select_row')}
                                />
                              </span>
                            </td>
                          )}
                          <td className={cn(TD_CLASS, 'max-w-0')}>
                            <span className="block truncate">{orderInvoiceLabel(order)}</span>
                            <span className="block truncate text-[11px] text-muted-foreground">{order.reference}</span>
                          </td>
                          <td className={cn(TD_CLASS, 'whitespace-nowrap tabular-nums')}>
                            {payeeLabel(order)}
                            {(order.payee_check === 'new' || order.payee_check === 'changed') && order.status === 'draft' && (
                              <Badge variant={order.payee_check === 'changed' ? 'warning' : 'outline'} className="ml-2 font-normal">
                                {tStatus(order.payee_check === 'changed' ? 'payee_changed' : 'payee_new')}
                              </Badge>
                            )}
                          </td>
                          <td className={cn(TD_CLASS, 'whitespace-nowrap tabular-nums')}>{formatDate(order.requested_execution_date)}</td>
                          <td className={cn(TD_CLASS, 'whitespace-nowrap')}>
                            {held ? (
                              <Badge variant="warning" className="font-normal">
                                {tStatus('status_outcome_unknown')}
                              </Badge>
                            ) : variant ? (
                              <Badge variant={variant} className="font-normal">
                                {statusLabel(order.status)}
                              </Badge>
                            ) : (
                              <span className="text-muted-foreground">{statusLabel(order.status)}</span>
                            )}
                            {order.provider_error_code && (order.status === 'failed' || order.status === 'rejected') && (
                              <span className="ml-2 text-[11px] text-muted-foreground">{providerCodeText(tStatus, order.provider_error_code) ?? order.provider_error_code}</span>
                            )}
                          </td>
                          <td className={cn(TD_CLASS, 'whitespace-nowrap text-right tabular-nums rr-mask')}>
                            {formatCurrency(Number(order.amount), order.currency)}
                            {(() => {
                              const from = availability?.accounts.find((a) => a.id === order.cash_account_id)
                              return from ? (
                                <span className="flex items-center justify-end gap-1.5 text-[11px] text-muted-foreground">
                                  <BankMark bankName={from.bank_name} size={14} />
                                  {from.ledger_account}
                                </span>
                              ) : null
                            })()}
                          </td>
                          <td className={cn(TD_CLASS, 'whitespace-nowrap text-right')}>
                            {canWrite && (
                              <span className={cn('flex items-center justify-end gap-4', HOVER_REVEAL_CLASS)}>
                                {order.status === 'draft' && available && (
                                  <button type="button" className={QUIET_LINK_CLASS} onClick={() => setApproving([order])} disabled={busyId !== null}>
                                    {t('approve_one')}
                                  </button>
                                )}
                                {order.status === 'approved' && available && (
                                  <button type="button" className={QUIET_LINK_CLASS} onClick={() => setSigning([order])} disabled={busyId !== null}>
                                    {t('sign_one')}
                                  </button>
                                )}
                                {order.status === 'approved' && (
                                  <button type="button" className={QUIET_LINK_CLASS} onClick={() => unapprove(order)} disabled={busyId !== null}>
                                    {t('unapprove')}
                                  </button>
                                )}
                                {held && available && (
                                  <button type="button" className={QUIET_LINK_CLASS} onClick={() => setResolving(order)} disabled={busyId !== null}>
                                    {t('resolve')}
                                  </button>
                                )}
                                {canCancel(order) && !held && (
                                  <button type="button" className={QUIET_LINK_CLASS} onClick={() => cancel(order)} disabled={busyId !== null}>
                                    {t('cancel_one')}
                                  </button>
                                )}
                              </span>
                            )}
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            </section>
          )
        })}

      {(available || hasOrders) && filesSection}

      <DestructiveConfirmDialog {...dialogProps} />
      {approving && (
        <ApprovePaymentOrdersDialog
          orders={approving}
          onOpenChange={(open) => {
            if (!open) setApproving(null)
          }}
          onApproved={refresh}
        />
      )}
      {signing && availability && (
        <SignPaymentOrdersDialog
          orders={signing}
          signerKnown={availability.signer_known}
          onOpenChange={(open) => {
            if (!open) setSigning(null)
          }}
          onDone={refresh}
        />
      )}
      {resolving && (
        <ResolvePaymentOrderDialog
          order={resolving}
          onOpenChange={(open) => {
            if (!open) setResolving(null)
          }}
          onResolved={refresh}
        />
      )}
    </div>
  )
}
