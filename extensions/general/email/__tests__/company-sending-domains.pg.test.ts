import { describe, it, expect, beforeAll } from 'vitest'
import { randomUUID } from 'node:crypto'
import { getPool, withUserContext } from '@/tests/pg/setup'
import { insertAuthUser, insertCompany, insertCompanyMember } from '@/tests/pg/fixtures'

/**
 * company_sending_domains (20260822120000): RLS shape and column constraints.
 *   - members read their company's row, never another company's
 *   - only owner/admin may insert/update/delete
 *   - status, sender_local_part and sender_name are constrained
 *   - one domain per company, one company per domain (case-insensitive)
 */
describe('company_sending_domains', () => {
  let ownerId: string
  let memberId: string
  let outsiderId: string
  let companyId: string
  let otherCompanyId: string
  const domain = `pg-real-${randomUUID().slice(0, 8)}.example`

  beforeAll(async () => {
    ownerId = await insertAuthUser()
    memberId = await insertAuthUser()
    outsiderId = await insertAuthUser()
    companyId = await insertCompany({ createdBy: ownerId })
    otherCompanyId = await insertCompany({ createdBy: outsiderId })
    await insertCompanyMember({ companyId, userId: ownerId, role: 'owner' })
    await insertCompanyMember({ companyId, userId: memberId, role: 'member' })
    await insertCompanyMember({ companyId: otherCompanyId, userId: outsiderId, role: 'owner' })
    await getPool().query(
      `INSERT INTO public.company_sending_domains (company_id, domain) VALUES ($1, $2)`,
      [companyId, domain],
    )
  })

  it('defaults to pending, faktura@, enabled', async () => {
    const { rows } = await getPool().query(
      `SELECT status, sender_local_part, sender_name, enabled
         FROM public.company_sending_domains WHERE company_id = $1`,
      [companyId],
    )
    expect(rows[0]).toEqual({ status: 'pending', sender_local_part: 'faktura', sender_name: null, enabled: true })
  })

  it('members of the company can read the row; outsiders cannot', async () => {
    const own = await withUserContext(memberId, (c) =>
      c.query(`SELECT domain FROM public.company_sending_domains WHERE company_id = $1`, [companyId]),
    )
    expect(own.rows).toHaveLength(1)

    const foreign = await withUserContext(outsiderId, (c) =>
      c.query(`SELECT domain FROM public.company_sending_domains WHERE company_id = $1`, [companyId]),
    )
    expect(foreign.rows).toHaveLength(0)
  })

  it('a plain member cannot update or delete; the owner can', async () => {
    const memberUpdate = await withUserContext(memberId, (c) =>
      c.query(`UPDATE public.company_sending_domains SET enabled = false WHERE company_id = $1`, [companyId]),
    )
    expect(memberUpdate.rowCount).toBe(0)

    const memberDelete = await withUserContext(memberId, (c) =>
      c.query(`DELETE FROM public.company_sending_domains WHERE company_id = $1`, [companyId]),
    )
    expect(memberDelete.rowCount).toBe(0)

    const ownerUpdate = await withUserContext(ownerId, (c) =>
      c.query(`UPDATE public.company_sending_domains SET enabled = false WHERE company_id = $1`, [companyId]),
    )
    expect(ownerUpdate.rowCount).toBe(1)
  })

  it('a plain member cannot insert for their company; an outsider cannot insert for someone else', async () => {
    await expect(
      withUserContext(memberId, (c) =>
        c.query(`INSERT INTO public.company_sending_domains (company_id, domain) VALUES ($1, $2)`, [
          companyId,
          `member-${domain}`,
        ]),
      ),
    ).rejects.toThrow(/row-level security/)

    await expect(
      withUserContext(outsiderId, (c) =>
        c.query(`INSERT INTO public.company_sending_domains (company_id, domain) VALUES ($1, $2)`, [
          companyId,
          `outsider-${domain}`,
        ]),
      ),
    ).rejects.toThrow(/row-level security/)
  })

  it('enforces the status, local part and sender name constraints', async () => {
    await expect(
      getPool().query(`UPDATE public.company_sending_domains SET status = 'weird' WHERE company_id = $1`, [companyId]),
    ).rejects.toThrow(/company_sending_domains_status_check/)

    await expect(
      getPool().query(
        `UPDATE public.company_sending_domains SET sender_local_part = 'Not Valid' WHERE company_id = $1`,
        [companyId],
      ),
    ).rejects.toThrow(/sender_local_part_check/)

    await expect(
      getPool().query(`UPDATE public.company_sending_domains SET sender_name = '' WHERE company_id = $1`, [companyId]),
    ).rejects.toThrow(/sender_name_check/)
  })

  it('one domain per company, and a domain belongs to one company (case-insensitive)', async () => {
    await expect(
      getPool().query(`INSERT INTO public.company_sending_domains (company_id, domain) VALUES ($1, $2)`, [
        companyId,
        `second-${domain}`,
      ]),
    ).rejects.toThrow(/idx_company_sending_domains_company/)

    await expect(
      getPool().query(`INSERT INTO public.company_sending_domains (company_id, domain) VALUES ($1, $2)`, [
        otherCompanyId,
        domain.toUpperCase(),
      ]),
    ).rejects.toThrow(/idx_company_sending_domains_domain/)
  })
})
