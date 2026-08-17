/**
 * The Gmail implementation of the core MailSearchService contract.
 *
 * Query-then-classify, never sync: for each purchase we run a provider-side
 * search, pull metadata for the few hits, and let the caller decide. No mailbox
 * is mirrored, no message body is stored, and nothing is written back to the
 * mailbox. That is what keeps this inside Google's Limited Use terms and inside
 * GDPR data minimisation, and it is the promise the consent screen makes.
 */
import { createServiceClientNoCookies } from '@/lib/auth/api-keys'
import { createLogger } from '@/lib/logger'
import type {
  FetchedAttachment,
  MailCandidate,
  MailSearchQuery,
  MailSearchService,
} from '@/lib/mail-search/service'
import { buildGmailQuery, looksLikeReceipt } from './gmail-query'
import {
  clearMessageCache,
  describeAttachment,
  fetchAttachmentBytes,
  getMessageSummary,
  searchMessageIds,
} from './gmail-client'
import {
  getAccessToken,
  listActiveConnections,
  touchSearched,
  type MailConnectionRow,
} from './connections'
import { isGoogleMailConfigured } from './google-oauth'

const log = createLogger('mail-search')

/**
 * Origin used to rebuild the redirect_uri during a token refresh. Google
 * requires the same value the grant was issued against, so it is derived from
 * the deployment's canonical URL rather than a request that may not exist
 * (the hunt runs from a cron, with no browser origin to borrow).
 */
function canonicalOrigin(): string {
  return process.env.NEXT_PUBLIC_APP_URL?.trim() || 'http://localhost:3000'
}

/**
 * How many message summaries to pull at once, per connection.
 *
 * Gmail enforces a per-user concurrency ceiling, not just a daily quota, and
 * answers 429 "Too many concurrent requests for user" well below any volume
 * this app generates. Fanning out over every id at once reliably tripped it and
 * returned an empty search, which is indistinguishable from a mailbox holding
 * nothing. Five is comfortably under the ceiling and still finishes a page of
 * results in a couple of round trips.
 */
const GMAIL_SUMMARY_CONCURRENCY = 5

/** Map with a bounded worker pool, preserving input order. */
async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length)
  let next = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = next++
      if (i >= items.length) return
      out[i] = await fn(items[i])
    }
  })
  await Promise.all(workers)
  return out
}

export class GmailSearchService implements MailSearchService {
  /**
   * Connections whose search threw during the last search() call. A refused
   * mailbox returns no candidates, exactly like an empty one, so without this
   * the run reports "nothing found" about a mailbox it never managed to read.
   */
  private failures = 0

  isConfigured(): boolean {
    return isGoogleMailConfigured()
  }

  /**
   * Messages are cached so one mail is not downloaded once per purchase, and a
   * cached message carries its body. The hunt calls this when it is done, so a
   * body never outlives the run that read it.
   */
  releaseCache(): void {
    clearMessageCache()
  }

  async search(companyId: string, query: MailSearchQuery): Promise<MailCandidate[]> {
    if (!this.isConfigured()) return []

    this.failures = 0
    const supabase = createServiceClientNoCookies()
    const connections = await listActiveConnections(supabase, companyId)
    if (connections.length === 0) return []

    const q = buildGmailQuery(query)

    // Mailboxes are searched in parallel: the work is read-only, so there is
    // nothing to serialise, and one slow account should not delay the rest.
    // The per-message fan-out inside searchOne is throttled, which is where
    // Gmail's per-user concurrency ceiling actually bites.
    const perConnection = await Promise.all(
      connections.map((connection) => this.searchOne(supabase, connection, q, query.limit)),
    )
    return perConnection.flat()
  }

  private async searchOne(
    supabase: ReturnType<typeof createServiceClientNoCookies>,
    connection: MailConnectionRow,
    q: string,
    limit?: number,
  ): Promise<MailCandidate[]> {
    // A dead grant shrinks the hunt rather than aborting it; getAccessToken has
    // already parked it as needs_reconsent for the UI to surface.
    const accessToken = await getAccessToken(supabase, connection, canonicalOrigin())
    if (!accessToken) return []

    try {
      const ids = await searchMessageIds(accessToken, q, limit)
      if (ids.length === 0) return []

      // One request per message, but not all at once. Gmail answers 429
      // "Too many concurrent requests for user" long before any daily quota is
      // near, and a whole search can come back empty because of it. The failure
      // used to look exactly like an empty mailbox, so the honest fix is to
      // stop provoking it rather than to report it more loudly.
      const summaries = await mapWithConcurrency(ids, GMAIL_SUMMARY_CONCURRENCY, (id) =>
        getMessageSummary(accessToken, id, connection.id, connection.email_address),
      )
      await touchSearched(supabase, connection.id)

      // Cheap pre-filter before anything expensive looks at these.
      return summaries.filter((c) => looksLikeReceipt(c.subject, c.from))
    } catch (error) {
      // Never let one mailbox's failure surface as the company's failure: the
      // other mailboxes still have answers. But a refused search is not an
      // empty one, and the caller has to be able to tell them apart, or
      // "hittade inget" gets said about a mailbox nobody managed to read.
      this.failures += 1
      log.warn('gmail search failed for connection', {
        connectionId: connection.id,
        error: error instanceof Error ? error.message : String(error),
      })
      return []
    }
  }

  /** How many connections refused the last search. */
  searchFailureCount(): number {
    return this.failures
  }

  async fetchAttachment(
    connectionId: string,
    messageId: string,
    attachmentId: string,
  ): Promise<FetchedAttachment | null> {
    const supabase = createServiceClientNoCookies()
    const { data } = await supabase
      .from('mail_connections')
      .select(
        'id, company_id, provider, email_address, encrypted_refresh_token, encrypted_access_token, access_token_expires_at, scope_label, status',
      )
      .eq('id', connectionId)
      .maybeSingle()
    if (!data) return null

    const accessToken = await getAccessToken(
      supabase,
      data as MailConnectionRow,
      canonicalOrigin(),
    )
    if (!accessToken) return null

    const [bytes, described] = await Promise.all([
      fetchAttachmentBytes(accessToken, messageId, attachmentId),
      describeAttachment(accessToken, messageId, attachmentId),
    ])
    if (!bytes) return null

    return {
      filename: described?.filename ?? 'underlag.pdf',
      mimeType: described?.mimeType ?? 'application/octet-stream',
      bytes,
    }
  }
}
