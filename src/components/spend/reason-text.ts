'use client'

import { useTranslations } from 'next-intl'
import { formatCurrency } from '@/lib/utils'
import type { SpendKind, SpendReasonJson } from './types'

const KINDS: readonly SpendKind[] = [
  'card_purchase', 'card_invoice', 'fee', 'refund', 'chargeback', 'cashback', 'out_of_pocket', 'mileage', 'per_diem',
  'reimbursement', 'external_reimbursement', 'wallet_topup', 'wallet_unload', 'atm_withdrawal', 'personal_spend',
  'invoice', 'invoice_payment', 'balance_adjustment', 'other',
]

/** The kind of an expense, as a person reads it. */
export function useSpendKindText(): (kind: string) => string {
  const t = useTranslations('spend')
  return (kind) => t(`kind_${KINDS.includes(kind as SpendKind) ? kind : 'other'}`)
}

const REVIEW_CODES = new Set([
  'vat_without_receipt',
  'vat_over_simplified_limit',
  'representation',
  'foreign_merchant_domestic_vat',
  'vat_amount_mismatch',
  'payroll_related',
  'counter_account_needed',
  'wallet_account_differs',
  'no_fiscal_period',
])

/**
 * Why an expense waits for a person, or why it went back to the provider, as
 * sentences. Provider issues keep the service's own wording.
 */
export function useSpendReasonText(): (reason: SpendReasonJson) => string {
  const t = useTranslations('spend')
  return (reason) => {
    const p = reason.params
    if (reason.code === 'provider_issue') return reason.message ?? t('reason_provider_issue', { code: String(p.code ?? '') })
    if (reason.code === 'vat_over_simplified_limit') return t('reason_vat_over_simplified_limit', { amount: formatCurrency(Number(p.amount_sek)) })
    if (reason.code === 'vat_amount_mismatch') {
      return t('reason_vat_amount_mismatch', { stated: formatCurrency(Number(p.stated_sek)), expected: formatCurrency(Number(p.expected_sek)) })
    }
    if (reason.code === 'wallet_account_differs') {
      return t('reason_wallet_account_differs', { settings: String(p.settings ?? ''), provider: String(p.provider ?? '') })
    }
    if (reason.code === 'foreign_merchant_domestic_vat') return t('reason_foreign_merchant_domestic_vat', { country: String(p.country ?? '') })
    if (reason.code === 'representation') return t('reason_representation', { attendees: Number(p.attendees ?? 0) })
    if (reason.code === 'no_fiscal_period') return t('reason_no_fiscal_period', { date: String(p.date ?? '') })
    if (REVIEW_CODES.has(reason.code)) return t(`reason_${reason.code}`)
    // A rejection: what the provider was told.
    switch (reason.code) {
      case 'account_unknown':
        return t('rejected_account_unknown', { account: String(p.account ?? '') })
      case 'vat_code_unknown':
        return t('rejected_vat_code_unknown', { code: String(p.vat_code ?? '') })
      case 'dimension_unknown':
        return t('rejected_dimension_unknown', { dimension: String(p.dimension ?? ''), value: String(p.value ?? '') })
      case 'currency_unsupported':
        return t('rejected_currency_unsupported', { currency: String(p.currency ?? '') })
      case 'period_locked':
        return t('rejected_period_locked', { date: String(p.date ?? '') })
      case 'receipt_unusable':
        return t('rejected_receipt_unusable', { file: String(p.file ?? '') })
      case 'kind_unsupported':
      case 'account_missing':
      case 'vat_code_missing':
      case 'amounts_mismatch':
      case 'wallet_account_unknown':
        return t(`rejected_${reason.code}`)
      default:
        return t('rejected_other')
    }
  }
}

/** Why a connection's delivery stopped or stumbles, in words a person acts on. */
export function useSpendHealthText(): (code: string | null) => string {
  const t = useTranslations('spend')
  return (code) => {
    switch (code) {
      case 'CONNECTOR_SPEND_RECONNECT_REQUIRED':
        return t('health_reconnect')
      case 'CONNECTOR_SPEND_PROVIDER_ACCESS_DENIED':
        return t('health_access_denied')
      case 'CONNECTOR_CONNECTION_NOT_OWNED':
      case 'SPEND_CONNECT_UNCONFIGURED':
      case 'CONNECTOR_SCOPE_MISSING':
      case 'CONNECTOR_KEY_INVALID':
      case 'CONNECTOR_KEY_MISSING':
      case 'CONNECTOR_KEY_SUSPENDED':
        return t('health_connect_refused')
      case 'CONNECTOR_SPEND_PROVIDER_RATE_LIMITED':
      case 'CONNECTOR_RATE_LIMITED':
        return t('health_rate_limited')
      case null:
        return ''
      default:
        return t('health_other', { code })
    }
  }
}
