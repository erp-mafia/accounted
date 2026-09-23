import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { getPool } from '@/tests/pg/setup'
import { seedCompany } from '@/tests/pg/fixtures'

// Insert a customer + draft invoice (invoice_number=null) and return the invoice id.
async function insertDraftInvoice(params: {
  userId: string
  companyId: string
  documentType?: 'invoice' | 'proforma'
}): Promise<string> {
  const customerId = randomUUID()
  await getPool().query(
    `INSERT INTO public.customers (id, user_id, company_id, name)
     VALUES ($1, $2, $3, 'Test Customer')`,
    [customerId, params.userId, params.companyId],
  )

  const invoiceId = randomUUID()
  await getPool().query(
    `INSERT INTO public.invoices
       (id, user_id, company_id, customer_id, invoice_number, document_type,
        invoice_date, due_date, currency, subtotal, vat_amount, total,
        vat_treatment, vat_rate, moms_ruta, status)
     VALUES ($1, $2, $3, $4, NULL, $5,
             '2026-04-27', '2026-05-27', 'SEK', 1000, 250, 1250,
             'standard_25', 25, '10', 'draft')`,
    [invoiceId, params.userId, params.companyId, customerId, params.documentType ?? 'invoice'],
  )
  return invoiceId
}

async function ensureCompanySettings(params: {
  userId: string
  companyId: string
  invoicePrefix?: string
  nextInvoiceNumber?: number
}): Promise<void> {
  await getPool().query(
    `INSERT INTO public.company_settings
       (user_id, company_id, invoice_prefix, next_invoice_number)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (company_id) DO UPDATE
       SET invoice_prefix = EXCLUDED.invoice_prefix,
           next_invoice_number = EXCLUDED.next_invoice_number`,
    [params.userId, params.companyId, params.invoicePrefix ?? 'F', params.nextInvoiceNumber ?? 1],
  )
}

async function readCounter(companyId: string): Promise<number> {
  const { rows } = await getPool().query<{ next_invoice_number: number }>(
    'SELECT next_invoice_number FROM public.company_settings WHERE company_id = $1',
    [companyId],
  )
  return rows[0]!.next_invoice_number
}

describe('generate_invoice_number RPC', () => {
  it('assigns a number to a draft and persists it on the invoice row', async () => {
    const { userId, companyId } = await seedCompany()
    await ensureCompanySettings({ userId, companyId, invoicePrefix: 'F', nextInvoiceNumber: 1 })
    const invoiceId = await insertDraftInvoice({ userId, companyId })

    const { rows } = await getPool().query<{ generate_invoice_number: string }>(
      'SELECT public.generate_invoice_number($1, $2, $3)',
      [companyId, invoiceId, 'invoice'],
    )

    const assigned = rows[0]!.generate_invoice_number
    expect(assigned).toBe('F001')

    const persisted = await getPool().query<{ invoice_number: string }>(
      'SELECT invoice_number FROM public.invoices WHERE id = $1',
      [invoiceId],
    )
    expect(persisted.rows[0]!.invoice_number).toBe(assigned)
  })

  it('produces a PF- prefix when document_type is proforma', async () => {
    const { userId, companyId } = await seedCompany()
    await ensureCompanySettings({ userId, companyId, invoicePrefix: 'F', nextInvoiceNumber: 42 })
    const invoiceId = await insertDraftInvoice({ userId, companyId, documentType: 'proforma' })

    const { rows } = await getPool().query<{ generate_invoice_number: string }>(
      'SELECT public.generate_invoice_number($1, $2, $3)',
      [companyId, invoiceId, 'proforma'],
    )

    expect(rows[0]!.generate_invoice_number).toBe('PF-042')
  })

  it('is idempotent: a second call on the same invoice returns the same number without bumping the counter', async () => {
    const { userId, companyId } = await seedCompany()
    await ensureCompanySettings({ userId, companyId, invoicePrefix: 'F', nextInvoiceNumber: 10 })
    const invoiceId = await insertDraftInvoice({ userId, companyId })

    const first = await getPool().query<{ generate_invoice_number: string }>(
      'SELECT public.generate_invoice_number($1, $2, $3)',
      [companyId, invoiceId, 'invoice'],
    )
    const counterAfterFirst = await readCounter(companyId)

    const second = await getPool().query<{ generate_invoice_number: string }>(
      'SELECT public.generate_invoice_number($1, $2, $3)',
      [companyId, invoiceId, 'invoice'],
    )
    const counterAfterSecond = await readCounter(companyId)

    expect(second.rows[0]!.generate_invoice_number).toBe(first.rows[0]!.generate_invoice_number)
    expect(counterAfterSecond).toBe(counterAfterFirst)
  })

  it('serializes concurrent calls on the same invoice: both see the same number, counter advances by 1', async () => {
    const { userId, companyId } = await seedCompany()
    await ensureCompanySettings({ userId, companyId, invoicePrefix: 'F', nextInvoiceNumber: 100 })
    const invoiceId = await insertDraftInvoice({ userId, companyId })
    const counterBefore = await readCounter(companyId)

    // Race two RPC calls on dedicated clients so they really execute in parallel.
    const a = getPool()
      .connect()
      .then(async (c) => {
        try {
          const { rows } = await c.query<{ generate_invoice_number: string }>(
            'SELECT public.generate_invoice_number($1, $2, $3)',
            [companyId, invoiceId, 'invoice'],
          )
          return rows[0]!.generate_invoice_number
        } finally {
          c.release()
        }
      })
    const b = getPool()
      .connect()
      .then(async (c) => {
        try {
          const { rows } = await c.query<{ generate_invoice_number: string }>(
            'SELECT public.generate_invoice_number($1, $2, $3)',
            [companyId, invoiceId, 'invoice'],
          )
          return rows[0]!.generate_invoice_number
        } finally {
          c.release()
        }
      })

    const [resultA, resultB] = await Promise.all([a, b])
    const counterAfter = await readCounter(companyId)

    expect(resultA).toBe(resultB)
    expect(counterAfter - counterBefore).toBe(1)
  })

  it('different invoices in the same company get distinct sequential numbers', async () => {
    const { userId, companyId } = await seedCompany()
    await ensureCompanySettings({ userId, companyId, invoicePrefix: 'F', nextInvoiceNumber: 200 })

    const invoiceA = await insertDraftInvoice({ userId, companyId })
    const invoiceB = await insertDraftInvoice({ userId, companyId })

    const a = await getPool().query<{ generate_invoice_number: string }>(
      'SELECT public.generate_invoice_number($1, $2, $3)',
      [companyId, invoiceA, 'invoice'],
    )
    const b = await getPool().query<{ generate_invoice_number: string }>(
      'SELECT public.generate_invoice_number($1, $2, $3)',
      [companyId, invoiceB, 'invoice'],
    )

    expect(a.rows[0]!.generate_invoice_number).toBe('F200')
    expect(b.rows[0]!.generate_invoice_number).toBe('F201')
  })

  it('uses bare number when invoice_prefix is null (no implicit year prefix)', async () => {
    const { userId, companyId } = await seedCompany()
    // Mirror the C by Sea bug report: user set next_invoice_number=10159 with
    // no prefix, expected '10159', got '2026101' under the old year-prefix
    // bug. After the fix the bare number is what they get.
    await ensureCompanySettings({ userId, companyId, invoicePrefix: undefined, nextInvoiceNumber: 10159 })
    await getPool().query(
      'UPDATE public.company_settings SET invoice_prefix = NULL WHERE company_id = $1',
      [companyId],
    )
    const invoiceId = await insertDraftInvoice({ userId, companyId })

    const { rows } = await getPool().query<{ generate_invoice_number: string }>(
      'SELECT public.generate_invoice_number($1, $2, $3)',
      [companyId, invoiceId, 'invoice'],
    )
    expect(rows[0]!.generate_invoice_number).toBe('10159')
  })

  it('does not zero-pad numbers that exceed three digits', async () => {
    const { userId, companyId } = await seedCompany()
    await ensureCompanySettings({ userId, companyId, invoicePrefix: 'F-', nextInvoiceNumber: 10159 })
    const invoiceId = await insertDraftInvoice({ userId, companyId })

    const { rows } = await getPool().query<{ generate_invoice_number: string }>(
      'SELECT public.generate_invoice_number($1, $2, $3)',
      [companyId, invoiceId, 'invoice'],
    )
    expect(rows[0]!.generate_invoice_number).toBe('F-10159')
  })

  it('raises when the invoice id does not belong to the company', async () => {
    const { userId, companyId } = await seedCompany()
    await ensureCompanySettings({ userId, companyId })
    const otherCompany = await seedCompany()
    const invoiceId = await insertDraftInvoice({
      userId: otherCompany.userId,
      companyId: otherCompany.companyId,
    })

    await expect(
      getPool().query('SELECT public.generate_invoice_number($1, $2, $3)', [
        companyId,
        invoiceId,
        'invoice',
      ]),
    ).rejects.toThrow(/Invoice .* not found/)
  })
})
