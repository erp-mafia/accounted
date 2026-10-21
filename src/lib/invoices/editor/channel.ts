import { isKronorCurrency } from '@/lib/bookkeeping/currency-utils'
import { UNDECRYPTABLE_PERSONAL_NUMBER_MASK } from '@/lib/customers/mask-personal-number'
import { DIGITAL_MAILBOX_PROVIDERS, type DigitalMailboxProviderId } from '@/lib/digital-mailboxes/types'
import { normalizeOrgNumber } from '@/lib/invariants/org-number'
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
 *  - kivra, billo: the customer's digital mailbox
 *            (POST /api/invoices/{id}/digital-mailbox/send). Listed, like
 *            Peppol, only when it can be used: the company sends through the
 *            provider and the invoice and its customer qualify
 *            (resolveMailboxReady). Whether the customer has a mailbox there
 *            is the provider's answer at send, before anything is issued.
 */
export type MailboxChannel = DigitalMailboxProviderId
export type EditorChannel = 'email' | 'manual' | 'peppol' | MailboxChannel

export function isMailboxChannel(channel: EditorChannel): channel is MailboxChannel {
  return (DIGITAL_MAILBOX_PROVIDERS as readonly string[]).includes(channel)
}

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
  /** Per provider: the invoice can go to the customer's mailbox there (resolveMailboxReady). */
  mailboxReady: Record<MailboxChannel, boolean>
}

/** No mailbox channel: a credit note, a document before the status is read. */
export const NO_MAILBOX_READY: Record<MailboxChannel, boolean> = { kivra: false, billo: false }

/** What the editor knows about the picked customer, as the mailbox address needs it. */
export interface MailboxCustomerFacts {
  customer_type?: string | null
  org_number?: string | null
  /**
   * The kundkort's personnummer as the browser holds it: ciphertext or the
   * masked display form, never the number. Presence is enough; the server
   * reads the number itself.
   */
  personal_number?: string | null
}

/**
 * Whether the invoice can be addressed to a mailbox: a Swedish company (or
 * a sole trader) by a valid organisationsnummer, a private person by a
 * personnummer on file. The same split the send makes
 * (lib/invoices/digital-mailbox-send.ts invoiceMailboxRecipient); the
 * undecryptable placeholder is no number.
 */
export function mailboxRecipientIdentifiable(customer: MailboxCustomerFacts | null | undefined): boolean {
  if (!customer) return false
  if (customer.customer_type === 'swedish_business') return normalizeOrgNumber(customer.org_number) !== null
  if (customer.customer_type === 'individual') {
    const stored = customer.personal_number?.trim()
    return Boolean(stored) && stored !== UNDECRYPTABLE_PERSONAL_NUMBER_MASK
  }
  return false
}

export interface MailboxReadyInput {
  /** Providers the company sends through (lib/digital-mailboxes/sending-status.ts). */
  activeProviders: readonly MailboxChannel[]
  documentType: InvoiceDocumentType
  isCreditNote: boolean
  /** The invoice currency; the mailboxes take kronor only. */
  currency: string | null | undefined
  customer: MailboxCustomerFacts | null | undefined
}

/**
 * Per provider, whether the editor offers it: sending is active there, the
 * document is a plain faktura (not a kreditfaktura, quote, proforma or
 * följesedel), in kronor, to a customer the mailbox can be addressed to.
 */
export function resolveMailboxReady(input: MailboxReadyInput): Record<MailboxChannel, boolean> {
  const qualifies =
    input.documentType === 'invoice' &&
    !input.isCreditNote &&
    isKronorCurrency(input.currency) &&
    mailboxRecipientIdentifiable(input.customer)
  return {
    kivra: qualifies && input.activeProviders.includes('kivra'),
    billo: qualifies && input.activeProviders.includes('billo'),
  }
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
  if (ctx.documentType === 'invoice') {
    for (const provider of DIGITAL_MAILBOX_PROVIDERS) {
      if (ctx.mailboxReady[provider]) options.push({ channel: provider, available: true, reason: null })
    }
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

/**
 * Why the Mejl tab is off, or null when the email goes out. Email cannot be
 * sent (följesedel, sandbox, plan, a customer without an address): that
 * reason. It can, but the user picked another channel ("Jag skickar själv",
 * Peppol, Kivra, Billo): that channel, since no email goes out with it either.
 */
export function emailPreviewBlock(
  channel: EditorChannel,
  options: readonly ChannelOption[],
): EmailBlockReason | Exclude<EditorChannel, 'email'> | null {
  if (channel === 'email') return null
  return options.find((option) => option.channel === 'email')?.reason ?? channel
}
