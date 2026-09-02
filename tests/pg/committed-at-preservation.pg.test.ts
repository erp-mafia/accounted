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

interface OverrideAuditRow {
  action: string
  new_state: {
    preset_committed_at: string
    wall_clock: string
    jwt_role: string
  }
  created_at: Date
}

async function fetchOverrideRows(entryId: string): Promise<OverrideAuditRow[]> {
  // Read as postgres: audit_log SELECT is restricted to the owning user.
  const { rows } = await getPool().query<OverrideAuditRow>(
    `SELECT action, new_state, created_at
     FROM public.audit_log
     WHERE table_name = 'journal_entries'
       AND record_id = $1
       AND action = 'COMMITTED_AT_OVERRIDE'`,
    [entryId],
  )
  return rows
}

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
      // Direct draft -> posted flips from a user session must carry a
      // sequence-issued voucher number (20260902093000); take one inline.
      const updated = await client.query(
        `UPDATE public.journal_entries
            SET status = 'posted',
                voucher_number = public.next_voucher_number(company_id, fiscal_period_id, voucher_series)
          WHERE id = $1 RETURNING id`,
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

// Migration 20260810121000: preserving a preset committed_at is a sanctioned
// override of the behandlingshistorik timestamp, so BFNAR 2013:2 kap 8 wants a
// durable trace: who kept which preset value, and what the wall clock said.
describe('committed_at override audit trail', () => {
  it('writes a COMMITTED_AT_OVERRIDE audit row when postgres preserves a preset', async () => {
    const { entryId } = await seedBackdatedDraft()
    const before = Date.now()
    await getPool().query(`UPDATE public.journal_entries SET status = 'posted' WHERE id = $1`, [
      entryId,
    ])
    const after = Date.now()

    const rows = await fetchOverrideRows(entryId)
    expect(rows).toHaveLength(1)
    expect(new Date(rows[0].new_state.preset_committed_at).toISOString()).toBe(BACKDATED_ISO)
    expect(rows[0].new_state.jwt_role).toBe('none')
    // The row separates real from preset time: wall_clock is the transition
    // moment, not the backdated stamp.
    const wallClock = new Date(rows[0].new_state.wall_clock).getTime()
    expect(wallClock).toBeGreaterThanOrEqual(before - 60_000)
    expect(wallClock).toBeLessThanOrEqual(after + 60_000)
  })

  it('writes the audit row under SET ROLE service_role, despite audit_log RLS', async () => {
    // service_role has no BYPASSRLS in this harness and audit_log has no
    // INSERT policy: only the SECURITY DEFINER writer makes this pass.
    const { entryId } = await seedBackdatedDraft()
    await runAsServiceRole(async (client) => {
      await client.query(`UPDATE public.journal_entries SET status = 'posted' WHERE id = $1`, [
        entryId,
      ])
    })

    const rows = await fetchOverrideRows(entryId)
    expect(rows).toHaveLength(1)
    expect(rows[0].new_state.jwt_role).toBe('service_role')
    expect(new Date(rows[0].new_state.preset_committed_at).toISOString()).toBe(BACKDATED_ISO)
  })

  it('stamps wall_clock at the update moment, not the transaction start', async () => {
    // The seeding flows post many entries inside one transaction; now() would
    // pin every override to the BEGIN. The writer must use clock_timestamp().
    const { entryId } = await seedBackdatedDraft()
    const client = await getPool().connect()
    try {
      await client.query('BEGIN')
      const {
        rows: [{ txn_start }],
      } = await client.query<{ txn_start: Date }>(`SELECT now() AS txn_start`)
      await client.query(`SELECT pg_sleep(1.2)`)
      await client.query(`UPDATE public.journal_entries SET status = 'posted' WHERE id = $1`, [
        entryId,
      ])
      await client.query('COMMIT')
      const rows = await fetchOverrideRows(entryId)
      expect(rows).toHaveLength(1)
      const wallClock = new Date(rows[0].new_state.wall_clock).getTime()
      expect(wallClock).toBeGreaterThanOrEqual(txn_start.getTime() + 1_000)
    } finally {
      client.release()
    }
  })

  it('writes no override row when an authenticated member posts (stamp path)', async () => {
    const { entryId, userId } = await seedBackdatedDraft()
    await withUserContext(userId, async (client) => {
      // Direct draft -> posted flips from a user session must carry a
      // sequence-issued voucher number (20260902093000); take one inline.
      const updated = await client.query(
        `UPDATE public.journal_entries
            SET status = 'posted',
                voucher_number = public.next_voucher_number(company_id, fiscal_period_id, voucher_series)
          WHERE id = $1 RETURNING id`,
        [entryId],
      )
      expect(updated.rowCount).toBe(1)
    })
    expect(await fetchOverrideRows(entryId)).toHaveLength(0)
  })

  it('writes no override row when the draft carries no committed_at', async () => {
    const { userId, companyId, fiscalPeriodId } = await seedCompany()
    const entryId = await insertDraftJournalEntry({
      userId,
      companyId,
      fiscalPeriodId,
      entryDate: '2026-03-15',
    })
    await insertBalancedLines(entryId)
    await getPool().query(`UPDATE public.journal_entries SET status = 'posted' WHERE id = $1`, [
      entryId,
    ])
    expect(await fetchOverrideRows(entryId)).toHaveLength(0)
  })

  it('does not expose the writer to client roles', async () => {
    // PostgREST would surface any EXECUTE-granted SECURITY DEFINER function in
    // public as an RPC; a member must not be able to write audit noise.
    const { entryId, userId } = await seedBackdatedDraft()
    await withUserContext(userId, async (client) => {
      await expect(
        client.query(
          `SELECT public.log_committed_at_override(je, 'authenticated')
           FROM public.journal_entries je WHERE je.id = $1`,
          [entryId],
        ),
      ).rejects.toThrow(/permission denied/)
    })
  })
})
