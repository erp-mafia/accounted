import { describe, expect, it } from 'vitest'
import { getClient, getPool, withUserContext } from './setup'
import { insertAuthUser } from './fixtures'

/**
 * Migration 20261101120100_stockholm_today: public.stockholm_today() is today
 * in SQL, the twin of todayIsoStockholm. The function tests stand on a chosen
 * day with withSwedishToday (fixtures.ts), in the test file of each function.
 */

/**
 * The functions that still read the session date, each with why. A new
 * CURRENT_DATE lands here with its reason, or uses public.stockholm_today().
 */
const ON_THE_SESSION_DATE: Record<string, string> = {
  block_document_deletion: 'retention expiry, an enforcement trigger: the UTC date only holds on longer',
  enforce_retention_journal_entries: 'retention expiry, an enforcement trigger: the UTC date only holds on longer',
  enforce_invoice_delivery_immutability: 'retention expiry of delivery PII: the UTC date only holds on longer',
  redact_expired_invoice_delivery_pii: 'retention expiry of delivery PII, its cron runs at 03:15 UTC',
  package_open_obligations: 'an employment ended today still counts: the UTC date only holds on longer',
  save_bank_account_selection: 'mirrors the provider cursor, checked against UTC midnight in the Enable Banking handler',
  delete_last_voucher: 'one word left, once the open restatement of the function has landed',
}

describe('public.stockholm_today()', () => {
  it.each(['UTC', 'Pacific/Kiritimati', 'Etc/GMT+12'])('is the Swedish day in session zone %s', async (zone) => {
    const client = await getClient()
    try {
      await client.query('BEGIN')
      await client.query(`SET LOCAL TIME ZONE '${zone}'`)
      const { rows } = await client.query<{ today: string; swedish: string }>(
        `SELECT public.stockholm_today()::text AS today, (now() AT TIME ZONE 'Europe/Stockholm')::date::text AS swedish`,
      )
      expect(rows[0]!.today).toBe(rows[0]!.swedish)
    } finally {
      await client.query('ROLLBACK')
      client.release()
    }
  })

  it('differs from CURRENT_DATE where the session is on another day', async () => {
    const client = await getClient()
    try {
      await client.query('BEGIN')
      // 26 hours apart, so never on one date: at least one is not on the Swedish day.
      const dates: string[] = []
      for (const zone of ['Pacific/Kiritimati', 'Etc/GMT+12']) {
        await client.query(`SET LOCAL TIME ZONE '${zone}'`)
        const { rows } = await client.query<{ d: string }>(`SELECT CURRENT_DATE::text AS d`)
        dates.push(rows[0]!.d)
      }
      const { rows } = await client.query<{ today: string }>(`SELECT public.stockholm_today()::text AS today`)
      expect(dates.some((d) => d !== rows[0]!.today)).toBe(true)
    } finally {
      await client.query('ROLLBACK')
      client.release()
    }
  })

  it('runs for a signed-in user, whose RPCs read it, and not for anon', async () => {
    const userId = await insertAuthUser()
    await expect(withUserContext(userId, (client) => client.query('SELECT public.stockholm_today()'))).resolves.toBeDefined()

    const { rows } = await getPool().query<{ anon: boolean; authenticated: boolean; service_role: boolean }>(
      `SELECT has_function_privilege('anon', 'public.stockholm_today()', 'EXECUTE') AS anon,
              has_function_privilege('authenticated', 'public.stockholm_today()', 'EXECUTE') AS authenticated,
              has_function_privilege('service_role', 'public.stockholm_today()', 'EXECUTE') AS service_role`,
    )
    expect(rows[0]).toEqual({ anon: false, authenticated: true, service_role: true })
  })
})

describe('the session date in SQL', () => {
  it('is read only by the functions that say why', async () => {
    const { rows } = await getPool().query<{ proname: string }>(
      `SELECT DISTINCT p.proname
         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public' AND p.prosrc ~* '\\mcurrent_date\\M'
        ORDER BY 1`,
    )
    expect(rows.map((r) => r.proname)).toEqual(Object.keys(ON_THE_SESSION_DATE).sort())
  })
})
