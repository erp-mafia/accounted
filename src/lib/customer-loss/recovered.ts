/**
 * Återvunnen kundförlust (build spec 4.2 H, founder decision F3).
 *
 * A payment on a written-off claim is income, never a silent reopening of the
 * invoice: Dr the account the money reached / Cr 3950 Återvunna, tidigare
 * avskrivna kundfordringar for the net, and Cr the output VAT accounts for
 * the VAT the write-off took off (ML 7 kap 43 §: the tax is reported again
 * when the payment comes). The VAT share follows the written-off VAT per
 * account pro rata, and the recovery that reaches the written-off amount
 * takes the exact remainder, so every recovery together reports back the
 * written-off VAT to the öre. The momsdeklaration raises ruta 05 again by the
 * recorded bases.
 *
 * While the invoice's collection case is open, a payment straight to the
 * company is refused here: the agency must hear of it (it would otherwise go
 * on pursuing the customer for money already paid), and only the case knows
 * how to tell it. The case is closed or withdrawn first. A payment the
 * agency itself collected and reported (bookCollectedPayment in
 * lib/collections/collected-payments.ts) passes fromCollectedPayment, debits
 * the connection's clearing account and is booked while the case is open,
 * with its payment record as the decision's underlag.
 *
 * The status stays 'written_off'. A claim that never reached the ledger
 * (kontantmetoden) has no write-off voucher to recover from: its payment is
 * an ordinary sale (CUSTOMER_LOSS_RECOVERY_NOT_BOOKED).
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { roundOre } from '@/lib/money'
import { liveRows, recoveryLines, recoveryShares, totalVat } from './amounts'
import type { CustomerLossOutcome } from './errors'
import { bookDecision } from './record'
import { loadCustomerLossState } from './state'
import { decisionDescription, invoiceLabel } from './text'

export interface RecordRecoveredLossParams {
  invoiceId: string
  amount: number
  entryDate: string
  /** The account the money reached: the bank (1930) by default. */
  paymentAccount: string
  reason: string
  decidedBy: string
  /** The agency collected the money and reported it (collections settlement): the case may stay open. */
  fromCollectedPayment?: boolean
  /** The underlag the decision rests on: the payment record of a collected payment. */
  evidenceDocumentId?: string | null
}

export async function recordRecoveredLoss(
  supabase: SupabaseClient,
  companyId: string,
  userId: string,
  params: RecordRecoveredLossParams,
): Promise<CustomerLossOutcome> {
  const loaded = await loadCustomerLossState(supabase, companyId, params.invoiceId)
  if (!loaded.ok) return loaded
  const { state } = loaded
  if (state.invoice.status !== 'written_off' || !state.confirmed) {
    return { ok: false, code: 'CUSTOMER_LOSS_NOT_WRITTEN_OFF' }
  }
  if (!state.confirmed.journal_entry_id) return { ok: false, code: 'CUSTOMER_LOSS_RECOVERY_NOT_BOOKED' }
  if (state.latestCase?.is_open && !params.fromCollectedPayment) {
    return { ok: false, code: 'CUSTOMER_LOSS_RECOVERY_CASE_OPEN' }
  }

  const amount = roundOre(params.amount)
  const prior = liveRows(state.rows).filter((r) => r.kind === 'recovered')
  const { shares, left } = recoveryShares(state.confirmed, prior, amount)
  if (amount <= 0 || roundOre(amount - left) > 0) {
    return { ok: false, code: 'CUSTOMER_LOSS_RECOVERY_EXCEEDS', details: { left } }
  }
  const vat = totalVat(shares)
  const label = invoiceLabel(state.invoice)

  return bookDecision(supabase, companyId, userId, {
    state,
    kind: 'recovered',
    entryDate: params.entryDate,
    description: decisionDescription('Återvunnen kundförlust', label, params.reason),
    lines: recoveryLines({ amount, shares, paymentAccount: params.paymentAccount, tag: label }),
    amount,
    net: roundOre(amount - vat),
    vat,
    shares,
    reason: params.reason,
    evidenceDocumentId: params.evidenceDocumentId ?? null,
    caseId: state.latestCase?.id ?? null,
    decidedBy: params.decidedBy,
  })
}
