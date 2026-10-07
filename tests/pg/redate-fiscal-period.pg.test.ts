/**
 * pg-real tests for redate_fiscal_period (migration 20261005211012, crm#1010).
 *
 * The case that must work: an aktiebolag's first räkenskapsår was recorded
 * from 2025-04-24 while Bolagsverket registered it from 2025-04-23, and
 * verifikat are already posted from 2025-04-24 on. Moving the start one day
 * earlier reassigns nothing, so it succeeds, leaves every verifikat exactly as
 * it was and lands in audit_log (behandlingshistorik).
 *
 * Everything that would be affected refuses with a named Swedish blocker:
 * verifikat or drafts outside the new dates, posted opening balances when the
 * start moves, a locked or closed year, the company lock date over a changed
 * day, an unfinished SIE import, a filed annual declaration or tax decision,
 * BFL 3 kap. shape and the BFNAR 2013:2 chain to the neighbouring years. The
 * actor gate mirrors correct_entry_metadata: a session acts as itself, only a
 * service-role caller may name the actor, and viewers and outsiders get
 * FORBIDDEN. anon cannot execute the function at all.
 */
import { describe, expect, it } from 'vitest'
import { getPool, runAsServiceRole, withUserContext } from '@/tests/pg/setup'
import {
  insertAuthUser,
  insertCompany,
  insertCompanyMember,
  insertDraftJournalEntry,
  insertFiscalPeriod,
  insertPostedJournalEntry,
} from '@/tests/pg/fixtures'
import type { EntityType } from '@/types'

interface Blocker {
  code: string
  message_sv: string
  [key: string]: unknown
}

interface RedateResult {
  ok: boolean
  code?: string
  changed?: boolean
  dry_run?: boolean
  blockers?: Blocker[]
  period?: { period_start: string; period_end: string; name: string }
  previous?: { period_start: string; period_end: string; name: string }
}

interface Year {
  userId: string
  companyId: string
  periodId: string
}

const SQL = `SELECT public.redate_fiscal_period($1::uuid, $2::uuid, $3::date, $4::date, $5::text, $6::boolean, $7::uuid) AS result`

/** The crm#1010 shape: an AB whose first year was recorded one day late. */
async function seedFirstYear(
  opts: { entityType?: EntityType; start?: string; end?: string } = {},
): Promise<Year> {
  const userId = await insertAuthUser()
  const companyId = await insertCompany({ createdBy: userId, entityType: opts.entityType ?? 'aktiebolag' })
  await insertCompanyMember({ companyId, userId, role: 'owner' })
  const periodId = await insertFiscalPeriod({
    userId,
    companyId,
    periodStart: opts.start ?? '2025-04-24',
    periodEnd: opts.end ?? '2026-08-31',
    name: 'Räkenskapsår 2025/2026',
  })
  return { userId, companyId, periodId }
}

async function post(year: Year, entryDate: string, voucherNumber: number, sourceType = 'manual'): Promise<string> {
  return insertPostedJournalEntry({
    userId: year.userId,
    companyId: year.companyId,
    fiscalPeriodId: year.periodId,
    entryDate,
    voucherNumber,
    sourceType,
  })
}

/** The v1/MCP door: service role, actor named by p_user_id. Commits. */
async function redate(
  year: Year,
  start: string | null,
  end: string | null,
  opts: { actor?: string | null; name?: string; dryRun?: boolean } = {},
): Promise<RedateResult> {
  const actor = opts.actor === undefined ? year.userId : opts.actor
  const res = await runAsServiceRole((client) =>
    client.query<{ result: RedateResult }>(SQL, [
      year.companyId,
      year.periodId,
      start,
      end,
      opts.name ?? null,
      opts.dryRun ?? false,
      actor,
    ]),
  )
  return res.rows[0].result
}

/** The dashboard door: an end-user session. Rolled back afterwards. */
async function redateAsSession(
  sessionUserId: string,
  year: Year,
  start: string,
  end: string,
  claimedActor: string | null = null,
): Promise<RedateResult> {
  return withUserContext(sessionUserId, async (client) => {
    const res = await client.query<{ result: RedateResult }>(SQL, [
      year.companyId,
      year.periodId,
      start,
      end,
      null,
      false,
      claimedActor,
    ])
    return res.rows[0].result
  })
}

async function periodRow(periodId: string): Promise<{ period_start: string; period_end: string; name: string }> {
  const { rows } = await getPool().query<{ period_start: string; period_end: string; name: string }>(
    `SELECT period_start::text, period_end::text, name FROM public.fiscal_periods WHERE id = $1`,
    [periodId],
  )
  return rows[0]
}

async function entriesSnapshot(companyId: string): Promise<unknown[]> {
  const { rows } = await getPool().query(
    `SELECT id, entry_date::text, voucher_series, voucher_number, status, fiscal_period_id, updated_at
       FROM public.journal_entries WHERE company_id = $1 ORDER BY id`,
    [companyId],
  )
  return rows
}

function blockerCodes(result: RedateResult): string[] {
  return (result.blockers ?? []).map((b) => b.code)
}

describe('redate_fiscal_period: the crm#1010 correction.pg', () => {
  it('moves the start one day earlier while the posted verifikat stay untouched', async () => {
    const year = await seedFirstYear()
    await post(year, '2025-04-24', 1)
    await post(year, '2025-05-02', 2)
    await post(year, '2026-08-15', 3)
    const before = await entriesSnapshot(year.companyId)

    const result = await redate(year, '2025-04-23', '2026-08-31')

    expect(result).toMatchObject({
      ok: true,
      changed: true,
      period: { period_start: '2025-04-23', period_end: '2026-08-31' },
      previous: { period_start: '2025-04-24', period_end: '2026-08-31' },
    })
    expect(await periodRow(year.periodId)).toMatchObject({ period_start: '2025-04-23', period_end: '2026-08-31' })
    expect(await entriesSnapshot(year.companyId)).toEqual(before)

    // write_audit_log records the change with both dates: the
    // behandlingshistorik reads it as "Räkenskapsår ändrat".
    const { rows } = await getPool().query<{ old_start: string; new_start: string }>(
      `SELECT old_state->>'period_start' AS old_start, new_state->>'period_start' AS new_start
         FROM public.audit_log
        WHERE table_name = 'fiscal_periods' AND record_id = $1 AND action = 'UPDATE'`,
      [year.periodId],
    )
    expect(rows).toEqual([{ old_start: '2025-04-24', new_start: '2025-04-23' }])
  })

  it('a dry run answers the same verdict and writes nothing', async () => {
    const year = await seedFirstYear()
    await post(year, '2025-04-24', 1)

    const result = await redate(year, '2025-04-23', null, { dryRun: true })

    expect(result).toMatchObject({ ok: true, changed: true, dry_run: true })
    expect(await periodRow(year.periodId)).toMatchObject({ period_start: '2025-04-24' })
    const { rows } = await getPool().query(
      `SELECT 1 FROM public.audit_log WHERE table_name = 'fiscal_periods' AND record_id = $1 AND action = 'UPDATE'`,
      [year.periodId],
    )
    expect(rows).toHaveLength(0)
  })

  it('moves the end as well when nothing is booked after the new end, and renames atomically', async () => {
    const year = await seedFirstYear()
    await post(year, '2025-04-24', 1)
    await post(year, '2026-05-31', 2)

    const result = await redate(year, '2025-04-23', '2026-06-30', { name: 'Räkenskapsår 2025/2026 (förkortat)' })

    expect(result.ok).toBe(true)
    expect(await periodRow(year.periodId)).toEqual({
      period_start: '2025-04-23',
      period_end: '2026-06-30',
      name: 'Räkenskapsår 2025/2026 (förkortat)',
    })
  })

  it('still moves the first year start when a following year exists', async () => {
    const year = await seedFirstYear()
    await post(year, '2025-04-24', 1)
    await insertFiscalPeriod({
      userId: year.userId,
      companyId: year.companyId,
      periodStart: '2026-09-01',
      periodEnd: '2027-08-31',
      name: 'Räkenskapsår 2026/2027',
    })

    const result = await redate(year, '2025-04-23', '2026-08-31')
    expect(result.ok).toBe(true)
  })
})

describe('redate_fiscal_period: refusals name what blocks.pg', () => {
  it('refuses a start that would leave a posted verifikat outside, and names it', async () => {
    const year = await seedFirstYear()
    await post(year, '2025-04-24', 1)
    await post(year, '2025-05-02', 2)

    const result = await redate(year, '2025-05-01', null)

    expect(result).toMatchObject({ ok: false, code: 'FISCAL_PERIOD_DATES_BLOCKED' })
    const blocker = result.blockers?.find((b) => b.code === 'entries_outside')
    expect(blocker).toMatchObject({ count: 1, first_date: '2025-04-24', last_date: '2025-04-24' })
    expect(blocker?.message_sv).toBe(
      'En bokförd verifikation ligger utanför de nya datumen: A1 (2025-04-24).',
    )
    expect(await periodRow(year.periodId)).toMatchObject({ period_start: '2025-04-24' })
  })

  it('refuses an end before the last verifikat, a reversed one included', async () => {
    const year = await seedFirstYear()
    const late = await post(year, '2026-08-15', 1)
    await getPool().query(
      `UPDATE public.journal_entries SET status = 'reversed' WHERE id = $1`,
      [late],
    )

    const result = await redate(year, null, '2026-07-31')

    expect(blockerCodes(result)).toEqual(['entries_outside'])
    expect(await periodRow(year.periodId)).toMatchObject({ period_end: '2026-08-31' })
  })

  it('refuses when a draft would fall outside the new dates', async () => {
    const year = await seedFirstYear()
    await insertDraftJournalEntry({
      userId: year.userId,
      companyId: year.companyId,
      fiscalPeriodId: year.periodId,
      entryDate: '2025-04-24',
    })

    const result = await redate(year, '2025-05-01', null)

    expect(blockerCodes(result)).toEqual(['drafts_outside'])
    expect(result.blockers?.[0].message_sv).toMatch(/^Ett utkast ligger utanför de nya datumen/)
  })

  it('refuses moving the start away from posted opening balances, but lets the end move', async () => {
    const year = await seedFirstYear()
    await post(year, '2025-04-24', 1, 'opening_balance')

    const start = await redate(year, '2025-04-23', null)
    expect(blockerCodes(start)).toEqual(['opening_balance'])
    expect(start.blockers?.[0].message_sv).toContain('A1 (2025-04-24)')

    const end = await redate(year, null, '2026-06-30')
    expect(end.ok).toBe(true)
  })

  it('refuses a locked year and a closed year', async () => {
    const locked = await seedFirstYear()
    await getPool().query(`UPDATE public.fiscal_periods SET locked_at = now() WHERE id = $1`, [locked.periodId])
    expect(blockerCodes(await redate(locked, '2025-04-23', null))).toContain('period_locked')

    const closed = await seedFirstYear()
    await getPool().query(
      `UPDATE public.fiscal_periods SET is_closed = true, closed_at = now() WHERE id = $1`,
      [closed.periodId],
    )
    expect(blockerCodes(await redate(closed, '2025-04-23', null))).toContain('period_closed')
  })

  it('refuses when the company lock date reaches a changed day, not otherwise', async () => {
    const year = await seedFirstYear()
    await post(year, '2025-04-24', 1)
    await getPool().query(
      `INSERT INTO public.company_settings (user_id, company_id, bookkeeping_locked_through)
       VALUES ($1, $2, '2025-06-30')`,
      [year.userId, year.companyId],
    )

    const covered = await redate(year, '2025-04-23', null)
    expect(blockerCodes(covered)).toEqual(['company_lock_date'])
    expect(covered.blockers?.[0]).toMatchObject({ locked_through: '2025-06-30' })

    // Only the end changes, and the lock stops long before it.
    const endOnly = await redate(year, null, '2026-07-31')
    expect(endOnly.ok).toBe(true)
  })

  it('refuses while an SIE import holds the year', async () => {
    const year = await seedFirstYear()
    const { rows } = await getPool().query<{ id: string }>(
      `INSERT INTO public.sie_imports (company_id, user_id, filename, file_hash, sie_type, status)
       VALUES ($1, $2, 'hold.se', md5(gen_random_uuid()::text), 4, 'completed') RETURNING id`,
      [year.companyId, year.userId],
    )
    await getPool().query(`UPDATE public.fiscal_periods SET import_hold = $2 WHERE id = $1`, [
      year.periodId,
      rows[0].id,
    ])

    expect(blockerCodes(await redate(year, '2025-04-23', null))).toEqual(['sie_import_hold'])
  })

  it('refuses when an annual declaration or a tax decision for the year exists', async () => {
    const filed = await seedFirstYear()
    await getPool().query(
      `INSERT INTO public.deadlines (company_id, user_id, title, due_date, deadline_type, tax_deadline_type, tax_period, status)
       VALUES ($1, $2, 'Inkomstdeklaration AB 2025/2026', '2027-04-01', 'tax', 'inkomstdeklaration_ab', '2025/2026', 'submitted')`,
      [filed.companyId, filed.userId],
    )
    const declared = await redate(filed, '2025-04-23', null)
    expect(blockerCodes(declared)).toEqual(['annual_filing'])
    expect(declared.blockers?.[0].message_sv).toBe('Följande är redan inlämnat för räkenskapsåret: inkomstdeklaration.')

    const assessed = await seedFirstYear()
    await getPool().query(
      `INSERT INTO public.tax_assessment_notices (company_id, user_id, fiscal_period_id, decision_type, decision_date, payment_due_date)
       VALUES ($1, $2, $3, 'final', '2027-08-01', '2027-11-12')`,
      [assessed.companyId, assessed.userId, assessed.periodId],
    )
    expect(blockerCodes(await redate(assessed, '2025-04-23', null))).toEqual(['tax_assessment'])
  })

  it('keeps the BFL 3 kap. shape: month-end end, at most 18 months, calendar year for an enskild firma', async () => {
    const year = await seedFirstYear()
    expect(blockerCodes(await redate(year, null, '2026-08-30'))).toEqual(['end_not_month_end'])

    const tooLong = await redate(year, '2025-04-23', '2026-10-31')
    expect(blockerCodes(tooLong)).toEqual(['exceeds_18_months'])
    expect(tooLong.blockers?.[0]).toMatchObject({ months: 19, max_months: 18 })

    expect(blockerCodes(await redate(year, '2026-08-31', '2025-04-23'))).toEqual(['end_not_after_start'])

    const firm = await seedFirstYear({ entityType: 'enskild_firma', start: '2025-04-24', end: '2025-12-31' })
    expect(blockerCodes(await redate(firm, null, '2026-06-30'))).toEqual(['enskild_firma_calendar_year'])
    expect((await redate(firm, '2025-04-23', null)).ok).toBe(true)
  })

  it('keeps the chain to the neighbouring years (BFNAR 2013:2)', async () => {
    const year = await seedFirstYear()
    const nextId = await insertFiscalPeriod({
      userId: year.userId,
      companyId: year.companyId,
      periodStart: '2026-09-01',
      periodEnd: '2027-08-31',
      name: 'Räkenskapsår 2026/2027',
    })

    const gap = await redate(year, null, '2026-06-30')
    expect(blockerCodes(gap)).toEqual(['not_contiguous'])
    expect(gap.blockers?.[0]).toMatchObject({ expected_end: '2026-08-31', following_period_id: nextId })

    const overlap = await redate(year, null, '2026-09-30')
    expect(blockerCodes(overlap)).toEqual(['overlap'])
    expect(overlap.blockers?.[0].message_sv).toBe('De nya datumen överlappar Räkenskapsår 2026/2027.')

    // A later year may not start mid-month, nor away from its predecessor.
    const second: Year = { ...year, periodId: nextId }
    expect(blockerCodes(await redate(second, '2026-09-02', null)).sort()).toEqual(
      ['not_contiguous', 'start_not_first_of_month'],
    )
  })
})

describe('redate_fiscal_period: actor gate.pg', () => {
  it('refuses without an actor, for a viewer and for an outsider', async () => {
    const year = await seedFirstYear()
    const viewer = await insertAuthUser()
    await insertCompanyMember({ companyId: year.companyId, userId: viewer, role: 'viewer' })
    const outsider = await insertAuthUser()

    for (const actor of [null, viewer, outsider]) {
      expect(await redate(year, '2025-04-23', null, { actor })).toMatchObject({ ok: false, code: 'FORBIDDEN' })
    }
    expect(await periodRow(year.periodId)).toMatchObject({ period_start: '2025-04-24' })
  })

  it('a session acts as itself: naming an owner as p_user_id lends nothing', async () => {
    const year = await seedFirstYear()
    const outsider = await insertAuthUser()

    const result = await redateAsSession(outsider, year, '2025-04-23', '2026-08-31', year.userId)
    expect(result).toMatchObject({ ok: false, code: 'FORBIDDEN' })
  })

  it('a writing member re-dates through a session', async () => {
    const year = await seedFirstYear()
    const member = await insertAuthUser()
    await insertCompanyMember({ companyId: year.companyId, userId: member, role: 'member' })

    const result = await redateAsSession(member, year, '2025-04-23', '2026-08-31')
    expect(result).toMatchObject({ ok: true, changed: true, period: { period_start: '2025-04-23' } })
  })

  it('anon cannot execute it; authenticated and service_role can', async () => {
    const { rows } = await getPool().query<{ anon: boolean; auth: boolean; service: boolean }>(
      `SELECT has_function_privilege('anon', p.oid, 'EXECUTE') AS anon,
              has_function_privilege('authenticated', p.oid, 'EXECUTE') AS auth,
              has_function_privilege('service_role', p.oid, 'EXECUTE') AS service
         FROM pg_proc p
        WHERE p.oid = 'public.redate_fiscal_period(uuid,uuid,date,date,text,boolean,uuid)'::regprocedure`,
    )
    expect(rows[0]).toEqual({ anon: false, auth: true, service: true })
  })

  it('answers PERIOD_NOT_FOUND for a year of another company', async () => {
    const year = await seedFirstYear()
    const other = await seedFirstYear()
    const result = await redate({ ...year, periodId: other.periodId }, '2025-04-23', null)
    expect(result).toMatchObject({ ok: false, code: 'PERIOD_NOT_FOUND' })
  })
})
