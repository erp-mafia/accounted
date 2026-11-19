import { randomUUID } from 'node:crypto'
import type { PoolClient } from 'pg'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { seedCompany } from '@/tests/pg/fixtures'
import { getClient } from '@/tests/pg/setup'

/**
 * payment_batch_psus.psu_ip_address (20261031210500): the IP address a
 * signing was started from, sent again on its payments' unattended status
 * reads. Nullable, a single host address only, and the table stays service
 * role only.
 */

let client: PoolClient
let owner: Awaited<ReturnType<typeof seedCompany>>
let batchId: string

beforeEach(async () => {
  owner = await seedCompany()
  client = await getClient()
  await client.query('BEGIN')
  batchId = randomUUID()
  await client.query(
    `INSERT INTO public.payment_order_batches (id, company_id, user_id, provider, signing_target, order_count, total_amount, currency)
     VALUES ($1, $2, $3, 'open_payments', 'payment', 1, 1000, 'SEK')`,
    [batchId, owner.companyId, owner.userId],
  )
  await client.query(`INSERT INTO public.payment_batch_psus (batch_id, company_id, psu_id_enc) VALUES ($1, $2, '\\xc0ffee')`, [batchId, owner.companyId])
})

afterEach(async () => {
  await client.query('ROLLBACK').catch(() => {})
  client.release()
})

async function setIp(value: string | null): Promise<void> {
  await client.query(`UPDATE public.payment_batch_psus SET psu_ip_address = $2 WHERE batch_id = $1`, [batchId, value])
}

async function ip(): Promise<string | null> {
  const { rows } = await client.query<{ ip: string | null }>(`SELECT psu_ip_address::text AS ip FROM public.payment_batch_psus WHERE batch_id = $1`, [batchId])
  return rows[0]!.ip
}

describe('payment_batch_psus.psu_ip_address (pg)', () => {
  it('is nullable: a row kept before it existed, or without an address, reads null', async () => {
    const { rows } = await client.query<{ is_nullable: string; data_type: string }>(
      `SELECT is_nullable, data_type FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'payment_batch_psus' AND column_name = 'psu_ip_address'`,
    )
    expect(rows).toEqual([{ is_nullable: 'YES', data_type: 'inet' }])
    expect(await ip()).toBeNull()
  })

  it('keeps an IPv4 or IPv6 host address and clears back to null', async () => {
    await setIp('203.0.113.10')
    expect(await ip()).toBe('203.0.113.10/32')
    await setIp('2001:db8::1')
    expect(await ip()).toBe('2001:db8::1/128')
    await setIp(null)
    expect(await ip()).toBeNull()
  })

  it('refuses a network and anything that is not an address', async () => {
    await client.query('SAVEPOINT refused')
    await expect(setIp('10.0.0.0/8')).rejects.toThrow(/payment_batch_psus_ip_is_host/)
    await client.query('ROLLBACK TO SAVEPOINT refused')
    await expect(setIp('2001:db8::/32')).rejects.toThrow(/payment_batch_psus_ip_is_host/)
    await client.query('ROLLBACK TO SAVEPOINT refused')
    await expect(setIp('not-an-ip')).rejects.toThrow(/invalid input syntax/i)
    await client.query('ROLLBACK TO SAVEPOINT refused')
  })

  it('stays service role only: no browser session reads the column, member or not', async () => {
    await setIp('203.0.113.10')
    for (const role of ['anon', 'authenticated']) {
      await client.query('SAVEPOINT denied')
      await client.query("SELECT set_config('request.jwt.claim.sub', $1, true), set_config('request.jwt.claims', $2, true)", [
        owner.userId,
        JSON.stringify({ sub: owner.userId, role }),
      ])
      await client.query(`SET LOCAL ROLE ${role}`)
      await expect(client.query(`SELECT psu_ip_address FROM public.payment_batch_psus`)).rejects.toThrow(/permission denied/i)
      await client.query('ROLLBACK TO SAVEPOINT denied')
    }
    await client.query('SET LOCAL ROLE service_role')
    await client.query(`UPDATE public.payment_batch_psus SET psu_ip_address = NULL WHERE batch_id = $1`, [batchId])
    await client.query('RESET ROLE')
    expect(await ip()).toBeNull()
  })

  it('RLS is unchanged: enabled, with no policy', async () => {
    const { rows } = await client.query<{ rls: boolean; policies: number }>(
      `SELECT c.relrowsecurity AS rls, (SELECT count(*)::int FROM pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'payment_batch_psus') AS policies
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relname = 'payment_batch_psus'`,
    )
    expect(rows).toEqual([{ rls: true, policies: 0 }])
  })
})
