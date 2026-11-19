import { describe, expect, it } from 'vitest'
import { getPool, withUserContext } from './setup'
import { insertAuthUser, insertCompanyMember, seedCompany } from './fixtures'

/**
 * 20261021083000_company_portals.sql: RLS (members read; writing members add
 * in their own name, change the link and remove; viewers and strangers do
 * none of it), the column grant that keeps the supplier fixed, the URL CHECKs
 * and the audit trail.
 */

const TELIA_URL = 'https://minasidor.telia.se/foretag'

async function insertPortal(
  companyId: string,
  userId: string,
  overrides: { key?: string; vendor?: string; url?: string } = {},
): Promise<string> {
  const res = await getPool().query<{ id: string }>(
    `INSERT INTO public.company_portals (company_id, counterparty_key, vendor_name, url, created_by)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id`,
    [companyId, overrides.key ?? 'telia sverige', overrides.vendor ?? 'Telia', overrides.url ?? TELIA_URL, userId],
  )
  return res.rows[0].id
}

describe('company_portals RLS', () => {
  it('lets company members read, strangers see nothing', async () => {
    const { userId, companyId } = await seedCompany()
    await insertPortal(companyId, userId)
    const viewer = await insertAuthUser()
    await insertCompanyMember({ companyId, userId: viewer, role: 'viewer' })
    const stranger = await insertAuthUser()

    const read = (who: string) =>
      withUserContext(who, (client) =>
        client.query(`SELECT vendor_name, url FROM public.company_portals WHERE company_id = $1`, [companyId]),
      )
    expect((await read(userId)).rows).toEqual([{ vendor_name: 'Telia', url: TELIA_URL }])
    expect((await read(viewer)).rows).toEqual([{ vendor_name: 'Telia', url: TELIA_URL }])
    expect((await read(stranger)).rows).toHaveLength(0)
  })

  it('lets a writing member add a portal in their own name, change its link and remove it', async () => {
    const { companyId } = await seedCompany()
    const member = await insertAuthUser()
    await insertCompanyMember({ companyId, userId: member, role: 'member' })

    const after = await withUserContext(member, async (client) => {
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO public.company_portals (company_id, counterparty_key, vendor_name, url, created_by)
         VALUES ($1, 'telia sverige', 'Telia', $2, $3) RETURNING id`,
        [companyId, TELIA_URL, member],
      )
      const id = rows[0].id
      const changed = await client.query(
        `UPDATE public.company_portals SET url = 'https://www.telia.se/foretag' WHERE id = $1 RETURNING url`,
        [id],
      )
      expect(changed.rows).toEqual([{ url: 'https://www.telia.se/foretag' }])
      const removed = await client.query(`DELETE FROM public.company_portals WHERE id = $1`, [id])
      expect(removed.rowCount).toBe(1)
      return client.query(`SELECT 1 FROM public.company_portals WHERE company_id = $1`, [companyId])
    })
    expect(after.rowCount).toBe(0)
  })

  it("refuses an add in someone else's name, and a stranger's add", async () => {
    const { userId: owner, companyId } = await seedCompany()
    const member = await insertAuthUser()
    await insertCompanyMember({ companyId, userId: member, role: 'member' })
    const stranger = await insertAuthUser()

    for (const [who, createdBy] of [
      [member, owner],
      [stranger, stranger],
    ]) {
      await expect(
        withUserContext(who, (client) =>
          client.query(
            `INSERT INTO public.company_portals (company_id, counterparty_key, vendor_name, url, created_by)
             VALUES ($1, 'telia sverige', 'Telia', $2, $3)`,
            [companyId, TELIA_URL, createdBy],
          ),
        ),
      ).rejects.toThrow(/row-level security/i)
    }
  })

  it('refuses every write by a viewer', async () => {
    const { userId, companyId } = await seedCompany()
    const id = await insertPortal(companyId, userId)
    const viewer = await insertAuthUser()
    await insertCompanyMember({ companyId, userId: viewer, role: 'viewer' })

    await expect(
      withUserContext(viewer, (client) =>
        client.query(
          `INSERT INTO public.company_portals (company_id, counterparty_key, vendor_name, url, created_by)
           VALUES ($1, 'ellevio', 'Ellevio', 'https://www.ellevio.se', $2)`,
          [companyId, viewer],
        ),
      ),
    ).rejects.toThrow(/row-level security/i)
    await expect(
      withUserContext(viewer, (client) =>
        client.query(`UPDATE public.company_portals SET url = 'https://evil.example.se' WHERE id = $1`, [id]),
      ),
    ).rejects.toThrow(/row-level security/i)
    // The DELETE policy holds the role in USING: a viewer's delete matches no row.
    const removed = await withUserContext(viewer, (client) =>
      client.query(`DELETE FROM public.company_portals WHERE id = $1`, [id]),
    )
    expect(removed.rowCount).toBe(0)

    const left = await getPool().query(`SELECT url FROM public.company_portals WHERE id = $1`, [id])
    expect(left.rows).toEqual([{ url: TELIA_URL }])
  })

  it("never lets a stranger change or remove another company's portal", async () => {
    const { userId, companyId } = await seedCompany()
    const id = await insertPortal(companyId, userId)
    const other = await seedCompany()

    const counts = await withUserContext(other.userId, async (client) => {
      const changed = await client.query(`UPDATE public.company_portals SET url = 'https://evil.example.se' WHERE id = $1`, [id])
      const removed = await client.query(`DELETE FROM public.company_portals WHERE id = $1`, [id])
      return { changed: changed.rowCount, removed: removed.rowCount }
    })
    expect(counts).toEqual({ changed: 0, removed: 0 })
    const left = await getPool().query(`SELECT url FROM public.company_portals WHERE id = $1`, [id])
    expect(left.rows).toEqual([{ url: TELIA_URL }])
  })

  it('lets a member change the link and nothing else: which supplier it is and who added it stay', async () => {
    const { userId, companyId } = await seedCompany()
    const id = await insertPortal(companyId, userId)
    for (const assignment of [`counterparty_key = 'ellevio'`, `vendor_name = 'Ellevio'`, `created_by = NULL`, `company_id = company_id`]) {
      await expect(
        withUserContext(userId, (client) =>
          client.query(`UPDATE public.company_portals SET ${assignment} WHERE id = $1`, [id]),
        ),
        assignment,
      ).rejects.toThrow(/permission denied/i)
    }
  })
})

describe('company_portals constraints and audit', () => {
  it('keeps one portal per supplier and company', async () => {
    const { userId, companyId } = await seedCompany()
    await insertPortal(companyId, userId)
    await expect(insertPortal(companyId, userId, { url: 'https://www.telia.se' })).rejects.toThrow(/company_portals_counterparty_key/)
    const other = await seedCompany()
    await expect(insertPortal(other.companyId, other.userId)).resolves.toBeTruthy()
  })

  it('stores only an https link with a dotted host, no userinfo, no query string and no whitespace', async () => {
    const { userId, companyId } = await seedCompany()
    for (const [i, url] of [
      'http://minasidor.telia.se',
      'javascript:alert(1)',
      'https://user:pass@minasidor.telia.se',
      'https://localhost/fakturor',
      'https://minasidor.telia.se/foretag?session=abc',
      'https://minasidor.telia.se/a b',
      `https://minasidor.telia.se/${'a'.repeat(2048)}`,
    ].entries()) {
      await expect(insertPortal(companyId, userId, { key: `leverantor ${i}`, url }), url).rejects.toThrow(/company_portals_url_check/)
    }
    // A fragment may carry a question mark: it never reaches the server.
    await expect(
      insertPortal(companyId, userId, { key: 'microsoft', url: 'https://admin.microsoft.com/#/billing?view=invoices' }),
    ).resolves.toBeTruthy()
  })

  it('refuses a key too short to name anyone and a supplier name too long for the view', async () => {
    const { userId, companyId } = await seedCompany()
    await expect(insertPortal(companyId, userId, { key: 'ab' })).rejects.toThrow(/counterparty_key_check/)
    await expect(insertPortal(companyId, userId, { key: 'lang leverantor', vendor: 'x'.repeat(81) })).rejects.toThrow(
      /vendor_name_check/,
    )
    await expect(insertPortal(companyId, userId, { key: 'tom leverantor', vendor: '   ' })).rejects.toThrow(/vendor_name_check/)
  })

  it('writes every change to audit_log with the company, and keeps updated_at current', async () => {
    const { userId, companyId } = await seedCompany()
    const id = await insertPortal(companyId, userId)
    const before = await getPool().query<{ updated_at: Date }>(`SELECT updated_at FROM public.company_portals WHERE id = $1`, [id])
    await getPool().query(`UPDATE public.company_portals SET url = 'https://www.telia.se/foretag' WHERE id = $1`, [id])
    const after = await getPool().query<{ updated_at: Date }>(`SELECT updated_at FROM public.company_portals WHERE id = $1`, [id])
    expect(after.rows[0].updated_at.getTime()).toBeGreaterThanOrEqual(before.rows[0].updated_at.getTime())
    await getPool().query(`DELETE FROM public.company_portals WHERE id = $1`, [id])

    const rows = await getPool().query<{ action: string; company_id: string }>(
      `SELECT action, company_id FROM public.audit_log
        WHERE table_name = 'company_portals' AND record_id = $1
        ORDER BY created_at, id`,
      [id],
    )
    expect(rows.rows).toEqual([
      { action: 'INSERT', company_id: companyId },
      { action: 'UPDATE', company_id: companyId },
      { action: 'DELETE', company_id: companyId },
    ])
  })
})
