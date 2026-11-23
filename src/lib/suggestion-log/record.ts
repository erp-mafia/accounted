import type { SupabaseClient } from '@supabase/supabase-js'
import { BANK_LINE_SUGGESTIONS } from '@/lib/composition/bank-line-suggestions'
import { resolveCompanyEntityType } from '@/lib/company/entity-type'
import { getActor } from '@/lib/bookkeeping/actor-context'
import { traceIdColumn, writeWithTraceId } from '@/lib/observability/trace-column'
import { getTemplateById } from '@/lib/bookkeeping/booking-templates'
import { agentReasonColumn, isMissingColumnError, writeWithAgentReason } from '@/lib/pending-operations/agent-reason'
import { committingAgentReason, committingOperationId } from '@/lib/pending-operations/commit-scope'
import { createLogger } from '@/lib/logger'
import type { BookingProposal, ProposalBooking } from '@/lib/bookkeeping/proposal'
import type { AssistantRead } from '@/lib/agent/categorize/read-shape'
import type { EntityType, JournalEntry, MappingResult, Transaction, TransactionCategory, VatTreatment } from '@/types'
import {
  businessAccountOfLines,
  classifyBankLineDecision,
  offeredSuggestions,
  type BankLineFinal,
  type LoggedRead,
} from './classify'
import type { DecisionCheck } from './checks'
import type { DirectBookingSwitch } from './bank-line-suggestions'
import { bankLineInputHash, reasoningSha256, withProgramVersion } from './provenance'

/**
 * Writes suggestion_log rows for decisions on bank lines.
 *
 * Two steps around a booking:
 *   1. snapshotSuggestions() BEFORE booking: what proposeForTransactions
 *      offers for the rows right now. Taken before the booking because the
 *      learning that runs after one (mapping rule, counterparty template)
 *      would otherwise leak the decision into its own suggestions. It also
 *      fixes what the decision is made on: the rules version and the hash of
 *      the inputs (./provenance.ts).
 *   2. recordDecisions() AFTER the booking succeeded: one row per bank line,
 *      with the guards the door ran, the band the acted-on suggestion fell
 *      in under the direct-booking policy and the company's one-click switch
 *      read with the snapshot, whether the person saw the review before it
 *      was booked (review_shown, when the door says), and the pending
 *      operation whose approval carried it (when an agent staged it) with
 *      its agent_reason.
 *
 * Neither step can fail a booking: a failed snapshot records an empty list,
 * a failed write is logged and dropped. The log describes bookkeeping, it is
 * never a precondition for it.
 *
 * The voucher is found from the row (final.journal_entry_id), not the other
 * way round: a samlingsverifikat carries many bank lines, so one id on the
 * voucher could not point at all their decisions.
 */

const log = createLogger('suggestion-log')

export interface SnapshotEntry {
  proposals: BookingProposal[]
  read: AssistantRead | null
  documentId: string | null
  /** SHA-256 of the inputs (./provenance.ts); null when the document's hash could not be read. */
  inputHash?: string | null
}

export interface SuggestionSnapshot {
  companyId: string
  entityType?: EntityType
  /** The rules the suggestions came from; unset when the snapshot failed. */
  ruleVersion?: string
  /** The company's one-click switch, read with the suggestions; unset when the snapshot failed. */
  directBooking?: DirectBookingSwitch
  byTransaction: Map<string, SnapshotEntry>
}

/** The stored read as the log keeps it: its reasoning only as a hash. */
export function loggedRead(read: AssistantRead | null | undefined): LoggedRead | null {
  if (!read) return null
  return {
    model: read.model,
    prompt_sha256: read.prompt_sha256 ?? null,
    agreement: read.agreement,
    from_candidate: read.from_candidate,
    reasoning_sha256: reasoningSha256(read.reasoning),
  }
}

/** The hashes of the documents pinned to the rows, or null when they could not be read. */
async function documentHashes(
  supabase: SupabaseClient,
  companyId: string,
  documentIds: string[],
): Promise<Map<string, string | null> | null> {
  const hashes = new Map<string, string | null>()
  if (documentIds.length === 0) return hashes
  try {
    const { data, error } = await supabase
      .from('document_attachments')
      .select('id, sha256_hash')
      .eq('company_id', companyId)
      .in('id', documentIds)
    if (error) throw new Error(error.message)
    for (const doc of (data ?? []) as Array<{ id: string; sha256_hash: string | null }>) hashes.set(doc.id, doc.sha256_hash ?? null)
    return hashes
  } catch (err) {
    log.warn('document hashes unavailable; decisions are recorded without an input hash', {
      companyId,
      error: err instanceof Error ? err.message : String(err),
    })
    return null
  }
}

export async function snapshotSuggestions(
  supabase: SupabaseClient,
  companyId: string,
  transactionIds: string[],
): Promise<SuggestionSnapshot> {
  const snapshot: SuggestionSnapshot = { companyId, byTransaction: new Map() }
  if (transactionIds.length === 0) return snapshot
  try {
    const { data, error } = await supabase
      .from('transactions')
      .select('*')
      .eq('company_id', companyId)
      .in('id', transactionIds)
    if (error) throw new Error(error.message)
    const transactions = (data ?? []) as Transaction[]
    const [entityType, proposed] = await Promise.all([
      resolveCompanyEntityType(supabase, companyId),
      BANK_LINE_SUGGESTIONS.propose(supabase, companyId, transactions),
    ])
    snapshot.entityType = entityType
    snapshot.directBooking = proposed.direct_booking
    const hashes = await documentHashes(
      supabase,
      companyId,
      [...new Set(transactions.map((tx) => tx.document_id).filter((id): id is string => !!id))],
    )
    for (const tx of transactions) {
      const proposals = proposed.proposals[tx.id] ?? []
      const read = proposed.assistant_reads[tx.id] ?? null
      const documentId = tx.document_id ?? null
      snapshot.byTransaction.set(tx.id, {
        proposals,
        read,
        documentId,
        inputHash: hashes
          ? bankLineInputHash({
              transaction: tx,
              documentSha256: documentId ? (hashes.get(documentId) ?? null) : null,
              suggestions: offeredSuggestions(proposals, loggedRead(read)).suggestions,
            })
          : null,
      })
    }
    snapshot.ruleVersion = withProgramVersion(BANK_LINE_SUGGESTIONS.rulesRevision(companyId))
  } catch (err) {
    log.warn('suggestion snapshot failed; decisions are recorded without suggestions', {
      companyId,
      error: err instanceof Error ? err.message : String(err),
    })
  }
  return snapshot
}

export interface BankLineDecision {
  transactionId: string
  /** Stable id of the suggestion the caller acted on (BookingProposal.template_id). */
  actedOn?: string | null
  /** What was booked; null when the bank line was dismissed. */
  final: BankLineFinal | null
  /** The guards the door ran before this decision (./checks.ts); omitted when it does not report them. */
  checks?: DecisionCheck[] | null
  /**
   * Whether the person saw the booking's review before it was booked: false
   * for the row's one click, true from Granska bokföring. Omitted when the
   * door does not say (suggestion_log.review_shown stays null).
   */
  reviewShown?: boolean | null
}

export async function recordDecisions(
  supabase: SupabaseClient,
  snapshot: SuggestionSnapshot,
  decisions: BankLineDecision[],
  userId: string | null,
): Promise<void> {
  if (decisions.length === 0) return
  try {
    const actorType = getActor()?.type ?? 'user'
    const pendingOperationId = committingOperationId()
    const rowsWith = (agentReason: string | null, withReviewShown: boolean, traceId: string | null) => decisions.map((d) => {
      const taken = snapshot.byTransaction.get(d.transactionId)
      const classified = classifyBankLineDecision({
        proposals: taken?.proposals ?? [],
        read: loggedRead(taken?.read),
        actedOn: d.actedOn,
        final: d.final,
        entityType: snapshot.entityType,
        directBooking: snapshot.directBooking,
      })
      return {
        company_id: snapshot.companyId,
        kind: 'bank_line',
        transaction_id: d.transactionId,
        document_id: taken?.documentId ?? null,
        suggestions: classified.suggestions,
        acted_on: classified.acted_on,
        final: d.final,
        outcome: classified.outcome,
        actor_type: actorType,
        resolved_by: userId,
        // A row the snapshot did not reach has no recorded inputs or rules.
        rule_version: taken ? (snapshot.ruleVersion ?? null) : null,
        input_hash: taken?.inputHash ?? null,
        // The policy is recorded with the band it decided, never without.
        policy_version: classified.confidence_band ? BANK_LINE_SUGGESTIONS.policyVersion() : null,
        confidence_band: classified.confidence_band,
        checks: d.checks ?? null,
        pending_operation_id: pendingOperationId,
        // The request that recorded it (lib/observability/trace-context.ts).
        ...traceIdColumn(traceId),
        ...agentReasonColumn(agentReason),
        ...(withReviewShown && typeof d.reviewShown === 'boolean' ? { review_shown: d.reviewShown } : {}),
      }
    })
    // The approved operation's reason, when an agent staged it with one.
    const insert = (withReviewShown: boolean) =>
      writeWithTraceId((traceId) =>
        writeWithAgentReason(committingAgentReason(), (agentReason) =>
          supabase.from('suggestion_log').insert(rowsWith(agentReason, withReviewShown, traceId)),
        ),
      )
    let { error } = await insert(true)
    // Without review_shown while the column is not there yet: the code is
    // live a few minutes before its migration runs.
    if (isMissingColumnError(error) && decisions.some((d) => typeof d.reviewShown === 'boolean')) ({ error } = await insert(false))
    if (error) throw new Error(error.message)
  } catch (err) {
    log.error('failed to record booking decisions (booking unaffected)', {
      companyId: snapshot.companyId,
      count: decisions.length,
      error: err instanceof Error ? err.message : String(err),
    })
  }
}

/** The posted lines in the log's compact shape. */
export function linesOf(entry: Pick<JournalEntry, 'lines'> | null | undefined): BankLineFinal['lines'] {
  return (entry?.lines ?? []).map((l) => ({
    account: l.account_number,
    debit: Number(l.debit_amount),
    credit: Number(l.credit_amount),
  }))
}

/**
 * What a categorize door booked: the booking shape it was asked for and
 * the business account the mapping posted (after overrides and settlement).
 */
export function finalFromCategorize(input: {
  journalEntry: Pick<JournalEntry, 'id' | 'lines'>
  mappingResult: Pick<MappingResult, 'debit_account' | 'credit_account'>
  amount: number
  templateId?: string | null
  counterpartyTemplateId?: string | null
  category?: TransactionCategory | null
  vatTreatment?: VatTreatment | null
}): BankLineFinal {
  const account = input.amount < 0 ? input.mappingResult.debit_account : input.mappingResult.credit_account
  const vatTreatment =
    input.vatTreatment ?? (input.templateId ? (getTemplateById(input.templateId)?.vat_treatment ?? null) : null)
  let booking: ProposalBooking | null = null
  if (input.counterpartyTemplateId) {
    booking = { kind: 'counterparty', counterparty_template_id: input.counterpartyTemplateId }
  } else if (input.templateId && input.category) {
    booking = { kind: 'template', template_id: input.templateId, category: input.category }
  } else if (account && vatTreatment && input.category) {
    booking = { kind: 'account', account, vat_treatment: vatTreatment, category: input.category }
  }
  return {
    journal_entry_id: input.journalEntry.id,
    booking,
    account: account || null,
    vat_treatment: vatTreatment,
    lines: linesOf(input.journalEntry),
  }
}

/**
 * What a door that posts explicit lines booked (book route, bulk-book). The
 * row's settlement ledger, when given, is left out of the business account
 * like 19xx is: a card row's 2890 is its bank leg.
 */
export function finalFromLines(
  journalEntryId: string,
  lines: BankLineFinal['lines'],
  settlementLedgers: readonly string[] = [],
): BankLineFinal {
  return {
    journal_entry_id: journalEntryId,
    booking: null,
    account: businessAccountOfLines(lines, settlementLedgers),
    vat_treatment: null,
    lines,
  }
}
