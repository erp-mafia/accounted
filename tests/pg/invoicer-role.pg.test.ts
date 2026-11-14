import { randomUUID } from 'node:crypto'
import { beforeAll, describe, expect, it } from 'vitest'
import type { PoolClient } from 'pg'
import { getPool, withUserContext } from './setup'
import {
  insertAuthUser,
  insertCashAccount,
  insertCompanyMember,
  insertPostedJournalEntry,
  insertTransaction,
  seedCompany,
  setActiveCompany,
} from './fixtures'

// pg-real coverage for 20261027130000_invoicer_company_role: the invoicer
// role reads only the invoicing tables, gets zero rows everywhere else and
// writes nothing through PostgREST, while owner, member and viewer read and
// write exactly as before.

interface Seed {
  companyId: string
  owner: string
  member: string
  viewer: string
  invoicer: string
  invoiceId: string
}

let seed: Seed

/** Every table the role must not see, with the seeded row count all others see. */
const DENIED_TABLES = [
  'employees',
  'salary_runs',
  'agi_declarations',
  'journal_entries',
  'journal_entry_lines',
  'transactions',
  'cash_accounts',
  'document_attachments',
  'webhooks',
] as const

const INVOICING_TABLES = [
  'invoices',
  'invoice_items',
  'customers',
  'articles',
  'sales_orders',
  'fiscal_periods',
  'company_settings',
] as const

async function countRows(client: PoolClient, table: string, companyId: string): Promise<number> {
  const sql =
    table === 'invoice_items'
      ? `SELECT count(*)::int AS n FROM public.invoice_items ii JOIN public.invoices i ON i.id = ii.invoice_id WHERE i.company_id = $1`
      : table === 'journal_entry_lines'
        ? `SELECT count(*)::int AS n FROM public.journal_entry_lines l JOIN public.journal_entries e ON e.id = l.journal_entry_id WHERE e.company_id = $1`
        : `SELECT count(*)::int AS n FROM public.${table} WHERE company_id = $1`
  const { rows } = await client.query<{ n: number }>(sql, [companyId])
  return rows[0].n
}

/** Run one statement as the user, expecting it to fail, without aborting the transaction. */
async function expectRefused(client: PoolClient, sql: string, params: unknown[]): Promise<string> {
  await client.query('SAVEPOINT refused')
  try {
    await client.query(sql, params)
  } catch (err) {
    await client.query('ROLLBACK TO SAVEPOINT refused')
    return (err as Error).message
  }
  await client.query('ROLLBACK TO SAVEPOINT refused')
  throw new Error(`expected the statement to be refused: ${sql}`)
}

beforeAll(async () => {
  const { userId: owner, companyId, fiscalPeriodId } = await seedCompany()
  const pool = getPool()

  const member = await insertAuthUser()
  const viewer = await insertAuthUser()
  const invoicer = await insertAuthUser()
  await insertCompanyMember({ companyId, userId: member, role: 'member' })
  await insertCompanyMember({ companyId, userId: viewer, role: 'viewer' })
  await insertCompanyMember({ companyId, userId: invoicer, role: 'invoicer' })
  for (const user of [owner, member, viewer, invoicer]) await setActiveCompany(user, companyId)

  await pool.query(
    `INSERT INTO public.company_settings (user_id, company_id, company_name, bankgiro)
     VALUES ($1, $2, 'Test AB', '123-4567')
     ON CONFLICT (company_id) DO UPDATE SET bankgiro = EXCLUDED.bankgiro`,
    [owner, companyId],
  )

  // Invoicing rows.
  const customerId = randomUUID()
  await pool.query(
    `INSERT INTO public.customers (id, user_id, company_id, name, customer_type)
     VALUES ($1, $2, $3, 'Kund AB', 'swedish_business')`,
    [customerId, owner, companyId],
  )
  const invoiceId = randomUUID()
  await pool.query(
    `INSERT INTO public.invoices (id, user_id, company_id, customer_id, invoice_date, due_date, currency)
     VALUES ($1, $2, $3, $4, '2026-10-01', '2026-10-31', 'SEK')`,
    [invoiceId, owner, companyId, customerId],
  )
  await pool.query(
    `INSERT INTO public.invoice_items (id, invoice_id, sort_order, description, quantity, unit, unit_price, line_total, vat_rate, vat_amount)
     VALUES ($1, $2, 0, 'Konsultation', 1, 'st', 1000, 1000, 25, 250)`,
    [randomUUID(), invoiceId],
  )
  await pool.query(
    `INSERT INTO public.articles (id, company_id, user_id, name) VALUES ($1, $2, $3, 'Timme')`,
    [randomUUID(), companyId, owner],
  )
  await pool.query(
    `INSERT INTO public.sales_orders (company_id, user_id, customer_id, status, order_date)
     VALUES ($1, $2, $3, 'draft', '2026-10-01')`,
    [companyId, owner, customerId],
  )

  // Rows the role must never see.
  await pool.query(
    `INSERT INTO public.employees
       (company_id, user_id, first_name, last_name, personnummer, personnummer_last4, employment_start, monthly_salary)
     VALUES ($1, $2, 'Anna', 'Anställd', 'enc-payload', '0000', '2026-01-01', 41000)`,
    [companyId, owner],
  )
  await pool.query(
    `INSERT INTO public.salary_runs (company_id, user_id, period_year, period_month, payment_date)
     VALUES ($1, $2, 2026, 9, '2026-09-25')`,
    [companyId, owner],
  )
  await pool.query(
    `INSERT INTO public.agi_declarations (company_id, user_id, period_year, period_month, xml_content, individuppgifter)
     VALUES ($1, $2, 2026, 9, '<xml/>', '[]'::jsonb)`,
    [companyId, owner],
  )
  await insertPostedJournalEntry({
    userId: owner,
    companyId,
    fiscalPeriodId,
  })
  const cashAccountId = await insertCashAccount({ companyId, ledgerAccount: '1940' })
  await insertTransaction({ companyId, userId: owner, amount: -41000, description: 'Lön Anna', cashAccountId })
  const documentId = randomUUID()
  await pool.query(
    `INSERT INTO public.document_attachments
       (id, user_id, company_id, file_name, mime_type, file_size_bytes, storage_path, sha256_hash, upload_source)
     VALUES ($1, $2, $3, 'lonespec.pdf', 'application/pdf', 1024, $4, $5, 'file_upload')`,
    [documentId, owner, companyId, `documents/${companyId}/${documentId}.pdf`, 'cd'.repeat(32)],
  )
  await pool.query(
    `INSERT INTO public.webhooks (company_id, event_type, webhook_url, secret)
     VALUES ($1, 'invoice.created', 'https://hooks.example.test/in', 'secret')`,
    [companyId],
  )

  seed = { companyId, owner, member, viewer, invoicer, invoiceId }
})

describe('invoicer role: reads', () => {
  it('reads the invoicing tables the pages read straight from the browser', async () => {
    const counts = await withUserContext(seed.invoicer, async (client) => {
      const out: Record<string, number> = {}
      for (const table of INVOICING_TABLES) out[table] = await countRows(client, table, seed.companyId)
      return out
    })
    for (const table of INVOICING_TABLES) expect(counts[table], table).toBeGreaterThan(0)
  })

  it('gets zero rows from payroll, the ledger, the bank, documents, AGI and webhooks', async () => {
    const counts = await withUserContext(seed.invoicer, async (client) => {
      const out: Record<string, number> = {}
      for (const table of DENIED_TABLES) out[table] = await countRows(client, table, seed.companyId)
      return out
    })
    for (const table of DENIED_TABLES) expect(counts[table], table).toBe(0)
  })

  it('sees the company row and its own membership, never the other members', async () => {
    const result = await withUserContext(seed.invoicer, async (client) => {
      const companies = await client.query(`SELECT id FROM public.companies WHERE id = $1`, [seed.companyId])
      const members = await client.query<{ user_id: string }>(
        `SELECT user_id FROM public.company_members WHERE company_id = $1`,
        [seed.companyId],
      )
      return { companies: companies.rows.length, members: members.rows.map((r) => r.user_id) }
    })
    expect(result.companies).toBe(1)
    expect(result.members).toEqual([seed.invoicer])
  })

  it('reads an invoice\'s delivery history through the definer reader, by its own membership (for #206)', async () => {
    // GET /api/invoices/[id]/deliveries runs on the role's own session
    // (INVOICER_ROUTES, `session`): list_invoice_delivery_summaries asks for
    // a member of the active company, whatever the role. Nothing is seeded,
    // so the answer is an empty history, not a refusal.
    const result = await withUserContext(seed.invoicer, (client) =>
      client.query(`SELECT id FROM public.list_invoice_delivery_summaries($1, $2)`, [seed.companyId, seed.invoiceId]),
    )
    expect(result.rows).toEqual([])
  })

  it('is left out of the shared membership checks', async () => {
    const result = await withUserContext(seed.invoicer, async (client) => {
      const ids = await client.query(`SELECT * FROM public.user_company_ids()`)
      const canWrite = await client.query<{ ok: boolean }>(`SELECT public.current_user_can_write() AS ok`)
      const canWriteCompany = await client.query<{ ok: boolean }>(
        `SELECT public.caller_can_write_company($1) AS ok`,
        [seed.companyId],
      )
      const active = await client.query<{ id: string | null }>(`SELECT public.current_active_company_id() AS id`)
      return {
        ids: ids.rows.length,
        canWrite: canWrite.rows[0].ok,
        canWriteCompany: canWriteCompany.rows[0].ok,
        active: active.rows[0].id,
      }
    })
    expect(result).toEqual({ ids: 0, canWrite: false, canWriteCompany: false, active: seed.companyId })
  })
})

describe('invoicer role: writes', () => {
  it('cannot write the invoicing tables through PostgREST', async () => {
    const messages = await withUserContext(seed.invoicer, async (client) => [
      await expectRefused(
        client,
        `INSERT INTO public.customers (user_id, company_id, name, customer_type) VALUES ($1, $2, 'Ny kund', 'swedish_business')`,
        [seed.invoicer, seed.companyId],
      ),
      await expectRefused(
        client,
        `INSERT INTO public.invoices (user_id, company_id, invoice_date, due_date) VALUES ($1, $2, '2026-10-01', '2026-10-31')`,
        [seed.invoicer, seed.companyId],
      ),
    ])
    for (const message of messages) expect(message).toMatch(/row-level security|no write access/i)

    const updated = await withUserContext(seed.invoicer, (client) =>
      client.query(`UPDATE public.invoices SET currency = currency WHERE id = $1`, [seed.invoiceId]),
    )
    expect(updated.rowCount).toBe(0)
  })

  it('is refused by the definer functions that check membership themselves', async () => {
    const customerId = randomUUID()
    const result = await withUserContext(seed.invoicer, async (client) => {
      const preview = await client.query<{ r: { ok: boolean; code?: string } }>(
        `SELECT public.customer_merge_preview($1, $2, ARRAY[$3]::uuid[]) AS r`,
        [seed.companyId, customerId, randomUUID()],
      )
      const undo = await expectRefused(client, `SELECT public.undo_register_import($1, $2)`, [
        seed.companyId,
        randomUUID(),
      ])
      return { preview: preview.rows[0].r, undo }
    })
    expect(result.preview).toMatchObject({ ok: false, code: 'CUSTOMER_MERGE_FORBIDDEN' })
    expect(result.undo).toMatch(/no write access/)

    const member = await withUserContext(seed.member, (client) =>
      client.query<{ r: { ok: boolean; code?: string } }>(
        `SELECT public.customer_merge_preview($1, $2, ARRAY[$3]::uuid[]) AS r`,
        [seed.companyId, customerId, randomUUID()],
      ),
    )
    expect(member.rows[0].r.code).not.toBe('CUSTOMER_MERGE_FORBIDDEN')
  })

  it('carries the role exclusion in every function the migration changed', async () => {
    const { rows } = await getPool().query<{ proname: string; patched: boolean }>(
      `SELECT p.proname, p.prosrc LIKE '%invoicer%' AS patched
       FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.proname = ANY($1)`,
      [
        [
          'user_company_ids',
          'current_user_can_write',
          'caller_can_write_company',
          'undo_register_import',
          'remove_collection_batch_items',
          'customer_merge_preview',
          'merge_customers',
          'undo_customer_merge',
        ],
      ],
    )
    expect(rows.length).toBe(8)
    expect(rows.filter((r) => !r.patched).map((r) => r.proname)).toEqual([])
  })
})

describe('existing roles are unchanged', () => {
  it('owner, member and viewer read every seeded table', async () => {
    for (const user of [seed.owner, seed.member, seed.viewer]) {
      const counts = await withUserContext(user, async (client) => {
        const out: Record<string, number> = {}
        for (const table of [...INVOICING_TABLES, ...DENIED_TABLES]) {
          out[table] = await countRows(client, table, seed.companyId)
        }
        return out
      })
      for (const [table, n] of Object.entries(counts)) expect(n, `${user} ${table}`).toBeGreaterThan(0)
    }
  })

  it('member writes, viewer does not', async () => {
    const member = await withUserContext(seed.member, async (client) => {
      const canWrite = await client.query<{ ok: boolean }>(`SELECT public.current_user_can_write() AS ok`)
      const inserted = await client.query(
        `INSERT INTO public.customers (user_id, company_id, name, customer_type)
         VALUES ($1, $2, 'Medlemmens kund', 'swedish_business') RETURNING id`,
        [seed.member, seed.companyId],
      )
      const quote = await client.query<{ n: string }>(`SELECT public.generate_quote_number($1) AS n`, [seed.companyId])
      return { canWrite: canWrite.rows[0].ok, inserted: inserted.rowCount, quote: quote.rows[0].n }
    })
    expect(member.canWrite).toBe(true)
    expect(member.inserted).toBe(1)
    expect(member.quote).toMatch(/^OF-\d+/)

    const viewer = await withUserContext(seed.viewer, async (client) => {
      const canWrite = await client.query<{ ok: boolean }>(`SELECT public.current_user_can_write() AS ok`)
      const ids = await client.query(`SELECT * FROM public.user_company_ids()`)
      const refused = await expectRefused(
        client,
        `INSERT INTO public.customers (user_id, company_id, name, customer_type) VALUES ($1, $2, 'Läsarens kund', 'swedish_business')`,
        [seed.viewer, seed.companyId],
      )
      return { canWrite: canWrite.rows[0].ok, ids: ids.rows.length, refused }
    })
    expect(viewer.canWrite).toBe(false)
    expect(viewer.ids).toBe(1)
    expect(viewer.refused).toMatch(/row-level security|no write access/i)
  })

  it('member and viewer see every membership row, as before', async () => {
    for (const user of [seed.member, seed.viewer]) {
      const { rows } = await withUserContext(user, (client) =>
        client.query(`SELECT user_id FROM public.company_members WHERE company_id = $1`, [seed.companyId]),
      )
      expect(rows.length, user).toBe(4)
    }
  })
})
