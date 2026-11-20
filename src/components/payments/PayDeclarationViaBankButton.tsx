'use client'

import { useEffect, useState, type ReactNode } from 'react'
import dynamic from 'next/dynamic'
import { useTranslations } from 'next-intl'
import { Button } from '@/components/ui/button'
import { DialogLoadingSkeleton } from '@/components/ui/dialog-loading-skeleton'
import { fetchPaymentsAvailability, type SkattekontoPaymentSourceInput } from './payments-client'

const PaySkattekontoViaBankDialog = dynamic(() => import('./PaySkattekontoViaBankDialog'), { loading: DialogLoadingSkeleton })

interface PayDeclarationViaBankButtonProps {
  /** The declaration to pay: a momsdeklaration by its period, or the AGI of a month. Null opens a payment of the next charge. */
  source: SkattekontoPaymentSourceInput | null
  /** How the page names the declaration's period, for the dialog's line about what it pays. */
  sourceLabel?: string
  label?: string
  /** A line beside the button (what is to pay), shown only with it. */
  prompt?: ReactNode
  variant?: 'default' | 'outline'
  size?: 'default' | 'toolbar'
  /** Called when the dialog closes after a payment was made, approved or sent to the bank. */
  onDone?: () => void
}

/**
 * Betala via banken for a payment in to the skattekonto, where a filed
 * declaration shows its amount to pay (the momsdeklaration's step 4, the
 * salary run's tax payment) and on Betalningar. Rendered only where bank
 * payments are switched on for the company (GET /api/payments/availability),
 * like the button on Skattekonto; the dialog does the rest.
 */
export function PayDeclarationViaBankButton({
  source,
  sourceLabel,
  label,
  prompt,
  variant = 'default',
  size = 'default',
  onDone,
}: PayDeclarationViaBankButtonProps) {
  const t = useTranslations('skattekonto_bank_payment')
  const [available, setAvailable] = useState(false)
  const [open, setOpen] = useState(false)

  useEffect(() => {
    let cancelled = false
    fetchPaymentsAvailability()
      .then((data) => {
        if (!cancelled) setAvailable(data.available)
      })
      .catch(() => {
        // Without an answer the button stays away; the manual details still stand.
      })
    return () => {
      cancelled = true
    }
  }, [])

  if (!available) return null
  const button = (
    <Button variant={variant} size={size} onClick={() => setOpen(true)}>
      {label ?? t('pay_via_bank')}
    </Button>
  )
  return (
    <>
      {prompt ? (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-[13px] leading-6 text-muted-foreground">{prompt}</p>
          {button}
        </div>
      ) : (
        button
      )}
      {open && (
        <PaySkattekontoViaBankDialog
          open
          onOpenChange={(next) => {
            if (!next) setOpen(false)
          }}
          onDone={onDone}
          source={source}
          sourceLabel={sourceLabel}
        />
      )}
    </>
  )
}
