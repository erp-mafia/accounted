import { randomBytes, randomUUID } from 'node:crypto'
import { beforeAll, describe, expect, it } from 'vitest'
import {
  insertAuthUser,
  insertCompanyMember,
  insertDraftJournalEntry,
  insertPostedJournalEntry,
  seedCompany,
} from '@/tests/pg/fixtures'
import { getPool, runAsServiceRole, withUserContext } from '@/tests/pg/setup'

/**
 * pg-real coverage for the POS sales migrations:
 *   - 20261004120000_pos_sales.sql: members read, never write; the connection
 *     handle is withheld from members; one live connection per venue; one row
 *     per business day; a booked day is frozen and its voucher link holds;
 *   - 20261004120100_journal_source_type_pos_daily_sales.sql: the source type
 *     and the one-live-voucher-per-day index the booking race relies on.
 * The needs-doc list (20261004120300) is probed per source type by
 * document-surfaces-unification.pg.test.ts against NEEDS_DOC_SOURCE_TYPES.
 */

const handle = () => `pos_${randomBytes(30).toString('base64url')}`

async function insertConnection(companyId: string, overrides: { venueRef?: string; status?: string } = {}): Promise<string> {
  const status = overrides.status ?? 'active'
  const { rows } = await getPool().query<{ id: string }>(
    `INSERT INTO public.pos_connections
       (company_id, provider, provider_name, venue_ref, venue_name, connection_handle, status, sync_from, ended_at)
     VALUES ($1, 'heynow', 'Heynow', $2, 'Restaurang Test', $3, $4, '2026-09-30',
             CASE WHEN $4 = 'disconnected' THEN now() END)
     RETURNING id`,
    [companyId, overrides.venueRef ?? randomUUID().slice(0, 16), status === 'disconnected' ? null : handle(), status],
  )
  return rows[0].id
}

async function insertDay(companyId: string, connectionId: string, businessDate: string): Promise<string> {
  const { rows } = await getPool().query<{ id: string }>(
    `INSERT INTO public.pos_sales_days
       (company_id, connection_id, business_date, status, gross, net, vat, day,
        raw_body, raw_content_type, raw_sha256, fetched_at)
     VALUES ($1, $2, $3::date, 'ready', 112, 100, 12, jsonb_build_object('businessDate', $3::date),
             '{"receipts":[]}', 'application/json', repeat('a', 64), now())
     RETURNING id`,
    [companyId, connectionId, businessDate],
  )
  return rows[0].id
}

async function postedDayVoucher(seed: { userId: string; companyId: string; fiscalPeriodId: string }, dayId: string): Promise<string> {
  return insertPostedJournalEntry({
    ...seed,
    entryDate: '2026-09-30',
    voucherSeries: 'F',
    sourceType: 'pos_daily_sales',
    sourceId: dayId,
    description: 'Dagskassa 2026-09-30 Restaurang Test (Heynow)',
    lines: [
      { accountNumber: '1686', debitAmount: 112, creditAmount: 0 },
      { accountNumber: '3002', debitAmount: 0, creditAmount: 100 },
      { accountNumber: '2621', debitAmount: 0, creditAmount: 12 },
    ],
  })
}

/** One statement per context: a refused statement aborts the transaction. */
async function expectRefusedAs(userId: string, sql: string, params: unknown[] = [], code = '42501'): Promise<void> {
  await expect(withUserContext(userId, (client) => client.query(sql, params))).rejects.toMatchObject({ code })
}

async function expectRefused(sql: string, params: unknown[], code: string): Promise<void> {
  await expect(getPool().query(sql, params), sql).rejects.toMatchObject({ code })
}

describe('pos sales tables: what a member may do', () => {
  let ownerA: string
  let viewerA: string
  let ownerB: string
  let connectionA: string
  let connectionB: string
  let dayA: string
  let dayB: string

  beforeAll(async () => {
    const a = await seedCompany()
    const b = await seedCompany()
    ownerA = a.userId
    ownerB = b.userId
    viewerA = await insertAuthUser()
    await insertCompanyMember({ companyId: a.companyId, userId: viewerA, role: 'viewer' })
    connectionA = await insertConnection(a.companyId)
    connectionB = await insertConnection(b.companyId)
    dayA = await insertDay(a.companyId, connectionA, '2026-09-30')
    dayB = await insertDay(b.companyId, connectionB, '2026-09-30')
  })

  it("reads its own company's connections and days, never another company's", async () => {
    for (const userId of [ownerA, viewerA]) {
      const seen = await withUserContext(userId, async (client) => ({
        connections: (await client.query<{ id: string }>('SELECT id FROM public.pos_connections')).rows.map((r) => r.id),
        days: (await client.query<{ id: string }>('SELECT id FROM public.pos_sales_days')).rows.map((r) => r.id),
      }))
      expect(seen.connections).toContain(connectionA)
      expect(seen.connections).not.toContain(connectionB)
      expect(seen.days).toContain(dayA)
      expect(seen.days).not.toContain(dayB)
    }
    const other = await withUserContext(ownerB, (client) => client.query<{ id: string }>('SELECT id FROM public.pos_sales_days'))
    expect(other.rows.map((r) => r.id)).not.toContain(dayA)
  })

  it('never shows a member the connection handle, while every other column stays readable', async () => {
    const pool = getPool()
    const { rows: columns } = await pool.query<{ attname: string }>(
      `SELECT attname FROM pg_attribute
        WHERE attrelid = 'public.pos_connections'::regclass AND attnum > 0 AND NOT attisdropped`,
    )
    for (const { attname } of columns) {
      const { rows } = await pool.query<{ member: boolean; anon: boolean; server: boolean }>(
        `SELECT has_column_privilege('authenticated', 'public.pos_connections'::regclass, $1, 'SELECT') AS member,
                has_column_privilege('anon', 'public.pos_connections'::regclass, $1, 'SELECT') AS anon,
                has_column_privilege('service_role', 'public.pos_connections'::regclass, $1, 'SELECT') AS server`,
        [attname],
      )
      expect(rows[0], attname).toEqual({ member: attname !== 'connection_handle', anon: false, server: true })
    }
    await expectRefusedAs(ownerA, 'SELECT connection_handle FROM public.pos_connections')
    await expectRefusedAs(ownerA, 'SELECT * FROM public.pos_connections')
    const server = await runAsServiceRole((client) =>
      client.query<{ connection_handle: string }>('SELECT connection_handle FROM public.pos_connections WHERE id = $1', [connectionA]),
    )
    expect(server.rows[0].connection_handle).toMatch(/^pos_/)
  })

  it('writes nothing as a member: every write goes through the server', async () => {
    await expectRefusedAs(
      ownerA,
      `INSERT INTO public.pos_connections (company_id, provider, provider_name, venue_ref, venue_name, connection_handle, sync_from)
       SELECT company_id, 'heynow', 'Heynow', 'other-venue', 'X', $1, '2026-09-30' FROM public.pos_connections WHERE id = $2`,
      [handle(), connectionA],
    )
    await expectRefusedAs(ownerA, `UPDATE public.pos_connections SET settings = '{"tips_account":"2820"}' WHERE id = $1`, [connectionA])
    await expectRefusedAs(ownerA, 'DELETE FROM public.pos_connections WHERE id = $1', [connectionA])
    await expectRefusedAs(ownerA, `UPDATE public.pos_sales_days SET status = 'empty' WHERE id = $1`, [dayA])
    await expectRefusedAs(ownerA, 'DELETE FROM public.pos_sales_days WHERE id = $1', [dayA])
    for (const table of ['pos_connections', 'pos_sales_days']) {
      const { rows } = await getPool().query<{ anon: boolean }>(
        `SELECT has_any_column_privilege('anon', $1::regclass, 'SELECT') AS anon`,
        [`public.${table}`],
      )
      expect(rows[0].anon, table).toBe(false)
    }
  })
})

describe('pos_connections: one live connection per venue', () => {
  it('refuses a second live connection to the same venue, and allows one after the first ended', async () => {
    const { companyId } = await seedCompany()
    const venueRef = `venue-${randomUUID().slice(0, 8)}`
    const first = await insertConnection(companyId, { venueRef })
    await expect(insertConnection(companyId, { venueRef })).rejects.toMatchObject({ code: '23505' })
    await getPool().query(
      `UPDATE public.pos_connections SET status = 'disconnected', ended_at = now(), connection_handle = NULL WHERE id = $1`,
      [first],
    )
    await expect(insertConnection(companyId, { venueRef })).resolves.toEqual(expect.any(String))
  })

  it('keeps status, end time and handle consistent', async () => {
    const { companyId } = await seedCompany()
    const id = await insertConnection(companyId)
    // Active needs a handle; ended iff disconnected.
    await expectRefused('UPDATE public.pos_connections SET connection_handle = NULL WHERE id = $1', [id], '23514')
    await expectRefused(`UPDATE public.pos_connections SET status = 'disconnected' WHERE id = $1`, [id], '23514')
    await expectRefused('UPDATE public.pos_connections SET ended_at = now() WHERE id = $1', [id], '23514')
    await expectRefused(`UPDATE public.pos_connections SET route = 'direct' WHERE id = $1`, [id], '23514')
  })
})

describe('pos_sales_days: one row per day, frozen once booked', () => {
  let seed: { userId: string; companyId: string; fiscalPeriodId: string }
  let connectionId: string

  beforeAll(async () => {
    seed = await seedCompany()
    connectionId = await insertConnection(seed.companyId)
  })

  it('holds one row per connection and business day', async () => {
    await insertDay(seed.companyId, connectionId, '2026-09-01')
    await expect(insertDay(seed.companyId, connectionId, '2026-09-01')).rejects.toMatchObject({ code: '23505' })
  })

  it('never marks a day booked without saying when', async () => {
    const dayId = await insertDay(seed.companyId, connectionId, '2026-09-02')
    await expectRefused(`UPDATE public.pos_sales_days SET status = 'booked' WHERE id = $1`, [dayId], '23514')
  })

  it('freezes what a booked day was booked from, and lets the review fields move', async () => {
    const dayId = await insertDay(seed.companyId, connectionId, '2026-09-30')
    const voucherId = await postedDayVoucher(seed, dayId)
    await getPool().query(
      `UPDATE public.pos_sales_days SET journal_entry_id = $2, status = 'booked', booked_at = now(), booked_by = $3 WHERE id = $1`,
      [dayId, voucherId, seed.userId],
    )

    const frozen: Array<[string, unknown]> = [
      ['day', JSON.stringify({ businessDate: '2026-09-30', changed: true })],
      ['raw_body', '{"receipts":[1]}'],
      ['raw_sha256', 'b'.repeat(64)],
      ['gross', 999],
      ['net', 1],
      ['vat', 1],
      ['tips', 5],
      ['tenders', '[{"kind":"cash"}]'],
      ['vat_groups', '[{"ratePercent":12}]'],
      ['business_date', '2026-09-29'],
    ]
    for (const [column, value] of frozen) {
      await expectRefused(`UPDATE public.pos_sales_days SET ${column} = $2 WHERE id = $1`, [dayId, value], '23514')
    }
    // The server path is held to the same rule.
    await expect(
      runAsServiceRole((client) => client.query(`UPDATE public.pos_sales_days SET gross = 1 WHERE id = $1`, [dayId])),
    ).rejects.toMatchObject({ code: '23514' })

    // A later fetch that answered something else only flags the day.
    await getPool().query(
      `UPDATE public.pos_sales_days
          SET changed_after_booking = true, latest_raw_sha256 = repeat('c', 64), latest_fetched_at = now(),
              fetch_count = fetch_count + 1, review_reasons = '[]'
        WHERE id = $1`,
      [dayId],
    )
    const { rows } = await getPool().query(
      'SELECT gross::float8 AS gross, raw_sha256, changed_after_booking, journal_entry_id FROM public.pos_sales_days WHERE id = $1',
      [dayId],
    )
    expect(rows[0]).toEqual({ gross: 112, raw_sha256: 'a'.repeat(64), changed_after_booking: true, journal_entry_id: voucherId })
  })

  it('keeps the link to a posted voucher: no relinking, no unlinking', async () => {
    const dayId = await insertDay(seed.companyId, connectionId, '2026-09-28')
    const voucherId = await postedDayVoucher(seed, dayId)
    await getPool().query(
      `UPDATE public.pos_sales_days SET journal_entry_id = $2, status = 'booked', booked_at = now() WHERE id = $1`,
      [dayId, voucherId],
    )
    const otherDay = await insertDay(seed.companyId, connectionId, '2026-09-27')
    const otherVoucher = await postedDayVoucher(seed, otherDay)
    await expectRefused('UPDATE public.pos_sales_days SET journal_entry_id = $2 WHERE id = $1', [dayId, otherVoucher], '23514')
    await expectRefused('UPDATE public.pos_sales_days SET journal_entry_id = NULL WHERE id = $1', [dayId], '23514')
  })

  it('releases the claim of a booking that did not commit', async () => {
    // book-day.ts claims the row with the draft before the commit and, when
    // the commit fails, unlinks it and cancels the draft.
    const dayId = await insertDay(seed.companyId, connectionId, '2026-09-26')
    const draftId = await insertDraftJournalEntry({ ...seed, sourceType: 'pos_daily_sales', sourceId: dayId, voucherSeries: 'F' })
    await getPool().query('UPDATE public.pos_sales_days SET journal_entry_id = $2 WHERE id = $1', [dayId, draftId])
    await getPool().query('UPDATE public.pos_sales_days SET journal_entry_id = NULL WHERE id = $1', [dayId])
    await getPool().query(`UPDATE public.journal_entries SET status = 'cancelled' WHERE id = $1`, [draftId])
    // And the day can be booked again.
    const retry = await insertDraftJournalEntry({ ...seed, sourceType: 'pos_daily_sales', sourceId: dayId, voucherSeries: 'F' })
    await getPool().query('UPDATE public.pos_sales_days SET journal_entry_id = $2 WHERE id = $1', [dayId, retry])
  })
})

describe('journal_entries: the pos_daily_sales source type', () => {
  it('allows one live voucher per day: a draft or a posted one blocks the next, a cancelled one does not', async () => {
    const seed = await seedCompany()
    const dayId = randomUUID()
    const draft = await insertDraftJournalEntry({ ...seed, sourceType: 'pos_daily_sales', sourceId: dayId })
    await expect(insertDraftJournalEntry({ ...seed, sourceType: 'pos_daily_sales', sourceId: dayId })).rejects.toMatchObject({
      code: '23505',
    })
    await getPool().query(`UPDATE public.journal_entries SET status = 'cancelled' WHERE id = $1`, [draft])
    await postedDayVoucher(seed, dayId)
    await expect(insertDraftJournalEntry({ ...seed, sourceType: 'pos_daily_sales', sourceId: dayId })).rejects.toMatchObject({
      code: '23505',
    })
    // Another source type pointing at the same id is not a second day voucher.
    await expect(insertDraftJournalEntry({ ...seed, sourceType: 'manual', sourceId: dayId })).resolves.toEqual(expect.any(String))
    // Nor is the same day id in another company.
    const other = await seedCompany()
    await expect(insertDraftJournalEntry({ ...other, sourceType: 'pos_daily_sales', sourceId: dayId })).resolves.toEqual(
      expect.any(String),
    )
  })
})
