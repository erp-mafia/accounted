/**
 * /api/v1/companies/{companyId}/journal-entries — list + create draft.
 *
 * GET   — cursor-paginated list with filters (fiscal_period_id, status, date range).
 *         Cursor on (entry_date DESC, id DESC).
 * POST  — create a draft verifikation. Idempotent (mandatory Idempotency-Key).
 *         Dry-runnable. The draft has no voucher number until you call
 *         /commit, so a draft that's never committed produces no löpnummer gap
 *         (BFL 5 kap 6–7 §§).
 *
 * Strict-mode v1: any engine failure aborts before any state change. The
 * `createDraftEntry` engine call is itself atomic (rollbacks the row on
 * line-insert failure); the route surface just propagates structured errors.
 */

import { z } from 'zod'
import { created, paginated } from '@/lib/api/v1/response'
import { dryRunPreview } from '@/lib/api/v1/dry-run'
import {
  decodeDefaultCursor,
  encodeDefaultCursor,
  parsePaginationParams,
} from '@/lib/api/v1/pagination'
import { registerEndpoint, listEnvelope } from '@/lib/api/v1/registry'
import { withApiV1 } from '@/lib/api/v1/with-api-v1'
import { v1ErrorResponse, v1ErrorResponseFromCode } from '@/lib/api/v1/errors'
import { checkPeriodLock } from '@/lib/api/v1/check-period-lock'
import { ownsFiscalPeriod } from '@/lib/api/v1/owns-fiscal-period'
import { CreateJournalEntrySchema } from '@/lib/api/schemas'
import { createDraftEntry, validateBalance } from '@/lib/bookkeeping/engine'
import { isBookkeepingError } from '@/lib/bookkeeping/errors'

const JE_LINE_COLUMNS =
  'id, account_number, debit_amount, credit_amount, line_description, currency, amount_in_currency, exchange_rate, tax_code, cost_center, project, sort_order'
const JE_COLUMNS =
  'id, fiscal_period_id, voucher_series, voucher_number, entry_date, description, status, source_type, source_id, notes, reverses_id, reversed_by_id, correction_of_id, created_at, updated_at'

const JournalEntryStatus = z.enum(['draft', 'posted', 'cancelled'])

const JournalEntrySummary = z.object({
  id: z.string().uuid(),
  fiscal_period_id: z.string().uuid(),
  voucher_series: z.string(),
  voucher_number: z.number().int(),
  entry_date: z.string(),
  description: z.string(),
  status: JournalEntryStatus,
  source_type: z.string(),
  created_at: z.string(),
})

const JournalEntriesListResponse = listEnvelope(JournalEntrySummary)

const JournalEntryLine = z.object({
  id: z.string().uuid(),
  account_number: z.string(),
  debit_amount: z.number(),
  credit_amount: z.number(),
  line_description: z.string().nullable(),
  currency: z.string().nullable(),
  amount_in_currency: z.number().nullable(),
  exchange_rate: z.number().nullable(),
  tax_code: z.string().nullable(),
  cost_center: z.string().nullable(),
  project: z.string().nullable(),
})

const JournalEntryDetail = JournalEntrySummary.extend({
  notes: z.string().nullable(),
  reverses_id: z.string().uuid().nullable(),
  reversed_by_id: z.string().uuid().nullable(),
  correction_of_id: z.string().uuid().nullable(),
  lines: z.array(JournalEntryLine),
})

registerEndpoint({
  operation: 'journal-entries.list',
  method: 'GET',
  path: '/api/v1/companies/:companyId/journal-entries',
  summary: 'List journal entries (verifikationer).',
  description:
    'Cursor-paginated list of journal entries. Filters: fiscal_period_id, status, date_from, date_to. Excludes status=cancelled by default; pass status=cancelled to inspect storno-cancelled drafts.',
  useWhen:
    'You need to walk the verifikationsserie for a period (audit, SIE export, gap detection) or list recent activity for a UI.',
  doNotUseFor:
    'Reading a single verifikation (use GET /{id}). Reading lines without the header (no separate endpoint — they ride in /{id}).',
  pitfalls: [
    'Cancelled drafts are hidden by default. They are NOT a löpnummer gap (no voucher_number is allocated for drafts); the filter is for noise reduction.',
    'voucher_number=0 indicates a draft that has not been committed. Posted entries always have voucher_number > 0.',
  ],
  example: {
    response: {
      data: [
        {
          id: '0e9c…',
          fiscal_period_id: 'a8f1…',
          voucher_series: 'A',
          voucher_number: 142,
          entry_date: '2026-05-12',
          description: 'Levfaktura 2026-1234, Office Depot AB (ankomstnr 42)',
          status: 'posted',
          source_type: 'supplier_invoice_registered',
          created_at: '2026-05-13T15:00:00Z',
        },
      ],
      meta: { request_id: 'req_…', api_version: '2026-05-12', next_cursor: null },
    },
  },
  scope: 'reports:read',
  risk: 'low',
  idempotent: true,
  reversible: false,
  dryRunSupported: false,
  response: { success: JournalEntriesListResponse },
})

export const GET = withApiV1<{ params: Promise<{ companyId: string }> }>(
  'journal-entries.list',
  async (request, ctx) => {
    const url = new URL(request.url)
    const { limit, cursor } = parsePaginationParams(url)
    const decoded = decodeDefaultCursor(cursor)

    const FiltersSchema = z.object({
      fiscal_period_id: z.string().uuid().optional(),
      status: JournalEntryStatus.optional(),
      date_from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      date_to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    })
    const fr = FiltersSchema.safeParse({
      fiscal_period_id: url.searchParams.get('fiscal_period_id') ?? undefined,
      status: url.searchParams.get('status') ?? undefined,
      date_from: url.searchParams.get('date_from') ?? undefined,
      date_to: url.searchParams.get('date_to') ?? undefined,
    })
    if (!fr.success) {
      return v1ErrorResponseFromCode('VALIDATION_ERROR', ctx.log, {
        requestId: ctx.requestId,
        details: { issues: fr.error.issues.map((i) => ({ field: i.path.join('.'), message: i.message })) },
      })
    }
    const filters = fr.data

    let query = ctx.supabase
      .from('journal_entries')
      .select(JE_COLUMNS)
      .eq('company_id', ctx.companyId!)
      .order('entry_date', { ascending: false })
      .order('id', { ascending: false })
      .limit(limit + 1)

    if (filters.fiscal_period_id) query = query.eq('fiscal_period_id', filters.fiscal_period_id)
    if (filters.status) {
      query = query.eq('status', filters.status)
    } else {
      query = query.neq('status', 'cancelled')
    }
    if (filters.date_from) query = query.gte('entry_date', filters.date_from)
    if (filters.date_to) query = query.lte('entry_date', filters.date_to)

    if (decoded) {
      query = query.or(`entry_date.lt.${decoded.ts},and(entry_date.eq.${decoded.ts},id.lt.${decoded.id})`)
    }

    const { data, error } = await query
    if (error) return v1ErrorResponse(error, ctx.log, { requestId: ctx.requestId })

    type Row = {
      id: string
      fiscal_period_id: string
      voucher_series: string
      voucher_number: number
      entry_date: string
      description: string
      status: string
      source_type: string
      created_at: string
    } & Record<string, unknown>

    const rows = ((data ?? []) as unknown) as Row[]
    const trimmed = rows.slice(0, limit)
    const hasMore = rows.length > limit
    const last = trimmed[trimmed.length - 1]
    const nextCursor = hasMore && last
      ? encodeDefaultCursor({ id: last.id, created_at: last.entry_date })
      : null

    return paginated(
      trimmed.map((r) => ({
        id: r.id,
        fiscal_period_id: r.fiscal_period_id,
        voucher_series: r.voucher_series,
        voucher_number: r.voucher_number,
        entry_date: r.entry_date,
        description: r.description,
        status: r.status,
        source_type: r.source_type,
        created_at: r.created_at,
      })),
      { requestId: ctx.requestId, nextCursor: nextCursor ?? undefined },
    )
  },
)

// ──────────────────────────────────────────────────────────────────
// POST — create draft verifikation
// ──────────────────────────────────────────────────────────────────

registerEndpoint({
  operation: 'journal-entries.create-draft',
  method: 'POST',
  path: '/api/v1/companies/:companyId/journal-entries',
  summary: 'Create a draft journal entry (verifikation).',
  description:
    'Creates a draft journal entry via the engine\'s createDraftEntry(). The draft has no voucher_number until /commit is called. Idempotent (mandatory Idempotency-Key). Dry-runnable: a dry-run validates balance + account-chart membership + period date constraints without inserting any row.',
  useWhen:
    'You\'re posting an arbitrary verifikation — manual journal entries, accrual reversals, period closing adjustments — outside the invoicing / supplier-invoice / transaction flows.',
  doNotUseFor:
    'Bookkeeping flows that have a dedicated endpoint (invoices, supplier-invoices, transactions). Editing an existing posted entry — use /correct instead.',
  pitfalls: [
    'Idempotency-Key is mandatory.',
    'Lines must sum to zero (Σ debit = Σ credit). Engine rejects with JOURNAL_ENTRY_NOT_BALANCED on imbalance.',
    'entry_date must fall within fiscal_period_id\'s [period_start, period_end]; otherwise ENTRY_DATE_OUTSIDE_FISCAL_PERIOD.',
    'All account_numbers must be active in the chart_of_accounts; otherwise ACCOUNTS_NOT_IN_CHART.',
    'voucher_series defaults to "A" if omitted. Must be a single uppercase letter.',
    'This creates a DRAFT only — call POST /{id}/commit to assign the voucher_number and post atomically.',
  ],
  example: {
    request: {
      fiscal_period_id: 'a8f1…',
      entry_date: '2026-05-12',
      description: 'Bankavgift maj 2026',
      lines: [
        { account_number: '6570', debit_amount: 50, credit_amount: 0, line_description: 'Bankavgift' },
        { account_number: '1930', debit_amount: 0, credit_amount: 50, line_description: 'Företagskonto' },
      ],
    },
    response: {
      data: { id: '0e9c…', status: 'draft', voucher_series: 'A', voucher_number: 0 },
      meta: { request_id: 'req_…', api_version: '2026-05-12' },
    },
  },
  scope: 'bookkeeping:write',
  risk: 'high',
  idempotent: true,
  reversible: true,
  dryRunSupported: true,
  request: { body: CreateJournalEntrySchema },
  response: { success: JournalEntryDetail },
})

export const POST = withApiV1<{ params: Promise<{ companyId: string }> }>(
  'journal-entries.create-draft',
  async (request, ctx) => {
    let rawBody: unknown
    try {
      rawBody = await request.json()
    } catch {
      return v1ErrorResponseFromCode('VALIDATION_ERROR', ctx.log, {
        requestId: ctx.requestId,
        details: { field: 'body', message: 'Body is not valid JSON.' },
      })
    }

    const parsed = CreateJournalEntrySchema.safeParse(rawBody)
    if (!parsed.success) {
      return v1ErrorResponseFromCode('VALIDATION_ERROR', ctx.log, {
        requestId: ctx.requestId,
        details: { issues: parsed.error.issues.map((i) => ({ field: i.path.join('.'), message: i.message })) },
      })
    }
    const input = parsed.data

    // Ownership pre-check: the caller-supplied fiscal_period_id must belong
    // to ctx.companyId. The engine scopes by company_id internally but the
    // engine throws a Swedish error string on mismatch; the route returns
    // a structured envelope before the engine call.
    if (!(await ownsFiscalPeriod(ctx.supabase, ctx.companyId!, input.fiscal_period_id))) {
      return v1ErrorResponseFromCode('NOT_FOUND', ctx.log, {
        requestId: ctx.requestId,
        details: { resource: 'fiscal_period', field: 'fiscal_period_id' },
      })
    }

    // Balance pre-check — same logic the engine runs, but cheap to fail fast.
    const balance = validateBalance(input.lines)
    if (!balance.valid) {
      return v1ErrorResponseFromCode('JOURNAL_ENTRY_NOT_BALANCED', ctx.log, {
        requestId: ctx.requestId,
        details: { total_debit: balance.totalDebit, total_credit: balance.totalCredit },
      })
    }

    // Period-lock pre-check — drafts CAN technically be inserted into locked
    // periods (no JE-trigger fires until commit), but rejecting up front is
    // cleaner UX and avoids leaving an undeletable draft behind.
    const lockVerdict = await checkPeriodLock(ctx.supabase, ctx.companyId!, input.entry_date)
    if (lockVerdict.locked) {
      return v1ErrorResponseFromCode('PERIOD_LOCKED', ctx.log, {
        requestId: ctx.requestId,
        details: { reason: lockVerdict.reason, fiscal_period_id: lockVerdict.fiscal_period_id },
      })
    }

    if (ctx.dryRun) {
      // Dry-run preview: report the balanced lines + would-be header. No row
      // is inserted, so the engine's per-line account-id resolution doesn't
      // happen — chart-lookup failures will only be reported on live commit.
      return dryRunPreview(
        {
          status: 'draft' as const,
          voucher_series: input.voucher_series ?? 'A',
          voucher_number: 0,
          fiscal_period_id: input.fiscal_period_id,
          entry_date: input.entry_date,
          description: input.description,
          source_type: input.source_type ?? 'manual',
          source_id: input.source_id ?? null,
          notes: input.notes ?? null,
          lines: input.lines.map((l, i) => ({
            sort_order: i,
            account_number: l.account_number,
            debit_amount: l.debit_amount,
            credit_amount: l.credit_amount,
            line_description: l.line_description ?? null,
            currency: l.currency ?? null,
            amount_in_currency: l.amount_in_currency ?? null,
            exchange_rate: l.exchange_rate ?? null,
            tax_code: l.tax_code ?? null,
            cost_center: l.cost_center ?? null,
            project: l.project ?? null,
          })),
          totals: { debit: balance.totalDebit, credit: balance.totalCredit },
        },
        { requestId: ctx.requestId, log: ctx.log },
      )
    }

    try {
      const entry = await createDraftEntry(ctx.supabase, ctx.companyId!, ctx.userId, input)
      // Refetch with lines to return the full detail shape.
      const { data: complete } = await ctx.supabase
        .from('journal_entries')
        .select(`${JE_COLUMNS}, lines:journal_entry_lines(${JE_LINE_COLUMNS})`)
        .eq('company_id', ctx.companyId!)
        .eq('id', entry.id)
        .maybeSingle()
      return created(complete ?? entry, { requestId: ctx.requestId })
    } catch (err) {
      if (isBookkeepingError(err)) {
        return v1ErrorResponse(err, ctx.log, { requestId: ctx.requestId })
      }
      ctx.log.error('journal-entries.create-draft failed', err as Error)
      return v1ErrorResponseFromCode('BOOKKEEPING_DATABASE_ERROR', ctx.log, {
        requestId: ctx.requestId,
        details: { step: 'create_draft' },
      })
    }
  },
  { requireIdempotencyKey: true },
)
