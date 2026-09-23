import { randomUUID } from 'node:crypto'
import { describe, it, expect, beforeAll } from 'vitest'
import { getPool } from '@/tests/pg/setup'
import { seedCompany } from '@/tests/pg/fixtures'
import { createToolPgClient } from '@/tests/tool-pg/client'
import { countRowlessInvoices } from '../complete-invoice-lines'

/**
 * `invoice_items=is.null` on a to-many embed is resolved by PostgREST, not by
 * Postgres and not by the type system, and a HEAD count on top of it is one
 * more thing a mocked client answers whatever the grammar means. The cron
 * skips every register this count reports as empty, so a count that came
 * back 0 for everyone would switch the whole cron off, and a count that
 * ignored the embed filter would size registers by their whole history. Both
 * pass unit tests. This asserts on the real thing that the count is the
 * anti-join the pass's own `loadCandidates` evaluates client-side.
 */

async function insertInvoice(input: {
  userId: string
  companyId: string
  status?: string
  documentType?: string
  rows?: number
}): Promise<string> {
  const id = randomUUID()
  await getPool().query(
    `INSERT INTO public.invoices
       (id, user_id, company_id, invoice_number, invoice_date, due_date, status, document_type, total)
     VALUES ($1, $2, $3, $4, '2026-03-14', '2026-04-13', $5, $6, 1250)`,
    [id, input.userId, input.companyId, `F-${randomUUID()}`, input.status ?? 'sent', input.documentType ?? 'invoice'],
  )
  for (let i = 0; i < (input.rows ?? 0); i++) {
    await getPool().query(
      `INSERT INTO public.invoice_items (invoice_id, sort_order, description, quantity, unit_price, line_total)
       VALUES ($1, $2, 'Konsulttid', 1, 1000, 1000)`,
      [id, i + 1],
    )
  }
  return id
}

describe('countRowlessInvoices against a real PostgREST', () => {
  let client: ReturnType<typeof createToolPgClient>
  let companyId: string
  let otherCompanyId: string

  beforeAll(async () => {
    client = createToolPgClient()
    const a = await seedCompany()
    const b = await seedCompany()
    companyId = a.companyId
    otherCompanyId = b.companyId

    // Three the pass would complete...
    await insertInvoice({ userId: a.userId, companyId })
    await insertInvoice({ userId: a.userId, companyId, status: 'paid' })
    await insertInvoice({ userId: a.userId, companyId, status: 'overdue' })
    // ...and four it would not: rows already there, a draft, a proforma.
    await insertInvoice({ userId: a.userId, companyId, status: 'paid', rows: 1 })
    await insertInvoice({ userId: a.userId, companyId, rows: 3 })
    await insertInvoice({ userId: a.userId, companyId, status: 'draft' })
    await insertInvoice({ userId: a.userId, companyId, documentType: 'proforma' })
    // Another company's row-less invoice must not leak into the count.
    await insertInvoice({ userId: b.userId, companyId: otherCompanyId })
  }, 30_000)

  it('counts exactly the non-draft sales invoices with no rows, per company', async () => {
    expect(await countRowlessInvoices(client, companyId)).toBe(3)
    expect(await countRowlessInvoices(client, otherCompanyId)).toBe(1)
  })

  it('agrees with the predicate the pass evaluates client-side', async () => {
    const { data, error } = await client
      .from('invoices')
      .select('id, invoice_items(id)')
      .eq('company_id', companyId)
      .eq('document_type', 'invoice')
      .neq('status', 'draft')
    expect(error).toBeNull()
    const rows = (data ?? []) as { id: string; invoice_items: { id: string }[] | null }[]
    const rowless = rows.filter((row) => (row.invoice_items?.length ?? 0) === 0)
    expect(rows).toHaveLength(5)
    expect(rowless).toHaveLength(await countRowlessInvoices(client, companyId))
  })

  it('reports zero for a company whose invoices all have rows', async () => {
    const c = await seedCompany()
    await insertInvoice({ userId: c.userId, companyId: c.companyId, rows: 2 })
    await insertInvoice({ userId: c.userId, companyId: c.companyId, status: 'paid', rows: 1 })

    expect(await countRowlessInvoices(client, c.companyId)).toBe(0)
  })
})
