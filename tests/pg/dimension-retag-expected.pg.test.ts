import { describe, expect, it } from 'vitest'
import { getPool, runAsServiceRole, withUserContext } from '@/tests/pg/setup'
import {
  seedCompany,
  insertAuthUser,
  insertCompanyMember,
  insertDraftJournalEntry,
} from '@/tests/pg/fixtures'

// Migration 20261122120000_retag_expected_dimensions_and_closed_period_restore.sql
//
//   1. retag_line_dimensions(..., p_expected_dimensions): optimistic check
//      against the planned value, delegating to the unchanged 5-arg RPC.
//   2. restore_closed_period_line_dimensions: service-role-only path that puts
//      back tags on UNTAGGED lines in closed/locked periods, owner/admin only,
//      dimension column only, one log row per line.

async function insertPostedLine(params: {
  companyId: string
  userId: string
  fiscalPeriodId: string
  dimensions?: Record<string, string> | null
  voucherNumber?: number
}): Promise<{ entryId: string; lineId: string }> {
  const entryId = await insertDraftJournalEntry({
    userId: params.userId,
    companyId: params.companyId,
    fiscalPeriodId: params.fiscalPeriodId,
    sourceType: 'manual',
    status: 'draft',
    voucherNumber: params.voucherNumber ?? 1,
  })
  const dims = params.dimensions === undefined ? {} : params.dimensions
  const { rows } = await getPool().query<{ id: string }>(
    `INSERT INTO public.journal_entry_lines
       (journal_entry_id, account_number, debit_amount, credit_amount, line_description, dimensions)
     VALUES ($1, '5010', 1000, 0, 'Hyra', $2::jsonb)
     RETURNING id`,
    [entryId, dims === null ? null : JSON.stringify(dims)],
  )
  await getPool().query(
    `INSERT INTO public.journal_entry_lines
       (journal_entry_id, account_number, debit_amount, credit_amount)
     VALUES ($1, '1930', 0, 1000)`,
    [entryId],
  )
  await getPool().query(`UPDATE public.journal_entries SET status = 'posted' WHERE id = $1`, [entryId])
  return { entryId, lineId: rows[0].id }
}

async function insertRegistryValue(companyId: string, sieDimNo: number, code: string) {
  const { rows } = await getPool().query<{ id: string }>(
    `INSERT INTO public.dimensions (company_id, sie_dim_no, name, resets_annually, is_system, is_active)
     VALUES ($1, $2::int, 'Dim ' || $2::text, true, false, true)
     ON CONFLICT (company_id, sie_dim_no) DO UPDATE SET is_active = true
     RETURNING id`,
    [companyId, sieDimNo],
  )
  await getPool().query(
    `INSERT INTO public.dimension_values (company_id, dimension_id, code, name, is_active)
     VALUES ($1, $2, $3, $3, true)
     ON CONFLICT (company_id, dimension_id, code) DO NOTHING`,
    [companyId, rows[0].id, code],
  )
}

async function closePeriod(fiscalPeriodId: string) {
  await getPool().query(
    `UPDATE public.fiscal_periods SET is_closed = true, closed_at = now() WHERE id = $1`,
    [fiscalPeriodId],
  )
}

const RETAG6 = `SELECT public.retag_line_dimensions($1::uuid, $2::uuid, $3::jsonb, $4, $5::uuid, $6::jsonb) AS result`
const RESTORE = `SELECT public.restore_closed_period_line_dimensions($1::uuid, $2::uuid, $3::jsonb, $4, $5::uuid, $6::jsonb) AS result`

function args(
  companyId: string,
  lineId: string,
  dims: Record<string, string>,
  reason: string,
  actor: string,
  expected: Record<string, string> | null,
) {
  return [companyId, lineId, JSON.stringify(dims), reason, actor, expected === null ? null : JSON.stringify(expected)]
}

async function lineRow(lineId: string) {
  const { rows } = await getPool().query(
    `SELECT dimensions, cost_center, account_number, debit_amount, credit_amount, line_description
       FROM public.journal_entry_lines WHERE id = $1`,
    [lineId],
  )
  return rows[0]
}

async function logRows(lineId: string) {
  const { rows } = await getPool().query(
    `SELECT old_dimensions, new_dimensions, actor, reason FROM public.dimension_retag_log WHERE line_id = $1`,
    [lineId],
  )
  return rows
}

async function errorOf(p: Promise<unknown>): Promise<{ code?: string; message: string }> {
  try {
    await p
  } catch (e) {
    const err = e as { code?: string; message: string }
    return { code: err.code, message: err.message }
  }
  throw new Error('expected the call to fail')
}

describe('retag_line_dimensions with expected dimensions', () => {
  it('writes and logs when the line matches the expectation', async () => {
    const { companyId, userId, fiscalPeriodId } = await seedCompany()
    await insertRegistryValue(companyId, 1, 'KS01')
    const { lineId } = await insertPostedLine({ companyId, userId, fiscalPeriodId })

    const res = await getPool().query(RETAG6, args(companyId, lineId, { '1': 'KS01' }, 'Planerad taggning', userId, {}))
    expect(res.rows[0].result.changed).toBe(true)
    expect((await lineRow(lineId)).dimensions).toEqual({ '1': 'KS01' })
    const log = await logRows(lineId)
    expect(log).toHaveLength(1)
    expect(log[0].actor).toBe(userId)
  })

  it('raises 40001 and writes nothing when the line changed since the plan', async () => {
    const { companyId, userId, fiscalPeriodId } = await seedCompany()
    await insertRegistryValue(companyId, 1, 'KS01')
    await insertRegistryValue(companyId, 1, 'KS02')
    const { lineId } = await insertPostedLine({ companyId, userId, fiscalPeriodId, dimensions: { '1': 'KS02' } })

    const err = await errorOf(
      getPool().query(RETAG6, args(companyId, lineId, { '1': 'KS01' }, 'Planerad taggning', userId, {})),
    )
    expect(err.code).toBe('40001')
    expect((await lineRow(lineId)).dimensions).toEqual({ '1': 'KS02' })
    expect(await logRows(lineId)).toHaveLength(0)
  })

  it('treats a NULL bag as untagged ({})', async () => {
    const { companyId, userId, fiscalPeriodId } = await seedCompany()
    await insertRegistryValue(companyId, 1, 'KS01')
    // Older rows may hold NULL; the column may forbid it, in which case the
    // '{}' path above already covers the comparison.
    let lineId: string
    try {
      lineId = (await insertPostedLine({ companyId, userId, fiscalPeriodId, dimensions: null })).lineId
    } catch {
      return
    }
    const res = await getPool().query(RETAG6, args(companyId, lineId, { '1': 'KS01' }, 'Planerad taggning', userId, {}))
    expect(res.rows[0].result.changed).toBe(true)
    expect(await logRows(lineId)).toHaveLength(1)
  })

  it("cannot reach another company's line", async () => {
    const a = await seedCompany()
    const b = await seedCompany()
    const { lineId } = await insertPostedLine({ companyId: a.companyId, userId: a.userId, fiscalPeriodId: a.fiscalPeriodId })

    await expect(
      getPool().query(RETAG6, args(b.companyId, lineId, {}, 'Annat bolag', b.userId, {})),
    ).rejects.toThrow(/hittades inte/)
    expect(await logRows(lineId)).toHaveLength(0)
  })

  it('keeps every check of the 5-argument function (closed period refused)', async () => {
    const { companyId, userId, fiscalPeriodId } = await seedCompany()
    await insertRegistryValue(companyId, 1, 'KS01')
    const { lineId } = await insertPostedLine({ companyId, userId, fiscalPeriodId })
    await closePeriod(fiscalPeriodId)

    await expect(
      getPool().query(RETAG6, args(companyId, lineId, { '1': 'KS01' }, 'Planerad taggning', userId, {})),
    ).rejects.toThrow(/stängd/)
    expect(await logRows(lineId)).toHaveLength(0)
  })

  it('leaves the 5-argument function callable with 4 and 5 arguments', async () => {
    const { companyId, userId, fiscalPeriodId } = await seedCompany()
    await insertRegistryValue(companyId, 1, 'KS01')
    const { lineId } = await insertPostedLine({ companyId, userId, fiscalPeriodId })

    const five = await getPool().query(
      `SELECT public.retag_line_dimensions($1::uuid, $2::uuid, $3::jsonb, $4, $5::uuid) AS result`,
      [companyId, lineId, JSON.stringify({ '1': 'KS01' }), 'Fem argument', userId],
    )
    expect(five.rows[0].result.changed).toBe(true)

    // 4 arguments resolves to the 5-arg function's DEFAULT, not the overload.
    const four = await withUserContext(userId, (client) =>
      client.query(
        `SELECT public.retag_line_dimensions($1::uuid, $2::uuid, $3::jsonb, $4) AS result`,
        [companyId, lineId, JSON.stringify({}), 'Fyra argument'],
      ),
    )
    expect(four.rows[0].result.changed).toBe(true)
  })
})

describe('restore_closed_period_line_dimensions', () => {
  it('restores an untagged line in a closed period, dimension column only, logged', async () => {
    const { companyId, userId, fiscalPeriodId } = await seedCompany()
    await insertRegistryValue(companyId, 1, 'KS01')
    const { entryId, lineId } = await insertPostedLine({ companyId, userId, fiscalPeriodId })
    const before = await lineRow(lineId)
    await closePeriod(fiscalPeriodId)

    const res = await runAsServiceRole((client) =>
      client.query(RESTORE, args(companyId, lineId, { '1': 'KS01' }, 'Återställt objekt ur SIE-fil', userId, {})),
    )
    expect(res.rows[0].result.changed).toBe(true)
    expect(res.rows[0].result.closed_period).toBe(true)

    const after = await lineRow(lineId)
    expect(after.dimensions).toEqual({ '1': 'KS01' })
    expect(after.cost_center).toBe('KS01')
    expect(after.account_number).toBe(before.account_number)
    expect(after.debit_amount).toBe(before.debit_amount)
    expect(after.credit_amount).toBe(before.credit_amount)
    expect(after.line_description).toBe(before.line_description)

    const { rows: log } = await getPool().query(
      `SELECT journal_entry_id, old_dimensions, new_dimensions, actor, reason
         FROM public.dimension_retag_log WHERE line_id = $1`,
      [lineId],
    )
    expect(log).toHaveLength(1)
    expect(log[0].journal_entry_id).toBe(entryId)
    expect(log[0].old_dimensions).toEqual({})
    expect(log[0].new_dimensions).toEqual({ '1': 'KS01' })
    expect(log[0].actor).toBe(userId)
    expect(log[0].reason).toBe('[stängd period] Återställt objekt ur SIE-fil')
  })

  it('also covers locked periods and lines behind the company lock date', async () => {
    const locked = await seedCompany()
    await insertRegistryValue(locked.companyId, 1, 'KS01')
    const l1 = await insertPostedLine(locked)
    await getPool().query(`UPDATE public.fiscal_periods SET locked_at = now() WHERE id = $1`, [locked.fiscalPeriodId])
    const r1 = await runAsServiceRole((c) =>
      c.query(RESTORE, args(locked.companyId, l1.lineId, { '1': 'KS01' }, 'Återställt objekt ur SIE-fil', locked.userId, {})),
    )
    expect(r1.rows[0].result.changed).toBe(true)

    const dated = await seedCompany()
    await insertRegistryValue(dated.companyId, 1, 'KS01')
    const l2 = await insertPostedLine(dated)
    const { rows } = await getPool().query<{ entry_date: string }>(
      `SELECT entry_date::text FROM public.journal_entries WHERE id = (SELECT journal_entry_id FROM public.journal_entry_lines WHERE id = $1)`,
      [l2.lineId],
    )
    await getPool().query(
      `INSERT INTO public.company_settings (user_id, company_id, bookkeeping_locked_through)
       VALUES ($1, $2, $3::date)
       ON CONFLICT (company_id) DO UPDATE SET bookkeeping_locked_through = EXCLUDED.bookkeeping_locked_through`,
      [dated.userId, dated.companyId, rows[0].entry_date],
    )
    const r2 = await runAsServiceRole((c) =>
      c.query(RESTORE, args(dated.companyId, l2.lineId, { '1': 'KS01' }, 'Återställt objekt ur SIE-fil', dated.userId, {})),
    )
    expect(r2.rows[0].result.changed).toBe(true)
  })

  it('refuses open periods (they use retag_line_dimensions)', async () => {
    const { companyId, userId, fiscalPeriodId } = await seedCompany()
    await insertRegistryValue(companyId, 1, 'KS01')
    const { lineId } = await insertPostedLine({ companyId, userId, fiscalPeriodId })

    await expect(
      runAsServiceRole((c) =>
        c.query(RESTORE, args(companyId, lineId, { '1': 'KS01' }, 'Återställt objekt ur SIE-fil', userId, {})),
      ),
    ).rejects.toThrow(/öppen/)
    expect(await logRows(lineId)).toHaveLength(0)
  })

  it('never changes an existing tag', async () => {
    const { companyId, userId, fiscalPeriodId } = await seedCompany()
    await insertRegistryValue(companyId, 1, 'KS01')
    await insertRegistryValue(companyId, 1, 'KS02')
    const { lineId } = await insertPostedLine({ companyId, userId, fiscalPeriodId, dimensions: { '1': 'KS02' } })
    await closePeriod(fiscalPeriodId)

    const err = await errorOf(
      runAsServiceRole((c) =>
        c.query(RESTORE, args(companyId, lineId, { '1': 'KS01' }, 'Återställt objekt ur SIE-fil', userId, {})),
      ),
    )
    expect(err.code).toBe('40001')
    // An expectation other than {} is refused up front.
    await expect(
      runAsServiceRole((c) =>
        c.query(RESTORE, args(companyId, lineId, { '1': 'KS01' }, 'Återställt objekt ur SIE-fil', userId, { '1': 'KS02' })),
      ),
    ).rejects.toThrow(/otaggade/)
    expect((await lineRow(lineId)).dimensions).toEqual({ '1': 'KS02' })
    expect(await logRows(lineId)).toHaveLength(0)
  })

  it('requires owner or admin; member gets 42501', async () => {
    const { companyId, userId, fiscalPeriodId } = await seedCompany()
    await insertRegistryValue(companyId, 1, 'KS01')
    const { lineId } = await insertPostedLine({ companyId, userId, fiscalPeriodId })
    await closePeriod(fiscalPeriodId)
    const memberId = await insertAuthUser()
    await insertCompanyMember({ companyId, userId: memberId, role: 'member' })

    const err = await errorOf(
      runAsServiceRole((c) =>
        c.query(RESTORE, args(companyId, lineId, { '1': 'KS01' }, 'Återställt objekt ur SIE-fil', memberId, {})),
      ),
    )
    expect(err.code).toBe('42501')

    const adminId = await insertAuthUser()
    await insertCompanyMember({ companyId, userId: adminId, role: 'admin' })
    const ok = await runAsServiceRole((c) =>
      c.query(RESTORE, args(companyId, lineId, { '1': 'KS01' }, 'Återställt objekt ur SIE-fil', adminId, {})),
    )
    expect(ok.rows[0].result.changed).toBe(true)
    const log = await logRows(lineId)
    expect(log).toHaveLength(1)
    expect(log[0].actor).toBe(adminId)
  })

  it('is not executable by authenticated or anon', async () => {
    const { companyId, userId, fiscalPeriodId } = await seedCompany()
    const { lineId } = await insertPostedLine({ companyId, userId, fiscalPeriodId })
    await closePeriod(fiscalPeriodId)

    await expect(
      withUserContext(userId, (c) =>
        c.query(RESTORE, args(companyId, lineId, { '1': 'KS01' }, 'Återställt objekt ur SIE-fil', userId, {})),
      ),
    ).rejects.toThrow(/permission denied/)
    const { rows } = await getPool().query<{ anon: boolean; auth: boolean; svc: boolean }>(
      `SELECT has_function_privilege('anon', p, 'EXECUTE') AS anon,
              has_function_privilege('authenticated', p, 'EXECUTE') AS auth,
              has_function_privilege('service_role', p, 'EXECUTE') AS svc
         FROM (SELECT 'public.restore_closed_period_line_dimensions(uuid,uuid,jsonb,text,uuid,jsonb)'::regprocedure AS p) x`,
    )
    expect(rows[0]).toEqual({ anon: false, auth: false, svc: true })
  })

  it('reports a missing line before validating codes (contract probe)', async () => {
    const { companyId, userId } = await seedCompany()
    await expect(
      runAsServiceRole((c) =>
        c.query(RESTORE, args(companyId, '00000000-0000-0000-0000-000000000000', { '1': 'SOND' }, 'kontraktssond inget skrivs', userId, {})),
      ),
    ).rejects.toThrow(/hittades inte/)
    await expect(
      getPool().query(RETAG6, args(companyId, '00000000-0000-0000-0000-000000000000', { '1': 'SOND' }, 'kontraktssond inget skrivs', userId, {})),
    ).rejects.toThrow(/hittades inte/)
  })

  it('leaves a plain UPDATE of an amount in a closed period refused', async () => {
    const { companyId, userId, fiscalPeriodId } = await seedCompany()
    const { lineId } = await insertPostedLine({ companyId, userId, fiscalPeriodId })
    await closePeriod(fiscalPeriodId)

    await expect(
      getPool().query(`UPDATE public.journal_entry_lines SET debit_amount = 1 WHERE id = $1`, [lineId]),
    ).rejects.toThrow(/Cannot UPDATE lines of a posted journal entry/)
  })
})
