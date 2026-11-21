/**
 * The records a question rests on: whether each one exists in the company,
 * and the amounts that stand on them.
 *
 * Amounts per kind:
 *   transaction       the amount, in its own currency and in SEK
 *   journal_entry     the total (the debit side) and every line amount
 *   invoice           total, net, VAT, remaining and paid, in the invoice's
 *   supplier_invoice  currency and in SEK
 *   document          the totals read off the document, when it has any
 *   fact              the amounts written in the saved fact
 *   account           the account's balance today
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { accountBalanceThrough } from '@/lib/bookkeeping/account-balance'
import { todayIsoStockholm } from '@/lib/dates/iso'
import { dbError } from '@/lib/errors/db-error'
import { isAccountNumber } from '@/lib/invariants/account-number'
import { isUuid } from '@/lib/invariants/uuid'
import { sumOre } from '@/lib/money'
import { fetchAllRows } from '@/lib/supabase/fetch-all'
import { findMoneyMentions } from './amounts'
import type { EvidenceKind, EvidenceRef } from './types'

export interface ResolvedEvidence {
  /** References that name no record of the company. */
  missing: EvidenceRef[]
  /** Every amount that stands on the records found. */
  amounts: number[]
}

interface Found {
  /** The ids (or account numbers) that exist in the company. */
  ids: Set<string>
  amounts: number[]
}

type Numeric = number | string | null | undefined

/** A numeric column as a number: PostgREST may hand a numeric back as text. */
function numeric(value: Numeric): number | null {
  if (value === null || value === undefined || value === '') return null
  const n = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(n) ? n : null
}

function collect(amounts: number[], ...values: Numeric[]): void {
  for (const value of values) {
    const n = numeric(value)
    if (n !== null) amounts.push(n)
  }
}

async function transactions(supabase: SupabaseClient, companyId: string, ids: string[]): Promise<Found> {
  const { data, error } = await supabase
    .from('transactions')
    .select('id, amount, amount_sek, instructed_amount')
    .eq('company_id', companyId)
    .in('id', ids)
  if (error) throw dbError(error)
  const found: Found = { ids: new Set(), amounts: [] }
  for (const row of (data ?? []) as Array<{ id: string; amount: Numeric; amount_sek: Numeric; instructed_amount: Numeric }>) {
    found.ids.add(row.id)
    collect(found.amounts, row.amount, row.amount_sek, row.instructed_amount)
  }
  return found
}

interface LineRow {
  id: string
  journal_entry_id: string
  debit_amount: Numeric
  credit_amount: Numeric
  amount_in_currency: Numeric
}

async function journalEntries(supabase: SupabaseClient, companyId: string, ids: string[]): Promise<Found> {
  const { data, error } = await supabase.from('journal_entries').select('id').eq('company_id', companyId).in('id', ids)
  if (error) throw dbError(error)
  const found: Found = { ids: new Set(((data ?? []) as Array<{ id: string }>).map((row) => row.id)), amounts: [] }
  if (found.ids.size === 0) return found

  const entryIds = [...found.ids]
  const lines = await fetchAllRows<LineRow>(({ from, to }) =>
    supabase
      .from('journal_entry_lines')
      .select('id, journal_entry_id, debit_amount, credit_amount, amount_in_currency')
      .in('journal_entry_id', entryIds)
      .order('id')
      .range(from, to),
  )
  const debitsByEntry = new Map<string, number[]>()
  for (const line of lines) {
    collect(found.amounts, line.debit_amount, line.credit_amount, line.amount_in_currency)
    const debit = numeric(line.debit_amount)
    if (debit !== null) debitsByEntry.set(line.journal_entry_id, [...(debitsByEntry.get(line.journal_entry_id) ?? []), debit])
  }
  for (const debits of debitsByEntry.values()) found.amounts.push(sumOre(debits))
  return found
}

interface InvoiceAmounts {
  id: string
  total: Numeric
  total_sek: Numeric
  subtotal: Numeric
  subtotal_sek: Numeric
  vat_amount: Numeric
  vat_amount_sek: Numeric
  remaining_amount: Numeric
  paid_amount: Numeric
}

function invoiceAmounts(rows: InvoiceAmounts[]): Found {
  const found: Found = { ids: new Set(), amounts: [] }
  for (const row of rows) {
    found.ids.add(row.id)
    collect(
      found.amounts,
      row.total,
      row.total_sek,
      row.subtotal,
      row.subtotal_sek,
      row.vat_amount,
      row.vat_amount_sek,
      row.remaining_amount,
      row.paid_amount,
    )
  }
  return found
}

async function invoices(supabase: SupabaseClient, companyId: string, ids: string[]): Promise<Found> {
  const { data, error } = await supabase
    .from('invoices')
    .select('id, total, total_sek, subtotal, subtotal_sek, vat_amount, vat_amount_sek, remaining_amount, paid_amount')
    .eq('company_id', companyId)
    .in('id', ids)
  if (error) throw dbError(error)
  return invoiceAmounts((data ?? []) as InvoiceAmounts[])
}

async function supplierInvoices(supabase: SupabaseClient, companyId: string, ids: string[]): Promise<Found> {
  const { data, error } = await supabase
    .from('supplier_invoices')
    .select('id, total, total_sek, subtotal, subtotal_sek, vat_amount, vat_amount_sek, remaining_amount, paid_amount')
    .eq('company_id', companyId)
    .in('id', ids)
  if (error) throw dbError(error)
  return invoiceAmounts((data ?? []) as InvoiceAmounts[])
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** The totals a reading of a document carries: totals.* and the prominent amounts. */
function extractedAmounts(extracted: unknown): number[] {
  if (!isRecord(extracted)) return []
  const amounts: number[] = []
  if (isRecord(extracted.totals)) {
    for (const value of Object.values(extracted.totals)) {
      if (typeof value === 'number' && Number.isFinite(value)) amounts.push(value)
    }
  }
  if (Array.isArray(extracted.prominentAmounts)) {
    for (const entry of extracted.prominentAmounts) {
      if (isRecord(entry) && typeof entry.amount === 'number' && Number.isFinite(entry.amount)) amounts.push(entry.amount)
    }
  }
  return amounts
}

async function documents(supabase: SupabaseClient, companyId: string, ids: string[]): Promise<Found> {
  const { data, error } = await supabase
    .from('document_attachments')
    .select('id, extracted_data')
    .eq('company_id', companyId)
    .in('id', ids)
  if (error) throw dbError(error)
  const found: Found = { ids: new Set(), amounts: [] }
  for (const row of (data ?? []) as Array<{ id: string; extracted_data: unknown }>) {
    found.ids.add(row.id)
    found.amounts.push(...extractedAmounts(row.extracted_data))
  }
  return found
}

async function facts(supabase: SupabaseClient, companyId: string, ids: string[]): Promise<Found> {
  const { data, error } = await supabase.from('agent_memory').select('id, content').eq('company_id', companyId).in('id', ids)
  if (error) throw dbError(error)
  const found: Found = { ids: new Set(), amounts: [] }
  for (const row of (data ?? []) as Array<{ id: string; content: string | null }>) {
    found.ids.add(row.id)
    for (const mention of findMoneyMentions(row.content ?? '')) {
      for (const reading of mention.readings) found.amounts.push(reading.value)
    }
  }
  return found
}

async function accounts(supabase: SupabaseClient, companyId: string, numbers: string[]): Promise<Found> {
  const { data, error } = await supabase
    .from('chart_of_accounts')
    .select('account_number')
    .eq('company_id', companyId)
    .in('account_number', numbers)
  if (error) throw dbError(error)
  const found: Found = { ids: new Set(((data ?? []) as Array<{ account_number: string }>).map((row) => row.account_number)), amounts: [] }
  const today = todayIsoStockholm()
  for (const accountNumber of found.ids) {
    const balance = await accountBalanceThrough(supabase, companyId, accountNumber, today)
    if (balance !== null) found.amounts.push(balance)
  }
  return found
}

const LOADERS: Record<EvidenceKind, (supabase: SupabaseClient, companyId: string, ids: string[]) => Promise<Found>> = {
  transaction: transactions,
  journal_entry: journalEntries,
  invoice: invoices,
  supplier_invoice: supplierInvoices,
  document: documents,
  fact: facts,
  account: accounts,
}

/** Whether the id has the shape its kind is stored with; one that has not names no record. */
function wellFormed(ref: EvidenceRef): boolean {
  return ref.kind === 'account' ? isAccountNumber(ref.id) : isUuid(ref.id)
}

/**
 * Looks every reference up in the company. A reference with a malformed id,
 * or one that names no record of this company, is returned in `missing`.
 * Throws when a read fails.
 */
export async function resolveEvidence(
  supabase: SupabaseClient,
  companyId: string,
  refs: readonly EvidenceRef[],
): Promise<ResolvedEvidence> {
  const idsByKind = new Map<EvidenceKind, string[]>()
  for (const ref of refs) {
    if (!wellFormed(ref)) continue
    idsByKind.set(ref.kind, [...(idsByKind.get(ref.kind) ?? []), ref.id])
  }
  const loaded = new Map<EvidenceKind, Found>()
  await Promise.all(
    [...idsByKind].map(async ([kind, ids]) => {
      loaded.set(kind, await LOADERS[kind](supabase, companyId, [...new Set(ids)]))
    }),
  )
  const amounts: number[] = []
  for (const found of loaded.values()) amounts.push(...found.amounts)
  const missing = refs.filter((ref) => !loaded.get(ref.kind)?.ids.has(ref.id))
  return { missing, amounts }
}
