import type Stripe from 'stripe'
import type { SupabaseClient } from '@supabase/supabase-js'
import { getStripe } from '@/lib/stripe/client'
import { createJournalEntry, findFiscalPeriod } from '@/lib/bookkeeping/engine'
import {
  generateReverseChargeBasisLines,
  generateReverseChargeLines,
} from '@/lib/bookkeeping/vat-entries'
import { createLogger, type Logger } from '@/lib/logger'
import type { CreateJournalEntryInput, CreateJournalEntryLineInput } from '@/types'
import { connectedAccountOptions } from './connect'
import type { StripeConnection } from '../types'

const defaultLog = createLogger('stripe/payouts')

/**
 * Book a Stripe payout as one journal entry:
 *
 *   Debit  1930 Företagskonto            [net]
 *   Debit  6570 Bankkostnader            [fees]
 *   Debit  4535 + Credit 4598            [fees]        ruta 21 basis pair
 *   Debit  2645 / Credit 2614            [25% of fees] fiktiv moms
 *   Credit 1686 Fordringar för kontokort [gross]
 *
 * Stripe Payments Europe Ltd (Ireland) invoices the fees, so they are an EU
 * services purchase under omvänd skattskyldighet: the same vat-entries
 * generators as supplier invoices produce the ruta 21 basis pair and the
 * 2645/2614 fiktiv-moms pair, keeping the momsdeklaration correct by
 * construction (rutor 21, 30, 48).
 *
 * Auto-booked ONLY when fully deterministic: every balance transaction in the
 * payout is a charge/payment (plus the payout row itself), the currency is
 * SEK, the company is VAT registered, and gross - fees equals the payout net
 * exactly. Refunds, disputes, adjustments, FX or arithmetic drift become
 * needs_review rows: a human decides, the sync never guesses.
 *
 * The 1930 debit then appears in bank reconciliation
 * (get_unlinked_1930_lines) for linking against the incoming bank feed
 * transaction, which closes the loop without double-booking the deposit.
 */

/** Balance transaction types that make up a plain card-payment payout. */
const DETERMINISTIC_TXN_TYPES = new Set(['charge', 'payment'])

interface PayoutLike {
  id: string
  amount?: number | null
  currency?: string | null
  arrival_date?: number | null
  livemode?: boolean
}

export interface PayoutOutcome {
  status: 'booked' | 'needs_review' | 'ignored' | 'already_processed'
  reason: string | null
}

export async function processPayoutPaidEvent(
  supabase: SupabaseClient,
  connection: StripeConnection,
  event: Stripe.Event,
  log: Logger = defaultLog,
): Promise<PayoutOutcome> {
  const payout = event.data.object as PayoutLike
  if (!payout?.id) return { status: 'ignored', reason: 'malformed_event' }

  // Claim (idempotency): one row per (connection, payout). A duplicate event
  // or overlapping poll window is a no-op.
  const { data: inserted } = await supabase
    .from('stripe_payouts')
    .upsert(
      {
        company_id: connection.company_id,
        connection_id: connection.id,
        payout_id: payout.id,
        stripe_event_id: event.id,
        amount: typeof payout.amount === 'number' ? payout.amount / 100 : null,
        currency: payout.currency?.toUpperCase() ?? null,
        arrival_date: payout.arrival_date
          ? new Date(payout.arrival_date * 1000).toISOString().split('T')[0]
          : null,
        status: 'processing',
        event_created_at: new Date(event.created * 1000).toISOString(),
      },
      { onConflict: 'connection_id,payout_id', ignoreDuplicates: true },
    )
    .select('id')

  if (!inserted || inserted.length === 0) {
    return { status: 'already_processed', reason: null }
  }
  const claimId = (inserted[0] as { id: string }).id

  const outcome = await evaluateAndBook(supabase, connection, payout, event, log)

  await supabase
    .from('stripe_payouts')
    .update({
      status: outcome.status === 'booked' ? 'booked' : outcome.status,
      reason: outcome.reason,
      ...(outcome.journalEntryId ? { journal_entry_id: outcome.journalEntryId } : {}),
      ...(outcome.gross != null ? { gross: outcome.gross } : {}),
      ...(outcome.fees != null ? { fees: outcome.fees } : {}),
    })
    .eq('id', claimId)

  return { status: outcome.status, reason: outcome.reason }
}

interface EvaluationOutcome {
  status: 'booked' | 'needs_review' | 'ignored'
  reason: string | null
  journalEntryId?: string
  gross?: number
  fees?: number
}

async function evaluateAndBook(
  supabase: SupabaseClient,
  connection: StripeConnection,
  payout: PayoutLike,
  event: Stripe.Event,
  log: Logger,
): Promise<EvaluationOutcome> {
  if (payout.livemode !== undefined && payout.livemode !== connection.livemode) {
    return { status: 'ignored', reason: 'livemode_mismatch' }
  }
  if (payout.currency?.toLowerCase() !== 'sek') {
    return { status: 'needs_review', reason: 'non_sek_payout' }
  }

  const { data: settings } = await supabase
    .from('company_settings')
    .select('vat_registered')
    .eq('company_id', connection.company_id)
    .maybeSingle()
  if (settings?.vat_registered === false) {
    // Reverse charge on the fees interacts with the company's VAT status;
    // a human decides how a non-VAT-registered company books this.
    return { status: 'needs_review', reason: 'not_vat_registered' }
  }

  const stripe = getStripe()
  const txns = await stripe.balanceTransactions
    .list({ payout: payout.id, limit: 100 }, connectedAccountOptions(connection.stripe_account_id!))
    .autoPagingToArray({ limit: 1000 })

  let grossOre = 0
  let feesOre = 0
  for (const txn of txns) {
    if (txn.type === 'payout') continue // the payout row itself (negative net)
    if (!DETERMINISTIC_TXN_TYPES.has(txn.type)) {
      return { status: 'needs_review', reason: `non_deterministic_txn_${txn.type}` }
    }
    if (txn.currency?.toLowerCase() !== 'sek') {
      return { status: 'needs_review', reason: 'non_sek_balance_txn' }
    }
    grossOre += txn.amount
    feesOre += txn.fee
  }

  const gross = grossOre / 100
  const fees = feesOre / 100
  const net = typeof payout.amount === 'number' ? payout.amount / 100 : null

  if (net == null || Math.round((gross - fees) * 100) !== Math.round(net * 100)) {
    return {
      status: 'needs_review',
      reason: 'arithmetic_mismatch',
      gross,
      fees,
    }
  }
  if (!(gross > 0)) {
    return { status: 'needs_review', reason: 'empty_payout', gross, fees }
  }

  const arrivalDate = payout.arrival_date
    ? new Date(payout.arrival_date * 1000).toISOString().split('T')[0]
    : new Date(event.created * 1000).toISOString().split('T')[0]

  const fiscalPeriodId = await findFiscalPeriod(supabase, connection.company_id, arrivalDate)
  if (!fiscalPeriodId) {
    return { status: 'needs_review', reason: 'no_open_fiscal_period', gross, fees }
  }

  const round = (n: number) => Math.round(n * 100) / 100
  const lines: CreateJournalEntryLineInput[] = [
    {
      account_number: '1930',
      debit_amount: round(net),
      credit_amount: 0,
      line_description: `Stripe-utbetalning ${payout.id}`,
    },
  ]
  if (fees > 0) {
    lines.push({
      account_number: '6570',
      debit_amount: round(fees),
      credit_amount: 0,
      line_description: 'Stripe-avgifter (omvänd skattskyldighet, EU)',
    })
    // Ruta 21 basis pair (4535 / 4598) + fiktiv moms (2645 / 2614): same
    // generators as the supplier reverse-charge flow, so the VAT report
    // picks the fees up identically.
    lines.push(...generateReverseChargeBasisLines(round(fees), 0.25, 'eu_business'))
    lines.push(...generateReverseChargeLines(round(fees), 0.25, false))
  }
  lines.push({
    account_number: '1686',
    debit_amount: 0,
    credit_amount: round(gross),
    line_description: 'Avräkning Stripe-betalningar',
  })

  const input: CreateJournalEntryInput = {
    fiscal_period_id: fiscalPeriodId,
    entry_date: arrivalDate,
    description: `Stripe-utbetalning ${payout.id}`,
    source_type: 'stripe_payout',
    lines,
  }

  try {
    const entry = await createJournalEntry(
      supabase,
      connection.company_id,
      connection.user_id,
      input,
    )
    if (!entry) {
      return { status: 'needs_review', reason: 'booking_returned_null', gross, fees }
    }
    log.info('booked stripe payout', {
      connectionId: connection.id,
      payoutId: payout.id,
      journalEntryId: entry.id,
      net,
      fees,
    })
    return { status: 'booked', reason: null, journalEntryId: entry.id, gross, fees }
  } catch (err) {
    return {
      status: 'needs_review',
      reason: `booking_failed: ${err instanceof Error ? err.message : String(err)}`,
      gross,
      fees,
    }
  }
}
