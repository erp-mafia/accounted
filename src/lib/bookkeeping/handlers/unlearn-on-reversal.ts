import type { SupabaseClient } from '@supabase/supabase-js'
import { createServiceClientNoCookies } from '@/lib/auth/api-keys'
import { unlearnCounterpartyTemplate, type UnlearnOutcome } from '@/lib/bookkeeping/counterparty-templates'
import { eventBus } from '@/lib/events/bus'
import type { EventPayload } from '@/lib/events/types'
import type { JournalEntry } from '@/types'

type VerifikatLine = { account_number: string; debit_amount: number | string; credit_amount: number | string }

/**
 * A reversed bank booking takes back what it taught. Every way a verifikat is
 * reversed (Ångra on the row, "Ångra alla", storno from the verifikat, an
 * agent's reverse) ends in reverseEntry or correctEntry, and both emit
 * journal_entry.reversed, so the counterpart template learned from the booking
 * is corrected in one place (crm#1275).
 *
 * Learning is a side effect of booking and never blocks it; unlearning is the
 * same: the reversal stands. A failure throws to the event bus, which logs it
 * as an error with the event type and this consumer's name (lib/events/bus.ts)
 * and isolates it from the other consumers and the emitter.
 */
export function registerUnlearnOnReversalHandler(): () => void {
  return eventBus.on('journal_entry.reversed', unlearnOnReversal)
}

/** The journal_entry.reversed handler; lib/init subscribes it through EVENT_CONSUMERS (lib/composition/event-consumers.ts). */
export async function unlearnOnReversal({ originalEntry, companyId }: EventPayload<'journal_entry.reversed'>): Promise<void> {
  await unlearnReversedBankBooking(createServiceClientNoCookies(), companyId, originalEntry)
}

export async function unlearnReversedBankBooking(
  supabase: SupabaseClient,
  companyId: string,
  entry: Pick<JournalEntry, 'id' | 'source_type' | 'source_id' | 'lines'>,
): Promise<UnlearnOutcome | null> {
  if (entry.source_type !== 'bank_transaction' || !entry.source_id) return null
  const { data: transaction, error: transactionError } = await supabase
    .from('transactions')
    .select('merchant_name, original_description, description')
    .eq('id', entry.source_id)
    .eq('company_id', companyId)
    .maybeSingle()
  // A failed read must not read as "no bank row": the template would stay taught.
  if (transactionError) throw new Error(`reversed bank booking: transaction read failed: ${transactionError.message}`)
  if (!transaction) return null

  let lines: ReadonlyArray<VerifikatLine> = entry.lines ?? []
  if (lines.length === 0) {
    const { data, error } = await supabase
      .from('journal_entry_lines')
      .select('account_number, debit_amount, credit_amount')
      .eq('journal_entry_id', entry.id)
    if (error) throw new Error(`reversed bank booking: verifikat lines read failed: ${error.message}`)
    lines = (data ?? []) as VerifikatLine[]
  }
  return unlearnCounterpartyTemplate(supabase, companyId, transaction, lines)
}
