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
import { Loader2 } from 'lucide-react'
import type { TransactionWithInvoice } from './transaction-types'

interface ExpensePayoutMatchDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Row carrying `potential_expense_payout`; the dialog renders nothing without it. */
  transaction: TransactionWithInvoice | null
  isConfirming: boolean
  onConfirm: () => void
}

/**
 * Confirm dialog for booking an outgoing bank row as the repayment of one
 * person's registered utlägg: the person's liability account is debited,
 * the row's cash account credited, the claims flip to paid and the row is
 * linked to the voucher, all in one RPC call. Two legs, amount from the bank
 * row, so everything to approve is known up front (convention 10).
 */
export default function ExpensePayoutMatchDialog({
  open,
  onOpenChange,
  transaction,
  isConfirming,
  onConfirm,
}: ExpensePayoutMatchDialogProps) {
  const t = useTranslations('tx_expense_payout_match')
  const match = transaction?.potential_expense_payout ?? null
  const currency = transaction?.currency || 'SEK'
  const amount = transaction ? Math.abs(transaction.amount) : 0

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{t('title')}</DialogTitle>
          <DialogDescription>{t('description')}</DialogDescription>
        </DialogHeader>

        {transaction && match && (
          <div className="space-y-4">
            <div className="rounded-lg border border-border p-4 space-y-1">
              <p className="font-medium">{transaction.description}</p>
              <div className="flex justify-between text-sm">
                <span className="text-muted-foreground tabular-nums">{formatDate(transaction.date)}</span>
                <span className="font-medium tabular-nums">{formatCurrency(-amount, currency)}</span>
              </div>
            </div>

            <div className="rounded-lg border border-border p-4 space-y-1 text-sm">
              <p className="font-medium">{match.claimant_name}</p>
              <p className="text-muted-foreground">
                {match.claim_count === 1
                  ? t('claims_one', { date: formatDate(match.oldest_expense_date) })
                  : t('claims_other', { count: match.claim_count, date: formatDate(match.oldest_expense_date) })}
              </p>
              <p className="text-xs text-muted-foreground tabular-nums pt-2 border-t border-border">
                {match.liability_account} D {formatCurrency(amount, 'SEK')} · 19xx K {formatCurrency(amount, 'SEK')}
              </p>
              <p className="text-xs text-muted-foreground">{t('outcome')}</p>
            </div>
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={isConfirming}>
            {t('cancel')}
          </Button>
          <Button onClick={onConfirm} disabled={isConfirming || !match}>
            {isConfirming && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
            {t('confirm')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
