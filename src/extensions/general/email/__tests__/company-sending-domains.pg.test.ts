import { describe, it, expect, beforeAll } from 'vitest'
import { randomUUID } from 'node:crypto'
import { getPool, withUserContext, runAsServiceRole } from '@/tests/pg/setup'
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

    // Dot-atom rule (20260822130000): no trailing or consecutive dots.
    for (const bad of ['faktura.', 'fak..tura', '.faktura']) {
      await expect(
        getPool().query(`UPDATE public.company_sending_domains SET sender_local_part = $2 WHERE company_id = $1`, [
          companyId,
          bad,
        ]),
      ).rejects.toThrow(/sender_local_part_check/)
    }
    const ok = await getPool().query(
      `UPDATE public.company_sending_domains SET sender_local_part = 'fak.tura' WHERE company_id = $1`,
      [companyId],
    )
    expect(ok.rowCount).toBe(1)
  })

  it('a Resend domain id maps to at most one row', async () => {
    await getPool().query(
      `UPDATE public.company_sending_domains SET resend_domain_id = 'rd_unique' WHERE company_id = $1`,
      [companyId],
    )
    await expect(
      getPool().query(
        `INSERT INTO public.company_sending_domains (company_id, domain, resend_domain_id) VALUES ($1, $2, 'rd_unique')`,
        [otherCompanyId, `other-${domain}`],
      ),
    ).rejects.toThrow(/idx_company_sending_domains_resend_id/)
  })

  it('rejects a malformed or non-lowercase domain (domain_shape CHECK)', async () => {
    await expect(
      getPool().query(`UPDATE public.company_sending_domains SET domain = 'Not A Domain' WHERE company_id = $1`, [
        companyId,
      ]),
    ).rejects.toThrow(/company_sending_domains_domain_shape/)
    await expect(
      getPool().query(`UPDATE public.company_sending_domains SET domain = 'Upper.Example' WHERE company_id = $1`, [
        companyId,
      ]),
    ).rejects.toThrow(/company_sending_domains_domain_shape/)
  })

  it('tenant guard: an owner cannot open a claim as verified, nor touch verification state', async () => {
    // Fresh owner + company so the unique indexes do not interfere.
    const forgerId = await insertAuthUser()
    const forgerCompanyId = await insertCompany({ createdBy: forgerId })
    await insertCompanyMember({ companyId: forgerCompanyId, userId: forgerId, role: 'owner' })

    await expect(
      withUserContext(forgerId, (c) =>
        c.query(
          `INSERT INTO public.company_sending_domains (company_id, domain, status)
           VALUES ($1, $2, 'verified')`,
          [forgerCompanyId, `forged-${domain}`],
        ),
      ),
    ).rejects.toThrow(/tenant claim starts as pending/)

    await expect(
      withUserContext(forgerId, (c) =>
        c.query(
          `INSERT INTO public.company_sending_domains (company_id, domain, resend_domain_id)
           VALUES ($1, $2, 'rd_forged')`,
          [forgerCompanyId, `forged-${domain}`],
        ),
      ),
    ).rejects.toThrow(/tenant claim starts as pending/)

    // A pending claim is fine for the tenant (what the route does)...
    const pending = await withUserContext(forgerId, (c) =>
      c.query(
        `INSERT INTO public.company_sending_domains (company_id, domain) VALUES ($1, $2) RETURNING status`,
        [forgerCompanyId, `forged-${domain}`],
      ),
    )
    expect(pending.rows[0].status).toBe('pending')

    // ...but on the seeded row the owner can neither verify it nor retarget it.
    await expect(
      withUserContext(ownerId, (c) =>
        c.query(`UPDATE public.company_sending_domains SET status = 'verified' WHERE company_id = $1`, [companyId]),
      ),
    ).rejects.toThrow(/server-managed/)
    await expect(
      withUserContext(ownerId, (c) =>
        c.query(`UPDATE public.company_sending_domains SET domain = 'other.example' WHERE company_id = $1`, [
          companyId,
        ]),
      ),
    ).rejects.toThrow(/server-managed/)
    await expect(
      withUserContext(ownerId, (c) =>
        c.query(`UPDATE public.company_sending_domains SET resend_domain_id = 'rd_x' WHERE company_id = $1`, [
          companyId,
        ]),
      ),
    ).rejects.toThrow(/server-managed/)

    // Sender presentation stays tenant-editable.
    const presentation = await withUserContext(ownerId, (c) =>
      c.query(
        `UPDATE public.company_sending_domains
            SET sender_local_part = 'ekonomi', sender_name = 'Ekonomi', enabled = true
          WHERE company_id = $1`,
        [companyId],
      ),
    )
    expect(presentation.rowCount).toBe(1)
  })

  it('tenant guard: the service role and direct sessions may write verification state', async () => {
    await runAsServiceRole(async (c) => {
      const r = await c.query(
        `UPDATE public.company_sending_domains
            SET status = 'verified', resend_domain_id = 'rd_pg', verified_at = now(), last_checked_at = now()
          WHERE company_id = $1`,
        [companyId],
      )
      expect(r.rowCount).toBe(1)
    })
    const { rows } = await getPool().query(
      `SELECT status, resend_domain_id FROM public.company_sending_domains WHERE company_id = $1`,
      [companyId],
    )
    expect(rows[0]).toEqual({ status: 'verified', resend_domain_id: 'rd_pg' })
    // Direct (superuser) session: allowed, used by the other tests above.
    const direct = await getPool().query(
      `UPDATE public.company_sending_domains SET status = 'pending' WHERE company_id = $1`,
      [companyId],
    )
    expect(direct.rowCount).toBe(1)
  })

  it('one domain per company, and a domain belongs to one company (case-insensitive)', async () => {
    await expect(
      getPool().query(`INSERT INTO public.company_sending_domains (company_id, domain) VALUES ($1, $2)`, [
        companyId,
        `second-${domain}`,
      ]),
    ).rejects.toThrow(/idx_company_sending_domains_company/)

    // Same domain for another company: the global unique index wins.
    await expect(
      getPool().query(`INSERT INTO public.company_sending_domains (company_id, domain) VALUES ($1, $2)`, [
        otherCompanyId,
        domain,
      ]),
    ).rejects.toThrow(/idx_company_sending_domains_domain/)
    // Case variants never reach the index: the domain_shape CHECK
    // (20260822130000) requires lowercase, so uniqueness is case-insensitive
    // by construction.
    await expect(
      getPool().query(`INSERT INTO public.company_sending_domains (company_id, domain) VALUES ($1, $2)`, [
        otherCompanyId,
        domain.toUpperCase(),
      ]),
    ).rejects.toThrow(/company_sending_domains_domain_shape/)
  })
})
