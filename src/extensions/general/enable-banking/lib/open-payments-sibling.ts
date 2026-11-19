import type { SupabaseClient } from '@supabase/supabase-js'
import { LIVE_CONNECTION_STATUSES, OPEN_PAYMENTS_AGGREGATOR } from '@/lib/bank-sync/aggregator'
import { bankCoveredByOpenPayments } from '@/lib/bank-feed/bank-coverage'
import { matchBankByName } from '@/lib/bank-feed/bank-match'

export interface OpenPaymentsSibling {
  id: string
  bank_name: string
}

/**
 * The company's Open Payments connection to the bank a fresh Enable Banking
 * connect names, or null. Such a connection holds that bank's accounts until
 * it is removed, so a second login there through Enable Banking goes through
 * at the bank and is then refused at the callback
 * (BANK_CALLBACK_MIRROR_CLAIMED): the person signs with BankID for nothing.
 * Matched the way the switch campaign matches the two services' bank names
 * (lib/bank-feed/bank-match.ts), and only for a bank Open Payments reaches,
 * so "Nordea First Card" never counts as "Nordea".
 */
export async function findOpenPaymentsSibling(
  supabase: SupabaseClient,
  companyId: string,
  bankName: string,
): Promise<OpenPaymentsSibling | null> {
  if (!bankCoveredByOpenPayments(bankName)) return null
  const { data, error } = await supabase
    .from('bank_connections')
    .select('id, bank_name')
    .eq('company_id', companyId)
    .eq('aggregator', OPEN_PAYMENTS_AGGREGATOR)
    .in('status', [...LIVE_CONNECTION_STATUSES])
  if (error) throw error
  const rows = ((data ?? []) as Array<{ id: string; bank_name: string | null }>)
    .filter((r): r is OpenPaymentsSibling => Boolean(r.bank_name))
    .map((r) => ({ id: r.id, bank_name: r.bank_name, name: r.bank_name }))
  const match = matchBankByName(bankName, rows)
  return match ? { id: match.id, bank_name: match.bank_name } : null
}

/** What the connect answers instead of sending the person to the bank. */
export function openPaymentsSiblingMessage(sibling: OpenPaymentsSibling): string {
  return `${sibling.bank_name} är redan kopplad med BankID under Ny bankkoppling på den här sidan. Koppla bort den där först om du vill koppla banken på nytt.`
}
