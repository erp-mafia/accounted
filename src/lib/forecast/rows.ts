/**
 * Forecast rows (cash_forecast_rows): list them, upsert a batch by the
 * caller's own key, cancel one. The rules every door shares; the doors are
 * the operations in lib/operations/cash-forecast.ts.
 *
 * Not bookkeeping: a row never reaches a verifikat, so API and MCP callers
 * write directly under forecast:write (decision 2026-10-28). Still:
 *
 *   - an upsert names each row by (external_source, external_id), so sending
 *     the same batch twice changes nothing the second time;
 *   - an upsert changes only open rows: a row that is realised, superseded or
 *     cancelled stays as it is and is reported as skipped, so a system that
 *     keeps sending a booking a person cancelled does not bring it back;
 *   - a row is cancelled by status, never deleted;
 *   - an invoice, supplier invoice or dimension value a row points at must be
 *     the company's (the database refuses it too: cash_forecast_rows_same_company).
 */
import { z } from 'zod'
import { isoDateSchema } from '@/lib/invariants/zod'
import { roundOre } from '@/lib/money'
import type { OperationContext, OperationOutcome } from '@/lib/operations/types'

export const FORECAST_ROW_CATEGORIES = ['revenue', 'payroll', 'tax', 'rent', 'loan', 'other'] as const
export const FORECAST_ROW_CONFIDENCES = ['firm', 'likely', 'possible'] as const
export const FORECAST_ROW_STATUSES = ['open', 'realised', 'superseded', 'cancelled'] as const
export const FORECAST_ROW_SOURCES = ['manual', 'api', 'mcp', 'pms'] as const
export const MAX_UPSERT_BATCH = 500

interface ForecastRowRecord {
  id: string
  expected_date: string
  amount: number | string
  direction: 'in' | 'out'
  currency: string
  category: (typeof FORECAST_ROW_CATEGORIES)[number]
  source: (typeof FORECAST_ROW_SOURCES)[number]
  external_source: string | null
  external_id: string | null
  confidence: (typeof FORECAST_ROW_CONFIDENCES)[number]
  dimension_value_id: string | null
  invoice_id: string | null
  supplier_invoice_id: string | null
  status: (typeof FORECAST_ROW_STATUSES)[number]
  matched_transaction_id: string | null
  note: string | null
  created_at: string
  updated_at: string
}

export const ForecastRowView = z.object({
  cash_forecast_row_id: z.string().uuid(),
  expected_date: z.string(),
  amount: z.number(),
  direction: z.enum(['in', 'out']),
  currency: z.string(),
  category: z.enum(FORECAST_ROW_CATEGORIES),
  source: z.enum(FORECAST_ROW_SOURCES),
  external_source: z.string().nullable(),
  external_id: z.string().nullable(),
  confidence: z.enum(FORECAST_ROW_CONFIDENCES),
  dimension_value_id: z.string().uuid().nullable(),
  invoice_id: z.string().uuid().nullable(),
  supplier_invoice_id: z.string().uuid().nullable(),
  status: z.enum(FORECAST_ROW_STATUSES),
  matched_transaction_id: z.string().uuid().nullable(),
  note: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
})
export type ForecastRowView = z.infer<typeof ForecastRowView>

function view(row: ForecastRowRecord): ForecastRowView {
  return {
    cash_forecast_row_id: row.id,
    expected_date: row.expected_date,
    amount: roundOre(Number(row.amount)),
    direction: row.direction,
    currency: row.currency,
    category: row.category,
    source: row.source,
    external_source: row.external_source,
    external_id: row.external_id,
    confidence: row.confidence,
    dimension_value_id: row.dimension_value_id,
    invoice_id: row.invoice_id,
    supplier_invoice_id: row.supplier_invoice_id,
    status: row.status,
    matched_transaction_id: row.matched_transaction_id,
    note: row.note,
    created_at: row.created_at,
    updated_at: row.updated_at,
  }
}

const readFailed = (error: { message?: string; code?: string } | null): OperationOutcome<never> => ({
  ok: false,
  code: 'CASH_FORECAST_ROWS_READ_FAILED',
  details: { reason: error?.message ?? 'unknown' },
})

// ---------------------------------------------------------------------------
// List
// ---------------------------------------------------------------------------

export const ListForecastRowsInput = z.object({
  status: z.enum(FORECAST_ROW_STATUSES).optional().describe('Only rows with this status. Default: every status.'),
  from: isoDateSchema.optional().describe('First expected date, inclusive.'),
  to: isoDateSchema.optional().describe('Last expected date, inclusive.'),
  external_source: z.string().trim().min(1).max(100).optional().describe('Only rows from this outside system, e.g. "boom".'),
  limit: z.coerce.number().int().min(1).max(500).optional().describe('Rows per page, default 100.'),
  offset: z.coerce.number().int().min(0).optional(),
})
export type ListForecastRowsInput = z.infer<typeof ListForecastRowsInput>

export async function listForecastRows(
  ctx: OperationContext,
  input: ListForecastRowsInput,
): Promise<OperationOutcome<{ rows: ForecastRowView[]; total: number }>> {
  const limit = input.limit ?? 100
  const offset = input.offset ?? 0
  let query = ctx.supabase.from('cash_forecast_rows').select('id, expected_date, amount, direction, currency, category, source, external_source, external_id, confidence, dimension_value_id, invoice_id, supplier_invoice_id, status, matched_transaction_id, note, created_at, updated_at', { count: 'exact' }).eq('company_id', ctx.companyId)
  if (input.status) query = query.eq('status', input.status)
  if (input.from) query = query.gte('expected_date', input.from)
  if (input.to) query = query.lte('expected_date', input.to)
  if (input.external_source) query = query.eq('external_source', input.external_source)
  const { data, error, count } = await query
    .order('expected_date', { ascending: true })
    .order('id', { ascending: true })
    .range(offset, offset + limit - 1)
  if (error) return readFailed(error)
  return { ok: true, data: { rows: ((data ?? []) as ForecastRowRecord[]).map(view), total: count ?? 0 } }
}

// ---------------------------------------------------------------------------
// Upsert a batch
// ---------------------------------------------------------------------------

const UUID = z.string().uuid()

export const ForecastRowInput = z.object({
  external_source: z
    .string()
    .trim()
    .min(1)
    .max(100)
    .describe('The system the row comes from, e.g. "boom" for a property management system. With external_id it names the row.'),
  external_id: z.string().trim().min(1).max(200).describe("The row's id in that system. Sending it again updates the row."),
  expected_date: isoDateSchema.describe('YYYY-MM-DD the money is expected in or out.'),
  amount: z.number().positive().max(1_000_000_000).describe('SEK, positive; direction says which way.'),
  direction: z.enum(['in', 'out']),
  category: z.enum(FORECAST_ROW_CATEGORIES),
  confidence: z.enum(FORECAST_ROW_CONFIDENCES).optional().describe('Default likely.'),
  note: z.string().trim().max(500).nullable().optional(),
  dimension_value_id: UUID.nullable().optional().describe('A kostnadsställe or projekt value (GET /dimensions).'),
  invoice_id: UUID.nullable().optional().describe('The customer invoice this row anticipates: once linked, the invoice counts and the row does not.'),
  supplier_invoice_id: UUID.nullable().optional().describe('The supplier invoice this row anticipates: once linked, the invoice counts and the row does not.'),
})
export type ForecastRowInput = z.infer<typeof ForecastRowInput>

export const UpsertForecastRowsInput = z
  .object({
    rows: z.array(ForecastRowInput).min(1).max(MAX_UPSERT_BATCH),
    source: z
      .enum(['api', 'mcp', 'pms'])
      .optional()
      .describe('Who writes the rows. Default: the door called (api over REST, mcp over MCP). pms: a property management system.'),
  })
  .superRefine((value, ctx) => {
    const seen = new Set<string>()
    value.rows.forEach((row, index) => {
      if (row.invoice_id && row.supplier_invoice_id) {
        ctx.addIssue({ code: 'custom', path: ['rows', index, 'supplier_invoice_id'], message: 'A row anticipates one invoice: send invoice_id or supplier_invoice_id, not both.' })
      }
      const key = `${row.external_source}\u0000${row.external_id}`
      if (seen.has(key)) {
        ctx.addIssue({ code: 'custom', path: ['rows', index, 'external_id'], message: 'The same external_source and external_id appear twice in the batch.' })
      }
      seen.add(key)
    })
  })
export type UpsertForecastRowsInput = z.infer<typeof UpsertForecastRowsInput>

export interface UpsertForecastRowsResult {
  rows: ForecastRowView[]
  created: number
  updated: number
  /** Rows that exist but are no longer open: left as they are. */
  skipped: Array<{ cash_forecast_row_id: string; external_source: string; external_id: string; status: ForecastRowView['status'] }>
}

const keyOf = (source: string, id: string) => `${source}\u0000${id}`

/** Ids in the batch that are not the company's, per kind; empty when every one is. */
async function foreignReferences(ctx: OperationContext, rows: readonly ForecastRowInput[]): Promise<Record<string, string[]> | { error: unknown }> {
  const checks: Array<{ table: string; field: 'invoice_id' | 'supplier_invoice_id' | 'dimension_value_id' }> = [
    { table: 'invoices', field: 'invoice_id' },
    { table: 'supplier_invoices', field: 'supplier_invoice_id' },
    { table: 'dimension_values', field: 'dimension_value_id' },
  ]
  const missing: Record<string, string[]> = {}
  for (const { table, field } of checks) {
    const ids = [...new Set(rows.map((r) => r[field]).filter((v): v is string => !!v))]
    const found = new Set<string>()
    for (const chunk of chunks(ids)) {
      const { data, error } = await ctx.supabase.from(table).select('id').eq('company_id', ctx.companyId).in('id', chunk)
      if (error) return { error }
      for (const r of (data ?? []) as Array<{ id: string }>) found.add(r.id)
    }
    const absent = ids.filter((id) => !found.has(id))
    if (absent.length > 0) missing[field] = absent
  }
  return missing
}

/** Ids per `.in()` filter: the list travels in the URL. */
const IN_CHUNK = 100

function chunks<T>(items: readonly T[]): T[][] {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += IN_CHUNK) out.push(items.slice(i, i + IN_CHUNK))
  return out
}

export async function upsertForecastRows(
  ctx: OperationContext,
  input: UpsertForecastRowsInput,
  options: { dryRun: boolean },
): Promise<OperationOutcome<UpsertForecastRowsResult>> {
  const references = await foreignReferences(ctx, input.rows)
  if ('error' in references) return readFailed(references.error as { message?: string })
  if (Object.keys(references).length > 0) {
    return { ok: false, code: 'CASH_FORECAST_ROW_REFERENCE_NOT_FOUND', details: references }
  }

  // The rows the batch names that exist already: one read per outside system.
  const existing = new Map<string, Pick<ForecastRowRecord, 'id' | 'external_id' | 'status'>>()
  const bySource = new Map<string, string[]>()
  for (const row of input.rows) bySource.set(row.external_source, [...(bySource.get(row.external_source) ?? []), row.external_id])
  for (const [source, ids] of bySource) {
    for (const chunk of chunks(ids)) {
      const { data, error } = await ctx.supabase
        .from('cash_forecast_rows')
        .select('id, external_id, status')
        .eq('company_id', ctx.companyId)
        .eq('external_source', source)
        .in('external_id', chunk)
      if (error) return readFailed(error)
      for (const row of (data ?? []) as Array<Pick<ForecastRowRecord, 'id' | 'external_id' | 'status'>>) {
        existing.set(keyOf(source, row.external_id ?? ''), row)
      }
    }
  }

  const values = (row: ForecastRowInput) => ({
    external_source: row.external_source,
    external_id: row.external_id,
    expected_date: row.expected_date,
    amount: roundOre(row.amount),
    direction: row.direction,
    category: row.category,
    confidence: row.confidence ?? 'likely',
    note: row.note ?? null,
    dimension_value_id: row.dimension_value_id ?? null,
    invoice_id: row.invoice_id ?? null,
    supplier_invoice_id: row.supplier_invoice_id ?? null,
  })

  const inserts: ForecastRowInput[] = []
  const updates: ForecastRowInput[] = []
  const skipped: UpsertForecastRowsResult['skipped'] = []
  for (const row of input.rows) {
    const found = existing.get(keyOf(row.external_source, row.external_id))
    if (!found) inserts.push(row)
    else if (found.status === 'open') updates.push(row)
    else skipped.push({ cash_forecast_row_id: found.id, external_source: row.external_source, external_id: row.external_id, status: found.status })
  }

  if (options.dryRun) {
    return {
      ok: true,
      dryRun: true,
      preview: {
        would_create: inserts.length,
        would_update: updates.length,
        skipped,
        rows: input.rows.map(values),
      },
    }
  }

  const source = input.source ?? (ctx.door === 'mcp' ? 'mcp' : 'api')
  const writes = [...inserts, ...updates]
  let written: ForecastRowRecord[] = []
  if (writes.length > 0) {
    // One statement for the whole batch (upsert_cash_forecast_rows): an
    // insert per new key, an update per open row, and a row that stopped
    // being open meanwhile left as it is. source and created_by are set on
    // insert only.
    const { data, error } = await ctx.supabase.rpc('upsert_cash_forecast_rows', {
      p_company_id: ctx.companyId,
      p_source: source,
      p_created_by: ctx.userId,
      p_rows: writes.map(values),
    })
    if (error) return writeFailed(error)
    written = (data ?? []) as ForecastRowRecord[]
  }

  ctx.log.info('cash forecast rows upserted', { created: inserts.length, updated: updates.length, skipped: skipped.length })
  return {
    ok: true,
    data: { rows: written.map(view), created: inserts.length, updated: updates.length, skipped },
    created: inserts.length > 0,
  }
}

// ---------------------------------------------------------------------------
// A person's row
// ---------------------------------------------------------------------------

export const CreateManualForecastRowInput = z.object({
  expected_date: isoDateSchema,
  amount: z.number().positive().max(1_000_000_000),
  direction: z.enum(['in', 'out']),
  category: z.enum(FORECAST_ROW_CATEGORIES),
  confidence: z.enum(FORECAST_ROW_CONFIDENCES).optional(),
  note: z.string().trim().max(500).nullable().optional(),
})
export type CreateManualForecastRowInput = z.infer<typeof CreateManualForecastRowInput>

/**
 * A row a person types in on the Likviditetsprognos page: source manual and
 * no outside key (cash_forecast_rows_external_pair), so no upsert ever names
 * it; it leaves the forecast by being cancelled or realised. The session's
 * RLS decides who may write it: a writing member of the active company. The
 * API's door for the same money is the upsert, keyed by the caller's system.
 */
export async function createManualForecastRow(
  ctx: OperationContext,
  input: CreateManualForecastRowInput,
): Promise<OperationOutcome<{ row: ForecastRowView }>> {
  const { data, error } = await ctx.supabase
    .from('cash_forecast_rows')
    .insert({
      company_id: ctx.companyId,
      expected_date: input.expected_date,
      amount: roundOre(input.amount),
      direction: input.direction,
      category: input.category,
      confidence: input.confidence ?? 'likely',
      note: input.note ? input.note : null,
      source: 'manual',
      created_by: ctx.userId,
    })
    .select('id, expected_date, amount, direction, currency, category, source, external_source, external_id, confidence, dimension_value_id, invoice_id, supplier_invoice_id, status, matched_transaction_id, note, created_at, updated_at')
    .single()
  if (error) return writeFailed(error)
  ctx.log.info('cash forecast row added', { cashForecastRowId: (data as ForecastRowRecord).id })
  return { ok: true, data: { row: view(data as ForecastRowRecord) }, created: true }
}

function writeFailed(error: { message?: string; code?: string }): OperationOutcome<never> {
  // A unique violation the upsert could not absorb: sending the batch again resolves it.
  if (error.code === '23505') return { ok: false, code: 'CASH_FORECAST_ROWS_CONFLICT', details: { reason: error.message } }
  if (error.code === '23503') return { ok: false, code: 'CASH_FORECAST_ROW_REFERENCE_NOT_FOUND', details: { reason: error.message } }
  return { ok: false, code: 'CASH_FORECAST_ROWS_WRITE_FAILED', details: { reason: error.message ?? 'unknown' } }
}

// ---------------------------------------------------------------------------
// Cancel
// ---------------------------------------------------------------------------

export const CancelForecastRowInput = z
  .object({
    cash_forecast_row_id: UUID.optional().describe('The row to cancel. Or name it by external_source and external_id.'),
    external_source: z.string().trim().min(1).max(100).optional(),
    external_id: z.string().trim().min(1).max(200).optional(),
  })
  .superRefine((value, ctx) => {
    const byKey = value.external_source !== undefined || value.external_id !== undefined
    if (value.cash_forecast_row_id ? byKey : !(value.external_source && value.external_id)) {
      ctx.addIssue({
        code: 'custom',
        path: ['cash_forecast_row_id'],
        message: 'Name the row by cash_forecast_row_id, or by external_source and external_id together.',
      })
    }
  })
export type CancelForecastRowInput = z.infer<typeof CancelForecastRowInput>

export async function cancelForecastRow(
  ctx: OperationContext,
  input: CancelForecastRowInput,
  options: { dryRun: boolean },
): Promise<OperationOutcome<{ row: ForecastRowView }>> {
  let query = ctx.supabase.from('cash_forecast_rows').select('id, expected_date, amount, direction, currency, category, source, external_source, external_id, confidence, dimension_value_id, invoice_id, supplier_invoice_id, status, matched_transaction_id, note, created_at, updated_at').eq('company_id', ctx.companyId)
  query = input.cash_forecast_row_id
    ? query.eq('id', input.cash_forecast_row_id)
    : query.eq('external_source', input.external_source!).eq('external_id', input.external_id!)
  const { data, error } = await query.maybeSingle()
  if (error) return readFailed(error)
  const row = data as ForecastRowRecord | null
  if (!row) return { ok: false, code: 'CASH_FORECAST_ROW_NOT_FOUND' }
  // Cancelling twice is the same as once.
  if (row.status === 'cancelled') return options.dryRun ? { ok: true, dryRun: true, preview: { row: view(row), changes: false } } : { ok: true, data: { row: view(row) } }
  if (row.status !== 'open') {
    return { ok: false, code: 'CASH_FORECAST_ROW_NOT_OPEN', details: { cash_forecast_row_id: row.id, status: row.status } }
  }
  if (options.dryRun) return { ok: true, dryRun: true, preview: { row: { ...view(row), status: 'cancelled' }, changes: true } }

  // Compare-and-set on open: a row realised meanwhile is not cancelled.
  const { data: updated, error: updateError } = await ctx.supabase
    .from('cash_forecast_rows')
    .update({ status: 'cancelled' })
    .eq('company_id', ctx.companyId)
    .eq('id', row.id)
    .eq('status', 'open')
    .select('id, expected_date, amount, direction, currency, category, source, external_source, external_id, confidence, dimension_value_id, invoice_id, supplier_invoice_id, status, matched_transaction_id, note, created_at, updated_at')
    .maybeSingle()
  if (updateError) return writeFailed(updateError)
  if (!updated) return { ok: false, code: 'CASH_FORECAST_ROW_NOT_OPEN', details: { cash_forecast_row_id: row.id } }
  ctx.log.info('cash forecast row cancelled', { cashForecastRowId: row.id })
  return { ok: true, data: { row: view(updated as ForecastRowRecord) } }
}
