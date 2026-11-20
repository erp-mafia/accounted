/**
 * The SIE import replaces an empty, open räkenskapsår that overlaps the
 * file's year (precheckFiscalPeriod: create, replacesEmptyPeriodId). When the
 * next year was linked to the empty one (previous_period_id, as creating a
 * year by hand in front of another leaves it), the delete hit
 * fiscal_periods_previous_period_id_fkey and the import answered 500, three
 * times in a row for one company on 2026-11-15.
 *
 * Here ensureFiscalPeriod runs as the member's own session (RLS) against the
 * real foreign key and every fiscal_periods trigger, with the next year open,
 * klarmarkerat, locked and closed with a bokslut. No guard on the table
 * covers previous_period_id, so in each state the import clears the link,
 * replaces the empty year and points the next year at the file's year: the
 * outcome the parse preview promised. What is not real is the HTTP hop to
 * PostgREST (tests/pg/postgrest-over-pg.ts); every request must stay inside
 * its grammar.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { getPool } from './setup'
import { createPgRest, type PgRest } from './postgrest-over-pg'
import {
  insertAuthUser,
  insertCompany,
  insertCompanyMember,
  insertFiscalPeriod,
  insertPostedJournalEntry,
  setActiveCompany,
} from './fixtures'
import { ensureFiscalPeriod, precheckFiscalPeriod } from '@/lib/import/sie-import'

class UnusedRealtimeTransport {
  constructor() {
    throw new Error('pg-real: realtime is not used')
  }
}

const shims: PgRest[] = []

/** A supabase-js client acting as a signed-in member, through RLS. */
function memberClient(userId: string): SupabaseClient {
  const rest = createPgRest({ role: 'authenticated', userId })
  shims.push(rest)
  return createClient('http://pg-real.invalid', 'pg-real-anon', {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch: rest.fetch },
    realtime: { transport: UnusedRealtimeTransport as never },
  })
}

afterEach(() => {
  const unsupported = shims.flatMap((rest) => rest.unsupported.splice(0))
  shims.length = 0
  expect(unsupported).toEqual([])
})

type NextYearState = 'open' | 'klarmarkerat' | 'locked' | 'closed with a bokslut'

/** An owner, an empty 2024 created in front of 2025, and 2025 linked to it in the given state. */
async function books(state: NextYearState) {
  const userId = await insertAuthUser()
  const companyId = await insertCompany({ createdBy: userId })
  await insertCompanyMember({ companyId, userId, role: 'owner' })
  await setActiveCompany(userId, companyId)
  const empty = await insertFiscalPeriod({
    userId, companyId, name: 'Räkenskapsår 2024', periodStart: '2024-01-01', periodEnd: '2024-12-31',
  })
  const next = await insertFiscalPeriod({
    userId, companyId, name: 'Räkenskapsår 2025', periodStart: '2025-01-01', periodEnd: '2025-12-31',
  })
  // Seeding on the superuser connection, as the app's own doors leave it.
  const pool = getPool()
  await pool.query(`UPDATE public.fiscal_periods SET previous_period_id = $2 WHERE id = $1`, [next, empty])
  if (state === 'klarmarkerat') {
    await pool.query(
      `UPDATE public.fiscal_periods
          SET is_closed = true, closed_at = now(), closed_externally = true, locked_at = now()
        WHERE id = $1`,
      [next],
    )
  }
  if (state === 'locked') {
    await pool.query(`UPDATE public.fiscal_periods SET locked_at = now() WHERE id = $1`, [next])
  }
  if (state === 'closed with a bokslut') {
    const bokslut = await insertPostedJournalEntry({
      userId, companyId, fiscalPeriodId: next, entryDate: '2025-12-31',
      description: 'Årsbokslut 2025', sourceType: 'year_end', voucherNumber: 9001,
      lines: [
        { accountNumber: '3001', debitAmount: 1000, creditAmount: 0 },
        { accountNumber: '2099', debitAmount: 0, creditAmount: 1000 },
      ],
    })
    await pool.query(
      `UPDATE public.fiscal_periods
          SET closing_entry_id = $2, locked_at = now(), is_closed = true, closed_at = now()
        WHERE id = $1`,
      [next, bokslut],
    )
  }
  return { companyId, empty, next, client: memberClient(userId) }
}

async function yearsOf(companyId: string) {
  const { rows } = await getPool().query(
    `SELECT id, period_start::text AS period_start, period_end::text AS period_end, previous_period_id,
            is_closed, closed_externally, locked_at IS NOT NULL AS locked, closing_entry_id
       FROM public.fiscal_periods WHERE company_id = $1 ORDER BY period_start`,
    [companyId],
  )
  return rows
}

describe('an SIE import replacing an empty year the next year is linked to', () => {
  it.each<NextYearState>(['open', 'klarmarkerat', 'locked', 'closed with a bokslut'])(
    'replaces it and links the next year to the file\'s year when the next year is %s',
    async (state) => {
      const b = await books(state)
      const [, nextBefore] = await yearsOf(b.companyId)

      // The förlängt first year in the file (18 months) overlaps the empty 2024.
      await expect(precheckFiscalPeriod(b.client, b.companyId, '2023-07-01', '2024-12-31')).resolves.toEqual({
        verdict: 'create',
        replacesEmptyPeriodId: b.empty,
      })

      const fileYear = await ensureFiscalPeriod(b.client, b.companyId, '2023-07-01', '2024-12-31')

      expect(fileYear).not.toBe(b.empty)
      const years = await yearsOf(b.companyId)
      expect(years.map((y) => [y.id, y.period_start, y.period_end, y.previous_period_id])).toEqual([
        [fileYear, '2023-07-01', '2024-12-31', null],
        [b.next, '2025-01-01', '2025-12-31', fileYear],
      ])
      // Only the link moved: the next year keeps its close, lock and bokslut.
      expect(years[1]).toEqual({ ...nextBefore, previous_period_id: fileYear })
    },
    30000,
  )
})
