/**
 * Fixtures for the kontantmetod year-end carry suites (#3440,
 * 20261018131100 / 20261018131110). A cash-method company with the closing
 * year 2026 and the next year 2027 open, customer and supplier invoices, the
 * per-invoice carry verifikat and the storno the engine's reverseEntry
 * writes. All writes go through the superuser pool with every accounting
 * guard enabled (draft, lines, post), like tests/pg/fixtures.ts.
 */
import { randomUUID } from 'node:crypto'
import type { PoolClient } from 'pg'
import { getPool } from './setup'
import {
  insertFiscalPeriod,
  insertPostedJournalEntry,
  seedCompany,
  type PostedJournalEntryLine,
} from './fixtures'

export const PERIOD_END = '2026-12-31'

export interface CashCompany {
  userId: string
  companyId: string
  /** The closing year, 2026. */
  fiscalPeriodId: string
  /** The next year, 2027. */
  nextPeriodId: string
}

let seq = 0
/** Unique per run and within it, for voucher and document numbers. */
export function nextSeq(): number {
  return (Date.now() % 1_000_000) * 1000 + seq++
}

export async function seedCashCompany(
  method: 'cash' | 'accrual' = 'cash',
  opts: { sandbox?: boolean } = {},
): Promise<CashCompany> {
  const seeded = await seedCompany()
  await getPool().query(
    `INSERT INTO public.company_settings (user_id, company_id, accounting_method, is_sandbox)
     VALUES ($1, $2, $3, $4)`,
    [seeded.userId, seeded.companyId, method, opts.sandbox ?? false],
  )
  const nextPeriodId = await insertFiscalPeriod({
    userId: seeded.userId,
    companyId: seeded.companyId,
    name: '2027',
    periodStart: '2027-01-01',
    periodEnd: '2027-12-31',
  })
  return { ...seeded, nextPeriodId }
}

export async function insertCustomerInvoice(
  company: CashCompany,
  params: {
    subtotal?: number
    vat?: number
    invoiceDate?: string
    status?: string
    creditedInvoiceId?: string | null
    currency?: string
    exchangeRate?: number | null
    totalSek?: number | null
  } = {},
): Promise<string> {
  const customerId = randomUUID()
  await getPool().query(
    `INSERT INTO public.customers (id, user_id, company_id, name, customer_type)
     VALUES ($1, $2, $3, 'Kund AB', 'swedish_business')`,
    [customerId, company.userId, company.companyId],
  )
  const id = randomUUID()
  const subtotal = params.subtotal ?? 1000
  const vat = params.vat ?? 250
  const total = Math.round((subtotal + vat) * 100) / 100
  await getPool().query(
    `INSERT INTO public.invoices
       (id, user_id, company_id, customer_id, invoice_number, invoice_date, due_date,
        currency, exchange_rate, subtotal, vat_amount, total, total_sek,
        vat_treatment, vat_rate, status, paid_amount, remaining_amount, credited_invoice_id)
     VALUES ($1, $2, $3, $4, $5, $6, '2027-01-31',
             $7, $8, $9, $10, $11, $12, 'standard_25', 25, $13, 0, $11, $14)`,
    [
      id,
      company.userId,
      company.companyId,
      customerId,
      `F-${nextSeq()}`,
      params.invoiceDate ?? '2026-11-15',
      params.currency ?? 'SEK',
      params.exchangeRate ?? null,
      subtotal,
      vat,
      total,
      params.totalSek ?? null,
      params.status ?? 'sent',
      params.creditedInvoiceId ?? null,
    ],
  )
  return id
}

export async function insertSupplierInvoice(
  company: CashCompany,
  params: {
    subtotal?: number
    vat?: number
    invoiceDate?: string
    isCreditNote?: boolean
    creditedInvoiceId?: string | null
  } = {},
): Promise<string> {
  const supplierId = randomUUID()
  await getPool().query(
    `INSERT INTO public.suppliers
       (id, user_id, company_id, name, supplier_type, country, default_payment_terms, default_currency)
     VALUES ($1, $2, $3, 'Leverantör AB', 'swedish_business', 'SE', 30, 'SEK')`,
    [supplierId, company.userId, company.companyId],
  )
  const id = randomUUID()
  const subtotal = params.subtotal ?? 400
  const vat = params.vat ?? 100
  const total = Math.round((subtotal + vat) * 100) / 100
  const arrivalNumber = nextSeq()
  await getPool().query(
    `INSERT INTO public.supplier_invoices
       (id, user_id, company_id, supplier_id, arrival_number, supplier_invoice_number,
        invoice_date, due_date, received_date, status, currency, exchange_rate,
        subtotal, vat_amount, total, paid_amount, remaining_amount,
        vat_treatment, reverse_charge, is_credit_note, credited_invoice_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, '2027-01-31', $7, $13, 'SEK', NULL,
             $8, $9, $10, 0, $10, 'standard_25', false, $11, $12)`,
    [
      id,
      company.userId,
      company.companyId,
      supplierId,
      arrivalNumber,
      `LF-${arrivalNumber}`,
      params.invoiceDate ?? '2026-11-20',
      subtotal,
      vat,
      total,
      params.isCreditNote ?? false,
      params.creditedInvoiceId ?? null,
      // A supplier credit note never takes the payable lifecycle states
      // (supplier_invoices_credit_note_not_payable).
      params.isCreditNote ? 'credited' : 'registered',
    ],
  )
  return id
}

/** Customer carry C: Dr 1510 1250 / Cr 3001 1000 / Cr 2611 250. */
export const CUSTOMER_CARRY_LINES: PostedJournalEntryLine[] = [
  { accountNumber: '1510', debitAmount: 1250, creditAmount: 0 },
  { accountNumber: '3001', debitAmount: 0, creditAmount: 1000 },
  { accountNumber: '2611', debitAmount: 0, creditAmount: 250 },
]

/** Supplier carry C_s: Dr 6110 400 / Dr 2641 100 / Cr 2440 500. */
export const SUPPLIER_CARRY_LINES: PostedJournalEntryLine[] = [
  { accountNumber: '6110', debitAmount: 400, creditAmount: 0 },
  { accountNumber: '2641', debitAmount: 100, creditAmount: 0 },
  { accountNumber: '2440', debitAmount: 0, creditAmount: 500 },
]

/** A posted per-invoice carry verifikat (not yet marked or linked). */
export async function postCarry(
  company: CashCompany,
  params: {
    lines?: PostedJournalEntryLine[]
    supplier?: boolean
    entryDate?: string
    sourceType?: string
    sourceId?: string | null
    fiscalPeriodId?: string
    description?: string
  } = {},
): Promise<string> {
  return insertPostedJournalEntry({
    userId: company.userId,
    companyId: company.companyId,
    fiscalPeriodId: params.fiscalPeriodId ?? company.fiscalPeriodId,
    voucherNumber: nextSeq() % 1_000_000_000,
    entryDate: params.entryDate ?? PERIOD_END,
    description:
      params.description ??
      (params.supplier
        ? 'Leverantörsfaktura LF-1: obetald vid bokslut (kontantmetoden)'
        : 'Kundfaktura F-1: obetald vid bokslut (kontantmetoden)'),
    sourceType: params.sourceType ?? 'year_end',
    sourceId: params.sourceId === undefined ? company.fiscalPeriodId : params.sourceId,
    lines: params.lines ?? (params.supplier ? SUPPLIER_CARRY_LINES : CUSTOMER_CARRY_LINES),
  })
}

export interface LinkResult {
  ok: boolean
  code?: string
  marker_id?: string
  kind?: string
  journal_entry_id?: string
  details?: Record<string, unknown>
}

const RECORD_LINK = `SELECT public.record_kontantmetod_cutoff_link($1, $2, $3, $4, $5) AS result`

/** record_kontantmetod_cutoff_link, on the given client or the superuser pool. */
export async function recordLink(
  company: CashCompany,
  params: { journalEntryId: string; invoiceId?: string; supplierInvoiceId?: string },
  client?: PoolClient,
): Promise<LinkResult> {
  const runner = client ?? getPool()
  const { rows } = await runner.query<{ result: LinkResult }>(RECORD_LINK, [
    company.companyId,
    company.fiscalPeriodId,
    params.journalEntryId,
    params.invoiceId ?? null,
    params.supplierInvoiceId ?? null,
  ])
  return rows[0].result
}

/** Post a carry and mark + link it in one go: a live carry. */
export async function carryCustomerInvoice(
  company: CashCompany,
  invoiceId: string,
  lines: PostedJournalEntryLine[] = CUSTOMER_CARRY_LINES,
): Promise<string> {
  const carryId = await postCarry(company, { lines })
  const result = await recordLink(company, { journalEntryId: carryId, invoiceId })
  if (!result.ok) throw new Error(`carry link failed: ${JSON.stringify(result)}`)
  return carryId
}

export async function carrySupplierInvoice(
  company: CashCompany,
  supplierInvoiceId: string,
  lines: PostedJournalEntryLine[] = SUPPLIER_CARRY_LINES,
): Promise<string> {
  const carryId = await postCarry(company, { lines, supplier: true })
  const result = await recordLink(company, { journalEntryId: carryId, supplierInvoiceId })
  if (!result.ok) throw new Error(`carry link failed: ${JSON.stringify(result)}`)
  return carryId
}

/**
 * The storno reverseEntry writes, first half: a posted mirror (source_type
 * 'storno', reverses_id) dated `date`. Committed on its own, exactly as the
 * engine does, so a refused CAS (markReversed) leaves it posted and the
 * original intact.
 */
export async function postStorno(
  company: CashCompany,
  entryId: string,
  params: { date?: string; fiscalPeriodId?: string } = {},
): Promise<string> {
  const stornoId = randomUUID()
  const client = await getPool().connect()
  try {
    await client.query('BEGIN')
    await client.query(
      `INSERT INTO public.journal_entries
         (id, user_id, company_id, fiscal_period_id, voucher_number, voucher_series,
          entry_date, description, source_type, source_id, reverses_id, status)
       SELECT $1, e.user_id, e.company_id, $2, $3, 'A', $4,
              'Makulering: ' || e.description, 'storno', e.source_id, e.id, 'draft'
       FROM public.journal_entries e WHERE e.id = $5`,
      [
        stornoId,
        params.fiscalPeriodId ?? company.fiscalPeriodId,
        nextSeq() % 1_000_000_000,
        params.date ?? PERIOD_END,
        entryId,
      ],
    )
    await client.query(
      `INSERT INTO public.journal_entry_lines
         (journal_entry_id, account_number, debit_amount, credit_amount, currency, sort_order)
       SELECT $1, l.account_number, l.credit_amount, l.debit_amount, l.currency, l.sort_order
       FROM public.journal_entry_lines l WHERE l.journal_entry_id = $2`,
      [stornoId, entryId],
    )
    await client.query(`UPDATE public.journal_entries SET status = 'posted' WHERE id = $1`, [stornoId])
    await client.query('COMMIT')
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {})
    throw error
  } finally {
    client.release()
  }
  return stornoId
}

/** reverseEntry's second half: the CAS that marks the original reversed. */
export async function markReversed(entryId: string, stornoId: string): Promise<void> {
  await getPool().query(
    `UPDATE public.journal_entries
        SET status = 'reversed', reversed_by_id = $1
      WHERE id = $2 AND status = 'posted'`,
    [stornoId, entryId],
  )
}

/** Both halves: a storno of `entryId` dated `date`. */
export async function stornoEntry(
  company: CashCompany,
  entryId: string,
  params: { date?: string; fiscalPeriodId?: string } = {},
): Promise<string> {
  const stornoId = await postStorno(company, entryId, params)
  await markReversed(entryId, stornoId)
  return stornoId
}

export async function entryStatus(entryId: string): Promise<string> {
  const { rows } = await getPool().query<{ status: string }>(
    `SELECT status FROM public.journal_entries WHERE id = $1`,
    [entryId],
  )
  return rows[0].status
}

export async function invoiceLink(invoiceId: string): Promise<string | null> {
  const { rows } = await getPool().query<{ journal_entry_id: string | null }>(
    `SELECT journal_entry_id FROM public.invoices WHERE id = $1`,
    [invoiceId],
  )
  return rows[0].journal_entry_id
}

export async function supplierInvoiceLink(id: string): Promise<string | null> {
  const { rows } = await getPool().query<{ registration_journal_entry_id: string | null }>(
    `SELECT registration_journal_entry_id FROM public.supplier_invoices WHERE id = $1`,
    [id],
  )
  return rows[0].registration_journal_entry_id
}

export async function markerKinds(companyId: string): Promise<string[]> {
  const { rows } = await getPool().query<{ kind: string }>(
    `SELECT kind FROM public.kontantmetod_cutoff_entries WHERE company_id = $1 ORDER BY kind`,
    [companyId],
  )
  return rows.map((row) => row.kind)
}

export async function liveCarry(
  invoiceId: string | null,
  supplierInvoiceId: string | null,
): Promise<string[]> {
  const { rows } = await getPool().query<{ journal_entry_id: string }>(
    `SELECT journal_entry_id FROM public.kontantmetod_live_carry($1, $2)`,
    [invoiceId, supplierInvoiceId],
  )
  return rows.map((row) => row.journal_entry_id)
}

export async function insertInvoicePaymentRow(
  company: CashCompany,
  invoiceId: string,
  paymentDate: string,
  amount = 1250,
): Promise<string> {
  const { rows } = await getPool().query<{ id: string }>(
    `INSERT INTO public.invoice_payments
       (user_id, company_id, invoice_id, payment_date, amount, currency)
     VALUES ($1, $2, $3, $4, $5, 'SEK') RETURNING id`,
    [company.userId, company.companyId, invoiceId, paymentDate, amount],
  )
  return rows[0].id
}

export async function insertSupplierPaymentRow(
  company: CashCompany,
  supplierInvoiceId: string,
  paymentDate: string,
  amount = 500,
): Promise<string> {
  const { rows } = await getPool().query<{ id: string }>(
    `INSERT INTO public.supplier_invoice_payments
       (user_id, company_id, supplier_invoice_id, payment_date, amount, currency)
     VALUES ($1, $2, $3, $4, $5, 'SEK') RETURNING id`,
    [company.userId, company.companyId, supplierInvoiceId, paymentDate, amount],
  )
  return rows[0].id
}
