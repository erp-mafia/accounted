import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { getPool, withUserContext } from './setup'
import { insertAuthUser, insertCompanyMember, seedCompany } from './fixtures'

/**
 * The daily collections batch (migration 20261012030600_collection_daily_batch.sql):
 * customers.collections_excluded, the collections_daily_batch operation type,
 * one pending batch per company and one batch per company and day, and the
 * batch guard (system-staged, removal only while pending, audited).
 */

interface Seed {
  companyId: string
  userId: string
}

function item(invoiceId: string, overrides: Record<string, unknown> = {}) {
  return {
    kind: 'open',
    invoice_id: invoiceId,
    case_id: null,
    invoice_number: `F-${invoiceId.slice(0, 4)}`,
    customer_name: 'Kund AB',
    due_date: '2026-09-01',
    remaining_amount: 1250,
    start_step: 'reminder',
    decision_kind: null,
    reminder_fee_agreed: false,
    bank_check: 'pass',
    ...overrides,
  }
}

function batchParams(items: unknown[], batchDate = '2026-10-07') {
  return {
    batch_date: batchDate,
    connection_id: randomUUID(),
    items,
    excluded: [{ kind: 'open', invoice_id: randomUUID(), invoice_number: 'F-9', customer_name: 'Annan AB', due_date: '2026-09-02', reason: 'bank_stale', block: null }],
  }
}

async function stageBatch(seed: Seed, params: unknown, status = 'pending'): Promise<string> {
  const { rows } = await getPool().query<{ id: string }>(
    `INSERT INTO public.pending_operations (company_id, user_id, operation_type, title, params, status, risk_level, actor_type)
     VALUES ($1, $2, 'collections_daily_batch', 'Inkassoomgång', $3::jsonb, $4, 'high', 'cron')
     RETURNING id`,
    [seed.companyId, seed.userId, JSON.stringify(params), status],
  )
  return rows[0]!.id
}

async function freshCompany(): Promise<Seed> {
  const { companyId, userId } = await seedCompany()
  return { companyId, userId }
}

async function readParams(id: string): Promise<{ items: Array<{ invoice_id: string }>; removed?: unknown[] }> {
  const { rows } = await getPool().query<{ params: { items: Array<{ invoice_id: string }>; removed?: unknown[] } }>(
    'SELECT params FROM public.pending_operations WHERE id = $1',
    [id],
  )
  return rows[0]!.params
}

describe('customers.collections_excluded', () => {
  it('defaults to false and can be set', async () => {
    const seed = await freshCompany()
    const id = randomUUID()
    await getPool().query(
      `INSERT INTO public.customers (id, user_id, company_id, name, customer_type) VALUES ($1, $2, $3, 'Kund AB', 'swedish_business')`,
      [id, seed.userId, seed.companyId],
    )
    const before = await getPool().query<{ collections_excluded: boolean }>('SELECT collections_excluded FROM public.customers WHERE id = $1', [id])
    expect(before.rows[0]!.collections_excluded).toBe(false)
    await getPool().query('UPDATE public.customers SET collections_excluded = true WHERE id = $1', [id])
    const after = await getPool().query<{ collections_excluded: boolean }>('SELECT collections_excluded FROM public.customers WHERE id = $1', [id])
    expect(after.rows[0]!.collections_excluded).toBe(true)
  })
})

describe('collections_daily_batch rows', () => {
  it('accepts the type and keeps one pending batch per company', async () => {
    const seed = await freshCompany()
    await stageBatch(seed, batchParams([item(randomUUID())], '2026-10-05'))
    await expect(stageBatch(seed, batchParams([item(randomUUID())], '2026-10-06'))).rejects.toThrow(/pending_operations_collections_batch_pending_uniq/)
  })

  it('keeps one batch per company and day, whatever became of the first', async () => {
    const seed = await freshCompany()
    await stageBatch(seed, batchParams([item(randomUUID())], '2026-10-07'), 'rejected')
    await expect(stageBatch(seed, batchParams([item(randomUUID())], '2026-10-07'))).rejects.toThrow(/pending_operations_collections_batch_day_uniq/)
    // Another company the same day is its own batch.
    const other = await freshCompany()
    await expect(stageBatch(other, batchParams([item(randomUUID())], '2026-10-07'))).resolves.toBeTruthy()
  })

  it('is staged by the system only: a member cannot insert one through the API', async () => {
    const seed = await freshCompany()
    await withUserContext(seed.userId, async (client) => {
      await client.query(`SELECT set_config('request.jwt.claim.role', 'authenticated', true)`)
      await expect(
        client.query(
          `INSERT INTO public.pending_operations (company_id, user_id, operation_type, title, params)
           VALUES ($1, $2, 'collections_daily_batch', 'x', $3::jsonb)`,
          [seed.companyId, seed.userId, JSON.stringify(batchParams([item(randomUUID())]))],
        ),
      ).rejects.toThrow(/COLLECTION_BATCH_SYSTEM_ONLY/)
    })
  })

  it('keeps its params, type and preview frozen once staged', async () => {
    const seed = await freshCompany()
    const params = batchParams([item(randomUUID())])
    const id = await stageBatch(seed, params)
    await expect(
      getPool().query(`UPDATE public.pending_operations SET params = $2::jsonb WHERE id = $1`, [id, JSON.stringify({ ...params, items: [] })]),
    ).rejects.toThrow(/frozen/)
    await expect(getPool().query(`UPDATE public.pending_operations SET operation_type = 'create_invoice' WHERE id = $1`, [id])).rejects.toThrow(/frozen/)
  })

  it('moves through its statuses with its params untouched', async () => {
    const seed = await freshCompany()
    const id = await stageBatch(seed, batchParams([item(randomUUID())]))
    await getPool().query(`UPDATE public.pending_operations SET status = 'committing' WHERE id = $1`, [id])
    await getPool().query(
      `UPDATE public.pending_operations SET status = 'committed', resolved_at = now(), result_data = '{"done_count":1}'::jsonb WHERE id = $1`,
      [id],
    )
    const { rows } = await getPool().query<{ status: string }>('SELECT status FROM public.pending_operations WHERE id = $1', [id])
    expect(rows[0]!.status).toBe('committed')
  })
})

describe('remove_collection_batch_items', () => {
  async function removals(id: string): Promise<Array<{ invoice_id: string; kind: string; removed_by: string }>> {
    const { rows } = await getPool().query<{ invoice_id: string; kind: string; removed_by: string }>(
      'SELECT invoice_id, kind, removed_by FROM public.collection_batch_removals WHERE pending_operation_id = $1 ORDER BY removed_at',
      [id],
    )
    return rows
  }

  async function remove(userId: string, id: string, invoiceIds: string[]): Promise<{ removed: number; remaining: number }> {
    return withUserContext(userId, async (client) => {
      const { rows } = await client.query<{ result: { removed: number; remaining: number } }>(
        'SELECT public.remove_collection_batch_items($1, $2::uuid[]) AS result',
        [id, invoiceIds],
      )
      // withUserContext rolls back: copy what the call wrote out of the transaction for the assertions.
      const written = await client.query('SELECT invoice_id, kind, removed_by FROM public.collection_batch_removals WHERE pending_operation_id = $1', [id])
      const audit = await client.query('SELECT actor_id, description, new_state FROM public.audit_log WHERE record_id = $1', [id])
      lastWritten = { removals: written.rows, audit: audit.rows }
      return rows[0]!.result
    })
  }
  let lastWritten: { removals: Array<Record<string, unknown>>; audit: Array<Record<string, unknown>> } = { removals: [], audit: [] }

  it('lets the owner take items out, leaves the params as staged and writes an audit row naming them', async () => {
    const seed = await freshCompany()
    const [a, b, c] = [randomUUID(), randomUUID(), randomUUID()]
    const id = await stageBatch(seed, batchParams([item(a), item(b), item(c)]))
    const result = await remove(seed.userId, id, [b, randomUUID()])
    expect(result).toEqual({ removed: 1, remaining: 2 })
    expect(lastWritten.removals).toEqual([{ invoice_id: b, kind: 'open', removed_by: seed.userId }])
    expect(lastWritten.audit).toHaveLength(1)
    expect(lastWritten.audit[0]!.actor_id).toBe(seed.userId)
    // Only what was taken out: not the id outside the batch.
    expect((lastWritten.audit[0]!.new_state as { removed_invoice_ids: string[] }).removed_invoice_ids).toEqual([b])
    expect((await readParams(id)).items).toHaveLength(3)
  })

  it('takes an item out once: a second call removes nothing and writes no audit row', async () => {
    const seed = await freshCompany()
    const [a, b] = [randomUUID(), randomUUID()]
    const id = await stageBatch(seed, batchParams([item(a), item(b)]))
    await getPool().query(
      `INSERT INTO public.collection_batch_removals (company_id, pending_operation_id, invoice_id, kind, removed_by) VALUES ($1, $2, $3, 'open', $4)`,
      [seed.companyId, id, b, seed.userId],
    )
    const result = await remove(seed.userId, id, [b])
    expect(result).toEqual({ removed: 0, remaining: 1 })
    expect(lastWritten.audit).toHaveLength(0)
  })

  it('refuses taking out the last item: the batch is rejected instead', async () => {
    const seed = await freshCompany()
    const [a, b] = [randomUUID(), randomUUID()]
    const id = await stageBatch(seed, batchParams([item(a), item(b)]))
    await expect(remove(seed.userId, id, [a, b])).rejects.toThrow(/COLLECTION_BATCH_EMPTY/)
    expect(await removals(id)).toHaveLength(0)
  })

  it('refuses a decided batch', async () => {
    const seed = await freshCompany()
    const [a, b] = [randomUUID(), randomUUID()]
    const id = await stageBatch(seed, batchParams([item(a), item(b)]), 'rejected')
    await expect(remove(seed.userId, id, [a])).rejects.toThrow(/COLLECTION_BATCH_NOT_PENDING/)
  })

  it('answers not found for another company, another operation type and a member who is not an administrator', async () => {
    const seed = await freshCompany()
    const [a, b] = [randomUUID(), randomUUID()]
    const id = await stageBatch(seed, batchParams([item(a), item(b)]))
    const outsider = await freshCompany()
    await expect(remove(outsider.userId, id, [a])).rejects.toThrow(/COLLECTION_BATCH_NOT_FOUND/)

    const member = await insertAuthUser()
    await insertCompanyMember({ companyId: seed.companyId, userId: member, role: 'member' })
    await expect(remove(member, id, [a])).rejects.toThrow(/COLLECTION_BATCH_ADMIN_ONLY/)

    const admin = await insertAuthUser()
    await insertCompanyMember({ companyId: seed.companyId, userId: admin, role: 'admin' })
    await expect(remove(admin, id, [a])).resolves.toEqual({ removed: 1, remaining: 1 })

    const { rows } = await getPool().query<{ id: string }>(
      `INSERT INTO public.pending_operations (company_id, user_id, operation_type, title) VALUES ($1, $2, 'create_invoice', 'x') RETURNING id`,
      [seed.companyId, seed.userId],
    )
    await expect(remove(seed.userId, rows[0]!.id, [a])).rejects.toThrow(/COLLECTION_BATCH_NOT_FOUND/)
  })

  it('is readable by members only, and members cannot write removals directly', async () => {
    const seed = await freshCompany()
    const [a, b] = [randomUUID(), randomUUID()]
    const id = await stageBatch(seed, batchParams([item(a), item(b)]))
    await getPool().query(
      `INSERT INTO public.collection_batch_removals (company_id, pending_operation_id, invoice_id, kind, removed_by) VALUES ($1, $2, $3, 'open', $4)`,
      [seed.companyId, id, b, seed.userId],
    )
    const outsider = await freshCompany()
    const seen = await withUserContext(outsider.userId, async (client) =>
      (await client.query('SELECT 1 FROM public.collection_batch_removals WHERE pending_operation_id = $1', [id])).rowCount,
    )
    expect(seen).toBe(0)
    const own = await withUserContext(seed.userId, async (client) =>
      (await client.query('SELECT 1 FROM public.collection_batch_removals WHERE pending_operation_id = $1', [id])).rowCount,
    )
    expect(own).toBe(1)
    await expect(
      withUserContext(seed.userId, (client) =>
        client.query(
          `INSERT INTO public.collection_batch_removals (company_id, pending_operation_id, invoice_id, kind, removed_by) VALUES ($1, $2, $3, 'open', $4)`,
          [seed.companyId, id, a, seed.userId],
        ),
      ),
    ).rejects.toThrow(/permission denied/)
    await expect(
      withUserContext(seed.userId, (client) => client.query('DELETE FROM public.collection_batch_removals WHERE pending_operation_id = $1', [id])),
    ).rejects.toThrow(/permission denied/)
  })

  it('goes with its batch in a sandbox teardown cascade', async () => {
    const seed = await freshCompany()
    const [a, b] = [randomUUID(), randomUUID()]
    const id = await stageBatch(seed, batchParams([item(a), item(b)]))
    await getPool().query(
      `INSERT INTO public.collection_batch_removals (company_id, pending_operation_id, invoice_id, kind, removed_by) VALUES ($1, $2, $3, 'open', $4)`,
      [seed.companyId, id, b, seed.userId],
    )
    await getPool().query('DELETE FROM public.pending_operations WHERE id = $1', [id])
    expect(await removals(id)).toHaveLength(0)
  })
})
