'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useLocale, useTranslations } from 'next-intl'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Checkbox } from '@/components/ui/checkbox'
import { Skeleton } from '@/components/ui/skeleton'
import { AttnLine } from '@/components/ui/attn-line'
import { useToast } from '@/components/ui/use-toast'
import { getErrorMessage, type ErrorLocale } from '@/lib/errors/get-error-message'
import { formatCurrency, formatDate } from '@/lib/utils'
import { BankIdSigningFlow, type SigningFlowStage } from './BankIdSigningFlow'
import {
  approvePaymentOrders,
  fetchPaymentsAvailability,
  payeeLabel,
  PaymentsClientError,
  preparePaymentOrders,
  type PaymentOrder,
  type PaymentsAvailability,
  type PreparedOrders,
} from './payments-client'

/**
 * Betala via banken, from the supplier invoice list:
 *   setup:   the account to pay from and an optional payment date
 *   review:  one draft per invoice, the payee it goes to, what was skipped;
 *            Godkänn attests the drafts (each new or changed account is
 *            confirmed one by one)
 *   sign:    BankID for the approved payments (BankIdSigningFlow)
 * Godkänn and Signera are never the same button. Drafts a person does not
 * approve stay on the Betalningar page under Att godkänna.
 */

type Phase = 'setup' | 'review' | 'sign'

interface PayViaBankDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  invoiceIds: string[]
  /** Supplier and invoice number per invoice id, for the rows and the skipped list. */
  invoiceLabelById?: ReadonlyMap<string, string>
  /** Called when the dialog closes after anything changed (drafts made, approved or sent to the bank). */
  onDone: () => void
}

function needsPayeeConfirmation(order: PaymentOrder): boolean {
  return order.payee_check === 'new' || order.payee_check === 'changed'
}

export default function PayViaBankDialog({ open, onOpenChange, invoiceIds, invoiceLabelById, onDone }: PayViaBankDialogProps) {
  const t = useTranslations('bank_payments')
  const locale = useLocale() as ErrorLocale
  const { toast } = useToast()

  const [phase, setPhase] = useState<Phase>('setup')
  const [availability, setAvailability] = useState<PaymentsAvailability | null>(null)
  const [accountId, setAccountId] = useState('')
  const [executionDate, setExecutionDate] = useState('')
  const [prepared, setPrepared] = useState<PreparedOrders | null>(null)
  const [confirmedInvoices, setConfirmedInvoices] = useState<Set<string>>(new Set())
  const [busy, setBusy] = useState(false)
  const [signingStage, setSigningStage] = useState<SigningFlowStage>('method')
  const changed = useRef(false)

  const fail = useCallback(
    (title: string, error: unknown) => {
      const body = error instanceof PaymentsClientError ? error.body : null
      toast({ title, description: getErrorMessage(body, { locale }), variant: 'destructive' })
    },
    [locale, toast],
  )

  useEffect(() => {
    if (!open) return
    let cancelled = false
    fetchPaymentsAvailability()
      .then((data) => {
        if (cancelled) return
        setAvailability(data)
        const first = data.accounts.find((a) => a.payable)
        if (first) setAccountId(first.id)
      })
      .catch(() => {
        if (!cancelled) setAvailability({ available: false, reason: null, provider: null, accounts: [], signer_known: false })
      })
    return () => {
      cancelled = true
    }
  }, [open])

  const payableAccounts = useMemo(() => availability?.accounts.filter((a) => a.payable) ?? [], [availability])
  const orders = useMemo(() => prepared?.orders ?? [], [prepared])
  const total = useMemo(() => orders.reduce((sum, o) => sum + Number(o.amount), 0), [orders])
  const toConfirm = useMemo(() => orders.filter(needsPayeeConfirmation), [orders])
  const allConfirmed = toConfirm.every((o) => o.supplier_invoice_id && confirmedInvoices.has(o.supplier_invoice_id))

  async function prepare() {
    setBusy(true)
    try {
      const result = await preparePaymentOrders({
        supplierInvoiceIds: invoiceIds,
        cashAccountId: accountId,
        executionDate: executionDate || null,
      })
      changed.current = true
      setPrepared(result)
      setPhase('review')
    } catch (error) {
      fail(t('prepare_failed_title'), error)
    } finally {
      setBusy(false)
    }
  }

  async function approve() {
    if (!prepared || orders.length === 0) return
    setBusy(true)
    try {
      await approvePaymentOrders({
        orderIds: orders.map((o) => o.id),
        confirmedPayeeInvoiceIds: [...confirmedInvoices],
      })
      setPrepared({ ...prepared, orders: orders.map((o) => ({ ...o, status: 'approved' as const })) })
      setPhase('sign')
    } catch (error) {
      fail(t('approve_failed_title'), error)
    } finally {
      setBusy(false)
    }
  }

  function close(nextOpen: boolean) {
    if (!nextOpen && changed.current) onDone()
    onOpenChange(nextOpen)
  }

  const closeButton = (
    <Button variant="secondary" onClick={() => close(false)}>
      {t('close')}
    </Button>
  )

  const title =
    phase === 'sign' ? (signingStage === 'done' ? t('title_done') : t('title_sign')) : phase === 'review' ? t('title_review') : t('title')

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription className="sr-only">{t('title')}</DialogDescription>
        </DialogHeader>

        {phase === 'setup' && (
          <div className="space-y-4">
            {!availability ? (
              <div className="space-y-3">
                <Skeleton className="h-4 w-1/2" />
                <Skeleton className="h-9 w-full" />
              </div>
            ) : payableAccounts.length === 0 ? (
              <AttnLine>{t('account_none')}</AttnLine>
            ) : (
              <>
                <label className="block space-y-2 text-[13px]">
                  <span className="text-muted-foreground">{t('account_label')}</span>
                  <select
                    className="h-9 w-full rounded-lg border border-border bg-background px-3 text-[13px]"
                    value={accountId}
                    onChange={(e) => setAccountId(e.target.value)}
                  >
                    {payableAccounts.map((a) => (
                      <option key={a.id} value={a.id}>
                        {`${a.ledger_account} ${a.name ?? ''} ${a.iban ?? ''}`.trim()}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="block space-y-2 text-[13px]">
                  <span className="text-muted-foreground">{t('date_label')}</span>
                  <Input type="date" value={executionDate} onChange={(e) => setExecutionDate(e.target.value)} className="w-[180px] tabular-nums" />
                  <span className="block text-[12.5px] text-muted-foreground">{t('date_hint')}</span>
                </label>
              </>
            )}
            <DialogFooter>
              {closeButton}
              <Button onClick={prepare} loading={busy} disabled={!accountId || payableAccounts.length === 0}>
                {t('prepare')}
              </Button>
            </DialogFooter>
          </div>
        )}

        {phase === 'review' && prepared && (
          <div className="space-y-4">
            {orders.length > 0 && (
              <div className="overflow-x-auto">
                <table className="w-full border-collapse text-[13px]">
                  <thead>
                    <tr className="border-b border-border text-left text-[11px] uppercase tracking-wider text-muted-foreground">
                      <th className="py-2 pr-3 font-medium">{t('th_supplier')}</th>
                      <th className="py-2 pr-3 font-medium">{t('th_payee')}</th>
                      <th className="py-2 pr-3 font-medium">{t('th_date')}</th>
                      <th className="py-2 text-right font-medium">{t('th_amount')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {orders.map((order) => {
                      const warnings = prepared.warnings.filter((w) => w.supplier_invoice_id === order.supplier_invoice_id)
                      const changedPayee = warnings.find((w) => w.code === 'payee_changed')
                      const unattested = warnings.some((w) => w.code === 'unattested')
                      const label = (order.supplier_invoice_id && invoiceLabelById?.get(order.supplier_invoice_id)) || order.reference
                      return (
                        <tr key={order.id} className="border-b border-border align-middle">
                          <td className="w-1/3 max-w-0 py-2 pr-3">
                            <span className="block truncate">{order.payee_name}</span>
                            <span className="block truncate text-[11px] text-muted-foreground">{label}</span>
                          </td>
                          <td className="whitespace-nowrap py-2 pr-3 tabular-nums">
                            <span>{payeeLabel(order)}</span>
                            {order.payee_check === 'changed' && (
                              <Badge
                                variant="warning"
                                className="ml-2 font-normal"
                                title={changedPayee?.alternative_payee ? t('payee_changed_detail', { alternative: changedPayee.alternative_payee }) : undefined}
                              >
                                {t('payee_changed')}
                              </Badge>
                            )}
                            {order.payee_check === 'new' && (
                              <Badge variant="outline" className="ml-2 font-normal">
                                {t('payee_new')}
                              </Badge>
                            )}
                            {unattested && (
                              <Badge variant="outline" className="ml-2 font-normal">
                                {t('unattested')}
                              </Badge>
                            )}
                          </td>
                          <td className="whitespace-nowrap py-2 pr-3 tabular-nums">{formatDate(order.requested_execution_date)}</td>
                          <td className="whitespace-nowrap py-2 text-right tabular-nums">{formatCurrency(Number(order.amount), order.currency)}</td>
                        </tr>
                      )
                    })}
                  </tbody>
                  <tfoot>
                    <tr>
                      <td colSpan={3} className="py-2 pr-3 text-muted-foreground">
                        {t('total')}
                      </td>
                      <td className="py-2 text-right font-medium tabular-nums">{formatCurrency(total, orders[0]?.currency ?? 'SEK')}</td>
                    </tr>
                  </tfoot>
                </table>
              </div>
            )}

            {prepared.skipped.length > 0 && (
              <div className="space-y-1 text-[12.5px] text-muted-foreground">
                <p>{t('skipped_title', { count: prepared.skipped.length })}</p>
                <ul className="space-y-1">
                  {prepared.skipped.map((s) => (
                    <li key={s.supplier_invoice_id}>
                      {invoiceLabelById?.get(s.supplier_invoice_id) ?? s.supplier_invoice_id}:{' '}
                      {t.has(`skip_${s.reason}`) ? t(`skip_${s.reason}`) : s.reason}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {toConfirm.length > 0 && (
              <div className="space-y-2">
                <p className="text-[12.5px] text-muted-foreground">{t('confirm_payees_intro')}</p>
                {toConfirm.map((order) => {
                  const invoiceId = order.supplier_invoice_id as string
                  return (
                    <label key={order.id} className="flex items-center gap-2 text-[13px]">
                      <Checkbox
                        className="border-foreground"
                        checked={confirmedInvoices.has(invoiceId)}
                        onCheckedChange={(v) =>
                          setConfirmedInvoices((prev) => {
                            const next = new Set(prev)
                            if (v === true) next.add(invoiceId)
                            else next.delete(invoiceId)
                            return next
                          })
                        }
                      />
                      <span>
                        {t('confirm_payee_row', { supplier: order.payee_name, payee: payeeLabel(order) })}
                      </span>
                    </label>
                  )
                })}
              </div>
            )}

            {orders.length > 0 && <p className="text-[12.5px] text-muted-foreground">{t('drafts_hint')}</p>}

            <DialogFooter>
              {closeButton}
              {orders.length > 0 && (
                <Button onClick={approve} loading={busy} disabled={busy || !allConfirmed}>
                  {t('approve', { count: orders.length })}
                </Button>
              )}
            </DialogFooter>
          </div>
        )}

        {phase === 'sign' && availability && (
          <BankIdSigningFlow
            orders={orders.map((o) => ({ id: o.id, payee_name: o.payee_name, amount: Number(o.amount), currency: o.currency }))}
            signerKnown={availability.signer_known}
            closeButton={closeButton}
            onStageChange={setSigningStage}
          />
        )}
      </DialogContent>
    </Dialog>
  )
}
