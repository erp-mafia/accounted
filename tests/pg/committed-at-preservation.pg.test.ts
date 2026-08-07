import { describe, it, expect } from 'vitest'
import { getPool, withUserContext, runAsServiceRole } from './setup'
import { seedCompany, insertDraftJournalEntry, insertBalancedLines } from './fixtures'

// set_committed_at() after migration 20260806160000: on draft-to-posted the
// preset committed_at survives ONLY for backend writers, decided by the JWT
// claims role (service_role, or no claims at all: direct SQL and pg tests).
// Seeding flows backdate history that way. For end-user callers the stamp
// stays tamper-proof: RLS lets a member insert a draft with any committed_at,
// and the timeliness checks (BFL 5 kap) read committed_at as the genuine
// transition time, so an authenticated caller must never control it: not via
// a direct UPDATE, and not by laundering the post through the SECURITY
// DEFINER commit_journal_entry RPC (which is why the guard reads JWT claims,
// not current_user). Drafts with no committed_at are stamped now() for
// everyone.

const BACKDATED = '2026-03-15T10:00:00Z'
const BACKDATED_ISO = '2026-03-15T10:00:00.000Z'

async function seedBackdatedDraft(): Promise<{ entryId: string; userId: string }> {
  const { userId, companyId, fiscalPeriodId } = await seedCompany()
  const entryId = await insertDraftJournalEntry({
    userId,
    companyId,
    fiscalPeriodId,
    entryDate: '2026-03-15',
    committedAt: BACKDATED,
  })
  await insertBalancedLines(entryId)
  return { entryId, userId }
}

describe('set_committed_at trusted-writer preservation', () => {
  it('preserves a backdated committed_at when posting as postgres', async () => {
    const { entryId } = await seedBackdatedDraft()
    const pool = getPool()
    await pool.query(`UPDATE public.journal_entries SET status = 'posted' WHERE id = $1`, [
      entryId,
    ])
    const { rows } = await pool.query<{ committed_at: Date }>(
      `SELECT committed_at FROM public.journal_entries WHERE id = $1`,
      [entryId],
    )
    expect(rows[0].committed_at.toISOString()).toBe(BACKDATED_ISO)
  })

  it('preserves a backdated committed_at when posting as service_role', async () => {
    const { entryId } = await seedBackdatedDraft()
    const committedAt = await runAsServiceRole(async (client) => {
      await client.query(`UPDATE public.journal_entries SET status = 'posted' WHERE id = $1`, [
        entryId,
      ])
      const { rows } = await client.query<{ committed_at: Date }>(
        `SELECT committed_at FROM public.journal_entries WHERE id = $1`,
        [entryId],
      )
      return rows[0].committed_at
    })
    expect(committedAt.toISOString()).toBe(BACKDATED_ISO)
  })

  it('overwrites a preset committed_at when an authenticated member posts', async () => {
    const { entryId, userId } = await seedBackdatedDraft()
    const before = Date.now()
    const committedAt = await withUserContext(userId, async (client) => {
      const updated = await client.query(
        `UPDATE public.journal_entries SET status = 'posted' WHERE id = $1 RETURNING id`,
        [entryId],
      )
      // RLS must actually let the member's UPDATE through; 0 rows would make
      // the assertion below pass vacuously against the seeded value.
      expect(updated.rowCount).toBe(1)
      const { rows } = await client.query<{ committed_at: Date }>(
        `SELECT committed_at FROM public.journal_entries WHERE id = $1`,
        [entryId],
      )
      return rows[0].committed_at
    })
    const after = Date.now()
    expect(committedAt.toISOString()).not.toBe(BACKDATED_ISO)
    expect(committedAt.getTime()).toBeGreaterThanOrEqual(before - 60_000)
    expect(committedAt.getTime()).toBeLessThanOrEqual(after + 60_000)
  })

  it('overwrites a preset committed_at when an authenticated member posts via commit_journal_entry', async () => {
    // The laundering path: the RPC is SECURITY DEFINER, so current_user
    // inside it is the function owner. The guard must still see the caller's
    // JWT claims and stamp now().
    const { userId, companyId, fiscalPeriodId } = await seedCompany()
    const entryId = await insertDraftJournalEntry({
      userId,
      companyId,
      fiscalPeriodId,
      entryDate: '2026-03-15',
      committedAt: BACKDATED,
    })
    await insertBalancedLines(entryId)

    const before = Date.now()
    const committedAt = await withUserContext(userId, async (client) => {
      const committed = await client.query<{ voucher_number: number }>(
        `SELECT * FROM public.commit_journal_entry($1, $2)`,
        [companyId, entryId],
      )
      expect(committed.rows[0].voucher_number).toBeGreaterThan(0)
      const { rows } = await client.query<{ committed_at: Date }>(
        `SELECT committed_at FROM public.journal_entries WHERE id = $1`,
        [entryId],
      )
      return rows[0].committed_at
    })
    const after = Date.now()
    expect(committedAt.toISOString()).not.toBe(BACKDATED_ISO)
    expect(committedAt.getTime()).toBeGreaterThanOrEqual(before - 60_000)
    expect(committedAt.getTime()).toBeLessThanOrEqual(after + 60_000)
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

    const pool = getPool()
    const before = Date.now()
    await pool.query(`UPDATE public.journal_entries SET status = 'posted' WHERE id = $1`, [
      entryId,
    ])
    const after = Date.now()
    const { rows } = await pool.query<{ committed_at: Date | null }>(
      `SELECT committed_at FROM public.journal_entries WHERE id = $1`,
      [entryId],
    )
    expect(rows[0].committed_at).not.toBeNull()
    // Stamped at posting time, not the (older) entry_date.
    expect(rows[0].committed_at!.getTime()).toBeGreaterThanOrEqual(before - 60_000)
    expect(rows[0].committed_at!.getTime()).toBeLessThanOrEqual(after + 60_000)
  })
})
