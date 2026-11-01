'use client'

import { useState } from 'react'
import { useTranslations } from 'next-intl'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { useToast } from '@/components/ui/use-toast'
import { isAccountNumber, isIsoDateShaped } from '@/lib/invariants'
import { parseAmountInput } from '@/lib/money'
import { usePaymentBankLedger } from '@/lib/reference-data/hooks'
import { formatLossAmount } from '@/lib/customer-loss/text'
import { postCustomerLoss } from './use-customer-loss'

interface Props {
  invoiceId: string
  invoiceNumber: string | null
  /** How much a recovery can still take, VAT included. */
  left: number
  today: string
  open: boolean
  onOpenChange: (open: boolean) => void
  onDone: () => void
}

/**
 * "Bokför återvunnen kundförlust": a payment after a konstaterad write-off is
 * income (3950) and its VAT is reported again; the invoice stays written off.
 */
export function RecoveredLossDialog({ invoiceId, invoiceNumber, left, today, open, onOpenChange, onDone }: Props) {
  const t = useTranslations('customer_loss')
  const { toast } = useToast()
  const [amount, setAmount] = useState('')
  const paymentLedger = usePaymentBankLedger()
  const [accountChoice, setAccountChoice] = useState<string | null>(null)
  const account = accountChoice ?? paymentLedger
  const [reason, setReason] = useState('')
  const [entryDate, setEntryDate] = useState(today)
  const [sending, setSending] = useState(false)

  // Start from a clean form each time the dialog opens.
  const [openedFor, setOpenedFor] = useState(open)
  if (open !== openedFor) {
    setOpenedFor(open)
    if (open) {
      setAmount('')
      setAccountChoice(null)
      setReason('')
      setEntryDate(today)
    }
  }

  // The shared amount grammar (lib/money.ts); NaN keeps an unreadable amount unsendable.
  const parsed = parseAmountInput(amount) ?? Number.NaN
  const canSend =
    Number.isFinite(parsed) &&
    parsed > 0 &&
    parsed <= left &&
    isAccountNumber(account) &&
    reason.trim().length > 0 &&
    isIsoDateShaped(entryDate)

  async function send() {
    setSending(true)
    const result = await postCustomerLoss(invoiceId, {
      kind: 'recovered',
      amount: parsed,
      payment_account: account,
      reason: reason.trim(),
      entry_date: entryDate,
    })
    setSending(false)
    if (result.ok) {
      toast({ title: t('booked_toast') })
      onOpenChange(false)
      onDone()
    } else {
      toast({ title: t('failed_toast'), description: result.message ?? undefined, variant: 'destructive' })
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{t('recovery_title', { number: invoiceNumber ?? '' })}</DialogTitle>
          <DialogDescription>{t('recovery_description')}</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="recovery-amount">{t('recovery_amount')}</Label>
            <Input id="recovery-amount" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />
            <p className="text-xs text-muted-foreground">{t('recovery_left', { amount: formatLossAmount(left) })}</p>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="recovery-account">{t('recovery_account')}</Label>
            <Input id="recovery-account" inputMode="numeric" maxLength={4} value={account} onChange={(e) => setAccountChoice(e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="recovery-reason">{t('reason')}</Label>
            <Textarea id="recovery-reason" rows={2} maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="recovery-date">{t('date')}</Label>
            <Input id="recovery-date" type="date" value={entryDate} onChange={(e) => setEntryDate(e.target.value)} />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={sending}>
            {t('cancel')}
          </Button>
          <Button onClick={() => void send()} loading={sending} disabled={!canSend}>
            {t('recovery_confirm')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
