import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { insertAuthUser, insertCompany, insertCompanyMember } from '@/tests/pg/fixtures'
import { getClient, getPool, withUserContext } from '@/tests/pg/setup'

/**
 * 20261016006000_companies_jurisdiction_ledger_currency.sql: every company,
 * old and new, is pinned to jurisdiction 'SE' and ledger_currency 'SEK', and
 * no role can store anything else until a migration widens the CHECKs.
 */

const MIGRATION_SQL = readFileSync(
  join(process.cwd(), 'supabase/migrations/20261016006000_companies_jurisdiction_ledger_currency.sql'),
  'utf8',
)

async function pinnedColumns(companyId: string) {
  const res = await getPool().query<{ jurisdiction: string; ledger_currency: string }>(
    `SELECT jurisdiction, ledger_currency FROM public.companies WHERE id = $1`,
    [companyId],
  )
  return res.rows[0]
}

async function sqlState(run: () => Promise<unknown>): Promise<string | null> {
  try {
    await run()
    return null
  } catch (err) {
    return (err as { code?: string }).code ?? 'unknown'
  }
}

describe('companies.jurisdiction and companies.ledger_currency', () => {
  it('default a new company to SE and SEK', async () => {
    const userId = await insertAuthUser()
    const companyId = await insertCompany({ createdBy: userId })
    expect(await pinnedColumns(companyId)).toEqual({ jurisdiction: 'SE', ledger_currency: 'SEK' })
  })

  it('fill the rows that existed before the migration', async () => {
    const userId = await insertAuthUser()
    const client = await getClient()
    try {
      await client.query('BEGIN')
      // Back to the schema before the migration, with a company in it, then
      // the migration itself. Rolled back: the table ends as the replay left it.
      await client.query('ALTER TABLE public.companies DROP COLUMN jurisdiction, DROP COLUMN ledger_currency')
      const companyId = randomUUID()
      await client.query(
        `INSERT INTO public.companies (id, name, entity_type, created_by) VALUES ($1, 'Före AB', 'aktiebolag', $2)`,
        [companyId, userId],
      )
      await client.query(MIGRATION_SQL)
      const res = await client.query(
        `SELECT jurisdiction, ledger_currency FROM public.companies WHERE id = $1`,
        [companyId],
      )
      expect(res.rows[0]).toEqual({ jurisdiction: 'SE', ledger_currency: 'SEK' })
    } finally {
      await client.query('ROLLBACK')
      client.release()
    }
  })

  it('refuse any other value, and NULL, on insert and update', async () => {
    const userId = await insertAuthUser()
    const companyId = await insertCompany({ createdBy: userId })
    const insertWith = (column: 'jurisdiction' | 'ledger_currency', value: string | null) =>
      getPool().query(
        `INSERT INTO public.companies (id, name, entity_type, created_by, ${column}) VALUES ($1, 'Annat AB', 'aktiebolag', $2, $3)`,
        [randomUUID(), userId, value],
      )
    const updateTo = (column: 'jurisdiction' | 'ledger_currency', value: string | null) =>
      getPool().query(`UPDATE public.companies SET ${column} = $2 WHERE id = $1`, [companyId, value])

    expect(await sqlState(() => insertWith('jurisdiction', 'NO'))).toBe('23514')
    expect(await sqlState(() => insertWith('ledger_currency', 'EUR'))).toBe('23514')
    expect(await sqlState(() => updateTo('jurisdiction', 'se'))).toBe('23514')
    expect(await sqlState(() => updateTo('ledger_currency', 'EUR'))).toBe('23514')
    expect(await sqlState(() => updateTo('jurisdiction', null))).toBe('23502')
    expect(await sqlState(() => updateTo('ledger_currency', null))).toBe('23502')
    expect(await pinnedColumns(companyId)).toEqual({ jurisdiction: 'SE', ledger_currency: 'SEK' })
  })

  it('refuse another value from the company owner too, and let the owner read both', async () => {
    const ownerId = await insertAuthUser()
    const companyId = await insertCompany({ createdBy: ownerId })
    await insertCompanyMember({ companyId, userId: ownerId, role: 'owner' })

    const read = await withUserContext(ownerId, (client) =>
      client.query(`SELECT jurisdiction, ledger_currency FROM public.companies WHERE id = $1`, [companyId]),
    )
    expect(read.rows[0]).toEqual({ jurisdiction: 'SE', ledger_currency: 'SEK' })

    const state = await sqlState(() =>
      withUserContext(ownerId, (client) =>
        client.query(`UPDATE public.companies SET jurisdiction = 'DK', ledger_currency = 'DKK' WHERE id = $1`, [
          companyId,
        ]),
      ),
    )
    expect(state).toBe('23514')
  })
})
