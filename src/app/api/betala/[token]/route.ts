import { NextResponse } from 'next/server'
import { withSigningLinkToken } from '@/lib/payments/orders/signing-link-route'
import { describePaymentSigningLink } from '@/lib/payments/orders/signing-links'

/**
 * GET /api/betala/:token: the basket of a payment signing link, for the page
 * a firmatecknare opens without a login: who asked and for which company,
 * the note, each payment (payee, account, amount, date, reference, status),
 * the bank and account paying, the total, where the link's signing stands
 * and the state (ready, in_signing, done, changed). Answers for a short
 * while after the signing consumed the link, so the last screen can reload.
 */
export const GET = withSigningLinkToken<{ token: string }>('payment_signing_link.read', { stage: 'follow_up' }, async (_request, { link, service }) => {
  return NextResponse.json({ data: await describePaymentSigningLink(service, link) })
})
