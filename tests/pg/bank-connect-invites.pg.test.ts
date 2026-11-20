import { createHash, randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { insertAuthUser, insertCompany, insertCompanyMember, seedCompany } from '@/tests/pg/fixtures'
import { getClient, getPool, runAsServiceRole, withUserContext } from '@/tests/pg/setup'

const hashOf = (seed: string) => createHash('sha256').update(seed).digest('hex')

async function seedInvite(companyId: string, createdBy: string, seed = randomUUID()): Promise<string> {
  const { rows } = await getPool().query<{ id: string }>(
    `INSERT INTO public.bank_connect_invites (company_id, created_by, token_hash, offer_payments, expires_at)
     VALUES ($1, $2, $3, true, now() + interval '7 days') RETURNING id`,
    [companyId, createdBy, hashOf(seed)],
  )
  return rows[0]!.id
}

describe('bank_connect_invites.pg: who may create and read a signatory link', () => {
  it('lets an owner create and read the company\'s links', async () => {
    const { userId, companyId } = await seedCompany()
    await withUserContext(userId, async (client) => {
      const inserted = await client.query<{ id: string; expires_at: string }>(
        `INSERT INTO public.bank_connect_invites (company_id, created_by, token_hash, offer_payments, expires_at)
         VALUES ($1, $2, $3, false, now() + interval '7 days') RETURNING id, expires_at`,
        [companyId, userId, hashOf('owner-link')],
      )
      expect(inserted.rows[0]?.id).toBeTruthy()
      const read = await client.query<{ count: string }>(`SELECT count(*) FROM public.bank_connect_invites WHERE company_id = $1`, [companyId])
      expect(Number(read.rows[0]!.count)).toBe(1)
    })
  })

  it('lets an admin create a link but never in another member\'s name', async () => {
    const { userId: ownerId, companyId } = await seedCompany()
    const adminId = await insertAuthUser()
    await insertCompanyMember({ companyId, userId: adminId, role: 'admin' })
    await withUserContext(adminId, async (client) => {
      const own = await client.query(
        `INSERT INTO public.bank_connect_invites (company_id, created_by, token_hash, expires_at)
         VALUES ($1, $2, $3, now() + interval '7 days')`,
        [companyId, adminId, hashOf('admin-link')],
      )
      expect(own.rowCount).toBe(1)
      await expect(
        client.query(
          `INSERT INTO public.bank_connect_invites (company_id, created_by, token_hash, expires_at)
           VALUES ($1, $2, $3, now() + interval '7 days')`,
          [companyId, ownerId, hashOf('forged-creator')],
        ),
      ).rejects.toThrow(/row-level security/i)
    })
  })

  it('refuses a plain member and a viewer, and hides the rows from them', async () => {
    const { userId: ownerId, companyId } = await seedCompany()
    await seedInvite(companyId, ownerId)
    for (const role of ['member', 'viewer'] as const) {
      const userId = await insertAuthUser()
      await insertCompanyMember({ companyId, userId, role })
      // One context per statement: a refused statement aborts its transaction.
      await withUserContext(userId, async (client) => {
        const read = await client.query<{ count: string }>(`SELECT count(*) FROM public.bank_connect_invites WHERE company_id = $1`, [companyId])
        expect(Number(read.rows[0]!.count)).toBe(0)
      })
      await withUserContext(userId, async (client) => {
        await expect(
          client.query(
            `INSERT INTO public.bank_connect_invites (company_id, created_by, token_hash, expires_at)
             VALUES ($1, $2, $3, now() + interval '7 days')`,
            [companyId, userId, hashOf(`${role}-link`)],
          ),
        ).rejects.toThrow(/row-level security/i)
      })
    }
  })

  it('hides a company\'s links from the owner of another company', async () => {
    const { userId: ownerId, companyId } = await seedCompany()
    await seedInvite(companyId, ownerId)
    const otherOwner = await insertAuthUser()
    const otherCompany = await insertCompany({ createdBy: otherOwner })
    await insertCompanyMember({ companyId: otherCompany, userId: otherOwner, role: 'owner' })
    await withUserContext(otherOwner, async (client) => {
      const read = await client.query<{ count: string }>(`SELECT count(*) FROM public.bank_connect_invites`)
      expect(Number(read.rows[0]!.count)).toBe(0)
      await expect(
        client.query(
          `INSERT INTO public.bank_connect_invites (company_id, created_by, token_hash, expires_at)
           VALUES ($1, $2, $3, now() + interval '7 days')`,
          [companyId, otherOwner, hashOf('cross-company')],
        ),
      ).rejects.toThrow(/row-level security/i)
    })
  })

  it('keeps consumption and the mail log with the service role: no UPDATE for a session, none at all for anon', async () => {
    const { userId, companyId } = await seedCompany()
    const inviteId = await seedInvite(companyId, userId)
    // One context per statement: a refused statement aborts its transaction.
    await withUserContext(userId, async (client) => {
      await expect(client.query(`UPDATE public.bank_connect_invites SET consumed_at = now() WHERE id = $1`, [inviteId])).rejects.toThrow(/permission denied/i)
    })
    await withUserContext(userId, async (client) => {
      await expect(client.query(`DELETE FROM public.bank_connect_invites WHERE id = $1`, [inviteId])).rejects.toThrow(/permission denied/i)
    })
    const client = await getClient()
    try {
      await client.query('BEGIN')
      await client.query('SET LOCAL ROLE anon')
      await expect(client.query(`SELECT id FROM public.bank_connect_invites`)).rejects.toThrow(/permission denied/i)
    } finally {
      await client.query('ROLLBACK').catch(() => {})
      client.release()
    }
    await runAsServiceRole(async (service) => {
      const updated = await service.query(`UPDATE public.bank_connect_invites SET consumed_at = now(), mail_sent_at = now() WHERE id = $1`, [inviteId])
      expect(updated.rowCount).toBe(1)
    })
    const { rows } = await getPool().query<{ consumed_at: string | null }>(`SELECT consumed_at FROM public.bank_connect_invites WHERE id = $1`, [inviteId])
    expect(rows[0]!.consumed_at).not.toBeNull()
  })

  it('takes only a sha256 hex hash, a BIC-shaped bic and an expiry after creation', async () => {
    const { userId, companyId } = await seedCompany()
    await expect(
      getPool().query(
        `INSERT INTO public.bank_connect_invites (company_id, created_by, token_hash, expires_at)
         VALUES ($1, $2, 'clear-token-by-mistake', now() + interval '7 days')`,
        [companyId, userId],
      ),
    ).rejects.toThrow(/check constraint/i)
    await expect(
      getPool().query(
        `INSERT INTO public.bank_connect_invites (company_id, created_by, token_hash, bic, expires_at)
         VALUES ($1, $2, $3, 'swedbank', now() + interval '7 days')`,
        [companyId, userId, hashOf('bad-bic')],
      ),
    ).rejects.toThrow(/check constraint/i)
    await expect(
      getPool().query(
        `INSERT INTO public.bank_connect_invites (company_id, created_by, token_hash, expires_at)
         VALUES ($1, $2, $3, now() - interval '1 minute')`,
        [companyId, userId, hashOf('expired-at-birth')],
      ),
    ).rejects.toThrow(/check constraint/i)
  })
})
