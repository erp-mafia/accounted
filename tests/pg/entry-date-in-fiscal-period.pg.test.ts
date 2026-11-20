import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import type { PoolClient } from 'pg'
import {
  insertBalancedLines,
  insertDraftJournalEntry,
  insertFiscalPeriod,
  seedCompany,
  setActiveCompany,
} from '@/tests/pg/fixtures'
import { getPool, runAsServiceRole, withUserContext } from '@/tests/pg/setup'

/**
 * Covers 20261024140200_entry_date_inside_fiscal_period: a journal entry that
 * is not cancelled is dated inside its fiscal year (insert, re-date, period
 * move, draft -> posted), except a storno that mirrors its original's date and
 * period; and new fiscal year dates may not leave an entry that is inside the
 * year today outside it. The year in every test is 2026-01-01..2026-12-31.
 */

const OUTSIDE = /ENTRY_DATE_OUTSIDE_FISCAL_PERIOD/
const STRANDED = /FISCAL_PERIOD_DATES_BLOCKED/

const COMMIT_SQL = `SELECT * FROM public.commit_journal_entry($1, $2, $3, $4, $5, $6)`

async function seed() {
  const company = await seedCompany()
  await setActiveCompany(company.userId, company.companyId)
  return company
}

async function insertEntry(
  client: PoolClient,
  params: {
    userId: string
    companyId: string
    fiscalPeriodId: string
    entryDate: string
    status?: 'draft' | 'posted'
    reversesId?: string | null
    sourceType?: string
  },
): Promise<string> {
  const id = randomUUID()
  await client.query(
    `INSERT INTO public.journal_entries
       (id, user_id, company_id, fiscal_period_id, voucher_number, voucher_series,
        entry_date, description, source_type, status, reverses_id)
     VALUES ($1, $2, $3, $4, 0, 'A', $5, 'Test entry', $6, $7, $8)`,
    [
      id,
      params.userId,
      params.companyId,
      params.fiscalPeriodId,
      params.entryDate,
      params.sourceType ?? 'manual',
      params.status ?? 'draft',
      params.reversesId ?? null,
    ],
  )
  return id
}

/**
 * A misdated row as prod still holds 710 of them: written with the guard off,
 * the way the fixed writers wrote them before it existed. Posted entries get
 * balanced lines and a voucher number.
 */
async function insertLegacyEntry(params: {
  userId: string
  companyId: string
  fiscalPeriodId: string
  entryDate: string
  status: 'draft' | 'posted'
  voucherNumber?: number
}): Promise<string> {
  const client = await getPool().connect()
  try {
    await client.query('BEGIN')
    await client.query(
      'ALTER TABLE public.journal_entries DISABLE TRIGGER zz_enforce_entry_date_in_fiscal_period',
    )
    const id = await insertEntry(client, { ...params, status: 'draft' })
    await client.query(
      `INSERT INTO public.journal_entry_lines (journal_entry_id, account_number, debit_amount, credit_amount)
       VALUES ($1, '1930', 500, 0), ($1, '3001', 0, 500)`,
      [id],
    )
    if (params.status === 'posted') {
      await client.query(
        `UPDATE public.journal_entries SET status = 'posted', voucher_number = $2 WHERE id = $1`,
        [id, params.voucherNumber ?? 900],
      )
      // Run the deferred balance check now: ALTER TABLE refuses a table
      // with pending trigger events.
      await client.query('SET CONSTRAINTS ALL IMMEDIATE')
    }
    await client.query(
      'ALTER TABLE public.journal_entries ENABLE TRIGGER zz_enforce_entry_date_in_fiscal_period',
    )
    await client.query('COMMIT')
    return id
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
}

/** A storno draft of `originalId` with its lines mirrored, on the superuser connection. */
async function insertStornoDraft(params: {
  userId: string
  companyId: string
  fiscalPeriodId: string
  entryDate: string
  originalId: string
}): Promise<string> {
  const client = await getPool().connect()
  try {
    const id = await insertEntry(client, {
      ...params,
      reversesId: params.originalId,
      sourceType: 'storno',
    })
    await client.query(
      `INSERT INTO public.journal_entry_lines (journal_entry_id, account_number, debit_amount, credit_amount)
       SELECT $1, account_number, credit_amount, debit_amount
         FROM public.journal_entry_lines WHERE journal_entry_id = $2`,
      [id, params.originalId],
    )
    return id
  } finally {
    client.release()
  }
}

async function statusOf(entryId: string): Promise<string> {
  const { rows } = await getPool().query<{ status: string }>(
    'SELECT status FROM public.journal_entries WHERE id = $1',
    [entryId],
  )
  return rows[0].status
}

describe('journal entries stay inside their fiscal year', () => {
  it('a member cannot save a draft dated outside its year', async () => {
    const { userId, companyId, fiscalPeriodId } = await seed()

    await expect(
      withUserContext(userId, (client) =>
        insertEntry(client, { userId, companyId, fiscalPeriodId, entryDate: '2025-12-31' }),
      ),
    ).rejects.toMatchObject({ code: '23514', message: expect.stringMatching(OUTSIDE) })
  })

  it('the service role cannot insert a posted entry dated outside its year', async () => {
    const { userId, companyId, fiscalPeriodId } = await seed()

    await expect(
      runAsServiceRole((client) =>
        insertEntry(client, {
          userId,
          companyId,
          fiscalPeriodId,
          entryDate: '2027-01-02',
          status: 'posted',
        }),
      ),
    ).rejects.toThrow(OUTSIDE)
  })

  it('names the date and the year in Swedish', async () => {
    const { userId, companyId, fiscalPeriodId } = await seed()

    await expect(
      withUserContext(userId, (client) =>
        insertEntry(client, { userId, companyId, fiscalPeriodId, entryDate: '2025-12-31' }),
      ),
    ).rejects.toThrow(
      'ENTRY_DATE_OUTSIDE_FISCAL_PERIOD: verifikationsdatumet 2025-12-31 ligger utanför räkenskapsåret 2026 (2026-01-01 till 2026-12-31)',
    )
  })

  it('a draft can be neither re-dated outside its year nor moved to a year that does not hold its date', async () => {
    const { userId, companyId, fiscalPeriodId } = await seed()
    const previousYear = await insertFiscalPeriod({
      userId,
      companyId,
      name: '2025',
      periodStart: '2025-01-01',
      periodEnd: '2025-12-31',
    })
    const draftId = await insertDraftJournalEntry({ userId, companyId, fiscalPeriodId })

    await expect(
      withUserContext(userId, (client) =>
        client.query(`UPDATE public.journal_entries SET entry_date = '2027-01-05' WHERE id = $1`, [draftId]),
      ),
    ).rejects.toThrow(OUTSIDE)
    await expect(
      withUserContext(userId, (client) =>
        client.query('UPDATE public.journal_entries SET fiscal_period_id = $2 WHERE id = $1', [
          draftId,
          previousYear,
        ]),
      ),
    ).rejects.toThrow(OUTSIDE)

    // Date and year moved together stay allowed.
    await withUserContext(userId, async (client) => {
      await client.query(
        `UPDATE public.journal_entries SET entry_date = '2025-11-30', fiscal_period_id = $2 WHERE id = $1`,
        [draftId, previousYear],
      )
    })
  })

  it('a misdated draft from before the rule cannot be posted', async () => {
    const { userId, companyId, fiscalPeriodId } = await seed()
    const draftId = await insertLegacyEntry({
      userId,
      companyId,
      fiscalPeriodId,
      entryDate: '2025-12-20',
      status: 'draft',
    })

    await expect(
      withUserContext(userId, (client) =>
        client.query(COMMIT_SQL, [companyId, draftId, 'user_accept', null, 'user', 'Test']),
      ),
    ).rejects.toThrow(OUTSIDE)
    expect(await statusOf(draftId)).toBe('draft')
  })

  it('in-year drafts are saved, re-dated and posted as before', async () => {
    const { userId, companyId, fiscalPeriodId } = await seed()

    const voucherNumber = await withUserContext(userId, async (client) => {
      const id = await insertEntry(client, { userId, companyId, fiscalPeriodId, entryDate: '2026-01-01' })
      await client.query(
        `INSERT INTO public.journal_entry_lines (journal_entry_id, account_number, debit_amount, credit_amount)
         VALUES ($1, '1930', 750, 0), ($1, '3001', 0, 750)`,
        [id],
      )
      await client.query(`UPDATE public.journal_entries SET entry_date = '2026-12-31' WHERE id = $1`, [id])
      const { rows } = await client.query<{ voucher_number: number }>(COMMIT_SQL, [
        companyId,
        id,
        'user_accept',
        null,
        'user',
        'Test',
      ])
      return rows[0].voucher_number
    })

    expect(voucherNumber).toBeGreaterThan(0)
  })

  it('a misdated original is reversed by a storno that mirrors its date and year', async () => {
    const { userId, companyId, fiscalPeriodId } = await seed()
    const originalId = await insertLegacyEntry({
      userId,
      companyId,
      fiscalPeriodId,
      entryDate: '2025-12-20',
      status: 'posted',
    })
    const stornoId = await insertStornoDraft({
      userId,
      companyId,
      fiscalPeriodId,
      entryDate: '2025-12-20',
      originalId,
    })

    await runAsServiceRole(async (client) => {
      await client.query(COMMIT_SQL, [companyId, stornoId, 'api_key', null, 'system', 'Test'])
      // The original's posted -> reversed flip is not a date write.
      await client.query(
        `UPDATE public.journal_entries SET status = 'reversed', reversed_by_id = $2 WHERE id = $1`,
        [originalId, stornoId],
      )
    })

    expect(await statusOf(stornoId)).toBe('posted')
    expect(await statusOf(originalId)).toBe('reversed')
  })

  it('a storno dated outside the year on another day than its original is refused', async () => {
    const { userId, companyId, fiscalPeriodId } = await seed()
    const originalId = await insertLegacyEntry({
      userId,
      companyId,
      fiscalPeriodId,
      entryDate: '2025-12-20',
      status: 'posted',
    })

    await expect(
      runAsServiceRole((client) =>
        insertEntry(client, {
          userId,
          companyId,
          fiscalPeriodId,
          entryDate: '2025-11-30',
          reversesId: originalId,
          sourceType: 'storno',
        }),
      ),
    ).rejects.toThrow(OUTSIDE)
  })

  it('a cancelled draft is left alone', async () => {
    const { userId, companyId, fiscalPeriodId } = await seed()
    const draftId = await insertLegacyEntry({
      userId,
      companyId,
      fiscalPeriodId,
      entryDate: '2025-12-20',
      status: 'draft',
    })

    await withUserContext(userId, async (client) => {
      await client.query(`UPDATE public.journal_entries SET status = 'cancelled' WHERE id = $1`, [draftId])
    })
  })
})

describe('fiscal year dates keep their entries inside', () => {
  it('a direct update that would leave an entry outside the year is refused', async () => {
    const { userId, companyId, fiscalPeriodId } = await seed()
    const draftId = await insertDraftJournalEntry({
      userId,
      companyId,
      fiscalPeriodId,
      entryDate: '2026-06-01',
    })
    await insertBalancedLines(draftId)

    await expect(
      withUserContext(userId, (client) =>
        client.query(`UPDATE public.fiscal_periods SET period_end = '2026-05-31' WHERE id = $1`, [
          fiscalPeriodId,
        ]),
      ),
    ).rejects.toMatchObject({ code: '23514', message: expect.stringMatching(STRANDED) })
  })

  it('dates that keep every entry inside are accepted', async () => {
    const { userId, companyId, fiscalPeriodId } = await seed()
    await insertDraftJournalEntry({ userId, companyId, fiscalPeriodId, entryDate: '2026-06-01' })

    await withUserContext(userId, async (client) => {
      await client.query(
        `UPDATE public.fiscal_periods SET period_start = '2026-02-01', period_end = '2027-03-31' WHERE id = $1`,
        [fiscalPeriodId],
      )
    })
  })

  it('an entry already outside the year does not block an unrelated change, one inside does', async () => {
    const { userId, companyId, fiscalPeriodId } = await seed()
    await insertLegacyEntry({
      userId,
      companyId,
      fiscalPeriodId,
      entryDate: '2025-12-15',
      status: 'posted',
    })

    await withUserContext(userId, async (client) => {
      await client.query(`UPDATE public.fiscal_periods SET period_start = '2026-02-01' WHERE id = $1`, [
        fiscalPeriodId,
      ])
    })

    await insertDraftJournalEntry({ userId, companyId, fiscalPeriodId, entryDate: '2026-01-15' })
    await expect(
      withUserContext(userId, (client) =>
        client.query(`UPDATE public.fiscal_periods SET period_start = '2026-02-01' WHERE id = $1`, [
          fiscalPeriodId,
        ]),
      ),
    ).rejects.toThrow(STRANDED)
  })
})
