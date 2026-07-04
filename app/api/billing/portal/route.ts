import { NextResponse } from 'next/server'
import { requireAuth } from '@/lib/auth/require-auth'
import { requireCompanyId } from '@/lib/company/context'
import { createServiceClient } from '@/lib/supabase/server'
import { getStripe } from '@/lib/stripe/client'

/**
 * Create a Stripe Billing Customer Portal session so the user can manage,
 * upgrade/downgrade, or cancel their subscription. Stripe handles all the
 * compliance/PCI surface: we never build those flows ourselves.
 */
export async function POST() {
  const { user, supabase, error } = await requireAuth()
  if (error) return error

  let companyId: string
  try {
    companyId = await requireCompanyId(supabase, user.id)
  } catch {
    return NextResponse.json({ error: 'No company context' }, { status: 400 })
  }

  const service = createServiceClient()
  const { data: sub } = await service
    .from('company_subscriptions')
    .select('stripe_customer_id')
    .eq('company_id', companyId)
    .maybeSingle()

  const customerId = (sub as { stripe_customer_id: string | null } | null)?.stripe_customer_id
  if (!customerId) {
    return NextResponse.json({ error: 'No subscription to manage' }, { status: 400 })
  }

  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? ''
  const portal = await getStripe().billingPortal.sessions.create({
    customer: customerId,
    return_url: `${appUrl}/settings/billing`,
  })

  return NextResponse.json({ url: portal.url })
}
