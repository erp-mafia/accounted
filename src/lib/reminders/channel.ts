/**
 * The reminder channel port: how a reminder reaches the customer.
 *
 * v1 has one channel, email, over the installation's EmailService (Resend or
 * SMTP, chosen by the email extension), so no reminder code knows the mail
 * provider: a new provider is a new EmailService plus a delivery-report
 * parser (lib/email/delivery-reports.ts). Kivra or post would be further
 * channels of this same shape. A deterministic fake stands in for tests and
 * the sandbox (channels/fake.ts).
 */

export interface ReminderMessage {
  companyId: string
  to: string[]
  cc: string[]
  bcc: string[]
  /** Where the customer's answer goes (resolveInvoiceReplyTo); none means no "reply to this mail" line. */
  replyTo?: string
  /** Display name on the platform sender. */
  fromName: string
  /** The brand's verified address (getSenderForCompany); the platform address when absent. */
  fromAddress?: string
  /** The company's own verified sender (resolveInvoiceSender); platform sender when absent. */
  from?: { name: string; address: string }
  subject: string
  html: string
  text: string
  /** The invoice PDF as the customer was first emailed it, when there is one. */
  attachments?: Array<{ filename: string; content: Buffer; contentType: string }>
}

export interface ReminderReceipt {
  /** Who took the message ('resend', 'smtp', 'fake'): with the id it finds the reminder again on a delivery report. */
  provider: string
  providerMessageId: string | null
}

export interface ReminderChannel {
  readonly kind: 'email'
  /** Resolves once the provider took the message; throws ReminderChannelError when it did not. */
  send(message: ReminderMessage): Promise<ReminderReceipt>
}

export class ReminderChannelError extends Error {
  readonly code: string
  /**
   * The provider may have sent it anyway (a timeout, a dropped connection).
   * The reminder is recorded as failed either way and the ladder stops for a
   * person to look: sending it again could remind the customer twice.
   */
  readonly outcomeUnknown: boolean

  constructor(code: string, options: { outcomeUnknown: boolean; detail?: string; cause?: unknown }) {
    super(options.detail ? `${code}: ${options.detail}` : code, options.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'ReminderChannelError'
    this.code = code
    this.outcomeUnknown = options.outcomeUnknown
  }
}
