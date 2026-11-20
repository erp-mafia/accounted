import { describe, expect, it } from 'vitest'
import { insertAuthUser, insertCompany, insertCompanyMember, seedCompany, setActiveCompany } from '@/tests/pg/fixtures'
import { getClient, getPool, runAsServiceRole, withUserContext } from '@/tests/pg/setup'

const INSERT = `INSERT INTO public.vat_check_reviews
  (company_id, period_type, period_start, period_end, check_code, action, fingerprint, note, source, actor)
  VALUES ($1, 'yearly', '2025-10-19', '2026-09-30', $2, $3, $4, $5, $6, $7) RETURNING id`

const FINGERPRINT = 'v1:0123456789abcdef'

async function seed() {
  const { userId, companyId } = await seedCompany()
  await setActiveCompany(userId, companyId)
  return { userId, companyId }
}

describe('vat_check_reviews.pg: a person reviews a VAT warning for a period, in their own name, append-only', () => {
  it('lets a writing member of the active company review and withdraw in their own name and read it back', async () => {
    const { userId, companyId } = await seed()
    const member = await insertAuthUser()
    await insertCompanyMember({ companyId, userId: member, role: 'member' })
    await setActiveCompany(member, companyId)
    for (const actor of [userId, member]) {
      await withUserContext(actor, async (client) => {
        const reviewed = await client.query(INSERT, [
          companyId, 'RC_BASIS_MISSING', 'reviewed', FINGERPRINT, 'Basbeloppet finns i A61', 'web', actor,
        ])
        expect(reviewed.rowCount).toBe(1)
        const withdrawn = await client.query(INSERT, [companyId, 'RC_BASIS_MISSING', 'withdrawn', null, null, 'web', actor])
        expect(withdrawn.rowCount).toBe(1)
        const read = await client.query<{ actor: string }>(
          `SELECT actor FROM public.vat_check_reviews WHERE company_id = $1`,
          [companyId],
        )
        expect(read.rows.map((r) => r.actor)).toContain(actor)
      })
    }
  })

  it('refuses a viewer, a review in someone else\'s name, and a company that is not the active one', async () => {
    const { userId, companyId } = await seed()
    const viewer = await insertAuthUser()
    await insertCompanyMember({ companyId, userId: viewer, role: 'viewer' })
    await setActiveCompany(viewer, companyId)
    await withUserContext(viewer, async (client) => {
      await expect(
        client.query(INSERT, [companyId, 'RC_BASIS_MISSING', 'reviewed', FINGERPRINT, null, 'web', viewer]),
      ).rejects.toThrow(/row-level security/i)
    })
    const member = await insertAuthUser()
    await insertCompanyMember({ companyId, userId: member, role: 'member' })
    await setActiveCompany(member, companyId)
    await withUserContext(member, async (client) => {
      await expect(
        client.query(INSERT, [companyId, 'RC_BASIS_MISSING', 'reviewed', FINGERPRINT, null, 'web', userId]),
      ).rejects.toThrow(/row-level security/i)
    })
    // The owner of a second company, with the first one active, cannot write into the second.
    const other = await insertCompany({ createdBy: userId })
    await insertCompanyMember({ companyId: other, userId, role: 'owner' })
    await withUserContext(userId, async (client) => {
      await expect(
        client.query(INSERT, [other, 'RC_BASIS_MISSING', 'reviewed', FINGERPRINT, null, 'web', userId]),
      ).rejects.toThrow(/row-level security/i)
    })
  })

  it('has no update or delete for a browser session, and hides a company\'s reviews from other companies and anon', async () => {
    const { userId, companyId } = await seed()
    const { rows } = await getPool().query<{ id: string }>(INSERT, [
      companyId, 'RC_INPUT_VAT_MISMATCH', 'reviewed', FINGERPRINT, null, 'web', userId,
    ])
    const id = rows[0]!.id
    await withUserContext(userId, async (client) => {
      await expect(
        client.query(`UPDATE public.vat_check_reviews SET fingerprint = 'v1:ffffffffffffffff' WHERE id = $1`, [id]),
      ).rejects.toThrow(/permission denied/i)
    })
    await withUserContext(userId, async (client) => {
      await expect(client.query(`DELETE FROM public.vat_check_reviews WHERE id = $1`, [id])).rejects.toThrow(/permission denied/i)
    })
    const outsider = await insertAuthUser()
    const outsiderCompany = await insertCompany({ createdBy: outsider })
    await insertCompanyMember({ companyId: outsiderCompany, userId: outsider, role: 'owner' })
    await withUserContext(outsider, async (client) => {
      const read = await client.query<{ n: number }>(`SELECT count(*)::int AS n FROM public.vat_check_reviews`)
      expect(read.rows[0]!.n).toBe(0)
    })
    const anon = await getClient()
    try {
      await anon.query('BEGIN')
      await anon.query('SET LOCAL ROLE anon')
      await expect(anon.query(`SELECT id FROM public.vat_check_reviews`)).rejects.toThrow(/permission denied/i)
    } finally {
      await anon.query('ROLLBACK').catch(() => {})
      anon.release()
    }
    // An approved agent proposal is written by the server as the service role.
    await runAsServiceRole(async (service) => {
      const inserted = await service.query(INSERT, [
        companyId, 'RC_BASIS_MISSING', 'reviewed', FINGERPRINT, null, 'agent', userId,
      ])
      expect(inserted.rowCount).toBe(1)
    })
  })

  it('keeps code, action, fingerprint, source and period to their shapes, and audits each row', async () => {
    const { userId, companyId } = await seed()
    // A review needs a fingerprint; a withdrawal has none.
    await expect(
      getPool().query(INSERT, [companyId, 'RC_BASIS_MISSING', 'reviewed', null, null, 'web', userId]),
    ).rejects.toThrow(/check constraint/i)
    await expect(
      getPool().query(INSERT, [companyId, 'RC_BASIS_MISSING', 'withdrawn', FINGERPRINT, null, 'web', userId]),
    ).rejects.toThrow(/check constraint/i)
    await expect(
      getPool().query(INSERT, [companyId, 'RC_BASIS_MISSING', 'reviewed', 'deadbeef', null, 'web', userId]),
    ).rejects.toThrow(/check constraint/i)
    await expect(
      getPool().query(INSERT, [companyId, 'rc basis', 'reviewed', FINGERPRINT, null, 'web', userId]),
    ).rejects.toThrow(/check constraint/i)
    await expect(
      getPool().query(INSERT, [companyId, 'RC_BASIS_MISSING', 'dismissed', FINGERPRINT, null, 'web', userId]),
    ).rejects.toThrow(/check constraint/i)
    await expect(
      getPool().query(INSERT, [companyId, 'RC_BASIS_MISSING', 'reviewed', FINGERPRINT, null, 'api_key', userId]),
    ).rejects.toThrow(/check constraint/i)
    await expect(
      getPool().query(INSERT, [companyId, 'RC_BASIS_MISSING', 'reviewed', FINGERPRINT, 'x'.repeat(1001), 'web', userId]),
    ).rejects.toThrow(/check constraint/i)
    await expect(
      getPool().query(
        `INSERT INTO public.vat_check_reviews
           (company_id, period_type, period_start, period_end, check_code, action, fingerprint, source, actor)
         VALUES ($1, 'monthly', '2026-03-31', '2026-03-01', 'RC_BASIS_MISSING', 'reviewed', $2, 'web', $3)`,
        [companyId, FINGERPRINT, userId],
      ),
    ).rejects.toThrow(/check constraint/i)

    const ok = await getPool().query<{ id: string }>(INSERT, [
      companyId, 'RC_BASIS_MISSING', 'reviewed', FINGERPRINT, 'Granskad', 'web', userId,
    ])
    const audit = await getPool().query<{ n: number }>(
      `SELECT count(*)::int AS n FROM public.audit_log WHERE table_name = 'vat_check_reviews' AND record_id = $1`,
      [ok.rows[0]!.id],
    )
    expect(audit.rows[0]!.n).toBe(1)
  })

  it('lets the staged tool\'s type into pending_operations', async () => {
    const { userId, companyId } = await seed()
    const staged = await getPool().query(
      `INSERT INTO public.pending_operations (user_id, company_id, operation_type, title)
       VALUES ($1, $2, 'mark_vat_check_reviewed', 'Markera momsvarning som granskad') RETURNING id`,
      [userId, companyId],
    )
    expect(staged.rowCount).toBe(1)
  })
})
