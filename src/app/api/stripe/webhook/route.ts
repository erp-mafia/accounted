import { NextResponse } from 'next/server'
import type Stripe from 'stripe'
import { getStripe } from '@/lib/stripe/client'
import { createServiceClient } from '@/lib/supabase/server'
import { handleStripeEvent } from '@/lib/stripe/subscription-sync'

// Unauthenticated by design: authenticity comes from the Stripe signature, not
// a session. The route reads the RAW body (req.text()); parsing as JSON first
// would change the byte representation and break signature verification.
export async function POST(request: Request) {
  const secret = process.env.STRIPE_WEBHOOK_SECRET
  if (!secret) {
    return NextResponse.json({ error: 'Webhook not configured' }, { status: 500 })
  }

  const sig = request.headers.get('stripe-signature')
  if (!sig) {
    return NextResponse.json({ error: 'Missing signature' }, { status: 400 })
  }

  const rawBody = await request.text()
  let event: Stripe.Event
  try {
    event = getStripe().webhooks.constructEvent(rawBody, sig, secret)
  } catch {
    return NextResponse.json({ error: 'Invalid signature' }, { status: 400 })
  }

  const service = createServiceClient()

  // Idempotency: skip events we've already fully processed. The handler itself
  // is idempotent too (upserts), so a concurrent double-delivery is also safe.
  const { data: already } = await service
    .from('stripe_webhook_events')
    .select('event_id')
    .eq('event_id', event.id)
    .maybeSingle()
  if (already) {
    return NextResponse.json({ received: true, duplicate: true })
  }

  try {
    // Throws when the state could not be written (crm#1736), so the event is
    // not marked processed and the 500 below has Stripe deliver it again.
    await handleStripeEvent(service, getStripe(), event)
    // Mark processed only AFTER success, so a failure lets Stripe retry.
    const { error: markError } = await service
      .from('stripe_webhook_events')
      .insert({ event_id: event.id, type: event.type })
    // A unique violation is a concurrent delivery of the same event that
    // recorded it first. Any other failure answers 500 as well: the state
    // above is applied, and applying it again on the redelivery changes nothing.
    if (markError && markError.code !== '23505') {
      throw new Error(`stripe_webhook_events write failed: ${markError.message}`)
    }
  } catch (err) {
    // Log with context before the generic 500 so a failing webhook is visible
    // to operators (Stripe will retry on the non-2xx).
    console.error('[stripe-webhook] processing failed', {
      eventId: event.id,
      type: event.type,
      error: err instanceof Error ? err.message : String(err),
    })
    return NextResponse.json({ error: 'processing_failed' }, { status: 500 })
  }

  return NextResponse.json({ received: true })
}
