/**
 * How the Autogiro page names states and files. Chips mark exceptions
 * (design.md convention 5): a normal state (an active mandate, a debit sent or
 * debited) is muted text, a Badge only where something needs a look.
 */
import type { useTranslations } from 'next-intl'
import { formatCurrency, formatDate } from '@/lib/utils'
import type { AutogiroFileRow, DebitBlocker, DebitStatus, MandateStatus, ReportDebitLine } from './types'

export type AutogiroT = ReturnType<typeof useTranslations<'autogiro'>>

type ExceptionVariant = 'warning' | 'destructive'

export const MANDATE_STATUS_VARIANT: Partial<Record<MandateStatus, ExceptionVariant>> = {
  pending: 'warning',
  rejected: 'destructive',
}

/** Failed and rejected debits need attention: the invoice stays open and is in Att dra again. */
export const DEBIT_STATUS_VARIANT: Partial<Record<DebitStatus, ExceptionVariant>> = {
  failed: 'destructive',
  rejected: 'destructive',
  refunded: 'warning',
}

export const REPORT_OUTCOME_VARIANT: Partial<Record<ReportDebitLine['outcome'], ExceptionVariant>> = {
  failed: 'destructive',
  rejected: 'destructive',
  refunded: 'warning',
  unknown: 'warning',
}

export const BLOCKER_KEY: Record<DebitBlocker, string> = {
  mandate_not_active: 'blocker_mandate_not_active',
  reference_unusable: 'blocker_reference_unusable',
  nothing_to_pay: 'blocker_nothing_to_pay',
}

const FILE_KIND_KEYS: Record<string, string> = {
  debits: 'file_kind_debits',
  mandates: 'file_kind_mandates',
  payment_specification: 'file_kind_payment_specification',
  rejected_payments: 'file_kind_rejected_payments',
  mandate_notice: 'file_kind_mandate_notice',
  mandate_register: 'file_kind_mandate_register',
  internet_bank_mandates: 'file_kind_internet_bank_mandates',
}

/** The name of a file or report kind; an unknown kind shows as stored. */
export function fileKindLabel(kind: string, t: AutogiroT): string {
  const key = FILE_KIND_KEYS[kind]
  return key ? t(key) : kind
}

function count(summary: Record<string, unknown>, key: string): number {
  const value = Number(summary[key])
  return Number.isFinite(value) ? value : 0
}

/** One line for a file: what it carried (the summary the routes stored with it). */
export function fileSummary(file: AutogiroFileRow, t: AutogiroT): string {
  const s = file.summary ?? {}
  if (file.kind === 'debits') {
    const first = typeof s.first_date === 'string' ? formatDate(s.first_date) : null
    const parts = [t('summary_debits', { count: count(s, 'debits') }), formatCurrency(count(s, 'total'))]
    if (first) parts.push(t('summary_first_date', { date: first }))
    return parts.join(', ')
  }
  if (file.kind === 'mandates' && file.direction === 'to_bankgirot') {
    return typeof s.payer_number === 'string'
      ? t('summary_cancelled_payer', { payer: s.payer_number })
      : t('summary_cancelled', { count: count(s, 'cancelled') })
  }
  if (file.kind === 'payment_specification' || file.kind === 'rejected_payments') {
    const parts = (['debited', 'failed', 'retry', 'rejected', 'refunded', 'unknown'] as const)
      .filter((key) => count(s, key) > 0)
      .map((key) => t(`summary_outcome_${key}`, { count: count(s, key) }))
    return parts.length > 0 ? parts.join(', ') : t('summary_nothing')
  }
  const parts = [t('summary_mandates', { count: count(s, 'mandates') })]
  for (const key of ['active', 'pending', 'cancelled', 'rejected', 'linked'] as const) {
    if (count(s, key) > 0) parts.push(t(`summary_mandates_${key}`, { count: count(s, key) }))
  }
  return parts.join(', ')
}
