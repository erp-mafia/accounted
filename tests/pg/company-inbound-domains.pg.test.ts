import { randomUUID } from 'node:crypto'
import { describe, it, expect } from 'vitest'
import { getPool, withUserContext } from './setup'
import { seedCompany, insertAuthUser, insertCompanyMember } from './fixtures'

// pg-real coverage for 20260701090000_company_inbound_domains: RLS (member
// SELECT, owner/admin-only writes), the two unique indexes (global
// lower(domain), one domain per company), the status CHECK, and the
// updated_at + audit triggers.

async function insertDomain(
  companyId: string,
  overrides: { domain?: string; status?: string } = {},
): Promise<string> {
  const id = randomUUID()
  await getPool().query(
    `INSERT INTO public.company_inbound_domains (id, company_id, domain, status)
     VALUES ($1, $2, $3, $4)`,
    [
      id,
      companyId,
      overrides.domain ?? `faktura-${id.slice(0, 8)}.example`,
      overrides.status ?? 'pending',
    ],
  )
  return id
}

describe('company_inbound_domains RLS', () => {
  it('lets company members read, strangers see nothing', async () => {
    const { userId, companyId } = await seedCompany()
    const rowId = await insertDomain(companyId)
    const stranger = await insertAuthUser()

    const ownerView = await withUserContext(userId, (client) =>
      client.query<{ id: string }>(
        `SELECT id FROM public.company_inbound_domains WHERE id = $1`,
        [rowId],
      ),
    )
    expect(ownerView.rows).toHaveLength(1)

    const strangerView = await withUserContext(stranger, (client) =>
      client.query<{ id: string }>(
        `SELECT id FROM public.company_inbound_domains WHERE id = $1`,
        [rowId],
      ),
    )
    expect(strangerView.rows).toHaveLength(0)
  })

  it('lets viewers read but not insert', async () => {
    const { companyId } = await seedCompany()
    const rowId = await insertDomain(companyId)
    const viewer = await insertAuthUser()
    await insertCompanyMember({ companyId, userId: viewer, role: 'viewer' })

    const viewerRead = await withUserContext(viewer, (client) =>
      client.query<{ id: string }>(
        `SELECT id FROM public.company_inbound_domains WHERE id = $1`,
        [rowId],
      ),
    )
    expect(viewerRead.rows).toHaveLength(1)

    const otherCompany = await seedCompany()
    await insertCompanyMember({ companyId: otherCompany.companyId, userId: viewer, role: 'viewer' })
    await expect(
      withUserContext(viewer, (client) =>
        client.query(
          `INSERT INTO public.company_inbound_domains (company_id, domain)
           VALUES ($1, $2)`,
          [otherCompany.companyId, `viewer-claim-${randomUUID().slice(0, 8)}.example`],
        ),
      ),
    ).rejects.toThrow(/row-level security/i)
  })

  it('lets admins insert and delete', async () => {
    const { companyId } = await seedCompany()
    const admin = await insertAuthUser()
    await insertCompanyMember({ companyId, userId: admin, role: 'admin' })

    // withUserContext always rolls back, so assert the insert via RETURNING
    // inside the same context.
    const inserted = await withUserContext(admin, (client) =>
      client.query<{ id: string }>(
        `INSERT INTO public.company_inbound_domains (company_id, domain)
         VALUES ($1, $2) RETURNING id`,
        [companyId, `admin-claim-${randomUUID().slice(0, 8)}.example`],
      ),
    )
    expect(inserted.rows).toHaveLength(1)

    // Seed via superuser (persists) so the RLS DELETE has a row to hit.
    const rowId = await insertDomain(companyId)
    const deleted = await withUserContext(admin, (client) =>
      client.query<{ id: string }>(
        `DELETE FROM public.company_inbound_domains WHERE id = $1 RETURNING id`,
        [rowId],
      ),
    )
    expect(deleted.rows).toHaveLength(1)
  })
})

describe('company_inbound_domains constraints', () => {
  it('enforces one owner per domain globally, case-insensitively', async () => {
    const { companyId } = await seedCompany()
    const other = await seedCompany()
    // Random per run: superuser seeds persist across runs on a local DB.
    const domain = `unique-claim-${randomUUID().slice(0, 8)}.example`
    await insertDomain(companyId, { domain })

    await expect(
      insertDomain(other.companyId, { domain: domain.toUpperCase() }),
    ).rejects.toThrow(/duplicate|unique/i)
  })

  it('enforces one custom domain per company', async () => {
    const { companyId } = await seedCompany()
    await insertDomain(companyId)

    await expect(insertDomain(companyId)).rejects.toThrow(/duplicate|unique/i)
  })

  it('rejects unknown status values', async () => {
    const { companyId } = await seedCompany()
    await expect(
      insertDomain(companyId, { status: 'sortof-verified' }),
    ).rejects.toThrow(/check/i)
  })
})

describe('company_inbound_domains triggers', () => {
  it('bumps updated_at on update', async () => {
    const { companyId } = await seedCompany()
    const rowId = await insertDomain(companyId)

    const before = await getPool().query<{ updated_at: string }>(
      `SELECT updated_at FROM public.company_inbound_domains WHERE id = $1`,
      [rowId],
    )
    await getPool().query(
      `UPDATE public.company_inbound_domains SET status = 'verified' WHERE id = $1`,
      [rowId],
    )
    const after = await getPool().query<{ updated_at: string }>(
      `SELECT updated_at FROM public.company_inbound_domains WHERE id = $1`,
      [rowId],
    )
    expect(new Date(after.rows[0].updated_at).getTime()).toBeGreaterThanOrEqual(
      new Date(before.rows[0].updated_at).getTime(),
    )
  })

  it('writes an audit row on insert', async () => {
    const { companyId } = await seedCompany()
    const rowId = await insertDomain(companyId)

    const audit = await getPool().query<{ count: string }>(
      `SELECT count(*)::text AS count FROM public.audit_log
       WHERE table_name = 'company_inbound_domains' AND record_id = $1`,
      [rowId],
    )
    expect(Number(audit.rows[0].count)).toBeGreaterThanOrEqual(1)
  })
})
