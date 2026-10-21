/**
 * Digital mailboxes (Kivra, Billo): the one shape both providers are read
 * and written through, so the Inkorg sync, the invoice send and the payslip
 * send never branch on the provider. Provider specifics live in kivra.ts
 * and billo.ts; references in docs/integrations/{kivra,billo}.md.
 */

export const DIGITAL_MAILBOX_PROVIDERS = ['kivra', 'billo'] as const
export type DigitalMailboxProviderId = (typeof DIGITAL_MAILBOX_PROVIDERS)[number]

export function isDigitalMailboxProvider(value: unknown): value is DigitalMailboxProviderId {
  return typeof value === 'string' && (DIGITAL_MAILBOX_PROVIDERS as readonly string[]).includes(value)
}

// ---------------------------------------------------------------------------
// Receiving: the company's own mailbox
// ---------------------------------------------------------------------------

/** Where the company's mailbox is at the provider. */
export interface ReceiveAccount {
  /** Kivra: company_key. Billo: partnerCustomerId. */
  accountRef: string
  /** Billo: enrollmentId. Null for Kivra. */
  mailboxRef: string | null
}

/** A document in the listing: enough to decide whether it is new. */
export interface MailboxDocumentSummary {
  /** The provider's id for the document (Kivra content_key, Billo documentId). */
  ref: string
  /** When the mailbox received it (ISO), null when the provider does not say. */
  receivedAt: string | null
}

export type MailboxDocumentKind = 'invoice' | 'receipt' | 'letter' | 'other'

/** One document with what the provider says about it. */
export interface MailboxDocument {
  ref: string
  receivedAt: string | null
  subject: string | null
  senderName: string | null
  /** The sender's organisationsnummer, ten digits, when the provider knows it. */
  senderOrgNumber: string | null
  kind: MailboxDocumentKind
  /**
   * The provider's own metadata (payment options, invoice fields), kept with
   * the arrival as hints. Never file bodies.
   */
  meta: Record<string, unknown>
}

export interface MailboxFile {
  name: string
  contentType: string
  bytes: ArrayBuffer
}

export interface MailboxReceiver {
  /** Documents received at or after `since` (all of them when null), newest first or in any order. */
  listDocuments(account: ReceiveAccount, since: Date | null): Promise<MailboxDocumentSummary[]>
  /** The document's metadata and its files (PDF and image parts only, in the provider's order). */
  getDocument(account: ReceiveAccount, ref: string): Promise<{ document: MailboxDocument; files: MailboxFile[] }>
}

// ---------------------------------------------------------------------------
// Sending: the company as a sender to recipients' mailboxes
// ---------------------------------------------------------------------------

export type MailboxRecipient =
  | { kind: 'company'; orgNumber: string }
  | { kind: 'person'; personnummer: string }

export interface OutgoingPdf {
  name: string
  bytes: Uint8Array
}

/** How the recipient pays: shown in the mailbox so nobody re-types the OCR. */
export interface OutgoingPayment {
  /** Amount due in SEK, two decimals. */
  amount: number
  /** YYYY-MM-DD. */
  dueDate: string
  /** 'bankgiro' or 'plusgiro', the account the reference is for. */
  method: 'bankgiro' | 'plusgiro'
  account: string
  /** OCR when the invoice prints one, otherwise the invoice number as a free reference. */
  reference: string
  referenceType: 'ocr' | 'invoice_number'
}

export interface OutgoingInvoice {
  subject: string
  /** YYYY-MM-DD the document was issued. */
  generatedAt: string
  invoiceNumber: string
  pdf: OutgoingPdf
  /** Null when the invoice carries no Swedish giro to pay to: sent as a document. */
  payment: OutgoingPayment | null
}

/** The employer as the payslip names it, with the contact details from the company settings. */
export interface PayslipEmployer {
  name: string
  orgNumber: string
  streetAddress: string | null
  postalCode: string | null
  city: string | null
  /** ISO 3166-1 alpha-2, as company_settings stores it. */
  country: string | null
  email: string | null
  phone: string | null
}

/** A payslip's figures, for a provider that shows the payslip as data next to its PDF (Kivra salaryslip). */
export interface PayslipStatement {
  employer: PayslipEmployer
  /** YYYY-MM-DD: the pay month's first and last day. */
  periodStart: string
  periodEnd: string
  /** YYYY-MM-DD. */
  payoutDate: string
  /** Amounts in SEK. */
  grossPay: number
  taxDeducted: number
  netPay: number
  yearToDateGrossPay: number
  yearToDateTax: number
}

export interface OutgoingPayslip {
  subject: string
  generatedAt: string
  pdf: OutgoingPdf
  statement: PayslipStatement
  /** For a provider that reaches non-users by a link (Billo SendEasy). */
  firstName: string
  lastName: string
  email: string | null
  phone: string | null
}

export interface SendReceipt {
  /** The provider's id for what it received, when it answered one. */
  providerRef: string | null
}

export interface MailboxSender {
  /**
   * The company's sender identity (tenant), created or found by its
   * organisationsnummer. Idempotent: the same company answers the same key.
   */
  registerSender(company: { orgNumber: string; name: string }): Promise<{ tenantRef: string }>
  /** Whether the recipient has a mailbox this sender may deliver to. */
  isReachable(tenantRef: string, recipient: MailboxRecipient): Promise<boolean>
  sendInvoice(tenantRef: string, recipient: MailboxRecipient, invoice: OutgoingInvoice): Promise<SendReceipt>
  sendPayslip(tenantRef: string, personnummer: string, payslip: OutgoingPayslip): Promise<SendReceipt>
  /**
   * Whether a payslip reaches a person without a mailbox at this provider
   * (Billo SendEasy sends a BankID-protected link by email or SMS).
   */
  readonly payslipReachesNonUsers: boolean
  /**
   * Whether a payslip carries the employer's address, email and phone
   * (Kivra's salaryslip requires them), so the send refuses up front while
   * the company settings lack one.
   */
  readonly payslipNeedsEmployerContact: boolean
}

export interface DigitalMailboxProvider {
  readonly id: DigitalMailboxProviderId
  /** Null when this deployment holds no receiving credentials. */
  readonly receiver: MailboxReceiver | null
  /** Null when this deployment holds no sending credentials. */
  readonly sender: MailboxSender | null
}
