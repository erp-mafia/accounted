import { randomUUID } from 'node:crypto'
import type { PoolClient } from 'pg'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { seedCompany } from '@/tests/pg/fixtures'
import { getClient } from '@/tests/pg/setup'

/**
 * bank_connection_psus and payment_batch_psus (20261014230000): the PSU-ID a
 * bank consent or a signing's payments were created with, encrypted. Service
 * role only, and gone with their connection or signing.
 */

let client: PoolClient
let owner: Awaited<ReturnType<typeof seedCompany>>
let connectionId: string
let batchId: string

beforeEach(async () => {
  owner = await seedCompany()
  client = await getClient()
  await client.query('BEGIN')
  connectionId = randomUUID()
  batchId = randomUUID()
  await client.query(
    `INSERT INTO public.bank_connections (id, company_id, user_id, provider, aggregator, bic, status, session_id)
     VALUES ($1, $2, $3, 'open_payments', 'open_payments', 'SWEDSESS', 'pending', $4)`,
    [connectionId, owner.companyId, owner.userId, `consent-${connectionId}`],
  )
  await client.query(
    `INSERT INTO public.payment_order_batches (id, company_id, user_id, provider, signing_target, order_count, total_amount, currency)
     VALUES ($1, $2, $3, 'open_payments', 'payment', 1, 1000, 'SEK')`,
    [batchId, owner.companyId, owner.userId],
  )
  await client.query(
    `INSERT INTO public.bank_connection_psus (connection_id, company_id, psu_id_enc, source) VALUES ($1, $2, '\\xc0ffee', 'typed')`,
    [connectionId, owner.companyId],
  )
  await client.query(`INSERT INTO public.payment_batch_psus (batch_id, company_id, psu_id_enc) VALUES ($1, $2, '\\xc0ffee')`, [batchId, owner.companyId])
})

afterEach(async () => {
  await client.query('ROLLBACK').catch(() => {})
  client.release()
})

async function count(table: string, key: string, id: string): Promise<number> {
  const { rows } = await client.query<{ n: number }>(`SELECT count(*)::int AS n FROM public.${table} WHERE ${key} = $1`, [id])
  return rows[0]!.n
}

describe('resource PSU-IDs (pg)', () => {
  it.each(['bank_connection_psus', 'payment_batch_psus'])('%s: no browser session reaches it, member or not', async (table) => {
    for (const role of ['anon', 'authenticated']) {
      await client.query('SAVEPOINT denied')
      await client.query("SELECT set_config('request.jwt.claim.sub', $1, true), set_config('request.jwt.claims', $2, true)", [
        owner.userId,
        JSON.stringify({ sub: owner.userId, role }),
      ])
      await client.query(`SET LOCAL ROLE ${role}`)
      await expect(client.query(`SELECT psu_id_enc FROM public.${table}`)).rejects.toThrow(/permission denied/i)
      await client.query('ROLLBACK TO SAVEPOINT denied')
    }
  })

  it('the service role reads, upserts and deletes both', async () => {
    await client.query('SET LOCAL ROLE service_role')
    const { rows } = await client.query<{ psu_id_enc: string; source: string }>(
      `SELECT psu_id_enc, source FROM public.bank_connection_psus WHERE connection_id = $1`,
      [connectionId],
    )
    expect(rows[0]).toEqual({ psu_id_enc: '\\xc0ffee', source: 'typed' })
    await client.query(
      `INSERT INTO public.bank_connection_psus (connection_id, company_id, psu_id_enc, source) VALUES ($1, $2, '\\xbeef', 'signatory_link')
       ON CONFLICT (connection_id) DO UPDATE SET psu_id_enc = EXCLUDED.psu_id_enc, source = EXCLUDED.source`,
      [connectionId, owner.companyId],
    )
    expect((await client.query(`SELECT source FROM public.bank_connection_psus WHERE connection_id = $1`, [connectionId])).rows[0]).toEqual({ source: 'signatory_link' })
    expect((await client.query(`SELECT psu_id_enc FROM public.payment_batch_psus WHERE batch_id = $1`, [batchId])).rows).toHaveLength(1)
    await client.query(`DELETE FROM public.payment_batch_psus WHERE batch_id = $1`, [batchId])
    await client.query('RESET ROLE')
    expect(await count('payment_batch_psus', 'batch_id', batchId)).toBe(0)
  })

  it('refuses a source it does not know', async () => {
    await expect(
      client.query(`UPDATE public.bank_connection_psus SET source = 'guessed' WHERE connection_id = $1`, [connectionId]),
    ).rejects.toThrow(/check constraint/i)
  })

  it('goes with its connection and its signing', async () => {
    await client.query(`DELETE FROM public.bank_connections WHERE id = $1`, [connectionId])
    expect(await count('bank_connection_psus', 'connection_id', connectionId)).toBe(0)
    await client.query(`DELETE FROM public.payment_order_batches WHERE id = $1`, [batchId])
    expect(await count('payment_batch_psus', 'batch_id', batchId)).toBe(0)
  })
})
