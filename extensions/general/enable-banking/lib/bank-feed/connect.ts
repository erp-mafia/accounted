import { bankSyncResponseSchema, connectorErrorSchema } from '@accounted/connect-contract'
import type { BankFeedAdapter, BankFeedSyncInput, BankFeedSyncResult } from '@/lib/bank-feed/port'
import { CONNECT_BANK_FEED_PROVIDER } from '@/lib/bank-feed/registry'
import { bankConnectorMode, CONNECTOR_COMPANY_HEADER } from '@/lib/connect/instance/upstreams'
import { ConnectorSyncError, SessionExpiredError } from '../api-client'

const CONNECTOR_SYNC_TIMEOUT_MS = 120_000

/**
 * Bank feed adapter over Accounted Connect's sync operation
 * (POST /api/connect/bank/sync, wire contract in @accounted/connect-contract).
 *
 * The session id is the installation's own and travels per call; the service
 * proves ownership from its ledger, does the provider work and answers with
 * the contract's response shape. A 410 means the consent is over and maps
 * onto the same SessionExpiredError the direct adapter throws, so callers
 * flip the connection to expired identically. Every other failure of the hop
 * (transport, timeout, error envelope, wrong shape) is a ConnectorSyncError:
 * the consent is untouched and must never be marked dead for it.
 */
export const connectBankFeedAdapter: BankFeedAdapter = {
  provider: CONNECT_BANK_FEED_PROVIDER,
  needsSessionId: true,

  async syncBooked(input: BankFeedSyncInput): Promise<BankFeedSyncResult> {
    const connector = bankConnectorMode(input.companyId)
    if (!connector) throw new Error('Connect bank feed adapter selected without connector configuration')
    if (!input.sessionId) throw new Error('Connector bank sync requires a connection with a session id')

    // The body is read INSIDE the timeout window: a service that sends headers
    // and then stalls the body must not hold the sync open past the budget.
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), CONNECTOR_SYNC_TIMEOUT_MS)
    let response: Response
    let text: string
    try {
      try {
        response = await fetch(`${connector.baseUrl}/sync`, {
          method: 'POST',
          signal: controller.signal,
          redirect: 'error',
          headers: {
            Authorization: `Bearer ${connector.key}`,
            'Content-Type': 'application/json',
            Accept: 'application/json',
            [CONNECTOR_COMPANY_HEADER]: input.companyId,
          },
          body: JSON.stringify({
            session_id: input.sessionId,
            account_uid: input.accountUid,
            account_currency: input.accountCurrency,
            date_from: input.fromDate,
            date_to: input.toDate,
            ...(input.strategy ? { strategy: input.strategy } : {}),
          }),
        })
        text = await response.text()
      } catch (err) {
        const aborted = err instanceof Error && err.name === 'AbortError'
        throw new ConnectorSyncError(
          null,
          aborted ? 'CONNECTOR_TIMEOUT' : 'CONNECTOR_TRANSPORT',
          err instanceof Error ? err.message : String(err),
        )
      }
    } finally {
      clearTimeout(timeout)
    }

    let json: unknown = null
    try {
      json = text ? JSON.parse(text) : null
    } catch {
      json = null
    }
    if (!response.ok) {
      const envelope = connectorErrorSchema.safeParse(json)
      const code = envelope.success ? envelope.data.code : `HTTP_${response.status}`
      if (response.status === 410 || code === 'CONNECTOR_BANK_SESSION_EXPIRED') {
        throw new SessionExpiredError(response.status, text)
      }
      throw new ConnectorSyncError(response.status, code, text.slice(0, 500))
    }
    const parsed = bankSyncResponseSchema.safeParse(json)
    if (!parsed.success) {
      // The field paths are the only thing that lets the service side be fixed:
      // a bare "unexpected shape" left the 2026-09-04 canary failure undiagnosable.
      const issues = parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
      console.warn('[enable-banking] Connector sync response failed the wire contract', {
        connectionId: input.connectionId,
        accountUid: input.accountUid,
        status: response.status,
        issues,
      })
      throw new ConnectorSyncError(response.status, 'CONNECTOR_BAD_SHAPE', text.slice(0, 500), issues)
    }
    const remote = parsed.data
    return {
      transactions: remote.transactions,
      rawPages: remote.raw_pages,
      skippedPending: remote.skipped_pending,
      effectiveFromDate: remote.effective_date_from ?? undefined,
      narrowed: remote.effective_date_from !== null,
    }
  },
}
