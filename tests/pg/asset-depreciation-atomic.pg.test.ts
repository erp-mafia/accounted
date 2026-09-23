import { randomUUID } from 'node:crypto'
import type { PoolClient } from 'pg'
import { describe, expect, it } from 'vitest'
import { getClient, getPool, withUserContext } from './setup'
import { insertAuthUser, seedCompany } from './fixtures'

/**
 * Issue #2779 (migration 20260920190200): the asset register and the ledger
 * must not be able to drift apart.
 *
 * Two gaps, both reproduced on the pre-migration schema before this file was
 * written:
 *   1. assets -> depreciation_schedules is ON DELETE CASCADE and nothing at
 *      the database level refused deleting a schedule row that points at a
 *      verifikat. Deleting the asset removed the posted row and left the
 *      posted voucher with no register row.
 *   2. Posting a planenlig avskrivning committed the voucher and wrote the
 *      schedule link in two statements, so a failure (or a zero-row UPDATE)
 *      in between left a posted voucher with no link.
 *
 * What is pinned here: the BEFORE DELETE guard and its transaction-local
 * gnubok.allow_delete bypass, commit_asset_depreciation as one transaction,
 * delete_never_posted_asset deciding under the same asset row lock, and the
 * two serialising against each other on two real connections.
 *
 * Also pinned, because this migration deliberately leaves it alone: a
 * depreciation voucher stays undeletable through delete_last_voucher. The
 * RESTRICT foreign key refuses at the DELETE, before anything is removed, and
 * a posted row cannot be un-posted by UPDATE to get around the guard.
 */

type Seed = { userId: string; companyId: string; fiscalPeriodId: string }

async function insertAsset(seed: Seed, overrides: { disposed?: boolean } = {}): Promise<string> {
  const assetId = randomUUID()
  await getPool().query(
    `INSERT INTO public.assets (
       id, user_id, company_id, name, category, acquisition_date,
       acquisition_cost, salvage_value, useful_life_months,
       depreciation_method, bas_asset_account, bas_accumulated_account,
       bas_expense_account, disposed_at, disposed_proceeds
     ) VALUES ($1, $2, $3, 'Machine', 'equipment', '2026-01-01',
               100000, 0, 60, 'linear', '1220', '1229', '7832', $4, $5)`,
    [
      assetId,
      seed.userId,
      seed.companyId,
      overrides.disposed ? '2026-06-30' : null,
      overrides.disposed ? 0 : null,
    ],
  )
  return assetId
}

/** A balanced year_end draft, the shape commitAnnualPostings() prepares. */
async function insertDepreciationDraft(
  seed: Seed,
  options: { amount?: number; sourceType?: string; balanced?: boolean } = {},
): Promise<string> {
  const entryId = randomUUID()
  const amount = options.amount ?? 20000
  await getPool().query(
    `INSERT INTO public.journal_entries (
       id, user_id, company_id, fiscal_period_id, voucher_number,
       voucher_series, entry_date, description, source_type, status
     ) VALUES ($1, $2, $3, $4, 0, 'A', '2026-12-31',
               'Planenlig avskrivning 2026: Machine', $5, 'draft')`,
    [entryId, seed.userId, seed.companyId, seed.fiscalPeriodId, options.sourceType ?? 'year_end'],
  )
  await getPool().query(
    `INSERT INTO public.journal_entry_lines
       (journal_entry_id, account_number, debit_amount, credit_amount)
     VALUES ($1, '7832', $2, 0), ($1, '1229', 0, $3)`,
    [entryId, amount, options.balanced === false ? amount - 1 : amount],
  )
  return entryId
}

async function insertUnpostedSchedule(seed: Seed, assetId: string, amount = 20000): Promise<string> {
  const { rows } = await getPool().query<{ id: string }>(
    `INSERT INTO public.depreciation_schedules
       (user_id, company_id, asset_id, fiscal_period_id, planned_depreciation)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [seed.userId, seed.companyId, assetId, seed.fiscalPeriodId, amount],
  )
  return rows[0].id
}

const COMMIT_SQL = `SELECT * FROM public.commit_asset_depreciation(
  $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::numeric, NULL::text, NULL::text
)`

function commitDepreciation(
  runner: { query: PoolClient['query'] },
  seed: Seed,
  assetId: string,
  entryId: string,
  amount = 20000,
) {
  return runner.query<{ voucher_number: number; schedule_id: string }>(COMMIT_SQL, [
    seed.companyId,
    assetId,
    entryId,
    seed.fiscalPeriodId,
    amount,
  ])
}

/** Asset with one planenlig avskrivning posted through the real RPC. */
async function seedPostedDepreciation(): Promise<
  Seed & { assetId: string; entryId: string; scheduleId: string; voucherNumber: number }
> {
  const seed = await seedCompany()
  const assetId = await insertAsset(seed)
  const entryId = await insertDepreciationDraft(seed)
  const { rows } = await commitDepreciation(getPool(), seed, assetId, entryId)
  return {
    ...seed,
    assetId,
    entryId,
    scheduleId: rows[0].schedule_id,
    voucherNumber: rows[0].voucher_number,
  }
}

async function scheduleRows(assetId: string) {
  const { rows } = await getPool().query<{
    id: string
    journal_entry_id: string | null
    posted_at: Date | null
    planned_depreciation: string
  }>(
    `SELECT id, journal_entry_id, posted_at, planned_depreciation
       FROM public.depreciation_schedules WHERE asset_id = $1`,
    [assetId],
  )
  return rows
}

async function entryState(entryId: string) {
  const { rows } = await getPool().query<{ status: string; voucher_number: number }>(
    `SELECT status, voucher_number FROM public.journal_entries WHERE id = $1`,
    [entryId],
  )
  return rows[0] ?? null
}

async function assetExists(assetId: string): Promise<boolean> {
  const { rowCount } = await getPool().query(`SELECT 1 FROM public.assets WHERE id = $1`, [assetId])
  return (rowCount ?? 0) > 0
}

async function lastVoucherNumber(seed: Seed): Promise<number> {
  const { rows } = await getPool().query<{ last_number: number }>(
    `SELECT last_number FROM public.voucher_sequences
      WHERE company_id = $1 AND fiscal_period_id = $2 AND voucher_series = 'A'`,
    [seed.companyId, seed.fiscalPeriodId],
  )
  return rows[0]?.last_number ?? 0
}

/** Poll until the backend is parked on a heavyweight lock: a deterministic
 *  "it is blocked" signal, where a sleep would only be a guess. */
async function waitUntilBlockedOnLock(pid: number, maxAttempts = 150, intervalMs = 20): Promise<void> {
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const { rows } = await getPool().query<{ wait_event_type: string | null }>(
      `SELECT wait_event_type FROM pg_stat_activity WHERE pid = $1`,
      [pid],
    )
    if (rows[0]?.wait_event_type === 'Lock') return
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }
  throw new Error(`Backend ${pid} never blocked on a lock after ${maxAttempts * intervalMs}ms`)
}

async function backendPid(client: PoolClient): Promise<number> {
  const { rows } = await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')
  return rows[0].pid
}

describe('depreciation_schedules: a posted row cannot be deleted', () => {
  it('refuses a direct DELETE of a posted row', async () => {
    const posted = await seedPostedDepreciation()

    await expect(
      getPool().query(`DELETE FROM public.depreciation_schedules WHERE id = $1`, [posted.scheduleId]),
    ).rejects.toMatchObject({ code: '23514' })

    expect(await scheduleRows(posted.assetId)).toHaveLength(1)
  })

  it('refuses the cascade when the asset is deleted: asset, row and voucher all survive', async () => {
    const posted = await seedPostedDepreciation()

    await expect(
      getPool().query(`DELETE FROM public.assets WHERE id = $1`, [posted.assetId]),
    ).rejects.toMatchObject({ code: '23514' })

    expect(await assetExists(posted.assetId)).toBe(true)
    const rows = await scheduleRows(posted.assetId)
    expect(rows).toHaveLength(1)
    expect(rows[0].journal_entry_id).toBe(posted.entryId)
    expect((await entryState(posted.entryId))?.status).toBe('posted')
  })

  it('still lets an unposted draft row go, directly and through the asset cascade', async () => {
    const seed = await seedCompany()
    const direct = await insertAsset(seed)
    const directRow = await insertUnpostedSchedule(seed, direct)
    await getPool().query(`DELETE FROM public.depreciation_schedules WHERE id = $1`, [directRow])
    expect(await scheduleRows(direct)).toHaveLength(0)

    const cascaded = await insertAsset(seed)
    await insertUnpostedSchedule(seed, cascaded)
    await getPool().query(`DELETE FROM public.assets WHERE id = $1`, [cascaded])
    expect(await assetExists(cascaded)).toBe(false)
    expect(await scheduleRows(cascaded)).toHaveLength(0)
  })

  it('lets a teardown through inside the gnubok.allow_delete window, and the flag does not outlive it', async () => {
    const posted = await seedPostedDepreciation()
    const client = await getClient()
    try {
      await client.query('BEGIN')
      await client.query(`SELECT set_config('gnubok.allow_delete', 'true', true)`)
      // The cascade from the asset is the path a tenant teardown takes.
      await client.query(`DELETE FROM public.assets WHERE id = $1`, [posted.assetId])
      const inside = await client.query(
        `SELECT 1 FROM public.depreciation_schedules WHERE asset_id = $1`,
        [posted.assetId],
      )
      expect(inside.rowCount).toBe(0)
      await client.query('ROLLBACK')

      // Transaction-local: the same connection, one statement later, is
      // refused again. A flag that leaked would unlock every later caller
      // that happens to draw this pooled connection.
      await expect(
        client.query(`DELETE FROM public.assets WHERE id = $1`, [posted.assetId]),
      ).rejects.toMatchObject({ code: '23514' })
    } finally {
      client.release()
    }
    expect(await assetExists(posted.assetId)).toBe(true)
  })
})

describe('commit_asset_depreciation: voucher and register link are one transaction', () => {
  it('posts the voucher and links a new schedule row in one call', async () => {
    const seed = await seedCompany()
    const assetId = await insertAsset(seed)
    const entryId = await insertDepreciationDraft(seed)

    const { rows } = await commitDepreciation(getPool(), seed, assetId, entryId)

    expect(rows[0].voucher_number).toBe(1)
    expect(await entryState(entryId)).toEqual({ status: 'posted', voucher_number: 1 })
    const schedules = await scheduleRows(assetId)
    expect(schedules).toHaveLength(1)
    expect(schedules[0].id).toBe(rows[0].schedule_id)
    expect(schedules[0].journal_entry_id).toBe(entryId)
    expect(schedules[0].posted_at).not.toBeNull()
    expect(Number(schedules[0].planned_depreciation)).toBe(20000)
  })

  it('adopts an existing unposted draft row instead of inserting a second one', async () => {
    const seed = await seedCompany()
    const assetId = await insertAsset(seed)
    const draftRowId = await insertUnpostedSchedule(seed, assetId, 19999)
    const entryId = await insertDepreciationDraft(seed)

    const { rows } = await commitDepreciation(getPool(), seed, assetId, entryId)

    expect(rows[0].schedule_id).toBe(draftRowId)
    const schedules = await scheduleRows(assetId)
    expect(schedules).toHaveLength(1)
    expect(schedules[0].journal_entry_id).toBe(entryId)
    // The posted amount wins over the stale proposal the draft row carried.
    expect(Number(schedules[0].planned_depreciation)).toBe(20000)
  })

  it('refuses a second posting for the same asset and period and burns no voucher number', async () => {
    const posted = await seedPostedDepreciation()
    const secondDraft = await insertDepreciationDraft(posted)
    const before = await lastVoucherNumber(posted)

    await expect(
      commitDepreciation(getPool(), posted, posted.assetId, secondDraft),
    ).rejects.toMatchObject({ code: '23505' })

    expect((await entryState(secondDraft))?.status).toBe('draft')
    expect(await lastVoucherNumber(posted)).toBe(before)
    const schedules = await scheduleRows(posted.assetId)
    expect(schedules).toHaveLength(1)
    expect(schedules[0].journal_entry_id).toBe(posted.entryId)
  })

  it('a failure at the link step takes the voucher commit down with it', async () => {
    // The historical window: voucher committed, then the link write fails.
    // Simulated with a trigger scoped to this one asset (pg-real runs files
    // one at a time, and the WHEN clause keeps every other row untouched).
    const seed = await seedCompany()
    const assetId = await insertAsset(seed)
    const entryId = await insertDepreciationDraft(seed)
    const before = await lastVoucherNumber(seed)
    const suffix = assetId.replace(/-/g, '')
    const fn = `pg_test_fail_link_${suffix}`

    await getPool().query(
      `CREATE FUNCTION public.${fn}() RETURNS trigger LANGUAGE plpgsql AS
       $$ BEGIN RAISE EXCEPTION 'simulated link failure' USING ERRCODE = 'P0001'; END $$`,
    )
    await getPool().query(
      `CREATE TRIGGER ${fn} BEFORE INSERT OR UPDATE ON public.depreciation_schedules
       FOR EACH ROW WHEN (NEW.asset_id = '${assetId}'::uuid)
       EXECUTE FUNCTION public.${fn}()`,
    )
    try {
      await expect(commitDepreciation(getPool(), seed, assetId, entryId)).rejects.toThrow(
        /simulated link failure/,
      )
    } finally {
      await getPool().query(`DROP TRIGGER IF EXISTS ${fn} ON public.depreciation_schedules`)
      await getPool().query(`DROP FUNCTION IF EXISTS public.${fn}()`)
    }

    // No posted voucher without its link: the entry is still a draft, the
    // sequence did not move, and there is no schedule row.
    expect(await entryState(entryId)).toEqual({ status: 'draft', voucher_number: 0 })
    expect(await lastVoucherNumber(seed)).toBe(before)
    expect(await scheduleRows(assetId)).toHaveLength(0)

    // And the same draft posts cleanly once the fault is gone.
    const { rows } = await commitDepreciation(getPool(), seed, assetId, entryId)
    expect(rows[0].voucher_number).toBe(before + 1)
  })

  it('a balance failure at COMMIT, after the link is written, still leaves nothing behind', async () => {
    // check_balance_on_post is a constraint trigger, INITIALLY DEFERRED: it
    // fires at COMMIT, later than both the voucher commit and the link write
    // inside the RPC. It is the latest point a failure can occur, so it is
    // the sharpest proof that voucher, link and sequence are one transaction.
    const seed = await seedCompany()
    const assetId = await insertAsset(seed)
    const unbalanced = await insertDepreciationDraft(seed, { balanced: false })
    const before = await lastVoucherNumber(seed)

    // Matched on the message so this cannot pass for an unrelated reason.
    await expect(commitDepreciation(getPool(), seed, assetId, unbalanced)).rejects.toThrow(
      /is not balanced/,
    )

    expect(await entryState(unbalanced)).toEqual({ status: 'draft', voucher_number: 0 })
    expect(await scheduleRows(assetId)).toHaveLength(0)
    expect(await lastVoucherNumber(seed)).toBe(before)
  })

  it('refuses to post into a period locked after the draft was prepared', async () => {
    // Period-lock enforcement is delegated to commit_journal_entry (the lock
    // trigger fires on its draft-to-posted UPDATE). Pinned here because this
    // RPC is now the only route a planenlig avskrivning takes to the books.
    const seed = await seedCompany()
    const assetId = await insertAsset(seed)
    const entryId = await insertDepreciationDraft(seed)
    await getPool().query(`UPDATE public.fiscal_periods SET locked_at = now() WHERE id = $1`, [
      seed.fiscalPeriodId,
    ])

    await expect(commitDepreciation(getPool(), seed, assetId, entryId)).rejects.toThrow(
      /locked\/closed fiscal period/,
    )

    expect(await entryState(entryId)).toEqual({ status: 'draft', voucher_number: 0 })
    expect(await scheduleRows(assetId)).toHaveLength(0)
  })

  it('only posts a year_end draft of this company and period', async () => {
    const seed = await seedCompany()
    const assetId = await insertAsset(seed)
    // 22023 (bad draft: a caller bug) is deliberately NOT the P0002 a missing
    // asset raises (an expected concurrent-delete outcome the engine skips).
    const manualDraft = await insertDepreciationDraft(seed, { sourceType: 'manual' })
    await expect(commitDepreciation(getPool(), seed, assetId, manualDraft)).rejects.toMatchObject({
      code: '22023',
    })

    const other = await seedCompany()
    const foreignDraft = await insertDepreciationDraft(other)
    await expect(commitDepreciation(getPool(), seed, assetId, foreignDraft)).rejects.toMatchObject({
      code: '22023',
    })
    expect((await entryState(foreignDraft))?.status).toBe('draft')
  })

  it('refuses an amount that is not what the draft voucher books', async () => {
    // The RPC is independently callable: the register may not record a
    // figure the ledger does not carry.
    const seed = await seedCompany()
    const assetId = await insertAsset(seed)
    const entryId = await insertDepreciationDraft(seed, { amount: 20000 })
    await expect(
      commitDepreciation(getPool(), seed, assetId, entryId, 12345),
    ).rejects.toMatchObject({ code: '23514' })
    expect((await entryState(entryId))?.status).toBe('draft')
    expect(await scheduleRows(assetId)).toHaveLength(0)
  })

  it('rejects a non-positive amount before touching anything', async () => {
    const seed = await seedCompany()
    const assetId = await insertAsset(seed)
    const entryId = await insertDepreciationDraft(seed)
    await expect(commitDepreciation(getPool(), seed, assetId, entryId, 0)).rejects.toMatchObject({
      code: '23514',
    })
    expect((await entryState(entryId))?.status).toBe('draft')
  })

  it('refuses a caller who is not a member of the company', async () => {
    const seed = await seedCompany()
    const assetId = await insertAsset(seed)
    const entryId = await insertDepreciationDraft(seed)
    const outsider = await insertAuthUser()

    await expect(
      withUserContext(outsider, (client) => commitDepreciation(client, seed, assetId, entryId)),
    ).rejects.toMatchObject({ code: '42501' })
    expect((await entryState(entryId))?.status).toBe('draft')
  })
})

describe('delete_never_posted_asset: the rule is decided under the asset row lock', () => {
  const DELETE_SQL = `SELECT public.delete_never_posted_asset($1::uuid, $2::uuid) AS outcome`

  it('deletes a never-posted asset together with its unposted drafts', async () => {
    const seed = await seedCompany()
    const assetId = await insertAsset(seed)
    await insertUnpostedSchedule(seed, assetId)

    const { rows } = await getPool().query(DELETE_SQL, [seed.companyId, assetId])

    expect(rows[0].outcome).toBe('deleted')
    expect(await assetExists(assetId)).toBe(false)
    expect(await scheduleRows(assetId)).toHaveLength(0)
  })

  it('answers depreciation_posted, disposed and not_found without deleting anything', async () => {
    const posted = await seedPostedDepreciation()
    const a = await getPool().query(DELETE_SQL, [posted.companyId, posted.assetId])
    expect(a.rows[0].outcome).toBe('depreciation_posted')
    expect(await assetExists(posted.assetId)).toBe(true)
    expect(await scheduleRows(posted.assetId)).toHaveLength(1)

    const seed = await seedCompany()
    const disposedId = await insertAsset(seed, { disposed: true })
    const b = await getPool().query(DELETE_SQL, [seed.companyId, disposedId])
    expect(b.rows[0].outcome).toBe('disposed')
    expect(await assetExists(disposedId)).toBe(true)

    // Right asset, wrong company: indistinguishable from a missing row.
    const c = await getPool().query(DELETE_SQL, [seed.companyId, posted.assetId])
    expect(c.rows[0].outcome).toBe('not_found')
    expect(await assetExists(posted.assetId)).toBe(true)
  })

  it('runs as the caller: a member deletes, an outsider sees nothing to delete', async () => {
    const seed = await seedCompany()
    const assetId = await insertAsset(seed)
    const outsider = await insertAuthUser()

    const asOutsider = await withUserContext(outsider, (client) =>
      client.query(DELETE_SQL, [seed.companyId, assetId]),
    )
    expect(asOutsider.rows[0].outcome).toBe('not_found')
    expect(await assetExists(assetId)).toBe(true)

    // withUserContext rolls back, so assert the outcome from inside it.
    const asMember = await withUserContext(seed.userId, async (client) => {
      const result = await client.query(DELETE_SQL, [seed.companyId, assetId])
      const left = await client.query(`SELECT 1 FROM public.assets WHERE id = $1`, [assetId])
      return { outcome: result.rows[0].outcome, left: left.rowCount }
    })
    expect(asMember).toEqual({ outcome: 'deleted', left: 0 })
  })
})

describe('posting and deleting the same asset serialise on its row lock', () => {
  const DELETE_SQL = `SELECT public.delete_never_posted_asset($1::uuid, $2::uuid) AS outcome`

  it('poster first: the delete waits, then refuses because the row is now posted', async () => {
    const seed = await seedCompany()
    const assetId = await insertAsset(seed)
    const entryId = await insertDepreciationDraft(seed)
    const poster = await getClient()
    const deleter = await getClient()
    try {
      await poster.query('BEGIN')
      await commitDepreciation(poster, seed, assetId, entryId)
      // Posted but NOT committed: invisible to everyone else. This is the
      // exact instant the old check-then-delete read "no posted rows".

      const deleterPid = await backendPid(deleter)
      const pendingDelete = deleter.query(DELETE_SQL, [seed.companyId, assetId])
      await waitUntilBlockedOnLock(deleterPid)

      await poster.query('COMMIT')
      const { rows } = await pendingDelete
      expect(rows[0].outcome).toBe('depreciation_posted')
    } finally {
      await poster.query('ROLLBACK').catch(() => {})
      poster.release()
      deleter.release()
    }

    expect(await assetExists(assetId)).toBe(true)
    const schedules = await scheduleRows(assetId)
    expect(schedules).toHaveLength(1)
    expect(schedules[0].journal_entry_id).toBe(entryId)
    expect((await entryState(entryId))?.status).toBe('posted')
  })

  it('deleter first: the posting waits, then finds no asset and posts no voucher', async () => {
    const seed = await seedCompany()
    const assetId = await insertAsset(seed)
    const entryId = await insertDepreciationDraft(seed)
    const before = await lastVoucherNumber(seed)
    const poster = await getClient()
    const deleter = await getClient()
    try {
      await deleter.query('BEGIN')
      const deleted = await deleter.query(DELETE_SQL, [seed.companyId, assetId])
      expect(deleted.rows[0].outcome).toBe('deleted')

      const posterPid = await backendPid(poster)
      const pendingPost = commitDepreciation(poster, seed, assetId, entryId)
      // Attach the rejection handler before awaiting anything else, so the
      // expected failure can never surface as an unhandled rejection.
      const postOutcome = expect(pendingPost).rejects.toMatchObject({ code: 'P0002' })
      await waitUntilBlockedOnLock(posterPid)

      await deleter.query('COMMIT')
      await postOutcome
    } finally {
      await deleter.query('ROLLBACK').catch(() => {})
      poster.release()
      deleter.release()
    }

    // No stray voucher: the draft never posted and no number was burned.
    expect(await assetExists(assetId)).toBe(false)
    expect((await entryState(entryId))?.status).toBe('draft')
    expect(await lastVoucherNumber(seed)).toBe(before)
  })
})

describe('a depreciation voucher stays undeletable, and the guard cannot be sidestepped', () => {
  it('delete_last_voucher is refused by the foreign key, and nothing in the series changes', async () => {
    // Unchanged by this migration on purpose. The refusal is the RESTRICT
    // foreign key firing at the DELETE, so nothing has been removed when it
    // raises. lib/errors/get-error-message.ts maps this exact constraint to a
    // Swedish message; if the constraint is ever renamed, both must change.
    const posted = await seedPostedDepreciation()
    const sequenceBefore = await lastVoucherNumber(posted)

    const err = await withUserContext(posted.userId, (client) =>
      client.query(`SELECT public.delete_last_voucher($1::uuid, $2::uuid)`, [
        posted.companyId,
        posted.entryId,
      ]),
    ).catch((e) => e)

    expect(err).toMatchObject({
      code: '23503',
      constraint: 'depreciation_schedules_journal_entry_id_fkey',
    })
    expect(String(err.message)).toContain('"depreciation_schedules_journal_entry_id_fkey"')

    expect(await entryState(posted.entryId)).toEqual({
      status: 'posted',
      voucher_number: posted.voucherNumber,
    })
    const rows = await scheduleRows(posted.assetId)
    expect(rows).toHaveLength(1)
    expect(rows[0].journal_entry_id).toBe(posted.entryId)
    expect(rows[0].posted_at).not.toBeNull()
    expect(await lastVoucherNumber(posted)).toBe(sequenceBefore)
    const audit = await getPool().query(
      `SELECT 1 FROM public.audit_log
        WHERE record_id = $1 AND table_name = 'journal_entries' AND action = 'DELETE'`,
      [posted.entryId],
    )
    expect(audit.rowCount).toBe(0)
  })

  it('a posted row cannot be un-posted by UPDATE to get around the delete guard', async () => {
    // Null the link, then delete: that would sidestep the BEFORE DELETE guard.
    // enforce_depreciation_schedule_immutability (20260516120000, untouched
    // here) is what refuses the first step.
    const posted = await seedPostedDepreciation()
    await expect(
      getPool().query(
        `UPDATE public.depreciation_schedules
            SET journal_entry_id = NULL, posted_at = NULL WHERE id = $1`,
        [posted.scheduleId],
      ),
    ).rejects.toMatchObject({ code: '23514' })
    expect((await scheduleRows(posted.assetId))[0].journal_entry_id).toBe(posted.entryId)
  })

  it('the allow_delete window makes a posted row neither editable nor unlinkable', async () => {
    // The flag bypasses the DELETE guard for tenant teardown and nothing else.
    const posted = await seedPostedDepreciation()
    const client = await getClient()
    try {
      await client.query('BEGIN')
      await client.query(`SELECT set_config('gnubok.allow_delete', 'true', true)`)
      await client.query('SAVEPOINT a')
      await expect(
        client.query(
          `UPDATE public.depreciation_schedules SET planned_depreciation = 1 WHERE id = $1`,
          [posted.scheduleId],
        ),
      ).rejects.toMatchObject({ code: '23514' })
      await client.query('ROLLBACK TO SAVEPOINT a')
      await expect(
        client.query(
          `UPDATE public.depreciation_schedules
              SET journal_entry_id = NULL, posted_at = NULL WHERE id = $1`,
          [posted.scheduleId],
        ),
      ).rejects.toMatchObject({ code: '23514' })
    } finally {
      await client.query('ROLLBACK').catch(() => {})
      client.release()
    }
    const row = (await scheduleRows(posted.assetId))[0]
    expect(row.journal_entry_id).toBe(posted.entryId)
    expect(Number(row.planned_depreciation)).toBe(20000)
  })
})
