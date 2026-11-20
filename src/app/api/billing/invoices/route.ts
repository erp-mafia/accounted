import { NextResponse } from 'next/server'
import type Stripe from 'stripe'
import { withRouteContext } from '@/lib/api/with-route-context'
import { isSandboxCompany } from '@/lib/sandbox/guard'
import { createServiceClient } from '@/lib/supabase/server'
import { getStripe, isStripeConfigured } from '@/lib/stripe/client'

/** Statuses a customer can have a receipt for. Drafts and voided invoices are not shown. */
const SHOWN_STATUSES = new Set<Stripe.Invoice.Status>(['paid', 'open', 'uncollectible'])

const INVOICE_LIMIT = 24

export interface BillingInvoice {
  id: string
  number: string | null
  /** ISO timestamp of when Stripe created the invoice. */
  created: string
  /** Kronor, not öre. Amount paid, or the amount still due for an unpaid invoice. */
  amountPaid: number
  currency: string
  status: 'paid' | 'open' | 'uncollectible'
  description: string | null
  pdfUrl: string | null
  hostedUrl: string | null
}

function toBillingInvoice(invoice: Stripe.Invoice): BillingInvoice {
  const status = invoice.status as BillingInvoice['status']
  // An open or uncollectible invoice has amount_paid 0: show what it is for
  // (amount_due) so the receipt row is not a misleading "0 kr".
  const minor = status === 'paid' ? invoice.amount_paid : invoice.amount_due
  return {
    id: invoice.id,
    number: invoice.number ?? null,
    created: new Date(invoice.created * 1000).toISOString(),
    amountPaid: Math.round((minor / 100) * 100) / 100,
    currency: invoice.currency,
    status,
    description: invoice.description ?? invoice.lines?.data?.[0]?.description ?? null,
    pdfUrl: invoice.invoice_pdf ?? null,
    hostedUrl: invoice.hosted_invoice_url ?? null,
  }
}

/**
 * The active company's Stripe invoices (receipts) for Settings → Abonnemang,
 * newest first. Read-only. A company without a Stripe customer, or an
 * instance without Stripe, has no receipts: that is an empty list, not an
 * error.
 *
 * company_subscriptions is read via the service client on purpose (see
 * billing/portal): the row is webhook-owned and not member-readable under
 * RLS; the query still filters by the membership-validated companyId.
 */
export const GET = withRouteContext('billing.invoices', async (_request, { user, supabase, companyId }) => {
  if (!isStripeConfigured() || user.is_anonymous) {
    return NextResponse.json({ invoices: [] })
  }
  // Sandbox companies never reach external systems (lib/sandbox/guard.ts),
  // like billing/checkout and billing/portal. A sandbox has no receipts, so
  // the answer is the empty list the Kvitton tab already renders.
  if (await isSandboxCompany(supabase, companyId)) {
    return NextResponse.json({ invoices: [] })
  }

  const { data: sub } = await createServiceClient()
    .from('company_subscriptions')
    .select('stripe_customer_id')
    .eq('company_id', companyId)
    .maybeSingle()

  const customerId = (sub as { stripe_customer_id: string | null } | null)?.stripe_customer_id
  if (!customerId) {
    return NextResponse.json({ invoices: [] })
  }

  // Stripe lists newest first. Stripe errors propagate to withRouteContext,
  // which answers with the canonical error envelope.
  const list = await getStripe().invoices.list({ customer: customerId, limit: INVOICE_LIMIT })
  const invoices = list.data
    .filter((inv) => inv.status !== null && SHOWN_STATUSES.has(inv.status))
    .map(toBillingInvoice)

  return NextResponse.json({ invoices })
})
