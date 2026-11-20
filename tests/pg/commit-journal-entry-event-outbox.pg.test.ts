import { describe, expect, it } from 'vitest'
import type { PoolClient } from 'pg'
import {
  insertAuthUser,
  insertBalancedLines,
  insertCompanyMember,
  insertDraftJournalEntry,
  seedCompany,
} from '@/tests/pg/fixtures'
import { getPool, runAsServiceRole, withUserContext } from '@/tests/pg/setup'
import { eventDedupeKey } from '@/lib/events/dedupe-key'

/**
 * Covers 20261016001100_commit_journal_entry_writes_committed_event:
 * commit_journal_entry writes the journal_entry.committed row into event_log
 * inside the transaction that posts the verifikat. The event exists if and
 * only if the voucher was posted: a commit writes exactly one row, carrying
 * the actor the RPC was given; a refused commit writes none. The event-bus
 * handler's later write for the same entry (same dedupe_key, ON CONFLICT DO
 * NOTHING) adds nothing.
 */

interface EventRow {
  user_id: string
  company_id: string
  event_type: string
  entity_id: string
  dedupe_key: string
  data: {
    entry: {
      id: string
      status: string
      voucher_number: number
      commit_method: string | null
      committed_actor_type: string | null
      committed_actor_label: string | null
      lines: Array<{ account_number: string; debit_amount: number; credit_amount: number }>
    }
  }
}

const EVENT_ROWS_SQL = `
  SELECT user_id, company_id, event_type, entity_id, dedupe_key, data
    FROM public.event_log
   WHERE entity_id = $1 AND event_type = 'journal_entry.committed'`

async function eventRows(entryId: string, client?: PoolClient): Promise<EventRow[]> {
  const { rows } = await (client ?? getPool()).query<EventRow>(EVENT_ROWS_SQL, [entryId])
  return rows
}

async function entryState(entryId: string): Promise<{ status: string; voucher_number: number }> {
  const { rows } = await getPool().query<{ status: string; voucher_number: number }>(
    `SELECT status, voucher_number FROM public.journal_entries WHERE id = $1`,
    [entryId],
  )
  return rows[0]
}

async function preparedDraft() {
  const seed = await seedCompany()
  const entryId = await insertDraftJournalEntry({
    userId: seed.userId,
    companyId: seed.companyId,
    fiscalPeriodId: seed.fiscalPeriodId,
  })
  await insertBalancedLines(entryId, 1250)
  return { ...seed, entryId }
}

const COMMIT_SQL = `SELECT * FROM public.commit_journal_entry($1, $2, $3, $4, $5, $6)`

describe('commit_journal_entry: the committed event is written in the commit', () => {
  it('a member commit writes exactly one event row, attributed to the caller and the actor', async () => {
    const { companyId, entryId } = await preparedDraft()
    // A second member commits, so the row's user_id is provably the caller,
    // not the entry's creator.
    const memberId = await insertAuthUser()
    await insertCompanyMember({ companyId, userId: memberId, role: 'member' })

    const rows = await withUserContext(memberId, async (client) => {
      const committed = await client.query<{ voucher_number: number }>(COMMIT_SQL, [
        companyId,
        entryId,
        'user_accept',
        null,
        'user',
        'Anna Andersson',
      ])
      expect(committed.rows[0].voucher_number).toBeGreaterThan(0)
      return eventRows(entryId, client)
    })

    expect(rows).toHaveLength(1)
    const [row] = rows
    expect(row).toMatchObject({
      user_id: memberId,
      company_id: companyId,
      event_type: 'journal_entry.committed',
      entity_id: entryId,
      dedupe_key: eventDedupeKey('journal_entry.committed', entryId),
    })
    expect(row.data.entry).toMatchObject({
      id: entryId,
      status: 'posted',
      commit_method: 'user_accept',
      committed_actor_type: 'user',
      committed_actor_label: 'Anna Andersson',
    })
    expect(row.data.entry.voucher_number).toBeGreaterThan(0)
    expect(row.data.entry.lines).toHaveLength(2)
    expect(row.data.entry.lines.map((l) => l.account_number).sort()).toEqual(['1930', '3001'])
  })

  it('a service-role commit (API key, MCP) persists the row with the entry creator as user', async () => {
    const { userId, companyId, entryId } = await preparedDraft()

    const voucherNumber = await runAsServiceRole(async (client) => {
      const { rows } = await client.query<{ voucher_number: number }>(COMMIT_SQL, [
        companyId,
        entryId,
        'agent',
        null,
        'mcp_oauth',
        'Claude (MCP)',
      ])
      return rows[0].voucher_number
    })

    const rows = await eventRows(entryId)
    expect(rows).toHaveLength(1)
    expect(rows[0].user_id).toBe(userId)
    expect(rows[0].data.entry).toMatchObject({
      status: 'posted',
      voucher_number: voucherNumber,
      commit_method: 'agent',
      committed_actor_type: 'mcp_oauth',
      committed_actor_label: 'Claude (MCP)',
    })
  })

  it("the event-bus handler's write for the same entry adds nothing", async () => {
    const { userId, companyId, entryId } = await preparedDraft()
    await runAsServiceRole((client) => client.query(COMMIT_SQL, [companyId, entryId, null, null, null, null]))
    const [before] = await eventRows(entryId)

    // What lib/events/handlers/event-log-handler.ts sends for the emit that
    // follows the commit: the TypeScript key, ON CONFLICT DO NOTHING.
    await runAsServiceRole((client) =>
      client.query(
        `INSERT INTO public.event_log (user_id, company_id, event_type, entity_id, data, dedupe_key)
         VALUES ($1, $2, 'journal_entry.committed', $3, '{"entry": {"from": "bus"}}'::jsonb, $4)
         ON CONFLICT (dedupe_key) DO NOTHING`,
        [userId, companyId, entryId, eventDedupeKey('journal_entry.committed', entryId)],
      ),
    )

    const after = await eventRows(entryId)
    expect(after).toHaveLength(1)
    expect(after[0].data).toEqual(before.data)
  })
})

describe('commit_journal_entry: a refused commit writes no event', () => {
  it('a period locked after the draft was prepared', async () => {
    const { companyId, fiscalPeriodId, entryId } = await preparedDraft()
    await getPool().query(`UPDATE public.fiscal_periods SET locked_at = now() WHERE id = $1`, [fiscalPeriodId])

    await expect(
      runAsServiceRole((client) => client.query(COMMIT_SQL, [companyId, entryId, 'user_accept', null, 'user', 'x'])),
    ).rejects.toThrow(/locked\/closed fiscal period/)

    expect(await eventRows(entryId)).toEqual([])
    expect(await entryState(entryId)).toEqual({ status: 'draft', voucher_number: 0 })
  })

  it('an unbalanced entry', async () => {
    const seed = await seedCompany()
    const entryId = await insertDraftJournalEntry({
      userId: seed.userId,
      companyId: seed.companyId,
      fiscalPeriodId: seed.fiscalPeriodId,
    })
    await getPool().query(
      `INSERT INTO public.journal_entry_lines (journal_entry_id, account_number, debit_amount, credit_amount)
       VALUES ($1, '1930', 100, 0), ($1, '3001', 0, 90)`,
      [entryId],
    )

    await expect(
      runAsServiceRole((client) => client.query(COMMIT_SQL, [seed.companyId, entryId, null, null, null, null])),
    ).rejects.toThrow()

    expect(await eventRows(entryId)).toEqual([])
    expect(await entryState(entryId)).toEqual({ status: 'draft', voucher_number: 0 })
  })

  it('a second commit of an entry already posted', async () => {
    const { companyId, entryId } = await preparedDraft()
    await runAsServiceRole((client) => client.query(COMMIT_SQL, [companyId, entryId, null, null, null, null]))

    await expect(
      runAsServiceRole((client) => client.query(COMMIT_SQL, [companyId, entryId, null, null, null, null])),
    ).rejects.toThrow(/Draft journal entry not found/)

    expect(await eventRows(entryId)).toHaveLength(1)
  })

  it('a caller who cannot write the company', async () => {
    const { companyId, entryId } = await preparedDraft()
    const outsiderId = await insertAuthUser()

    await expect(
      withUserContext(outsiderId, (client) => client.query(COMMIT_SQL, [companyId, entryId, null, null, null, null])),
    ).rejects.toMatchObject({ code: '42501' })

    expect(await eventRows(entryId)).toEqual([])
    expect(await entryState(entryId)).toEqual({ status: 'draft', voucher_number: 0 })
  })
})
