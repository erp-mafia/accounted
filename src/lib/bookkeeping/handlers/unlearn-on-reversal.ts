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
 * agent's reverse) ends in reverseEntry, which emits journal_entry.reversed,
 * or in correctEntry, which emits journal_entry.corrected instead. Both are
 * handled here, so the counterpart template learned from the booking is
 * corrected in one place (crm#1275). Before, only the first was: a booking
 * corrected with storno and rättelse stayed a learned habit and came back as
 * the next row's proposal (crm#1858).
 *
 * Learning is a side effect of booking and never blocks it; unlearning is the
 * same: the reversal stands. A failure throws to the event bus, which logs it
 * as an error with the event type and this consumer's name (lib/events/bus.ts)
 * and isolates it from the other consumers and the emitter.
 */
export function registerUnlearnOnReversalHandler(): () => void {
  const offReversed = eventBus.on('journal_entry.reversed', unlearnOnReversal)
  const offCorrected = eventBus.on('journal_entry.corrected', unlearnOnCorrection)
  return () => {
    offReversed()
    offCorrected()
  }
}

/** The journal_entry.reversed handler; lib/init subscribes it and unlearnOnCorrection through EVENT_CONSUMERS (lib/composition/event-consumers.ts). */
export async function unlearnOnReversal({ originalEntry, companyId }: EventPayload<'journal_entry.reversed'>): Promise<void> {
  await unlearnReversedBankBooking(createServiceClientNoCookies(), companyId, originalEntry)
}

/**
 * The journal_entry.corrected handler. A correction that drops an account or
 * side the booking taught (another cost account, other moms) takes the
 * original's occurrence back, as a reversal does. One that keeps every taught
 * account on its side rejected nothing: a new date, amount or text, or lines
 * only added to it (the missing reverse-charge basis pair of
 * rc-basis-gaps/fix, a rounding line). A correction the system made
 * (keepLearnedTemplates: the kontantmetod cut-off) rejected nothing either.
 */
export async function unlearnOnCorrection({ original, corrected, companyId, keepLearnedTemplates }: EventPayload<'journal_entry.corrected'>): Promise<void> {
  if (keepLearnedTemplates) return
  const supabase = createServiceClientNoCookies()
  // The verifikat corrected here may itself be a correction (source_type
  // 'correction', no bank identity): the occurrence was taught by the bank
  // booking at the start of its correction_of_id chain.
  const chain = await correctionChain(supabase, companyId, original)
  const booking = chain[chain.length - 1]
  const taught = konteringSides(await entryLines(supabase, booking))
  if (!dropsAny(taught, await entryLines(supabase, corrected))) return
  // An earlier correction that dropped a taught side already took the
  // occurrence back; a second withdrawal would take one the booking never gave.
  for (const link of chain.slice(0, -1)) {
    if (dropsAny(taught, await entryLines(supabase, link))) return
  }
  await unlearnReversedBankBooking(supabase, companyId, booking)
}

type ChainEntry = Pick<JournalEntry, 'id' | 'source_type' | 'source_id' | 'lines'> & { correction_of_id?: string | null }

/** Longer than any real run of corrections; a guard against a cycle in the links. */
const MAX_CORRECTION_CHAIN = 50

/** The entry, then each verifikat it corrects through correction_of_id, ending at the first booking. */
async function correctionChain(
  supabase: SupabaseClient,
  companyId: string,
  entry: ChainEntry,
): Promise<ChainEntry[]> {
  const chain: ChainEntry[] = [entry]
  let current = entry
  while (current.source_type === 'correction') {
    if (chain.length > MAX_CORRECTION_CHAIN) throw new Error(`corrected bank booking: correction chain of ${current.id} too long`)
    let parentId = current.correction_of_id
    if (parentId === undefined) {
      const { data, error } = await supabase
        .from('journal_entries')
        .select('correction_of_id')
        .eq('id', current.id)
        .eq('company_id', companyId)
        .maybeSingle()
      if (error) throw new Error(`corrected bank booking: correction link read failed: ${error.message}`)
      parentId = (data as { correction_of_id: string | null } | null)?.correction_of_id ?? null
    }
    if (!parentId) break
    const { data: parent, error } = await supabase
      .from('journal_entries')
      .select('id, source_type, source_id, correction_of_id')
      .eq('id', parentId)
      .eq('company_id', companyId)
      .maybeSingle()
    if (error) throw new Error(`corrected bank booking: corrected verifikat read failed: ${error.message}`)
    if (!parent) break
    current = parent as ChainEntry
    chain.push(current)
  }
  return chain
}

async function entryLines(
  supabase: SupabaseClient,
  entry: Pick<JournalEntry, 'id' | 'lines'>,
): Promise<ReadonlyArray<VerifikatLine>> {
  if (entry.lines && entry.lines.length > 0) return entry.lines
  const { data, error } = await supabase
    .from('journal_entry_lines')
    .select('account_number, debit_amount, credit_amount')
    .eq('journal_entry_id', entry.id)
  if (error) throw new Error(`corrected bank booking: verifikat lines read failed: ${error.message}`)
  return (data ?? []) as VerifikatLine[]
}

/** The accounts a verifikat books, each with its side. */
function konteringSides(lines: ReadonlyArray<VerifikatLine>): Set<string> {
  const sides = new Set<string>()
  for (const l of lines) {
    if (Number(l.debit_amount) > 0) sides.add(`D${l.account_number}`)
    if (Number(l.credit_amount) > 0) sides.add(`K${l.account_number}`)
  }
  return sides
}

/** Whether these lines leave out an account or side the booking taught. */
function dropsAny(taught: ReadonlySet<string>, lines: ReadonlyArray<VerifikatLine>): boolean {
  const kept = konteringSides(lines)
  for (const side of taught) if (!kept.has(side)) return true
  return false
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
