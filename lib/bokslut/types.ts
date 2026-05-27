import type { CreateJournalEntryLineInput } from '@/types'

export type DispositionKind =
  | 'bolagsskatt'
  | 'periodiseringsfond_avsattning'
  | 'periodiseringsfond_ateforing'
  | 'overavskrivningar'
  | 'sarskild_loneskatt'
  | 'uppskjuten_skatt'

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
  /** Final voucher lines if the user accepts. Already balanced. */
  lines: CreateJournalEntryLineInput[]
  /** Soft warnings the UI surfaces beside the card (e.g. forced p-fond reversal,
   *  rate cap reached). Not blockers. */
  warnings: string[]
  /** Calculator-specific breakdown the UI can render in an "Visa beräkning"
   *  panel. Free-form so each calculator can show its own details. */
  computation?: Record<string, unknown>
  /** True if this proposal cannot be skipped — e.g. periodiseringsfond from
   *  tax year N-6 that must be reversed. UI disables the skip control. */
  required?: boolean
}

/**
 * Snapshot of all proposed dispositions for a fiscal period, returned by the
 * dispositions API. Order is the suggested user-flow order: p-fond återföring
 * (mandatory) → överavskrivningar → p-fond avsättning → SLP → bolagsskatt.
 * The wizard renders them in that order so each step's effect is visible to
 * the next one (bolagsskatt comes last because it depends on everything else).
 */
export interface DispositionsProposal {
  entityType: 'aktiebolag' | 'enskild_firma' | 'handelsbolag' | 'kommanditbolag' | 'ekonomisk_forening'
  fiscalPeriod: {
    id: string
    name: string
    period_start: string
    period_end: string
  }
  /** Result before any new dispositions, from the income statement (positive = profit). */
  netResultBefore: number
  proposals: ProposedDisposition[]
}
