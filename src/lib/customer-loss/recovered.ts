/**
 * Återvunnen kundförlust (build spec 4.2 H, product decision F3).
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
import { liveRows, recoveryClosingAmounts, recoveryLeft, recoveryLines, recoveryShares, totalVat, type VatShare } from './amounts'
import type { CustomerLossOutcome } from './errors'
import { resolvePrimaryBankAccount } from '@/lib/bookkeeping/settlement-account'
import { createLogger } from '@/lib/logger'
import { bookDecision } from './record'
import { loadCustomerLossState, type CustomerLossState, type WriteOffRow } from './state'
import { decisionDescription, invoiceLabel } from './text'

const log = createLogger('customer-loss/recovered')

export interface RecordRecoveredLossParams {
  invoiceId: string
  amount: number
  entryDate: string
  /** The account the money reached; the company's primary bank account when nothing names one. */
  paymentAccount?: string
  reason: string
  decidedBy: string
  /** The agency collected the money and reported it (collections settlement): the case may stay open. */
  fromCollectedPayment?: boolean
  /** The underlag the decision rests on: the payment record of a collected payment. */
  evidenceDocumentId?: string | null
}

export interface RecoveryPlan {
  /** What the recovery takes off the written-off claim, VAT included. */
  amount: number
  /** The money that came in: `amount`, or a öresavrundning away from it. */
  received: number
  net: number
  vat: number
  shares: VatShare[]
}

/**
 * What a recovery of `receivedAmount` books on a written-off claim, or the
 * amount left when it is more than the claim has. A payment of what the
 * invoice asked for closes the claim (recoveryClosingAmounts): it takes what
 * is left, every written-off VAT öre is reported again, and the öre between
 * the two goes to 3740 (recoveryLines).
 */
export function planRecovery(
  confirmed: WriteOffRow,
  state: Pick<CustomerLossState, 'rows' | 'basis' | 'toPayRounding'> & { invoice: Pick<CustomerLossState['invoice'], 'total'> },
  receivedAmount: number,
): { ok: true; plan: RecoveryPlan } | { ok: false; left: number } {
  const received = roundOre(receivedAmount)
  const prior = liveRows(state.rows).filter((r) => r.kind === 'recovered')
  const left = recoveryLeft(confirmed, prior)
  const closes = recoveryClosingAmounts({ left, total: state.invoice.total, basis: state.basis, toPayRounding: state.toPayRounding }).includes(received)
  const amount = closes ? left : received
  if (received <= 0 || roundOre(amount - left) > 0) return { ok: false, left }
  const { shares } = recoveryShares(confirmed, prior, amount)
  const vat = totalVat(shares)
  return { ok: true, plan: { amount, received, net: roundOre(amount - vat), vat, shares } }
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

  const planned = planRecovery(state.confirmed, state, params.amount)
  if (!planned.ok) return { ok: false, code: 'CUSTOMER_LOSS_RECOVERY_EXCEEDS', details: { left: planned.left } }
  const { amount, received, shares, vat, net } = planned.plan
  const label = invoiceLabel(state.invoice)
  const paymentAccount = params.paymentAccount ?? (await resolvePrimaryBankAccount(supabase, companyId, log))

  return bookDecision(supabase, companyId, userId, {
    state,
    kind: 'recovered',
    entryDate: params.entryDate,
    description: decisionDescription('Återvunnen kundförlust', label, params.reason),
    lines: recoveryLines({ amount, received, shares, paymentAccount, tag: label }),
    amount,
    net,
    vat,
    shares,
    reason: params.reason,
    evidenceDocumentId: params.evidenceDocumentId ?? null,
    caseId: state.latestCase?.id ?? null,
    decidedBy: params.decidedBy,
  })
}
