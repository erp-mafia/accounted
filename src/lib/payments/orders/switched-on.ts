/**
 * Who may pay through the bank from this installation.
 *
 * Two questions, asked together at every door that starts something new
 * (availability, the company verification, preparing orders, starting a
 * signing):
 *
 *   1. Does the installation serve bank payments at all? A registered payment
 *      initiation provider: the Connect adapter on hosted and self-hosted alike
 *      (lib/payments/initiation/connect.ts), present when a connector key is
 *      configured.
 *   2. Is the company on a paid plan? Bank payments ride CAPABILITY.bank_sync,
 *      the paid key of the bank services, until the Betalningar add-on gets a
 *      capability of its own with the pricing work. Trial, comp, byrå agreement
 *      and Stripe grants all carry it; the manual tier does not.
 *
 * OPENPAYMENTS_COMPANY_IDS is the pilot switch. Unset or empty (the normal
 * state): every company on a paid plan. A comma-separated list of company ids:
 * ONLY those companies, whatever their plan, so an operator can try the feature
 * with one company before opening it. `*`: every company, plan or not
 * (development, self-host). Read on every call so a redeploy with a new value
 * needs no restart of anything else.
 *
 * Polling, cancelling and resolving an order that already exists never ask
 * here: money at the bank must stay followable after a plan lapses (freeze
 * and retain), so those paths take the provider straight from the registry.
 */

import type { OperationContext } from '@/lib/operations/types'
import { getPaymentInitiationProvider, type PaymentInitiationProvider } from '@/lib/payments/initiation/provider'
import { paymentsAdmitted } from './pilot'

export { paymentsPilot, type PaymentsEnv, type PaymentsPilot } from './pilot'

/** Why a company cannot pay through the bank right now. */
export type PaymentsUnavailableReason = 'no_provider' | 'not_in_pilot' | 'subscription' | 'sandbox'

export type PaymentsDoor =
  | { ok: true; provider: PaymentInitiationProvider }
  | { ok: false; reason: Exclude<PaymentsUnavailableReason, 'sandbox'> }

/**
 * The provider for a company that may pay through the bank, or the reason it
 * may not. The sandbox check stays with the callers that need it: a sandbox
 * company is refused for a different reason and never gets an upsell.
 */
export async function openPaymentsDoor(ctx: Pick<OperationContext, 'supabase' | 'companyId'>): Promise<PaymentsDoor> {
  const provider = await getPaymentInitiationProvider(ctx.companyId)
  if (!provider) return { ok: false, reason: 'no_provider' }
  const admitted = await paymentsAdmitted(ctx.supabase, ctx.companyId)
  return admitted.ok ? { ok: true, provider } : admitted
}
