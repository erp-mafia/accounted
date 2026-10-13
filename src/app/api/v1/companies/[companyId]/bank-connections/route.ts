/**
 * GET /api/v1/companies/{companyId}/bank-connections
 *
 * List PSD2 bank connections with freshness metadata: last_synced_at,
 * consent_expires, status, error_message. This is the API-key surface's
 * answer to "is my bank data current?": a connection whose last_synced_at
 * is stale, or whose status is expired/error, means the transaction and
 * balance data downstream is old even though it looks complete.
 */
import { z } from 'zod'
import { ok } from '@/lib/api/v1/response'
import { registerEndpoint, dataEnvelope } from '@/lib/api/v1/registry'
import { withApiV1 } from '@/lib/api/v1/with-api-v1'
import { v1ErrorResponse } from '@/lib/api/v1/errors'
import { requireCapability } from '@/lib/entitlements/has-capability'
import { CAPABILITY } from '@/lib/entitlements/keys'
import { aggregatorOf } from '@/lib/bank-sync/aggregator'

const BankConnection = z.object({
  connection_id: z.string(),
  bank: z.string().nullable(),
  aggregator: z
    .enum(['enable_banking', 'open_payments'])
    .describe('The service between Accounted and the bank. open_payments rows are managed through /bank-feed; enable_banking rows are the legacy feed and can be switched.'),
  status: z.enum(['pending', 'pending_selection', 'active', 'expired', 'error']),
  since: z.string(),
  last_synced_at: z.string().nullable(),
  consent_expires: z.string().nullable(),
  error_message: z.string().nullable(),
})

const BankConnectionsResponse = dataEnvelope(
  z.object({ bank_connections: z.array(BankConnection) }),
)

registerEndpoint({
  operation: 'bank-connections.list',
  method: 'GET',
  path: '/api/v1/companies/:companyId/bank-connections',
  summary: 'List PSD2 bank connections with sync freshness and consent expiry.',
  description:
    'Returns every bank connection for the company with its aggregator (enable_banking or open_payments), status, last successful sync (last_synced_at), consent expiry (consent_expires) and any user-facing error message. Connections sync automatically once a day server-side; this endpoint tells you whether that is still happening. The Open Payments rows with their accounts, the reachable banks and the switch from Enable Banking: GET /bank-feed, /bank-feed/banks, /bank-feed/switch-progress.',
  useWhen:
    'You need to verify bank data is current before building on it (liquidity, reconciliation, reports), or to detect a dead connection that needs BankID re-authorisation.',
  doNotUseFor:
    'Fetching transactions (use /transactions) or account balances (use /cash-accounts). Triggering a sync: POST /bank-connections/{connectionId}/sync.',
  pitfalls: [
    'last_synced_at is null until the first sync completes (about a minute after connecting); it does NOT mean the connection is broken.',
    'A connection can hold status=active with a stale last_synced_at (older than ~36 hours): treat the data as suspect, but do NOT assume re-authorisation fixes it. Common causes are a lapsed subscription (this endpoint then answers with a capability error) or every account deselected in settings.',
    'status=expired means the PSD2 consent is dead: only the user can fix it, with BankID in a browser. An open_payments row is renewed from the Kopplingar page or from a signatory link (POST /bank-feed/invites with replace_connection_id).',
    'error_message is Swedish and user-facing: show it verbatim rather than translating.',
  ],
  example: {
    response: {
      data: {
        bank_connections: [
          {
            connection_id: '4f6c…',
            bank: 'Swedbank',
            aggregator: 'open_payments',
            status: 'active',
            since: '2026-08-01T00:00:00Z',
            last_synced_at: '2026-08-31T05:04:12Z',
            consent_expires: '2026-11-01T00:00:00Z',
            error_message: null,
          },
        ],
      },
      meta: { request_id: 'req_…', api_version: '2026-05-12' },
    },
  },
  scope: 'companies:read',
  risk: 'low',
  idempotent: true,
  reversible: false,
  dryRunSupported: false,
  response: { success: BankConnectionsResponse },
})

export const GET = withApiV1<{ params: Promise<{ companyId: string }> }>(
  'bank-connections.list',
  async (_request, ctx) => {
    // Mirror the MCP twin (gnubok_connect_bank is gated on bank_sync via
    // MCP_TOOL_CAPABILITY_MAP): without this, a company whose entitlement
    // lapsed reads status=active with a frozen last_synced_at and the docs
    // steer the agent toward a needless BankID re-auth. The capability error
    // names the real cause instead.
    const capBlocked = await requireCapability(ctx.supabase, ctx.companyId!, CAPABILITY.bank_sync)
    if (capBlocked) return capBlocked

    try {
      const { data, error } = await ctx.supabase
        .from('bank_connections')
        .select('id, bank_name, aggregator, status, created_at, last_synced_at, consent_expires, error_message')
        .eq('company_id', ctx.companyId!)
        .in('status', ['pending', 'pending_selection', 'active', 'expired', 'error'])
        .order('created_at', { ascending: false })
      if (error) throw error

      type Row = {
        id: string
        bank_name: string | null
        aggregator?: string | null
        status: string
        created_at: string
        last_synced_at: string | null
        consent_expires: string | null
        error_message: string | null
      }
      const bank_connections = ((data ?? []) as Row[]).map((c) => ({
        connection_id: c.id,
        bank: c.bank_name,
        aggregator: aggregatorOf(c),
        status: c.status,
        since: c.created_at,
        last_synced_at: c.last_synced_at,
        consent_expires: c.consent_expires,
        error_message: c.error_message,
      }))
      return ok({ bank_connections }, { requestId: ctx.requestId })
    } catch (error) {
      return v1ErrorResponse(error, ctx.log, { requestId: ctx.requestId })
    }
  },
)
