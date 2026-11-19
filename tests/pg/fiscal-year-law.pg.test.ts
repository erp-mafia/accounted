import { describe, expect, it } from 'vitest'
import { exceedsFiscalYearCap } from '@/lib/bookkeeping/validate-period-duration'
import { addDaysIso, addMonthsIso } from '@/lib/dates/iso'
import { insertAuthUser, insertCompany, insertCompanyMember, insertFiscalPeriod } from './fixtures'
import { getPool, withUserContext } from './setup'

/** enforce_fiscal_year_law: BFL 3 kap. under every door, a stored year never re-judged. */
async function company(entityType: 'aktiebolag' | 'enskild_firma') {
  const userId = await insertAuthUser()
  const companyId = await insertCompany({ createdBy: userId, entityType })
  await insertCompanyMember({ companyId, userId, role: 'owner' })
  return { userId, companyId }
}

const addYear = (who: { userId: string; companyId: string }, start: string, end: string) =>
  insertFiscalPeriod({ ...who, periodStart: start, periodEnd: end, name: `${start} ${end}` })

/** A row from before the rule: written past the trigger, in one connection. */
async function storedBeforeTheRule(who: { userId: string; companyId: string }, start: string, end: string) {
  const client = await getPool().connect()
  try {
    await client.query(`SET session_replication_role = replica`)
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO public.fiscal_periods (user_id, company_id, name, period_start, period_end)
       VALUES ($1, $2, 'old', $3, $4) RETURNING id`,
      [who.userId, who.companyId, start, end],
    )
    return rows[0].id
  } finally {
    await client.query(`SET session_replication_role = DEFAULT`)
    client.release()
  }
}

describe('at most 18 months', () => {
  it('takes 18 months, a mid-month start counting its month in full', async () => {
    const who = await company('aktiebolag')
    await expect(addYear(who, '2024-03-01', '2025-08-31')).resolves.toBeTruthy()
    const other = await company('aktiebolag')
    await expect(addYear(other, '2024-03-15', '2025-08-31')).resolves.toBeTruthy()
  })

  it('refuses 19, also for a first year', async () => {
    const who = await company('aktiebolag')
    await expect(addYear(who, '2024-03-01', '2025-09-30')).rejects.toThrow(/FISCAL_PERIOD_TOO_LONG/)
    await expect(addYear(who, '2024-01-31', '2025-07-31')).rejects.toThrow(/FISCAL_PERIOD_TOO_LONG/)
  })

  it('counts like exceedsFiscalYearCap on every shape around the line', async () => {
    const who = await company('aktiebolag')
    const shapes: Array<[string, string]> = []
    for (const start of ['2024-01-01', '2024-01-31', '2024-02-15', '2024-02-29', '2024-03-31', '2024-08-31', '2024-12-01']) {
      for (const months of [16, 17, 18, 19]) {
        // The last day of the month `months` calendar months on.
        shapes.push([start, addDaysIso(addMonthsIso(`${start.slice(0, 7)}-01`, months), -1)])
      }
    }
    const { rows } = await getPool().query<{ start: string; stop: string; refused: boolean }>(
      `SELECT start, stop,
              ((extract(year FROM stop::date)::int - extract(year FROM start::date)::int) * 12
               + (extract(month FROM stop::date)::int - extract(month FROM start::date)::int) + 1) > 18 AS refused
         FROM unnest($1::text[], $2::text[]) AS shape(start, stop)`,
      [shapes.map((shape) => shape[0]), shapes.map((shape) => shape[1])],
    )
    for (const row of rows) expect([row.start, row.stop, row.refused]).toEqual([row.start, row.stop, exceedsFiscalYearCap(row.start, row.stop)])

    for (const [start, end] of shapes) {
      const client = await getPool().connect()
      try {
        await client.query('BEGIN')
        const attempt = client.query(
          `INSERT INTO public.fiscal_periods (user_id, company_id, name, period_start, period_end) VALUES ($1, $2, 'x', $3, $4)`,
          [who.userId, who.companyId, start, end],
        )
        if (exceedsFiscalYearCap(start, end)) await expect(attempt).rejects.toThrow(/FISCAL_PERIOD_TOO_LONG/)
        else await expect(attempt).resolves.toBeTruthy()
      } finally {
        await client.query('ROLLBACK')
        client.release()
      }
    }
  })
})

describe('the calendar year of an enskild firma', () => {
  it('refuses a year ending anywhere but 31 December', async () => {
    const who = await company('enskild_firma')
    await expect(addYear(who, '2026-01-01', '2026-06-30')).rejects.toThrow(/FISCAL_PERIOD_ENSKILD_FIRMA_CALENDAR_YEAR/)
    await expect(addYear(who, '2025-09-01', '2026-08-31')).rejects.toThrow(/31 december/)
  })

  it('refuses a later year starting after 1 January', async () => {
    const who = await company('enskild_firma')
    await addYear(who, '2025-01-01', '2025-12-31')
    await expect(addYear(who, '2026-02-01', '2026-12-31')).rejects.toThrow(/bara det första/)
  })

  it('takes a first year from any day to 31 December, also ahead of a later year', async () => {
    const who = await company('enskild_firma')
    await addYear(who, '2026-01-01', '2026-12-31')
    await expect(addYear(who, '2024-07-14', '2025-12-31')).resolves.toBeTruthy()
  })

  it('leaves an aktiebolag its broken year', async () => {
    const who = await company('aktiebolag')
    await expect(addYear(who, '2025-09-01', '2026-08-31')).resolves.toBeTruthy()
    await expect(addYear(who, '2026-09-01', '2027-08-31')).resolves.toBeTruthy()
  })

  it('holds for a member writing through RLS', async () => {
    const who = await company('enskild_firma')
    await expect(
      withUserContext(who.userId, (client) =>
        client.query(
          `INSERT INTO public.fiscal_periods (user_id, company_id, name, period_start, period_end)
           VALUES ($1, $2, 'x', '2026-01-01', '2026-06-30')`,
          [who.userId, who.companyId],
        ),
      ),
    ).rejects.toThrow(/FISCAL_PERIOD_ENSKILD_FIRMA_CALENDAR_YEAR/)
  })
})

describe('a stored year is not re-judged', () => {
  it('lets an edit past a year of 36 months that leaves its dates alone', async () => {
    const who = await company('aktiebolag')
    const id = await storedBeforeTheRule(who, '2024-01-01', '2026-12-31')
    const pool = getPool()
    await expect(pool.query(`UPDATE public.fiscal_periods SET name = 'nytt namn' WHERE id = $1`, [id])).resolves.toBeTruthy()
    // PostgREST writes every column it is given, the dates included.
    await expect(
      pool.query(`UPDATE public.fiscal_periods SET period_end = '2026-12-31' WHERE id = $1`, [id]),
    ).resolves.toBeTruthy()
    await expect(
      pool.query(`UPDATE public.fiscal_periods SET period_end = '2026-06-30' WHERE id = $1`, [id]),
    ).rejects.toThrow(/FISCAL_PERIOD_TOO_LONG/)
    await expect(
      pool.query(`UPDATE public.fiscal_periods SET period_end = '2025-06-30' WHERE id = $1`, [id]),
    ).resolves.toBeTruthy()
  })

  it('lets an enskild firma on broken years keep them, and take no new one', async () => {
    const who = await company('enskild_firma')
    const id = await storedBeforeTheRule(who, '2024-09-01', '2025-08-31')
    await expect(
      getPool().query(`UPDATE public.fiscal_periods SET locked_at = now() WHERE id = $1`, [id]),
    ).resolves.toBeTruthy()
    await expect(addYear(who, '2025-09-01', '2026-08-31')).rejects.toThrow(/FISCAL_PERIOD_ENSKILD_FIRMA_CALENDAR_YEAR/)
  })
})
