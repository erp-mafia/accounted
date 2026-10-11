import type { SupabaseClient } from '@supabase/supabase-js'
import { proposeForTransactions } from '@/lib/transactions/propose'
import { resolveCompanyEntityType } from '@/lib/company/entity-type'
import { getActor } from '@/lib/bookkeeping/actor-context'
import { getTemplateById } from '@/lib/bookkeeping/booking-templates'
import { createLogger } from '@/lib/logger'
import type { BookingProposal, ProposalBooking } from '@/lib/bookkeeping/proposal'
import type { AssistantRead } from '@/lib/agent/categorize/read-shape'
import type { EntityType, JournalEntry, MappingResult, Transaction, TransactionCategory, VatTreatment } from '@/types'
import { businessAccountOfLines, classifyBankLineDecision, type BankLineFinal } from './classify'

/**
 * Writes suggestion_log rows for decisions on bank lines.
 *
 * Two steps around a booking:
 *   1. snapshotSuggestions() BEFORE booking: what proposeForTransactions
 *      offers for the rows right now. Taken before the booking because the
 *      learning that runs after one (mapping rule, counterparty template)
 *      would otherwise leak the decision into its own suggestions.
 *   2. recordDecisions() AFTER the booking succeeded: one row per bank line.
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

export interface SuggestionSnapshot {
  companyId: string
  entityType?: EntityType
  byTransaction: Map<string, { proposals: BookingProposal[]; read: AssistantRead | null; documentId: string | null }>
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
      proposeForTransactions(supabase, companyId, transactions),
    ])
    snapshot.entityType = entityType
    for (const tx of transactions) {
      snapshot.byTransaction.set(tx.id, {
        proposals: proposed.proposals[tx.id] ?? [],
        read: proposed.assistant_reads[tx.id] ?? null,
        documentId: tx.document_id ?? null,
      })
    }
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
    const rows = decisions.map((d) => {
      const taken = snapshot.byTransaction.get(d.transactionId)
      const classified = classifyBankLineDecision({
        proposals: taken?.proposals ?? [],
        read: taken?.read ?? null,
        actedOn: d.actedOn,
        final: d.final,
        entityType: snapshot.entityType,
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
      }
    })
    const { error } = await supabase.from('suggestion_log').insert(rows)
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

/** What a door that posts explicit lines booked (book route, bulk-book). */
export function finalFromLines(journalEntryId: string, lines: BankLineFinal['lines']): BankLineFinal {
  return {
    journal_entry_id: journalEntryId,
    booking: null,
    account: businessAccountOfLines(lines),
    vat_treatment: null,
    lines,
  }
}
