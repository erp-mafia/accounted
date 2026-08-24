/**
 * GET /api/v1/companies/{companyId}/reconciliation/accounts/{accountKey}
 *
 * The bridge for one account: what the outside says, what the ledger says,
 * the difference, and the lines that explain it. Read-only.
 */
import { z } from 'zod'
import { ok } from '@/lib/api/v1/response'
import { registerEndpoint, dataEnvelope } from '@/lib/api/v1/registry'
import { withApiV1 } from '@/lib/api/v1/with-api-v1'
import { v1ErrorResponse, v1ErrorResponseFromCode } from '@/lib/api/v1/errors'
import { ISO_DATE_RE } from '@/lib/invariants'
import { AccountKeySchema, ReconciliationStatusSchema } from '@/lib/reconciliation/schemas'
import { getAccountStatus } from '@/lib/reconciliation/service'

const DATE = ISO_DATE_RE

registerEndpoint({
  operation: 'reconciliation.accounts.status',
  method: 'GET',
  path: '/api/v1/companies/:companyId/reconciliation/accounts/:accountKey',
  summary: 'The reconciliation bridge for one account.',
  description:
    'Returns external_balance (Skatteverket saldo; null for bank accounts until a statement balance exists), ledger_balance (1630 balance at the snapshot for skattekonto; period movement on the bank account), difference, unexplained_difference, is_reconciled, the bridge lines (label, amount, count, items_bucket) that explain the difference row by row, counts per bucket, and a kind block (skattekonto: saldo, fetched_at, history_start, opening_difference, upcoming; bank: today\'s bank status fields). Optional ?date_from / ?date_to: for skattekonto they scope the item lists only (the bridge is anchored at the snapshot); for bank they scope the bridge window.',
  useWhen:
    'You need to know whether an account reconciles and why not: the bridge is the explanation, the buckets are the work.',
  doNotUseFor:
    'Listing the rows themselves (use .../items) or linking (POST .../links).',
  pitfalls: [
    'Judge health on unexplained_difference, never on difference. The difference is expected to be non-zero while rows are unmatched; unexplained_difference is what is left once every bridge line is accounted for, and for skattekonto it is 0,00 whenever the data is consistent (a non-zero value is an integrity finding, not a task).',
    'stale = true means the outside truth is older than 7 days (Skatteverket connection needing re-consent is the usual cause). is_reconciled can still be true on stale data; read both.',
    'skattekonto.opening_difference is the gap between the derived saldo at history_start and the ledger before it; it belongs to migrated ledgers and is accepted once at sign-off, not worked down.',
    'Bank accounts carry the legacy field set in the bank block (bank_transaction_total, gl_1930_period_movement, …) unchanged from /reconciliation/bank/status.',
  ],
  example: {
    response: {
      data: {
        account_key: 'skattekonto',
        kind: 'skattekonto',
        account_number: '1630',
        currency: 'SEK',
        window: { from: null, to: null },
        as_of: '2026-08-20T04:00:12.000Z',
        stale: false,
        external_balance: 53395,
        ledger_balance: 30342,
        difference: 23053,
        unexplained_difference: 0,
        is_reconciled: false,
        bridge: [
          { key: 'external_balance', label_sv: 'Saldo hos Skatteverket', label_en: 'Balance at Skatteverket', amount: 53395, count: null, items_bucket: null },
          { key: 'unmatched_external', label_sv: 'Händelser som saknas i bokföringen', label_en: 'Events missing from the ledger', amount: -35553, count: 5, items_bucket: 'unmatched_external' },
          { key: 'unmatched_ledger', label_sv: 'Rader på 1630 utan händelse hos Skatteverket', label_en: '1630 lines without a Skatteverket event', amount: 12500, count: 1, items_bucket: 'unmatched_ledger' },
          { key: 'ledger_balance', label_sv: 'Bokfört på 1630', label_en: 'Booked on 1630', amount: 30342, count: null, items_bucket: null },
        ],
        counts: { proposed: 2, unmatched_external: 3, unmatched_ledger: 1, matched: 41, ignored: 0 },
        skattekonto: { saldo_skatteverket: 53395, fetched_at: '2026-08-20T04:00:12.000Z', history_start: '2025-01-17', opening_difference: 0, upcoming_count: 3, upcoming_total: -18450, ledger_balance_before_start: 0 },
        bank: null,
      },
      meta: { request_id: 'req_…', api_version: '2026-05-12' },
    },
  },
  scope: 'reconciliation:read',
  risk: 'low',
  idempotent: true,
  reversible: false,
  dryRunSupported: false,
  response: { success: dataEnvelope(ReconciliationStatusSchema) },
})

export const GET = withApiV1<{ params: Promise<{ companyId: string; accountKey: string }> }>(
  'reconciliation.accounts.status',
  async (request, ctx, params) => {
    const { accountKey } = await params.params
    if (!AccountKeySchema.safeParse(accountKey).success) {
      return v1ErrorResponseFromCode('NOT_FOUND', ctx.log, {
        requestId: ctx.requestId,
        details: { field: 'accountKey', message: 'Okänt konto.' },
      })
    }
    const url = new URL(request.url)
    const Filters = z.object({
      date_from: z.string().regex(DATE).optional(),
      date_to: z.string().regex(DATE).optional(),
    })
    const parsed = Filters.safeParse({
      date_from: url.searchParams.get('date_from') ?? undefined,
      date_to: url.searchParams.get('date_to') ?? undefined,
    })
    if (!parsed.success) {
      return v1ErrorResponseFromCode('VALIDATION_ERROR', ctx.log, {
        requestId: ctx.requestId,
        details: {
          issues: parsed.error.issues.map((i) => ({ field: i.path.join('.'), message: i.message })),
        },
      })
    }
    try {
      const status = await getAccountStatus(ctx.supabase, ctx.companyId!, accountKey, {
        windowFrom: parsed.data.date_from ?? null,
        windowTo: parsed.data.date_to ?? null,
      })
      if (!status) {
        return v1ErrorResponseFromCode('NOT_FOUND', ctx.log, {
          requestId: ctx.requestId,
          details: { field: 'accountKey', message: 'Okänt konto för det här företaget.' },
        })
      }
      // The skattekonto engine returns its item lists too; the status route is
      // the bridge only. Items live at .../items.
      const { items: _items, ...rest } = status as typeof status & { items?: unknown }
      void _items
      return ok(rest, { requestId: ctx.requestId })
    } catch (err) {
      return v1ErrorResponse(err, ctx.log, { requestId: ctx.requestId })
    }
  },
)
