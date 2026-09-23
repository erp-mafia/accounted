import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { PoolClient } from 'pg'
import { describe, expect, it } from 'vitest'
import { getPool, withUserContext } from './setup'
import { insertAuthUser, insertCompany, insertCompanyMember, seedCompany } from './fixtures'

/**
 * pg-real coverage for the repair half of
 * 20260920190800_migration_reset_replacement_stays_onboarded.sql.
 *
 * Before that migration, reset_company_for_migration forced
 * onboarding_complete = false on the replacement company. The Hem page
 * ("Att göra", route "/") redirects to /onboarding on that flag, and
 * /onboarding only creates NEW companies, so the replacement could never open
 * Hem again. The function half is pinned in
 * company-migration-reset.pg.test.ts; this file pins the backfill that
 * repairs the replacements created while the bug was live:
 *   - a replacement inherits "onboarded" (and the step) from its root source
 *   - a chain repairs its live tail from the ROOT, not from the intermediate
 *     source, and never touches that write-closed intermediate row
 *   - a root that was not onboarded leaves its replacement alone
 *   - a user-archived replacement is repaired too
 *   - companies that are not reset replacements are never touched
 *   - idempotent
 *
 * Every case runs inside withUserContext's transaction and rolls back: the
 * backfill statement is global, so nothing it does may outlive the test.
 */

const MIGRATION_PATH = join(
  process.cwd(),
  'supabase/migrations/20260920190800_migration_reset_replacement_stays_onboarded.sql',
)

// Run the statement that ships, not a copy of it.
function backfillStatement(): string {
  const sql = readFileSync(MIGRATION_PATH, 'utf8')
  const start = sql.indexOf('-- backfill:begin')
  const end = sql.indexOf('-- backfill:end')
  expect(start).toBeGreaterThan(-1)
  expect(end).toBeGreaterThan(start)
  return sql.slice(start + '-- backfill:begin'.length, end)
}

const REASON = 'The first migration used the wrong fiscal periods.'

async function seedOnboardedCompany(onboardingComplete = true): Promise<{
  userId: string
  companyId: string
}> {
  const { userId, companyId } = await seedCompany()
  await getPool().query(
    `INSERT INTO public.company_settings
       (user_id, company_id, entity_type, company_name, org_number,
        onboarding_complete, onboarding_step)
     VALUES ($1, $2, 'aktiebolag', 'Reset AB', '5590000001', $3, $4)`,
    [userId, companyId, onboardingComplete, onboardingComplete ? 4 : 2],
  )
  return { userId, companyId }
}

/** Reset as the owner, then hand the transaction back to the superuser. */
async function resetCompany(client: PoolClient, companyId: string): Promise<string> {
  await client.query('SET LOCAL ROLE authenticated')
  const { rows } = await client.query<{
    result: { ok: boolean; code?: string; replacement_company_id?: string }
  }>(`SELECT public.reset_company_for_migration($1, 'Reset AB', $2, true, true) AS result`, [
    companyId,
    REASON,
  ])
  await client.query('RESET ROLE')
  expect(rows[0]!.result).toMatchObject({ ok: true })
  return rows[0]!.result.replacement_company_id!
}

/** The state the pre-20260920190800 function left on every replacement. */
async function forcePreFixState(client: PoolClient, companyId: string): Promise<void> {
  await client.query(
    `UPDATE public.company_settings
     SET onboarding_complete = false, onboarding_step = 1
     WHERE company_id = $1`,
    [companyId],
  )
}

async function onboardingState(
  client: PoolClient,
  companyId: string,
): Promise<{ onboarding_complete: boolean; onboarding_step: number }> {
  const { rows } = await client.query<{ onboarding_complete: boolean; onboarding_step: number }>(
    `SELECT onboarding_complete, onboarding_step::int AS onboarding_step
     FROM public.company_settings WHERE company_id = $1`,
    [companyId],
  )
  return rows[0]!
}

describe('migration reset replacement onboarding backfill (pg)', () => {
  it('repairs a replacement from its onboarded source and is idempotent', async () => {
    const { userId, companyId } = await seedOnboardedCompany()

    await withUserContext(userId, async (client) => {
      const replacementId = await resetCompany(client, companyId)
      await forcePreFixState(client, replacementId)

      await client.query(backfillStatement())

      expect(await onboardingState(client, replacementId)).toEqual({
        onboarding_complete: true,
        onboarding_step: 4,
      })

      const second = await client.query(backfillStatement())
      expect(second.rowCount).toBe(0)
    })
  })

  it('repairs the live tail of a reset chain from the root and leaves the write-closed middle alone', async () => {
    const { userId, companyId } = await seedOnboardedCompany()

    await withUserContext(userId, async (client) => {
      const middleId = await resetCompany(client, companyId)
      // The middle company was written by the old function, then reset again:
      // its row is now a retained source and says "not onboarded" forever.
      await forcePreFixState(client, middleId)
      const tailId = await resetCompany(client, middleId)
      expect(await onboardingState(client, tailId)).toEqual({
        onboarding_complete: false,
        onboarding_step: 1,
      })

      // Must not raise: touching the middle row would trip
      // company_settings_block_migration_reset_source_mutation and abort the
      // whole migration on deploy.
      await client.query(backfillStatement())

      expect(await onboardingState(client, tailId)).toEqual({
        onboarding_complete: true,
        onboarding_step: 4,
      })
      expect(await onboardingState(client, middleId)).toEqual({
        onboarding_complete: false,
        onboarding_step: 1,
      })
    })
  })

  it('leaves a replacement alone when its root never finished onboarding', async () => {
    const { userId, companyId } = await seedOnboardedCompany(false)

    await withUserContext(userId, async (client) => {
      const replacementId = await resetCompany(client, companyId)

      await client.query(backfillStatement())

      expect(await onboardingState(client, replacementId)).toEqual({
        onboarding_complete: false,
        onboarding_step: 2,
      })
    })
  })

  it('repairs a replacement the owner archived, so un-archiving cannot resurrect the trap', async () => {
    const { userId, companyId } = await seedOnboardedCompany()

    await withUserContext(userId, async (client) => {
      const replacementId = await resetCompany(client, companyId)
      await forcePreFixState(client, replacementId)
      await client.query(
        `UPDATE public.companies SET archived_at = now(), archived_by = $2 WHERE id = $1`,
        [replacementId, userId],
      )

      await client.query(backfillStatement())

      expect(await onboardingState(client, replacementId)).toMatchObject({
        onboarding_complete: true,
      })
    })
  })

  it('never touches a company that is not a reset replacement', async () => {
    const userId = await insertAuthUser()
    const companyId = await insertCompany({ createdBy: userId })
    await insertCompanyMember({ companyId, userId, role: 'owner' })
    await getPool().query(
      `INSERT INTO public.company_settings
         (user_id, company_id, entity_type, company_name, onboarding_complete, onboarding_step)
       VALUES ($1, $2, 'aktiebolag', 'Half set up AB', false, 2)`,
      [userId, companyId],
    )

    await withUserContext(userId, async (client) => {
      await client.query('RESET ROLE')
      await client.query(backfillStatement())

      expect(await onboardingState(client, companyId)).toEqual({
        onboarding_complete: false,
        onboarding_step: 2,
      })
    })
  })
})
