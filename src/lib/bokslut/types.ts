import type { CreateJournalEntryLineInput, EntityType } from '@/types'
import type { DeferredTaxSnapshot } from './tax-provision/deferred-tax-service'

export type DispositionKind =
  | 'bolagsskatt'
  | 'periodiseringsfond_avsattning'
  | 'periodiseringsfond_ateforing'
  | 'overavskrivningar'
  | 'sarskild_loneskatt'
  /** Uppskjuten skatt on temporary differences and a recognised loss, K3
   *  years only (BFNAR 2012:1 kap. 29): 8940 against 2240/1370. Not the
   *  'uppskjuten_skatt' kind removed 2026-08-05, which was on obeskattade
   *  reserver (K3 29.37 keeps those gross). */
  | 'uppskjuten_skatt_kap29'
  /** Fond för utvecklingsutgifter, K3 (ÅRL 4 kap. 2 och 8 §§): an equity
   *  transfer between 2089 and balanserat resultat, no result effect. */
  | 'fond_for_utvecklingsutgifter'

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
  /** Detected, but counts only once the user ticks it (dividends, crm#1726). */
  needsConfirmation?: boolean
}

export interface TaxAdjustmentSnapshot {
  items: TaxAdjustmentItem[]
  nonDeductibleExpenses: number
  nonTaxableIncome: number
  /** Prior years' unused deficit deducted this year (INK2S 4.14 a, SRU 7763). */
  deficitCarryforward: number
  /**
   * The underskottsregister (IL 40 kap.) for this fiscal year. Present only
   * while BOLAGET_COMPANY_IDS opens the register for a company that files
   * INK2; absent, the deficit is the manual entry exactly as before.
   */
  lossRegister?: TaxAdjustmentLossRegister
}

export interface TaxAdjustmentLossRegister {
  /** The register's row for the year, null when the year has none. */
  row: null | {
    taxLossCarryforwardId: string
    /** INK2S 4.14 a. */
    broughtForward: number
    /** INK2S 4.14 b. */
    amountBlockReduction: number
    /** INK2S 4.14 c. */
    groupBlockReduction: number
    /** 4.14 a less 4.14 b and 4.14 c: what the register says the year deducts. */
    deductible: number
    source: 'manual' | 'ink2_history' | 'tax_assessment' | 'computed'
  }
  /** True when a saved manual deficit differs from the register and is used instead. */
  overridden: boolean
}

/**
 * What the bolagsskatt preview is computed from (accounted#180): the result
 * as booked, and each proposed disposition not booked yet that moves it. The
 * card's tax assumes every one of them is booked, so a 0 kr tax can come from
 * a proposal the user may still skip; the wizard lists them in the
 * computation and names the ones in `zeroedBy` on the 0 kr card instead of
 * leaving the 0 kr unexplained.
 */
export interface BolagsskattBasis {
  /** Resultat före skatt in the ledger now (posted dispositions in it). */
  bookedResultBeforeTax: number
  /** Proposed, unposted dispositions in the preview, with their signed effect on the result. */
  pending: Array<{ kind: DispositionKind; label: string; resultEffect: number }>
  /** Bolagsskatt when every pending proposal is booked: the preview's figure. */
  taxWithProposals: number
  /** Bolagsskatt on the ledger as it stands, none of the pending proposals booked. */
  taxAsBooked: number
  /**
   * The pending proposals that take the tax to 0 kr: those that lower the
   * result (signed effect, negative), in booking order. Empty unless the
   * ledger as it stands carries tax and the preview, with every proposal
   * booked, is 0 kr.
   */
  zeroedBy: Array<{ kind: DispositionKind; label: string; resultEffect: number }>
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
  /**
   * The result before dispositions (positive = profit): resultat efter
   * finansiella poster as the declaration reads it (readYearResult), or the
   * income statement's result for a form without corporate tax dispositions.
   */
  netResultBefore: number
  proposals: ProposedDisposition[]
  taxAdjustments?: TaxAdjustmentSnapshot
  completedDispositions?: CompletedDisposition[]
  /** Non-blocking calculation warnings surfaced in the statutory wizard. */
  warnings?: string[]
  /** K3 years: what the uppskjuten skatt is computed from (absent in a K2 year). */
  deferredTax?: DeferredTaxSnapshot
  /** Forms with corporate tax: what the bolagsskatt preview is computed from. */
  taxBasis?: BolagsskattBasis
}
