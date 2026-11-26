import { isKronorCurrency } from '@/lib/bookkeeping/currency-utils'
import { UNDECRYPTABLE_PERSONAL_NUMBER_MASK } from '@/lib/customers/mask-personal-number'
import { DIGITAL_MAILBOX_PROVIDERS, type DigitalMailboxProviderId } from '@/lib/digital-mailboxes/types'
import { isLegalPersonOrgNumber, normalizeOrgNumber } from '@/lib/invariants/org-number'
import { EMAIL_PATTERN } from '@/lib/invoices/email-recipients'
import { defaultChannelByOrder, type SendOrderWay } from '@/lib/invoices/send-order'
import type { InvoiceDocumentType } from '@/types'

/**
 * How the invoice editor's primary action delivers the document.
 *
 *  - email:  persist, then POST /api/invoices/{id}/send (the invoice email
 *            with the PDF attached).
 *  - manual: persist, then POST /api/invoices/{id}/mark-sent; the archived,
 *            numbered PDF downloads ("Jag skickar själv").
 *  - peppol: e-faktura through the company's access point
 *            (POST /api/invoices/{id}/peppol/send). Listed on a faktura once
 *            the company can send e-fakturor (resolvePeppolChannel); a
 *            company without access never sees it, since a teaser there would
 *            be noise. Listed but not choosable, with the reason, when this
 *            month's sends are used up or the customer has no Peppol id.
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
  /** The Peppol channel (resolvePeppolChannel); null = not listed. */
  peppol: PeppolChannel | null
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

/** Why the Peppol channel is listed but cannot be chosen. */
export type PeppolBlockReason =
  | 'peppol_send_limit' // this month's sends are used up (peppol_access.max_sends)
  | 'peppol_no_participant' // the customer is not a Swedish legal person with an organisationsnummer
  | 'peppol_not_sek' // the e-faktura is SEK only

/** Why a channel cannot be chosen; the editor states it under the label. */
export type ChannelBlockReason = EmailBlockReason | PeppolBlockReason

/** The block reasons as keys of the invoice_editor_shell namespace. */
export const CHANNEL_BLOCK_KEYS: Record<ChannelBlockReason, string> = {
  not_emailable: 'email_block_not_emailable',
  sandbox: 'email_block_sandbox',
  no_email_plan: 'email_block_no_email_plan',
  no_customer_email: 'email_block_no_customer_email',
  peppol_send_limit: 'peppol_block_send_limit',
  peppol_no_participant: 'peppol_block_no_participant',
  peppol_not_sek: 'peppol_block_not_sek',
}

export interface PeppolChannel {
  available: boolean
  reason: PeppolBlockReason | null
}

/**
 * The company's e-faktura sending as the editor reads it
 * (lib/invoices/editor/peppol-sending.ts): null = it cannot send (no access,
 * no transport, or the read failed). remainingSends null = no monthly cap.
 */
export interface PeppolSending {
  remainingSends: number | null
}

export interface PeppolChannelInput {
  sending: PeppolSending | null
  documentType: InvoiceDocumentType
  isCreditNote: boolean
  currency: string | null | undefined
  customer: Pick<MailboxCustomerFacts, 'customer_type' | 'org_number'> | null | undefined
}

/**
 * The buyer's Peppol id is 0007 plus the organisationsnummer, so the
 * customer must be a Swedish business whose number is a legal person's. The
 * generator refuses anything else (lib/invoices/peppol-bis-billing.ts:
 * BUYER_TYPE_UNSUPPORTED, BUYER_ORG_NUMBER_INVALID,
 * BUYER_PARTICIPANT_IDENTIFIER_UNSUPPORTED).
 */
export function peppolRecipientIdentifiable(
  customer: Pick<MailboxCustomerFacts, 'customer_type' | 'org_number'> | null | undefined,
): boolean {
  if (customer?.customer_type !== 'swedish_business') return false
  const orgNumber = normalizeOrgNumber(customer.org_number)
  return orgNumber !== null && isLegalPersonOrgNumber(orgNumber)
}

/**
 * Whether the editor lists Peppol, and whether it can be chosen. Listed on a
 * plain faktura (the e-faktura send refuses kreditfakturor and the other
 * document types) once the company can send; choosable when sends are left,
 * the customer has a Peppol id and the invoice is in SEK. The send route
 * checks every rule again, and the recipient's registration, before
 * anything is issued.
 */
export function resolvePeppolChannel(input: PeppolChannelInput): PeppolChannel | null {
  if (!input.sending || input.documentType !== 'invoice' || input.isCreditNote) return null
  if (input.sending.remainingSends !== null && input.sending.remainingSends <= 0) {
    return { available: false, reason: 'peppol_send_limit' }
  }
  if (!peppolRecipientIdentifiable(input.customer)) return { available: false, reason: 'peppol_no_participant' }
  if (!isKronorCurrency(input.currency)) return { available: false, reason: 'peppol_not_sek' }
  return { available: true, reason: null }
}

export interface ChannelOption {
  channel: EditorChannel
  available: boolean
  reason: ChannelBlockReason | null
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
  if (ctx.peppol && ctx.documentType === 'invoice') {
    options.push({ channel: 'peppol', available: ctx.peppol.available, reason: ctx.peppol.reason })
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
 * available (a customer switch can take email away), else the default. With
 * a saved send order (company_settings.invoice_send_order) the default is
 * the first way in it that is listed and choosable, else the default below;
 * without one it is resolveDefaultChannel, unchanged.
 */
export function resolveEffectiveChannel(
  choice: EditorChannel | null,
  ctx: ChannelContext,
  sendOrder?: readonly SendOrderWay[] | null,
): EditorChannel {
  const options = resolveChannelOptions(ctx)
  if (choice) {
    const option = options.find((o) => o.channel === choice)
    if (option?.available) return choice
  }
  const fallback = resolveDefaultChannel(ctx)
  return sendOrder ? defaultChannelByOrder(options, sendOrder, fallback) : fallback
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
): ChannelBlockReason | Exclude<EditorChannel, 'email'> | null {
  if (channel === 'email') return null
  return options.find((option) => option.channel === 'email')?.reason ?? channel
}
