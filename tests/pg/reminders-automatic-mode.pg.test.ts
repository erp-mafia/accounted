import { describe, expect, it } from 'vitest'
import { getPool, withUserContext } from './setup'
import { seedCompany, setActiveCompany } from './fixtures'

/**
 * Automatic reminders (migration 20261027120300_reminders_automatic_mode.sql):
 * only Accounted sets company_settings.reminders_automatic_at/by, and
 * turning reminders off turns automatic off with them.
 */

async function seedSettings(): Promise<{ companyId: string; userId: string }> {
  const seeded = await seedCompany()
  await getPool().query(
    `INSERT INTO public.company_settings (user_id, company_id, send_invoice_reminders) VALUES ($1, $2, true)`,
    [seeded.userId, seeded.companyId],
  )
  return seeded
}

async function automaticOf(companyId: string): Promise<{ at: Date | null; by: string | null }> {
  const { rows } = await getPool().query<{ reminders_automatic_at: Date | null; reminders_automatic_by: string | null }>(
    `SELECT reminders_automatic_at, reminders_automatic_by FROM public.company_settings WHERE company_id = $1`,
    [companyId],
  )
  return { at: rows[0]!.reminders_automatic_at, by: rows[0]!.reminders_automatic_by }
}

describe('company_settings.reminders_automatic_at (pg)', () => {
  it('is set by Accounted, and cleared when reminders are turned off', async () => {
    const { companyId, userId } = await seedSettings()
    await getPool().query(`UPDATE public.company_settings SET reminders_automatic_at = now(), reminders_automatic_by = $2 WHERE company_id = $1`, [companyId, userId])
    expect(await automaticOf(companyId)).toMatchObject({ by: userId })

    await getPool().query(`UPDATE public.company_settings SET send_invoice_reminders = false WHERE company_id = $1`, [companyId])
    expect(await automaticOf(companyId)).toEqual({ at: null, by: null })
  })

  it('stays off while reminders are off', async () => {
    const { companyId, userId } = await seedSettings()
    await getPool().query(`UPDATE public.company_settings SET send_invoice_reminders = false WHERE company_id = $1`, [companyId])
    await getPool().query(`UPDATE public.company_settings SET reminders_automatic_at = now(), reminders_automatic_by = $2 WHERE company_id = $1`, [companyId, userId])
    expect(await automaticOf(companyId)).toEqual({ at: null, by: null })
  })

  it("ignores a member's own write to it", async () => {
    const { companyId, userId } = await seedSettings()
    await setActiveCompany(userId, companyId)
    const written = await withUserContext(userId, async (client) => {
      await client.query(`SELECT set_config('request.jwt.claim.role', 'authenticated', true)`)
      await client.query(`UPDATE public.company_settings SET reminders_automatic_at = now(), reminders_automatic_by = $2 WHERE company_id = $1`, [companyId, userId])
      const { rows } = await client.query<{ reminders_automatic_at: Date | null }>(
        `SELECT reminders_automatic_at FROM public.company_settings WHERE company_id = $1`,
        [companyId],
      )
      return rows[0]?.reminders_automatic_at ?? null
    })
    expect(written).toBeNull()
  })
})
