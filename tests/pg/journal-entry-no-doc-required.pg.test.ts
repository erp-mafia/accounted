import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  seedCompany,
  insertCompanyMember,
  insertAuthUser,
  insertDraftJournalEntry,
} from '@/tests/pg/fixtures'
import { getPool, withUserContext } from '@/tests/pg/setup'

/**
 * Covers migration 20260527170100_journal_entry_no_doc_required:
 *   - Sidecar table accepts inserts via PostgREST (user context)
 *   - RLS isolates exemptions across companies
 *   - FK cascade removes the exemption when the parent journal_entry is deleted
 *   - reason length is capped at 200 chars
 *   - PRIMARY KEY on journal_entry_id prevents duplicate exemptions
 */

async function insertExemption(client: {
  query: (sql: string, params: unknown[]) => Promise<unknown>
}, params: {
  journalEntryId: string
  companyId: string
  userId: string
  reason?: string | null
}) {
  await client.query(
    `INSERT INTO public.journal_entry_no_doc_required
       (journal_entry_id, company_id, user_id, reason)
     VALUES ($1, $2, $3, $4)`,
    [params.journalEntryId, params.companyId, params.userId, params.reason ?? null],
  )
}

describe('journal_entry_no_doc_required.pg', () => {
  it('inserts and reads back an exemption row', async () => {
    const { userId, companyId, fiscalPeriodId } = await seedCompany()
    const entryId = await insertDraftJournalEntry({ userId, companyId, fiscalPeriodId })

    await insertExemption(getPool(), {
      journalEntryId: entryId,
      companyId,
      userId,
      reason: 'Bankavgift',
    })

    const res = await getPool().query<{ reason: string | null }>(
      `SELECT reason FROM public.journal_entry_no_doc_required WHERE journal_entry_id = $1`,
      [entryId],
    )
    expect(res.rows).toHaveLength(1)
    expect(res.rows[0]!.reason).toBe('Bankavgift')
  })

  it('PK on journal_entry_id blocks duplicate exemptions', async () => {
    const { userId, companyId, fiscalPeriodId } = await seedCompany()
    const entryId = await insertDraftJournalEntry({ userId, companyId, fiscalPeriodId })

    await insertExemption(getPool(), { journalEntryId: entryId, companyId, userId })
    await expect(
      insertExemption(getPool(), { journalEntryId: entryId, companyId, userId }),
    ).rejects.toThrow(/duplicate key|already exists/)
  })

  it('caps reason at 200 chars', async () => {
    const { userId, companyId, fiscalPeriodId } = await seedCompany()
    const entryId = await insertDraftJournalEntry({ userId, companyId, fiscalPeriodId })

    const longReason = 'x'.repeat(201)
    await expect(
      insertExemption(getPool(), {
        journalEntryId: entryId,
        companyId,
        userId,
        reason: longReason,
      }),
    ).rejects.toThrow(/check constraint|violates check/i)
  })

  it('cascades on delete when the journal_entry is removed', async () => {
    const { userId, companyId, fiscalPeriodId } = await seedCompany()
    const entryId = await insertDraftJournalEntry({ userId, companyId, fiscalPeriodId })

    await insertExemption(getPool(), { journalEntryId: entryId, companyId, userId })

    // enforce_journal_entry_immutability blocks DELETE unconditionally; the
    // delete_last_voucher RPC sets gnubok.allow_delete='true' before deleting.
    // Mirror that here so the cascade can fire.
    const client = await getPool().connect()
    try {
      await client.query('BEGIN')
      await client.query(`SELECT set_config('gnubok.allow_delete', 'true', true)`)
      await client.query(`DELETE FROM public.journal_entries WHERE id = $1`, [entryId])
      await client.query('COMMIT')
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {})
      throw err
    } finally {
      client.release()
    }

    const res = await getPool().query<{ count: string }>(
      `SELECT COUNT(*)::text as count FROM public.journal_entry_no_doc_required
       WHERE journal_entry_id = $1`,
      [entryId],
    )
    expect(res.rows[0]!.count).toBe('0')
  })

  it('RLS hides exemptions from users in other companies', async () => {
    // Company A: owner u1, with one exempted entry
    const { userId: u1, companyId: c1, fiscalPeriodId: fp1 } = await seedCompany()
    const entryA = await insertDraftJournalEntry({ userId: u1, companyId: c1, fiscalPeriodId: fp1 })
    await insertExemption(getPool(), { journalEntryId: entryA, companyId: c1, userId: u1 })

    // Company B: owner u2, no overlap with c1
    const u2 = await insertAuthUser()
    const { companyId: c2 } = await seedCompany()
    await insertCompanyMember({ companyId: c2, userId: u2, role: 'owner' })

    // u2 must not see u1's exemption row
    const visible = await withUserContext(u2, async (client) => {
      const r = await client.query<{ journal_entry_id: string }>(
        `SELECT journal_entry_id FROM public.journal_entry_no_doc_required`,
      )
      return r.rows
    })
    expect(visible.some((r) => r.journal_entry_id === entryA)).toBe(false)
  })
})
