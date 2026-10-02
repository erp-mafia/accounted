import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { getPool, runAsServiceRole, withUserContext } from '@/tests/pg/setup'
import {
  seedCompany,
  insertAuthUser,
  insertCompanyMember,
  insertDraftJournalEntry,
} from '@/tests/pg/fixtures'

// Migration 20260702170000_dimension_retag_log_and_rpc.sql: the founder-
// approved Tier-2 retro-tagging carve-out (dimensions plan PR6, §3).
//
// The mandatory suite from the plan:
//   1. a GUC-less UPDATE of a posted line's dimensions is still blocked
//   2. retag is blocked in closed/locked periods and behind the lock date
//   3. amounts (or any non-dimension column) can never change under the GUC
//   4. the RPC never updates without an audit row
//   5. the delete_last_voucher/undo GUC path (gnubok.allow_delete) is
//      unaffected
// plus registry validation, role gates, log immutability, mirror sync and
// the untag path.
//
// 20260928200000 pins the logged actor for JWT callers and closes the
// carve-out flag after the UPDATE; 20260928200200 adds the line bag CHECK
// that stands behind the registry lookup.

async function insertPostedTaggedEntry(params: {
  companyId: string
  userId: string
  fiscalPeriodId: string
  dimensions?: Record<string, string>
  entryDate?: string
  voucherNumber?: number
}): Promise<{ entryId: string; lineId: string }> {
  const entryId = await insertDraftJournalEntry({
    userId: params.userId,
    companyId: params.companyId,
    fiscalPeriodId: params.fiscalPeriodId,
    sourceType: 'manual',
    status: 'draft',
    voucherNumber: params.voucherNumber ?? 1,
    entryDate: params.entryDate,
  })
  const dims = params.dimensions ?? {}
  const { rows } = await getPool().query<{ id: string }>(
    `INSERT INTO public.journal_entry_lines
       (journal_entry_id, account_number, debit_amount, credit_amount, dimensions)
     VALUES ($1, '5010', 1000, 0, $2::jsonb)
     RETURNING id`,
    [entryId, JSON.stringify(dims)],
  )
  await getPool().query(
    `INSERT INTO public.journal_entry_lines
       (journal_entry_id, account_number, debit_amount, credit_amount)
     VALUES ($1, '1930', 0, 1000)`,
    [entryId],
  )
  await getPool().query(`UPDATE public.journal_entries SET status = 'posted' WHERE id = $1`, [entryId])
  return { entryId, lineId: rows[0].id }
}

async function insertRegistryValue(params: {
  companyId: string
  sieDimNo: number
  code: string
  isActive?: boolean
  dimIsActive?: boolean
}): Promise<void> {
  const { rows } = await getPool().query<{ id: string }>(
    `INSERT INTO public.dimensions (company_id, sie_dim_no, name, resets_annually, is_system, is_active)
     VALUES ($1, $2::int, 'Dim ' || $2::text, true, false, $3)
     ON CONFLICT (company_id, sie_dim_no) DO UPDATE SET is_active = EXCLUDED.is_active
     RETURNING id`,
    [params.companyId, params.sieDimNo, params.dimIsActive ?? true],
  )
  await getPool().query(
    `INSERT INTO public.dimension_values (company_id, dimension_id, code, name, is_active)
     VALUES ($1, $2, $3, $3, $4)
     ON CONFLICT (company_id, dimension_id, code) DO UPDATE SET is_active = EXCLUDED.is_active`,
    [params.companyId, rows[0].id, params.code, params.isActive ?? true],
  )
}

async function callRetag(
  companyId: string,
  lineId: string,
  dimensions: Record<string, string>,
  reason: string,
  actor: string,
) {
  return getPool().query<{ result: { changed: boolean; log_id: string | null } }>(
    `SELECT public.retag_line_dimensions($1::uuid, $2::uuid, $3::jsonb, $4, $5::uuid) AS result`,
    [companyId, lineId, JSON.stringify(dimensions), reason, actor],
  )
}

async function lineState(lineId: string) {
  const { rows } = await getPool().query(
    `SELECT dimensions, cost_center, project, debit_amount FROM public.journal_entry_lines WHERE id = $1`,
    [lineId],
  )
  return rows[0]
}

describe('dimension retag carve-out (PR6)', () => {
  it('still blocks a GUC-less dimensions UPDATE on a posted line', async () => {
    const { companyId, userId, fiscalPeriodId } = await seedCompany()
    const { lineId } = await insertPostedTaggedEntry({ companyId, userId, fiscalPeriodId })

    await expect(
      getPool().query(
        `UPDATE public.journal_entry_lines SET dimensions = '{"6":"P001"}'::jsonb WHERE id = $1`,
        [lineId],
      ),
    ).rejects.toThrow(/Cannot UPDATE lines of a posted journal entry/)
  })

  it('retags happy path: dimensions + mirrors updated, immutable log row written', async () => {
    const { companyId, userId, fiscalPeriodId } = await seedCompany()
    await insertRegistryValue({ companyId, sieDimNo: 1, code: 'KS01' })
    await insertRegistryValue({ companyId, sieDimNo: 6, code: 'P001' })
    const { entryId, lineId } = await insertPostedTaggedEntry({
      companyId, userId, fiscalPeriodId,
      dimensions: { '6': 'GAMMAL' },
    })
    // GAMMAL never registered: old values need no registry presence.

    const res = await callRetag(companyId, lineId, { '1': 'KS01', '6': 'P001' }, 'Rätt projekt', userId)
    expect(res.rows[0].result.changed).toBe(true)
    expect(res.rows[0].result.log_id).toBeTruthy()

    const line = await lineState(lineId)
    expect(line.dimensions).toEqual({ '1': 'KS01', '6': 'P001' })
    expect(line.cost_center).toBe('KS01')
    expect(line.project).toBe('P001')

    const { rows: log } = await getPool().query(
      `SELECT old_dimensions, new_dimensions, actor, reason, journal_entry_id
         FROM public.dimension_retag_log WHERE line_id = $1`,
      [lineId],
    )
    expect(log).toHaveLength(1)
    expect(log[0].old_dimensions).toEqual({ '6': 'GAMMAL' })
    expect(log[0].new_dimensions).toEqual({ '1': 'KS01', '6': 'P001' })
    expect(log[0].actor).toBe(userId)
    expect(log[0].reason).toBe('Rätt projekt')
    expect(log[0].journal_entry_id).toBe(entryId)
  })

  it('supports untagging with {} and NULLs the mirrors', async () => {
    const { companyId, userId, fiscalPeriodId } = await seedCompany()
    const { lineId } = await insertPostedTaggedEntry({
      companyId, userId, fiscalPeriodId,
      dimensions: { '1': 'KS01', '6': 'P001' },
    })

    const res = await callRetag(companyId, lineId, {}, 'Feltaggad rad', userId)
    expect(res.rows[0].result.changed).toBe(true)

    const line = await lineState(lineId)
    expect(line.dimensions).toEqual({})
    expect(line.cost_center).toBeNull()
    expect(line.project).toBeNull()
  })

  it('is an idempotent no-op (no log row) when the dimensions are unchanged', async () => {
    const { companyId, userId, fiscalPeriodId } = await seedCompany()
    await insertRegistryValue({ companyId, sieDimNo: 6, code: 'P001' })
    const { lineId } = await insertPostedTaggedEntry({
      companyId, userId, fiscalPeriodId,
      dimensions: { '6': 'P001' },
    })

    const res = await callRetag(companyId, lineId, { '6': 'P001' }, 'Ingen ändring', userId)
    expect(res.rows[0].result.changed).toBe(false)

    const { rows: log } = await getPool().query(
      `SELECT 1 FROM public.dimension_retag_log WHERE line_id = $1`,
      [lineId],
    )
    expect(log).toHaveLength(0)
  })

  it('never lets amounts (or any non-dimension column) change under the GUC', async () => {
    const { companyId, userId, fiscalPeriodId } = await seedCompany()
    const { lineId } = await insertPostedTaggedEntry({ companyId, userId, fiscalPeriodId })

    const client = await getPool().connect()
    try {
      await client.query('BEGIN')
      await client.query(`SELECT set_config('gnubok.allow_dimension_retag', 'true', true)`)
      // Amount edit smuggled alongside a dimension change → carve-out must NOT admit it.
      await expect(
        client.query(
          `UPDATE public.journal_entry_lines
              SET dimensions = '{"6":"P001"}'::jsonb, debit_amount = 999999
            WHERE id = $1`,
          [lineId],
        ),
      ).rejects.toThrow(/Cannot UPDATE lines of a posted journal entry/)
      await client.query('ROLLBACK')

      await client.query('BEGIN')
      await client.query(`SELECT set_config('gnubok.allow_dimension_retag', 'true', true)`)
      await expect(
        client.query(
          `UPDATE public.journal_entry_lines SET line_description = 'hacked' WHERE id = $1`,
          [lineId],
        ),
      ).rejects.toThrow(/Cannot UPDATE lines of a posted journal entry/)
      await client.query('ROLLBACK')

      // A pure dimension diff IS admitted under the GUC (the RPC's write
      // shape). PR9: the bag alone: the generated mirrors recompute.
      await client.query('BEGIN')
      await client.query(`SELECT set_config('gnubok.allow_dimension_retag', 'true', true)`)
      await client.query(
        `UPDATE public.journal_entry_lines
            SET dimensions = '{"6":"P001"}'::jsonb
          WHERE id = $1`,
        [lineId],
      )
      await client.query('ROLLBACK')
    } finally {
      client.release()
    }

    // The GUC was transaction-local: outside it, updates are blocked again.
    await expect(
      getPool().query(
        `UPDATE public.journal_entry_lines SET dimensions = '{"6":"P001"}'::jsonb WHERE id = $1`,
        [lineId],
      ),
    ).rejects.toThrow(/Cannot UPDATE lines of a posted journal entry/)
  })

  it('rejects retag in closed and locked periods', async () => {
    // Post first, then close: the period-lock trigger (correctly) refuses
    // inserts into an already-closed period.
    const closed = await seedCompany()
    const { lineId: closedLine } = await insertPostedTaggedEntry({
      companyId: closed.companyId, userId: closed.userId, fiscalPeriodId: closed.fiscalPeriodId,
    })
    await getPool().query(
      `UPDATE public.fiscal_periods SET is_closed = true, closed_at = now() WHERE id = $1`,
      [closed.fiscalPeriodId],
    )
    await expect(
      callRetag(closed.companyId, closedLine, {}, 'Testar stängd', closed.userId),
    ).rejects.toThrow(/stängd/)

    const locked = await seedCompany()
    const { lineId: lockedLine } = await insertPostedTaggedEntry({
      companyId: locked.companyId, userId: locked.userId, fiscalPeriodId: locked.fiscalPeriodId,
    })
    await getPool().query(`UPDATE public.fiscal_periods SET locked_at = now() WHERE id = $1`, [
      locked.fiscalPeriodId,
    ])
    await expect(
      callRetag(locked.companyId, lockedLine, {}, 'Testar låst', locked.userId),
    ).rejects.toThrow(/låst/)
  })

  it('rejects retag behind the company lock date', async () => {
    const { companyId, userId, fiscalPeriodId } = await seedCompany()
    const { lineId } = await insertPostedTaggedEntry({
      companyId, userId, fiscalPeriodId, entryDate: '2026-03-15',
    })
    await getPool().query(
      `INSERT INTO public.company_settings (user_id, company_id, bookkeeping_locked_through)
       VALUES ($1, $2, '2026-06-30')
       ON CONFLICT (company_id) DO UPDATE SET bookkeeping_locked_through = '2026-06-30'`,
      [userId, companyId],
    )

    await expect(callRetag(companyId, lineId, {}, 'Bakom låsdatum', userId)).rejects.toThrow(
      /låst t\.o\.m/,
    )
  })

  it('rejects viewers, non-members and drafts; requires a reason and active registry values', async () => {
    const { companyId, userId, fiscalPeriodId } = await seedCompany()
    await insertRegistryValue({ companyId, sieDimNo: 6, code: 'P001' })
    await insertRegistryValue({ companyId, sieDimNo: 6, code: 'ARKIV', isActive: false })
    const { lineId } = await insertPostedTaggedEntry({ companyId, userId, fiscalPeriodId })

    // Viewer
    const viewerId = await insertAuthUser()
    await insertCompanyMember({ companyId, userId: viewerId, role: 'viewer' })
    await expect(callRetag(companyId, lineId, { '6': 'P001' }, 'Som viewer', viewerId)).rejects.toThrow(
      /skrivbehörighet/,
    )

    // Complete stranger
    await expect(
      callRetag(companyId, lineId, { '6': 'P001' }, 'Som främling', randomUUID()),
    ).rejects.toThrow(/skrivbehörighet/)

    // Reason required
    await expect(callRetag(companyId, lineId, { '6': 'P001' }, '  ', userId)).rejects.toThrow(
      /anledning/i,
    )

    // Unknown + archived codes rejected
    await expect(callRetag(companyId, lineId, { '6': 'FINNSEJ' }, 'Okänd kod', userId)).rejects.toThrow(
      /finns inte som aktivt värde/,
    )
    await expect(callRetag(companyId, lineId, { '6': 'ARKIV' }, 'Arkiverad kod', userId)).rejects.toThrow(
      /finns inte som aktivt värde/,
    )

    // Draft lines are out of scope (edited directly instead)
    const draftId = await insertDraftJournalEntry({
      userId, companyId, fiscalPeriodId, status: 'draft', voucherNumber: 99,
    })
    const { rows } = await getPool().query<{ id: string }>(
      `INSERT INTO public.journal_entry_lines (journal_entry_id, account_number, debit_amount, credit_amount)
       VALUES ($1, '5010', 100, 0) RETURNING id`,
      [draftId],
    )
    await expect(callRetag(companyId, rows[0].id, { '6': 'P001' }, 'Utkast', userId)).rejects.toThrow(
      /bokförda verifikat/,
    )
  })

  it("cannot reach another company's lines", async () => {
    const a = await seedCompany()
    const b = await seedCompany()
    const { lineId } = await insertPostedTaggedEntry({
      companyId: a.companyId, userId: a.userId, fiscalPeriodId: a.fiscalPeriodId,
    })

    // b's owner passes b's company id but a's line id → not found.
    await expect(
      callRetag(b.companyId, lineId, {}, 'Cross-tenant', b.userId),
    ).rejects.toThrow(/hittades inte/)
  })

  it('keeps the dimension_retag_log immutable', async () => {
    const { companyId, userId, fiscalPeriodId } = await seedCompany()
    await insertRegistryValue({ companyId, sieDimNo: 6, code: 'P001' })
    const { lineId } = await insertPostedTaggedEntry({ companyId, userId, fiscalPeriodId })
    await callRetag(companyId, lineId, { '6': 'P001' }, 'Skapa loggrad', userId)

    const { rows } = await getPool().query<{ id: string }>(
      `SELECT id FROM public.dimension_retag_log WHERE line_id = $1`,
      [lineId],
    )
    await expect(
      getPool().query(`UPDATE public.dimension_retag_log SET reason = 'x' WHERE id = $1`, [rows[0].id]),
    ).rejects.toThrow(/oföränderlig/)
    await expect(
      getPool().query(`DELETE FROM public.dimension_retag_log WHERE id = $1`, [rows[0].id]),
    ).rejects.toThrow(/oföränderlig/)
  })

  it('leaves the gnubok.allow_delete bulk-delete path unaffected', async () => {
    const { companyId, userId, fiscalPeriodId } = await seedCompany()
    const { entryId, lineId } = await insertPostedTaggedEntry({ companyId, userId, fiscalPeriodId })

    const client = await getPool().connect()
    try {
      await client.query('BEGIN')
      await client.query(`SELECT set_config('gnubok.allow_delete', 'true', true)`)
      // Full bypass still deletes posted lines + entries (undo/replace flows).
      await client.query(`DELETE FROM public.journal_entry_lines WHERE id = $1`, [lineId])
      await client.query(`DELETE FROM public.journal_entries WHERE id = $1`, [entryId])
      await client.query('ROLLBACK')
    } finally {
      client.release()
    }
  })
})

// The error a rejected query carries, for assertions on SQLSTATE and text.
async function rejectionOf(query: Promise<unknown>): Promise<{ code?: string; message: string }> {
  try {
    await query
  } catch (err) {
    return err as { code?: string; message: string }
  }
  throw new Error('expected the query to be rejected')
}

describe('retag actor attribution and carve-out scope (20260928200000)', () => {
  // Owner plus a second writer (role 'member'), two active values, one
  // posted untagged line.
  async function seedTwoWriters() {
    const seeded = await seedCompany()
    const memberId = await insertAuthUser()
    await insertCompanyMember({ companyId: seeded.companyId, userId: memberId, role: 'member' })
    await insertRegistryValue({ companyId: seeded.companyId, sieDimNo: 6, code: 'P001' })
    await insertRegistryValue({ companyId: seeded.companyId, sieDimNo: 6, code: 'P002' })
    const { lineId } = await insertPostedTaggedEntry({
      companyId: seeded.companyId,
      userId: seeded.userId,
      fiscalPeriodId: seeded.fiscalPeriodId,
    })
    return { ...seeded, memberId, lineId }
  }

  it('refuses a signed-in writer who names another member as the actor', async () => {
    const { companyId, userId: ownerId, memberId, lineId } = await seedTwoWriters()

    const err = await withUserContext(memberId, (client) =>
      rejectionOf(
        client.query(
          `SELECT public.retag_line_dimensions($1::uuid, $2::uuid, $3::jsonb, $4, $5::uuid)`,
          [companyId, lineId, '{"6":"P001"}', 'Förfalskad utförare', ownerId],
        ),
      ),
    )
    expect(err.code).toBe('42501')
    expect(err.message).toMatch(/annan användare/)

    // Nothing was logged or written under anyone's name.
    const { rows: log } = await getPool().query(
      `SELECT 1 FROM public.dimension_retag_log WHERE line_id = $1`,
      [lineId],
    )
    expect(log).toHaveLength(0)
    expect((await lineState(lineId)).dimensions).toEqual({})
  })

  it('refuses a viewer who borrows a writer id at the actor check, before any write', async () => {
    const { companyId, userId: ownerId, lineId } = await seedTwoWriters()
    const viewerId = await insertAuthUser()
    await insertCompanyMember({ companyId, userId: viewerId, role: 'viewer' })

    // Before the pin the borrowed id passed the RPC's own writer gate and
    // only the line's writer-role trigger (20260902093000) stopped the
    // UPDATE; now the RPC refuses the borrowed identity itself.
    const err = await withUserContext(viewerId, (client) =>
      rejectionOf(
        client.query(
          `SELECT public.retag_line_dimensions($1::uuid, $2::uuid, $3::jsonb, $4, $5::uuid)`,
          [companyId, lineId, '{"6":"P001"}', 'Lånad behörighet', ownerId],
        ),
      ),
    )
    expect(err.code).toBe('42501')
    expect(err.message).toMatch(/annan användare/)
    expect((await lineState(lineId)).dimensions).toEqual({})
  })

  it('logs the signed-in caller as the actor for its own id and for NULL', async () => {
    const { companyId, memberId, lineId } = await seedTwoWriters()

    await withUserContext(memberId, async (client) => {
      const own = await client.query<{ result: { changed: boolean } }>(
        `SELECT public.retag_line_dimensions($1::uuid, $2::uuid, $3::jsonb, $4, $5::uuid) AS result`,
        [companyId, lineId, '{"6":"P001"}', 'Eget användar-id', memberId],
      )
      expect(own.rows[0].result.changed).toBe(true)

      const withoutId = await client.query<{ result: { changed: boolean } }>(
        `SELECT public.retag_line_dimensions($1::uuid, $2::uuid, $3::jsonb, $4) AS result`,
        [companyId, lineId, '{"6":"P002"}', 'Utan användar-id'],
      )
      expect(withoutId.rows[0].result.changed).toBe(true)

      const { rows } = await client.query<{ reason: string; actor: string }>(
        `SELECT reason, actor FROM public.dimension_retag_log WHERE line_id = $1 ORDER BY reason`,
        [lineId],
      )
      expect(rows).toEqual([
        { reason: 'Eget användar-id', actor: memberId },
        { reason: 'Utan användar-id', actor: memberId },
      ])
    })
  })

  it('keeps p_user_id for a service-role caller (the MCP approval path)', async () => {
    const { companyId, memberId, lineId } = await seedTwoWriters()

    await runAsServiceRole((client) =>
      client.query(
        `SELECT public.retag_line_dimensions($1::uuid, $2::uuid, $3::jsonb, $4, $5::uuid)`,
        [companyId, lineId, '{"6":"P001"}', 'Godkänd via MCP', memberId],
      ),
    )

    const { rows } = await getPool().query(
      `SELECT actor FROM public.dimension_retag_log WHERE line_id = $1`,
      [lineId],
    )
    expect(rows).toEqual([{ actor: memberId }])
  })

  it('closes the carve-out flag right after its own UPDATE', async () => {
    const { companyId, userId, fiscalPeriodId } = await seedCompany()
    await insertRegistryValue({ companyId, sieDimNo: 6, code: 'P001' })
    const { lineId } = await insertPostedTaggedEntry({ companyId, userId, fiscalPeriodId })
    const { lineId: otherLineId } = await insertPostedTaggedEntry({
      companyId, userId, fiscalPeriodId, voucherNumber: 2,
    })

    const client = await getPool().connect()
    try {
      await client.query('BEGIN')
      await client.query(
        `SELECT public.retag_line_dimensions($1::uuid, $2::uuid, $3::jsonb, $4, $5::uuid)`,
        [companyId, lineId, '{"6":"P001"}', 'Loggad ändring', userId],
      )
      const { rows } = await client.query<{ flag: string | null }>(
        `SELECT current_setting('gnubok.allow_dimension_retag', true) AS flag`,
      )
      expect(rows[0].flag).toBe('false')

      // A direct, unlogged UPDATE later in the same transaction is blocked
      // again instead of riding the retag's carve-out.
      await expect(
        client.query(
          `UPDATE public.journal_entry_lines SET dimensions = '{"6":"P001"}'::jsonb WHERE id = $1`,
          [otherLineId],
        ),
      ).rejects.toThrow(/Cannot UPDATE lines of a posted journal entry/)
    } finally {
      await client.query('ROLLBACK').catch(() => {})
      client.release()
    }
  })
})

describe('line bag CHECK behind the registry lookup (20260928200200)', () => {
  it('refuses a non-string value at the UPDATE even when the registry lookup passes', async () => {
    const { companyId, userId, fiscalPeriodId } = await seedCompany()
    await insertRegistryValue({ companyId, sieDimNo: 1, code: '5' })
    const { lineId } = await insertPostedTaggedEntry({
      companyId, userId, fiscalPeriodId,
      dimensions: { '6': 'GAMMAL' },
    })

    // jsonb_each_text turns the JSON number 5 into the registered code '5',
    // so only the line CHECK stands between this bag and the ledger.
    await expect(
      getPool().query(
        `SELECT public.retag_line_dimensions($1::uuid, $2::uuid, '{"1":5}'::jsonb, 'Numeriskt värde', $3::uuid)`,
        [companyId, lineId, userId],
      ),
    ).rejects.toThrow(/jel_dimensions_well_formed/)

    expect((await lineState(lineId)).dimensions).toEqual({ '6': 'GAMMAL' })
    const { rows } = await getPool().query(
      `SELECT 1 FROM public.dimension_retag_log WHERE line_id = $1`,
      [lineId],
    )
    expect(rows).toHaveLength(0)
  })
})
