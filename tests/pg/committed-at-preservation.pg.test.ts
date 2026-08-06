import { describe, it, expect } from 'vitest'
import { getPool } from './setup'
import { seedCompany, insertDraftJournalEntry, insertBalancedLines } from './fixtures'

// set_committed_at() after migration 20260806150000: the draft-to-posted
// transition stamps committed_at = now() ONLY when the row carries none.
// Seeding flows post drafts with a backdated committed_at (sandbox seed,
// seed-demo-account, seed-export-data); that value must survive posting,
// while the engine path (drafts with NULL committed_at) keeps getting
// stamped, so a posted entry never ends up without a committed_at.

async function postEntry(id: string): Promise<{ committed_at: Date | null }> {
  const pool = getPool()
  await pool.query(
    `UPDATE public.journal_entries SET status = 'posted' WHERE id = $1`,
    [id],
  )
  const { rows } = await pool.query(
    `SELECT committed_at FROM public.journal_entries WHERE id = $1`,
    [id],
  )
  return rows[0] as { committed_at: Date | null }
}

describe('set_committed_at preserves a preset committed_at', () => {
  it('keeps a backdated committed_at on draft-to-posted', async () => {
    const { userId, companyId, fiscalPeriodId } = await seedCompany()
    const backdated = '2026-03-15T10:00:00Z'
    const entryId = await insertDraftJournalEntry({
      userId,
      companyId,
      fiscalPeriodId,
      entryDate: '2026-03-15',
      committedAt: backdated,
    })
    await insertBalancedLines(entryId)

    const { committed_at } = await postEntry(entryId)
    expect(committed_at?.toISOString()).toBe('2026-03-15T10:00:00.000Z')
  })

  it('stamps now() when the draft carries no committed_at', async () => {
    const { userId, companyId, fiscalPeriodId } = await seedCompany()
    const entryId = await insertDraftJournalEntry({
      userId,
      companyId,
      fiscalPeriodId,
      entryDate: '2026-03-15',
    })
    await insertBalancedLines(entryId)

    const before = Date.now()
    const { committed_at } = await postEntry(entryId)
    expect(committed_at).not.toBeNull()
    // Stamped at posting time, not the (older) entry_date.
    expect(committed_at!.getTime()).toBeGreaterThanOrEqual(before - 60_000)
  })
})
