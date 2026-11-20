import { createHash, randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { insertAuthUser, insertCompany, insertCompanyMember, seedCompany } from '@/tests/pg/fixtures'
import { getClient, getPool, runAsServiceRole, withUserContext } from '@/tests/pg/setup'

const hashOf = (seed: string) => createHash('sha256').update(seed).digest('hex')

async function seedLink(companyId: string, createdBy: string, overrides: { orderIds?: string[] } = {}): Promise<string> {
  const { rows } = await getPool().query<{ id: string }>(
    `INSERT INTO public.payment_signing_links (company_id, created_by, token_hash, recipient_email, note, order_ids, total_amount, currency)
     VALUES ($1, $2, $3, 'anna@example.se', 'Oktober', $4::uuid[], 1250.50, 'SEK') RETURNING id`,
    [companyId, createdBy, hashOf(randomUUID()), overrides.orderIds ?? [randomUUID(), randomUUID()]],
  )
  return rows[0]!.id
}

describe('payment_signing_links.pg: who reads and writes a payment signing link', () => {
  it('lets every member of the company read its links, but never the token hash', async () => {
    const { userId: ownerId, companyId } = await seedCompany()
    await seedLink(companyId, ownerId)
    for (const role of ['owner', 'member', 'viewer'] as const) {
      const userId = role === 'owner' ? ownerId : await insertAuthUser()
      if (role !== 'owner') await insertCompanyMember({ companyId, userId, role })
      await withUserContext(userId, async (client) => {
        const read = await client.query<{ id: string; recipient_email: string; total_amount: string }>(
          `SELECT id, recipient_email, order_ids, total_amount, batch_id, consumed_at, cancelled_at FROM public.payment_signing_links WHERE company_id = $1`,
          [companyId],
        )
        expect(read.rows).toHaveLength(1)
        expect(read.rows[0]!.recipient_email).toBe('anna@example.se')
      })
      // One context per statement: a refused statement aborts its transaction.
      await withUserContext(userId, async (client) => {
        await expect(client.query(`SELECT token_hash FROM public.payment_signing_links WHERE company_id = $1`, [companyId])).rejects.toThrow(/permission denied/i)
      })
    }
  })

  it("hides a company's links from the owner of another company", async () => {
    const { userId: ownerId, companyId } = await seedCompany()
    await seedLink(companyId, ownerId)
    const otherOwner = await insertAuthUser()
    const otherCompany = await insertCompany({ createdBy: otherOwner })
    await insertCompanyMember({ companyId: otherCompany, userId: otherOwner, role: 'owner' })
    await withUserContext(otherOwner, async (client) => {
      const read = await client.query<{ count: string }>(`SELECT count(*) FROM public.payment_signing_links`)
      expect(Number(read.rows[0]!.count)).toBe(0)
    })
  })

  it('keeps every write with the service role: no INSERT, UPDATE or DELETE for a session, nothing at all for anon', async () => {
    const { userId, companyId } = await seedCompany()
    const linkId = await seedLink(companyId, userId)
    await withUserContext(userId, async (client) => {
      await expect(
        client.query(
          `INSERT INTO public.payment_signing_links (company_id, created_by, token_hash, order_ids, total_amount, currency)
           VALUES ($1, $2, $3, ARRAY[gen_random_uuid()], 10, 'SEK')`,
          [companyId, userId, hashOf('session-insert')],
        ),
      ).rejects.toThrow(/permission denied/i)
    })
    await withUserContext(userId, async (client) => {
      await expect(client.query(`UPDATE public.payment_signing_links SET consumed_at = now() WHERE id = $1`, [linkId])).rejects.toThrow(/permission denied/i)
    })
    await withUserContext(userId, async (client) => {
      await expect(client.query(`DELETE FROM public.payment_signing_links WHERE id = $1`, [linkId])).rejects.toThrow(/permission denied/i)
    })
    const client = await getClient()
    try {
      await client.query('BEGIN')
      await client.query('SET LOCAL ROLE anon')
      await expect(client.query(`SELECT id FROM public.payment_signing_links`)).rejects.toThrow(/permission denied/i)
    } finally {
      await client.query('ROLLBACK').catch(() => {})
      client.release()
    }
    await runAsServiceRole(async (service) => {
      const updated = await service.query(`UPDATE public.payment_signing_links SET mail_sent_at = now(), consumed_at = now() WHERE id = $1`, [linkId])
      expect(updated.rowCount).toBe(1)
    })
    const { rows } = await getPool().query<{ consumed_at: string | null }>(`SELECT consumed_at FROM public.payment_signing_links WHERE id = $1`, [linkId])
    expect(rows[0]!.consumed_at).not.toBeNull()
  })

  it('defaults a link to 72 hours', async () => {
    const { userId, companyId } = await seedCompany()
    const linkId = await seedLink(companyId, userId)
    const { rows } = await getPool().query<{ hours: string }>(
      `SELECT extract(epoch FROM (expires_at - created_at)) / 3600 AS hours FROM public.payment_signing_links WHERE id = $1`,
      [linkId],
    )
    expect(Math.round(Number(rows[0]!.hours))).toBe(72)
  })

  it('takes only a sha256 hash, 1 to 100 orders without a null, a positive total, an ISO currency, a short note, and never consumed and cancelled at once', async () => {
    const { userId, companyId } = await seedCompany()
    const insert = (columns: Record<string, string>) =>
      getPool().query(
        `INSERT INTO public.payment_signing_links (company_id, created_by, token_hash, order_ids, total_amount, currency, note, consumed_at, cancelled_at)
         VALUES ($1, $2, ${columns.token_hash ?? `'${hashOf(randomUUID())}'`}, ${columns.order_ids ?? 'ARRAY[gen_random_uuid()]'}, ${columns.total_amount ?? '10'},
                 ${columns.currency ?? `'SEK'`}, ${columns.note ?? 'NULL'}, ${columns.consumed_at ?? 'NULL'}, ${columns.cancelled_at ?? 'NULL'})`,
        [companyId, userId],
      )
    await expect(insert({ token_hash: `'clear-token-by-mistake'` })).rejects.toThrow(/check constraint/i)
    await expect(insert({ order_ids: `'{}'::uuid[]` })).rejects.toThrow(/check constraint/i)
    await expect(insert({ order_ids: `ARRAY[gen_random_uuid(), NULL]::uuid[]` })).rejects.toThrow(/check constraint/i)
    await expect(insert({ order_ids: `(SELECT array_agg(gen_random_uuid()) FROM generate_series(1, 101))` })).rejects.toThrow(/check constraint/i)
    await expect(insert({ total_amount: '0' })).rejects.toThrow(/check constraint/i)
    await expect(insert({ currency: `'sek'` })).rejects.toThrow(/check constraint/i)
    await expect(insert({ note: `repeat('x', 501)` })).rejects.toThrow(/check constraint/i)
    await expect(insert({ consumed_at: 'now()', cancelled_at: 'now()' })).rejects.toThrow(/check constraint/i)
    await expect(insert({ order_ids: `(SELECT array_agg(gen_random_uuid()) FROM generate_series(1, 100))`, note: `repeat('x', 500)` })).resolves.toBeTruthy()
  })
})
