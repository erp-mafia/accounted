'use client'

import useSWR from 'swr'
import { useCompany } from '@/contexts/CompanyContext'

/**
 * The browser's view of the arcim-migration deduction step (crm#1144): Visma
 * invoices imported without their ROT, RUT or grön teknik deduction. The
 * shapes mirror extensions/general/arcim-migration/lib/deduction-backfill.ts,
 * restated here because core code never imports from @/extensions.
 */
export const MIGRATED_DEDUCTION_ROUTE = '/api/extensions/ext/arcim-migration/deduction-backfill'

export type DeductionBackfillMode = 'preview' | 'apply'
export type DeductionBackfillStopReason = 'rate_limited' | 'reconnect' | 'period_locked' | 'accounts' | 'deadline'
export type DeductionBackfillBucket =
  | 'apply_unpaid'
  | 'apply_partially_paid'
  | 'apply_paid'
  | 'status_only'
  | 'review'
  | 'double_request'

/** The planner's review reasons plus the runner's own 'not_found_at_provider'. */
export type DeductionBackfillReviewReason =
  | 'not_sek'
  | 'several_buyers'
  | 'personnummer'
  | 'rows_differ'
  | 'unmapped_work_type'
  | 'missing_hours'
  | 'missing_property'
  | 'deduction_not_whole_kronor'
  | 'deduction_exceeds_remaining'
  | 'provider_remaining_differs'
  | 'payment_date_missing'
  | 'past_deadline'
  | 'voucher_without_deduction'
  | 'not_found_at_provider'

export type DeductionBackfillSkipReason =
  | 'no_deduction'
  | 'requested_at_provider'
  | 'rejected_at_provider'
  | 'already_applied'
  | 'not_open'

export interface DeductionBackfillInvoice {
  invoiceId: string
  invoiceNumber: string | null
  deductionTotal?: number
  paidOn?: string
}

export interface DeductionBackfillReport {
  mode: DeductionBackfillMode
  complete: boolean
  stopReason: DeductionBackfillStopReason | null
  candidates: number
  processed: number
  buckets: Record<DeductionBackfillBucket, { count: number; amount: number }>
  skipped: Partial<Record<DeductionBackfillSkipReason, number>>
  review: Array<DeductionBackfillInvoice & { reason: DeductionBackfillReviewReason }>
  doubleRequests: DeductionBackfillInvoice[]
  applied: { invoices: number; amount: number; statusRepaired: number }
  failures: Array<DeductionBackfillInvoice & { code: string }>
}

export interface DeductionBackfillStatus {
  applicable: boolean
  importRunning: boolean
}

async function readStatus(url: string): Promise<DeductionBackfillStatus> {
  const response = await fetch(url, { cache: 'no-store' })
  if (!response.ok) throw new Error('Deduction backfill status unavailable')
  return (await response.json()).data
}

/**
 * Whether the step applies to the active company. A failed read counts as
 * not applicable: the step is offered, never announced as broken.
 */
export function useMigratedDeductionStatus(): DeductionBackfillStatus | null {
  const { company } = useCompany()
  const { data } = useSWR(
    company ? [MIGRATED_DEDUCTION_ROUTE, company.id] : null,
    ([url]) => readStatus(url),
    // While the move is still writing invoices, look again until it is done.
    { refreshInterval: (latest) => (latest?.importRunning ? 15_000 : 0) },
  )
  return data ?? null
}
