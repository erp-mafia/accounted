import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { getPool, runAsServiceRole, withUserContext } from './setup'
import { insertAuthUser, insertCompanyMember, seedCompany, setActiveCompany } from './fixtures'

/**
 * merge_customers / undo_customer_merge (20261023003000, crm#1398, crm#1299):
 * every row that names a duplicate card moves to the surviving card in one
 * transaction, the duplicate is archived (never deleted), the merge is
 * recorded, and undo moves back exactly the rows it moved.
 */

type Seeded = { userId: string; companyId: string }

async function customer(c: Seeded, name: string, over: { org?: string; vat?: string; number?: string; archived?: boolean } = {}): Promise<string> {
  const id = randomUUID()
  await getPool().query(
    `INSERT INTO public.customers (id, company_id, user_id, name, customer_type, org_number, vat_number, customer_number, archived_at)
     VALUES ($1, $2, $3, $4, 'swedish_business', $5, $6, $7, CASE WHEN $8 THEN now() ELSE NULL END)`,
    [id, c.companyId, c.userId, name, over.org ?? null, over.vat ?? null, over.number ?? null, over.archived ?? false],
  )
  return id
}

async function invoice(c: Seeded, customerId: string, number: string | null, status = 'sent'): Promise<string> {
  const id = randomUUID()
  await getPool().query(
    `INSERT INTO public.invoices (id, company_id, user_id, customer_id, invoice_number, invoice_date, due_date, status, currency, subtotal, vat_amount, total, vat_treatment, paid_amount, remaining_amount)
     VALUES ($1, $2, $3, $4, $5, '2026-09-12', '2026-10-12', $6, 'SEK', 400, 100, 500, 'standard_25', 0, 500)`,
    [id, c.companyId, c.userId, customerId, number, status],
  )
  return id
}

/** One of each other row that names a customer, on `customerId`. */
async function dependents(c: Seeded, customerId: string) {
  const pool = getPool()
  const order = (await pool.query<{ id: string }>(
    `INSERT INTO public.sales_orders (company_id, user_id, customer_id, status, order_date)
     VALUES ($1, $2, $3, 'draft', '2026-09-01') RETURNING id`, [c.companyId, c.userId, customerId])).rows[0]!.id
  const schedule = (await pool.query<{ id: string }>(
    `INSERT INTO public.recurring_invoice_schedules (company_id, user_id, customer_id, name, day_of_month, next_run_date)
     VALUES ($1, $2, $3, 'Månadsavgift', 1, '2026-11-01') RETURNING id`, [c.companyId, c.userId, customerId])).rows[0]!.id
  const deadline = (await pool.query<{ id: string }>(
    `INSERT INTO public.deadlines (company_id, user_id, customer_id, title, due_date, deadline_type)
     VALUES ($1, $2, $3, 'Leverans', '2026-11-15', 'delivery') RETURNING id`, [c.companyId, c.userId, customerId])).rows[0]!.id
  const source = (await pool.query<{ id: string }>(
    `INSERT INTO public.migration_source_records (company_id, user_id, provider, account_key, resource, source_id, target_id)
     VALUES ($1, $2, 'visma', 'acct', 'customers', $3, $4) RETURNING id`,
    [c.companyId, c.userId, `src-${customerId}`, customerId])).rows[0]!.id
  return { order, schedule, deadline, source }
}

type Answer = { ok: boolean; code?: string; details?: Record<string, unknown> } & Record<string, unknown>

/** merge_customers, or with dryRun its read-only preview (customer_merge_preview). */
function merge(c: Seeded, survivor: string, merged: string[], dryRun = false, actor = c.userId): Promise<Answer> {
  const fn = dryRun ? 'customer_merge_preview' : 'merge_customers'
  return runAsServiceRole(async (client) =>
    (await client.query<{ r: Answer }>(`SELECT public.${fn}($1, $2, $3::uuid[], $4) AS r`,
      [c.companyId, survivor, merged, actor])).rows[0]!.r)
}

function undo(c: Seeded, mergeId: string, actor = c.userId): Promise<Answer> {
  return runAsServiceRole(async (client) =>
    (await client.query<{ r: Answer }>(`SELECT public.undo_customer_merge($1, $2, $3) AS r`, [c.companyId, mergeId, actor])).rows[0]!.r)
}

async function owners(table: string, ids: string[], column = 'customer_id'): Promise<string[]> {
  const { rows } = await getPool().query<{ owner: string }>(
    `SELECT ${column}::text AS owner FROM public.${table} WHERE id = ANY ($1::uuid[]) ORDER BY id`, [ids])
  return rows.map((r) => r.owner)
}

async function archivedAt(id: string): Promise<Date | null> {
  return (await getPool().query<{ a: Date | null }>(`SELECT archived_at AS a FROM public.customers WHERE id = $1`, [id])).rows[0]!.a
}

describe('merge_customers (pg)', () => {
  it('moves every row of the duplicate to the survivor, archives the duplicate and records the merge', async () => {
    const c = await seedCompany()
    const survivor = await customer(c, 'Myndigheten, avd A', { org: '202100-0001', number: '120' })
    const duplicate = await customer(c, 'Myndigheten Avdelning A', { org: '2021000001', number: '120' })
    const history = [await invoice(c, survivor, '1001'), await invoice(c, survivor, '1002')]
    const moved = [await invoice(c, duplicate, '1003'), await invoice(c, duplicate, null, 'draft')]
    const rows = await dependents(c, duplicate)

    const preview = await merge(c, survivor, [duplicate], true)
    expect(preview).toMatchObject({ ok: true, dry_run: true, totals: { invoices: 2, sales_orders: 1, recurring_invoice_schedules: 1, deadlines: 1 } })
    expect((preview.merged as Answer[])[0]).toMatchObject({ customer_id: duplicate, merge_id: null, source_records: 1 })
    expect(await owners('invoices', moved)).toEqual(moved.map(() => duplicate))
    expect(await archivedAt(duplicate)).toBeNull()

    const done = await merge(c, survivor, [duplicate])
    expect(done).toMatchObject({ ok: true, dry_run: false, survivor: { customer_id: survivor } })
    const mergeId = (done.merged as Answer[])[0]!.merge_id as string
    expect(mergeId).toBeTruthy()

    expect(await owners('invoices', [...history, ...moved])).toEqual([...history, ...moved].map(() => survivor))
    expect(await owners('sales_orders', [rows.order])).toEqual([survivor])
    expect(await owners('recurring_invoice_schedules', [rows.schedule])).toEqual([survivor])
    expect(await owners('deadlines', [rows.deadline])).toEqual([survivor])
    expect(await owners('migration_source_records', [rows.source], 'target_id')).toEqual([survivor])
    expect(await archivedAt(duplicate)).not.toBeNull()
    expect(await archivedAt(survivor)).toBeNull()

    const log = await getPool().query<{ survivor_id: string; merged_id: string; user_id: string; invoices: string[] }>(
      `SELECT survivor_id, merged_id, user_id, ARRAY(SELECT jsonb_array_elements_text(moved->'invoices')) AS invoices
       FROM public.customer_merges WHERE id = $1`, [mergeId])
    expect(log.rows[0]).toEqual({ survivor_id: survivor, merged_id: duplicate, user_id: c.userId, invoices: [...moved].sort() })

    // The archived duplicate is kept: a merge names it.
    await expect(getPool().query(`DELETE FROM public.customers WHERE id = $1`, [duplicate])).rejects.toMatchObject({ code: '23503' })
  })

  it('refuses two legal persons, an archived survivor, the survivor among the merged, and cards of another company', async () => {
    const c = await seedCompany()
    const other = await seedCompany()
    const survivor = await customer(c, 'Exempel AB', { org: '556677-8899', vat: 'SE556677889901' })
    const otherOrg = await customer(c, 'Exempel AB', { org: '559900-1122' })
    const otherVat = await customer(c, 'Exempel AB', { vat: 'SE559900112201' })
    const archived = await customer(c, 'Exempel AB', { archived: true })
    const foreign = await customer(other, 'Exempel AB')

    expect(await merge(c, survivor, [otherOrg])).toMatchObject({ ok: false, code: 'CUSTOMER_MERGE_IDENTITY_CONFLICT', details: { field: 'org_number' } })
    expect(await merge(c, survivor, [otherVat])).toMatchObject({ ok: false, code: 'CUSTOMER_MERGE_IDENTITY_CONFLICT', details: { field: 'vat_number' } })
    expect(await merge(c, archived, [survivor])).toMatchObject({ ok: false, code: 'CUSTOMER_MERGE_SURVIVOR_ARCHIVED' })
    expect(await merge(c, survivor, [survivor])).toMatchObject({ ok: false, code: 'VALIDATION_ERROR' })
    expect(await merge(c, survivor, [foreign])).toMatchObject({ ok: false, code: 'CUSTOMER_NOT_FOUND', details: { customer_ids: [foreign] } })
    expect(await merge(c, foreign, [archived])).toMatchObject({ ok: false, code: 'CUSTOMER_NOT_FOUND' })
    // An archived duplicate may be merged: its invoices still move.
    const kept = await invoice(c, archived, '2001')
    expect(await merge(c, survivor, [archived])).toMatchObject({ ok: true, merged: [{ customer_id: archived, was_archived: true, invoices: 1 }] })
    expect(await owners('invoices', [kept])).toEqual([survivor])
    expect(await getPool().query(`SELECT 1 FROM public.customer_merges WHERE company_id = $1`, [other.companyId]).then((r) => r.rowCount)).toBe(0)
  })

  it('refuses a viewer, an outsider and a service call on behalf of a non-member', async () => {
    const c = await seedCompany()
    const viewer = await insertAuthUser()
    await insertCompanyMember({ companyId: c.companyId, userId: viewer, role: 'viewer' })
    const outsider = await insertAuthUser()
    const survivor = await customer(c, 'A')
    const duplicate = await customer(c, 'B')

    for (const user of [viewer, outsider]) {
      const answer = await withUserContext(user, async (client) =>
        (await client.query<{ r: Answer }>(`SELECT public.merge_customers($1, $2, $3::uuid[], $4) AS r`,
          [c.companyId, survivor, [duplicate], c.userId])).rows[0]!.r)
      expect(answer).toMatchObject({ ok: false, code: 'CUSTOMER_MERGE_FORBIDDEN' })
    }
    expect(await merge(c, survivor, [duplicate], false, outsider)).toMatchObject({ ok: false, code: 'CUSTOMER_MERGE_FORBIDDEN' })
    expect(await archivedAt(duplicate)).toBeNull()
  })

  it('merges as the signed-in owner through the user-scoped client', async () => {
    const c = await seedCompany()
    const survivor = await customer(c, 'A')
    const duplicate = await customer(c, 'A')
    const inv = await invoice(c, duplicate, '3001')
    await setActiveCompany(c.userId, c.companyId)
    // withUserContext rolls back, so assert inside it.
    await withUserContext(c.userId, async (client) => {
      const answer = (await client.query<{ r: Answer }>(`SELECT public.merge_customers($1, $2, $3::uuid[]) AS r`,
        [c.companyId, survivor, [duplicate]])).rows[0]!.r
      expect(answer).toMatchObject({ ok: true, totals: { invoices: 1 } })
      const owner = (await client.query<{ o: string }>(`SELECT customer_id::text AS o FROM public.invoices WHERE id = $1`, [inv])).rows[0]!.o
      expect(owner).toBe(survivor)
      const visible = (await client.query(`SELECT 1 FROM public.customer_merges WHERE company_id = $1`, [c.companyId])).rowCount
      expect(visible).toBe(1)
    })
  })
})

describe('undo_customer_merge (pg)', () => {
  it('moves back the rows the merge moved, restores the card, and refuses a second undo', async () => {
    const c = await seedCompany()
    const survivor = await customer(c, 'A')
    const duplicate = await customer(c, 'A')
    const moved = await invoice(c, duplicate, '4001')
    const rows = await dependents(c, duplicate)
    const done = await merge(c, survivor, [duplicate])
    const mergeId = (done.merged as Answer[])[0]!.merge_id as string
    // Written after the merge on the survivor: stays there.
    const later = await invoice(c, survivor, '4002')

    expect(await undo(c, mergeId)).toMatchObject({
      ok: true, restored_customer_id: duplicate,
      restored: { invoices: 1, sales_orders: 1, recurring_invoice_schedules: 1, deadlines: 1, source_records: 1 },
    })
    expect(await owners('invoices', [moved])).toEqual([duplicate])
    expect(await owners('invoices', [later])).toEqual([survivor])
    expect(await owners('migration_source_records', [rows.source], 'target_id')).toEqual([duplicate])
    expect(await archivedAt(duplicate)).toBeNull()
    expect(await undo(c, mergeId)).toMatchObject({ ok: false, code: 'CUSTOMER_MERGE_ALREADY_UNDONE' })
  })

  it('refuses after 30 days, for another company, and while the survivor was merged on', async () => {
    const c = await seedCompany()
    const other = await seedCompany()
    const a = await customer(c, 'A')
    const b = await customer(c, 'A')
    const z = await customer(c, 'A')
    const first = ((await merge(c, a, [b])).merged as Answer[])[0]!.merge_id as string
    const second = ((await merge(c, z, [a])).merged as Answer[])[0]!.merge_id as string

    expect(await undo(other, first, other.userId)).toMatchObject({ ok: false, code: 'CUSTOMER_MERGE_NOT_FOUND' })
    expect(await undo(c, first)).toMatchObject({ ok: false, code: 'CUSTOMER_MERGE_UNDO_BLOCKED' })
    expect(await undo(c, second)).toMatchObject({ ok: true })
    await getPool().query(`UPDATE public.customer_merges SET created_at = now() - interval '31 days' WHERE id = $1`, [first])
    expect(await undo(c, first)).toMatchObject({ ok: false, code: 'CUSTOMER_MERGE_UNDO_EXPIRED' })
  })

  it('accepts merge_customers as a pending operation type', async () => {
    const c = await seedCompany()
    await expect(getPool().query(
      `INSERT INTO public.pending_operations (user_id, company_id, operation_type, title) VALUES ($1, $2, 'merge_customers', 'pg') RETURNING id`,
      [c.userId, c.companyId],
    )).resolves.toMatchObject({ rowCount: 1 })
  })
})
