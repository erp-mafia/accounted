import type { SupabaseClient } from '@supabase/supabase-js'
import { getSuggestedTemplates, buildCounterpartySuggestion, rowProposal } from './category-suggestions'
import {
  bindTemplateToSettlementAccount,
  findCounterpartyTemplatesBatch,
  type CounterpartyTemplateMatch,
} from '@/lib/bookkeeping/counterparty-templates'
import { loadCounterLegTopology, type CounterLegTopology } from '@/lib/cash-accounts/service'
import { isCashLedger } from '@/lib/bookkeeping/bank-leg'
import { loadReads, readIsFresh, assistantSuggestionFromRead, mergeAssistantSuggestion, type AssistantRead } from '@/lib/agent/categorize/read'
import { slateAccount, type BookingProposal } from '@/lib/bookkeeping/proposal'
import { COUNTERPART_SEEN_FOR_DIRECT } from './direct-booking'
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
 * contested, which takes it off the row (contestCounterpart below).
 */
export interface Proposed {
  proposals: Record<string, BookingProposal[]>
  /** Fresh stored reads by transaction id, so a review opens with the assistant's line. */
  assistant_reads: Record<string, AssistantRead>
}

export async function proposeForTransactions(
  supabase: SupabaseClient,
  companyId: string,
  transactions: Transaction[],
  opts: { withReads?: boolean } = {},
): Promise<Proposed> {
  const proposals: Record<string, BookingProposal[]> = {}
  const assistant_reads: Record<string, AssistantRead> = {}
  if (transactions.length === 0) return { proposals, assistant_reads }

  // The company's own rules plus the global (null-company) defaults. Two
  // static queries rather than one dynamic `.or('company_id.eq.<id>,...')`,
  // which the no-phantom-columns scanner cannot resolve.
  const [companyRules, globalRules] = await Promise.all([
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
  ])
  const mappingRules = [
    ...((companyRules.data ?? []) as MappingRule[]),
    ...((globalRules.data ?? []) as MappingRule[]),
  ]

  const { data: settings } = await supabase
    .from('company_settings')
    .select('entity_type')
    .eq('company_id', companyId)
    .single()
  const entityType = (settings?.entity_type as EntityType) || undefined

  // Batch counterparty template matching (1 DB query, in-memory matching)
  const counterpartyMatches = await findCounterpartyTemplatesBatch(supabase, companyId, transactions)

  for (const tx of transactions) {
    proposals[tx.id] = await getSuggestedTemplates(tx, entityType, mappingRules)
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
    const accounts = [
      tmpl.debit_account,
      tmpl.credit_account,
      ...(tmpl.line_pattern ?? []).map((entry) => entry.account),
    ].filter(isCashLedger)
    if (accounts.length === 0) return tmpl
    if (counterLegTopology === undefined) {
      counterLegTopology = await loadCounterLegTopology(supabase, companyId)
    }
    if (!counterLegTopology) return tmpl
    const { settlementLedger, twins } = counterLegTopology.contextFor(tx.cash_account_id)

    const bound = settlementLedger ? bindTemplateToSettlementAccount(tmpl, tx.amount, settlementLedger) : tmpl
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
    proposals[tx.id] = [buildCounterpartySuggestion(template, cpMatch.confidence), ...(proposals[tx.id] || [])]
  }

  // The assistant's stored reads (the ten-minute cron, or an earlier
  // open): a fresh one with an account joins the row's proposals, and the
  // read itself goes along so the review opens with it. Best effort: the
  // list never waits on this table.
  if (opts.withReads !== false) {
    const reads = await loadReads(supabase, companyId, transactions.map((t) => t.id)).catch(() => new Map<string, AssistantRead>())
    for (const tx of transactions) {
      const read = reads.get(tx.id)
      if (!read || !readIsFresh(read, tx)) continue
      assistant_reads[tx.id] = read
      const s = assistantSuggestionFromRead(read, tx, entityType)
      if (s) proposals[tx.id] = mergeAssistantSuggestion(proposals[tx.id] ?? [], s)
      const cpMatch = counterpartyMatches.get(tx.id)
      if (cpMatch) proposals[tx.id] = contestCounterpart(proposals[tx.id] ?? [], cpMatch, read)
    }
  }

  return { proposals, assistant_reads }
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
