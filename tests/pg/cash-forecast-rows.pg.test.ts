import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  insertAuthUser,
  insertCompany,
  insertCompanyMember,
  insertTransaction,
  seedCompany,
  setActiveCompany,
} from '@/tests/pg/fixtures'
import { getPool, runAsServiceRole, withUserContext } from '@/tests/pg/setup'

// Pins 20261031121500_cash_forecast_rows.sql: the forecast rows of the
// liquidity forecast (accounted#136). Members read their companies' rows, a
// writing member of the active company writes them, nobody deletes one (a row
// is cancelled by status), an outside key is unique per company, and a row
// never points at another company's invoice, bank row or dimension value.

const INSERT = `INSERT INTO public.cash_forecast_rows
  (company_id, expected_date, amount, direction, category, source, external_source, external_id)
  VALUES ($1, '2026-11-20', $2, $3, 'revenue', 'api', $4, $5) RETURNING id`

async function seed() {
  const { userId, companyId } = await seedCompany()
  await setActiveCompany(userId, companyId)
  return { userId, companyId }
}

async function insertInvoice(companyId: string, userId: string): Promise<string> {
  const customerId = randomUUID()
  await getPool().query(
    `INSERT INTO public.customers (id, user_id, company_id, name, customer_type) VALUES ($1, $2, $3, 'Kund AB', 'swedish_business')`,
    [customerId, userId, companyId],
  )
  const id = randomUUID()
  await getPool().query(
    `INSERT INTO public.invoices (id, user_id, company_id, customer_id, invoice_number, invoice_date, due_date, total, currency, document_type, status, creation_complete)
     VALUES ($1, $2, $3, $4, $5, '2026-11-02', '2026-12-02', 1250, 'SEK', 'invoice', 'draft', true)`,
    [id, userId, companyId, customerId, `F-${id.slice(0, 8)}`],
  )
  return id
}

describe('cash_forecast_rows.pg', () => {
  it('lets a writing member of the active company add and change a row, and read it back', async () => {
    const { userId, companyId } = await seed()
    await withUserContext(userId, async (client) => {
      const { rows } = await client.query<{ id: string }>(INSERT, [companyId, 25000, 'in', 'boom', 'booking-1'])
      expect(rows).toHaveLength(1)
      await client.query(`UPDATE public.cash_forecast_rows SET amount = 26000, status = 'cancelled' WHERE id = $1`, [rows[0]!.id])
      const read = await client.query<{ amount: string; status: string; currency: string; confidence: string }>(
        `SELECT amount, status, currency, confidence FROM public.cash_forecast_rows WHERE id = $1`,
        [rows[0]!.id],
      )
      expect(read.rows[0]).toEqual({ amount: '26000.00', status: 'cancelled', currency: 'SEK', confidence: 'likely' })
    })
  })

  it('refuses a viewer and a company that is not the active one', async () => {
    const { userId, companyId } = await seed()
    const viewer = await insertAuthUser()
    await insertCompanyMember({ companyId, userId: viewer, role: 'viewer' })
    await setActiveCompany(viewer, companyId)
    await withUserContext(viewer, async (client) => {
      await expect(client.query(INSERT, [companyId, 100, 'in', null, null])).rejects.toThrow(/row-level security/i)
    })
    const other = await insertCompany({ createdBy: userId })
    await insertCompanyMember({ companyId: other, userId, role: 'owner' })
    await withUserContext(userId, async (client) => {
      await expect(client.query(INSERT, [other, 100, 'in', null, null])).rejects.toThrow(/row-level security/i)
    })
  })

  it('never deletes a row from a browser session or the service role, and hides it from other companies', async () => {
    const { userId, companyId } = await seed()
    const { rows } = await getPool().query<{ id: string }>(INSERT, [companyId, 500, 'out', null, null])
    const id = rows[0]!.id
    await withUserContext(userId, async (client) => {
      await expect(client.query(`DELETE FROM public.cash_forecast_rows WHERE id = $1`, [id])).rejects.toThrow(/permission denied/i)
    })
    await runAsServiceRole(async (client) => {
      await expect(client.query(`DELETE FROM public.cash_forecast_rows WHERE id = $1`, [id])).rejects.toThrow(/permission denied/i)
    })
    const { userId: stranger } = await seed()
    await withUserContext(stranger, async (client) => {
      const read = await client.query(`SELECT id FROM public.cash_forecast_rows WHERE id = $1`, [id])
      expect(read.rows).toEqual([])
    })
  })

  it('lets the service role upsert on the outside key, and keeps rows without a key apart', async () => {
    const { companyId } = await seed()
    const upsert = `INSERT INTO public.cash_forecast_rows
      (company_id, expected_date, amount, direction, category, source, external_source, external_id)
      VALUES ($1, '2026-11-20', $2, 'in', 'revenue', 'pms', 'boom', 'booking-7')
      ON CONFLICT (company_id, external_source, external_id) DO UPDATE SET amount = EXCLUDED.amount
      RETURNING id, amount`
    await runAsServiceRole(async (client) => {
      const first = await client.query<{ id: string; amount: string }>(upsert, [companyId, 1000])
      const second = await client.query<{ id: string; amount: string }>(upsert, [companyId, 1200])
      expect(second.rows[0]!.id).toBe(first.rows[0]!.id)
      expect(second.rows[0]!.amount).toBe('1200.00')
      // Two typed-in rows (no key) never collide.
      await client.query(INSERT, [companyId, 10, 'out', null, null])
      await client.query(INSERT, [companyId, 10, 'out', null, null])
    })
    const count = await getPool().query<{ n: string }>(
      `SELECT count(*)::text AS n FROM public.cash_forecast_rows WHERE company_id = $1`,
      [companyId],
    )
    expect(count.rows[0]!.n).toBe('3')
  })

  it('refuses a zero amount, a half outside key, another currency and two invoices at once', async () => {
    const { userId, companyId } = await seed()
    const pool = getPool()
    await expect(pool.query(INSERT, [companyId, 0, 'in', null, null])).rejects.toThrow(/check constraint/i)
    await expect(pool.query(INSERT, [companyId, 10, 'in', 'boom', null])).rejects.toThrow(/cash_forecast_rows_external_pair/)
    await expect(
      pool.query(
        `INSERT INTO public.cash_forecast_rows (company_id, expected_date, amount, direction, category, source, currency)
         VALUES ($1, '2026-11-20', 10, 'in', 'other', 'manual', 'EUR')`,
        [companyId],
      ),
    ).rejects.toThrow(/check constraint/i)
    const invoiceId = await insertInvoice(companyId, userId)
    const supplierInvoiceId = randomUUID()
    await expect(
      pool.query(
        `INSERT INTO public.cash_forecast_rows (company_id, expected_date, amount, direction, category, source, invoice_id, supplier_invoice_id)
         VALUES ($1, '2026-11-20', 10, 'in', 'other', 'manual', $2, $3)`,
        [companyId, invoiceId, supplierInvoiceId],
      ),
    ).rejects.toThrow(/cash_forecast_rows_one_invoice|another company/)
  })

  it('refuses an invoice or a bank row of another company, also for the service role', async () => {
    const { userId, companyId } = await seed()
    const { userId: otherUser, companyId: otherCompany } = await seed()
    const foreignInvoice = await insertInvoice(otherCompany, otherUser)
    const foreignTx = await insertTransaction({ companyId: otherCompany, userId: otherUser })
    const ownInvoice = await insertInvoice(companyId, userId)
    const withInvoice = `INSERT INTO public.cash_forecast_rows (company_id, expected_date, amount, direction, category, source, invoice_id)
      VALUES ($1, '2026-11-20', 10, 'in', 'revenue', 'api', $2) RETURNING id`
    await runAsServiceRole(async (client) => {
      await expect(client.query(withInvoice, [companyId, foreignInvoice])).rejects.toThrow(/belongs to another company/)
    })
    const { rows } = await getPool().query<{ id: string }>(withInvoice, [companyId, ownInvoice])
    await expect(
      getPool().query(
        `UPDATE public.cash_forecast_rows SET status = 'realised', matched_transaction_id = $2 WHERE id = $1`,
        [rows[0]!.id, foreignTx],
      ),
    ).rejects.toThrow(/belongs to another company/)
    // A matched bank row only on a realised row.
    const ownTx = await insertTransaction({ companyId, userId })
    await expect(
      getPool().query(`UPDATE public.cash_forecast_rows SET matched_transaction_id = $2 WHERE id = $1`, [rows[0]!.id, ownTx]),
    ).rejects.toThrow(/cash_forecast_rows_matched_only_realised/)
  })

  it('lets one bank transaction realise one forecast row only, also for the service role', async () => {
    const { userId, companyId } = await seed()
    const tx = await insertTransaction({ companyId, userId, amount: 1000 })
    const { rows } = await getPool().query<{ id: string }>(
      `INSERT INTO public.cash_forecast_rows (company_id, expected_date, amount, direction, category, source)
       VALUES ($1, '2026-11-20', 1000, 'in', 'revenue', 'manual'), ($1, '2026-11-21', 1000, 'in', 'revenue', 'manual')
       RETURNING id`,
      [companyId],
    )
    const realise = `UPDATE public.cash_forecast_rows SET status = 'realised', matched_transaction_id = $2 WHERE id = $1`
    await runAsServiceRole((client) => client.query(realise, [rows[0]!.id, tx]))
    await runAsServiceRole(async (client) => {
      await expect(client.query(realise, [rows[1]!.id, tx])).rejects.toThrow(/uq_cash_forecast_rows_matched_transaction/)
    })
    const realised = await getPool().query<{ id: string }>(
      `SELECT id FROM public.cash_forecast_rows WHERE matched_transaction_id = $1`,
      [tx],
    )
    expect(realised.rows.map((r) => r.id)).toEqual([rows[0]!.id])
    // Rows without a match never collide.
    const unmatched = await getPool().query<{ n: string }>(
      `SELECT count(*)::text AS n FROM public.cash_forecast_rows WHERE company_id = $1 AND matched_transaction_id IS NULL`,
      [companyId],
    )
    expect(unmatched.rows[0]!.n).toBe('1')
  })

  it('writes the audit log and keeps the row when its draft invoice is deleted', async () => {
    const { userId, companyId } = await seed()
    const invoiceId = await insertInvoice(companyId, userId)
    const { rows } = await getPool().query<{ id: string }>(
      `INSERT INTO public.cash_forecast_rows (company_id, expected_date, amount, direction, category, source, invoice_id)
       VALUES ($1, '2026-11-20', 1250, 'in', 'revenue', 'manual', $2) RETURNING id`,
      [companyId, invoiceId],
    )
    const id = rows[0]!.id
    await getPool().query(`DELETE FROM public.invoices WHERE id = $1`, [invoiceId])
    const after = await getPool().query<{ invoice_id: string | null; status: string }>(
      `SELECT invoice_id, status FROM public.cash_forecast_rows WHERE id = $1`,
      [id],
    )
    expect(after.rows[0]).toEqual({ invoice_id: null, status: 'open' })
    const audit = await getPool().query<{ action: string; company_id: string }>(
      `SELECT action, company_id FROM public.audit_log WHERE table_name = 'cash_forecast_rows' AND record_id = $1 ORDER BY created_at, id`,
      [id],
    )
    expect(audit.rows.map((r) => r.action)).toEqual(['INSERT', 'UPDATE'])
    expect(audit.rows[0]!.company_id).toBe(companyId)
  })

  const UPSERT = `SELECT external_id, amount, source, confidence, created_by
    FROM public.upsert_cash_forecast_rows($1, $2, $3, $4::jsonb) ORDER BY external_id`
  const batch = (amount: number) =>
    JSON.stringify([
      { external_source: 'boom', external_id: 'b-1', expected_date: '2026-11-20', amount, direction: 'in', category: 'revenue' },
      { external_source: 'boom', external_id: 'b-2', expected_date: '2026-11-21', amount, direction: 'in', category: 'revenue', confidence: 'firm' },
    ])

  it('upserts a batch by the outside key in one statement, and leaves a row that is no longer open alone', async () => {
    const { userId, companyId } = await seed()
    const first = await runAsServiceRole((client) => client.query(UPSERT, [companyId, 'pms', userId, batch(100)]))
    expect(first.rows).toEqual([
      { external_id: 'b-1', amount: '100.00', source: 'pms', confidence: 'likely', created_by: userId },
      { external_id: 'b-2', amount: '100.00', source: 'pms', confidence: 'firm', created_by: userId },
    ])
    await getPool().query(`UPDATE public.cash_forecast_rows SET status = 'cancelled' WHERE company_id = $1 AND external_id = 'b-2'`, [companyId])

    const other = await insertAuthUser()
    const second = await runAsServiceRole((client) => client.query(UPSERT, [companyId, 'api', other, batch(250)]))
    // b-1 updated with the source and author of its first write; b-2 cancelled and not answered.
    expect(second.rows).toEqual([{ external_id: 'b-1', amount: '250.00', source: 'pms', confidence: 'likely', created_by: userId }])
    const cancelled = await getPool().query<{ amount: string; status: string }>(
      `SELECT amount, status FROM public.cash_forecast_rows WHERE company_id = $1 AND external_id = 'b-2'`,
      [companyId],
    )
    expect(cancelled.rows[0]).toEqual({ amount: '100.00', status: 'cancelled' })
  })

  it('runs the batch upsert under RLS for a browser session: the writer is the session, a viewer is refused', async () => {
    const { userId, companyId } = await seed()
    const other = await insertAuthUser()
    const own = await withUserContext(userId, (client) => client.query(UPSERT, [companyId, 'manual', other, batch(10)]))
    expect(own.rows.map((r) => r.created_by)).toEqual([userId, userId])

    const viewer = await insertAuthUser()
    await insertCompanyMember({ companyId, userId: viewer, role: 'viewer' })
    await setActiveCompany(viewer, companyId)
    await withUserContext(viewer, async (client) => {
      await expect(client.query(UPSERT, [companyId, 'manual', viewer, batch(20)])).rejects.toThrow(/row-level security/i)
    })
  })
})
