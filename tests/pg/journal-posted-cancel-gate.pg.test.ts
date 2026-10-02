import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import type { PoolClient } from 'pg'
import { getClient, getPool, runAsServiceRole, withUserContext } from './setup'
import { insertAuthUser, insertCompanyMember, seedCompany } from './fixtures'

// Migration 20260929220100_gate_posted_cancel.sql.
//
// posted -> cancelled used to be open to every company writer, and the lines
// of a cancelled entry could then be deleted. The migration adds two BEFORE
// triggers (the migration-017 enforcement functions are untouched) and one
// sanctioned door, cancel_orphaned_entry(), for the compensation cleanups of
// failed multi-step workflows.

interface Seeded {
  userId: string
  companyId: string
  fiscalPeriodId: string
}

async function setActiveCompany(userId: string, companyId: string): Promise<void> {
  await getPool().query(
    `INSERT INTO public.user_preferences (user_id, active_company_id)
     VALUES ($1, $2)
     ON CONFLICT (user_id) DO UPDATE SET active_company_id = EXCLUDED.active_company_id`,
    [userId, companyId],
  )
}

// Attach the company to a team where the user holds `role`: the
// voucher_gap_explanations INSERT policy admits team owners/admins only.
async function joinCompanyTeam(s: Seeded, userId: string, role: 'owner' | 'admin' | 'member'): Promise<void> {
  const { rows } = await getPool().query<{ team_id: string | null }>(
    `SELECT team_id FROM public.companies WHERE id = $1`,
    [s.companyId],
  )
  let teamId = rows[0]?.team_id ?? null
  if (!teamId) {
    teamId = randomUUID()
    await getPool().query(`INSERT INTO public.teams (id, name, created_by) VALUES ($1, 'Team', $2)`, [teamId, s.userId])
    await getPool().query(`UPDATE public.companies SET team_id = $1 WHERE id = $2`, [teamId, s.companyId])
  }
  await getPool().query(
    `INSERT INTO public.team_members (team_id, user_id, role) VALUES ($1, $2, $3)`,
    [teamId, userId, role],
  )
}

async function seed(): Promise<Seeded> {
  const seeded = await seedCompany()
  await setActiveCompany(seeded.userId, seeded.companyId)
  return seeded
}

// Draft with two balanced lines, then draft -> posted, all as the trusted
// superuser connection. committed_at is stamped now() unless a preset is
// given (set_committed_at keeps a trusted writer's preset).
async function postEntry(
  s: Seeded,
  params: {
    voucherNumber: number
    userId?: string
    sourceType?: string
    reversesId?: string
    correctionOfId?: string
    committedAt?: string
    entryDate?: string
    post?: boolean
  },
): Promise<string> {
  const id = randomUUID()
  const client = await getClient()
  try {
    await client.query('BEGIN')
    await client.query(
      `INSERT INTO public.journal_entries
         (id, user_id, company_id, fiscal_period_id, voucher_number, voucher_series,
          entry_date, description, source_type, status, reverses_id, correction_of_id, committed_at)
       VALUES ($1, $2, $3, $4, $5, 'A', $6, 'Testverifikat', $7, 'draft', $8, $9, $10::timestamptz)`,
      [
        id,
        params.userId ?? s.userId,
        s.companyId,
        s.fiscalPeriodId,
        params.voucherNumber,
        params.entryDate ?? '2026-06-01',
        params.sourceType ?? 'manual',
        params.reversesId ?? null,
        params.correctionOfId ?? null,
        params.committedAt ?? null,
      ],
    )
    await client.query(
      `INSERT INTO public.journal_entry_lines
         (journal_entry_id, account_number, debit_amount, credit_amount)
       VALUES ($1, '1930', 1000, 0), ($1, '3001', 0, 1000)`,
      [id],
    )
    if (params.post !== false) {
      await client.query(`UPDATE public.journal_entries SET status = 'posted' WHERE id = $1`, [id])
    }
    await client.query('COMMIT')
    return id
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {})
    throw error
  } finally {
    client.release()
  }
}

async function entryState(entryId: string): Promise<{ status: string; lines: number }> {
  const { rows } = await getPool().query<{ status: string; lines: string }>(
    `SELECT je.status,
            (SELECT count(*) FROM public.journal_entry_lines l WHERE l.journal_entry_id = je.id) AS lines
       FROM public.journal_entries je WHERE je.id = $1`,
    [entryId],
  )
  return { status: rows[0].status, lines: Number(rows[0].lines) }
}

type RpcResult = {
  cancelled: boolean
  previous_status: string
  gap_recorded: boolean
  voucher_number?: number
}

// Trusted caller (no JWT claims: the superuser connection), acting as p_user_id.
async function cancelAsTrusted(
  companyId: string,
  entryId: string,
  userId: string | null,
  explanation: string | null = null,
): Promise<RpcResult> {
  const { rows } = await getPool().query<{ r: RpcResult }>(
    `SELECT public.cancel_orphaned_entry($1::uuid, $2::uuid, $3::uuid, $4) AS r`,
    [companyId, entryId, userId, explanation],
  )
  return rows[0].r
}

describe('posted -> cancelled gate (guard_posted_cancel)', () => {
  it('refuses a company writer cancelling an ordinary posted verifikat', async () => {
    const s = await seed()
    const entryId = await postEntry(s, { voucherNumber: 1 })

    await withUserContext(s.userId, async (client) => {
      // Visible and writable under RLS, so a refusal is the gate, not a
      // silently filtered zero-row update.
      const visible = await client.query(`SELECT 1 FROM public.journal_entries WHERE id = $1`, [entryId])
      expect(visible.rowCount).toBe(1)
      await expect(
        client.query(`UPDATE public.journal_entries SET status = 'cancelled' WHERE id = $1`, [entryId]),
      ).rejects.toMatchObject({ code: '42501', message: expect.stringMatching(/Cannot cancel a posted journal entry/) })
    })
    // Cancelling together with another field change stays refused too (the
    // full-row lock of 20260915140000 fires first, the gate behind it).
    await withUserContext(s.userId, async (client) => {
      await expect(
        client.query(
          `UPDATE public.journal_entries SET status = 'cancelled', description = 'tampered' WHERE id = $1`,
          [entryId],
        ),
      ).rejects.toThrow(/Cannot modify fields of a posted entry during cancellation|Cannot cancel a posted journal entry/)
    })
    expect(await entryState(entryId)).toEqual({ status: 'posted', lines: 2 })
  })

  it('refuses the direct cancel for service_role and the superuser too', async () => {
    const s = await seed()
    const entryId = await postEntry(s, { voucherNumber: 1 })

    await expect(
      runAsServiceRole((client) =>
        client.query(`UPDATE public.journal_entries SET status = 'cancelled' WHERE id = $1`, [entryId]),
      ),
    ).rejects.toThrow(/Cannot cancel a posted journal entry/)
    await expect(
      getPool().query(`UPDATE public.journal_entries SET status = 'cancelled' WHERE id = $1`, [entryId]),
    ).rejects.toThrow(/Cannot cancel a posted journal entry/)
    expect(await entryState(entryId)).toEqual({ status: 'posted', lines: 2 })
  })

  it('keeps the full-row field lock even when the sanctioned GUC is set', async () => {
    const s = await seed()
    const entryId = await postEntry(s, { voucherNumber: 1 })
    const client = await getClient()
    try {
      await client.query('BEGIN')
      await client.query(`SELECT set_config('gnubok.allow_posted_cancel', 'true', true)`)
      await expect(
        client.query(
          `UPDATE public.journal_entries SET status = 'cancelled', description = 'tampered' WHERE id = $1`,
          [entryId],
        ),
      ).rejects.toThrow(/Cannot modify fields of a posted entry during cancellation/)
    } finally {
      await client.query('ROLLBACK').catch(() => {})
      client.release()
    }
  })

  it('leaves draft -> cancelled open to a writer, and the cancelled draft lines deletable', async () => {
    const s = await seed()
    const draftId = await postEntry(s, { voucherNumber: 0, post: false })

    await withUserContext(s.userId, async (client) => {
      const cancel = await client.query(
        `UPDATE public.journal_entries SET status = 'cancelled' WHERE id = $1 AND status = 'draft'`,
        [draftId],
      )
      expect(cancel.rowCount).toBe(1)
      const del = await client.query(`DELETE FROM public.journal_entry_lines WHERE journal_entry_id = $1`, [draftId])
      expect(del.rowCount).toBe(2)
    })
  })
})

describe('line retention on cancelled, once-posted entries (guard_posted_entry_line_delete)', () => {
  it('refuses deleting the lines of a cancelled verifikat that was posted, for a writer and the superuser', async () => {
    const s = await seed()
    const entryId = await postEntry(s, { voucherNumber: 1 })
    await cancelAsTrusted(s.companyId, entryId, s.userId)
    expect(await entryState(entryId)).toEqual({ status: 'cancelled', lines: 2 })

    await withUserContext(s.userId, async (client) => {
      await expect(
        client.query(`DELETE FROM public.journal_entry_lines WHERE journal_entry_id = $1`, [entryId]),
      ).rejects.toMatchObject({ code: '42501', message: expect.stringMatching(/retained accounting records/) })
    })
    await expect(
      getPool().query(`DELETE FROM public.journal_entry_lines WHERE journal_entry_id = $1`, [entryId]),
    ).rejects.toThrow(/retained accounting records/)
    expect(await entryState(entryId)).toEqual({ status: 'cancelled', lines: 2 })
  })

  it('still lets the gnubok.allow_delete teardown paths remove the entry and its lines', async () => {
    const s = await seed()
    const entryId = await postEntry(s, { voucherNumber: 1 })
    await cancelAsTrusted(s.companyId, entryId, s.userId)

    const client = await getClient()
    try {
      await client.query('BEGIN')
      await client.query(`SELECT set_config('gnubok.allow_delete', 'true', true)`)
      const lines = await client.query(`DELETE FROM public.journal_entry_lines WHERE journal_entry_id = $1`, [entryId])
      expect(lines.rowCount).toBe(2)
      const entry = await client.query(`DELETE FROM public.journal_entries WHERE id = $1`, [entryId])
      expect(entry.rowCount).toBe(1)
    } finally {
      await client.query('ROLLBACK').catch(() => {})
      client.release()
    }
  })
})

describe('cancel_orphaned_entry: the sanctioned cleanup door', () => {
  it('cancels a fresh orphan reversal for its authenticated creator and keeps its lines', async () => {
    const s = await seed()
    const originalId = await postEntry(s, { voucherNumber: 1 })
    // reverseEntry lost the CAS: the storno is posted, the original is not
    // marked reversed and does not point at it.
    const stornoId = await postEntry(s, { voucherNumber: 2, sourceType: 'storno', reversesId: originalId })

    await withUserContext(s.userId, async (client) => {
      const { rows } = await client.query<{ r: RpcResult }>(
        `SELECT public.cancel_orphaned_entry($1::uuid, $2::uuid) AS r`,
        [s.companyId, stornoId],
      )
      expect(rows[0].r).toMatchObject({ cancelled: true, previous_status: 'posted', gap_recorded: false })
      const state = await client.query<{ status: string; lines: string }>(
        `SELECT je.status, (SELECT count(*) FROM public.journal_entry_lines l WHERE l.journal_entry_id = je.id) AS lines
           FROM public.journal_entries je WHERE je.id = $1`,
        [stornoId],
      )
      expect(state.rows[0]).toEqual({ status: 'cancelled', lines: '2' })
    })
  })

  it('cancels a payment orphan and writes its gap explanation in the same transaction', async () => {
    const s = await seed()
    await joinCompanyTeam(s, s.userId, 'owner')
    const paymentId = await postEntry(s, { voucherNumber: 5, sourceType: 'supplier_invoice_paid' })

    await withUserContext(s.userId, async (client) => {
      const { rows } = await client.query<{ r: RpcResult }>(
        `SELECT public.cancel_orphaned_entry($1::uuid, $2::uuid, NULL, $3) AS r`,
        [s.companyId, paymentId, 'Automatiskt makulerad: dubblettbokning förhindrad av samtidighetsskydd'],
      )
      expect(rows[0].r).toMatchObject({ cancelled: true, previous_status: 'posted', gap_recorded: true, voucher_number: 5 })
      const gaps = await client.query<{ user_id: string; voucher_series: string; gap_start: number; gap_end: number; explanation: string }>(
        `SELECT user_id, voucher_series, gap_start, gap_end, explanation
           FROM public.voucher_gap_explanations WHERE company_id = $1`,
        [s.companyId],
      )
      expect(gaps.rows).toEqual([
        {
          user_id: s.userId,
          voucher_series: 'A',
          gap_start: 5,
          gap_end: 5,
          explanation: 'Automatiskt makulerad: dubblettbokning förhindrad av samtidighetsskydd',
        },
      ])
    })
  })

  it('cancels for a writer who may not author gap explanations, but skips the note', async () => {
    // The definer insert must not widen voucher_gap_explanations authorship
    // beyond its RLS (team owner/admin). The cancelled header still occupies
    // the number, so no gap opens either way.
    const s = await seed()
    const colleague = await insertAuthUser()
    await insertCompanyMember({ companyId: s.companyId, userId: colleague, role: 'member' })
    await setActiveCompany(colleague, s.companyId)
    await joinCompanyTeam(s, colleague, 'member')
    const paymentId = await postEntry(s, { voucherNumber: 5, userId: colleague, sourceType: 'supplier_invoice_paid' })

    await withUserContext(colleague, async (client) => {
      const { rows } = await client.query<{ r: RpcResult }>(
        `SELECT public.cancel_orphaned_entry($1::uuid, $2::uuid, NULL, $3) AS r`,
        [s.companyId, paymentId, 'Fritext från en skribent'],
      )
      expect(rows[0].r).toMatchObject({ cancelled: true, previous_status: 'posted', gap_recorded: false })
      // withUserContext rolls back, so read the outcome inside it.
      const state = await client.query<{ status: string }>(`SELECT status FROM public.journal_entries WHERE id = $1`, [paymentId])
      expect(state.rows[0]!.status).toBe('cancelled')
      const gaps = await client.query(`SELECT 1 FROM public.voucher_gap_explanations WHERE company_id = $1`, [s.companyId])
      expect(gaps.rowCount).toBe(0)
    })
    const gaps = await getPool().query(`SELECT 1 FROM public.voucher_gap_explanations WHERE company_id = $1`, [s.companyId])
    expect(gaps.rowCount).toBe(0)
  })

  it('keeps an existing explanation for the number and reports gap_recorded false', async () => {
    const s = await seed()
    const paymentId = await postEntry(s, { voucherNumber: 5, sourceType: 'supplier_invoice_paid' })
    await getPool().query(
      `INSERT INTO public.voucher_gap_explanations
         (company_id, user_id, fiscal_period_id, voucher_series, gap_start, gap_end, explanation)
       VALUES ($1, $2, $3, 'A', 5, 5, 'Manuell förklaring')`,
      [s.companyId, s.userId, s.fiscalPeriodId],
    )

    expect(
      await cancelAsTrusted(s.companyId, paymentId, s.userId, 'Automatiskt makulerad: test'),
    ).toMatchObject({ cancelled: true, previous_status: 'posted', gap_recorded: false })
    const gaps = await getPool().query<{ explanation: string }>(
      `SELECT explanation FROM public.voucher_gap_explanations WHERE company_id = $1`,
      [s.companyId],
    )
    expect(gaps.rows).toEqual([{ explanation: 'Manuell förklaring' }])
    expect(await entryState(paymentId)).toEqual({ status: 'cancelled', lines: 2 })
  })

  it('cancels a storno the user posted in the engine\'s own authenticated shape', async () => {
    // reverseEntry and correctEntry post with a direct UPDATE under the
    // user's JWT, not through commit_journal_entry. set_committed_at must
    // stamp committed_at on that path, or the 15-minute check would strand
    // every such orphan posted and double-counted.
    const s = await seed()
    // Outside the sequence range the user draws from below.
    const originalId = await postEntry(s, { voucherNumber: 100 })

    await withUserContext(s.userId, async (client) => {
      const n = await client.query<{ n: number }>(
        `SELECT public.next_voucher_number($1, $2, 'A') AS n`,
        [s.companyId, s.fiscalPeriodId],
      )
      const header = await client.query<{ id: string }>(
        `INSERT INTO public.journal_entries
           (user_id, company_id, fiscal_period_id, voucher_number, voucher_series, entry_date,
            description, source_type, reverses_id, status)
         VALUES ($1, $2, $3, $4, 'A', '2026-06-01', 'Makulering: Testverifikat', 'storno', $5, 'draft')
         RETURNING id`,
        [s.userId, s.companyId, s.fiscalPeriodId, n.rows[0]!.n, originalId],
      )
      const stornoId = header.rows[0]!.id
      await client.query(
        `INSERT INTO public.journal_entry_lines (journal_entry_id, account_number, debit_amount, credit_amount)
         VALUES ($1, '3001', 1000, 0), ($1, '1930', 0, 1000)`,
        [stornoId],
      )
      const posted = await client.query<{ status: string; committed_at: Date | null }>(
        `UPDATE public.journal_entries SET status = 'posted' WHERE id = $1 RETURNING status, committed_at`,
        [stornoId],
      )
      expect(posted.rows[0]!.status).toBe('posted')
      expect(posted.rows[0]!.committed_at).not.toBeNull()

      // The CAS on the original was lost: clean up as the same user.
      const { rows } = await client.query<{ r: RpcResult }>(
        `SELECT public.cancel_orphaned_entry($1::uuid, $2::uuid) AS r`,
        [s.companyId, stornoId],
      )
      expect(rows[0]!.r).toMatchObject({ cancelled: true, previous_status: 'posted' })
      const state = await client.query<{ status: string; lines: string }>(
        `SELECT je.status, (SELECT count(*) FROM public.journal_entry_lines l WHERE l.journal_entry_id = je.id) AS lines
           FROM public.journal_entries je WHERE je.id = $1`,
        [stornoId],
      )
      expect(state.rows[0]).toEqual({ status: 'cancelled', lines: '2' })
    })
    expect(await entryState(originalId)).toEqual({ status: 'posted', lines: 2 })
  })

  it('works for service_role acting as p_user_id, and refuses service_role without an actor', async () => {
    const s = await seed()
    const entryId = await postEntry(s, { voucherNumber: 1 })

    await expect(
      runAsServiceRole((client) =>
        client.query(`SELECT public.cancel_orphaned_entry($1::uuid, $2::uuid) AS r`, [s.companyId, entryId]),
      ),
    ).rejects.toMatchObject({ code: '22023', message: expect.stringMatching(/p_user_id is required/) })

    const result = await runAsServiceRole(async (client) => {
      const { rows } = await client.query<{ r: RpcResult }>(
        `SELECT public.cancel_orphaned_entry($1::uuid, $2::uuid, $3::uuid) AS r`,
        [s.companyId, entryId, s.userId],
      )
      return rows[0].r
    })
    expect(result).toMatchObject({ cancelled: true, previous_status: 'posted' })
    expect(await entryState(entryId)).toEqual({ status: 'cancelled', lines: 2 })
  })

  it('is never stricter than commit_journal_entry for a backend caller (no membership row needed)', async () => {
    // commit_journal_entry lets service_role post for any user by design, so
    // an orphan it posted must be cleanable by the same backend: a membership
    // check here would strand it posted and double-counted.
    const s = await seed()
    const formerMember = await insertAuthUser()
    const entryId = await postEntry(s, { voucherNumber: 1, userId: formerMember })

    const result = await runAsServiceRole(async (client) => {
      const { rows } = await client.query<{ r: RpcResult }>(
        `SELECT public.cancel_orphaned_entry($1::uuid, $2::uuid, $3::uuid) AS r`,
        [s.companyId, entryId, formerMember],
      )
      return rows[0].r
    })
    expect(result).toMatchObject({ cancelled: true, previous_status: 'posted' })
  })

  it('resets the sanctioned flag before returning, so the caller transaction gains nothing', async () => {
    const s = await seed()
    const orphanId = await postEntry(s, { voucherNumber: 1 })
    const ordinaryId = await postEntry(s, { voucherNumber: 2 })

    await withUserContext(s.userId, async (client) => {
      await client.query(`SELECT public.cancel_orphaned_entry($1::uuid, $2::uuid)`, [s.companyId, orphanId])
      await expect(
        client.query(`UPDATE public.journal_entries SET status = 'cancelled' WHERE id = $1`, [ordinaryId]),
      ).rejects.toMatchObject({ code: '42501', message: expect.stringMatching(/Cannot cancel a posted journal entry/) })
    })
    expect(await entryState(ordinaryId)).toEqual({ status: 'posted', lines: 2 })
  })

  it('ignores a p_user_id passed by an authenticated caller (no acting as the creator)', async () => {
    const s = await seed()
    const colleague = await insertAuthUser()
    await insertCompanyMember({ companyId: s.companyId, userId: colleague, role: 'member' })
    await setActiveCompany(colleague, s.companyId)
    const entryId = await postEntry(s, { voucherNumber: 1 })

    await withUserContext(colleague, async (client) => {
      await expect(
        client.query(`SELECT public.cancel_orphaned_entry($1::uuid, $2::uuid, $3::uuid) AS r`, [
          s.companyId,
          entryId,
          s.userId,
        ]),
      ).rejects.toMatchObject({ code: '42501', message: expect.stringMatching(/not created by the acting user/) })
    })
    expect(await entryState(entryId)).toEqual({ status: 'posted', lines: 2 })
  })

  it('refuses another user\'s entry even for a trusted caller', async () => {
    const s = await seed()
    const colleague = await insertAuthUser()
    await insertCompanyMember({ companyId: s.companyId, userId: colleague, role: 'member' })
    const entryId = await postEntry(s, { voucherNumber: 1 })

    await expect(cancelAsTrusted(s.companyId, entryId, colleague)).rejects.toThrow(/not created by the acting user/)
    expect(await entryState(entryId)).toEqual({ status: 'posted', lines: 2 })
  })

  it('refuses the creator of a draft that a colleague posted', async () => {
    // user_id is only the creator: the posting actor (committed_by) must be
    // the acting user too, or a writer could void a colleague's fresh post.
    const s = await seed()
    const colleague = await insertAuthUser()
    await insertCompanyMember({ companyId: s.companyId, userId: colleague, role: 'member' })
    await setActiveCompany(colleague, s.companyId)

    // One transaction that switches the JWT user in between (withUserContext
    // rolls back on exit, so the post would not survive to a second context).
    const actAs = async (client: PoolClient, userId: string) => {
      await client.query('RESET ROLE')
      await client.query(`SELECT set_config('request.jwt.claims', $1, true)`, [
        JSON.stringify({ sub: userId, role: 'authenticated' }),
      ])
      await client.query(`SELECT set_config('request.jwt.claim.sub', $1, true)`, [userId])
      await client.query('SET LOCAL ROLE authenticated')
    }
    const client = await getClient()
    try {
      await client.query('BEGIN')
      await actAs(client, s.userId)
      const n = await client.query<{ n: number }>(
        `SELECT public.next_voucher_number($1, $2, 'A') AS n`,
        [s.companyId, s.fiscalPeriodId],
      )
      const header = await client.query<{ id: string }>(
        `INSERT INTO public.journal_entries
           (user_id, company_id, fiscal_period_id, voucher_number, voucher_series, entry_date,
            description, source_type, status)
         VALUES ($1, $2, $3, $4, 'A', '2026-06-01', 'Testverifikat', 'manual', 'draft')
         RETURNING id`,
        [s.userId, s.companyId, s.fiscalPeriodId, n.rows[0]!.n],
      )
      const entryId = header.rows[0]!.id
      await client.query(
        `INSERT INTO public.journal_entry_lines (journal_entry_id, account_number, debit_amount, credit_amount)
         VALUES ($1, '1930', 1000, 0), ($1, '3001', 0, 1000)`,
        [entryId],
      )

      await actAs(client, colleague)
      const posted = await client.query<{ committed_by: string }>(
        `UPDATE public.journal_entries SET status = 'posted' WHERE id = $1 RETURNING committed_by`,
        [entryId],
      )
      expect(posted.rows[0]!.committed_by).toBe(colleague)

      await actAs(client, s.userId)
      await client.query('SAVEPOINT refused')
      await expect(
        client.query(`SELECT public.cancel_orphaned_entry($1::uuid, $2::uuid) AS r`, [s.companyId, entryId]),
      ).rejects.toMatchObject({ code: '42501', message: expect.stringMatching(/not posted by the acting user/) })
      await client.query('ROLLBACK TO SAVEPOINT refused')

      // A trusted backend acting for the creator is refused the same way.
      await client.query('RESET ROLE')
      await client.query(`SELECT set_config('request.jwt.claims', '', true)`)
      await client.query(`SELECT set_config('request.jwt.claim.sub', '', true)`)
      await client.query('SAVEPOINT trusted')
      await expect(
        client.query(`SELECT public.cancel_orphaned_entry($1::uuid, $2::uuid, $3::uuid) AS r`, [
          s.companyId,
          entryId,
          s.userId,
        ]),
      ).rejects.toThrow(/not posted by the acting user/)
      await client.query('ROLLBACK TO SAVEPOINT trusted')

      const state = await client.query<{ status: string }>(`SELECT status FROM public.journal_entries WHERE id = $1`, [entryId])
      expect(state.rows[0]!.status).toBe('posted')
    } finally {
      await client.query('ROLLBACK').catch(() => {})
      client.release()
    }
  })

  it('stamps committed_by only on draft -> posted and freezes it afterwards', async () => {
    const s = await seed()
    const colleague = await insertAuthUser()
    await insertCompanyMember({ companyId: s.companyId, userId: colleague, role: 'member' })
    await setActiveCompany(colleague, s.companyId)

    // A preset on a draft insert is discarded.
    const draftId = randomUUID()
    await getPool().query(
      `INSERT INTO public.journal_entries
         (id, user_id, company_id, fiscal_period_id, voucher_number, voucher_series,
          entry_date, description, source_type, status, committed_by)
       VALUES ($1, $2, $3, $4, 0, 'A', '2026-06-01', 'Utkast', 'manual', 'draft', $5)`,
      [draftId, s.userId, s.companyId, s.fiscalPeriodId, colleague],
    )
    const draft = await getPool().query<{ committed_by: string | null }>(
      `SELECT committed_by FROM public.journal_entries WHERE id = $1`,
      [draftId],
    )
    expect(draft.rows[0]!.committed_by).toBeNull()

    // A trusted backend post acts for the entry's user.
    const entryId = await postEntry(s, { voucherNumber: 1 })
    const read = async () =>
      (
        await getPool().query<{ committed_by: string | null }>(
          `SELECT committed_by FROM public.journal_entries WHERE id = $1`,
          [entryId],
        )
      ).rows[0]!.committed_by
    expect(await read()).toBe(s.userId)

    // A committed entry's committed_by cannot be rewritten: the whole-row
    // immutability lock refuses it next to a notes change...
    await withUserContext(colleague, async (client) => {
      await expect(
        client.query(
          `UPDATE public.journal_entries SET notes = 'anteckning', committed_by = $1 WHERE id = $2`,
          [colleague, entryId],
        ),
      ).rejects.toThrow(/immutable/)
    })
    expect(await read()).toBe(s.userId)

    // ...and the stamp trigger discards it on the column-enumerated
    // posted -> reversed transition.
    const stornoId = await postEntry(s, { voucherNumber: 2, sourceType: 'storno', reversesId: entryId })
    await getPool().query(
      `UPDATE public.journal_entries SET status = 'reversed', reversed_by_id = $1, committed_by = $2 WHERE id = $3`,
      [stornoId, colleague, entryId],
    )
    expect(await read()).toBe(s.userId)
  })

  it('refuses an entry posted more than 15 minutes ago', async () => {
    const s = await seed()
    const entryId = await postEntry(s, {
      voucherNumber: 1,
      committedAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
    })

    await expect(cancelAsTrusted(s.companyId, entryId, s.userId)).rejects.toMatchObject({
      code: '55000',
      message: expect.stringMatching(/not posted within the last 15 minutes/),
    })
    expect(await entryState(entryId)).toEqual({ status: 'posted', lines: 2 })
  })

  it('refuses an entry that a live correction references', async () => {
    const s = await seed()
    const entryId = await postEntry(s, { voucherNumber: 1 })
    await postEntry(s, { voucherNumber: 2, sourceType: 'correction', correctionOfId: entryId })

    await expect(cancelAsTrusted(s.companyId, entryId, s.userId)).rejects.toThrow(/referenced by another verifikat/)
    expect(await entryState(entryId)).toEqual({ status: 'posted', lines: 2 })
  })

  it('refuses a reversal the original already points at (an ambiguous CAS error that did land)', async () => {
    const s = await seed()
    const originalId = await postEntry(s, { voucherNumber: 1 })
    const stornoId = await postEntry(s, { voucherNumber: 2, sourceType: 'storno', reversesId: originalId })
    await getPool().query(
      `UPDATE public.journal_entries SET status = 'reversed', reversed_by_id = $1 WHERE id = $2`,
      [stornoId, originalId],
    )

    await expect(cancelAsTrusted(s.companyId, stornoId, s.userId)).rejects.toThrow(/referenced by another verifikat/)
    expect(await entryState(stornoId)).toEqual({ status: 'posted', lines: 2 })
  })

  it('refuses in a locked period and behind the company lock date', async () => {
    const locked = await seed()
    const lockedEntry = await postEntry(locked, { voucherNumber: 1 })
    await getPool().query(`UPDATE public.fiscal_periods SET locked_at = now() WHERE id = $1`, [locked.fiscalPeriodId])
    await expect(cancelAsTrusted(locked.companyId, lockedEntry, locked.userId)).rejects.toThrow(/closed or locked/)
    expect(await entryState(lockedEntry)).toEqual({ status: 'posted', lines: 2 })

    const behind = await seed()
    const behindEntry = await postEntry(behind, { voucherNumber: 1, entryDate: '2026-06-01' })
    await getPool().query(
      `INSERT INTO public.company_settings (user_id, company_id, bookkeeping_locked_through)
       VALUES ($1, $2, '2026-06-30')
       ON CONFLICT (company_id) DO UPDATE SET bookkeeping_locked_through = EXCLUDED.bookkeeping_locked_through`,
      [behind.userId, behind.companyId],
    )
    await expect(cancelAsTrusted(behind.companyId, behindEntry, behind.userId)).rejects.toThrow(/locked through/)
    expect(await entryState(behindEntry)).toEqual({ status: 'posted', lines: 2 })
  })

  it('refuses a viewer, a stranger and an entry of another company', async () => {
    const s = await seed()
    const entryId = await postEntry(s, { voucherNumber: 1 })

    const viewer = await insertAuthUser()
    await insertCompanyMember({ companyId: s.companyId, userId: viewer, role: 'viewer' })
    await setActiveCompany(viewer, s.companyId)
    await withUserContext(viewer, async (client) => {
      await expect(
        client.query(`SELECT public.cancel_orphaned_entry($1::uuid, $2::uuid) AS r`, [s.companyId, entryId]),
      ).rejects.toMatchObject({ code: '42501' })
    })

    const stranger = await seed()
    await withUserContext(stranger.userId, async (client) => {
      await expect(
        client.query(`SELECT public.cancel_orphaned_entry($1::uuid, $2::uuid) AS r`, [s.companyId, entryId]),
      ).rejects.toMatchObject({ code: '42501' })
    })
    // Own company id, foreign entry id: not found, never cancelled.
    await withUserContext(stranger.userId, async (client) => {
      await expect(
        client.query(`SELECT public.cancel_orphaned_entry($1::uuid, $2::uuid) AS r`, [stranger.companyId, entryId]),
      ).rejects.toMatchObject({ code: 'P0002' })
    })
    expect(await entryState(entryId)).toEqual({ status: 'posted', lines: 2 })
  })

  it('cancels a draft as it is and is idempotent on an already cancelled entry', async () => {
    const s = await seed()
    const draftId = await postEntry(s, { voucherNumber: 0, post: false })

    expect(await cancelAsTrusted(s.companyId, draftId, s.userId, 'ignored for drafts')).toMatchObject({
      cancelled: true,
      previous_status: 'draft',
      gap_recorded: false,
    })
    expect(await cancelAsTrusted(s.companyId, draftId, s.userId)).toMatchObject({
      cancelled: false,
      previous_status: 'cancelled',
    })
    const gaps = await getPool().query(`SELECT 1 FROM public.voucher_gap_explanations WHERE company_id = $1`, [s.companyId])
    expect(gaps.rowCount).toBe(0)
  })

  it('is not executable by anon', async () => {
    const { rows } = await getPool().query<{ granted: boolean }>(
      `SELECT has_function_privilege('anon', 'public.cancel_orphaned_entry(uuid, uuid, uuid, text)', 'EXECUTE') AS granted`,
    )
    expect(rows[0].granted).toBe(false)
  })
})
