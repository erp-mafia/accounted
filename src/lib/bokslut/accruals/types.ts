import type { CreateJournalEntryLineInput } from '@/types'

export type AccrualKind =
  | 'vacation_liability_change'
  | 'audit_fee'
  | 'social_fees_on_accrued_salary'
  | 'manual_prepaid_expense'
  | 'manual_accrued_expense'
  | 'deferred_revenue'
  | 'accrued_interest'
  | 'accrued_utility'

/**
 * A single accrual proposal the wizard renders as one card. Mirrors the
 * shape of `ProposedDisposition` (lib/bokslut/types.ts) so the wizard UI
 * patterns stay consistent across accruals and dispositioner.
 */
export interface AccrualProposal {
  kind: AccrualKind
  /** Short Swedish label for UI cards. */
  label: string
  /** One-sentence Swedish explanation. */
  description: string
  /** SEK amount displayed in the card header. Always positive. */
  amount: number
  /** Final voucher lines if the user accepts. Already balanced. */
  lines: CreateJournalEntryLineInput[]
  /** Date the entry should be reversed on (typically Jan 1 of next FY), or
   *  null for accruals that intentionally do NOT reverse (e.g. semesterlöne-
   *  skuld carries forward, see proposeVacationLiabilityChange). Phase 4
   *  ships this as metadata; the actual auto-reversal cron is follow-up
   *  infra. Using null instead of an empty string keeps the future cron's
   *  filter (`reverses_on IS NOT NULL`) unambiguous. */
  reverses_on: string | null
  /** Soft warnings the UI surfaces beside the card. Never blockers. */
  warnings: string[]
  /** Calculator-specific breakdown for the "Visa beräkning" panel. */
  computation?: Record<string, unknown>
}

/**
 * One employee in the semesterlöneskuld proposal's `computation.employees`:
 * liability = valued_days x day_value + earning_pay + variable_pay.
 */
export interface VacationProposalEmployee {
  employee_id: string
  employee_name: string
  employment_start: string
  vacation_rule: string
  entitled_days: number
  valued_days: number
  day_value: number
  day_value_estimated: boolean
  earning_pay: number
  variable_pay: number
  liability: number
}

/**
 * Snapshot of accrual proposals for a fiscal period.
 */
export interface AccrualsProposal {
  fiscalPeriod: {
    id: string
    name: string
    period_start: string
    period_end: string
  }
  proposals: AccrualProposal[]
  /** Reasons a detector looked and declined to propose (Swedish, one per
   *  detector). The UI shows them where the card would have been so a
   *  missing proposal never reads as "nothing to do". */
  notices: string[]
}
