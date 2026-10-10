'use client'

import { useRef, useState } from 'react'
import { useTranslations } from 'next-intl'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { BankIdSigningFlow, type SigningFlowStage } from './BankIdSigningFlow'
import type { PaymentOrder } from './payments-client'

interface SignPaymentOrdersDialogProps {
  /** Approved orders from one account in one currency. */
  orders: PaymentOrder[]
  signerKnown: boolean
  onOpenChange: (open: boolean) => void
  /** Called on close when payments were sent to the bank. */
  onDone: () => void
}

/** Signera from the Betalningar page: one BankID for the selected approved payments. */
export function SignPaymentOrdersDialog({ orders, signerKnown, onOpenChange, onDone }: SignPaymentOrdersDialogProps) {
  const t = useTranslations('bank_payments')
  const [stage, setStage] = useState<SigningFlowStage>('method')
  const sent = useRef(false)

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
