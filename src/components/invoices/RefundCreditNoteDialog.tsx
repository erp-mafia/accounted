'use client'

import { useEffect, useMemo, useState } from 'react'
import { useTranslations } from 'next-intl'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { AttnLine } from '@/components/ui/attn-line'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { useToast } from '@/components/ui/use-toast'
import { useCashAccounts } from '@/lib/reference-data/hooks'
import { cashAccountBankName } from '@/lib/cash-accounts/labels'
import { getErrorMessage } from '@/lib/errors/get-error-message'
import { todayIsoStockholm } from '@/lib/dates/iso'
import { formatCurrency } from '@/lib/utils'
import { PINNED_JURISDICTION, resolveAccountRole } from '@/lib/bookkeeping/account-roles'
import type { InvoiceWithRelations } from '@/components/invoices/types'

/** The receivable the credit note left the customer's credit on (1510). */
const RECEIVABLE_ACCOUNT = resolveAccountRole(PINNED_JURISDICTION, 'accounts_receivable')

interface BookedCandidate {
  journal_entry_id: string
  entry_date: string
  voucher: string | null
}

interface RefundCreditNoteDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  creditNote: InvoiceWithRelations
  /** What the customer has tillgodo (planCreditNoteRefund), in kronor. */
  owed: number
  onSuccess: () => void
}

/**
 * "Registrera återbetalning" on a kreditfaktura (follow-up of crm#1435): the
 * day the money left and the account it left from. Books Dr 1510 / Cr that
 * account for the whole amount owed through the mark-paid door, which
 * records the refund on the credit note.
 */
export default function RefundCreditNoteDialog({
  open,
  onOpenChange,
  creditNote,
  owed,
  onSuccess,
}: RefundCreditNoteDialogProps) {
  const t = useTranslations('credit_note_refund_dialog')
  const { toast } = useToast()
  const { cashAccounts } = useCashAccounts({ enabledOnly: true })
  const [refundDate, setRefundDate] = useState(() => todayIsoStockholm())
  const [cashAccountId, setCashAccountId] = useState<string>('')
  const [booked, setBooked] = useState<BookedCandidate[] | null>(null)
  const [isSubmitting, setIsSubmitting] = useState(false)

  // The account the customer paid to first (the credit note keeps the
  // original's payee), then the primary account.
  useEffect(() => {
    if (!open || cashAccountId || cashAccounts.length === 0) return
    const preferred =
      cashAccounts.find((a) => a.id === creditNote.payment_cash_account_id) ??
      cashAccounts.find((a) => a.is_primary) ??
      cashAccounts[0]
    setCashAccountId(preferred.id)
  }, [open, cashAccountId, cashAccounts, creditNote.payment_cash_account_id])

  useEffect(() => {
    if (!open) setBooked(null)
  }, [open])

  const account = useMemo(() => cashAccounts.find((a) => a.id === cashAccountId) ?? null, [cashAccounts, cashAccountId])

  const submit = async (force: boolean) => {
    if (!account) return
    setIsSubmitting(true)
    try {
      const response = await fetch(`/api/invoices/${creditNote.id}/mark-paid`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          payment_date: refundDate,
          lines: [
            { account_number: RECEIVABLE_ACCOUNT, debit_amount: owed, credit_amount: 0 },
            { account_number: account.ledger_account, debit_amount: 0, credit_amount: owed },
          ],
          ...(force ? { force: true } : {}),
        }),
      })
      if (!response.ok) {
        const data = await response.json().catch(() => null)
        const error = (data as { error?: { code?: string; details?: { candidates?: BookedCandidate[] } } } | null)?.error
        if (error?.code === 'CREDIT_NOTE_REFUND_LIKELY_BOOKED') {
          setBooked(error.details?.candidates ?? [])
          return
        }
        toast({
          title: t('failed_title'),
          description: getErrorMessage(data, { context: 'invoice', statusCode: response.status }),
          variant: 'destructive',
        })
        return
      }
      onOpenChange(false)
      onSuccess()
    } catch (error) {
      toast({ title: t('failed_title'), description: getErrorMessage(error, { context: 'invoice' }), variant: 'destructive' })
    } finally {
      setIsSubmitting(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[520px]">
        <DialogHeader>
          <DialogTitle>
            {/* data-ph-mask: the credit note number is user data */}
            {t('title')}
            {creditNote.invoice_number ? <span data-ph-mask="">{` ${creditNote.invoice_number}`}</span> : null}
          </DialogTitle>
          <DialogDescription>{t('description', { amount: formatCurrency(owed, 'SEK') })}</DialogDescription>
        </DialogHeader>

        {booked ? (
          <AttnLine>
            {t('likely_booked', {
              vouchers: booked.map((c) => c.voucher ?? c.entry_date).join(', '),
            })}
          </AttnLine>
        ) : (
          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="refund-date">{t('date_label')}</Label>
              <Input
                id="refund-date"
                type="date"
                value={refundDate}
                onChange={(e) => setRefundDate(e.target.value)}
                className="w-full sm:w-48"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="refund-account">{t('account_label')}</Label>
              <Select value={cashAccountId} onValueChange={setCashAccountId}>
                <SelectTrigger id="refund-account">
                  <SelectValue placeholder={t('account_placeholder')} />
                </SelectTrigger>
                <SelectContent>
                  {cashAccounts.map((a) => (
                    <SelectItem key={a.id} value={a.id}>
                      {a.ledger_account}
                      {cashAccountBankName(a) ? ` · ${cashAccountBankName(a)}` : ''}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            {account && (
              <div className="rounded-lg border border-border bg-secondary/40 px-4 py-3 text-sm">
                <div className="flex justify-between gap-4">
                  <span>{t('line_debit', { account: RECEIVABLE_ACCOUNT })}</span>
                  <span className="tabular-nums">{formatCurrency(owed, 'SEK')}</span>
                </div>
                <div className="flex justify-between gap-4">
                  <span>{t('line_credit', { account: account.ledger_account })}</span>
                  <span className="tabular-nums">{formatCurrency(owed, 'SEK')}</span>
                </div>
              </div>
            )}
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={isSubmitting}>
            {t('cancel')}
          </Button>
          <Button onClick={() => submit(booked !== null)} disabled={!account || !refundDate} loading={isSubmitting}>
            {booked ? t('book_anyway') : t('confirm')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
