'use client'

import { useRef, useState } from 'react'
import { useTranslations } from 'next-intl'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { BankIdSigningFlow, type SigningFlowStage } from './BankIdSigningFlow'
import type { PaymentOrder } from './payments-client'
import type { PaymentSigningReturn } from '@/lib/payments/orders/return-url'

interface SignPaymentOrdersDialogProps {
  /** Approved orders from one account in one currency. */
  orders: PaymentOrder[]
  signerKnown: boolean
  /** The bank the payments leave from, for its mark and the bank-page texts. */
  bankName?: string | null
  /** Back from the bank's own page: reopen at the signing's poll instead of the method choice. */
  resume?: PaymentSigningReturn | null
  onOpenChange: (open: boolean) => void
  /** Called on close when payments were sent to the bank. */
  onDone: () => void
}

/** Signera from the Betalningar page: one BankID for the selected approved payments. */
export function SignPaymentOrdersDialog({ orders, signerKnown, bankName = null, resume = null, onOpenChange, onDone }: SignPaymentOrdersDialogProps) {
  const t = useTranslations('bank_payments')
  const [stage, setStage] = useState<SigningFlowStage>(resume ? 'signing' : 'method')
  // A resumed signing was sent to the bank before the page reloaded: the list reloads on close.
  const sent = useRef(resume !== null)

  function close(nextOpen: boolean) {
    if (!nextOpen && sent.current) onDone()
    onOpenChange(nextOpen)
  }

  return (
    <Dialog open onOpenChange={close}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{stage === 'done' ? t('title_done') : t('title_sign')}</DialogTitle>
          <DialogDescription className="sr-only">{t('title_sign')}</DialogDescription>
        </DialogHeader>
        <BankIdSigningFlow
          orders={orders.map((o) => ({ id: o.id, payee_name: o.payee_name, amount: Number(o.amount), currency: o.currency }))}
          signerKnown={signerKnown}
          bankName={bankName}
          resume={resume}
          closeButton={
            <Button variant="secondary" onClick={() => close(false)}>
              {t('close')}
            </Button>
          }
          onSentToBank={() => {
            sent.current = true
          }}
          onStageChange={setStage}
        />
      </DialogContent>
    </Dialog>
  )
}
