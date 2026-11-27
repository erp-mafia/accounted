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
 * pg-real coverage for the spend migrations:
 *   - 20261127161000_spend_expenses.sql: members read, never write; the
 *     connection handle, the OAuth state and the return origin are withheld
 *     from members; one live connection per provider; one row per provider
 *     expense; a booked expense is frozen and its voucher link holds;
 *   - 20261127161100_journal_source_type_spend_item.sql: the source type and
 *     the one-live-voucher-per-expense index the booking race relies on.
 * The needs-doc list (20261127161300) is probed per source type by
 * document-surfaces-unification.pg.test.ts against NEEDS_DOC_SOURCE_TYPES,
 * the voucher-series default (20261127161200) by
 * voucher-series-standard-default.pg.test.ts and the migration-reset blocker
 * (20261127161600) by company-migration-reset.pg.test.ts.
 */

const handle = () => `spend_${randomBytes(30).toString('base64url')}`
const stateHash = () => randomBytes(32).toString('hex')

/** Columns only the server reads (column grants). */
const SERVER_ONLY = new Set(['connection_handle', 'pending_state_sha256', 'pending_expires_at', 'pending_return_origin'])

async function insertConnection(companyId: string, overrides: { provider?: string; status?: string } = {}): Promise<string> {
  const status = overrides.status ?? 'active'
  const { rows } = await getPool().query<{ id: string }>(
    `INSERT INTO public.spend_connections
       (company_id, provider, provider_name, mode, connection_handle, status, ended_at,
        pending_state_sha256, pending_expires_at)
     VALUES ($1, $2, 'Pleo', 'oauth', $3, $4,
             CASE WHEN $4 = 'disconnected' THEN now() END,
             CASE WHEN $4 = 'connecting' THEN $5 END,
             CASE WHEN $4 = 'connecting' THEN now() + interval '15 minutes' END)
     RETURNING id`,
    [companyId, overrides.provider ?? 'pleo', status === 'active' ? handle() : null, status, stateHash()],
  )
  return rows[0].id
}

async function insertItem(companyId: string, connectionId: string, externalId: string = randomUUID()): Promise<string> {
  const { rows } = await getPool().query<{ id: string }>(
    `INSERT INTO public.spend_items
       (company_id, connection_id, provider, external_id, kind, expense_date, currency, amount,
        merchant_name, person_name, status, expense, raw_body, raw_content_type, raw_sha256,
        received_at, ack_outcome, acknowledged_at)
     VALUES ($1, $2, 'pleo', $3, 'card_purchase', '2026-09-30', 'SEK', 625,
             'Papper & Penna AB', 'Anna Exempel', 'ready', jsonb_build_object('externalId', $3::text),
             '{"id":"exp"}', 'application/json', repeat('a', 64), now(), 'received', now())
     RETURNING id`,
    [companyId, connectionId, externalId],
  )
  return rows[0].id
}

async function postedItemVoucher(seed: { userId: string; companyId: string; fiscalPeriodId: string }, itemId: string): Promise<string> {
  return insertPostedJournalEntry({
    ...seed,
    entryDate: '2026-09-30',
    voucherSeries: 'A',
    sourceType: 'spend_item',
    sourceId: itemId,
    description: 'Kortköp Papper & Penna AB (Anna Exempel), Pleo',
    lines: [
      { accountNumber: '6110', debitAmount: 500, creditAmount: 0 },
      { accountNumber: '2641', debitAmount: 125, creditAmount: 0 },
      { accountNumber: '1940', debitAmount: 0, creditAmount: 625 },
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

describe('spend tables: what a member may do', () => {
  let ownerA: string
  let viewerA: string
  let ownerB: string
  let connectionA: string
  let connectionB: string
  let itemA: string
  let itemB: string

  beforeAll(async () => {
    const a = await seedCompany()
    const b = await seedCompany()
    ownerA = a.userId
    ownerB = b.userId
    viewerA = await insertAuthUser()
    await insertCompanyMember({ companyId: a.companyId, userId: viewerA, role: 'viewer' })
    connectionA = await insertConnection(a.companyId)
    connectionB = await insertConnection(b.companyId)
    itemA = await insertItem(a.companyId, connectionA)
    itemB = await insertItem(b.companyId, connectionB)
  })

  it("reads its own company's connections and expenses, never another company's", async () => {
    for (const userId of [ownerA, viewerA]) {
      const seen = await withUserContext(userId, async (client) => ({
        connections: (await client.query<{ id: string }>('SELECT id FROM public.spend_connections')).rows.map((r) => r.id),
        items: (await client.query<{ id: string }>('SELECT id FROM public.spend_items')).rows.map((r) => r.id),
      }))
      expect(seen.connections).toContain(connectionA)
      expect(seen.connections).not.toContain(connectionB)
      expect(seen.items).toContain(itemA)
      expect(seen.items).not.toContain(itemB)
    }
    const other = await withUserContext(ownerB, (client) => client.query<{ id: string }>('SELECT id FROM public.spend_items'))
    expect(other.rows.map((r) => r.id)).not.toContain(itemA)
  })

  it('never shows a member the handle, the OAuth state or the return origin, while every other column stays readable', async () => {
    const pool = getPool()
    const { rows: columns } = await pool.query<{ attname: string }>(
      `SELECT attname FROM pg_attribute
        WHERE attrelid = 'public.spend_connections'::regclass AND attnum > 0 AND NOT attisdropped`,
    )
    for (const { attname } of columns) {
      const { rows } = await pool.query<{ member: boolean; anon: boolean; server: boolean }>(
        `SELECT has_column_privilege('authenticated', 'public.spend_connections'::regclass, $1, 'SELECT') AS member,
                has_column_privilege('anon', 'public.spend_connections'::regclass, $1, 'SELECT') AS anon,
                has_column_privilege('service_role', 'public.spend_connections'::regclass, $1, 'SELECT') AS server`,
        [attname],
      )
      expect(rows[0], attname).toEqual({ member: !SERVER_ONLY.has(attname), anon: false, server: true })
    }
    for (const column of SERVER_ONLY) {
      await expectRefusedAs(ownerA, `SELECT ${column} FROM public.spend_connections`)
    }
    await expectRefusedAs(ownerA, 'SELECT * FROM public.spend_connections')
    const server = await runAsServiceRole((client) =>
      client.query<{ connection_handle: string }>('SELECT connection_handle FROM public.spend_connections WHERE id = $1', [connectionA]),
    )
    expect(server.rows[0].connection_handle).toMatch(/^spend_/)
  })

  it('writes nothing as a member: every write goes through the server', async () => {
    await expectRefusedAs(
      ownerA,
      `INSERT INTO public.spend_connections (company_id, provider, provider_name, mode, connection_handle, status)
       SELECT company_id, 'other', 'Other', 'oauth', $1, 'active' FROM public.spend_connections WHERE id = $2`,
      [handle(), connectionA],
    )
    await expectRefusedAs(ownerA, `UPDATE public.spend_connections SET settings = '{"wallet_account":"1940"}' WHERE id = $1`, [connectionA])
    await expectRefusedAs(ownerA, 'DELETE FROM public.spend_connections WHERE id = $1', [connectionA])
    await expectRefusedAs(ownerA, `UPDATE public.spend_items SET status = 'review' WHERE id = $1`, [itemA])
    await expectRefusedAs(ownerA, 'DELETE FROM public.spend_items WHERE id = $1', [itemA])
    for (const table of ['spend_connections', 'spend_items']) {
      const { rows } = await getPool().query<{ anon: boolean }>(
        `SELECT has_any_column_privilege('anon', $1::regclass, 'SELECT') AS anon`,
        [`public.${table}`],
      )
      expect(rows[0].anon, table).toBe(false)
    }
  })
})

describe('spend_connections: one live connection per provider', () => {
  it('refuses a second live connection to the same provider, and allows one after the first ended', async () => {
    const { companyId } = await seedCompany()
    const first = await insertConnection(companyId)
    await expect(insertConnection(companyId)).rejects.toMatchObject({ code: '23505' })
    // A consent attempt in progress is live too.
    await expect(insertConnection(companyId, { status: 'connecting' })).rejects.toMatchObject({ code: '23505' })
    await getPool().query(
      `UPDATE public.spend_connections SET status = 'disconnected', ended_at = now(), connection_handle = NULL WHERE id = $1`,
      [first],
    )
    await expect(insertConnection(companyId)).resolves.toEqual(expect.any(String))
    // Another provider is another connection.
    await expect(insertConnection(companyId, { provider: 'other-cards' })).resolves.toEqual(expect.any(String))
  })

  it('keeps status, end time, handle and the consent state consistent', async () => {
    const { companyId } = await seedCompany()
    const id = await insertConnection(companyId)
    // Active needs a handle; ended iff disconnected; Connect is the only route.
    await expectRefused('UPDATE public.spend_connections SET connection_handle = NULL WHERE id = $1', [id], '23514')
    await expectRefused(`UPDATE public.spend_connections SET status = 'disconnected' WHERE id = $1`, [id], '23514')
    await expectRefused('UPDATE public.spend_connections SET ended_at = now() WHERE id = $1', [id], '23514')
    await expectRefused(`UPDATE public.spend_connections SET route = 'direct' WHERE id = $1`, [id], '23514')
    // Connecting needs the state hash and its expiry.
    await expectRefused(`UPDATE public.spend_connections SET status = 'connecting' WHERE id = $1`, [id], '23514')
    // The return origin is an origin, never a URL with a path or a query.
    await expectRefused(
      `UPDATE public.spend_connections SET pending_return_origin = 'https://app.example.se/settings?x=1' WHERE id = $1`,
      [id],
      '23514',
    )
    await expect(
      getPool().query(`UPDATE public.spend_connections SET pending_return_origin = 'https://app.example.se' WHERE id = $1`, [id]),
    ).resolves.toBeDefined()
    await expectRefused(`UPDATE public.spend_connections SET provider = 'Pleo AB' WHERE id = $1`, [id], '23514')
  })

  it('holds one pending connection per OAuth state', async () => {
    const a = await seedCompany()
    const b = await seedCompany()
    const state = stateHash()
    await getPool().query(
      `INSERT INTO public.spend_connections (company_id, provider, provider_name, mode, status, pending_state_sha256, pending_expires_at)
       VALUES ($1, 'pleo', 'Pleo', 'oauth', 'connecting', $2, now() + interval '15 minutes')`,
      [a.companyId, state],
    )
    await expectRefused(
      `INSERT INTO public.spend_connections (company_id, provider, provider_name, mode, status, pending_state_sha256, pending_expires_at)
       VALUES ($1, 'pleo', 'Pleo', 'oauth', 'connecting', $2, now() + interval '15 minutes')`,
      [b.companyId, state],
      '23505',
    )
  })
})

describe('spend_items: one row per provider expense, frozen once booked', () => {
  let seed: { userId: string; companyId: string; fiscalPeriodId: string }
  let connectionId: string

  beforeAll(async () => {
    seed = await seedCompany()
    connectionId = await insertConnection(seed.companyId)
  })

  it("holds one row per company, provider and the provider's expense id", async () => {
    await insertItem(seed.companyId, connectionId, 'exp-dup')
    await expect(insertItem(seed.companyId, connectionId, 'exp-dup')).rejects.toMatchObject({ code: '23505' })
    // The same provider id in another company is another expense.
    const other = await seedCompany()
    const otherConnection = await insertConnection(other.companyId)
    await expect(insertItem(other.companyId, otherConnection, 'exp-dup')).resolves.toEqual(expect.any(String))
  })

  it('never marks an expense booked without saying when, and keeps the kind and status vocabulary closed', async () => {
    const itemId = await insertItem(seed.companyId, connectionId)
    await expectRefused(`UPDATE public.spend_items SET status = 'booked' WHERE id = $1`, [itemId], '23514')
    await expectRefused(`UPDATE public.spend_items SET status = 'approved' WHERE id = $1`, [itemId], '23514')
    await expectRefused(`UPDATE public.spend_items SET kind = 'transfer' WHERE id = $1`, [itemId], '23514')
    await expectRefused(`UPDATE public.spend_items SET ack_outcome = 'maybe' WHERE id = $1`, [itemId], '23514')
  })

  it('freezes what a booked expense was booked from, and lets the review fields move', async () => {
    const itemId = await insertItem(seed.companyId, connectionId)
    const voucherId = await postedItemVoucher(seed, itemId)
    await getPool().query(
      `UPDATE public.spend_items SET journal_entry_id = $2, status = 'booked', booked_at = now(), booked_by = $3 WHERE id = $1`,
      [itemId, voucherId, seed.userId],
    )

    const frozen: Array<[string, unknown]> = [
      ['expense', JSON.stringify({ externalId: 'changed' })],
      ['raw_body', '{"id":"other"}'],
      ['raw_sha256', 'b'.repeat(64)],
      ['amount', 999],
      ['currency', 'EUR'],
      ['expense_date', '2026-09-29'],
      ['kind', 'refund'],
      ['document_ids', `{${randomUUID()}}`],
      ['external_id', 'exp-other'],
    ]
    for (const [column, value] of frozen) {
      await expectRefused(`UPDATE public.spend_items SET ${column} = $2 WHERE id = $1`, [itemId, value], '23514')
    }
    // The server path is held to the same rule.
    await expect(
      runAsServiceRole((client) => client.query(`UPDATE public.spend_items SET amount = 1 WHERE id = $1`, [itemId])),
    ).rejects.toMatchObject({ code: '23514' })

    // A later export that answered something else only flags the expense.
    await getPool().query(
      `UPDATE public.spend_items
          SET changed_after_booking = true, latest_raw_sha256 = repeat('c', 64), latest_received_at = now(),
              receive_count = receive_count + 1, reasons = '[]'
        WHERE id = $1`,
      [itemId],
    )
    const { rows } = await getPool().query(
      'SELECT amount::float8 AS amount, raw_sha256, changed_after_booking, journal_entry_id FROM public.spend_items WHERE id = $1',
      [itemId],
    )
    expect(rows[0]).toEqual({ amount: 625, raw_sha256: 'a'.repeat(64), changed_after_booking: true, journal_entry_id: voucherId })
  })

  it('keeps the link to a posted voucher: no relinking, no unlinking', async () => {
    const itemId = await insertItem(seed.companyId, connectionId)
    const voucherId = await postedItemVoucher(seed, itemId)
    await getPool().query(
      `UPDATE public.spend_items SET journal_entry_id = $2, status = 'booked', booked_at = now() WHERE id = $1`,
      [itemId, voucherId],
    )
    const otherItem = await insertItem(seed.companyId, connectionId)
    const otherVoucher = await postedItemVoucher(seed, otherItem)
    await expectRefused('UPDATE public.spend_items SET journal_entry_id = $2 WHERE id = $1', [itemId, otherVoucher], '23514')
    await expectRefused('UPDATE public.spend_items SET journal_entry_id = NULL WHERE id = $1', [itemId], '23514')
  })

  it('releases the claim of a booking that did not commit', async () => {
    // book-item.ts claims the row with the draft before the commit and, when
    // the commit fails, unlinks it and cancels the draft.
    const itemId = await insertItem(seed.companyId, connectionId)
    const draftId = await insertDraftJournalEntry({ ...seed, sourceType: 'spend_item', sourceId: itemId, voucherSeries: 'A' })
    await getPool().query('UPDATE public.spend_items SET journal_entry_id = $2 WHERE id = $1', [itemId, draftId])
    await getPool().query('UPDATE public.spend_items SET journal_entry_id = NULL WHERE id = $1', [itemId])
    await getPool().query(`UPDATE public.journal_entries SET status = 'cancelled' WHERE id = $1`, [draftId])
    // And the expense can be booked again.
    const retry = await insertDraftJournalEntry({ ...seed, sourceType: 'spend_item', sourceId: itemId, voucherSeries: 'A' })
    await getPool().query('UPDATE public.spend_items SET journal_entry_id = $2 WHERE id = $1', [itemId, retry])
  })
})

describe('journal_entries: the spend_item source type', () => {
  it('allows one live voucher per expense: a draft or a posted one blocks the next, a cancelled one does not', async () => {
    const seed = await seedCompany()
    const itemId = randomUUID()
    const draft = await insertDraftJournalEntry({ ...seed, sourceType: 'spend_item', sourceId: itemId })
    await expect(insertDraftJournalEntry({ ...seed, sourceType: 'spend_item', sourceId: itemId })).rejects.toMatchObject({
      code: '23505',
    })
    await getPool().query(`UPDATE public.journal_entries SET status = 'cancelled' WHERE id = $1`, [draft])
    await postedItemVoucher(seed, itemId)
    await expect(insertDraftJournalEntry({ ...seed, sourceType: 'spend_item', sourceId: itemId })).rejects.toMatchObject({
      code: '23505',
    })
    // Another source type pointing at the same id is not a second expense voucher.
    await expect(insertDraftJournalEntry({ ...seed, sourceType: 'manual', sourceId: itemId })).resolves.toEqual(expect.any(String))
    // Nor is the same expense id in another company.
    const other = await seedCompany()
    await expect(insertDraftJournalEntry({ ...other, sourceType: 'spend_item', sourceId: itemId })).resolves.toEqual(
      expect.any(String),
    )
  })
})
