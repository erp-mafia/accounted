'use client'

import { useTranslations } from 'next-intl'
import { formatCurrency } from '@/lib/utils'
import type { PosReviewReasonJson, PosTenderKind } from './types'

const TENDER_KINDS: readonly PosTenderKind[] = ['card', 'swish', 'cash', 'gift_card', 'invoice', 'prepaid', 'other']

/** The reasons a day waits for a person, as sentences. Provider issues keep the service's own wording. */
export function usePosReasonText(): (reason: PosReviewReasonJson) => string {
  const t = useTranslations('pos_sales')
  return (reason) => {
    const p = reason.params
    switch (reason.code) {
      case 'tender_unmapped': {
        const kind = TENDER_KINDS.includes(p.kind as PosTenderKind) ? (p.kind as PosTenderKind) : 'other'
        return t('reason_tender_unmapped', { method: kind === 'other' ? String(p.method) : t(`tender_${kind}`), amount: formatCurrency(Number(p.amount)) })
      }
      case 'vat_rate_unmapped':
        return Number(p.rate) === 0
          ? t('reason_zero_rate_unmapped', { gross: formatCurrency(Number(p.gross)) })
          : t('reason_vat_rate_unmapped', { rate: String(p.rate), gross: formatCurrency(Number(p.gross)) })
      case 'not_balanced':
        return t('reason_not_balanced', { difference: formatCurrency(Number(p.difference)) })
      case 'payments_without_sales':
        return t('reason_payments_without_sales', { amount: formatCurrency(Number(p.amount)) })
      case 'provider_issue':
        return reason.message ?? t('reason_provider_issue', { code: String(p.code) })
    }
  }
}

/** Why a connection's fetch stopped or stumbles, in words a person acts on. */
export function usePosHealthText(): (code: string | null) => string {
  const t = useTranslations('pos_sales')
  return (code) => {
    switch (code) {
      case 'CONNECTOR_POS_PROVIDER_ACCESS_DENIED':
        return t('health_access_denied')
      case 'CONNECTOR_POS_VENUE_NOT_GRANTED':
      case 'CONNECTOR_CONNECTION_NOT_OWNED':
        return t('health_not_granted')
      case 'POS_CONNECT_UNCONFIGURED':
      case 'CONNECTOR_SCOPE_MISSING':
      case 'CONNECTOR_KEY_INVALID':
      case 'CONNECTOR_KEY_MISSING':
      case 'CONNECTOR_KEY_SUSPENDED':
        return t('health_connect_refused')
      case 'CONNECTOR_POS_PROVIDER_RATE_LIMITED':
      case 'CONNECTOR_RATE_LIMITED':
        return t('health_rate_limited')
      case null:
        return ''
      default:
        return t('health_other', { code })
    }
  }
}
