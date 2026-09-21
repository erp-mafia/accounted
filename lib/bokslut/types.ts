import type { CreateJournalEntryLineInput, EntityType } from '@/types'

export type DispositionKind =
  | 'bolagsskatt'
  | 'periodiseringsfond_avsattning'
  | 'periodiseringsfond_ateforing'
  | 'overavskrivningar'
  | 'sarskild_loneskatt'

/**
 * Common shape every bokslut-disposition calculator returns. The wizard renders
 * one card per proposal; the API endpoint accepts a list of `{ kind, accept,
 * overrideAmount? }` from the user and posts the matching entries.
 */
export interface ProposedDisposition {
  kind: DispositionKind
  /** Short Swedish label for UI cards (e.g. "Bolagsskatt 20,6 %"). */
  label: string
  /** One-sentence Swedish explanation of what the entry does. */
  description: string
  /** SEK amount displayed in the card header. Always a positive number. */
  amount: number
  /** Signed posting amount when direction matters while `amount` remains a
   *  positive display value. Used by over-depreciation releases. */
  signedAmount?: number
  /** Final voucher lines if the user accepts. Already balanced. */
  lines: CreateJournalEntryLineInput[]
  /** Soft warnings the UI surfaces beside the card (e.g. forced p-fond reversal,
   *  rate cap reached). Not blockers. */
  warnings: string[]
  /** Calculator-specific breakdown the UI can render in an "Visa beräkning"
   *  panel. Free-form so each calculator can show its own details. */
  computation?: Record<string, unknown>
  /** True if this proposal cannot be skipped: e.g. periodiseringsfond from
   *  tax year N-6 that must be reversed. UI disables the skip control. */
  required?: boolean
}

export type TaxAdjustmentType =
  | 'non_deductible_expense'
  | 'non_taxable_income'
  /** INK2S 4.14 a: outnyttjat underskott från föregående beskattningsår (IL 40 kap. 2 §). */
  | 'deficit_carryforward'
export type TaxAdjustmentSource = 'detected' | 'manual'

export interface TaxAdjustmentItem {
  sourceKey: string
  source: TaxAdjustmentSource
  adjustmentType: TaxAdjustmentType
  description: string
  accountNumber: string | null
  amount: number
  included: boolean
}

export interface TaxAdjustmentSnapshot {
  items: TaxAdjustmentItem[]
  nonDeductibleExpenses: number
  nonTaxableIncome: number
  /** Prior years' unused deficit deducted this year (INK2S 4.14 a, SRU 7763). */
  deficitCarryforward: number
}

export interface CompletedDisposition {
  kind: DispositionKind
  label: string
  amount: number
  status: 'booked' | 'needs_correction'
  warnings: string[]
}

/**
 * Snapshot of all proposed dispositions for a fiscal period, returned by the
 * dispositions API. Order is the suggested user-flow order: p-fond återföring
 * (mandatory) → överavskrivningar → p-fond avsättning → SLP → bolagsskatt.
 * The wizard renders them in that order so each step's effect is visible to
 * the next one (bolagsskatt comes last because it depends on everything else).
 */
export interface DispositionsProposal {
  /** The company's legal form; the wizard reads its capabilities, never the name. */
  entityType: EntityType
  fiscalPeriod: {
    id: string
    name: string
    period_start: string
    period_end: string
  }
  /** Result before any new dispositions, from the income statement (positive = profit). */
  netResultBefore: number
  proposals: ProposedDisposition[]
  taxAdjustments?: TaxAdjustmentSnapshot
  completedDispositions?: CompletedDisposition[]
  /** Non-blocking calculation warnings surfaced in the statutory wizard. */
  warnings?: string[]
}
