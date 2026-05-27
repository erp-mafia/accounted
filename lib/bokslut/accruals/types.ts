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
   *  skuld carries forward — see proposeVacationLiabilityChange). Phase 4
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
}
