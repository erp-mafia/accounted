import type { SupabaseClient } from '@supabase/supabase-js'
import { getStripe } from '@/lib/stripe/client'
import { hasCapability } from '@/lib/entitlements/has-capability'
import { CAPABILITY } from '@/lib/entitlements/keys'
import { isSandboxCompany } from '@/lib/sandbox/guard'
import { createServiceClientNoCookies } from '@/lib/auth/api-keys'
import { createLogger } from '@/lib/logger'
import type { ExtensionContext } from '@/lib/extensions/types'
import type { Invoice, CreditNote } from '@/types'
import {
  connectedAccountOptions,
  isLiveMode,
  isStripeConnectConfigured,
} from './connect'
import type { StripeConnection } from '../types'

const log = createLogger('stripe/payment-links')

type ActiveConnection = Pick<StripeConnection, 'id' | 'stripe_account_id' | 'livemode'>

async function getActiveConnection(
  supabase: SupabaseClient,
  companyId: string,
): Promise<ActiveConnection | null> {
  const { data } = await supabase
    .from('stripe_connections')
    .select('id, stripe_account_id, livemode')
    .eq('company_id', companyId)
    .eq('status', 'active')
    .maybeSingle()
  if (!data?.stripe_account_id) return null
  return data as ActiveConnection
}

/**
 * Registry service (`services.createInvoicePaymentLink`): create a single-use
 * Stripe Payment Link for an invoice on the company's connected account.
 *
 * Returns null when this company/invoice is not eligible (no connection, no
 * capability, sandbox, live/test-mode drift, nothing to pay): the caller then
 * simply sends the invoice without a link. Throws on actual Stripe API
 * failures so the caller can surface a warning.
 *
 * The link amount is the customer's payable share (`remaining_amount`, which
 * is total minus ROT/RUT deduction at send time) in the invoice currency.
 * Stripe idempotency keys are derived from the invoice id plus the payable
 * amount in minor units: a retried send of the same amount reuses the same
 * Price and Payment Link instead of minting duplicates, while a resend after
 * the amount changed mints fresh objects instead of tripping Stripe's
 * idempotency conflict (reused key with different parameters is rejected).
 */
export async function createInvoicePaymentLink(
  supabase: SupabaseClient,
  companyId: string,
  _userId: string,
  invoice: Invoice,
): Promise<{ url: string; externalId: string } | null> {
  if (!isStripeConnectConfigured()) return null
  // The sandbox never talks to external services.
  if (await isSandboxCompany(supabase, companyId)) return null
  if (!(await hasCapability(supabase, companyId, CAPABILITY.stripe_payments))) return null

  const connection = await getActiveConnection(supabase, companyId)
  if (!connection) return null

  // A connection made in one mode must not create links in the other: a
  // platform key swap (test <-> live) would otherwise silently mint links
  // against the wrong account universe.
  if (connection.livemode !== isLiveMode()) {
    log.warn('live/test mode drift between connection and platform key; skipping link', {
      companyId,
      connectionLivemode: connection.livemode,
    })
    return null
  }

  const payable =
    invoice.remaining_amount ?? (invoice.total - (invoice.deduction_total ?? 0))
  if (!(payable > 0)) return null

  const stripe = getStripe()
  const opts = connectedAccountOptions(connection.stripe_account_id!)
  const productName = invoice.invoice_number
    ? `Faktura ${invoice.invoice_number}`
    : 'Faktura'
  const unitAmount = Math.round(payable * 100)

  const price = await stripe.prices.create(
    {
      currency: invoice.currency.toLowerCase(),
      unit_amount: unitAmount,
      product_data: { name: productName },
    },
    { ...opts, idempotencyKey: `acc_inv_price_${invoice.id}_${unitAmount}` },
  )

  const link = await stripe.paymentLinks.create(
    {
      line_items: [{ price: price.id, quantity: 1 }],
      // One invoice, one payment: a completed session deactivates the link,
      // so a customer can never pay the same invoice twice through it.
      restrictions: { completed_sessions: { limit: 1 } },
      metadata: {
        invoice_id: invoice.id,
        company_id: companyId,
        invoice_number: invoice.invoice_number ?? '',
      },
    },
    { ...opts, idempotencyKey: `acc_inv_plink_${invoice.id}_${unitAmount}` },
  )

  log.info('created payment link for invoice', {
    companyId,
    invoiceId: invoice.id,
    paymentLinkId: link.id,
  })

  return { url: link.url, externalId: link.id }
}

/** Deactivate a payment link on the company's connected account. */
export async function deactivatePaymentLink(
  supabase: SupabaseClient,
  companyId: string,
  paymentLinkId: string,
): Promise<boolean> {
  if (!isStripeConnectConfigured()) return false
  const connection = await getActiveConnection(supabase, companyId)
  if (!connection) return false
  await getStripe().paymentLinks.update(
    paymentLinkId,
    { active: false },
    connectedAccountOptions(connection.stripe_account_id!),
  )
  return true
}

/**
 * invoice.paid handler: once an invoice is settled (through Stripe or any
 * other channel), its payment link must stop accepting money. Belt to the
 * single-use restriction's suspenders. Best-effort: a failure is logged,
 * never surfaced to the flow that emitted the event.
 */
export async function handleInvoicePaid(
  payload: { invoice: Invoice; companyId: string },
  ctx?: ExtensionContext,
): Promise<void> {
  const linkId = payload.invoice?.stripe_payment_link_id
  if (!linkId) return
  const supabase = ctx?.supabase ?? createServiceClientNoCookies()
  try {
    await deactivatePaymentLink(supabase, payload.companyId, linkId)
    log.info('deactivated payment link after invoice paid', {
      invoiceId: payload.invoice.id,
      paymentLinkId: linkId,
    })
  } catch (err) {
    log.warn('failed to deactivate payment link after invoice paid', {
      invoiceId: payload.invoice?.id,
      paymentLinkId: linkId,
      reason: err instanceof Error ? err.message : String(err),
    })
  }
}

/**
 * credit_note.created handler: crediting an invoice voids the claim, so the
 * ORIGINAL invoice's payment link must be deactivated (the credit note itself
 * never carries one; derived documents don't copy the column).
 */
export async function handleCreditNoteCreated(
  payload: { creditNote: CreditNote; companyId: string },
  ctx?: ExtensionContext,
): Promise<void> {
  const originalId = payload.creditNote?.credited_invoice_id
  if (!originalId) return
  const supabase = ctx?.supabase ?? createServiceClientNoCookies()
  try {
    const { data: original } = await supabase
      .from('invoices')
      .select('id, stripe_payment_link_id')
      .eq('id', originalId)
      .eq('company_id', payload.companyId)
      .maybeSingle()
    const linkId = original?.stripe_payment_link_id
    if (!linkId) return
    await deactivatePaymentLink(supabase, payload.companyId, linkId)
    log.info('deactivated payment link after credit note', {
      invoiceId: originalId,
      paymentLinkId: linkId,
    })
  } catch (err) {
    log.warn('failed to deactivate payment link after credit note', {
      invoiceId: originalId,
      reason: err instanceof Error ? err.message : String(err),
    })
  }
}
