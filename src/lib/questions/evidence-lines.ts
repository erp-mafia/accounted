/**
 * The records a question rests on, as lines a person can read: what each one
 * is, its date, its amount and where it opens.
 *
 * Per kind:
 *   transaction       date, the merchant or the bank text, the amount
 *   journal_entry     entry date, the voucher (A113) with its description, the total
 *   invoice           invoice date, the number with the customer, the total
 *   supplier_invoice  invoice date, the supplier with its invoice number, the total
 *   document          the day it arrived, the file name
 *   fact              the day it was saved, its text
 *   account           today, the number with its name, the balance today
 *
 * Every read filters company_id. A reference that names no record of the
 * company comes back as a line with `found: false`, never as an error.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { linkedRecordHref, nativeRecordHref } from '@/lib/agent-context/wiki-record'
import { accountBalanceThrough } from '@/lib/bookkeeping/account-balance'
import { formatVoucher } from '@/lib/bookkeeping/voucher-series-resolver'
import { todayIsoStockholm } from '@/lib/dates/iso'
import { dbError } from '@/lib/errors/db-error'
import { isAccountNumber } from '@/lib/invariants/account-number'
import { isUuid } from '@/lib/invariants/uuid'
import { sumOre } from '@/lib/money'
import { ID_READ_CHUNK } from '@/lib/supabase/read-in-slices'
import { fetchAllRows } from '@/lib/supabase/fetch-all'
import { chunk } from '@/lib/utils'
import type { EvidenceKind, EvidenceRef } from './types'

export interface EvidenceLine {
  kind: EvidenceKind
  id: string
  /** False when the reference names no record of the company any more. */
  found: boolean
  /** ISO date (yyyy-MM-dd). */
  date: string | null
  /** What the record is called: the counterpart, the voucher, the file, the fact. */
  label: string | null
  /** A second, quieter part: the voucher's description, the invoice's number. */
  detail: string | null
  amount: number | null
  currency: string | null
  /** The record's page in the app, when it has one. */
  href: string | null
}

type Numeric = number | string | null | undefined
type Lines = Map<string, EvidenceLine>

/** Facts are shown whole up to this many characters. */
const FACT_LABEL_MAX = 240

const keyOf = (kind: EvidenceKind, id: string) => `${kind}:${id}`

function numeric(value: Numeric): number | null {
  if (value === null || value === undefined || value === '') return null
  const n = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(n) ? n : null
}

function text(value: string | null | undefined): string | null {
  const trimmed = typeof value === 'string' ? value.trim() : ''
  return trimmed ? trimmed : null
}

function day(value: string | null | undefined): string | null {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}/.test(value) ? value.slice(0, 10) : null
}

/** The name on an embedded customer or supplier, whichever shape PostgREST hands back. */
function embeddedName(value: unknown): string | null {
  const row = Array.isArray(value) ? value[0] : value
  return row && typeof row === 'object' && 'name' in row && typeof row.name === 'string' ? text(row.name) : null
}

async function transactions(supabase: SupabaseClient, companyId: string, ids: string[], lines: Lines): Promise<void> {
  const { data, error } = await supabase
    .from('transactions')
    .select('id, date, description, merchant_name, amount, currency')
    .eq('company_id', companyId)
    .in('id', ids)
  if (error) throw dbError(error)
  for (const row of (data ?? []) as Array<{
    id: string
    date: string | null
    description: string | null
    merchant_name: string | null
    amount: Numeric
    currency: string | null
  }>) {
    lines.set(keyOf('transaction', row.id), {
      kind: 'transaction',
      id: row.id,
      found: true,
      date: day(row.date),
      label: text(row.merchant_name) ?? text(row.description),
      detail: null,
      amount: numeric(row.amount),
      currency: text(row.currency),
      href: linkedRecordHref('transaction', row.id),
    })
  }
}

async function journalEntries(supabase: SupabaseClient, companyId: string, ids: string[], lines: Lines): Promise<void> {
  const { data, error } = await supabase
    .from('journal_entries')
    .select('id, voucher_series, voucher_number, entry_date, description')
    .eq('company_id', companyId)
    .in('id', ids)
  if (error) throw dbError(error)
  const entries = (data ?? []) as Array<{
    id: string
    voucher_series: string | null
    voucher_number: number | null
    entry_date: string | null
    description: string | null
  }>
  if (entries.length === 0) return

  const entryIds = entries.map((entry) => entry.id)
  const debitLines = await fetchAllRows<{ id: string; journal_entry_id: string; debit_amount: Numeric }>(({ from, to }) =>
    supabase
      .from('journal_entry_lines')
      .select('id, journal_entry_id, debit_amount')
      .in('journal_entry_id', entryIds)
      .order('id')
      .range(from, to),
  )
  const debits = new Map<string, number[]>()
  for (const line of debitLines) {
    const debit = numeric(line.debit_amount)
    if (debit !== null) debits.set(line.journal_entry_id, [...(debits.get(line.journal_entry_id) ?? []), debit])
  }

  for (const entry of entries) {
    const total = debits.get(entry.id)
    lines.set(keyOf('journal_entry', entry.id), {
      kind: 'journal_entry',
      id: entry.id,
      found: true,
      date: day(entry.entry_date),
      label: entry.voucher_number ? formatVoucher(entry) : null,
      detail: text(entry.description),
      amount: total ? sumOre(total) : null,
      currency: 'SEK',
      href: nativeRecordHref('journal_entry', entry.id),
    })
  }
}

async function invoices(supabase: SupabaseClient, companyId: string, ids: string[], lines: Lines): Promise<void> {
  const { data, error } = await supabase
    .from('invoices')
    .select('id, invoice_number, invoice_date, total, currency, customer:customers(name)')
    .eq('company_id', companyId)
    .in('id', ids)
  if (error) throw dbError(error)
  for (const row of (data ?? []) as Array<{
    id: string
    invoice_number: string | null
    invoice_date: string | null
    total: Numeric
    currency: string | null
    customer: unknown
  }>) {
    lines.set(keyOf('invoice', row.id), {
      kind: 'invoice',
      id: row.id,
      found: true,
      date: day(row.invoice_date),
      label: embeddedName(row.customer) ?? text(row.invoice_number),
      detail: embeddedName(row.customer) ? text(row.invoice_number) : null,
      amount: numeric(row.total),
      currency: text(row.currency),
      href: linkedRecordHref('invoice', row.id),
    })
  }
}

async function supplierInvoices(supabase: SupabaseClient, companyId: string, ids: string[], lines: Lines): Promise<void> {
  const { data, error } = await supabase
    .from('supplier_invoices')
    .select('id, supplier_invoice_number, invoice_date, total, currency, supplier:suppliers(name)')
    .eq('company_id', companyId)
    .in('id', ids)
  if (error) throw dbError(error)
  for (const row of (data ?? []) as Array<{
    id: string
    supplier_invoice_number: string | null
    invoice_date: string | null
    total: Numeric
    currency: string | null
    supplier: unknown
  }>) {
    lines.set(keyOf('supplier_invoice', row.id), {
      kind: 'supplier_invoice',
      id: row.id,
      found: true,
      date: day(row.invoice_date),
      label: embeddedName(row.supplier) ?? text(row.supplier_invoice_number),
      detail: embeddedName(row.supplier) ? text(row.supplier_invoice_number) : null,
      amount: numeric(row.total),
      currency: text(row.currency),
      href: linkedRecordHref('supplier_invoice', row.id),
    })
  }
}

async function documents(supabase: SupabaseClient, companyId: string, ids: string[], lines: Lines): Promise<void> {
  const { data, error } = await supabase
    .from('document_attachments')
    .select('id, file_name, created_at')
    .eq('company_id', companyId)
    .in('id', ids)
  if (error) throw dbError(error)
  for (const row of (data ?? []) as Array<{ id: string; file_name: string | null; created_at: string | null }>) {
    lines.set(keyOf('document', row.id), {
      kind: 'document',
      id: row.id,
      found: true,
      date: day(row.created_at),
      label: text(row.file_name),
      detail: null,
      amount: null,
      currency: null,
      href: nativeRecordHref('document', row.id),
    })
  }
}

async function facts(supabase: SupabaseClient, companyId: string, ids: string[], lines: Lines): Promise<void> {
  const { data, error } = await supabase
    .from('agent_memory')
    .select('id, content, created_at')
    .eq('company_id', companyId)
    .in('id', ids)
  if (error) throw dbError(error)
  for (const row of (data ?? []) as Array<{ id: string; content: string | null; created_at: string | null }>) {
    const content = text(row.content)
    lines.set(keyOf('fact', row.id), {
      kind: 'fact',
      id: row.id,
      found: true,
      date: day(row.created_at),
      label: content && content.length > FACT_LABEL_MAX ? `${content.slice(0, FACT_LABEL_MAX - 1).trimEnd()}…` : content,
      detail: null,
      amount: null,
      currency: null,
      href: null,
    })
  }
}

async function accounts(supabase: SupabaseClient, companyId: string, numbers: string[], lines: Lines): Promise<void> {
  const { data, error } = await supabase
    .from('chart_of_accounts')
    .select('account_number, account_name')
    .eq('company_id', companyId)
    .in('account_number', numbers)
  if (error) throw dbError(error)
  const today = todayIsoStockholm()
  for (const row of (data ?? []) as Array<{ account_number: string; account_name: string | null }>) {
    lines.set(keyOf('account', row.account_number), {
      kind: 'account',
      id: row.account_number,
      found: true,
      date: today,
      label: row.account_number,
      detail: text(row.account_name),
      amount: await accountBalanceThrough(supabase, companyId, row.account_number, today),
      currency: 'SEK',
      href: null,
    })
  }
}

const LOADERS: Record<EvidenceKind, (supabase: SupabaseClient, companyId: string, ids: string[], lines: Lines) => Promise<void>> = {
  transaction: transactions,
  journal_entry: journalEntries,
  invoice: invoices,
  supplier_invoice: supplierInvoices,
  document: documents,
  fact: facts,
  account: accounts,
}

function wellFormed(ref: EvidenceRef): boolean {
  return ref.kind === 'account' ? isAccountNumber(ref.id) : isUuid(ref.id)
}

function missing(ref: EvidenceRef): EvidenceLine {
  return { kind: ref.kind, id: ref.id, found: false, date: null, label: null, detail: null, amount: null, currency: null, href: null }
}

/**
 * One line per reference, in the order given, read in one query per kind
 * (per ID_READ_CHUNK ids of it) whatever the number of questions. Throws when
 * a read fails.
 */
export async function evidenceLines(
  supabase: SupabaseClient,
  companyId: string,
  questions: ReadonlyArray<readonly EvidenceRef[]>,
): Promise<EvidenceLine[][]> {
  const idsByKind = new Map<EvidenceKind, Set<string>>()
  for (const refs of questions) {
    for (const ref of refs) {
      if (!wellFormed(ref)) continue
      idsByKind.set(ref.kind, (idsByKind.get(ref.kind) ?? new Set<string>()).add(ref.id))
    }
  }
  const lines: Lines = new Map()
  // Each kind in slices of ID_READ_CHUNK, one after another: the ids travel in
  // the GET query string, which the gateway refuses past its limit, and the
  // settled questions name up to 320 records of one kind (their own evidence
  // and their closes'), the operations of 200 questions up to 1000 bank rows.
  // A slice of verifikat keeps the read of their lines within the limit too.
  await Promise.all(
    [...idsByKind].map(async ([kind, ids]) => {
      for (const slice of chunk([...ids], ID_READ_CHUNK)) await LOADERS[kind](supabase, companyId, slice, lines)
    }),
  )
  return questions.map((refs) => refs.map((ref) => lines.get(keyOf(ref.kind, ref.id)) ?? missing(ref)))
}
