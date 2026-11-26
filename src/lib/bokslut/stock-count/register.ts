import type { SupabaseClient } from '@supabase/supabase-js'
import { createLogger } from '@/lib/logger'
import { fetchAllRows } from '@/lib/supabase/fetch-all'
import { sumOre } from '@/lib/money'
import { ID_READ_CHUNK } from '@/lib/reconciliation/limits'
import { chunk } from '@/lib/utils'
import { StockCountError, stockCountErrorFromDb } from './errors'
import { type SaveStockCountBody, SaveStockCountSchema } from './schemas'
import { categoryTotals, stockRowValue, type CategoryTotal, type StockCategory } from './valuation'

const log = createLogger('bokslut/stock-count')

/**
 * The register of year-end stock counts (inventory_counts and their rows):
 * read, make and change a draft, delete a draft. Signing lives in
 * ./signing.ts, booking in ./booking.ts. Every write goes through the
 * caller's client, so RLS, the writer-role trigger and the freeze trigger
 * (inventory_counts_guard) all apply.
 */

export type StockCountStatus = 'draft' | 'signed' | 'booked'

export interface StockCountRecord {
  id: string
  company_id: string
  fiscal_period_id: string
  balance_date: string
  count_date: string
  roll_forward_note: string | null
  note: string | null
  status: StockCountStatus
  signer_name: string | null
  signed_at: string | null
  signed_document_id: string | null
  signing_request_id: string | null
  journal_entry_id: string | null
  booked_at: string | null
  created_at: string
  updated_at: string
}

export interface StockCountRowRecord {
  id: string
  position: number
  article_id: string | null
  description: string
  category: StockCategory
  unit: string | null
  quantity: number
  unit_cost: number
  write_down_percent: number
  value: number
}

export interface StockCountView extends StockCountRecord {
  rows: StockCountRowRecord[]
  totals: CategoryTotal[]
  total_value: number
}

export interface StockCountSummary extends StockCountRecord {
  row_count: number
  total_value: number
}

export interface FiscalPeriodRef {
  id: string
  name: string
  period_start: string
  period_end: string
}

function toRow(raw: Record<string, unknown>): StockCountRowRecord {
  return {
    id: String(raw.id),
    position: Number(raw.position),
    article_id: (raw.article_id as string | null) ?? null,
    description: String(raw.description),
    category: raw.category as StockCategory,
    unit: (raw.unit as string | null) ?? null,
    quantity: Number(raw.quantity),
    unit_cost: Number(raw.unit_cost),
    write_down_percent: Number(raw.write_down_percent),
    value: Number(raw.value),
  }
}

export async function loadFiscalPeriod(
  supabase: SupabaseClient,
  companyId: string,
  fiscalPeriodId: string,
): Promise<FiscalPeriodRef> {
  const { data, error } = await supabase
    .from('fiscal_periods')
    .select('id, name, period_start, period_end')
    .eq('company_id', companyId)
    .eq('id', fiscalPeriodId)
    .maybeSingle()
  if (error) throw error
  if (!data) throw new StockCountError('STOCK_COUNT_NO_PERIOD')
  return data as FiscalPeriodRef
}

export async function loadStockCountRecord(supabase: SupabaseClient, companyId: string, id: string): Promise<StockCountRecord> {
  const { data, error } = await supabase
    .from('inventory_counts')
    .select('id, company_id, fiscal_period_id, balance_date, count_date, roll_forward_note, note, status, signer_name, signed_at, signed_document_id, signing_request_id, journal_entry_id, booked_at, created_at, updated_at')
    .eq('company_id', companyId)
    .eq('id', id)
    .maybeSingle()
  if (error) throw error
  if (!data) throw new StockCountError('STOCK_COUNT_NOT_FOUND')
  return data as unknown as StockCountRecord
}

export async function loadStockCountRows(supabase: SupabaseClient, companyId: string, id: string): Promise<StockCountRowRecord[]> {
  const rows = await fetchAllRows<Record<string, unknown>>(({ from, to }) =>
    supabase
      .from('inventory_count_rows')
      .select('id, position, article_id, description, category, unit, quantity, unit_cost, write_down_percent, value')
      .eq('company_id', companyId)
      .eq('inventory_count_id', id)
      .order('position', { ascending: true })
      .range(from, to),
  )
  return rows.map(toRow)
}

export function buildStockCountView(record: StockCountRecord, rows: StockCountRowRecord[]): StockCountView {
  const totals = categoryTotals(rows)
  return { ...record, rows, totals, total_value: sumOre(totals.map((t) => t.value)) }
}

/** The company's counts, newest first, optionally for one fiscal year, with their totals. */
export async function listStockCounts(
  supabase: SupabaseClient,
  companyId: string,
  options: { fiscalPeriodId?: string } = {},
): Promise<StockCountSummary[]> {
  let query = supabase.from('inventory_counts').select('id, company_id, fiscal_period_id, balance_date, count_date, roll_forward_note, note, status, signer_name, signed_at, signed_document_id, signing_request_id, journal_entry_id, booked_at, created_at, updated_at').eq('company_id', companyId)
  if (options.fiscalPeriodId) query = query.eq('fiscal_period_id', options.fiscalPeriodId)
  const { data, error } = await query.order('created_at', { ascending: false }).limit(200)
  if (error) throw error
  const counts = (data ?? []) as unknown as StockCountRecord[]
  if (counts.length === 0) return []
  const rowData = await fetchAllRows<{ id: string; inventory_count_id: string; value: number | string }>(({ from, to }) =>
    supabase
      .from('inventory_count_rows')
      .select('id, inventory_count_id, value')
      .eq('company_id', companyId)
      .in('inventory_count_id', counts.map((c) => c.id))
      .order('id', { ascending: true })
      .range(from, to),
  )
  const byCount = new Map<string, number[]>()
  for (const row of rowData) {
    const values = byCount.get(row.inventory_count_id) ?? []
    values.push(Number(row.value))
    byCount.set(row.inventory_count_id, values)
  }
  return counts.map((c) => {
    const values = byCount.get(c.id) ?? []
    return { ...c, row_count: values.length, total_value: sumOre(values) }
  })
}

function assertDates(period: FiscalPeriodRef, body: { count_date: string; roll_forward_note?: string | null }): void {
  if (body.count_date !== period.period_end && !body.roll_forward_note?.trim()) {
    throw new StockCountError('STOCK_COUNT_ROLL_FORWARD_REQUIRED', { balance_date: period.period_end })
  }
}

async function assertArticles(supabase: SupabaseClient, companyId: string, articleIds: string[]): Promise<void> {
  const unique = [...new Set(articleIds)]
  if (unique.length === 0) return
  // In slices of ID_READ_CHUNK: a count holds up to STOCK_COUNT_MAX_ROWS
  // rows, each on its own article, and the ids travel in the GET query
  // string, which the gateway refuses past its limit. One read would also
  // stop at PostgREST's 1000 rows and call the rest missing. Reads by
  // primary key: a slice answers at most ID_READ_CHUNK rows.
  const found = new Set<string>()
  for (const ids of chunk(unique, ID_READ_CHUNK)) {
    const { data, error } = await supabase.from('articles').select('id').eq('company_id', companyId).in('id', ids)
    if (error) throw error
    for (const article of (data ?? []) as Array<{ id: string }>) found.add(article.id)
  }
  const missing = unique.filter((id) => !found.has(id))
  if (missing.length > 0) throw new StockCountError('STOCK_COUNT_ARTICLE_NOT_FOUND', { article_ids: missing })
}

function rowPayloads(companyId: string, countId: string, body: ReturnType<typeof SaveStockCountSchema.parse>) {
  return body.rows.map((row, i) => ({
    company_id: companyId,
    inventory_count_id: countId,
    position: i + 1,
    article_id: row.article_id ?? null,
    description: row.description,
    category: row.category,
    unit: row.unit ?? null,
    quantity: row.quantity,
    unit_cost: row.unit_cost,
    write_down_percent: row.write_down_percent,
    value: stockRowValue(row),
  }))
}

async function insertRows(supabase: SupabaseClient, rows: ReturnType<typeof rowPayloads>): Promise<void> {
  if (rows.length === 0) return
  const { error } = await supabase.from('inventory_count_rows').insert(rows)
  if (error) throw stockCountErrorFromDb(error) ?? error
}

/** A new draft count for a fiscal year, its rows valued here. */
export async function createStockCount(
  supabase: SupabaseClient,
  companyId: string,
  userId: string,
  input: SaveStockCountBody,
): Promise<StockCountView> {
  const body = SaveStockCountSchema.parse(input)
  const period = await loadFiscalPeriod(supabase, companyId, body.fiscal_period_id)
  assertDates(period, body)
  await assertArticles(supabase, companyId, body.rows.flatMap((r) => (r.article_id ? [r.article_id] : [])))

  const { data, error } = await supabase
    .from('inventory_counts')
    .insert({
      company_id: companyId,
      user_id: userId,
      fiscal_period_id: period.id,
      balance_date: period.period_end,
      count_date: body.count_date,
      roll_forward_note: body.count_date === period.period_end ? null : body.roll_forward_note?.trim() || null,
      note: body.note?.trim() || null,
    })
    .select('id, company_id, fiscal_period_id, balance_date, count_date, roll_forward_note, note, status, signer_name, signed_at, signed_document_id, signing_request_id, journal_entry_id, booked_at, created_at, updated_at')
    .single()
  if (error) throw error
  const record = data as unknown as StockCountRecord
  try {
    await insertRows(supabase, rowPayloads(companyId, record.id, body))
  } catch (err) {
    // A draft without its rows is no count: take it back.
    const { error: undoError } = await supabase.from('inventory_counts').delete().eq('company_id', companyId).eq('id', record.id)
    if (undoError) log.warn('draft count left without rows', { countId: record.id, message: undoError.message })
    throw err
  }
  return buildStockCountView(record, await loadStockCountRows(supabase, companyId, record.id))
}

/** Change a draft: its dates and notes, and its rows replaced by the ones given. */
export async function updateStockCount(
  supabase: SupabaseClient,
  companyId: string,
  id: string,
  input: SaveStockCountBody,
): Promise<StockCountView> {
  const body = SaveStockCountSchema.parse(input)
  const current = await loadStockCountRecord(supabase, companyId, id)
  if (current.status !== 'draft') throw new StockCountError('STOCK_COUNT_LOCKED')
  if (current.signing_request_id) throw new StockCountError('STOCK_COUNT_SIGNING_PENDING')
  if (body.fiscal_period_id !== current.fiscal_period_id) {
    throw new StockCountError('STOCK_COUNT_LOCKED', { field: 'fiscal_period_id' })
  }
  const period = await loadFiscalPeriod(supabase, companyId, current.fiscal_period_id)
  assertDates(period, body)
  await assertArticles(supabase, companyId, body.rows.flatMap((r) => (r.article_id ? [r.article_id] : [])))

  const { data, error } = await supabase
    .from('inventory_counts')
    .update({
      count_date: body.count_date,
      roll_forward_note: body.count_date === current.balance_date ? null : body.roll_forward_note?.trim() || null,
      note: body.note?.trim() || null,
    })
    .eq('company_id', companyId)
    .eq('id', id)
    .eq('status', 'draft')
    .select('id, company_id, fiscal_period_id, balance_date, count_date, roll_forward_note, note, status, signer_name, signed_at, signed_document_id, signing_request_id, journal_entry_id, booked_at, created_at, updated_at')
    .maybeSingle()
  if (error) throw stockCountErrorFromDb(error) ?? error
  if (!data) throw new StockCountError('STOCK_COUNT_LOCKED')

  const { error: deleteError } = await supabase
    .from('inventory_count_rows')
    .delete()
    .eq('company_id', companyId)
    .eq('inventory_count_id', id)
  if (deleteError) throw stockCountErrorFromDb(deleteError) ?? deleteError
  await insertRows(supabase, rowPayloads(companyId, id, body))
  return buildStockCountView(data as unknown as StockCountRecord, await loadStockCountRows(supabase, companyId, id))
}

/** Delete a draft (a signed count is kept: the freeze trigger refuses it too). */
export async function deleteStockCount(supabase: SupabaseClient, companyId: string, id: string): Promise<void> {
  const current = await loadStockCountRecord(supabase, companyId, id)
  if (current.status !== 'draft') throw new StockCountError('STOCK_COUNT_LOCKED')
  if (current.signing_request_id) throw new StockCountError('STOCK_COUNT_SIGNING_PENDING')
  const { error } = await supabase.from('inventory_counts').delete().eq('company_id', companyId).eq('id', id)
  if (error) throw stockCountErrorFromDb(error) ?? error
}
