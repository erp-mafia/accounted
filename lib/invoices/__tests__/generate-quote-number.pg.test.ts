import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { getPool } from '@/tests/pg/setup'
import { seedCompany } from '@/tests/pg/fixtures'

// Migration 20260902140000_invoice_quotes: the OF-series RPC, the widened
// document_type CHECK and the quote column pairing constraint.

async function ensureCompanySettings(params: {
  userId: string
  companyId: string
  nextQuoteNumber?: number
}): Promise<void> {
  await getPool().query(
    `INSERT INTO public.company_settings
       (user_id, company_id, invoice_prefix, next_invoice_number, next_quote_number)
     VALUES ($1, $2, 'F', 1, $3)
     ON CONFLICT (company_id) DO UPDATE
       SET next_quote_number = EXCLUDED.next_quote_number`,
    [params.userId, params.companyId, params.nextQuoteNumber ?? 1],
  )
}

async function insertCustomer(userId: string, companyId: string): Promise<string> {
  const customerId = randomUUID()
  await getPool().query(
    `INSERT INTO public.customers (id, user_id, company_id, name)
     VALUES ($1, $2, $3, 'Test Customer')`,
    [customerId, userId, companyId],
  )
  return customerId
}

async function insertInvoiceRow(params: {
  userId: string
  companyId: string
  customerId: string
  documentType: string
  invoiceNumber: string | null
  quoteStatus: string | null
  validUntil?: string | null
}): Promise<string> {
  const id = randomUUID()
  await getPool().query(
    `INSERT INTO public.invoices
       (id, user_id, company_id, customer_id, invoice_number, document_type,
        invoice_date, due_date, valid_until, quote_status, currency,
        subtotal, vat_amount, total, vat_treatment, vat_rate, moms_ruta, status)
     VALUES ($1, $2, $3, $4, $5, $6,
             '2026-06-01', '2026-07-01', $7, $8, 'SEK',
             1000, 250, 1250, 'standard_25', 25, '10', 'draft')`,
    [
      id,
      params.userId,
      params.companyId,
      params.customerId,
      params.invoiceNumber,
      params.documentType,
      params.validUntil ?? null,
      params.quoteStatus,
    ],
  )
  return id
}

async function readCounter(companyId: string): Promise<{ quote: number; invoice: number }> {
  const { rows } = await getPool().query<{ next_quote_number: number; next_invoice_number: number }>(
    'SELECT next_quote_number, next_invoice_number FROM public.company_settings WHERE company_id = $1',
    [companyId],
  )
  return { quote: rows[0]!.next_quote_number, invoice: rows[0]!.next_invoice_number }
}

describe('generate_quote_number RPC', () => {
  it('allocates OF-nnn from its own counter and leaves the F-series untouched', async () => {
    const { userId, companyId } = await seedCompany()
    await ensureCompanySettings({ userId, companyId, nextQuoteNumber: 1 })

    const first = await getPool().query<{ n: string }>(
      'SELECT public.generate_quote_number($1) AS n',
      [companyId],
    )
    const second = await getPool().query<{ n: string }>(
      'SELECT public.generate_quote_number($1) AS n',
      [companyId],
    )

    expect(first.rows[0]!.n).toBe('OF-001')
    expect(second.rows[0]!.n).toBe('OF-002')
    const counters = await readCounter(companyId)
    expect(counters.quote).toBe(3)
    expect(counters.invoice).toBe(1)
  })

  it('grows past three digits without truncation', async () => {
    const { userId, companyId } = await seedCompany()
    await ensureCompanySettings({ userId, companyId, nextQuoteNumber: 1234 })

    const { rows } = await getPool().query<{ n: string }>(
      'SELECT public.generate_quote_number($1) AS n',
      [companyId],
    )

    expect(rows[0]!.n).toBe('OF-1234')
  })

  it('raises when the company has no settings row', async () => {
    await expect(
      getPool().query('SELECT public.generate_quote_number($1)', [randomUUID()]),
    ).rejects.toThrow(/Company settings not found/)
  })

  it('is not executable by anon', async () => {
    const { rows } = await getPool().query<{ ok: boolean }>(
      `SELECT has_function_privilege('anon', 'public.generate_quote_number(uuid)', 'EXECUTE') AS ok`,
    )
    expect(rows[0]!.ok).toBe(false)
  })
})

describe('invoices quote columns', () => {
  it('accepts document_type quote with an open quote_status', async () => {
    const { userId, companyId } = await seedCompany()
    const customerId = await insertCustomer(userId, companyId)

    const id = await insertInvoiceRow({
      userId,
      companyId,
      customerId,
      documentType: 'quote',
      invoiceNumber: 'OF-001',
      quoteStatus: 'open',
      validUntil: '2026-07-01',
    })

    const { rows } = await getPool().query<{ document_type: string; quote_status: string; valid_until: string }>(
      'SELECT document_type, quote_status, valid_until::text FROM public.invoices WHERE id = $1',
      [id],
    )
    expect(rows[0]).toEqual({ document_type: 'quote', quote_status: 'open', valid_until: '2026-07-01' })
  })

  it('rejects a quote without quote_status and a non-quote with one', async () => {
    const { userId, companyId } = await seedCompany()
    const customerId = await insertCustomer(userId, companyId)

    await expect(
      insertInvoiceRow({
        userId,
        companyId,
        customerId,
        documentType: 'quote',
        invoiceNumber: 'OF-002',
        quoteStatus: null,
      }),
    ).rejects.toThrow(/invoices_quote_columns_check/)

    await expect(
      insertInvoiceRow({
        userId,
        companyId,
        customerId,
        documentType: 'invoice',
        invoiceNumber: null,
        quoteStatus: 'open',
      }),
    ).rejects.toThrow(/invoices_quote_columns_check/)
  })

  it('rejects an unknown quote_status and an unknown document_type', async () => {
    const { userId, companyId } = await seedCompany()
    const customerId = await insertCustomer(userId, companyId)

    await expect(
      insertInvoiceRow({
        userId,
        companyId,
        customerId,
        documentType: 'quote',
        invoiceNumber: 'OF-003',
        quoteStatus: 'expired',
      }),
    ).rejects.toThrow(/invoices_quote_status_check/)

    await expect(
      insertInvoiceRow({
        userId,
        companyId,
        customerId,
        documentType: 'estimate',
        invoiceNumber: null,
        quoteStatus: null,
      }),
    ).rejects.toThrow(/invoices_document_type_check/)
  })
})
