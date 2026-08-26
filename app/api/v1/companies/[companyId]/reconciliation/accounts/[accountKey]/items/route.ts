/**
 * GET /api/v1/companies/{companyId}/reconciliation/accounts/{accountKey}/items
 *
 * The rows behind the bridge, in the page's buckets, with proposals and the
 * actions each row allows. Offset pagination carried in an opaque cursor.
 */
import { z } from 'zod'
import { ok } from '@/lib/api/v1/response'
import { registerEndpoint, dataEnvelope } from '@/lib/api/v1/registry'
import { withApiV1 } from '@/lib/api/v1/with-api-v1'
import { v1ErrorResponse, v1ErrorResponseFromCode } from '@/lib/api/v1/errors'
import {
  AccountKeySchema,
  ReconciliationItemBucketSchema,
  ReconciliationItemSchema,
} from '@/lib/reconciliation/schemas'
import { listAccountItems, MAX_ITEMS_LIMIT } from '@/lib/reconciliation/items'
import { ISO_DATE_RE } from '@/lib/invariants'

const DATE = ISO_DATE_RE

function encodeOffsetCursor(offset: number): string {
  return Buffer.from(JSON.stringify({ o: offset }), 'utf8').toString('base64url')
}
function decodeOffsetCursor(cursor: string | null | undefined): number | null {
  if (!cursor) return 0
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as { o?: unknown }
    return typeof parsed.o === 'number' && parsed.o >= 0 ? Math.floor(parsed.o) : null
  } catch {
    return null
  }
}

const ItemsResponse = z.object({
  items: z.array(ReconciliationItemSchema),
  count: z.number().int(),
  total_count: z.number().int(),
  has_more: z.boolean(),
  next_cursor: z.string().nullable(),
  /** Unmatched rows dated before date_from: counted so a window can never hide work. */
  older_unmatched_count: z.number().int(),
})

registerEndpoint({
  operation: 'reconciliation.accounts.items',
  method: 'GET',
  path: '/api/v1/companies/:companyId/reconciliation/accounts/:accountKey/items',
  summary: 'List the rows behind one account\'s bridge, bucketed.',
  description:
    'Returns reconciliation items for one account. ?bucket selects one of proposed | unmatched_external | unmatched_ledger | matched | ignored | upcoming (default: all open buckets first, then matched). Each item carries its side (external | ledger), a qualified item_id (skattekonto_transaction / transaction / journal_entry), date, description, signed amount, the proposal when one exists (journal_entry_id, voucher, confidence, reasons[]), link_problem when a link points at a reversed or draft entry, awaiting_external for fresh ledger lines, and the actions the row allows. ?date_from / ?date_to scope the lists; rows outside the window are never hidden from the counts (older_unmatched_count).',
  useWhen:
    'You are about to link, book or ignore rows and need to see what is open and what is proposed.',
  doNotUseFor:
    'The totals: those are on GET /reconciliation/accounts/{accountKey}.',
  pitfalls: [
    'An item in bucket proposed is NOT linked: it carries a proposal to link. Apply it with POST .../links { use_proposals: true } or explicit pairs.',
    'actions lists what the row allows right now; an action not listed returns a structured error rather than silently doing nothing.',
    'Ledger items are one per verifikat: several 1630/1930 lines of the same entry are netted, because a link settles the whole entry.',
    'Pagination is ?limit (max 200) + ?cursor; next_cursor is null on the last page.',
  ],
  example: {
    response: {
      data: {
        items: [
          {
            item_id: '33333333-3333-4333-8333-333333333333',
            item_type: 'skattekonto_transaction',
            side: 'external',
            bucket: 'proposed',
            date: '2026-08-12',
            description: 'Inbetalning bokförd',
            amount: 30000,
            currency: 'SEK',
            proposal: {
              journal_entry_id: '44444444-4444-4444-8444-444444444444',
              voucher_number: 214,
              voucher_series: 'A',
              entry_date: '2026-08-11',
              description: 'Inbetalning skattekonto',
              entry_status: 'posted',
              confidence: 0.95,
              reasons: ['exakt belopp på 1630', '1 dagars avstånd'],
            },
            actions: ['match', 'book', 'ignore'],
          },
        ],
        count: 1,
        total_count: 1,
        has_more: false,
        next_cursor: null,
        older_unmatched_count: 0,
      },
      meta: { request_id: 'req_…', api_version: '2026-05-12' },
    },
  },
  scope: 'reconciliation:read',
  risk: 'low',
  idempotent: true,
  reversible: false,
  dryRunSupported: false,
  response: { success: dataEnvelope(ItemsResponse) },
})

export const GET = withApiV1<{ params: Promise<{ companyId: string; accountKey: string }> }>(
  'reconciliation.accounts.items',
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
      bucket: ReconciliationItemBucketSchema.optional(),
      date_from: z.string().regex(DATE).optional(),
      date_to: z.string().regex(DATE).optional(),
      limit: z.coerce.number().int().min(1).max(MAX_ITEMS_LIMIT).optional(),
      cursor: z.string().optional(),
    })
    const parsed = Filters.safeParse({
      bucket: url.searchParams.get('bucket') ?? undefined,
      date_from: url.searchParams.get('date_from') ?? undefined,
      date_to: url.searchParams.get('date_to') ?? undefined,
      limit: url.searchParams.get('limit') ?? undefined,
      cursor: url.searchParams.get('cursor') ?? undefined,
    })
    if (!parsed.success) {
      return v1ErrorResponseFromCode('VALIDATION_ERROR', ctx.log, {
        requestId: ctx.requestId,
        details: {
          issues: parsed.error.issues.map((i) => ({ field: i.path.join('.'), message: i.message })),
        },
      })
    }
    const offset = decodeOffsetCursor(parsed.data.cursor)
    if (offset === null) {
      return v1ErrorResponseFromCode('VALIDATION_ERROR', ctx.log, {
        requestId: ctx.requestId,
        details: { field: 'cursor', message: 'Ogiltig cursor.' },
      })
    }
    try {
      const result = await listAccountItems(ctx.supabase, ctx.companyId!, accountKey, {
        bucket: parsed.data.bucket,
        windowFrom: parsed.data.date_from ?? null,
        windowTo: parsed.data.date_to ?? null,
        limit: parsed.data.limit,
        offset,
      })
      if (!result) {
        return v1ErrorResponseFromCode('NOT_FOUND', ctx.log, {
          requestId: ctx.requestId,
          details: { field: 'accountKey', message: 'Okänt konto för det här företaget.' },
        })
      }
      return ok(
        {
          items: result.items,
          count: result.count,
          total_count: result.total_count,
          has_more: result.has_more,
          next_cursor:
            result.has_more && result.next_offset !== undefined ? encodeOffsetCursor(result.next_offset) : null,
          older_unmatched_count: result.older_unmatched_count,
        },
        { requestId: ctx.requestId },
      )
    } catch (err) {
      return v1ErrorResponse(err, ctx.log, { requestId: ctx.requestId })
    }
  },
)
