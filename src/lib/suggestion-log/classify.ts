import { agentBookingFor, businessAccount, type BookingProposal, type ProposalBooking, type ProposalSource } from '@/lib/bookkeeping/proposal'
import { BANK_LINE_SUGGESTIONS } from '@/lib/composition/bank-line-suggestions'
import type { ConfidenceBand, DirectBookingSwitch } from './bank-line-suggestions'
import type { EntityType, LinePatternEntry, VatTreatment } from '@/types'

/**
 * How one decision on a bank line is written to suggestion_log: the
 * suggestions that were on offer, which one was acted on, what was booked
 * and the outcome. Pure, so every booking door classifies the same way.
 *
 * Outcome:
 *   - dismissed: the bank line was ignored (no final).
 *   - accepted:  the caller named a suggestion on offer and booked it as offered.
 *   - changed:   the caller named a suggestion on offer and booked something else.
 *   - manual:    no suggestion was named, or the named one was not on offer
 *                when the decision was made. matches_final still says which
 *                suggestions agreed with the booking.
 *
 * The confidence band is the acted-on suggestion's band under the
 * direct-booking policy (lib/transactions/direct-booking.ts), evaluated on
 * the proposal as it was offered and the company's one-click switch as it
 * was read with it: deterministic evidence, never the model's own words. No
 * suggestion acted on, or no switch read (a failed snapshot), no band.
 */

export type DecisionOutcome = 'accepted' | 'changed' | 'manual' | 'dismissed'

export type SuggestionLogSource = 'assistant' | 'rule' | 'catalog' | 'counterparty_template' | 'recent' | 'clearing' | 'precedent'

export interface LoggedSuggestion {
  source: SuggestionLogSource
  /** The proposal's stable id (catalog id, 'cp:<uuid>', 'assistant:<txid>'). */
  source_id: string
  rank: number
  proposal: {
    booking: ProposalBooking
    debit_account: string
    credit_account: string
    vat_treatment: VatTreatment | null
    line_pattern?: LinePatternEntry[]
  }
  confidence: number
  model: string | null
  prompt_sha256: string | null
  matches_final: boolean
  /** Set on a counterpart match the stored read took off the row (BookingProposal.contested). */
  contested?: true
  /**
   * Assistant only, from the stored read the suggestion came from: its
   * self-consistency agreement, whether it chose a deterministic candidate,
   * and a SHA-256 of its reasoning. Kept here because
   * transaction_assistant_reads holds only the latest read per row.
   */
  agreement?: number | null
  from_candidate?: boolean | null
  reasoning_sha256?: string | null
  /** What the direct-booking policy reads off the proposal, only the keys it carried. */
  evidence?: SuggestionEvidence
}

export interface SuggestionEvidence {
  seen_count?: number
  rule_mode?: string
  rule_own?: boolean
  rule_requires_review?: boolean
  /** Set only when true: a person set the rule to always ask. */
  rule_always_review?: true
  /** Set only when true: a rule from an imported history that no booking here had confirmed. */
  rule_import_unconfirmed?: true
  has_underlag?: boolean
  read_reverse_charge_kind?: string
  /** Set only when true: a read on a row where an auto-learned mapping row no longer read would have proposed. */
  replaces_learned_rule?: true
}

/** The stored read as the log keeps it: the reasoning only as a hash. */
export interface LoggedRead {
  model?: string | null
  prompt_sha256?: string | null
  agreement?: number | null
  from_candidate?: boolean | null
  reasoning_sha256?: string | null
}

export interface BankLineFinal {
  journal_entry_id: string | null
  /** The booking shape the caller named, when it named one (categorize doors). */
  booking: ProposalBooking | null
  /** The business account booked: the leg that is neither bank nor VAT. Null when ambiguous. */
  account: string | null
  vat_treatment: VatTreatment | null
  lines: Array<{ account: string; debit: number; credit: number }>
}

export interface ClassifiedDecision {
  suggestions: LoggedSuggestion[]
  acted_on: number | null
  outcome: DecisionOutcome
  confidence_band: ConfidenceBand | null
}

const SOURCE: Record<ProposalSource, SuggestionLogSource | null> = {
  rule: 'rule',
  recent: 'recent',
  catalog: 'catalog',
  counterparty: 'counterparty_template',
  assistant: 'assistant',
  manual: null,
  clearing: 'clearing',
  precedent: 'precedent',
}

function sameBooking(a: ProposalBooking, b: ProposalBooking): boolean {
  if (a.kind === 'template' && b.kind === 'template') return a.template_id === b.template_id
  if (a.kind === 'counterparty' && b.kind === 'counterparty') return a.counterparty_template_id === b.counterparty_template_id
  if (a.kind === 'account' && b.kind === 'account') return a.account === b.account && a.vat_treatment === b.vat_treatment
  return false
}

/** The account and VAT a suggestion books, in the shape the categorize API takes. */
function accountOf(p: BookingProposal, entityType?: EntityType): { account: string; vat: VatTreatment | null } {
  const booking = agentBookingFor(p, entityType)
  if (booking) return { account: booking.account_override, vat: booking.vat_treatment }
  return { account: businessAccount(p), vat: p.vat_treatment ?? null }
}

export function matchesFinal(p: BookingProposal, final: BankLineFinal, entityType?: EntityType): boolean {
  if (final.booking && sameBooking(p.booking, final.booking)) return true
  if (!final.account) return false
  const offered = accountOf(p, entityType)
  if (offered.account !== final.account) return false
  return final.vat_treatment == null || offered.vat == null || offered.vat === final.vat_treatment
}

export { businessAccountOfLines } from './business-account'

function evidenceOf(p: BookingProposal): SuggestionEvidence | undefined {
  const evidence: SuggestionEvidence = {
    ...(p.seen_count !== undefined ? { seen_count: p.seen_count } : {}),
    ...(p.rule_mode !== undefined ? { rule_mode: p.rule_mode } : {}),
    ...(p.rule_own !== undefined ? { rule_own: p.rule_own } : {}),
    ...(p.rule_requires_review !== undefined ? { rule_requires_review: p.rule_requires_review } : {}),
    ...(p.rule_always_review ? { rule_always_review: true as const } : {}),
    ...(p.rule_import_unconfirmed ? { rule_import_unconfirmed: true as const } : {}),
    ...(p.has_underlag !== undefined ? { has_underlag: p.has_underlag } : {}),
    ...(p.read_reverse_charge_kind ? { read_reverse_charge_kind: p.read_reverse_charge_kind } : {}),
    ...(p.replaces_learned_rule ? { replaces_learned_rule: true as const } : {}),
  }
  return Object.keys(evidence).length > 0 ? evidence : undefined
}

/**
 * The suggestions on offer, in the log's shape, before anything was booked
 * (matches_final is the booking's to decide). The snapshot hashes this list;
 * the decision adds matches_final to it.
 */
export function offeredSuggestions(
  proposals: BookingProposal[],
  read?: LoggedRead | null,
): { offered: BookingProposal[]; suggestions: Array<Omit<LoggedSuggestion, 'matches_final'>> } {
  const offered = proposals.filter((p) => SOURCE[p.source] !== null)
  const suggestions = offered.map((p, rank) => {
    const assistant = p.source === 'assistant'
    const evidence = evidenceOf(p)
    return {
      source: SOURCE[p.source]!,
      source_id: p.template_id,
      rank,
      proposal: {
        booking: p.booking,
        debit_account: p.debit_account,
        credit_account: p.credit_account,
        vat_treatment: p.vat_treatment ?? null,
        ...(p.line_pattern && p.line_pattern.length > 0 ? { line_pattern: p.line_pattern } : {}),
      },
      confidence: p.confidence,
      model: assistant ? (read?.model ?? null) : null,
      prompt_sha256: assistant ? (read?.prompt_sha256 ?? null) : null,
      ...(p.contested ? { contested: true as const } : {}),
      ...(assistant && read
        ? {
            agreement: read.agreement ?? null,
            from_candidate: read.from_candidate ?? null,
            reasoning_sha256: read.reasoning_sha256 ?? null,
          }
        : {}),
      ...(evidence ? { evidence } : {}),
    }
  })
  return { offered, suggestions }
}

export function classifyBankLineDecision(input: {
  proposals: BookingProposal[]
  read?: LoggedRead | null
  /** The stable id of the suggestion the caller acted on, when it said. */
  actedOn?: string | null
  /** Null when the bank line was dismissed. */
  final: BankLineFinal | null
  entityType?: EntityType
  /** The company's one-click switch as read with the proposals; without it no band is decided. */
  directBooking?: DirectBookingSwitch
}): ClassifiedDecision {
  const { final, entityType } = input
  const { offered, suggestions: onOffer } = offeredSuggestions(input.proposals, input.read)
  const suggestions: LoggedSuggestion[] = onOffer.map((s, i) => ({
    ...s,
    matches_final: final ? matchesFinal(offered[i], final, entityType) : false,
  }))

  if (!final) return { suggestions, acted_on: null, outcome: 'dismissed', confidence_band: null }
  const index = input.actedOn ? suggestions.findIndex((s) => s.source_id === input.actedOn) : -1
  if (index === -1) return { suggestions, acted_on: null, outcome: 'manual', confidence_band: null }
  return {
    suggestions,
    acted_on: index,
    outcome: suggestions[index].matches_final ? 'accepted' : 'changed',
    confidence_band: input.directBooking ? BANK_LINE_SUGGESTIONS.confidenceBand(offered[index], input.directBooking) : null,
  }
}
