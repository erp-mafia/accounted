import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { seedCompany } from '@/tests/pg/fixtures'
import { getPool } from '@/tests/pg/setup'

/**
 * pg-real coverage for 20260908094409_suppliers_org_number_canonical.sql
 * (#2391): the backfill that brings suppliers.org_number to the 10-digit key.
 *
 *  - hyphenated, spaced and 12-digit Swedish numbers become 10 digits
 *  - a foreign registration number and junk stay exactly as typed
 *  - a row that is already canonical is untouched
 *  - a migration-reset source company is skipped
 *  - the party link survives (suppliers_link_party fires on the update)
 *  - idempotent: a second run changes nothing
 */

// Run the real migration SQL so the test exercises exactly what ships.
const BACKFILL_SQL = readFileSync(
  join(process.cwd(), 'supabase/migrations/20260908094409_suppliers_org_number_canonical.sql'),
  'utf8',
)
async function runBackfill(): Promise<void> {
  await getPool().query(BACKFILL_SQL)
}

async function insertSupplier(params: {
  userId: string
  companyId: string
  orgNumber: string | null
  name?: string
}): Promise<string> {
  const id = randomUUID()
  await getPool().query(
    `INSERT INTO public.suppliers (id, user_id, company_id, name, org_number)
     VALUES ($1, $2, $3, $4, $5)`,
    [id, params.userId, params.companyId, params.name ?? 'Testleverantör AB', params.orgNumber],
  )
  return id
}

async function readSupplier(id: string): Promise<{ org_number: string | null; party_id: string | null }> {
  const { rows } = await getPool().query(
    `SELECT org_number, party_id FROM public.suppliers WHERE id = $1`,
    [id],
  )
  return rows[0]
}

describe('suppliers.org_number canonical backfill', () => {
  it('rewrites Swedish-shaped numbers to the 10-digit key and leaves the rest as typed', async () => {
    const { userId, companyId } = await seedCompany()
    const cases: [string, string][] = [
      ['556012-5790', '5560125790'],
      ['556012 5790', '5560125790'],
      ['165560125790', '5560125790'],
      ['19800101-1231', '8001011231'],
      ['5560125790', '5560125790'],
      ['DK12345678', 'DK12345678'],
      ['12345', '12345'],
    ]
    const ids: string[] = []
    for (const [typed] of cases) {
      ids.push(await insertSupplier({ userId, companyId, orgNumber: typed, name: `Leverantör ${typed}` }))
    }
    const nullRow = await insertSupplier({ userId, companyId, orgNumber: null })

    await runBackfill()

    for (const [i, [, expected]] of cases.entries()) {
      expect((await readSupplier(ids[i])).org_number, cases[i][0]).toBe(expected)
    }
    expect((await readSupplier(nullRow)).org_number).toBeNull()
  })

  it('keeps the party link on a rewritten row', async () => {
    const { userId, companyId } = await seedCompany()
    const id = await insertSupplier({ userId, companyId, orgNumber: '556012-5790' })
    const before = await readSupplier(id)
    expect(before.party_id).not.toBeNull()

    await runBackfill()

    const after = await readSupplier(id)
    expect(after.org_number).toBe('5560125790')
    expect(after.party_id).toBe(before.party_id)
  })

  it('skips a migration-reset source company', async () => {
    const source = await seedCompany()
    const replacement = await seedCompany()
    const id = await insertSupplier({
      userId: source.userId,
      companyId: source.companyId,
      orgNumber: '556012-5790',
    })
    await getPool().query(
      `INSERT INTO public.company_migration_resets
         (source_company_id, replacement_company_id, actor_id, reason,
          confirmation_snapshot, source_counts)
       VALUES ($1, $2, $3, 'pg test: archived by a migration reset', '{}'::jsonb, '{}'::jsonb)`,
      [source.companyId, replacement.companyId, source.userId],
    )

    await runBackfill()

    expect((await readSupplier(id)).org_number).toBe('556012-5790')
  })

  it('is idempotent', async () => {
    const { userId, companyId } = await seedCompany()
    const id = await insertSupplier({ userId, companyId, orgNumber: '556012-5790' })
    await runBackfill()
    const { rows: first } = await getPool().query(
      `SELECT org_number, updated_at FROM public.suppliers WHERE id = $1`,
      [id],
    )
    await runBackfill()
    const { rows: second } = await getPool().query(
      `SELECT org_number, updated_at FROM public.suppliers WHERE id = $1`,
      [id],
    )
    expect(second[0]).toEqual(first[0])
  })
})
