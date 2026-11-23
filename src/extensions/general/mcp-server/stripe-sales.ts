import type { SupabaseClient } from '@supabase/supabase-js'
import { formatVoucher } from '@/lib/bookkeeping/voucher-series-resolver'
import { dbError } from '@/lib/errors/db-error'
import { STRIPE_IMPORT_SOURCE } from '@/extensions/general/stripe/lib/transaction-sync'
import type { Transaction } from '@/types'

/**
 * A Stripe sale in gnubok_suggest_categories.
 *
 * The Stripe feed brings each card payment onto the Stripe balance as a row
 * of its own with the gross amount and the payer's name, and nothing else:
 * no moms, no buyer country (stripe/lib/transaction-sync.ts). No rule,
 * history or learned counterpart matches such a row, so it was listed as
 * having no signal at all, and an agent filled the gap with 25 % Swedish
 * moms, which is wrong for a sale to another EU country or outside the EU.
 *
 * The row now carries what the product does know: it is a Stripe sale,
 * Stripe sales are booked as one samlingsverifikat per day through
 * gnubok_bulk_book_transactions (the bookkeep skill), the verifikat that
 * booked the company's latest Stripe sale, and where the moms comes from.
 * It names no account and no rate, and it books nothing.
 */

/** The proposal id a Stripe sale carries. */
export const STRIPE_DAILY_SALES_PROPOSAL_ID = 'stripe_daily_sales'

/** The hint on that proposal: where the moms of a Stripe sale comes from (MCP, Swedish like `why`). */
export const STRIPE_SALE_VAT_HINT =
  'Raden har varken moms eller köparens land. Momsen beror på vad som sålts och på köparen (land, företag eller privatperson): ta den ur Stripes rapport för dagen och avgör den med horizontal/swedish-vat. Anta aldrig 25 % svensk moms; saknas rapporten, be användaren om den.'

/** A sale on the Stripe balance: a card payment from the Stripe feed, money in. */
export function isStripeSaleRow(tx: Pick<Transaction, 'import_source' | 'transaction_method' | 'amount'>): boolean {
  return tx.import_source === STRIPE_IMPORT_SOURCE && tx.transaction_method === 'card' && Number(tx.amount) > 0
}

export interface StripeSalesVoucher {
  journal_entry_id: string
  /** "A12" when the verifikat has a number, else null. */
  voucher: string | null
  entry_date: string
}

/**
 * The posted verifikat that booked the company's latest booked Stripe sale,
 * or null when no Stripe sale is booked yet. One read.
 */
export async function latestStripeSalesVoucher(
  supabase: SupabaseClient,
  companyId: string,
): Promise<StripeSalesVoucher | null> {
  const { data, error } = await supabase
    .from('transactions')
    .select('journal_entry:journal_entries!journal_entry_id(id, voucher_series, voucher_number, entry_date, status)')
    .eq('company_id', companyId)
    .eq('import_source', STRIPE_IMPORT_SOURCE)
    .eq('transaction_method', 'card')
    .gt('amount', 0)
    .not('journal_entry_id', 'is', null)
    .order('date', { ascending: false })
    .limit(1)
  if (error) throw dbError(error)
  const entry = ((data ?? []) as unknown as Array<{
    journal_entry: { id: string; voucher_series: string | null; voucher_number: number | null; entry_date: string; status: string } | null
  }>)[0]?.journal_entry
  if (!entry || entry.status !== 'posted') return null
  return {
    journal_entry_id: entry.id,
    voucher: entry.voucher_number ? formatVoucher(entry) : null,
    entry_date: entry.entry_date,
  }
}

/** The proposal a Stripe sale leads with: how such rows are booked, never a booking of its own. */
export function stripeDailySalesProposal(example: StripeSalesVoucher | null): Record<string, unknown> {
  const latest = example
    ? ` Senast bokförda Stripe-försäljning: ${example.voucher ? `verifikat ${example.voucher}` : 'verifikatet'} (${example.entry_date}).`
    : ''
  return {
    id: STRIPE_DAILY_SALES_PROPOSAL_ID,
    source: 'stripe_feed',
    label: 'Stripe-försäljning: en samlingsverifikat per dag',
    why: `En försäljning via Stripe på Stripe-saldot. Stripe-försäljning bokförs som en samlingsverifikat per dag: dagens alla försäljningsrader i ett anrop till gnubok_bulk_book_transactions.${latest}`,
    hint: STRIPE_SALE_VAT_HINT,
    books_without_review: false,
    ...(example ? { example_voucher: example } : {}),
  }
}
