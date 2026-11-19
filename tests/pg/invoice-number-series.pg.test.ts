import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { getClient, getPool, withUserContext } from '@/tests/pg/setup'
import { seedCompany } from '@/tests/pg/fixtures'

// 20261012161600_invoice_number_series_from_invoices.sql: the invoices decide
// where a company's own series stands, a number is unique by value (1 and 001
// are one löpnummer), and a number is never issued under a higher one in the
// same series (ML 17 kap 24 § p. 2).

interface PgError {
  code?: string
  message?: string
  detail?: string
}

async function ensureCompanySettings(params: {
  userId: string
  companyId: string
  invoicePrefix?: string | null
  nextInvoiceNumber?: number
}): Promise<void> {
  await getPool().query(
    `INSERT INTO public.company_settings
       (user_id, company_id, invoice_prefix, next_invoice_number)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (company_id) DO UPDATE
       SET invoice_prefix = EXCLUDED.invoice_prefix,
           next_invoice_number = EXCLUDED.next_invoice_number`,
    [params.userId, params.companyId, params.invoicePrefix ?? null, params.nextInvoiceNumber ?? 1],
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

/** An invoice row, numbered (an imported one) or not (a draft to issue). */
async function insertInvoice(params: {
  userId: string
  companyId: string
  invoiceNumber?: string | null
  documentType?: 'invoice' | 'proforma'
  createdAt?: string
}): Promise<string> {
  const customerId = await insertCustomer(params.userId, params.companyId)
  const invoiceId = randomUUID()
  await getPool().query(
    `INSERT INTO public.invoices
       (id, user_id, company_id, customer_id, invoice_number, document_type,
        invoice_date, due_date, currency, subtotal, vat_amount, total,
        vat_treatment, vat_rate, moms_ruta, status, created_at)
     VALUES ($1, $2, $3, $4, $5, $6,
             '2026-10-12', '2026-11-11', 'SEK', 1000, 250, 1250,
             'standard_25', 25, '10', 'draft', COALESCE($7::timestamptz, now()))`,
    [
      invoiceId,
      params.userId,
      params.companyId,
      customerId,
      params.invoiceNumber ?? null,
      params.documentType ?? 'invoice',
      params.createdAt ?? null,
    ],
  )
  return invoiceId
}

async function importNumbers(userId: string, companyId: string, numbers: string[]): Promise<void> {
  for (const invoiceNumber of numbers) {
    await insertInvoice({ userId, companyId, invoiceNumber })
  }
}

async function generate(companyId: string, invoiceId: string, documentType = 'invoice'): Promise<string> {
  const { rows } = await getPool().query<{ generate_invoice_number: string }>(
    'SELECT public.generate_invoice_number($1, $2, $3)',
    [companyId, invoiceId, documentType],
  )
  return rows[0]!.generate_invoice_number
}

async function generateError(companyId: string, invoiceId: string): Promise<PgError> {
  try {
    await generate(companyId, invoiceId)
  } catch (err) {
    return err as PgError
  }
  throw new Error('generate_invoice_number was expected to refuse')
}

async function readCounters(companyId: string): Promise<{ invoice: number; proforma: number }> {
  const { rows } = await getPool().query<{ next_invoice_number: number; next_proforma_number: number }>(
    'SELECT next_invoice_number, next_proforma_number FROM public.company_settings WHERE company_id = $1',
    [companyId],
  )
  return { invoice: rows[0]!.next_invoice_number, proforma: rows[0]!.next_proforma_number }
}

async function numberOf(invoiceId: string): Promise<string | null> {
  const { rows } = await getPool().query<{ invoice_number: string | null }>(
    'SELECT invoice_number FROM public.invoices WHERE id = $1',
    [invoiceId],
  )
  return rows[0]!.invoice_number
}

async function status(
  companyId: string,
  proposal: { prefix?: string; nextNumber?: number } = {},
): Promise<Record<string, unknown>> {
  const { rows } = await getPool().query<{ s: Record<string, unknown> }>(
    'SELECT public.invoice_number_series_status($1, $2, $3, $4) AS s',
    [companyId, 'invoice', proposal.prefix ?? null, proposal.nextNumber ?? null],
  )
  return rows[0]!.s
}

async function insertError(params: Parameters<typeof insertInvoice>[0]): Promise<PgError> {
  try {
    await insertInvoice(params)
  } catch (err) {
    return err as PgError
  }
  throw new Error('the insert was expected to fail')
}

describe('generate_invoice_number: the invoices decide where the series stands', () => {
  it('skips numbers an import already used at the end of the series (crm case: counter set onto 667)', async () => {
    const { userId, companyId } = await seedCompany()
    await ensureCompanySettings({ userId, companyId, nextInvoiceNumber: 667 })
    await importNumbers(userId, companyId, ['665', '666', '667', '668'])

    const draft = await insertInvoice({ userId, companyId })
    expect(await generate(companyId, draft)).toBe('669')
    expect((await readCounters(companyId)).invoice).toBe(670)
  })

  it('reads numbers by value: an imported 1 is never issued again as 001', async () => {
    const { userId, companyId } = await seedCompany()
    await ensureCompanySettings({ userId, companyId, nextInvoiceNumber: 1 })
    await importNumbers(userId, companyId, ['1'])

    const draft = await insertInvoice({ userId, companyId })
    expect(await generate(companyId, draft)).toBe('002')
  })

  it('refuses to issue under a higher number, and uses up nothing', async () => {
    const { userId, companyId } = await seedCompany()
    await ensureCompanySettings({ userId, companyId, nextInvoiceNumber: 1 })
    await importNumbers(userId, companyId, ['65024', '65025', '65026'])

    const draft = await insertInvoice({ userId, companyId })
    const err = await generateError(companyId, draft)
    expect(err.code).toBe('PT409')
    expect(err.message).toBe('INVOICE_NUMBER_SERIES_BEHIND')
    expect(JSON.parse(err.detail ?? '{}')).toMatchObject({ highest_number: 65026, first_allowed: 65027 })
    expect((await readCounters(companyId)).invoice).toBe(1)
    expect(await numberOf(draft)).toBeNull()
  })

  it('refuses to fill a hole inside the series', async () => {
    const { userId, companyId } = await seedCompany()
    await ensureCompanySettings({ userId, companyId, nextInvoiceNumber: 1 })
    await importNumbers(userId, companyId, ['1', '2', '3', '5'])

    const draft = await insertInvoice({ userId, companyId })
    const err = await generateError(companyId, draft)
    expect(err.message).toBe('INVOICE_NUMBER_SERIES_BEHIND')
    expect(JSON.parse(err.detail ?? '{}')).toMatchObject({ first_allowed: 6 })
  })

  it('continues the series once the company sets the next number past it', async () => {
    const { userId, companyId } = await seedCompany()
    await ensureCompanySettings({ userId, companyId, invoicePrefix: 'F', nextInvoiceNumber: 1 })
    await importNumbers(userId, companyId, ['F1001', 'F1002'])
    await getPool().query('UPDATE public.company_settings SET next_invoice_number = 1003 WHERE company_id = $1', [
      companyId,
    ])

    const draft = await insertInvoice({ userId, companyId })
    expect(await generate(companyId, draft)).toBe('F1003')
  })

  it('reads only the company prefix series: other formats neither block nor collide', async () => {
    const { userId, companyId } = await seedCompany()
    await ensureCompanySettings({ userId, companyId, invoicePrefix: 'F', nextInvoiceNumber: 1 })
    // The old system's series without the prefix, and a dashed year number.
    await importNumbers(userId, companyId, ['500', '501', '2025-17'])

    const draft = await insertInvoice({ userId, companyId })
    expect(await generate(companyId, draft)).toBe('F001')
  })

  it("treats Accounted's own year-style numbers from before 2026-05-11 as a finished series", async () => {
    const { userId, companyId } = await seedCompany()
    await ensureCompanySettings({ userId, companyId, nextInvoiceNumber: 386 })
    await insertInvoice({ userId, companyId, invoiceNumber: '2026383', createdAt: '2026-05-05T07:11:16Z' })
    await importNumbers(userId, companyId, ['384', '385'])

    const draft = await insertInvoice({ userId, companyId })
    expect(await generate(companyId, draft)).toBe('386')
  })

  it('counts a year-like number imported later as part of the series', async () => {
    const { userId, companyId } = await seedCompany()
    await ensureCompanySettings({ userId, companyId, nextInvoiceNumber: 1 })
    await importNumbers(userId, companyId, ['2026001', '2026002'])

    const draft = await insertInvoice({ userId, companyId })
    const err = await generateError(companyId, draft)
    expect(err.message).toBe('INVOICE_NUMBER_SERIES_BEHIND')
    expect(JSON.parse(err.detail ?? '{}')).toMatchObject({ first_allowed: 2026003 })
  })

  it('gives proformas their own PF- counter, so the invoice series keeps no hole', async () => {
    const { userId, companyId } = await seedCompany()
    await ensureCompanySettings({ userId, companyId, invoicePrefix: 'F', nextInvoiceNumber: 10 })

    const proforma = await insertInvoice({ userId, companyId, documentType: 'proforma' })
    expect(await generate(companyId, proforma, 'proforma')).toBe('PF-001')
    expect(await readCounters(companyId)).toEqual({ invoice: 10, proforma: 2 })

    const invoice = await insertInvoice({ userId, companyId })
    expect(await generate(companyId, invoice)).toBe('F010')
    expect(await readCounters(companyId)).toEqual({ invoice: 11, proforma: 2 })
  })

  it('keeps an issued number and does not move the counter on a second call', async () => {
    const { userId, companyId } = await seedCompany()
    await ensureCompanySettings({ userId, companyId, nextInvoiceNumber: 7 })
    const draft = await insertInvoice({ userId, companyId })

    expect(await generate(companyId, draft)).toBe('007')
    expect(await generate(companyId, draft)).toBe('007')
    expect((await readCounters(companyId)).invoice).toBe(8)
  })
})

describe('trg_invoices_number_value_unique: one invoice per number value', () => {
  it('refuses 1 when 001 exists, on insert', async () => {
    const { userId, companyId } = await seedCompany()
    await insertInvoice({ userId, companyId, invoiceNumber: '001' })

    const err = await insertError({ userId, companyId, invoiceNumber: '1' })
    // A unique violation like the index's, so callers that answer a taken
    // number (the migration review list) answer this one too.
    expect(err.code).toBe('23505')
    expect(err.message).toBe('INVOICE_NUMBER_TAKEN')
    expect(JSON.parse(err.detail ?? '{}')).toMatchObject({ invoice_number: '1', existing_invoice_number: '001' })
  })

  it('refuses a spelling of an existing number on update, with a prefix', async () => {
    const { userId, companyId } = await seedCompany()
    await insertInvoice({ userId, companyId, invoiceNumber: 'F-7' })
    const draft = await insertInvoice({ userId, companyId })

    await expect(
      getPool().query(`UPDATE public.invoices SET invoice_number = 'F-007' WHERE id = $1`, [draft]),
    ).rejects.toMatchObject({ code: '23505', message: 'INVOICE_NUMBER_TAKEN' })
  })

  it('leaves an exact repeat to the unique index', async () => {
    const { userId, companyId } = await seedCompany()
    await insertInvoice({ userId, companyId, invoiceNumber: '042' })

    const err = await insertError({ userId, companyId, invoiceNumber: '042' })
    expect(err.code).toBe('23505')
    expect(err.message).toMatch(/idx_invoices_company_invoice_number/)
  })

  it('allows the same value in another company, another prefix, and the PF- series', async () => {
    const a = await seedCompany()
    const b = await seedCompany()
    await insertInvoice({ userId: a.userId, companyId: a.companyId, invoiceNumber: '7' })

    await insertInvoice({ userId: b.userId, companyId: b.companyId, invoiceNumber: '007' })
    await insertInvoice({ userId: a.userId, companyId: a.companyId, invoiceNumber: 'F-007' })
    await insertInvoice({ userId: a.userId, companyId: a.companyId, invoiceNumber: 'PF-007', documentType: 'proforma' })
  })

  it('checks only the row being written: an existing pair stays editable', async () => {
    const { userId, companyId } = await seedCompany()
    const client = await getClient()
    let older: string
    try {
      // A pair from before the trigger existed.
      await client.query('ALTER TABLE public.invoices DISABLE TRIGGER trg_invoices_number_value_unique')
      older = await insertInvoice({ userId, companyId, invoiceNumber: '1' })
      await insertInvoice({ userId, companyId, invoiceNumber: '001' })
    } finally {
      await client.query('ALTER TABLE public.invoices ENABLE TRIGGER trg_invoices_number_value_unique')
      client.release()
    }

    await getPool().query(`UPDATE public.invoices SET notes = 'betald' WHERE id = $1`, [older])
    await getPool().query(`UPDATE public.invoices SET invoice_number = '1' WHERE id = $1`, [older])
    expect(await numberOf(older)).toBe('1')
  })

  it('serializes concurrent writers, so 1 and 001 cannot both land', async () => {
    const { userId, companyId } = await seedCompany()
    const customerId = await insertCustomer(userId, companyId)
    const insertSql = `INSERT INTO public.invoices
        (id, user_id, company_id, customer_id, invoice_number, document_type,
         invoice_date, due_date, currency, subtotal, vat_amount, total,
         vat_treatment, vat_rate, moms_ruta, status)
      VALUES ($1, $2, $3, $4, $5, 'invoice', '2026-10-12', '2026-11-11', 'SEK',
              1000, 250, 1250, 'standard_25', 25, '10', 'draft')`

    const first = await getClient()
    const second = await getClient()
    try {
      await first.query('BEGIN')
      await first.query(insertSql, [randomUUID(), userId, companyId, customerId, '1'])
      await second.query('BEGIN')
      const pending = second.query(insertSql, [randomUUID(), userId, companyId, customerId, '001'])
      const outcome = pending.then(
        () => 'inserted',
        (err: PgError) => err.message,
      )
      await new Promise((resolve) => setTimeout(resolve, 300))
      await first.query('COMMIT')
      expect(await outcome).toBe('INVOICE_NUMBER_TAKEN')
    } finally {
      await second.query('ROLLBACK').catch(() => {})
      first.release()
      second.release()
    }
  })
})

describe('invoice_number_series_status and peek_next_invoice_number', () => {
  it('previews the number generate_invoice_number would issue', async () => {
    const { userId, companyId } = await seedCompany()
    await ensureCompanySettings({ userId, companyId, nextInvoiceNumber: 667 })
    await importNumbers(userId, companyId, ['667', '668'])

    expect(await status(companyId)).toMatchObject({
      next_number: '669',
      highest_number: 668,
      behind: false,
      first_allowed: 669,
    })
    const { rows } = await getPool().query<{ peek: string | null }>(
      'SELECT public.peek_next_invoice_number($1, $2) AS peek',
      [companyId, 'invoice'],
    )
    expect(rows[0]!.peek).toBe('669')
  })

  it('says when the series is behind, and the preview is then empty', async () => {
    const { userId, companyId } = await seedCompany()
    await ensureCompanySettings({ userId, companyId, nextInvoiceNumber: 1 })
    await importNumbers(userId, companyId, ['1001', '1002'])

    expect(await status(companyId)).toMatchObject({
      next_number: null,
      highest_number: 1002,
      behind: true,
      first_allowed: 1003,
    })
    const { rows } = await getPool().query<{ peek: string | null }>(
      'SELECT public.peek_next_invoice_number($1, $2) AS peek',
      [companyId, 'invoice'],
    )
    expect(rows[0]!.peek).toBeNull()
  })

  it('judges a proposed prefix and next number instead of the stored ones', async () => {
    const { userId, companyId } = await seedCompany()
    await ensureCompanySettings({ userId, companyId, nextInvoiceNumber: 1 })
    await importNumbers(userId, companyId, ['1001', '1002'])

    expect(await status(companyId, { nextNumber: 1003 })).toMatchObject({ behind: false, next_number: '1003' })
    expect(await status(companyId, { prefix: 'F', nextNumber: 1 })).toMatchObject({
      behind: false,
      next_number: 'F001',
      highest_number: null,
      first_allowed: 1,
    })
  })

  it('refuses a caller that is not a member of the company', async () => {
    const intruder = await seedCompany()
    const target = await seedCompany()
    await ensureCompanySettings({ userId: target.userId, companyId: target.companyId })

    await expect(
      withUserContext(intruder.userId, async (client) => {
        await client.query('SELECT public.invoice_number_series_status($1, $2)', [target.companyId, 'invoice'])
      }),
    ).rejects.toThrow(/unauthorized/)

    const own = await withUserContext(target.userId, async (client) => {
      const { rows } = await client.query<{ s: { next_number: string } }>(
        'SELECT public.invoice_number_series_status($1, $2) AS s',
        [target.companyId, 'invoice'],
      )
      return rows[0]!.s
    })
    expect(own.next_number).toBe('001')
  })

  it('grants: status for members only, the position helper and the trigger function for nobody outside', async () => {
    const { rows } = await getPool().query<{ fn: string; role: string; allowed: boolean }>(
      `SELECT fn, role, has_function_privilege(role, fn, 'EXECUTE') AS allowed
       FROM unnest(ARRAY[
         'public.invoice_number_series_status(uuid,text,text,integer)',
         'public.invoice_number_series_position(uuid,text,bigint,boolean)',
         'public.guard_invoice_number_value()'
       ]) AS fn
       CROSS JOIN unnest(ARRAY['anon', 'authenticated', 'service_role']) AS role`,
    )
    const allowed = Object.fromEntries(rows.map((r) => [`${r.fn} ${r.role}`, r.allowed]))
    expect(allowed).toMatchObject({
      'public.invoice_number_series_status(uuid,text,text,integer) anon': false,
      'public.invoice_number_series_status(uuid,text,text,integer) authenticated': true,
      'public.invoice_number_series_status(uuid,text,text,integer) service_role': true,
      'public.invoice_number_series_position(uuid,text,bigint,boolean) anon': false,
      'public.invoice_number_series_position(uuid,text,bigint,boolean) authenticated': false,
      'public.invoice_number_series_position(uuid,text,bigint,boolean) service_role': true,
      'public.guard_invoice_number_value() anon': false,
      'public.guard_invoice_number_value() authenticated': false,
    })
  })
})
