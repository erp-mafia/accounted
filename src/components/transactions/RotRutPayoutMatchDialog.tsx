'use client'

import { useTranslations } from 'next-intl'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog'
import { formatCurrency, formatDate } from '@/lib/utils'
import { roundOre } from '@/lib/money'
import {
  expectedRotRutPayoutAmount,
  getRotRutPayoutMatchTargetState,
} from '@/lib/invoices/rot-rut-payout-matching'
import { CheckCircle2, AlertTriangle } from 'lucide-react'
import type { TransactionWithInvoice } from './transaction-types'

interface RotRutPayoutMatchDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Row carrying `potential_rot_rut_payout`; the dialog renders nothing without it. */
  transaction: TransactionWithInvoice | null
  isConfirming: boolean
  onConfirm: () => void
}

/**
 * Confirm dialog for matching an income bank row to one or several open
 * ROT/RUT begäran: Skatteverkets utbetalning clears the 1513 receivable
 * (debit the row's cash account, one 1513 credit per begäran) and the row is
 * linked to that voucher.
 *
 * Kept separate from InvoiceMatchDialog on purpose: no FX, no preview fetch,
 * no editable lines. The legs are known up front, so everything the user
 * needs to approve is on screen. A bundle (several begäran paid in one
 * transfer) is booked at exactly the decided sums: partial and over
 * variants exist only for a single begäran.
 */
export default function RotRutPayoutMatchDialog({
  open,
  onOpenChange,
  transaction,
  isConfirming,
  onConfirm,
}: RotRutPayoutMatchDialogProps) {
  const t = useTranslations('tx_rot_rut_match')
  const requests = transaction?.potential_rot_rut_payout?.requests ?? []
  const isSet = requests.length > 1
  const single = requests.length === 1 ? requests[0] : null

  // Every begäran must still be open and unsettled; the first blocked one
  // explains the refusal.
  const blockedState =
    requests.map((request) => getRotRutPayoutMatchTargetState(request)).find((s) => s !== 'matchable') ??
    null
  const targetBlocked = requests.length === 0 || blockedState !== null

  const txAmount = transaction ? roundOre(transaction.amount) : 0
  const expected = roundOre(
    requests.reduce((sum, request) => sum + expectedRotRutPayoutAmount(request), 0),
  )
  const requestedTotal = roundOre(
    requests.reduce((sum, request) => sum + roundOre(Number(request.requested_total)), 0),
  )
  const diff = roundOre(Math.abs(txAmount - expected))
  const amountsMatch = diff < 0.01
  // The settle service refuses a payout below requested_total unless the
  // beslut (decided_total) is recorded: say so here instead of letting the
  // button fail.
  const isPartial = single ? txAmount < requestedTotal - 0.005 : false
  const partialBlocked = isPartial && single?.decided_total == null
  // The service refuses more than Skatteverket can owe on this begäran: a
  // larger row would drive 1513 negative. Block here too, with the reason.
  const overBlocked = single ? txAmount > expected + 0.005 : false
  // A bundle only ever books the exact sum of its begäran.
  const setBlocked = isSet && !amountsMatch
  // Skatteverket pays out in SEK only; the route refuses anything else.
  const currencyBlocked = (transaction?.currency || 'SEK').toUpperCase() !== 'SEK'
  const currency = transaction?.currency || 'SEK'

  const typeLabel = (deductionType: 'rot' | 'rut') => (deductionType === 'rut' ? 'RUT' : 'ROT')

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t('title')}</DialogTitle>
          <DialogDescription>
            {targetBlocked ? t('description_blocked') : t('description')}
          </DialogDescription>
        </DialogHeader>

        {transaction && requests.length > 0 && (
          <div className="space-y-4">
            <div className="rounded-lg border p-4 space-y-2">
              <p className="text-sm font-medium text-muted-foreground">{t('transaction_label')}</p>
              <p className="font-medium">{transaction.description}</p>
              <div className="flex justify-between text-sm">
                <span className="text-muted-foreground">{formatDate(transaction.date)}</span>
                <span className="font-medium text-success">
                  +{formatCurrency(transaction.amount, currency)}
                </span>
              </div>
            </div>

            <div className="rounded-lg border p-4 space-y-3">
              <p className="text-sm font-medium text-muted-foreground">
                {isSet ? t('requests_label', { count: requests.length }) : t('request_label')}
              </p>
              {requests.map((request) => (
                <div key={request.id} className="space-y-2">
                  <p className="font-medium">
                    {t('request_name', { type: typeLabel(request.deduction_type), name: request.name })}
                  </p>
                  <div className="flex justify-between text-sm">
                    <span className="text-muted-foreground">
                      {t('requested_total', {
                        amount: formatCurrency(roundOre(Number(request.requested_total)), 'SEK'),
                      })}
                    </span>
                    {request.decided_total != null && (
                      <span className="text-muted-foreground">
                        {t('decided_total', {
                          amount: formatCurrency(Number(request.decided_total), 'SEK'),
                        })}
                      </span>
                    )}
                  </div>
                  {request.invoices.length > 0 && (
                    <div className="pt-2 border-t space-y-1">
                      <p className="text-xs font-medium text-muted-foreground">{t('invoices_title')}</p>
                      <ul className="text-sm space-y-0.5">
                        {request.invoices.map((inv, i) => (
                          <li key={`${inv.invoice_number ?? 'x'}-${i}`} className="flex justify-between">
                            <span>{t('invoice_row', { number: inv.invoice_number ?? '' })}</span>
                            <span className="tabular-nums text-muted-foreground">
                              {formatCurrency(Number(inv.requested_amount), 'SEK')}
                            </span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                </div>
              ))}
              {isSet && (
                <div className="flex justify-between border-t pt-2 text-sm font-medium">
                  <span>{t('requests_total_label')}</span>
                  <span className="tabular-nums">{formatCurrency(expected, 'SEK')}</span>
                </div>
              )}
            </div>

            {targetBlocked ? (
              <div className="flex items-start gap-2 p-3 rounded-lg bg-muted/30 text-attn">
                <AlertTriangle className="h-4 w-4 flex-shrink-0 mt-0.5" />
                <div className="text-sm">
                  <p className="font-medium">
                    {t(blockedState === 'settled' ? 'target_settled_title' : 'target_not_open_title')}
                  </p>
                  <p>
                    {t(
                      blockedState === 'settled'
                        ? 'target_settled_description'
                        : 'target_not_open_description',
                    )}
                  </p>
                </div>
              </div>
            ) : amountsMatch ? (
              <div className="flex items-center gap-2 p-3 rounded-lg bg-success/10 text-success">
                <CheckCircle2 className="h-4 w-4 flex-shrink-0" />
                <p className="text-sm font-medium">
                  {isSet ? t('amounts_match_set') : t('amounts_match')}
                </p>
              </div>
            ) : (
              <div className="flex items-start gap-2 p-3 rounded-lg bg-muted/30 text-attn">
                <AlertTriangle className="h-4 w-4 flex-shrink-0 mt-0.5" />
                <div className="text-sm">
                  <p className="font-medium">{isSet ? t('amounts_differ_set') : t('amounts_differ')}</p>
                  <p>{t('amount_diff', { amount: formatCurrency(diff, currency) })}</p>
                  {setBlocked && <p className="mt-1">{t('set_exact_required')}</p>}
                  {overBlocked && <p className="mt-1">{t('over_payout_blocked')}</p>}
                  {partialBlocked && <p className="mt-1">{t('partial_requires_beslut')}</p>}
                  {isPartial && !partialBlocked && (
                    <p className="mt-1">{t('partial_with_beslut_note')}</p>
                  )}
                </div>
              </div>
            )}

            {!targetBlocked && (
              <div className="rounded-lg border p-4 space-y-2">
                <p className="text-sm font-medium">{t('booking_title')}</p>
                <div className="text-sm space-y-1">
                  <div className="flex justify-between">
                    <span>
                      <span className="text-muted-foreground">{t('booking_debit')}</span>{' '}
                      {t('booking_bank_line')}
                    </span>
                    <span className="tabular-nums">{formatCurrency(txAmount, currency)}</span>
                  </div>
                  {isSet ? (
                    requests.map((request) => (
                      <div key={request.id} className="flex justify-between">
                        <span>
                          <span className="text-muted-foreground">{t('booking_credit')}</span>{' '}
                          {t('booking_receivable_line_named', { name: request.name })}
                        </span>
                        <span className="tabular-nums">
                          {formatCurrency(expectedRotRutPayoutAmount(request), currency)}
                        </span>
                      </div>
                    ))
                  ) : (
                    <div className="flex justify-between">
                      <span>
                        <span className="text-muted-foreground">{t('booking_credit')}</span>{' '}
                        {t('booking_receivable_line')}
                      </span>
                      <span className="tabular-nums">{formatCurrency(txAmount, currency)}</span>
                    </div>
                  )}
                </div>
              </div>
            )}

            {!targetBlocked && (
              <div className="rounded-lg bg-muted/50 p-4 space-y-2">
                <p className="text-sm font-medium">{t('on_confirm_title')}</p>
                <ul className="text-sm text-muted-foreground space-y-1">
                  <li>• {t('on_confirm_link')}</li>
                  <li>
                    • {isSet ? t('on_confirm_requests', { count: requests.length }) : t('on_confirm_request')}
                  </li>
                  <li>• {t('on_confirm_voucher')}</li>
                </ul>
              </div>
            )}
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={isConfirming}>
            {t('cancel')}
          </Button>
          <Button
            onClick={onConfirm}
            disabled={
              isConfirming ||
              requests.length === 0 ||
              targetBlocked ||
              partialBlocked ||
              overBlocked ||
              setBlocked ||
              currencyBlocked
            }
          >
            {isConfirming ? t('confirming') : t('confirm')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
