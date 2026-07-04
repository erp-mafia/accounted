import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { getPool, withUserContext } from '@/tests/pg/setup'
import { seedCompany } from '@/tests/pg/fixtures'

// Authorization tests for the invoice-number RPCs added in
// 20260510140000_harden_invoice_number_rpcs.sql. The functions are
// SECURITY DEFINER, so they bypass caller RLS. The migration added an inline
// auth.uid() membership check as defense-in-depth; these tests prove it.

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

async function insertDraftInvoice(params: {
  userId: string
  companyId: string
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
     VALUES ($1, $2, $3, $4, NULL, 'invoice',
             '2026-04-27', '2026-05-27', 'SEK', 1000, 250, 1250,
             'standard_25', 25, '10', 'draft')`,
    [invoiceId, params.userId, params.companyId, customerId],
  )
  return invoiceId
}

describe('invoice-number RPCs: authorization (defense in depth)', () => {
  it('peek_next_invoice_number raises when caller is not a member of the target company', async () => {
    const intruder = await seedCompany()
    const target = await seedCompany()
    await ensureCompanySettings({ userId: target.userId, companyId: target.companyId })

    await expect(
      withUserContext(intruder.userId, async (client) => {
        await client.query('SELECT public.peek_next_invoice_number($1, $2)', [
          target.companyId,
          'invoice',
        ])
      }),
    ).rejects.toThrow(/unauthorized/)
  })

  it('peek_next_invoice_number succeeds for a member of the target company', async () => {
    const { userId, companyId } = await seedCompany()
    await ensureCompanySettings({ userId, companyId, invoicePrefix: 'F', nextInvoiceNumber: 7 })

    const preview = await withUserContext(userId, async (client) => {
      const { rows } = await client.query<{ peek_next_invoice_number: string }>(
        'SELECT public.peek_next_invoice_number($1, $2)',
        [companyId, 'invoice'],
      )
      return rows[0]!.peek_next_invoice_number
    })

    expect(preview).toBe('F007')
  })

  it('generate_invoice_number raises when caller is not a member of the target company', async () => {
    const intruder = await seedCompany()
    const target = await seedCompany()
    await ensureCompanySettings({ userId: target.userId, companyId: target.companyId })
    const invoiceId = await insertDraftInvoice({
      userId: target.userId,
      companyId: target.companyId,
    })

    await expect(
      withUserContext(intruder.userId, async (client) => {
        await client.query('SELECT public.generate_invoice_number($1, $2, $3)', [
          target.companyId,
          invoiceId,
          'invoice',
        ])
      }),
    ).rejects.toThrow(/unauthorized/)
  })

  it('generate_invoice_number succeeds for a member of the target company', async () => {
    const { userId, companyId } = await seedCompany()
    await ensureCompanySettings({ userId, companyId, invoicePrefix: 'G', nextInvoiceNumber: 42 })
    const invoiceId = await insertDraftInvoice({ userId, companyId })

    const assigned = await withUserContext(userId, async (client) => {
      const { rows } = await client.query<{ generate_invoice_number: string }>(
        'SELECT public.generate_invoice_number($1, $2, $3)',
        [companyId, invoiceId, 'invoice'],
      )
      return rows[0]!.generate_invoice_number
    })

    expect(assigned).toBe('G042')
  })

  it('superuser (no JWT context) bypasses the membership check', async () => {
    // Service role / cron / pg-real seed paths run without a JWT. The
    // membership check is intentionally skipped when auth.uid() IS NULL:     // calling the RPC directly on the pool (no withUserContext) must still
    // succeed.
    const { userId, companyId } = await seedCompany()
    await ensureCompanySettings({ userId, companyId, invoicePrefix: 'F', nextInvoiceNumber: 1 })

    const { rows } = await getPool().query<{ peek_next_invoice_number: string }>(
      'SELECT public.peek_next_invoice_number($1, $2)',
      [companyId, 'invoice'],
    )
    expect(rows[0]!.peek_next_invoice_number).toBe('F001')
  })
})
