/**
 * Autogiro for a company: its agreement, its mandates, and the debit files it
 * uploads in its own bank. The report side (files from Bankgirot) is
 * ./import-report.ts.
 *
 * A debit names only the payee's bankgiro and the payer number; Bankgirot
 * finds the account in its own register. So existing mandates come along by
 * linking each payer number to its customer, and nothing here ever holds a
 * payer's account or personnummer. Which invoices are debited is decided by
 * invoices.autogiro_payer_number (migration 20261025084700_autogiro.sql): set
 * on the draft from the customer's active mandate and frozen at issue, so an
 * invoice is debited only when it told the customer so.
 *
 * Every function returns a result union instead of throwing for what the
 * person can fix: the route maps `code` through errorResponseFromCode.
 */
import { chunk as chunks } from '@/lib/utils'
import { createHash } from 'node:crypto'
import type { SupabaseClient } from '@supabase/supabase-js'
import { generateOcrReference, validateBankgiroNumber } from '@/lib/bankgiro/luhn'
import { fetchAllRows } from '@/lib/supabase/fetch-all'
import { roundOre } from '@/lib/money'
import { invoiceAmountDue } from '@/lib/invoices/amount-due'
import type { CompanySettings, Currency } from '@/types'
import { autogiroFile, debitSection, mandateSection, type AutogiroDebit, type AutogiroPayee } from './writer'
import { debitDateFor, debitReference, normalizePayerNumber } from './rules'

export type AutogiroFailure = { ok: false; code: string; details?: Record<string, unknown> }
export type AutogiroResult<T> = ({ ok: true } & T) | AutogiroFailure

export interface AutogiroSettings {
  customer_number: string
  /** Digits only. */
  bankgiro: string
}

export type MandateStatus = 'pending' | 'active' | 'cancelled' | 'rejected'
export type MandateSource = 'register' | 'notice' | 'internet_bank' | 'manual'

export interface AutogiroMandateRow {
  id: string
  customer_id: string | null
  payer_number: string
  status: MandateStatus
  source: MandateSource
  payer_name: string | null
  status_text: string | null
  status_changed_on: string | null
  created_at: string
}

export type DebitStatus = 'sent' | 'debited' | 'failed' | 'rejected' | 'cancelled' | 'refunded'

/** Why an autogiro invoice cannot go into a file now. */
export type DebitBlocker = 'mandate_not_active' | 'reference_unusable' | 'nothing_to_pay'

export interface DueAutogiroInvoice {
  invoice_id: string
  invoice_number: string | null
  customer_id: string | null
  customer_name: string | null
  payer_number: string
  mandate_id: string | null
  due_date: string
  /** The day the invoice went out: its first delivery, else its invoice date. */
  notice_date: string
  debit_date: string
  amount: number
  reference: string | null
  blocker: DebitBlocker | null
}

export const AUTOGIRO_STATUS_TEXT = {
  manual: 'Registrerat i Accounted som befintligt medgivande hos Bankgirot.',
  cancelledHere: 'Makulerat i Accounted. Ladda upp makuleringsfilen i banken.',
  withdrawn: 'Återkallad i Accounted innan Bankgirot rapporterade den.',
} as const

// ── Settings ────────────────────────────────────────────────────────────

export async function loadAutogiroSettings(supabase: SupabaseClient, companyId: string): Promise<AutogiroSettings | null> {
  const { data, error } = await supabase
    .from('autogiro_settings')
    .select('customer_number, bankgiro')
    .eq('company_id', companyId)
    .maybeSingle()
  if (error) throw error
  return (data as AutogiroSettings | null) ?? null
}

export async function saveAutogiroSettings(
  supabase: SupabaseClient,
  companyId: string,
  input: { customer_number: string; bankgiro: string },
): Promise<AutogiroResult<{ settings: AutogiroSettings }>> {
  const customerNumber = input.customer_number.replace(/\s/g, '')
  const bankgiro = input.bankgiro.replace(/[\s-]/g, '')
  if (!/^\d{1,6}$/.test(customerNumber)) {
    return { ok: false, code: 'AUTOGIRO_SETTINGS_INVALID', details: { field: 'customer_number' } }
  }
  if (!/^\d{7,8}$/.test(bankgiro) || !validateBankgiroNumber(bankgiro)) {
    return { ok: false, code: 'AUTOGIRO_SETTINGS_INVALID', details: { field: 'bankgiro' } }
  }
  const settings = { customer_number: customerNumber.replace(/^0+(?=\d)/, ''), bankgiro }
  const { error } = await supabase
    .from('autogiro_settings')
    .upsert({ company_id: companyId, customer_number: settings.customer_number, bankgiro: settings.bankgiro }, { onConflict: 'company_id' })
  if (error) throw error
  return { ok: true, settings }
}

/** The payee for the file writer. */
export function payeeOf(settings: AutogiroSettings): AutogiroPayee {
  return { customerNumber: settings.customer_number, bankgiro: settings.bankgiro }
}

// ── Mandates ────────────────────────────────────────────────────────────

export async function loadMandates(supabase: SupabaseClient, companyId: string): Promise<AutogiroMandateRow[]> {
  return fetchAllRows<AutogiroMandateRow>(({ from, to }) =>
    supabase
      .from('autogiro_mandates')
      .select('id, customer_id, payer_number, status, source, payer_name, status_text, status_changed_on, created_at')
      .eq('company_id', companyId)
      .order('created_at', { ascending: true })
      .order('id', { ascending: true })
      .range(from, to),
  )
}

async function customerBelongs(supabase: SupabaseClient, companyId: string, customerId: string): Promise<boolean> {
  const { data, error } = await supabase
    .from('customers')
    .select('id')
    .eq('id', customerId)
    .eq('company_id', companyId)
    .maybeSingle()
  if (error) throw error
  return !!data
}

async function activeMandateOf(
  supabase: SupabaseClient,
  companyId: string,
  customerId: string,
): Promise<{ id: string } | null> {
  const { data, error } = await supabase
    .from('autogiro_mandates')
    .select('id')
    .eq('company_id', companyId)
    .eq('customer_id', customerId)
    .eq('status', 'active')
    .maybeSingle()
  if (error) throw error
  return (data as { id: string } | null) ?? null
}

/**
 * A mandate the customer already gave on the company's bankgiro (moved from
 * another system), registered by its payer number. Bankgirot holds the
 * account; a wrong payer number shows as a rejected debit.
 */
export async function addExistingMandate(
  supabase: SupabaseClient,
  companyId: string,
  input: { customer_id: string; payer_number: string },
): Promise<AutogiroResult<{ mandate: AutogiroMandateRow }>> {
  const payerNumber = normalizePayerNumber(input.payer_number)
  if (!payerNumber) return { ok: false, code: 'AUTOGIRO_PAYER_NUMBER_INVALID' }
  if (!(await customerBelongs(supabase, companyId, input.customer_id))) {
    return { ok: false, code: 'AUTOGIRO_CUSTOMER_NOT_FOUND' }
  }
  if (await activeMandateOf(supabase, companyId, input.customer_id)) {
    return { ok: false, code: 'AUTOGIRO_CUSTOMER_HAS_MANDATE' }
  }
  const { data: existing, error: existingError } = await supabase
    .from('autogiro_mandates')
    .select('id, customer_id, payer_number, status, source, payer_name, status_text, status_changed_on, created_at')
    .eq('company_id', companyId)
    .eq('payer_number', payerNumber)
    .maybeSingle()
  if (existingError) throw existingError
  const row = existing as AutogiroMandateRow | null
  if (row && row.status === 'active' && row.customer_id && row.customer_id !== input.customer_id) {
    return { ok: false, code: 'AUTOGIRO_PAYER_NUMBER_TAKEN' }
  }
  const { data, error } = row
    ? await supabase
        .from('autogiro_mandates')
        .update({ customer_id: input.customer_id, status: 'active', status_text: AUTOGIRO_STATUS_TEXT.manual, status_changed_on: null })
        .eq('id', row.id)
        .eq('company_id', companyId)
        .select('id, customer_id, payer_number, status, source, payer_name, status_text, status_changed_on, created_at')
        .single()
    : await supabase
        .from('autogiro_mandates')
        .insert({
          company_id: companyId,
          payer_number: payerNumber,
          source: 'manual',
          customer_id: input.customer_id,
          status: 'active',
          status_text: AUTOGIRO_STATUS_TEXT.manual,
          status_changed_on: null,
        })
        .select('id, customer_id, payer_number, status, source, payer_name, status_text, status_changed_on, created_at')
        .single()
  if (error) throw error
  return { ok: true, mandate: data as AutogiroMandateRow }
}

/** Links a mandate to a customer, or unlinks it (null). */
export async function linkMandate(
  supabase: SupabaseClient,
  companyId: string,
  mandateId: string,
  customerId: string | null,
): Promise<AutogiroResult<{ mandate: AutogiroMandateRow }>> {
  const { data: current, error: loadError } = await supabase
    .from('autogiro_mandates')
    .select('id, customer_id, payer_number, status, source, payer_name, status_text, status_changed_on, created_at')
    .eq('id', mandateId)
    .eq('company_id', companyId)
    .maybeSingle()
  if (loadError) throw loadError
  const mandate = current as AutogiroMandateRow | null
  if (!mandate) return { ok: false, code: 'AUTOGIRO_MANDATE_NOT_FOUND' }
  if (customerId) {
    if (!(await customerBelongs(supabase, companyId, customerId))) return { ok: false, code: 'AUTOGIRO_CUSTOMER_NOT_FOUND' }
    if (mandate.status === 'active') {
      const other = await activeMandateOf(supabase, companyId, customerId)
      if (other && other.id !== mandateId) return { ok: false, code: 'AUTOGIRO_CUSTOMER_HAS_MANDATE' }
    }
  }
  const { data, error } = await supabase
    .from('autogiro_mandates')
    .update({ customer_id: customerId })
    .eq('id', mandateId)
    .eq('company_id', companyId)
    .select('id, customer_id, payer_number, status, source, payer_name, status_text, status_changed_on, created_at')
    .single()
  if (error) throw error
  return { ok: true, mandate: data as AutogiroMandateRow }
}

export interface WrittenFile {
  id: string
  filename: string
}

function sha256(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex')
}

/**
 * Cancels a mandate: Accounted stops debiting it at once, and the file that
 * tells Bankgirot (TK03, payer number only) is stored for download. The
 * customer's drafts drop Autogiro with it (the mandate trigger).
 */
export async function cancelMandate(
  supabase: SupabaseClient,
  companyId: string,
  userId: string,
  mandateId: string,
  today: string,
): Promise<AutogiroResult<{ mandate: AutogiroMandateRow; file: WrittenFile }>> {
  const settings = await loadAutogiroSettings(supabase, companyId)
  if (!settings) return { ok: false, code: 'AUTOGIRO_SETTINGS_MISSING' }
  const { data: current, error: loadError } = await supabase
    .from('autogiro_mandates')
    .select('id, customer_id, payer_number, status, source, payer_name, status_text, status_changed_on, created_at')
    .eq('id', mandateId)
    .eq('company_id', companyId)
    .maybeSingle()
  if (loadError) throw loadError
  const mandate = current as AutogiroMandateRow | null
  if (!mandate) return { ok: false, code: 'AUTOGIRO_MANDATE_NOT_FOUND' }
  if (mandate.status === 'cancelled' || mandate.status === 'rejected') {
    return { ok: false, code: 'AUTOGIRO_MANDATE_NOT_ACTIVE' }
  }

  const content = autogiroFile([mandateSection(payeeOf(settings), today, [{ kind: 'cancel', payerNumber: mandate.payer_number }])])
  const filename = `autogiro-makulering-${mandate.payer_number}-${today}.txt`
  const { data: file, error: fileError } = await supabase
    .from('autogiro_files')
    .insert({
      company_id: companyId,
      direction: 'to_bankgirot',
      kind: 'mandates',
      filename,
      file_hash: sha256(content),
      content,
      summary: { cancelled: 1, payer_number: mandate.payer_number },
      created_by: userId,
    })
    .select('id')
    .single()
  if (fileError) throw fileError

  const { data, error } = await supabase
    .from('autogiro_mandates')
    .update({ status: 'cancelled', status_text: AUTOGIRO_STATUS_TEXT.cancelledHere, status_changed_on: today })
    .eq('id', mandateId)
    .eq('company_id', companyId)
    .select('id, customer_id, payer_number, status, source, payer_name, status_text, status_changed_on, created_at')
    .single()
  if (error) throw error
  return { ok: true, mandate: data as AutogiroMandateRow, file: { id: (file as { id: string }).id, filename } }
}

// ── Invoices to debit ───────────────────────────────────────────────────

interface AutogiroInvoiceRow {
  id: string
  invoice_number: string | null
  invoice_date: string
  due_date: string
  status: string
  document_type: string | null
  credited_invoice_id: string | null
  total: number
  currency: Currency
  ore_rounding: boolean | null
  deduction_total: number | null
  paid_amount: number | null
  remaining_amount: number | null
  autogiro_payer_number: string
  customer_id: string | null
  customer: { name: string | null } | null
}

/** Issued statuses that still ask for money. */
const OPEN_STATUSES = ['sent', 'overdue', 'partially_paid']
const LIVE_DEBIT_STATUSES: DebitStatus[] = ['sent', 'debited']

/** Ids per `.in()` lookup. */
const ID_CHUNK = 100

/**
 * Every issued invoice that announced Autogiro and still asks for money, not
 * already in a live debit: what the next file can take, each with its payment
 * day and amount, or why it cannot go in now.
 */
export async function loadDueAutogiroInvoices(
  supabase: SupabaseClient,
  companyId: string,
  today: string,
  onlyInvoiceIds?: readonly string[],
): Promise<DueAutogiroInvoice[]> {
  const invoices = await fetchAllRows<AutogiroInvoiceRow>(({ from, to }) => {
    let query = supabase
      .from('invoices')
      .select(
        'id, invoice_number, invoice_date, due_date, status, document_type, credited_invoice_id, total, currency, ore_rounding, deduction_total, paid_amount, remaining_amount, autogiro_payer_number, customer_id, customer:customers(name)',
      )
      .eq('company_id', companyId)
      .not('autogiro_payer_number', 'is', null)
      .in('status', OPEN_STATUSES)
    if (onlyInvoiceIds) query = query.in('id', [...onlyInvoiceIds])
    return query.order('due_date', { ascending: true }).order('id', { ascending: true }).range(from, to) as unknown as PromiseLike<{
      data: AutogiroInvoiceRow[] | null
      error: { message: string } | null
    }>
  })
  if (invoices.length === 0) return []
  const ids = invoices.map((i) => i.id)

  const live = new Set<string>()
  const firstSent = new Map<string, string>()
  for (const part of chunks(ids, ID_CHUNK)) {
    const [{ data: debits, error: debitError }, { data: deliveries, error: deliveryError }] = await Promise.all([
      supabase.from('autogiro_debits').select('invoice_id').eq('company_id', companyId).in('invoice_id', part).in('status', LIVE_DEBIT_STATUSES),
      supabase.from('invoice_deliveries').select('invoice_id, sent_at').eq('company_id', companyId).in('invoice_id', part).not('sent_at', 'is', null),
    ])
    if (debitError) throw debitError
    if (deliveryError) throw deliveryError
    for (const d of (debits ?? []) as Array<{ invoice_id: string }>) live.add(d.invoice_id)
    for (const d of (deliveries ?? []) as Array<{ invoice_id: string; sent_at: string }>) {
      const day = d.sent_at.slice(0, 10)
      const prev = firstSent.get(d.invoice_id)
      if (!prev || day < prev) firstSent.set(d.invoice_id, day)
    }
  }

  const [{ data: mandates, error: mandateError }, { data: company, error: companyError }] = await Promise.all([
    supabase.from('autogiro_mandates').select('id, payer_number').eq('company_id', companyId).eq('status', 'active'),
    supabase.from('company_settings').select('ore_rounding').eq('company_id', companyId).maybeSingle(),
  ])
  if (mandateError) throw mandateError
  if (companyError) throw companyError
  const activeByPayer = new Map(((mandates ?? []) as Array<{ id: string; payer_number: string }>).map((m) => [m.payer_number, m.id]))

  const out: DueAutogiroInvoice[] = []
  for (const invoice of invoices) {
    if (live.has(invoice.id)) continue
    const noticeDate = firstSent.get(invoice.id) ?? invoice.invoice_date
    const amount = roundOre(invoiceAmountDue(invoice, company as Pick<CompanySettings, 'ore_rounding'> | null))
    const reference = invoice.invoice_number ? debitReference(generateOcrReference(invoice.invoice_number)) : null
    const mandateId = activeByPayer.get(invoice.autogiro_payer_number) ?? null
    const blocker: DebitBlocker | null = !mandateId
      ? 'mandate_not_active'
      : amount <= 0
        ? 'nothing_to_pay'
        : !reference
          ? 'reference_unusable'
          : null
    out.push({
      invoice_id: invoice.id,
      invoice_number: invoice.invoice_number,
      customer_id: invoice.customer_id,
      customer_name: invoice.customer?.name ?? null,
      payer_number: invoice.autogiro_payer_number,
      mandate_id: mandateId,
      due_date: invoice.due_date,
      notice_date: noticeDate,
      debit_date: debitDateFor({ dueDate: invoice.due_date, noticeDate, today }),
      amount,
      reference,
      blocker,
    })
  }
  return out
}

/**
 * Writes the debit file for the chosen invoices (or every debitable one):
 * one TK82 per invoice on its payment day, stored for download, each debit
 * recorded as sent. An invoice that cannot go in is reported, not written.
 */
export async function createDebitFile(
  supabase: SupabaseClient,
  companyId: string,
  userId: string,
  input: { invoice_ids?: readonly string[]; today: string },
): Promise<AutogiroResult<{ file: WrittenFile; debits: number; total: number; skipped: DueAutogiroInvoice[] }>> {
  const settings = await loadAutogiroSettings(supabase, companyId)
  if (!settings) return { ok: false, code: 'AUTOGIRO_SETTINGS_MISSING' }
  const due = await loadDueAutogiroInvoices(supabase, companyId, input.today, input.invoice_ids)
  const ready = due.filter((d) => d.blocker === null)
  const skipped = due.filter((d) => d.blocker !== null)
  if (ready.length === 0) return { ok: false, code: 'AUTOGIRO_NOTHING_TO_DEBIT', details: { skipped: skipped.length } }

  const debits: AutogiroDebit[] = ready.map((d) => ({
    date: d.debit_date,
    payerNumber: d.payer_number,
    amount: d.amount,
    reference: d.reference!,
  }))
  const content = autogiroFile([debitSection(payeeOf(settings), input.today, debits)])
  const total = roundOre(ready.reduce((sum, d) => sum + d.amount, 0))
  const dates = ready.map((d) => d.debit_date).sort()

  // The debits first: the one-live-debit index refuses an invoice another
  // request wrote a moment ago, before any file exists.
  const { data: inserted, error: debitError } = await supabase
    .from('autogiro_debits')
    .insert(
      ready.map((d) => ({
        company_id: companyId,
        invoice_id: d.invoice_id,
        mandate_id: d.mandate_id,
        payer_number: d.payer_number,
        amount: d.amount,
        debit_date: d.debit_date,
        reference: d.reference,
        status: 'sent',
      })),
    )
    .select('id')
  if (debitError) {
    if ((debitError as { code?: string }).code === '23505') return { ok: false, code: 'AUTOGIRO_DEBIT_ALREADY_LIVE' }
    throw debitError
  }
  const debitIds = ((inserted ?? []) as Array<{ id: string }>).map((r) => r.id)

  const filename = `autogiro-betalningar-${input.today}.txt`
  const { data: file, error: fileError } = await supabase
    .from('autogiro_files')
    .insert({
      company_id: companyId,
      direction: 'to_bankgirot',
      kind: 'debits',
      filename,
      file_hash: sha256(content),
      content,
      summary: { debits: ready.length, total, first_date: dates[0], last_date: dates[dates.length - 1] },
      created_by: userId,
    })
    .select('id')
    .single()
  if (fileError) {
    await supabase.from('autogiro_debits').update({ status: 'cancelled', status_text: AUTOGIRO_STATUS_TEXT.withdrawn }).in('id', debitIds)
    throw fileError
  }
  const fileId = (file as { id: string }).id
  const { error: linkError } = await supabase.from('autogiro_debits').update({ file_id: fileId }).in('id', debitIds).eq('company_id', companyId)
  if (linkError) throw linkError

  return { ok: true, file: { id: fileId, filename }, debits: ready.length, total, skipped }
}

/**
 * Withdraws a debit file Bankgirot has not reported on: its debits become
 * cancelled, so the invoices can go into a new file. It does not stop a file
 * already uploaded in the bank; the page says so.
 */
export async function withdrawDebitFile(
  supabase: SupabaseClient,
  companyId: string,
  fileId: string,
): Promise<AutogiroResult<{ cancelled: number }>> {
  const { data: file, error: fileError } = await supabase
    .from('autogiro_files')
    .select('id, kind, direction')
    .eq('id', fileId)
    .eq('company_id', companyId)
    .maybeSingle()
  if (fileError) throw fileError
  const row = file as { id: string; kind: string; direction: string } | null
  if (!row || row.kind !== 'debits' || row.direction !== 'to_bankgirot') return { ok: false, code: 'AUTOGIRO_FILE_NOT_FOUND' }

  const { data: debits, error: debitError } = await supabase
    .from('autogiro_debits')
    .select('id, status')
    .eq('company_id', companyId)
    .eq('file_id', fileId)
  if (debitError) throw debitError
  const rows = (debits ?? []) as Array<{ id: string; status: DebitStatus }>
  if (rows.some((d) => d.status !== 'sent' && d.status !== 'cancelled')) return { ok: false, code: 'AUTOGIRO_FILE_ALREADY_REPORTED' }
  const open = rows.filter((d) => d.status === 'sent').map((d) => d.id)
  if (open.length > 0) {
    const { error } = await supabase
      .from('autogiro_debits')
      .update({ status: 'cancelled', status_text: AUTOGIRO_STATUS_TEXT.withdrawn })
      .in('id', open)
      .eq('company_id', companyId)
      .eq('status', 'sent')
    if (error) throw error
  }
  return { ok: true, cancelled: open.length }
}

/** A stored file's text, for download. */
export async function loadStoredFile(
  supabase: SupabaseClient,
  companyId: string,
  fileId: string,
): Promise<AutogiroResult<{ filename: string; content: string }>> {
  const { data, error } = await supabase
    .from('autogiro_files')
    .select('filename, content')
    .eq('id', fileId)
    .eq('company_id', companyId)
    .maybeSingle()
  if (error) throw error
  const row = data as { filename: string | null; content: string | null } | null
  if (!row) return { ok: false, code: 'AUTOGIRO_FILE_NOT_FOUND' }
  if (row.content === null) return { ok: false, code: 'AUTOGIRO_FILE_NOT_STORED' }
  return { ok: true, filename: row.filename ?? 'autogiro.txt', content: row.content }
}

// ── The page ────────────────────────────────────────────────────────────

export interface AutogiroDebitRow {
  id: string
  invoice_id: string
  invoice_number: string | null
  customer_name: string | null
  payer_number: string
  amount: number
  debit_date: string
  reference: string
  status: DebitStatus
  status_text: string | null
  status_date: string | null
  file_id: string | null
}

export interface AutogiroFileRow {
  id: string
  direction: 'to_bankgirot' | 'from_bankgirot'
  kind: string
  filename: string | null
  stored: boolean
  summary: Record<string, unknown>
  created_at: string
}

export interface AutogiroOverview {
  settings: AutogiroSettings | null
  mandates: Array<AutogiroMandateRow & { customer_name: string | null }>
  due: DueAutogiroInvoice[]
  debits: AutogiroDebitRow[]
  files: AutogiroFileRow[]
}

/** Everything the Autogiro page shows: the agreement, mandates, what to debit, recent debits and files. */
export async function loadAutogiroOverview(supabase: SupabaseClient, companyId: string, today: string): Promise<AutogiroOverview> {
  const [settings, mandates, due, debitsResult, filesResult] = await Promise.all([
    loadAutogiroSettings(supabase, companyId),
    loadMandates(supabase, companyId),
    loadDueAutogiroInvoices(supabase, companyId, today),
    supabase
      .from('autogiro_debits')
      .select('id, invoice_id, payer_number, amount, debit_date, reference, status, status_text, status_date, file_id, invoice:invoices(invoice_number, customer:customers(name))')
      .eq('company_id', companyId)
      .order('debit_date', { ascending: false })
      .order('id', { ascending: true })
      .limit(200),
    supabase
      .from('autogiro_files')
      .select('id, direction, kind, filename, summary, created_at, stored:content')
      .eq('company_id', companyId)
      .order('created_at', { ascending: false })
      .limit(50),
  ])
  if (debitsResult.error) throw debitsResult.error
  if (filesResult.error) throw filesResult.error

  const customerIds = [...new Set(mandates.map((m) => m.customer_id).filter((id): id is string => !!id))]
  const names = new Map<string, string>()
  for (const part of chunks(customerIds, ID_CHUNK)) {
    const { data, error } = await supabase.from('customers').select('id, name').eq('company_id', companyId).in('id', part)
    if (error) throw error
    for (const c of (data ?? []) as Array<{ id: string; name: string }>) names.set(c.id, c.name)
  }

  type DebitJoin = Omit<AutogiroDebitRow, 'invoice_number' | 'customer_name'> & {
    invoice: { invoice_number: string | null; customer: { name: string | null } | null } | null
  }
  const debits = ((debitsResult.data ?? []) as unknown as DebitJoin[]).map(({ invoice, ...d }) => ({
    ...d,
    amount: Number(d.amount),
    invoice_number: invoice?.invoice_number ?? null,
    customer_name: invoice?.customer?.name ?? null,
  }))
  type FileJoin = Omit<AutogiroFileRow, 'stored'> & { stored: string | null }
  const files = ((filesResult.data ?? []) as unknown as FileJoin[]).map((f) => ({ ...f, stored: f.stored !== null }))

  return {
    settings,
    mandates: mandates.map((m) => ({ ...m, customer_name: m.customer_id ? (names.get(m.customer_id) ?? null) : null })),
    due,
    debits,
    files,
  }
}
