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
  /**
   * Merchant names likely to appear in the receipt itself, best first. Searched
   * in place of the raw descriptor when present: the bank writes
   * "ANTHROPIC* CLAUDE SUB", the receipt says "Anthropic".
   */
  aliases?: string[]
  /**
   * Set false to search the whole mailbox regardless of date.
   *
   * A forwarded receipt is stamped when it was forwarded, which can be months
   * after the purchase, so a window around the purchase date hides exactly the
   * mail being looked for. Measured on a real mailbox: the same merchant search
   * returned 0 hits inside the window and 10+ outside it.
   */
  useDateWindow?: boolean
  /** Only return messages carrying a file. */
  requireAttachment?: boolean
  /** Hits to return per mailbox. */
  limit?: number
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
   * Attachment filenames and the provider's own preview line. Metadata only,
   * never stored: they are what lets the hunt tell a receipt from a newsletter
   * that merely names the merchant, without opening anyone's mail.
   */
  attachmentNames?: string[]
  snippet?: string | null
  /**
   * Readable body text, already downloaded. A forwarded receipt writes the
   * original sender and the original purchase date into its quoted header,
   * which is the only reliable way to date a mail that was forwarded months
   * later. Never stored: it is read once to extract fields and discarded.
   */
  bodyText?: string | null
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

/**
 * Mailbox grants one person connected, read before their account is erased
 * and revoked at the provider only once the erasure has succeeded.
 */
export interface PreparedGrantRevocation {
  /** How many grants were read. */
  count: number
  /** Ask the provider to revoke them. Best effort: never throws. */
  revoke(): Promise<void>
}

export interface MailSearchService {
  /**
   * Search every healthy connection for one company. Read-only: the scopes
   * requested cannot send, modify or delete, and nothing is written to the
   * mailbox.
   */
  search(companyId: string, query: MailSearchQuery): Promise<MailCandidate[]>
  /**
   * Download one attachment through a connection of `companyId`. The company
   * is part of the lookup, so a connection id can never reach another
   * company's mailbox.
   */
  fetchAttachment(
    companyId: string,
    connectionId: string,
    messageId: string,
    attachmentId: string,
  ): Promise<FetchedAttachment | null>
  /** True when at least one provider has credentials configured. */
  isConfigured(): boolean
  /**
   * Drop anything the adapter held for the duration of a hunt.
   *
   * Adapters cache messages so one mail is not downloaded once per purchase,
   * and a cached message carries its body. Body text is read to extract fields
   * and must not outlive the run that read it, so the caller says when that is.
   */
  releaseCache?(): void
  /**
   * How many connections refused the last search.
   *
   * A refused mailbox yields no candidates, exactly like an empty one. Without
   * a way to tell them apart, a run that Gmail rate-limited reports "found
   * nothing" and the caller stops looking, which is the worst possible answer:
   * it is wrong, and it sounds final.
   */
  searchFailureCount?(): number
  /**
   * Account erasure: read the grants `userId` connected, in every company,
   * while their tokens still exist.
   *
   * The erasure RPC shreds the stored tokens, which ends our copy but leaves
   * each grant live at the provider, and afterwards nothing is left to revoke
   * it with. So the caller reads first and calls revoke() only after the
   * erasure succeeded; a refused erasure (the person still owns companies)
   * must revoke nothing, and the prepared value is simply dropped.
   */
  prepareGrantRevocation?(userId: string): Promise<PreparedGrantRevocation | null>
  /**
   * A company was archived: end every mailbox grant it holds, each exactly as
   * a disconnect by `userId` would (revoked at the provider unless another
   * company still reads that mailbox, row deleted, audited). An archived
   * company is hidden from its members, so nobody could disconnect them
   * afterwards. Best effort per mailbox: one failure never stops the rest.
   */
  endCompanyGrants?(companyId: string, userId: string): Promise<{ ended: number; failed: number }>
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
  releaseCache(): void {}
}

let mailSearchService: MailSearchService = new NoopMailSearchService()

export function getMailSearchService(): MailSearchService {
  return mailSearchService
}

export function registerMailSearchService(svc: MailSearchService): void {
  mailSearchService = svc
}
