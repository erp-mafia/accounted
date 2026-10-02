import { EMAIL_PATTERN } from '@/lib/invoices/email-recipients'
import type { InvoiceDocumentType } from '@/types'

/**
 * How the invoice editor's primary action delivers the document.
 *
 *  - email:  persist, then POST /api/invoices/{id}/send (the invoice email
 *            with the PDF attached).
 *  - manual: persist, then POST /api/invoices/{id}/mark-sent; the archived,
 *            numbered PDF downloads ("Jag skickar själv").
 *  - peppol: e-faktura through the company's access point. Listed only when
 *            it can actually be used (company access AND a customer
 *            participant id): with no sends ever, a disabled teaser would be
 *            noise.
 */
export type EditorChannel = 'email' | 'manual' | 'peppol'

/** Why the email channel cannot be chosen; the editor states it in Swedish. */
export type EmailBlockReason =
  | 'not_emailable' // följesedel: never emailed, only marked sent
  | 'sandbox' // email sending is off in the sandbox
  | 'no_email_plan' // the plan lacks the email_send capability
  | 'no_customer_email' // the picked customer has no usable address

export interface ChannelContext {
  documentType: InvoiceDocumentType
  /** The email_send capability (plan). */
  canEmail: boolean
  isSandbox: boolean
  /** Null while no customer is picked: email stays the expected channel. */
  customerEmail: string | null | undefined
  customerSelected: boolean
  /** The company has Peppol send access AND the customer a participant id. */
  peppolReady: boolean
}

export interface ChannelOption {
  channel: EditorChannel
  available: boolean
  reason: EmailBlockReason | null
}

/**
 * Null when the document can go out by email. Before a customer is picked the
 * customer half is not judged yet: the label should read "Skicka" from the
 * first keystroke for the common case instead of flipping once a customer is
 * chosen; a customer without an address then moves it to "Markera som
 * skickad".
 */
export function emailBlockReason(ctx: ChannelContext): EmailBlockReason | null {
  if (ctx.documentType === 'delivery_note') return 'not_emailable'
  if (ctx.isSandbox) return 'sandbox'
  if (!ctx.canEmail) return 'no_email_plan'
  if (!ctx.customerSelected) return null
  const email = ctx.customerEmail?.trim()
  if (!email || !EMAIL_PATTERN.test(email)) return 'no_customer_email'
  return null
}

/** The channels the caret menu lists, in menu order. */
export function resolveChannelOptions(ctx: ChannelContext): ChannelOption[] {
  const emailReason = emailBlockReason(ctx)
  const options: ChannelOption[] = [
    { channel: 'email', available: emailReason === null, reason: emailReason },
    { channel: 'manual', available: true, reason: null },
  ]
  if (ctx.peppolReady && ctx.documentType === 'invoice') {
    options.push({ channel: 'peppol', available: true, reason: null })
  }
  return options
}

/** Email when the plan, the environment and the customer allow it, else manual. */
export function resolveDefaultChannel(ctx: ChannelContext): EditorChannel {
  return emailBlockReason(ctx) === null ? 'email' : 'manual'
}

/**
 * The channel the primary acts on: the user's own pick while it is still
 * available (a customer switch can take email away), else the default.
 */
export function resolveEffectiveChannel(
  choice: EditorChannel | null,
  ctx: ChannelContext,
): EditorChannel {
  if (choice) {
    const option = resolveChannelOptions(ctx).find((o) => o.channel === choice)
    if (option?.available) return choice
  }
  return resolveDefaultChannel(ctx)
}
