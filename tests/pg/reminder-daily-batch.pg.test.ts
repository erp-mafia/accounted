import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { getPool, withUserContext } from './setup'
import { seedCompany } from './fixtures'

/**
 * The daily reminder batch (migration 20261027120100_reminder_daily_batch.sql):
 * the reminder_daily_batch operation type, one pending batch per company and
 * one batch per company and day, staged by the system only, and taking items
 * out through the collections batch's removals (kind 'reminder').
 */

interface Seed {
  companyId: string
  userId: string
}

function item(invoiceId: string) {
  return {
    kind: 'reminder',
    invoice_id: invoiceId,
    invoice_number: `F-${invoiceId.slice(0, 4)}`,
    customer_name: 'Kund AB',
    recipient: 'kund@example.se',
    due_date: '2026-12-02',
    level: 1,
    remaining_amount: 1250,
    currency: 'SEK',
    bank: 'fresh',
  }
}

function batchParams(items: unknown[], batchDate = '2026-12-17') {
  return { batch_date: batchDate, items, excluded: [] }
}

async function stageBatch(seed: Seed, params: unknown, status = 'pending'): Promise<string> {
  const { rows } = await getPool().query<{ id: string }>(
    `INSERT INTO public.pending_operations (company_id, user_id, operation_type, title, params, status, risk_level, actor_type)
     VALUES ($1, $2, 'reminder_daily_batch', 'Påminnelser', $3::jsonb, $4, 'high', 'cron')
     RETURNING id`,
    [seed.companyId, seed.userId, JSON.stringify(params), status],
  )
  return rows[0]!.id
}

async function remove(userId: string, id: string, invoiceIds: string[]) {
  return withUserContext(userId, async (client) => {
    const { rows } = await client.query<{ result: { removed: number; remaining: number } }>(
      'SELECT public.remove_collection_batch_items($1, $2::uuid[]) AS result',
      [id, invoiceIds],
    )
    // withUserContext rolls back: read what the call wrote inside the transaction.
    const written = await client.query<{ invoice_id: string; kind: string }>(
      'SELECT invoice_id, kind FROM public.collection_batch_removals WHERE pending_operation_id = $1',
      [id],
    )
    const audit = await client.query<{ description: string }>('SELECT description FROM public.audit_log WHERE record_id = $1', [id])
    return { result: rows[0]!.result, written: written.rows, audit: audit.rows }
  })
}

describe('reminder_daily_batch rows (pg)', () => {
  it('accepts the type and keeps one pending batch per company', async () => {
    const seed = await seedCompany()
    await stageBatch(seed, batchParams([item(randomUUID())], '2026-12-15'))
    await expect(stageBatch(seed, batchParams([item(randomUUID())], '2026-12-16'))).rejects.toThrow(/pending_operations_reminder_batch_pending_uniq/)
  })

  it('keeps one batch per company and day, whatever became of the first, beside a collections batch', async () => {
    const seed = await seedCompany()
    await stageBatch(seed, batchParams([item(randomUUID())]), 'rejected')
    await expect(stageBatch(seed, batchParams([item(randomUUID())]))).rejects.toThrow(/pending_operations_reminder_batch_day_uniq/)
    // The same company's collections batch that day is another type.
    await expect(
      getPool().query(
        `INSERT INTO public.pending_operations (company_id, user_id, operation_type, title, params, status, risk_level, actor_type)
         VALUES ($1, $2, 'collections_daily_batch', 'Inkassoomgång', $3::jsonb, 'pending', 'high', 'cron')`,
        [seed.companyId, seed.userId, JSON.stringify({ batch_date: '2026-12-17', connection_id: randomUUID(), items: [], excluded: [] })],
      ),
    ).resolves.toBeTruthy()
  })

  it('is staged by the system only: a member cannot insert one through the API', async () => {
    const seed = await seedCompany()
    await withUserContext(seed.userId, async (client) => {
      await client.query(`SELECT set_config('request.jwt.claim.role', 'authenticated', true)`)
      await expect(
        client.query(
          `INSERT INTO public.pending_operations (company_id, user_id, operation_type, title, params)
           VALUES ($1, $2, 'reminder_daily_batch', 'x', $3::jsonb)`,
          [seed.companyId, seed.userId, JSON.stringify(batchParams([item(randomUUID())]))],
        ),
      ).rejects.toThrow(/REMINDER_BATCH_SYSTEM_ONLY/)
    })
  })
})

describe('remove_collection_batch_items on a reminder batch (pg)', () => {
  it('lets the owner take a reminder out, recorded as kind reminder, with an audit row naming the batch', async () => {
    const seed = await seedCompany()
    const [a, b] = [randomUUID(), randomUUID()]
    const id = await stageBatch(seed, batchParams([item(a), item(b)]))

    const { result, written, audit } = await remove(seed.userId, id, [b])

    expect(result).toEqual({ removed: 1, remaining: 1 })
    expect(written).toEqual([{ invoice_id: b, kind: 'reminder' }])
    expect(audit.map((row) => row.description)).toEqual(['Removed 1 item(s) from a reminder batch'])
  })

  it('keeps the last reminder in: the batch is rejected instead', async () => {
    const seed = await seedCompany()
    const a = randomUUID()
    const id = await stageBatch(seed, batchParams([item(a)]))
    await expect(remove(seed.userId, id, [a])).rejects.toThrow(/COLLECTION_BATCH_EMPTY/)
  })

  it('still refuses another operation type', async () => {
    const seed = await seedCompany()
    const { rows } = await getPool().query<{ id: string }>(
      `INSERT INTO public.pending_operations (company_id, user_id, operation_type, title) VALUES ($1, $2, 'create_invoice', 'x') RETURNING id`,
      [seed.companyId, seed.userId],
    )
    await expect(remove(seed.userId, rows[0]!.id, [randomUUID()])).rejects.toThrow(/COLLECTION_BATCH_NOT_FOUND/)
  })

  it('refuses an unknown item kind on the removals table', async () => {
    const seed = await seedCompany()
    const id = await stageBatch(seed, batchParams([item(randomUUID())]))
    await expect(
      getPool().query(
        `INSERT INTO public.collection_batch_removals (company_id, pending_operation_id, invoice_id, kind, removed_by) VALUES ($1, $2, $3, 'letter', $4)`,
        [seed.companyId, id, randomUUID(), seed.userId],
      ),
    ).rejects.toThrow(/collection_batch_removals_kind_check/)
  })
})
