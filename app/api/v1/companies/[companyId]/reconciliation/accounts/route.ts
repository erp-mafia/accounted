/**
 * GET /api/v1/companies/{companyId}/reconciliation/accounts
 *
 * Every account with an outside truth, as the Avstämning page lists them:
 * enabled cash accounts (deduplicated per IBAN) and the skattekonto when the
 * company has a saldo snapshot or rows. One row per account with its source,
 * sync age and status (state, unexplained difference, open counts).
 * Read-only, no dry-run, no idempotency.
 */
import { z } from 'zod'
import { ok } from '@/lib/api/v1/response'
import { registerEndpoint, dataEnvelope } from '@/lib/api/v1/registry'
import { withApiV1 } from '@/lib/api/v1/with-api-v1'
import { v1ErrorResponse, v1ValidationError } from '@/lib/api/v1/errors'
import { ISO_DATE_RE } from '@/lib/invariants'
import { ReconciliationAccountSchema } from '@/lib/reconciliation/schemas'
import { listReconciliationAccounts } from '@/lib/reconciliation/service'

const DATE = ISO_DATE_RE

const AccountsResponse = z.object({ accounts: z.array(ReconciliationAccountSchema) })

registerEndpoint({
  operation: 'reconciliation.accounts.list',
  method: 'GET',
  path: '/api/v1/companies/:companyId/reconciliation/accounts',
  summary: 'List the accounts that can be reconciled, with status per account.',
  description:
    'Returns one row per reconcilable account (bank:<cash_account_id> for each enabled cash account, skattekonto when configured) with kind, number, currency, source (psd2 / bank_file / skatteverket_api / manual, synced_at, stale), status (reconciled | open | stale | not_configured, unexplained_difference, open_counts) and superseded_by for reconnect duplicates. Optional ?date_from / ?date_to scope the bank bridge (default: the calendar year to date). Pass ?with_status=false for a cheap list without status.',
  useWhen:
    'You need the side list of the Avstämning page, a month-end checklist, or to find the account_key to pass to the other reconciliation endpoints.',
  doNotUseFor:
    'The bridge and rows for one account: use GET /reconciliation/accounts/{accountKey} and .../items.',
  pitfalls: [
    'account_key is the identifier every other reconciliation endpoint takes: bank:<cash_account_id> or skattekonto. Do not pass the BAS number.',
    'status.state = stale means the outside truth is older than 7 days; the numbers are still computed, but judge them accordingly.',
    'superseded_by is set on an older cash account that shares IBAN + currency with a newer one (reconnect duplicate); it is kept in the list because it may still hold unlinked rows.',
    'Computing status per account runs one reconciliation per account; with_status=false skips that when you only need the list.',
  ],
  example: {
    response: {
      data: {
        accounts: [
          {
            account_key: 'bank:11111111-1111-4111-8111-111111111111',
            kind: 'bank',
            account_number: '1930',
            name: 'Swedbank företagskonto',
            currency: 'SEK',
            logo_url: null,
            source: { type: 'psd2', synced_at: '2026-08-20T06:40:00.000Z', stale: false },
            status: {
              state: 'open',
              as_of: '2026-08-20T09:00:00.000Z',
              unexplained_difference: 0,
              open_counts: { proposed: 0, unmatched_external: 1, unmatched_ledger: 1 },
            },
            superseded_by: null,
          },
          {
            account_key: 'skattekonto',
            kind: 'skattekonto',
            account_number: '1630',
            name: 'Skattekonto',
            currency: 'SEK',
            logo_url: '/logos/skatteverket_color.svg',
            source: { type: 'skatteverket_api', synced_at: '2026-08-20T04:00:12.000Z', stale: false },
            status: {
              state: 'open',
              as_of: '2026-08-20T04:00:12.000Z',
              unexplained_difference: 0,
              open_counts: { proposed: 2, unmatched_external: 3, unmatched_ledger: 1 },
            },
            superseded_by: null,
          },
        ],
      },
      meta: { request_id: 'req_…', api_version: '2026-05-12' },
    },
  },
  scope: 'reconciliation:read',
  risk: 'low',
  idempotent: true,
  reversible: false,
  dryRunSupported: false,
  response: { success: dataEnvelope(AccountsResponse) },
})

export const GET = withApiV1<{ params: Promise<{ companyId: string }> }>(
  'reconciliation.accounts.list',
  async (request, ctx) => {
    const url = new URL(request.url)
    const Filters = z.object({
      date_from: z.string().regex(DATE).optional(),
      date_to: z.string().regex(DATE).optional(),
      with_status: z.enum(['true', 'false']).optional(),
    })
    const parsed = Filters.safeParse({
      date_from: url.searchParams.get('date_from') ?? undefined,
      date_to: url.searchParams.get('date_to') ?? undefined,
      with_status: url.searchParams.get('with_status') ?? undefined,
    })
    if (!parsed.success) return v1ValidationError(ctx, parsed.error)
    try {
      const accounts = await listReconciliationAccounts(ctx.supabase, ctx.companyId!, {
        windowFrom: parsed.data.date_from,
        windowTo: parsed.data.date_to,
        withStatus: parsed.data.with_status !== 'false',
      })
      return ok({ accounts }, { requestId: ctx.requestId })
    } catch (err) {
      return v1ErrorResponse(err, ctx.log, { requestId: ctx.requestId })
    }
  },
)
