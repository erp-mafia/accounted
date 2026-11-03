import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { getPool, withUserContext } from './setup'
import { seedCompany } from './fixtures'

// pg-real coverage for the time tracking migration (time_entries): RLS
// isolation between companies, the customer-present and hours CHECKs, the
// per-company import_key idempotency, and the updated_at trigger.

async function insertEntry(
  companyId: string,
  userId: string,
  overrides: { importKey?: string | null; hours?: number; customerCode?: string | null } = {},
): Promise<string> {
  const id = randomUUID()
  await getPool().query(
    `INSERT INTO public.time_entries
       (id, company_id, user_id, entry_date, consultant, customer_code, hours, source, import_key)
     VALUES ($1, $2, $3, '2026-06-15', 'GK', $4, $5, 'import', $6)`,
    [
      id,
      companyId,
      userId,
      overrides.customerCode === undefined ? 'GF' : overrides.customerCode,
      overrides.hours ?? 7.5,
      overrides.importKey ?? null,
    ],
  )
  return id
}

describe('time_entries', () => {
  it('shows a company its own rows only, and refuses inserts into another company', async () => {
    const a = await seedCompany()
    const b = await seedCompany()
    const own = await insertEntry(a.companyId, a.userId)
    await insertEntry(b.companyId, b.userId)

    const visible = await withUserContext(a.userId, async (client) => {
      const { rows } = await client.query<{ id: string }>(`SELECT id FROM public.time_entries`)
      return rows.map((r) => r.id)
    })
    expect(visible).toEqual([own])

    await expect(
      withUserContext(a.userId, (client) =>
        client.query(
          `INSERT INTO public.time_entries (company_id, user_id, entry_date, consultant, customer_code, hours)
           VALUES ($1, $2, '2026-06-15', 'GK', 'GF', 1)`,
          [b.companyId, a.userId],
        ),
      ),
    ).rejects.toThrow(/row-level security/)
  })

  it('lets a member update and delete their company rows', async () => {
    const a = await seedCompany()
    const id = await insertEntry(a.companyId, a.userId)

    const result = await withUserContext(a.userId, async (client) => {
      const updated = await client.query(`UPDATE public.time_entries SET hours = 2 WHERE id = $1`, [id])
      const deleted = await client.query(`DELETE FROM public.time_entries WHERE id = $1`, [id])
      return { updated: updated.rowCount, deleted: deleted.rowCount }
    })
    expect(result).toEqual({ updated: 1, deleted: 1 })
  })

  it('requires a customer reference and hours within (0, 24]', async () => {
    const a = await seedCompany()
    await expect(insertEntry(a.companyId, a.userId, { customerCode: null })).rejects.toThrow(
      /time_entries_customer_present/,
    )
    await expect(insertEntry(a.companyId, a.userId, { hours: 0 })).rejects.toThrow(/check constraint/)
    await expect(insertEntry(a.companyId, a.userId, { hours: 24.5 })).rejects.toThrow(/check constraint/)
  })

  it('keeps import_key unique per company, not globally', async () => {
    const a = await seedCompany()
    const b = await seedCompany()
    await insertEntry(a.companyId, a.userId, { importKey: 'wb:abc:1' })
    await insertEntry(b.companyId, b.userId, { importKey: 'wb:abc:1' })
    await expect(insertEntry(a.companyId, a.userId, { importKey: 'wb:abc:1' })).rejects.toThrow(
      /time_entries_import_key_unique/,
    )

    const { rowCount } = await getPool().query(
      `INSERT INTO public.time_entries (company_id, user_id, entry_date, consultant, customer_code, hours, import_key)
       VALUES ($1, $2, '2026-06-15', 'GK', 'GF', 1, 'wb:abc:1')
       ON CONFLICT (company_id, import_key) DO NOTHING`,
      [a.companyId, a.userId],
    )
    expect(rowCount).toBe(0)
  })

  it('advances updated_at on update', async () => {
    const a = await seedCompany()
    const id = await insertEntry(a.companyId, a.userId)
    await getPool().query(`UPDATE public.time_entries SET updated_at = now() - interval '1 day' WHERE id = $1`, [id])
    await getPool().query(`UPDATE public.time_entries SET comment = 'bokf' WHERE id = $1`, [id])
    const { rows } = await getPool().query<{ fresh: boolean }>(
      `SELECT updated_at > now() - interval '1 minute' AS fresh FROM public.time_entries WHERE id = $1`,
      [id],
    )
    expect(rows[0].fresh).toBe(true)
  })
})
