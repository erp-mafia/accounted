/**
 * Reads everything a kundförlust decision rests on, for one invoice: the
 * invoice row, the company's accounting method, the invoice's own posted
 * voucher and its credit notes' vouchers, the earlier decisions, and the
 * invoice's latest collection case. Pure derivations live in amounts.ts.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { roundOre } from '@/lib/money'
import {
  isReceivableAccount,
  openVatByAccount,
  reachedLedgerAsReceivable,
  receivableBasis,
  reserveOutstanding,
  liveConfirmed,
  type LedgerLine,
  type VatShare,
  type WriteOffRowLike,
} from './amounts'

export interface CustomerLossInvoice {
  id: string
  invoice_number: string | null
  status: string
  currency: string | null
  total: number
  paid_amount: number
  remaining_amount: number
  due_date: string | null
  journal_entry_id: string | null
  deduction_total: number
  document_type: string | null
  credited_invoice_id: string | null
}

export interface WriteOffRow extends WriteOffRowLike {
  invoice_id: string
  entry_date: string
  reason: string
  evidence_document_id: string | null
  case_id: string | null
  decided_by: string | null
  vat_by_rate: VatShare[]
}

export interface LatestCase {
  id: string
  /** collection_cases.stage (provider-neutral). */
  stage: string
  close_reason: string | null
  is_open: boolean
}

export interface CustomerLossState {
  invoice: CustomerLossInvoice
  accountingMethod: 'accrual' | 'cash'
  /** The invoice's own voucher is posted and put the claim on 151x. */
  booked: boolean
  /** The 151x account the invoice's voucher debited (1510 in practice). */
  receivableAccount: string
  /** Output VAT per account still standing on the invoice. */
  openVat: Map<string, number>
  /** The receivable the invoice put on 151x, net of credit notes. */
  basis: number
  rows: WriteOffRow[]
  reserve: number
  confirmed: WriteOffRow | null
  latestCase: LatestCase | null
}

const num = (v: unknown): number => roundOre(Number(v ?? 0) || 0)

export type LoadStateResult = { ok: true; state: CustomerLossState } | { ok: false; code: 'CUSTOMER_LOSS_INVOICE_NOT_FOUND' }

export async function loadCustomerLossState(
  supabase: SupabaseClient,
  companyId: string,
  invoiceId: string,
): Promise<LoadStateResult> {
  const { data: invoiceRow, error: invoiceError } = await supabase
    .from('invoices')
    .select(
      'id, invoice_number, status, currency, total, paid_amount, remaining_amount, due_date, journal_entry_id, deduction_total, document_type, credited_invoice_id',
    )
    .eq('company_id', companyId)
    .eq('id', invoiceId)
    .maybeSingle()
  if (invoiceError) throw new Error(`customer loss: invoice lookup failed: ${invoiceError.message}`)
  if (!invoiceRow) return { ok: false, code: 'CUSTOMER_LOSS_INVOICE_NOT_FOUND' }

  const invoice: CustomerLossInvoice = {
    id: invoiceRow.id,
    invoice_number: invoiceRow.invoice_number ?? null,
    status: invoiceRow.status,
    currency: invoiceRow.currency ?? null,
    total: num(invoiceRow.total),
    paid_amount: num(invoiceRow.paid_amount),
    remaining_amount: num(invoiceRow.remaining_amount),
    due_date: invoiceRow.due_date ?? null,
    journal_entry_id: invoiceRow.journal_entry_id ?? null,
    deduction_total: num(invoiceRow.deduction_total),
    document_type: invoiceRow.document_type ?? null,
    credited_invoice_id: invoiceRow.credited_invoice_id ?? null,
  }

  const [settings, ownLines, creditNoteLines, rows, latestCase] = await Promise.all([
    supabase.from('company_settings').select('accounting_method').eq('company_id', companyId).maybeSingle(),
    loadPostedLines(supabase, companyId, invoice.journal_entry_id ? [invoice.journal_entry_id] : []),
    loadCreditNoteLines(supabase, companyId, invoice.id),
    loadWriteOffRows(supabase, companyId, invoice.id),
    loadLatestCase(supabase, companyId, invoice.id),
  ])
  if (settings.error) throw new Error(`customer loss: settings lookup failed: ${settings.error.message}`)

  const booked = reachedLedgerAsReceivable(ownLines)
  const receivableAccount =
    ownLines.find((l) => isReceivableAccount(l.account_number) && Number(l.debit_amount ?? 0) > 0)?.account_number ??
    '1510'

  return {
    ok: true,
    state: {
      invoice,
      accountingMethod: settings.data?.accounting_method === 'cash' ? 'cash' : 'accrual',
      booked,
      receivableAccount,
      openVat: booked ? openVatByAccount(ownLines, creditNoteLines) : new Map(),
      basis: booked ? receivableBasis(ownLines, creditNoteLines) : 0,
      rows,
      reserve: reserveOutstanding(rows),
      confirmed: liveConfirmed(rows),
      latestCase,
    },
  }
}

/** Lines of the given vouchers, only while they are posted (a stornoed voucher no longer counts). */
async function loadPostedLines(supabase: SupabaseClient, companyId: string, entryIds: string[]): Promise<LedgerLine[]> {
  if (entryIds.length === 0) return []
  const { data, error } = await supabase
    .from('journal_entries')
    .select('id, status, lines:journal_entry_lines(account_number, debit_amount, credit_amount)')
    .eq('company_id', companyId)
    .in('id', entryIds)
  if (error) throw new Error(`customer loss: voucher lookup failed: ${error.message}`)
  const out: LedgerLine[] = []
  for (const entry of (data ?? []) as Array<{ status: string; lines: LedgerLine[] | null }>) {
    if (entry.status !== 'posted') continue
    out.push(...(entry.lines ?? []))
  }
  return out
}

async function loadCreditNoteLines(supabase: SupabaseClient, companyId: string, invoiceId: string): Promise<LedgerLine[]> {
  const { data, error } = await supabase
    .from('invoices')
    .select('id, journal_entry_id, status')
    .eq('company_id', companyId)
    .eq('credited_invoice_id', invoiceId)
  if (error) throw new Error(`customer loss: credit note lookup failed: ${error.message}`)
  const ids = ((data ?? []) as Array<{ journal_entry_id: string | null; status: string }>)
    .filter((cn) => cn.status !== 'draft' && cn.status !== 'cancelled' && cn.journal_entry_id)
    .map((cn) => cn.journal_entry_id as string)
  return loadPostedLines(supabase, companyId, ids)
}

export async function loadWriteOffRows(supabase: SupabaseClient, companyId: string, invoiceId: string): Promise<WriteOffRow[]> {
  const { data, error } = await supabase
    .from('invoice_write_offs')
    .select(
      'id, invoice_id, kind, entry_date, amount, net_amount, vat_amount, vat_by_rate, reserve_released, journal_entry_id, evidence_document_id, reason, case_id, reverses_id, decided_by, decided_at',
    )
    .eq('company_id', companyId)
    .eq('invoice_id', invoiceId)
    .order('decided_at', { ascending: true })
  if (error) throw new Error(`customer loss: decision lookup failed: ${error.message}`)
  return ((data ?? []) as WriteOffRow[]).map((row) => ({ ...row, vat_by_rate: Array.isArray(row.vat_by_rate) ? row.vat_by_rate : [] }))
}

async function loadLatestCase(supabase: SupabaseClient, companyId: string, invoiceId: string): Promise<LatestCase | null> {
  const { data, error } = await supabase
    .from('collection_cases')
    .select('id, stage, close_reason, is_open, created_at')
    .eq('company_id', companyId)
    .eq('invoice_id', invoiceId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (error) throw new Error(`customer loss: case lookup failed: ${error.message}`)
  if (!data) return null
  return {
    id: data.id,
    stage: String(data.stage),
    close_reason: (data.close_reason as string | null) ?? null,
    is_open: data.is_open === true,
  }
}
