/**
 * Mail Search Service Interface
 *
 * Core defines the contract; the `mail` extension registers a real
 * implementation (Gmail today, Microsoft Graph next). Without the extension a
 * no-op service is used, so the receipt hunt degrades to matching whatever the
 * company already holds in Underlag rather than failing.
 *
 * Mirrors lib/email/service.ts: core must never import from @/extensions, and
 * a CI build with zero extensions has to compile.
 */

/** What the hunt knows about the purchase it is trying to find a receipt for. */
export interface MailSearchQuery {
  /** Merchant tokens, already folded (see core-receipt-matcher). */
  merchant: string | null
  /** Charged amount, always positive. */
  amount: number
  currency: string
  /** Purchase date, ISO. The window around it is the adapter's business. */
  date: string
}

/**
 * A message that might carry the receipt. Nothing is stored at this point: the
 * hunt decides, and only a confirmed receipt is ever persisted.
 */
export interface MailCandidate {
  connectionId: string
  /** Mailbox the hit came from, so a proposal can say where it looked. */
  mailbox: string
  provider: 'gmail' | 'microsoft'
  messageId: string
  subject: string | null
  from: string | null
  receivedAt: string | null
  /** Attachment ids on the message, resolvable through fetchAttachment. */
  attachmentIds: string[]
  /**
   * True when the message body IS the receipt (SL, Uber-style HTML mail) and
   * there is no attachment to fetch. The caller renders it instead.
   */
  bodyIsReceipt: boolean
}

export interface FetchedAttachment {
  filename: string
  mimeType: string
  bytes: Buffer
}

export interface MailSearchService {
  /**
   * Search every healthy connection for one company. Read-only: the scopes
   * requested cannot send, modify or delete, and nothing is written to the
   * mailbox.
   */
  search(companyId: string, query: MailSearchQuery): Promise<MailCandidate[]>
  fetchAttachment(
    connectionId: string,
    messageId: string,
    attachmentId: string,
  ): Promise<FetchedAttachment | null>
  /** True when at least one provider has credentials configured. */
  isConfigured(): boolean
}

class NoopMailSearchService implements MailSearchService {
  async search(): Promise<MailCandidate[]> {
    return []
  }
  async fetchAttachment(): Promise<FetchedAttachment | null> {
    return null
  }
  isConfigured(): boolean {
    return false
  }
}

let mailSearchService: MailSearchService = new NoopMailSearchService()

export function getMailSearchService(): MailSearchService {
  return mailSearchService
}

export function registerMailSearchService(svc: MailSearchService): void {
  mailSearchService = svc
}
