import { randomUUID } from 'node:crypto'
import { describe, it, expect } from 'vitest'
import type { PoolClient } from 'pg'
import { getPool, getClient, runAsServiceRole, withUserContext } from './setup'
import { seedCompany, insertAuthUser, insertCompanyMember } from './fixtures'

// pg-real coverage for 20260906135730_complete_invoice_rows_rpc:
// complete_invoice_rows writes a migrated invoice's rows (and its optional
// header VAT split) at most once. It locks the invoice, inserts only when the
// invoice still has no rows, applies the header in the same transaction,
// refuses non-members and foreign invoices, and serializes concurrent
// writers so the second one finds the first one's rows (#2313).

type RpcResult = {
  ok: boolean
  code?: string
  wrote?: boolean
  rows?: number
  header_updated?: boolean
  details?: Record<string, unknown>
}

const SIGNATURE = 'public.complete_invoice_rows(uuid,uuid,jsonb,jsonb)'

/** Two rows the way mapSalesInvoiceLine emits them: 1 000 kr net, 25 %. */
const ROWS = [
  { sort_order: 1, description: 'Konsulttid', quantity: 8, unit: 'h', unit_price: 100, line_total: 800, vat_rate: 25, vat_amount: 200, line_type: 'product' },
  { sort_order: 2, description: 'Resa', quantity: 1, unit: 'st', unit_price: 200, line_total: 200, vat_rate: 25, vat_amount: 50, line_type: 'product' },
]

/** The header split the detail form established for ROWS. */
const HEADER = {
  subtotal: 1000,
  subtotal_sek: 1000,
  vat_amount: 250,
  vat_amount_sek: 250,
  vat_rate: 25,
  vat_treatment: 'standard_25',
}

/**
 * A migrated invoice the way the pre-#1745 import left it: total right, 25 %
 * label beside 0 kr VAT and subtotal = total, and no rows.
 */
async function insertInvoice(companyId: string, userId: string): Promise<string> {
  const customerId = randomUUID()
  await getPool().query(
    `INSERT INTO public.customers (id, user_id, company_id, name, customer_type)
     VALUES ($1, $2, $3, 'Kund AB', 'swedish_business')`,
    [customerId, userId, companyId],
  )
  const id = randomUUID()
  await getPool().query(
    `INSERT INTO public.invoices
       (id, user_id, company_id, customer_id, invoice_number, document_type,
        invoice_date, due_date, currency, subtotal, subtotal_sek, vat_amount, vat_amount_sek,
        total, total_sek, vat_treatment, vat_rate, status)
     VALUES ($1, $2, $3, $4, $5, 'invoice',
             '2026-03-14', '2026-04-13', 'SEK', 1250, 1250, 0, 0,
             1250, 1250, 'standard_25', 25, 'sent')`,
    [id, userId, companyId, customerId, `1001-${id.slice(0, 8)}`],
  )
  return id
}

async function callRpc(
  client: PoolClient,
  companyId: string,
  invoiceId: string,
  rows: unknown,
  header: unknown = null,
): Promise<RpcResult> {
  const { rows: out } = await client.query<{ r: RpcResult }>(
    `SELECT public.complete_invoice_rows($1, $2, $3::jsonb, $4::jsonb) AS r`,
    [companyId, invoiceId, JSON.stringify(rows), header === null ? null : JSON.stringify(header)],
  )
  return out[0].r
}

async function beginAsUser(client: PoolClient, userId: string): Promise<void> {
  await client.query('BEGIN')
  await client.query(`SELECT set_config('request.jwt.claims', $1, true)`, [
    JSON.stringify({ sub: userId, role: 'authenticated' }),
  ])
  await client.query(`SELECT set_config('request.jwt.claim.sub', $1, true)`, [userId])
  await client.query('SET LOCAL ROLE authenticated')
}

/** Like withUserContext but COMMITs, so a later session can observe the result. */
async function asUser<T>(userId: string, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await getClient()
  try {
    await beginAsUser(client, userId)
    const result = await fn(client)
    await client.query('COMMIT')
    return result
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    throw err
  } finally {
    client.release()
  }
}

async function storedRows(invoiceId: string) {
  const { rows } = await getPool().query<{
    description: string
    sort_order: number
    quantity: string
    unit: string
    line_total: string
    vat_rate: string
    line_type: string
  }>(
    `SELECT description, sort_order, quantity::text, unit, line_total::text, vat_rate::text, line_type
     FROM public.invoice_items WHERE invoice_id = $1 ORDER BY sort_order, description`,
    [invoiceId],
  )
  return rows
}

async function storedHeader(invoiceId: string) {
  const { rows } = await getPool().query<{
    subtotal: string
    subtotal_sek: string
    vat_amount: string
    vat_amount_sek: string
    vat_rate: string
    vat_treatment: string
    total: string
  }>(
    `SELECT subtotal::text, subtotal_sek::text, vat_amount::text, vat_amount_sek::text,
            vat_rate::text, vat_treatment, total::text
     FROM public.invoices WHERE id = $1`,
    [invoiceId],
  )
  const h = rows[0]!
  return {
    subtotal: Number(h.subtotal),
    subtotal_sek: Number(h.subtotal_sek),
    vat_amount: Number(h.vat_amount),
    vat_amount_sek: Number(h.vat_amount_sek),
    vat_rate: Number(h.vat_rate),
    vat_treatment: h.vat_treatment,
    total: Number(h.total),
  }
}

describe('complete_invoice_rows', () => {
  it('writes the rows and the header split together, and only once', async () => {
    const { userId, companyId } = await seedCompany()
    const invoiceId = await insertInvoice(companyId, userId)

    const first = await asUser(userId, (client) => callRpc(client, companyId, invoiceId, ROWS, HEADER))
    expect(first).toEqual({ ok: true, wrote: true, rows: 2, header_updated: true })

    const rows = await storedRows(invoiceId)
    expect(rows.map((r) => r.description)).toEqual(['Konsulttid', 'Resa'])
    expect(rows[0]).toMatchObject({ sort_order: 1, unit: 'h', line_type: 'product' })
    expect(Number(rows[0].quantity)).toBe(8)
    expect(Number(rows[0].line_total)).toBe(800)
    expect(Number(rows[0].vat_rate)).toBe(25)

    const header = await storedHeader(invoiceId)
    expect(header).toEqual({ ...HEADER, total: 1250 })

    // Same rows again, or different ones: nothing is appended and the header
    // is not touched, whichever run gets there second.
    const again = await asUser(userId, (client) => callRpc(client, companyId, invoiceId, ROWS, HEADER))
    expect(again).toEqual({ ok: true, wrote: false, rows: 0, header_updated: false })
    const other = await asUser(userId, (client) =>
      callRpc(client, companyId, invoiceId, [{ description: 'Annat', line_total: 5 }], { ...HEADER, subtotal: 5 }),
    )
    expect(other).toEqual({ ok: true, wrote: false, rows: 0, header_updated: false })

    expect((await storedRows(invoiceId)).map((r) => r.description)).toEqual(['Konsulttid', 'Resa'])
    expect(await storedHeader(invoiceId)).toEqual({ ...HEADER, total: 1250 })
  })

  it('writes the rows without a header when none is given (the wizard path), taking table defaults for missing keys', async () => {
    const { userId, companyId } = await seedCompany()
    const invoiceId = await insertInvoice(companyId, userId)
    const before = await storedHeader(invoiceId)

    const r = await asUser(userId, (client) => callRpc(client, companyId, invoiceId, [{ description: 'Bara text' }]))
    expect(r).toEqual({ ok: true, wrote: true, rows: 1, header_updated: false })

    const rows = await storedRows(invoiceId)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ description: 'Bara text', sort_order: 0, unit: 'st', line_type: 'product' })
    expect(Number(rows[0].quantity)).toBe(1)
    expect(Number(rows[0].line_total)).toBe(0)
    expect(Number(rows[0].vat_rate)).toBe(25)
    expect(await storedHeader(invoiceId)).toEqual(before)
  })

  it('rolls the rows back when the header update fails: header and rows land together or not at all', async () => {
    const { userId, companyId } = await seedCompany()
    const invoiceId = await insertInvoice(companyId, userId)
    const before = await storedHeader(invoiceId)

    await expect(
      asUser(userId, (client) => callRpc(client, companyId, invoiceId, ROWS, { ...HEADER, vat_rate: 'tjugofem' })),
    ).rejects.toThrow(/numeric/)

    expect(await storedRows(invoiceId)).toHaveLength(0)
    expect(await storedHeader(invoiceId)).toEqual(before)
  })

  it('refuses a payload it cannot store honestly, before locking anything', async () => {
    const { userId, companyId } = await seedCompany()
    const invoiceId = await insertInvoice(companyId, userId)

    await withUserContext(userId, async (client) => {
      expect(await callRpc(client, companyId, invoiceId, [])).toEqual({ ok: false, code: 'NO_ROWS' })
      expect(await callRpc(client, companyId, invoiceId, { description: 'x' })).toEqual({ ok: false, code: 'NO_ROWS' })
      expect(await callRpc(client, companyId, invoiceId, ['x'])).toEqual({ ok: false, code: 'INVALID_ROWS' })
      // A column the mapper started emitting must fail loudly, not be dropped.
      expect(await callRpc(client, companyId, invoiceId, [{ ...ROWS[0], invoice_id: invoiceId }])).toEqual({
        ok: false, code: 'UNKNOWN_COLUMN', details: { column: 'invoice_id' },
      })
      // A partial header would null the columns it omits.
      expect(await callRpc(client, companyId, invoiceId, ROWS, { subtotal: 1000 })).toEqual({
        ok: false, code: 'INVALID_HEADER',
      })
      // A row without a description is a NOT NULL violation, not a silent row.
      await expect(callRpc(client, companyId, invoiceId, [{ line_total: 5 }])).rejects.toThrow(/description/)
    })

    expect(await storedRows(invoiceId)).toHaveLength(0)
  })

  it('refuses an invoice outside the company and callers without a write role', async () => {
    const a = await seedCompany()
    const b = await seedCompany()
    const invoiceA = await insertInvoice(a.companyId, a.userId)

    // Owner of B naming their own company with A's invoice, and owner of A
    // naming company B: both are "not found", never a write.
    await withUserContext(b.userId, async (client) => {
      expect(await callRpc(client, b.companyId, invoiceA, ROWS)).toEqual({ ok: false, code: 'INVOICE_NOT_FOUND' })
      expect(await callRpc(client, a.companyId, invoiceA, ROWS)).toEqual({ ok: false, code: 'FORBIDDEN' })
    })

    const viewer = await insertAuthUser()
    await insertCompanyMember({ companyId: a.companyId, userId: viewer, role: 'viewer' })
    await withUserContext(viewer, async (client) => {
      expect(await callRpc(client, a.companyId, invoiceA, ROWS)).toEqual({ ok: false, code: 'FORBIDDEN' })
    })

    // No JWT at all (a plain connection) is refused, not trusted.
    const client = await getClient()
    try {
      expect(await callRpc(client, a.companyId, invoiceA, ROWS)).toEqual({ ok: false, code: 'FORBIDDEN' })
    } finally {
      client.release()
    }

    expect(await storedRows(invoiceA)).toHaveLength(0)
  })

  it('lets the cron write on the service client, with no session user', async () => {
    const { userId, companyId } = await seedCompany()
    const invoiceId = await insertInvoice(companyId, userId)

    const r = await runAsServiceRole((client) => callRpc(client, companyId, invoiceId, ROWS, HEADER))
    expect(r).toEqual({ ok: true, wrote: true, rows: 2, header_updated: true })
    expect(await storedRows(invoiceId)).toHaveLength(2)
    expect(await storedHeader(invoiceId)).toEqual({ ...HEADER, total: 1250 })
  })

  it('serializes two writers on one invoice: the second waits on the lock and then finds the rows', async () => {
    const { userId, companyId } = await seedCompany()
    const invoiceId = await insertInvoice(companyId, userId)
    const first = await getClient()
    const second = await getClient()
    try {
      await beginAsUser(first, userId)
      await beginAsUser(second, userId)

      expect(await callRpc(first, companyId, invoiceId, ROWS, HEADER)).toMatchObject({ ok: true, wrote: true, rows: 2 })

      let settled = false
      const pending = callRpc(second, companyId, invoiceId, [{ description: 'Dubblett', line_total: 1 }]).then((r) => {
        settled = true
        return r
      })
      await new Promise((resolve) => setTimeout(resolve, 300))
      // Blocked on the first writer's row lock, not running ahead of it.
      expect(settled).toBe(false)

      await first.query('COMMIT')
      expect(await pending).toEqual({ ok: true, wrote: false, rows: 0, header_updated: false })
      await second.query('COMMIT')
    } catch (err) {
      await first.query('ROLLBACK').catch(() => {})
      await second.query('ROLLBACK').catch(() => {})
      throw err
    } finally {
      first.release()
      second.release()
    }

    expect((await storedRows(invoiceId)).map((r) => r.description)).toEqual(['Konsulttid', 'Resa'])
  })

  it('grants: anon and PUBLIC have no EXECUTE; authenticated and service_role do', async () => {
    const { rows } = await getPool().query<{ anon_can: boolean; public_can: boolean; auth_can: boolean; service_can: boolean }>(
      `SELECT has_function_privilege('anon', $1, 'EXECUTE') AS anon_can,
              has_function_privilege('public', $1, 'EXECUTE') AS public_can,
              has_function_privilege('authenticated', $1, 'EXECUTE') AS auth_can,
              has_function_privilege('service_role', $1, 'EXECUTE') AS service_can`,
      [SIGNATURE],
    )
    expect(rows[0]).toEqual({ anon_can: false, public_can: false, auth_can: true, service_can: true })
  })
})
