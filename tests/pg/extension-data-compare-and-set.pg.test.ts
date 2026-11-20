/**
 * pg-real test for the compare-and-set the underlag continuation claims a run
 * with (crm#1581, src/extensions/general/arcim-migration/lib/
 * document-import-continuation.ts).
 *
 * The worker writes the run's extension_data row only while its updated_at is
 * the version it read, and relies on every other write moving it: its own
 * updates, and the tab's upsert through the settings accessor. Both rest on
 * the BEFORE UPDATE trigger set_updated_at_extension_data, which also fires
 * for ON CONFLICT DO UPDATE. A mock cannot show that; this runs the
 * statements PostgREST issues for both against real Postgres.
 */
import { describe, expect, it } from 'vitest'
import { getPool } from './setup'
import { seedCompany } from './fixtures'

const EXTENSION_ID = 'arcim-migration'
const KEY = 'document_import_run'

// What PostgREST issues for
// .update({ value }).eq('id', id).eq('updated_at', version).select('updated_at')
const compareAndSet = (id: string, version: string, value: unknown) =>
  getPool().query<{ updated_at: string }>(
    `UPDATE public.extension_data SET value = $3
      WHERE id = $1 AND updated_at = $2::timestamptz
      RETURNING updated_at::text`,
    [id, version, value],
  )

// What the settings accessor's upsert issues (lib/extensions/context-factory.ts).
const upsert = (userId: string, companyId: string, value: unknown) =>
  getPool().query(
    `INSERT INTO public.extension_data (user_id, company_id, extension_id, key, value)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (company_id, extension_id, key) DO UPDATE SET
       user_id = EXCLUDED.user_id,
       company_id = EXCLUDED.company_id,
       extension_id = EXCLUDED.extension_id,
       key = EXCLUDED.key,
       value = EXCLUDED.value`,
    [userId, companyId, EXTENSION_ID, KEY, value],
  )

async function seedRun() {
  const { userId, companyId } = await seedCompany()
  await upsert(userId, companyId, { scanned: 2740 })
  const { rows } = await getPool().query<{ id: string; updated_at: string }>(
    `SELECT id, updated_at::text FROM public.extension_data
      WHERE company_id = $1 AND extension_id = $2 AND key = $3`,
    [companyId, EXTENSION_ID, KEY],
  )
  return { userId, companyId, id: rows[0]!.id, version: rows[0]!.updated_at }
}

describe('extension_data compare-and-set (crm#1581)', () => {
  it('writes once for a version, and a second write on the same version matches nothing', async () => {
    const { id, version } = await seedRun()

    const claim = await compareAndSet(id, version, { scanned: 2740, lease: { owner: 'worker-1' } })
    expect(claim.rows).toHaveLength(1)
    expect(claim.rows[0]!.updated_at).not.toBe(version)

    const late = await compareAndSet(id, version, { scanned: 2740, lease: { owner: 'worker-2' } })
    expect(late.rows).toHaveLength(0)

    const { rows } = await getPool().query(`SELECT value FROM public.extension_data WHERE id = $1`, [id])
    expect(rows[0].value).toEqual({ scanned: 2740, lease: { owner: 'worker-1' } })
  })

  it("moves the version on the tab's upsert, so a worker's next write finds nothing", async () => {
    const { userId, companyId, id, version } = await seedRun()
    const claim = await compareAndSet(id, version, { scanned: 2740, driver: 'server' })
    const held = claim.rows[0]!.updated_at

    await upsert(userId, companyId, { scanned: 2900, driver: 'browser' })

    const next = await compareAndSet(id, held, { scanned: 7740, driver: 'server' })
    expect(next.rows).toHaveLength(0)
    const { rows } = await getPool().query(`SELECT value FROM public.extension_data WHERE id = $1`, [id])
    expect(rows[0].value).toEqual({ scanned: 2900, driver: 'browser' })
  })
})
