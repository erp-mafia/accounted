import type { SupabaseClient } from '@supabase/supabase-js'
import { createServiceClientNoCookies } from '@/lib/auth/api-keys'
import { unlearnCounterpartyTemplate, type UnlearnOutcome } from '@/lib/bookkeeping/counterparty-templates'
import { eventBus } from '@/lib/events/bus'
import { createLogger } from '@/lib/logger'
import type { JournalEntry } from '@/types'

const log = createLogger('unlearn-on-reversal')

type VerifikatLine = { account_number: string; debit_amount: number | string; credit_amount: number | string }

/**
 * A reversed bank booking takes back what it taught. Every way a verifikat is
 * reversed (Ångra on the row, "Ångra alla", storno from the verifikat, an
 * agent's reverse) ends in reverseEntry or correctEntry, and both emit
 * journal_entry.reversed, so the counterpart template learned from the booking
 * is corrected in one place (crm#1275).
 *
 * Learning is a side effect of booking and never blocks it; unlearning is the
 * same: a failure is logged and the reversal stands.
 */
export function registerUnlearnOnReversalHandler(): () => void {
  return eventBus.on('journal_entry.reversed', async ({ originalEntry, companyId }) => {
    await unlearnReversedBankBooking(createServiceClientNoCookies(), companyId, originalEntry)
  })
}

export async function unlearnReversedBankBooking(
  supabase: SupabaseClient,
  companyId: string,
  entry: Pick<JournalEntry, 'id' | 'source_type' | 'source_id' | 'lines'>,
): Promise<UnlearnOutcome | null> {
  if (entry.source_type !== 'bank_transaction' || !entry.source_id) return null
  try {
    const { data: transaction } = await supabase
      .from('transactions')
      .select('merchant_name, original_description, description')
      .eq('id', entry.source_id)
      .eq('company_id', companyId)
      .maybeSingle()
    if (!transaction) return null

    let lines: ReadonlyArray<VerifikatLine> = entry.lines ?? []
    if (lines.length === 0) {
      const { data } = await supabase
        .from('journal_entry_lines')
        .select('account_number, debit_amount, credit_amount')
        .eq('journal_entry_id', entry.id)
      lines = (data ?? []) as VerifikatLine[]
    }
    return await unlearnCounterpartyTemplate(supabase, companyId, transaction, lines)
  } catch (err) {
    log.warn('unlearning a reversed bank booking failed', {
      companyId,
      journalEntryId: entry.id,
      error: err instanceof Error ? err.message : String(err),
    })
    return null
  }
}
