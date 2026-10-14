import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { insertAuthUser, insertCompany, insertCompanyMember, seedCompany } from '@/tests/pg/fixtures'
import { getClient, getPool, runAsServiceRole, withUserContext } from '@/tests/pg/setup'

const VISIBLE = 'company_id, status, valid_until, checked_at, link_created_at, link_expires_at, handed_off_at, started_by'

async function seedRecord(companyId: string, overrides: { status?: string; validUntil?: string | null; startedBy?: string | null } = {}): Promise<void> {
  await getPool().query(
    `INSERT INTO public.company_payment_verifications
       (company_id, status, valid_until, checked_at, link_created_at, link_url, link_expires_at, handed_off_at, started_by)
     VALUES ($1, $2, $3, now(), now(), $4, now() + interval '24 hours', NULL, $5)`,
    [companyId, overrides.status ?? 'valid', overrides.validUntil ?? '2027-10-03', `https://kyc.example/?instanceId=${randomUUID()}`, overrides.startedBy ?? null],
  )
}

describe('company_payment_verifications.pg: one row per company, members read it without the form URL, the server writes it', () => {
  it('holds one row per company', async () => {
    const { companyId } = await seedCompany()
    await seedRecord(companyId)
    await expect(seedRecord(companyId)).rejects.toThrow(/duplicate key|unique/i)
    const { rows } = await getPool().query<{ count: string }>(`SELECT count(*) FROM public.company_payment_verifications WHERE company_id = $1`, [companyId])
    expect(Number(rows[0]!.count)).toBe(1)
  })

  it('lets every member read the company\'s record, but never the form URL', async () => {
    const { userId: ownerId, companyId } = await seedCompany()
    await seedRecord(companyId, { startedBy: ownerId })
    for (const role of ['owner', 'admin', 'member', 'viewer'] as const) {
      const userId = role === 'owner' ? ownerId : await insertAuthUser()
      if (role !== 'owner') await insertCompanyMember({ companyId, userId, role })
      await withUserContext(userId, async (client) => {
        const read = await client.query<{ status: string; valid_until: string; started_by: string }>(
          `SELECT ${VISIBLE} FROM public.company_payment_verifications WHERE company_id = $1`,
          [companyId],
        )
        expect(read.rows).toHaveLength(1)
        expect(read.rows[0]!.status).toBe('valid')
      })
      // One context per statement: a refused statement aborts its transaction.
      await withUserContext(userId, async (client) => {
        await expect(client.query(`SELECT link_url FROM public.company_payment_verifications WHERE company_id = $1`, [companyId])).rejects.toThrow(/permission denied/i)
      })
      await withUserContext(userId, async (client) => {
        await expect(client.query(`SELECT * FROM public.company_payment_verifications WHERE company_id = $1`, [companyId])).rejects.toThrow(/permission denied/i)
      })
    }
  })

  it('hides a company\'s record from the members of another company', async () => {
    const { companyId } = await seedCompany()
    await seedRecord(companyId, { validUntil: '2026-11-01' })
    const otherOwner = await insertAuthUser()
    const otherCompany = await insertCompany({ createdBy: otherOwner })
    await insertCompanyMember({ companyId: otherCompany, userId: otherOwner, role: 'owner' })
    await withUserContext(otherOwner, async (client) => {
      const read = await client.query<{ count: string }>(`SELECT count(*) FROM public.company_payment_verifications`)
      expect(Number(read.rows[0]!.count)).toBe(0)
    })
  })

  it('refuses every write from a browser session and from anon; the service role upserts and updates', async () => {
    const { userId, companyId } = await seedCompany()
    await withUserContext(userId, async (client) => {
      await expect(
        client.query(`INSERT INTO public.company_payment_verifications (company_id, status) VALUES ($1, 'valid')`, [companyId]),
      ).rejects.toThrow(/permission denied/i)
    })
    await seedRecord(companyId)
    await withUserContext(userId, async (client) => {
      await expect(client.query(`UPDATE public.company_payment_verifications SET status = 'valid' WHERE company_id = $1`, [companyId])).rejects.toThrow(/permission denied/i)
    })
    await withUserContext(userId, async (client) => {
      await expect(client.query(`DELETE FROM public.company_payment_verifications WHERE company_id = $1`, [companyId])).rejects.toThrow(/permission denied/i)
    })
    const anon = await getClient()
    try {
      await anon.query('BEGIN')
      await anon.query('SET LOCAL ROLE anon')
      await expect(anon.query(`SELECT company_id FROM public.company_payment_verifications`)).rejects.toThrow(/permission denied/i)
    } finally {
      await anon.query('ROLLBACK').catch(() => {})
      anon.release()
    }

    // The server's write path: the check upsert leaves the link columns alone; a new link replaces them.
    await runAsServiceRole(async (service) => {
      const upserted = await service.query(
        `INSERT INTO public.company_payment_verifications (company_id, status, valid_until, checked_at)
         VALUES ($1, 'valid', '2027-10-03', now())
         ON CONFLICT (company_id) DO UPDATE SET status = EXCLUDED.status, valid_until = EXCLUDED.valid_until, checked_at = EXCLUDED.checked_at`,
        [companyId],
      )
      expect(upserted.rowCount).toBe(1)
      const handed = await service.query(
        `UPDATE public.company_payment_verifications SET handed_off_at = now() WHERE company_id = $1 AND link_expires_at > now() RETURNING link_url`,
        [companyId],
      )
      expect(handed.rowCount).toBe(1)
      expect(handed.rows[0]!.link_url).toMatch(/^https:\/\/kyc\.example\//)
    })
    const { rows } = await getPool().query<{ status: string; handed_off_at: string | null; link_url: string | null; updated_at: string; created_at: string }>(
      `SELECT status, handed_off_at, link_url, updated_at, created_at FROM public.company_payment_verifications WHERE company_id = $1`,
      [companyId],
    )
    expect(rows[0]!.status).toBe('valid')
    expect(rows[0]!.handed_off_at).not.toBeNull()
    expect(rows[0]!.link_url).not.toBeNull()
    expect(new Date(rows[0]!.updated_at).getTime()).toBeGreaterThanOrEqual(new Date(rows[0]!.created_at).getTime())
  })

  it('keeps the link columns consistent and the status to the three the provider answers', async () => {
    const { companyId } = await seedCompany()
    await expect(
      getPool().query(`INSERT INTO public.company_payment_verifications (company_id, status) VALUES ($1, 'Valid')`, [companyId]),
    ).rejects.toThrow(/check constraint/i)
    await expect(
      getPool().query(`INSERT INTO public.company_payment_verifications (company_id, link_expires_at) VALUES ($1, now())`, [companyId]),
    ).rejects.toThrow(/check constraint/i)
    await expect(
      getPool().query(`INSERT INTO public.company_payment_verifications (company_id, handed_off_at) VALUES ($1, now())`, [companyId]),
    ).rejects.toThrow(/check constraint/i)
    await expect(
      getPool().query(
        `INSERT INTO public.company_payment_verifications (company_id, link_created_at, link_expires_at) VALUES ($1, now(), now() - interval '1 hour')`,
        [companyId],
      ),
    ).rejects.toThrow(/check constraint/i)
  })
})
