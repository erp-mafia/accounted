/**
 * The payment signing link through the machine doors: an agent or an API
 * client that prepared bank payments, and had a person approve them, asks
 * someone without an Accounted login (the company's firmatecknare) to sign
 * the basket with BankID. The rules live in
 * lib/payments/orders/signing-links.ts; the dashboard's
 * POST /api/payments/signing-links calls the same function.
 *
 * Agents prepare and request; a person still signs: the link opens a page
 * where the firmatecknare's own BankID, at their own bank, is the signature.
 * The MCP tool stages (pending type request_payment_signature): the URL is a
 * credential, minted at approval only, and the approval answers it.
 */
import { z } from 'zod'
import {
  issuePaymentSigningLink,
  PAYMENT_SIGNING_LINK_TTL_HOURS,
  previewPaymentSigningLink,
  SIGNING_LINK_NOTE_MAX,
} from '@/lib/payments/orders/signing-links'
import { defineOperation } from './types'

const META = { request_id: 'req_…', api_version: '2026-05-12' }

export const paymentSigningLinksCreate = defineOperation({
  id: 'payment-signing-links.create',
  kind: 'write',
  scope: 'suppliers:write',
  risk: 'medium',
  reversible: false,
  docs: {
    summary: 'Ask someone without an Accounted login to sign approved bank payments with BankID: a signing link.',
    description:
      `Creates a link, valid ${PAYMENT_SIGNING_LINK_TTL_HOURS} hours, to a page at /betala/<token> where the company's firmatecknare sees the ` +
      'basket (payee, amount, date and reference per payment, the account paying, who asked, the note) and signs it with BankID ' +
      'at their bank, without logging in to Accounted. The orders must be approved, from one account and in one currency; if any ' +
      'of them leaves approved before the signing (cancelled, signed or un-approved elsewhere) the page says so and signs nothing. ' +
      'The link is consumed when the signing finalises. With recipient_email it is mailed (template payment_signing_request); the ' +
      'url is answered either way. Owners and admins, or the person who prepared every order. Dry-runnable: ?dry_run=true answers ' +
      'the basket and mints nothing.',
    useWhen:
      'A byrå or an agent prepared supplier payments and a person approved them, but the client\'s firmatecknare signs at the bank.',
    doNotUseFor: 'Signing in person (the Betalningar page), approving drafts (POST /payment-orders/approve) or payment files.',
    pitfalls: [
      'The url carries the credential: hand it to the signer only, once, and do not store it.',
      'PAYMENT_ORDERS_WRONG_STATUS: an order is not approved (details.orders); approve it first.',
      'PAYMENT_SIGNING_LINK_ALREADY_OPEN: another open link covers an order (details.signing_link_ids); it is cancelled on the Betalningar page.',
      'PAYMENT_ORDERS_MIXED_ACCOUNTS / PAYMENT_ORDERS_MIXED_CURRENCY: one link is one signing, from one account in one currency.',
    ],
    example: {
      request: { payment_order_ids: ['7c2e…'], recipient_email: 'anna@example.se', note: 'Leverantörsbetalningar för oktober.' },
      response: {
        data: {
          signing_link_id: '5d1a…',
          url: 'https://app.accounted.se/betala/…',
          expires_at: '2026-10-17T09:00:00.000Z',
          email_sent: true,
          order_count: 1,
          total_amount: 737.5,
          currency: 'SEK',
        },
        meta: META,
      },
    },
  },
  input: z.object({
    payment_order_ids: z
      .array(z.string().uuid())
      .min(1)
      .max(100)
      .describe('Approved payment orders (payment_order_id), 1-100, from one account in one currency.'),
    recipient_email: z.string().email().max(254).nullish().describe('Mail the link to the signer; omit to only get the url.'),
    note: z.string().max(SIGNING_LINK_NOTE_MAX).nullish().describe('A message to the signer, shown on the page and in the mail.'),
  }),
  output: z.object({
    signing_link_id: z.string().uuid(),
    url: z.string().describe('The signing page; the credential itself. Hand it to the signer only.'),
    expires_at: z.string(),
    email_sent: z.boolean(),
    order_count: z.number().int(),
    total_amount: z.number(),
    currency: z.string(),
  }),
  errorCodes: [
    'PAYMENTS_UNAVAILABLE',
    'PAYMENT_ORDERS_EMPTY_SELECTION',
    'PAYMENT_ORDER_NOT_FOUND',
    'PAYMENT_ORDERS_WRONG_STATUS',
    'PAYMENT_ORDERS_MIXED_ACCOUNTS',
    'PAYMENT_ORDERS_MIXED_CURRENCY',
    'PAYMENT_SIGNING_LINK_ALREADY_OPEN',
    'FORBIDDEN',
  ],
  http: { method: 'POST', path: '/api/v1/companies/:companyId/payments/signing-links' },
  mcp: {
    name: 'gnubok_request_payment_signature',
    title: 'Request Payment Signature',
    description:
      `Stage a signing link for approved bank payments: a ${PAYMENT_SIGNING_LINK_TTL_HOURS}-hour /betala page where the firmatecknare signs the ` +
      'basket with BankID without an Accounted login, optionally mailed. The approval answers data.url. Agents request; a person signs.',
    visibility: 'search',
    keywords: ['be någon annan signera', 'signeringslänk', 'firmatecknare signera', 'skicka betalningar för signering', 'bankid betalning', 'signera betalningar', 'länk betalning'],
    stage: {
      pendingType: 'request_payment_signature',
      title: (input) => {
        const count = Array.isArray(input.payment_order_ids) ? input.payment_order_ids.length : 0
        const recipient = typeof input.recipient_email === 'string' && input.recipient_email.trim() ? ` (${input.recipient_email.trim()})` : ''
        return `Be någon annan signera: ${count} ${count === 1 ? 'bankbetalning' : 'bankbetalningar'}${recipient}`
      },
      extras: () => ({
        next: {
          description:
            `After approval the answer's data.url is the signing link, valid ${PAYMENT_SIGNING_LINK_TTL_HOURS} hours: hand it to the signer only. ` +
            'When a person approves in Accounted instead, read result_data.url from gnubok_list_pending_operations.',
          tool: 'gnubok_approve_pending_operation',
        },
      }),
    },
  },
  run: async (ctx, input, { dryRun }) => {
    const link = { orderIds: input.payment_order_ids, recipientEmail: input.recipient_email ?? null, note: input.note ?? null }
    // A dry run (the MCP staging preview, ?dry_run=true) runs every rule the
    // mint runs and mints nothing: the URL is the credential.
    if (dryRun) return previewPaymentSigningLink(ctx, link)
    return issuePaymentSigningLink(ctx, link)
  },
})

export const PAYMENT_SIGNING_LINK_OPERATIONS = [paymentSigningLinksCreate] as const
