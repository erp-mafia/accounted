import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { getPool, withUserContext } from './setup'
import { seedCompany } from './fixtures'

/**
 * Migration 20260925194235: a depreciation_schedules row may be released from
 * its voucher (journal_entry_id -> NULL, posted_at -> NULL) ONLY when that
 * voucher is status 'reversed' AND a posted source_type='storno' entry with
 * reverses_id pointing at it exists: the chain only the engine's
 * reverseEntry() produces. Same trust rule as the closing_entry_id detach
 * (20260720140000, tests/pg/closing-entry-detach.pg.test.ts).
 *
 * Pinned here:
 *   (a) after a storno the release succeeds, is audited, and
 *       commit_asset_depreciation can post the period again;
 *   (b) without a posted storno the release is still refused;
 *   (c) every other change to a linked row is still refused, storno or not.
 */

type Seed = { userId: string; companyId: string; fiscalPeriodId: string }

const COMMIT_SQL = `SELECT * FROM public.commit_asset_depreciation(
  $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::numeric, NULL::text, NULL::text
)`

const RELEASE_SQL = `UPDATE public.depreciation_schedules
    SET journal_entry_id = NULL, posted_at = NULL WHERE id = $1`

async function insertAsset(seed: Seed): Promise<string> {
  const assetId = randomUUID()
  await getPool().query(
    `INSERT INTO public.assets (
       id, user_id, company_id, name, category, acquisition_date,
       acquisition_cost, salvage_value, useful_life_months,
       depreciation_method, bas_asset_account, bas_accumulated_account,
       bas_expense_account
     ) VALUES ($1, $2, $3, 'Dator', 'equipment', '2026-01-01',
               100000, 0, 60, 'linear', '1220', '1229', '7832')`,
    [assetId, seed.userId, seed.companyId],
  )
  return assetId
}

/** A balanced year_end draft, the shape commitAnnualPostings() prepares. */
async function insertDepreciationDraft(seed: Seed, amount: number): Promise<string> {
  const entryId = randomUUID()
  await getPool().query(
    `INSERT INTO public.journal_entries (
       id, user_id, company_id, fiscal_period_id, voucher_number,
       voucher_series, entry_date, description, source_type, status
     ) VALUES ($1, $2, $3, $4, 0, 'A', '2026-12-31',
               'Planenlig avskrivning 2026: Dator', 'year_end', 'draft')`,
    [entryId, seed.userId, seed.companyId, seed.fiscalPeriodId],
  )
  await getPool().query(
    `INSERT INTO public.journal_entry_lines
       (journal_entry_id, account_number, debit_amount, credit_amount)
     VALUES ($1, '7832', $2, 0), ($1, '1229', 0, $2)`,
    [entryId, amount],
  )
  return entryId
}

/**
 * Mirror what reverseEntry() writes: a balanced storno with reverses_id,
 * posted (or left at `status`), then the original flipped to 'reversed'.
 */
async function storno(
  seed: Seed,
  originalId: string,
  voucherNumber: number,
  options: { stornoStatus?: 'posted' | 'draft'; markReversed?: boolean } = {},
): Promise<string> {
  const id = randomUUID()
  const client = await getPool().connect()
  try {
    await client.query('BEGIN')
    await client.query(
      `INSERT INTO public.journal_entries
         (id, user_id, company_id, fiscal_period_id, voucher_number, voucher_series,
          entry_date, description, source_type, status, reverses_id)
       VALUES ($1, $2, $3, $4, $5, 'A', '2026-12-31', 'Makulering: avskrivning',
               'storno', 'draft', $6)`,
      [id, seed.userId, seed.companyId, seed.fiscalPeriodId, voucherNumber, originalId],
    )
    await client.query(
      `INSERT INTO public.journal_entry_lines
         (journal_entry_id, account_number, debit_amount, credit_amount)
       SELECT $1, account_number, credit_amount, debit_amount
         FROM public.journal_entry_lines WHERE journal_entry_id = $2`,
      [id, originalId],
    )
    if ((options.stornoStatus ?? 'posted') === 'posted') {
      await client.query(`UPDATE public.journal_entries SET status = 'posted' WHERE id = $1`, [id])
    }
    await client.query('COMMIT')
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {})
    throw error
  } finally {
    client.release()
  }
  if (options.markReversed ?? true) {
    await getPool().query(
      `UPDATE public.journal_entries SET status = 'reversed', reversed_by_id = $2 WHERE id = $1`,
      [originalId, id],
    )
  }
  return id
}

async function seedPosted(amount = 20000) {
  const seed = await seedCompany()
  const assetId = await insertAsset(seed)
  const entryId = await insertDepreciationDraft(seed, amount)
  const { rows } = await getPool().query<{ voucher_number: number; schedule_id: string }>(
    COMMIT_SQL,
    [seed.companyId, assetId, entryId, seed.fiscalPeriodId, amount],
  )
  return { ...seed, assetId, entryId, scheduleId: rows[0].schedule_id }
}

async function schedule(scheduleId: string) {
  const { rows } = await getPool().query<{
    journal_entry_id: string | null
    posted_at: Date | null
    planned_depreciation: string
  }>(
    `SELECT journal_entry_id, posted_at, planned_depreciation
       FROM public.depreciation_schedules WHERE id = $1`,
    [scheduleId],
  )
  return rows[0]
}

describe('depreciation_schedules: storno release (a)', () => {
  it('releases the link after a posted storno, audits it, and lets the period be re-posted', async () => {
    const posted = await seedPosted(20000)
    await storno(posted, posted.entryId, 900)

    await getPool().query(RELEASE_SQL, [posted.scheduleId])

    const released = await schedule(posted.scheduleId)
    expect(released.journal_entry_id).toBeNull()
    expect(released.posted_at).toBeNull()
    expect(Number(released.planned_depreciation)).toBe(20000)

    const audit = await getPool().query<{ old_state: { journal_entry_id: string }; new_state: { journal_entry_id: string | null } }>(
      `SELECT old_state, new_state FROM public.audit_log
        WHERE table_name = 'depreciation_schedules' AND record_id = $1 AND action = 'UPDATE'`,
      [posted.scheduleId],
    )
    expect(audit.rowCount).toBe(1)
    expect(audit.rows[0].old_state.journal_entry_id).toBe(posted.entryId)
    expect(audit.rows[0].new_state.journal_entry_id).toBeNull()

    // The corrected avskrivning (e.g. a longer useful life) books through the
    // register again and the same row is adopted, not duplicated.
    const redraft = await insertDepreciationDraft(posted, 12000)
    const { rows } = await getPool().query<{ voucher_number: number; schedule_id: string }>(
      COMMIT_SQL,
      [posted.companyId, posted.assetId, redraft, posted.fiscalPeriodId, 12000],
    )
    expect(rows[0].schedule_id).toBe(posted.scheduleId)
    const reposted = await schedule(posted.scheduleId)
    expect(reposted.journal_entry_id).toBe(redraft)
    expect(reposted.posted_at).not.toBeNull()
    expect(Number(reposted.planned_depreciation)).toBe(12000)

    // Only the release is audited, not the re-link.
    const auditAfter = await getPool().query(
      `SELECT 1 FROM public.audit_log
        WHERE table_name = 'depreciation_schedules' AND record_id = $1`,
      [posted.scheduleId],
    )
    expect(auditAfter.rowCount).toBe(1)
  })

  it('an authenticated company member can release it (the reverseEntry path runs under RLS)', async () => {
    const posted = await seedPosted()
    await storno(posted, posted.entryId, 900)

    const rows = await withUserContext(posted.userId, async (client) => {
      const res = await client.query(
        `${RELEASE_SQL} RETURNING journal_entry_id`,
        [posted.scheduleId],
      )
      return res.rows
    })
    expect(rows).toEqual([{ journal_entry_id: null }])
  })
})

describe('depreciation_schedules: no release without a posted storno (b)', () => {
  it('refuses to release a live (posted) voucher', async () => {
    const posted = await seedPosted()
    await expect(getPool().query(RELEASE_SQL, [posted.scheduleId])).rejects.toMatchObject({
      code: '23514',
    })
    expect((await schedule(posted.scheduleId)).journal_entry_id).toBe(posted.entryId)
  })

  it('refuses when the voucher is flagged reversed but no storno exists', async () => {
    const posted = await seedPosted()
    await getPool().query(`UPDATE public.journal_entries SET status = 'reversed' WHERE id = $1`, [
      posted.entryId,
    ])
    await expect(getPool().query(RELEASE_SQL, [posted.scheduleId])).rejects.toMatchObject({
      code: '23514',
    })
  })

  it('refuses when the storno is not posted', async () => {
    const posted = await seedPosted()
    await storno(posted, posted.entryId, 900, { stornoStatus: 'draft' })
    await expect(getPool().query(RELEASE_SQL, [posted.scheduleId])).rejects.toMatchObject({
      code: '23514',
    })
  })

  it('refuses when a posted storno exists but the voucher is not marked reversed', async () => {
    const posted = await seedPosted()
    await storno(posted, posted.entryId, 900, { markReversed: false })
    await expect(getPool().query(RELEASE_SQL, [posted.scheduleId])).rejects.toMatchObject({
      code: '23514',
    })
  })
})

describe('depreciation_schedules: other immutable columns still refused (c)', () => {
  it('refuses changing planned_depreciation together with the release', async () => {
    const posted = await seedPosted()
    await storno(posted, posted.entryId, 900)
    await expect(
      getPool().query(
        `UPDATE public.depreciation_schedules
            SET journal_entry_id = NULL, posted_at = NULL, planned_depreciation = 1
          WHERE id = $1`,
        [posted.scheduleId],
      ),
    ).rejects.toMatchObject({ code: '23514' })
  })

  it('refuses a release that keeps posted_at', async () => {
    const posted = await seedPosted()
    await storno(posted, posted.entryId, 900)
    await expect(
      getPool().query(
        `UPDATE public.depreciation_schedules SET journal_entry_id = NULL WHERE id = $1`,
        [posted.scheduleId],
      ),
    ).rejects.toMatchObject({ code: '23514' })
  })

  it('refuses re-pointing a reversed link straight at another voucher', async () => {
    const posted = await seedPosted()
    await storno(posted, posted.entryId, 900)
    const other = await insertDepreciationDraft(posted, 20000)
    await expect(
      getPool().query(
        `UPDATE public.depreciation_schedules SET journal_entry_id = $2 WHERE id = $1`,
        [posted.scheduleId, other],
      ),
    ).rejects.toMatchObject({ code: '23514' })
  })

  it('refuses changing planned_depreciation or the period on a linked row, even after storno', async () => {
    const posted = await seedPosted()
    await storno(posted, posted.entryId, 900)
    await expect(
      getPool().query(
        `UPDATE public.depreciation_schedules SET planned_depreciation = 1 WHERE id = $1`,
        [posted.scheduleId],
      ),
    ).rejects.toMatchObject({ code: '23514' })

    const { rows } = await getPool().query<{ id: string }>(
      `INSERT INTO public.fiscal_periods (user_id, company_id, name, period_start, period_end)
       VALUES ($1, $2, '2027', '2027-01-01', '2027-12-31') RETURNING id`,
      [posted.userId, posted.companyId],
    )
    await expect(
      getPool().query(
        `UPDATE public.depreciation_schedules SET fiscal_period_id = $2 WHERE id = $1`,
        [posted.scheduleId, rows[0].id],
      ),
    ).rejects.toMatchObject({ code: '23514' })

    const row = await schedule(posted.scheduleId)
    expect(row.journal_entry_id).toBe(posted.entryId)
    expect(Number(row.planned_depreciation)).toBe(20000)
  })
})
