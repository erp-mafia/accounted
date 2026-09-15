import type { SupabaseClient } from '@supabase/supabase-js'
import { coreKey, ledgerKey } from '@/lib/parties/ledger-key'
import { addDays, daysBetween } from './dates'

/**
 * Arkiv phase 4: did the expected money arrive? Obligations are compared
 * with bank transactions and marked matched or missed. This only observes:
 * nothing is booked, settled or attached from here; the ledger stays the
 * arbiter and the booking flows stay the only writers of the journal.
 */
export interface ObserveSummary {
  checked: number
  matched: number
  missed: number
}

/** Days before and after a due date a payment may land. */
const DATE_TOLERANCE_DAYS = 10
/** An expected payment this far past due with nothing arrived is missed. */
const MISSED_AFTER_DAYS = 14
/** How far back an obligation is still compared, so a late arrival can settle a missed one. */
const LOOKBACK_DAYS = 45
const LOOKAHEAD_DAYS = 3

interface ObligationRow {
  id: string
  agreement_id: string
  due_on: string
  amount: number
  currency: string
  amount_is_estimate: boolean
  status: 'expected' | 'missed'
}

interface AgreementRow {
  id: string
  counterparty_party_id: string | null
  counterparty_name: string | null
}

interface PartyRow {
  id: string
  display_name: string
  legal_name: string | null
  alias_keys: string[]
}

interface TransactionRow {
  id: string
  date: string
  amount: number
  currency: string | null
  description: string | null
  original_description: string | null
  merchant_name: string | null
}

export async function observeObligations(supabase: SupabaseClient, companyId: string, today: string): Promise<ObserveSummary> {
  const obligations = await loadObligations(supabase, companyId, today)
  const summary: ObserveSummary = { checked: obligations.length, matched: 0, missed: 0 }
  if (obligations.length === 0) return summary
  const agreements = await loadAgreements(supabase, [...new Set(obligations.map((o) => o.agreement_id))])
  const parties = await loadParties(supabase, [...new Set(agreements.map((a) => a.counterparty_party_id).filter((id): id is string => !!id))])
  const transactions = await loadTransactions(supabase, companyId, obligations)

  const used = new Set<string>()
  for (const obligation of obligations) {
    const agreement = agreements.find((a) => a.id === obligation.agreement_id)
    const party = agreement?.counterparty_party_id ? parties.find((p) => p.id === agreement.counterparty_party_id) : undefined
    const match = obligation.amount_is_estimate ? null : findMatch(obligation, transactions.filter((t) => !used.has(t.id)), counterpartyKeys(party, agreement?.counterparty_name))
    if (match) {
      used.add(match.transaction.id)
      const { error } = await supabase
        .from('agreement_obligations')
        .update({ status: 'matched', transaction_id: match.transaction.id, matched_basis: match.basis, matched_at: new Date().toISOString() })
        .eq('id', obligation.id)
      if (error) throw new Error(`obligation update failed: ${error.message}`)
      summary.matched++
    } else if (!obligation.amount_is_estimate && obligation.status === 'expected' && daysBetween(obligation.due_on, today) > MISSED_AFTER_DAYS) {
      // An estimate can never be matched on its amount, so its absence proves nothing.
      const { error } = await supabase.from('agreement_obligations').update({ status: 'missed' }).eq('id', obligation.id)
      if (error) throw new Error(`obligation update failed: ${error.message}`)
      summary.missed++
    }
  }
  return summary
}

/**
 * The one transaction that is this payment: same amount to the öre, same
 * currency, within the date tolerance, and the counterparty in the bank text
 * (proven). One amount hit with no counterparty anywhere is a guess. Two
 * hits are nobody's.
 */
export function findMatch(
  obligation: Pick<ObligationRow, 'due_on' | 'amount' | 'currency'>,
  transactions: TransactionRow[],
  partyKeys: Set<string>,
): { transaction: TransactionRow; basis: 'proven' | 'guessed' } | null {
  const keyTokens = [...partyKeys].map((k) => k.split(' '))
  const byAmount = transactions.filter(
    (t) =>
      Math.abs(Math.abs(Number(t.amount)) - Number(obligation.amount)) < 0.005 &&
      (t.currency ?? 'SEK') === obligation.currency &&
      Math.abs(daysBetween(obligation.due_on, t.date)) <= DATE_TOLERANCE_DAYS,
  )
  const byParty = byAmount.filter((t) => {
    const words = textTokens(t)
    return keyTokens.some((tokens) => tokens.every((token) => words.has(token)))
  })
  if (byParty.length === 1) return { transaction: byParty[0], basis: 'proven' }
  if (byParty.length === 0 && byAmount.length === 1) return { transaction: byAmount[0], basis: 'guessed' }
  return null
}

/**
 * Every name a party is known by, reduced to its core words. A bank text
 * names the party when it contains all the words of one of them, in any
 * order: "KVARNEN FASTIGHETS" is Fastighets AB Kvarnen.
 */
export function counterpartyKeys(party: PartyRow | undefined, printedName: string | null | undefined): Set<string> {
  const raw = [...(party?.alias_keys ?? []), party?.display_name, party?.legal_name, printedName].filter((s): s is string => !!s)
  return new Set(raw.map((s) => coreKey(ledgerKey(s))).filter(Boolean))
}

function textTokens(t: TransactionRow): Set<string> {
  return new Set(
    [t.description, t.original_description, t.merchant_name]
      .filter((s): s is string => !!s)
      .flatMap((s) => coreKey(ledgerKey(s)).split(' '))
      .filter(Boolean),
  )
}

async function loadObligations(supabase: SupabaseClient, companyId: string, today: string): Promise<ObligationRow[]> {
  const { data, error } = await supabase
    .from('agreement_obligations')
    .select('id, agreement_id, due_on, amount, currency, amount_is_estimate, status')
    .eq('company_id', companyId)
    .in('status', ['expected', 'missed'])
    .gte('due_on', addDays(today, -LOOKBACK_DAYS))
    .lte('due_on', addDays(today, LOOKAHEAD_DAYS))
    .order('due_on', { ascending: true })
  if (error) throw new Error(`obligations fetch failed: ${error.message}`)
  return (data ?? []) as ObligationRow[]
}

async function loadAgreements(supabase: SupabaseClient, ids: string[]): Promise<AgreementRow[]> {
  const { data, error } = await supabase.from('agreements').select('id, counterparty_party_id, counterparty_name').in('id', ids)
  if (error) throw new Error(`agreements fetch failed: ${error.message}`)
  return (data ?? []) as AgreementRow[]
}

async function loadParties(supabase: SupabaseClient, ids: string[]): Promise<PartyRow[]> {
  if (ids.length === 0) return []
  const { data, error } = await supabase.from('parties').select('id, display_name, legal_name, alias_keys').in('id', ids)
  if (error) throw new Error(`parties fetch failed: ${error.message}`)
  return (data ?? []) as PartyRow[]
}

/** Outgoing, unignored transactions around the obligations' due dates. */
async function loadTransactions(supabase: SupabaseClient, companyId: string, obligations: ObligationRow[]): Promise<TransactionRow[]> {
  const dates = obligations.map((o) => o.due_on).sort()
  const { data, error } = await supabase
    .from('transactions')
    .select('id, date, amount, currency, description, original_description, merchant_name')
    .eq('company_id', companyId)
    .eq('is_ignored', false)
    .lt('amount', 0)
    .gte('date', addDays(dates[0], -DATE_TOLERANCE_DAYS))
    .lte('date', addDays(dates[dates.length - 1], DATE_TOLERANCE_DAYS))
    .limit(2000)
  if (error) throw new Error(`transactions fetch failed: ${error.message}`)
  return (data ?? []) as TransactionRow[]
}
