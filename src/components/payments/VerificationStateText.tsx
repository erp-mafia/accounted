'use client'

import { useTranslations } from 'next-intl'
import { useFormat } from '@/lib/hooks/use-format'
import { formatDateTime } from '@/lib/utils'
import type { VerificationState } from '@/lib/payments/orders/verification-state'

/** What the sentence needs: the derived state and its dates (GET .../verification). */
export interface VerificationStateLike {
  state: VerificationState
  valid_until: string | null
  link_expires_at: string | null
}

/**
 * One sentence per verification state, the same on every surface (the Koppla
 * banken step, the Betalningar page, the payment dialog): where the company's
 * verification at the payment provider stands and what happens next. Renders
 * text only; the host puts it in its own line and adds its own button.
 */
export function VerificationStateText({ verification }: { verification: VerificationStateLike }) {
  const t = useTranslations('payments_verification')
  const { formatDateLong } = useFormat()
  const until = verification.link_expires_at ? formatDateTime(verification.link_expires_at) : ''
  switch (verification.state) {
    case 'not_started':
      return <>{t('state_not_started')}</>
    case 'form_open':
      return <>{t('state_form_open', { until })}</>
    case 'awaiting_signatory':
      return <>{t('state_awaiting_signatory', { until })}</>
    case 'link_expired':
      return <>{t('state_link_expired')}</>
    case 'valid':
      return <>{verification.valid_until ? t('state_valid', { date: formatDateLong(verification.valid_until) }) : t('state_valid_no_date')}</>
    case 'expiring':
      return <>{t('state_expiring', { date: verification.valid_until ? formatDateLong(verification.valid_until) : '' })}</>
    case 'expired':
      return <>{verification.valid_until ? t('state_expired', { date: formatDateLong(verification.valid_until) }) : t('state_expired_no_date')}</>
    default:
      return null
  }
}
