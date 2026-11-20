import type { PoolClient } from 'pg'
import { describe, expect, it } from 'vitest'
import { getPool, runAsServiceRole, withUserContext } from './setup'
import {
  insertBalancedLines,
  insertDraftJournalEntry,
  insertFiscalPeriod,
  insertPostedJournalEntry,
  seedCompany,
  setActiveCompany,
  withSwedishToday,
} from './fixtures'

/**
 * The fiscal year's close and lock, and the voucher counter, change only
 * through their functions (issue #199, audit LED-2; migration
 * 20261109153600_fiscal_period_close_lock_and_voucher_counter_owner).
 *
 * A direct write from the Data API (authenticated, service_role) keeps the
 * transitions the app makes with a plain UPDATE: lock, unlock, link the
 * bokslutsverifikat, close with it, klarmarkera and its undo. Everything else
 * is refused, above all reopening a year closed with a bokslut and any write
 * to voucher_sequences. SECURITY DEFINER functions run as the owner and keep
 * working: commit_journal_entry here; the owner reopen
 * (reopen_closed_fiscal_year, then the detach as the authenticated owner) in
 * fiscal-year-reopen.pg.test.ts; the lock route in
 * event-log-first-use-period-lock.pg.test.ts; the whole year-end run as
 * service_role in posting-parity-year-end.pg.test.ts.
 */

const STATE = /FISCAL_PERIOD_STATE_GUARDED/
const COUNTER = /VOUCHER_SEQUENCE_GUARDED/

type PgError = { code?: string; message: string }

/** One statement that must be refused, without aborting the caller's transaction. */
async function refused(client: PoolClient, sql: string, params: unknown[]): Promise<PgError> {
  await client.query('SAVEPOINT refused')
  let error: PgError | null = null
  try {
    await client.query(sql, params)
  } catch (err) {
    error = err as PgError
  }
  await client.query('ROLLBACK TO SAVEPOINT refused')
  if (!error) throw new Error(`expected a refusal: ${sql}`)
  return error
}

async function expectRefused(client: PoolClient, sql: string, params: unknown[], pattern: RegExp) {
  const error = await refused(client, sql, params)
  expect(error.code).toBe('42501')
  expect(error.message).toMatch(pattern)
}

async function updated(client: PoolClient, sql: string, params: unknown[]): Promise<void> {
  const result = await client.query(sql, params)
  expect(result.rowCount).toBe(1)
}

const LOCK = `UPDATE public.fiscal_periods SET locked_at = now() WHERE id = $1`
const UNLOCK = `UPDATE public.fiscal_periods SET locked_at = NULL WHERE id = $1`
const LINK = `UPDATE public.fiscal_periods SET closing_entry_id = $2 WHERE id = $1`
const CLOSE = `UPDATE public.fiscal_periods SET is_closed = true, closed_at = now() WHERE id = $1`
const REOPEN = `UPDATE public.fiscal_periods SET is_closed = false, closed_at = NULL, locked_at = NULL WHERE id = $1`
// markPeriodClosedExternally and reopenExternallyClosedPeriod, as the app sends them.
const KLARMARKERA = `UPDATE public.fiscal_periods
    SET is_closed = true, closed_at = now(), closed_externally = true, locked_at = coalesce(locked_at, now())
  WHERE id = $1`
const UNDO_KLARMARKERA = `UPDATE public.fiscal_periods
    SET is_closed = false, closed_at = NULL, closed_externally = false, locked_at = NULL
  WHERE id = $1`

/** An owner, the open 2026 year, and 2025 with its posted bokslutsverifikat (not yet linked). */
async function seed() {
  const s = await seedCompany()
  await setActiveCompany(s.userId, s.companyId)
  const year2025 = await insertFiscalPeriod({
    userId: s.userId, companyId: s.companyId, name: '2025', periodStart: '2025-01-01', periodEnd: '2025-12-31',
  })
  const bokslut = await insertPostedJournalEntry({
    userId: s.userId, companyId: s.companyId, fiscalPeriodId: year2025, entryDate: '2025-12-31',
    description: 'Årsbokslut 2025', sourceType: 'year_end', voucherNumber: 9001,
    lines: [
      { accountNumber: '3001', debitAmount: 1000, creditAmount: 0 },
      { accountNumber: '2099', debitAmount: 0, creditAmount: 1000 },
    ],
  })
  return { ...s, year2026: s.fiscalPeriodId, year2025, bokslut }
}

async function closeWithBokslut(periodId: string, bokslut: string): Promise<void> {
  // Seeding on the superuser connection, as the year-end run leaves it.
  await getPool().query(
    `UPDATE public.fiscal_periods
        SET closing_entry_id = $2, locked_at = now(), is_closed = true, closed_at = now()
      WHERE id = $1`,
    [periodId, bokslut],
  )
}

async function periodState(periodId: string) {
  const { rows } = await getPool().query(
    `SELECT is_closed, locked_at IS NOT NULL AS locked, closed_at IS NOT NULL AS has_closed_at,
            closing_entry_id, closed_externally
       FROM public.fiscal_periods WHERE id = $1`,
    [periodId],
  )
  return rows[0]
}

describe('fiscal_periods: the close and lock change only as the app changes them', () => {
  it('lets the year-end run link its bokslut, lock and close, then nothing about the close moves by hand', async () => {
    const s = await seed()
    await withUserContext(s.userId, async (client) => {
      await updated(client, LINK, [s.year2025, s.bokslut])
      await updated(client, LOCK, [s.year2025])
      await updated(client, CLOSE, [s.year2025])

      await expectRefused(client, REOPEN, [s.year2025], /reopen_closed_fiscal_year/)
      await expectRefused(client, UNDO_KLARMARKERA, [s.year2025], STATE)
      await expectRefused(client, UNLOCK, [s.year2025], STATE)
      await expectRefused(
        client, `UPDATE public.fiscal_periods SET closed_at = now() - interval '1 day' WHERE id = $1`, [s.year2025], STATE,
      )
      await expectRefused(
        client, `UPDATE public.fiscal_periods SET closed_externally = true WHERE id = $1`, [s.year2025], STATE,
      )
    })
  })

  it('refuses a close without the bokslut, an unlocked close and a closing entry that is not the year\'s bokslut', async () => {
    const s = await seed()
    const manual = await insertPostedJournalEntry({
      userId: s.userId, companyId: s.companyId, fiscalPeriodId: s.year2025, entryDate: '2025-06-30',
      sourceType: 'manual', voucherNumber: 1,
    })
    await withUserContext(s.userId, async (client) => {
      await expectRefused(client, LINK, [s.year2025, manual], STATE)
      await expectRefused(client, LINK, [s.year2026, s.bokslut], STATE)

      await updated(client, LOCK, [s.year2025])
      await expectRefused(client, CLOSE, [s.year2025], STATE)
      // Klarmarkera is for a year without a bokslut here.
      await updated(client, LINK, [s.year2025, s.bokslut])
      await expectRefused(client, KLARMARKERA, [s.year2025], STATE)

      await updated(client, UNLOCK, [s.year2025])
      await expectRefused(client, CLOSE, [s.year2025], STATE)
    })
    expect(await periodState(s.year2025)).toMatchObject({ is_closed: false, locked: false, closing_entry_id: null })
  })

  it('locks and unlocks an open year, but never rewrites the lock time', async () => {
    const s = await seed()
    await withUserContext(s.userId, async (client) => {
      await updated(client, LOCK, [s.year2026])
      await expectRefused(
        client, `UPDATE public.fiscal_periods SET locked_at = now() - interval '1 day' WHERE id = $1`, [s.year2026], STATE,
      )
      await expectRefused(client, `UPDATE public.fiscal_periods SET closed_at = now() WHERE id = $1`, [s.year2026], STATE)
      await updated(client, UNLOCK, [s.year2026])
    })
  })

  it('klarmarkerar an ended migrated year and undoes it, but not a year that is still running', async () => {
    const s = await seed()
    const migrated = await insertFiscalPeriod({
      userId: s.userId, companyId: s.companyId, name: '2024', periodStart: '2024-01-01', periodEnd: '2024-12-31',
    })
    await withSwedishToday('2025-02-15', () =>
      withUserContext(s.userId, async (client) => {
        await updated(client, KLARMARKERA, [migrated])
        expect(await client.query(`SELECT is_closed, closed_externally FROM public.fiscal_periods WHERE id = $1`, [migrated]))
          .toMatchObject({ rows: [{ is_closed: true, closed_externally: true }] })
        await updated(client, UNDO_KLARMARKERA, [migrated])
      }),
    )
    await withSwedishToday('2024-12-31', () =>
      withUserContext(s.userId, async (client) => {
        await expectRefused(client, KLARMARKERA, [migrated], STATE)
      }),
    )
  })

  it('starts a new fiscal period open, unlocked and without a closing entry', async () => {
    const s = await seed()
    const insert = (columns: string, values: string) =>
      `INSERT INTO public.fiscal_periods (user_id, company_id, name, period_start, period_end${columns})
       VALUES ($1, $2, '2027', '2027-01-01', '2027-12-31'${values})`
    await withUserContext(s.userId, async (client) => {
      await expectRefused(client, insert(', is_closed, closed_at', ', true, now()'), [s.userId, s.companyId], STATE)
      await expectRefused(client, insert(', locked_at', ', now()'), [s.userId, s.companyId], STATE)
      await expectRefused(client, insert(', closed_externally', ', true'), [s.userId, s.companyId], STATE)
      await updated(client, insert('', ''), [s.userId, s.companyId])
    })
  })

  it('judges the service role the same, except support\'s administrative undo of a bokslut', async () => {
    const s = await seed()
    await expect(runAsServiceRole((client) => client.query(CLOSE, [s.year2026]))).rejects.toThrow(STATE)

    await closeWithBokslut(s.year2025, s.bokslut)
    await withUserContext(s.userId, (client) => expectRefused(client, REOPEN, [s.year2025], STATE))
    expect(await periodState(s.year2025)).toMatchObject({ is_closed: true, locked: true })

    // scripts/undo-year-end-closing.ts: opens and unlocks, keeps the closing
    // entry until its storno is posted.
    const reopened = await runAsServiceRole((client) => client.query(REOPEN, [s.year2025]))
    expect(reopened.rowCount).toBe(1)
    expect(await periodState(s.year2025)).toMatchObject({
      is_closed: false, locked: false, has_closed_at: false, closing_entry_id: s.bokslut,
    })
  })
})

describe('voucher_sequences: only the numbering functions write the counter', () => {
  const COUNTER_ROW = `company_id = $1 AND fiscal_period_id = $2 AND voucher_series = 'A'`

  async function lastNumber(companyId: string, periodId: string): Promise<number | null> {
    const { rows } = await getPool().query<{ last_number: number }>(
      `SELECT last_number FROM public.voucher_sequences WHERE ${COUNTER_ROW}`, [companyId, periodId],
    )
    return rows[0]?.last_number ?? null
  }

  it('refuses a direct rewind, skip ahead or new series, and numbers on through commit_journal_entry', async () => {
    const s = await seed()
    await getPool().query(
      `INSERT INTO public.voucher_sequences (user_id, company_id, fiscal_period_id, voucher_series, last_number)
       VALUES ($1, $2, $3, 'A', 3)`,
      [s.userId, s.companyId, s.year2026],
    )
    const draft = await insertDraftJournalEntry({ userId: s.userId, companyId: s.companyId, fiscalPeriodId: s.year2026 })
    await insertBalancedLines(draft)

    await withUserContext(s.userId, async (client) => {
      await expectRefused(
        client, `UPDATE public.voucher_sequences SET last_number = 1 WHERE ${COUNTER_ROW}`, [s.companyId, s.year2026], COUNTER,
      )
      await expectRefused(
        client, `UPDATE public.voucher_sequences SET last_number = 500 WHERE ${COUNTER_ROW}`, [s.companyId, s.year2026], COUNTER,
      )
      await expectRefused(
        client,
        `INSERT INTO public.voucher_sequences (user_id, company_id, fiscal_period_id, voucher_series, last_number)
         VALUES ($1, $2, $3, 'B', 100)`,
        [s.userId, s.companyId, s.year2026],
        COUNTER,
      )

      const committed = await client.query<{ voucher_number: number }>(
        `SELECT * FROM public.commit_journal_entry($1, $2, $3, $4, $5, $6)`,
        [s.companyId, draft, 'user_accept', null, 'user', 'Test User'],
      )
      expect(Number(committed.rows[0].voucher_number)).toBe(4)
      const { rows } = await client.query<{ last_number: number }>(
        `SELECT last_number FROM public.voucher_sequences WHERE ${COUNTER_ROW}`, [s.companyId, s.year2026],
      )
      expect(rows[0].last_number).toBe(4)
    })

    await expect(
      runAsServiceRole((client) =>
        client.query(`UPDATE public.voucher_sequences SET last_number = 1 WHERE ${COUNTER_ROW}`, [s.companyId, s.year2026]),
      ),
    ).rejects.toThrow(COUNTER)
    await expect(
      runAsServiceRole((client) =>
        client.query(`DELETE FROM public.voucher_sequences WHERE ${COUNTER_ROW}`, [s.companyId, s.year2026]),
      ),
    ).rejects.toThrow(COUNTER)

    // withUserContext rolled the commit back; the direct writes never landed.
    expect(await lastNumber(s.companyId, s.year2026)).toBe(3)
  })
})
