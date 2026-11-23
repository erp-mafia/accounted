import type { SupabaseClient } from '@supabase/supabase-js'
import { getSuggestedTemplates, buildCounterpartySuggestion, matchedRuleProposals, rowProposal } from './category-suggestions'
import {
  bindTemplateToSettlementAccount,
  contradictsLearnedDirection,
  findCounterpartyTemplatesBatch,
  type CounterpartyTemplateMatch,
} from '@/lib/bookkeeping/counterparty-templates'
import { loadCounterLegTopology, type CounterLegTopology } from '@/lib/cash-accounts/service'
import { isCashLedger } from '@/lib/bookkeeping/bank-leg'
import { isCardLedgerAccount } from '@/lib/cash-accounts/card-ledger'
import type { AssistantRead } from '@/lib/agent/categorize/read'
import { ASSISTANT_READS } from '@/lib/composition/assistant-reads'
import { CLEARING_PROPOSERS } from '@/lib/composition/clearing-proposals'
import { createLogger } from '@/lib/logger'
import { booksSwedishInputVat, proposalFromTemplate, reverseChargeBoxesOf, slateAccount, type BookingProposal } from '@/lib/bookkeeping/proposal'
import { getTemplateById } from '@/lib/bookkeeping/booking-templates'
import { isSkatteverketPayment } from '@/lib/bookkeeping/skatteverket-payment'
import { ASSISTANT_LIKELY, COUNTERPART_SEEN_FOR_DIRECT, type DirectBookingSettings } from './direct-booking'
import { readDirectBookingSettings } from './direct-booking-settings'
import { proposeClearings } from './clearing-proposals'
import { loadActiveBookingReviewRules } from '@/lib/booking-review/rules'
import { markBlockedProposals } from '@/lib/booking-review/proposals'
import { isAutoLearnedMappingRule, mappingRulesRead } from '@/lib/bookkeeping/mapping-engine'
import type { Transaction, EntityType, CategorizationTemplate, MappingRule } from '@/types'

/**
 * The proposals for a batch of transactions: the one place that asks every
 * source. The transactions page, the assistant's candidate slate and the
 * MCP suggestion tool all call this, so a person, the model and Claude see
 * the same recommendation with the same evidence.
 *
 * Order per row: the company's learned counterpart first, then a mapping
 * rule that matched, the assistant's stored read when at least likely, the
 * catalog's keyword and MCC matches, an unsure assistant read, and last
 * templates a rule merely points at (picker only). A weak counterpart match
 * the stored read booked differently keeps its place but is marked
 * contested, which takes it off the row (contestCounterpart below). A
 * proposal the read puts in another reverse-charge box keeps its place and
 * carries the read's box, which sends it to a review (disputeReverseChargeBox).
 * A payment to Skatteverket is the exception to all of it: it leads with the
 * skattekonto, and no learned counterpart is offered for it (leadWithSkattekonto).
 * Money another block already booked onto a clearing account (the till's
 * card and Swish on 1686) leads above everything, since any other booking
 * of it counts the revenue twice (leadWithClearing); it never books from
 * the row.
 *
 * For a company whose auto-learned mapping rows are not read
 * (lib/bookkeeping/mapping-engine.ts readsAutoLearnedMappingRules), such a
 * row proposes nothing. Where one would have proposed, the assistant's
 * proposal carries replaces_learned_rule and never books without a review:
 * the row is not booked by one click on a read where a rule stood before.
 *
 * Last, a booking review rule (lib/booking-review, accounted#130 step 2)
 * marks every proposal it matches review_blocked: it keeps its place, and
 * never books without a person's review (reviewReason 'booking_blocked').
 */
/**
 * The rules behind a bank line's suggestions, recorded with every decision
 * as suggestion_log.rule_version (with the program version, which pins the
 * exact code). Bump by hand when what proposeForTransactions offers for the
 * same row changes on purpose: a source added or dropped, the order, the
 * contest or box-dispute rules.
 */
export const BANK_PROPOSAL_RULES_REVISION = 'bank-proposals.6'

const log = createLogger('transactions/propose')

export interface Proposed {
  proposals: Record<string, BookingProposal[]>
  /** Fresh stored reads by transaction id, so a review opens with the assistant's line. */
  assistant_reads: Record<string, AssistantRead>
  /**
   * The company's one-click switch, read with the proposals: what every
   * surface passes to reviewReason (./direct-booking.ts) beside a proposal.
   */
  direct_booking: DirectBookingSettings
}

export async function proposeForTransactions(
  supabase: SupabaseClient,
  companyId: string,
  transactions: Transaction[],
  opts: { withReads?: boolean } = {},
): Promise<Proposed> {
  const proposals: Record<string, BookingProposal[]> = {}
  const assistant_reads: Record<string, AssistantRead> = {}
  if (transactions.length === 0) return { proposals, assistant_reads, direct_booking: await readDirectBookingSettings(supabase, companyId) }

  // The company's own rules plus the global (null-company) defaults. Two
  // static queries rather than one dynamic `.or('company_id.eq.<id>,...')`,
  // which the no-phantom-columns scanner cannot resolve.
  //
  // Every read below depends only on the company and the rows, so they run
  // in one round; the proposals are then put together in the same order as
  // before. The suggestions in Transaktioner wait on this.
  const [companyRules, globalRules, direct_booking, settingsRead, counterpartyMatches, storedReads, clearings, blockRules] = await Promise.all([
    supabase
      .from('mapping_rules')
      .select('*')
      .eq('company_id', companyId)
      .eq('is_active', true)
      .order('priority', { ascending: false }),
    supabase
      .from('mapping_rules')
      .select('*')
      .is('company_id', null)
      .eq('is_active', true)
      .order('priority', { ascending: false }),
    readDirectBookingSettings(supabase, companyId),
    supabase
      .from('company_settings')
      .select('entity_type')
      .eq('company_id', companyId)
      .single(),
    // Batch counterparty template matching (1 DB query, in-memory matching)
    findCounterpartyTemplatesBatch(supabase, companyId, transactions),
    // The assistant's stored reads. Best effort: the list never waits on a
    // failed read of this table.
    opts.withReads !== false
      ? ASSISTANT_READS.load(supabase, companyId, transactions.map((t) => t.id)).catch(() => new Map<string, AssistantRead>())
      : Promise.resolve(null),
    // Best effort, like the reads: the list never waits on a failed proposer.
    proposeClearings(supabase, companyId, transactions, CLEARING_PROPOSERS, log).catch(
      () => new Map<string, BookingProposal>(),
    ),
    loadActiveBookingReviewRules(supabase, companyId),
  ])
  const storedRules = [
    ...((companyRules.data ?? []) as MappingRule[]),
    ...((globalRules.data ?? []) as MappingRule[]),
  ]
  // Without the company's auto-learned rows where they are not read
  // (lib/bookkeeping/mapping-engine.ts readsAutoLearnedMappingRules).
  const mappingRules = mappingRulesRead(companyId, storedRules)
  const unreadRules = mappingRules.length === storedRules.length ? [] : storedRules.filter(isAutoLearnedMappingRule)

  const entityType = (settingsRead.data?.entity_type as EntityType) || undefined

  // The rows an auto-learned rule that is no longer read would have proposed
  // for: the assistant's read may take the row there, but only into a review
  // (replaces_learned_rule below).
  const unreadRuleRows = new Set<string>()
  for (const tx of transactions) {
    proposals[tx.id] = await getSuggestedTemplates(tx, entityType, mappingRules)
    if (unreadRules.length > 0 && matchedRuleProposals(tx, entityType, unreadRules).length > 0) unreadRuleRows.add(tx.id)
  }

  // Inject counterparty template matches as top suggestions. A learned
  // template can carry the ledger it was learned on. Its bank leg is first
  // put on the transaction's own settlement ledger, the rewrite
  // applySettlementAccount makes at booking (crm#1046: a fee learned on one
  // currency account, offered on another), so the review shows the account
  // the verifikat will carry. Then the same rules guardCounterLegs applies
  // at commit (issue #1643 problem 4) decide what the transactions page is
  // offered, so a suggestion is never shown that the commit guard would
  // refuse, and never withheld that it would book:
  //   - a 19xx leg that is a TWIN of the transaction's own row (same IBAN,
  //     same currency: the stale bank leg of a template learned before a
  //     reconnect moved the account, or the other enabled ledger of one
  //     connection) is rewritten to the settlement ledger; if that leaves
  //     the settlement ledger against itself the suggestion is withheld,
  //   - a remaining 19xx leg in the orphaned set (revoked connection, or a
  //     stale twin of some live account) is a counter-position orphan and
  //     the suggestion is withheld: it would pre-fill a junk balance-sheet
  //     account in the booking dialog.
  // Static library templates only reference BAS business accounts plus the
  // literal 1930 settlement placeholder, so they never need this check.
  // The transaction's OWN settlement ledger is exempt: a transaction still
  // stranded on the orphaned row settles there.
  let counterLegTopology: CounterLegTopology | null | undefined
  const guardLearnedTemplate = async (
    tmpl: CategorizationTemplate,
    tx: Transaction,
  ): Promise<CategorizationTemplate | null> => {
    // A card-shaped ledger may be one of the company's cards: a template that
    // still carries a card's 2890 on its bank leg is bound like a 19xx one.
    const accounts = [
      tmpl.debit_account,
      tmpl.credit_account,
      ...(tmpl.line_pattern ?? []).map((entry) => entry.account),
    ].filter((account) => isCashLedger(account) || isCardLedgerAccount(account))
    if (accounts.length === 0) return tmpl
    if (counterLegTopology === undefined) {
      counterLegTopology = await loadCounterLegTopology(supabase, companyId)
    }
    if (!counterLegTopology) return tmpl
    const { settlementLedger, twins } = counterLegTopology.contextFor(tx.cash_account_id)

    const bound = settlementLedger
      ? bindTemplateToSettlementAccount(tmpl, tx.amount, settlementLedger, counterLegTopology.cardLedgers)
      : tmpl
    let guarded = bound
    if (
      settlementLedger &&
      [bound.debit_account, bound.credit_account, ...(bound.line_pattern ?? []).map((entry) => entry.account)]
        .some((a) => twins.has(a))
    ) {
      const rewrite = (a: string): string => (twins.has(a) ? settlementLedger : a)
      guarded = {
        ...bound,
        debit_account: rewrite(bound.debit_account),
        credit_account: rewrite(bound.credit_account),
        line_pattern: bound.line_pattern
          ? bound.line_pattern.map((entry) => ({ ...entry, account: rewrite(entry.account) }))
          : bound.line_pattern,
      }
      if (guarded.debit_account === settlementLedger && guarded.credit_account === settlementLedger) {
        return null
      }
    }

    const remaining = [
      guarded.debit_account,
      guarded.credit_account,
      ...(guarded.line_pattern ?? []).map((entry) => entry.account),
    ].filter(isCashLedger)
    const orphanHit = remaining.some(
      (a) => a !== settlementLedger && counterLegTopology!.orphaned.has(a),
    )
    return orphanHit ? null : guarded
  }

  for (const tx of transactions) {
    const cpMatch = counterpartyMatches.get(tx.id)
    if (!cpMatch) continue
    const template = await guardLearnedTemplate(cpMatch.template, tx)
    if (!template) continue
    // Read off the stored template, as the booking reads it: money in from a
    // counterpart learned as a cost is shown as the refund it books as.
    const directionMismatch = contradictsLearnedDirection(cpMatch.template, tx.amount)
    proposals[tx.id] = [
      buildCounterpartySuggestion(template, cpMatch.confidence, { directionMismatch }),
      ...(proposals[tx.id] || []),
    ]
  }

  // The assistant's stored reads (the ten-minute cron, or an earlier
  // open): a fresh one with an account joins the row's proposals, and the
  // read itself goes along so the review opens with it.
  if (storedReads) {
    const reads = storedReads
    for (const tx of transactions) {
      const read = reads.get(tx.id)
      if (!read || !ASSISTANT_READS.isFresh(read, tx)) continue
      assistant_reads[tx.id] = read
      const s = ASSISTANT_READS.proposal(read, tx, entityType)
      if (s) {
        proposals[tx.id] = mergeAssistantSuggestion(
          proposals[tx.id] ?? [],
          unreadRuleRows.has(tx.id) ? { ...s, replaces_learned_rule: true } : s,
        )
      }
      const cpMatch = counterpartyMatches.get(tx.id)
      if (cpMatch) proposals[tx.id] = contestCounterpart(proposals[tx.id] ?? [], cpMatch, read)
      proposals[tx.id] = disputeReverseChargeBox(proposals[tx.id] ?? [], read)
    }
  }

  for (const tx of transactions) {
    proposals[tx.id] = leadWithSkattekonto(proposals[tx.id] ?? [], tx)
  }

  for (const [txId, clearing] of clearings) {
    proposals[txId] = leadWithClearing(proposals[txId] ?? [], clearing)
  }

  if (blockRules.length > 0) {
    for (const tx of transactions) {
      proposals[tx.id] = markBlockedProposals(proposals[tx.id] ?? [], tx, blockRules)
    }
  }

  return { proposals, assistant_reads, direct_booking }
}

/**
 * A clearing proposal (lib/transactions/clearing-proposals.ts) leads the
 * row's list: the money is already booked onto the clearing account, so a
 * learned counterpart, the catalog or the assistant booking it as revenue
 * would count it twice. The others stay below it for the picker.
 */
export function leadWithClearing(list: BookingProposal[], clearing: BookingProposal): BookingProposal[] {
  return [clearing, ...list.filter((p) => p.template_id !== clearing.template_id)]
}

/**
 * Where the assistant's suggestion sits among the row's others: a rule and
 * a counterpart come first, then the assistant when it is at least likely,
 * then the catalog's keyword matches, then an unsure assistant last.
 */
export function mergeAssistantSuggestion(list: BookingProposal[], s: BookingProposal): BookingProposal[] {
  const rest = list.filter((x) => x.source !== 'assistant')
  if (s.confidence < ASSISTANT_LIKELY) return [...rest, s]
  const firstCatalog = rest.findIndex((x) => x.source !== 'rule' && x.source !== 'counterparty')
  if (firstCatalog === -1) return [...rest, s]
  return [...rest.slice(0, firstCatalog), s, ...rest.slice(firstCatalog)]
}

/** The catalog template that books a bank line on the skattekonto (Insättning skattekonto, 1630). */
const SKATTEKONTO_DEPOSIT_TEMPLATE_ID = 'financial_tax_account'

/**
 * A payment to Skatteverket (isSkatteverketPayment) leads with the booking on
 * the skattekonto, whatever the keywords, a learned counterpart or the
 * assistant ranked first: the bank line only ever touches the skattekonto
 * account, and the taxes it pays are booked from the skattekontoutdrag
 * (swedish-daily-bookkeeping, references/skattekonto-and-owner.md §1.1).
 * Before, the catalog ranked 2510 above 1630 and any learned template above
 * both, so one mistaken booking (5890 with 25 % moms) became the row's
 * proposal (crm#1275).
 *
 * A rule of the company's own that books there keeps the lead, with its
 * auto-booking; otherwise the catalog template does, which always goes to a
 * review. The other proposals stay below it for the picker. The template
 * names 1630; the booking puts it on the company's skattekonto account (2012
 * for an enskild firma that runs it there), as buildCategorizeMapping does
 * for every template on 1630.
 */
export function leadWithSkattekonto(list: BookingProposal[], tx: Transaction): BookingProposal[] {
  if (!isSkatteverketPayment(tx)) return list
  const own = list.find((p) => p.source === 'rule' && p.template_id === SKATTEKONTO_DEPOSIT_TEMPLATE_ID)
  const template = getTemplateById(SKATTEKONTO_DEPOSIT_TEMPLATE_ID)
  const lead = own ?? (template ? proposalFromTemplate(template, 'catalog', template.auto_match_confidence) : undefined)
  if (!lead) return list
  return [lead, ...list.filter((p) => p !== lead && p.template_id !== SKATTEKONTO_DEPOSIT_TEMPLATE_ID)]
}

/**
 * A learned-counterpart match is weak when the row does not carry the
 * counterpart's own name (the token and fuzzy tiers), or when the company
 * has booked that counterpart fewer times than it takes to call it a habit.
 * A rule the person set to book on its own, matched by name, is an
 * instruction and never weak.
 */
function isWeakCounterpartMatch(match: Pick<CounterpartyTemplateMatch, 'matchMethod' | 'template'>): boolean {
  if (match.matchMethod === 'token_subset' || match.matchMethod === 'fuzzy') return true
  if (match.template.mode === 'auto') return false
  return match.template.occurrence_count < COUNTERPART_SEEN_FOR_DIRECT
}

/**
 * The stored read as a check on the counterpart match, never a replacement
 * for it. When the match is weak and the read had that very counterpart on
 * its slate (so it saw the company's history for it) and still booked the
 * row on another account, the two disagree and neither is the row's
 * recommendation: the match is marked contested, which rowProposal and
 * booksWithoutReview honour, and stays in the list for the picker, the
 * review and an agent. A read that found nothing, or never saw the
 * counterpart, contests nothing.
 */
export function contestCounterpart(
  list: BookingProposal[],
  match: Pick<CounterpartyTemplateMatch, 'matchMethod' | 'template'>,
  read: Pick<AssistantRead, 'account' | 'candidates'>,
): BookingProposal[] {
  if (!read.account || !isWeakCounterpartMatch(match)) return list
  return list.map((p) => {
    if (p.source !== 'counterparty') return p
    const account = slateAccount(p)
    const sawIt = read.candidates.some((c) => c.source === 'counterparty_template' && c.account === account)
    return sawIt && read.account !== account ? { ...p, contested: true } : p
  })
}

/** The proposal a row wears and books from: the first that matched the row itself. */
export { rowProposal }

/**
 * The stored read as a check on the reverse-charge box (accounted#37). When
 * the read says which box the purchase belongs in (ruta 21, a service from
 * another EU country, or ruta 22, one from outside the EU: the model's answer
 * to where the seller is) and a proposal books another, the proposal carries
 * the read's box (read_reverse_charge_kind). It stays the row's
 * recommendation, but booksWithoutReview never books it from the row, and
 * the review opens on the read's box with the proposal's one click away.
 * The box depends on which company invoices, which is on the invoice: a
 * counterpart learned as one pair never learned it (it books the EU-service
 * default), and a catalog keyword names a vendor, not the company that
 * bills. A read that names no box (none asked, or a reverse charge taken
 * from a candidate's history) disputes nothing.
 *
 * A proposal that books the purchase with Swedish ingående moms (2641) where
 * the read names a box disputes the same way (crm#1498): a learned
 * counterpart or a catalog keyword booked Google Ads and ChatGPT with
 * Swedish moms from the row while the read had placed the seller abroad. A
 * seller abroad charges Swedish moms only when registered for it here, and
 * that is on the invoice, so the person sees both and picks. A proposal that
 * books neither (no moms, a non-registered company's exempt booking) is left
 * alone.
 */
export function disputeReverseChargeBox(
  list: BookingProposal[],
  read: Pick<AssistantRead, 'vat_treatment' | 'reverse_charge_kind'>,
): BookingProposal[] {
  const readKind = read.vat_treatment === 'reverse_charge' ? read.reverse_charge_kind : null
  if (!readKind) return list
  return list.map((p) => {
    if (p.source === 'assistant' || p.source === 'manual') return p
    const boxes = reverseChargeBoxesOf(p)
    const disputed = boxes.length > 0 ? boxes.some((k) => k !== readKind) : booksSwedishInputVat(p)
    return disputed ? { ...p, read_reverse_charge_kind: readKind } : p
  })
}
