import { describe, expect, it } from 'vitest'
import type { PoolClient } from 'pg'
import { getClient, getPool, withUserContext } from './setup'
import { insertAuthUser, insertCompanyMember, seedCompany } from './fixtures'

/**
 * pg-real coverage for 20261021001100_inbox_address_keeps_previous.sql
 * (crm#1334, crm#1209).
 *
 * A renamed company gets an inbox address with its current name without
 * losing the mail its suppliers still send to the old one. Pinned here:
 *   - rename_company_inbox turns the active address into 'previous' and mints
 *     a new active address from the current name
 *   - it refuses when the address already carries the name (PT409), when there
 *     is no active address (P0002), and for anyone but an owner or admin
 *   - only authenticated and service_role may execute it
 *   - rotate_company_inbox retires the previous addresses with the active one
 *   - the previous addresses follow the active one through a migration reset
 *   - the status check accepts 'previous' and still refuses anything unknown
 */

type Queryable = PoolClient | ReturnType<typeof getPool>

async function inboxRows(
  client: Queryable,
  companyId: string,
): Promise<Array<{ local_part: string; status: string; deprecated_at: string | null }>> {
  const { rows } = await client.query<{ local_part: string; status: string; deprecated_at: string | null }>(
    `SELECT local_part, status, deprecated_at::text AS deprecated_at FROM public.company_inboxes
     WHERE company_id = $1 ORDER BY created_at, local_part`,
    [companyId],
  )
  return rows
}

async function renameCompany(companyId: string, name: string): Promise<void> {
  await getPool().query(`UPDATE public.companies SET name = $2 WHERE id = $1`, [companyId, name])
}

/** The SQLSTATE a statement fails with, or null when it succeeds. */
async function sqlState(client: PoolClient, sql: string, params: unknown[]): Promise<string | null> {
  await client.query('SAVEPOINT attempt')
  try {
    await client.query(sql, params)
    await client.query('RELEASE SAVEPOINT attempt')
    return null
  } catch (err) {
    await client.query('ROLLBACK TO SAVEPOINT attempt')
    return (err as { code?: string }).code ?? 'unknown'
  }
}

describe('inbox address rename keeps the previous address (pg)', () => {
  it('turns the active address into a previous one and mints one with the current name', async () => {
    const { userId, companyId } = await seedCompany()
    const [original] = await inboxRows(getPool(), companyId)
    expect(original!.local_part).toMatch(/^test-ab-[a-z0-9]{4}$/)
    await renameCompany(companyId, 'Nytt Namn Öst AB')

    await withUserContext(userId, async (client) => {
      const { rows } = await client.query<{ local_part: string; status: string; slug_seed: string }>(
        `SELECT local_part, status, slug_seed FROM public.rename_company_inbox($1)`,
        [companyId],
      )
      expect(rows[0]!.status).toBe('active')
      expect(rows[0]!.slug_seed).toBe('nytt-namn-ost-ab')
      expect(rows[0]!.local_part).toMatch(/^nytt-namn-ost-ab-[a-z0-9]{4}$/)

      const after = await inboxRows(client, companyId)
      expect(after).toEqual([
        { local_part: original!.local_part, status: 'previous', deprecated_at: null },
        { local_part: rows[0]!.local_part, status: 'active', deprecated_at: null },
      ])
    })
  })

  it('refuses when the address already carries the company name', async () => {
    const { userId, companyId } = await seedCompany()
    const before = await inboxRows(getPool(), companyId)

    await withUserContext(userId, async (client) => {
      expect(await sqlState(client, `SELECT public.rename_company_inbox($1)`, [companyId])).toBe('PT409')
      expect(await inboxRows(client, companyId)).toEqual(before)
    })
  })

  it('refuses a company without an active address', async () => {
    const { userId, companyId } = await seedCompany()
    await renameCompany(companyId, 'Annat Namn AB')
    await getPool().query(
      `UPDATE public.company_inboxes SET status = 'deprecated', deprecated_at = now() WHERE company_id = $1`,
      [companyId],
    )

    await withUserContext(userId, async (client) => {
      expect(await sqlState(client, `SELECT public.rename_company_inbox($1)`, [companyId])).toBe('P0002')
    })
  })

  it('refuses members below admin and outsiders', async () => {
    const { companyId } = await seedCompany()
    await renameCompany(companyId, 'Annat Namn AB')
    const member = await insertAuthUser()
    await insertCompanyMember({ companyId, userId: member, role: 'member' })
    const outsider = await insertAuthUser()
    const before = await inboxRows(getPool(), companyId)

    for (const userId of [member, outsider]) {
      await withUserContext(userId, async (client) => {
        expect(await sqlState(client, `SELECT public.rename_company_inbox($1)`, [companyId])).toBe('42501')
      })
    }
    expect(await inboxRows(getPool(), companyId)).toEqual(before)
  })

  it('is executable by authenticated and service_role only', async () => {
    const { rows } = await getPool().query<{ anon: boolean; authenticated: boolean; service_role: boolean; follow_authenticated: boolean }>(
      `SELECT
         has_function_privilege('anon', 'public.rename_company_inbox(uuid)', 'EXECUTE') AS anon,
         has_function_privilege('authenticated', 'public.rename_company_inbox(uuid)', 'EXECUTE') AS authenticated,
         has_function_privilege('service_role', 'public.rename_company_inbox(uuid)', 'EXECUTE') AS service_role,
         has_function_privilege('authenticated', 'public.company_inboxes_previous_follow_active()', 'EXECUTE') AS follow_authenticated`,
    )
    expect(rows[0]).toEqual({ anon: false, authenticated: true, service_role: true, follow_authenticated: false })
  })

  it('rotation retires the previous addresses together with the active one', async () => {
    const { userId, companyId } = await seedCompany()
    await renameCompany(companyId, 'Nytt Namn AB')

    await withUserContext(userId, async (client) => {
      await client.query(`SELECT public.rename_company_inbox($1)`, [companyId])
      const renamed = await inboxRows(client, companyId)
      const { rows } = await client.query<{ local_part: string }>(
        `SELECT local_part FROM public.rotate_company_inbox($1)`,
        [companyId],
      )

      const after = await inboxRows(client, companyId)
      expect(after.filter((row) => row.status === 'active').map((row) => row.local_part)).toEqual([rows[0]!.local_part])
      for (const row of renamed) {
        const now = after.find((r) => r.local_part === row.local_part)!
        expect(now.status).toBe('deprecated')
        expect(now.deprecated_at).not.toBeNull()
      }
      expect(after.some((row) => row.status === 'previous')).toBe(false)
    })
  })

  it('moves the previous addresses with the active one in a migration reset', async () => {
    const { userId, companyId } = await seedCompany()
    // A rename kept an earlier address; the display name the reset asks for stays 'Test AB'.
    await getPool().query(
      `INSERT INTO public.company_inboxes (company_id, local_part, slug_seed, status)
       VALUES ($1, 'tidigare-namn-ab-' || substr(md5(random()::text), 1, 4), 'tidigare-namn-ab', 'previous')`,
      [companyId],
    )
    const before = await inboxRows(getPool(), companyId)
    expect(before.map((row) => row.status).sort()).toEqual(['active', 'previous'])

    await withUserContext(userId, async (client) => {
      const { rows } = await client.query<{ result: { ok: boolean; replacement_company_id?: string } }>(
        `SELECT public.reset_company_for_migration($1, $2, $3, true, true) AS result`,
        [companyId, 'Test AB', 'The first migration used the wrong fiscal periods.'],
      )
      expect(rows[0]!.result.ok).toBe(true)
      const replacementId = rows[0]!.result.replacement_company_id!
      await client.query('RESET ROLE')

      expect(await inboxRows(client, companyId)).toEqual([])
      const moved = await inboxRows(client, replacementId)
      expect(moved.map((row) => [row.local_part, row.status]).sort()).toEqual(
        before.map((row) => [row.local_part, row.status]).sort(),
      )
    })
  })

  it('accepts previous as a status and still refuses an unknown one', async () => {
    const { companyId } = await seedCompany()
    const client = await getClient()
    try {
      await client.query('BEGIN')
      expect(
        await sqlState(
          client,
          `INSERT INTO public.company_inboxes (company_id, local_part, slug_seed, status)
           VALUES ($1, 'status-check-' || substr(md5(random()::text), 1, 6), 'status-check', 'previous')`,
          [companyId],
        ),
      ).toBeNull()
      expect(
        await sqlState(
          client,
          `INSERT INTO public.company_inboxes (company_id, local_part, slug_seed, status)
           VALUES ($1, 'status-check-' || substr(md5(random()::text), 1, 6), 'status-check', 'alias')`,
          [companyId],
        ),
      ).toBe('23514')
    } finally {
      await client.query('ROLLBACK')
      client.release()
    }
  })
})
