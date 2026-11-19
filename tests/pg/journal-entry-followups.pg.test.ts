import { randomUUID } from 'node:crypto'
import { beforeAll, describe, expect, it } from 'vitest'
import { getClient, getPool, withUserContext } from './setup'
import { insertAuthUser, insertCompany, insertCompanyMember, insertFiscalPeriod, seedCompany } from './fixtures'

/**
 * journal_entry_followups (migration 20261028210100): one row per posted or
 * reversed journal entry with what happened to it after it was booked.
 *
 * Pinned here:
 *   (a) the view is security_invoker: a member of company A reads A's rows
 *       and none of company B's, and a stranger reads nothing;
 *   (b) the derivations: the decision that produced an entry, a storno
 *       reversal (reversed_at, days_to_reversal), inline rättelser (count,
 *       first), the VAT declaration of the period (monthly, quarterly,
 *       calendar and broken räkenskapsår periods; incomplete and dismissed
 *       deadlines do not count), and period lock and company lock date.
 *
 * Fixtures go through the posting paths: entries are posted by
 * commit_journal_entry, reversed the way reverseEntry() does it (a storno
 * draft with reverses_id, committed, then the original flipped to reversed),
 * and corrected inline by correct_entry_metadata. Nothing writes to a posted
 * entry outside those paths.
 */

interface FollowupRow {
  company_id: string
  journal_entry_id: string
  voucher_series: string
  voucher_number: number
  entry_date: string
  status: string
  source_type: string
  committed_at: Date | null
  committed_by: string | null
  committed_actor_type: string | null
  suggestion_log_id: string | null
  suggestion_kind: string | null
  suggestion_outcome: string | null
  suggestion_count: number
  pending_operation_id: string | null
  storno_journal_entry_id: string | null
  reversed_at: Date | null
  days_to_reversal: number | null
  replacement_journal_entry_id: string | null
  inline_correction_count: number
  first_inline_correction_at: Date | null
  vat_period_declared: boolean
  vat_declared_at: Date | null
  vat_declaration_source: string | null
  fiscal_period_id: string
  fiscal_period_closed: boolean
  fiscal_period_closed_at: Date | null
  fiscal_period_locked_at: Date | null
  company_lock_date: string | null
  covered_by_lock_date: boolean
}

const SELECT_FOLLOWUPS = `SELECT *, entry_date::text AS entry_date, company_lock_date::text AS company_lock_date
  FROM public.journal_entry_followups`

/** A balanced draft, posted by commit_journal_entry as the engine's commitEntry() does. */
async function postEntry(params: {
  companyId: string
  userId: string
  fiscalPeriodId: string
  entryDate: string
  description?: string
}): Promise<string> {
  const id = randomUUID()
  const client = await getClient()
  try {
    await client.query('BEGIN')
    await client.query(
      `INSERT INTO public.journal_entries
         (id, user_id, company_id, fiscal_period_id, voucher_number, voucher_series,
          entry_date, description, source_type, status)
       VALUES ($1, $2, $3, $4, 0, 'A', $5, $6, 'manual', 'draft')`,
      [id, params.userId, params.companyId, params.fiscalPeriodId, params.entryDate, params.description ?? 'Följduppgifter test'],
    )
    await client.query(
      `INSERT INTO public.journal_entry_lines
         (journal_entry_id, account_number, debit_amount, credit_amount, sort_order)
       VALUES ($1, '1930', 1000, 0, 0), ($1, '3001', 0, 1000, 1)`,
      [id],
    )
    await client.query(
      `SELECT * FROM public.commit_journal_entry($1::uuid, $2::uuid, 'user_accept', NULL, 'user', NULL)`,
      [params.companyId, id],
    )
    await client.query('COMMIT')
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {})
    throw error
  } finally {
    client.release()
  }
  return id
}

/**
 * Reverse an entry the way reverseEntry() does: a storno draft on the
 * original's date with reverses_id and the opposite sides, posted by
 * commit_journal_entry, then the original flipped posted -> reversed with
 * reversed_by_id (the compare-and-set step).
 */
async function reverseEntry(companyId: string, originalId: string): Promise<string> {
  const stornoId = randomUUID()
  const client = await getClient()
  try {
    await client.query('BEGIN')
    await client.query(
      `INSERT INTO public.journal_entries
         (id, user_id, company_id, fiscal_period_id, voucher_number, voucher_series,
          entry_date, description, source_type, reverses_id, status)
       SELECT $1, o.user_id, o.company_id, o.fiscal_period_id, 0, o.voucher_series,
              o.entry_date, 'Storno: ' || o.description, 'storno', o.id, 'draft'
         FROM public.journal_entries o
        WHERE o.id = $2 AND o.company_id = $3`,
      [stornoId, originalId, companyId],
    )
    await client.query(
      `INSERT INTO public.journal_entry_lines
         (journal_entry_id, account_number, debit_amount, credit_amount, sort_order)
       SELECT $1, l.account_number, l.credit_amount, l.debit_amount, l.sort_order
         FROM public.journal_entry_lines l
        WHERE l.journal_entry_id = $2`,
      [stornoId, originalId],
    )
    await client.query(
      `SELECT * FROM public.commit_journal_entry($1::uuid, $2::uuid, 'user_accept', NULL, 'user', NULL)`,
      [companyId, stornoId],
    )
    await client.query('COMMIT')
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {})
    throw error
  } finally {
    client.release()
  }
  const { rowCount } = await getPool().query(
    `UPDATE public.journal_entries SET status = 'reversed', reversed_by_id = $2
      WHERE id = $1 AND company_id = $3 AND status = 'posted'`,
    [originalId, stornoId, companyId],
  )
  expect(rowCount).toBe(1)
  return stornoId
}

/** Inline rättelse of the verifikationstext through the sanctioned RPC. */
async function correctDescription(companyId: string, entryId: string, description: string, userId: string) {
  const { rows } = await getPool().query<{ result: { changed: boolean } }>(
    `SELECT public.correct_entry_metadata($1::uuid, $2::uuid, $3, NULL::date, $4::uuid) AS result`,
    [companyId, entryId, description, userId],
  )
  expect(rows[0].result.changed).toBe(true)
}

async function insertVatDeadline(params: {
  companyId: string
  userId: string
  type: 'moms_monthly' | 'moms_quarterly' | 'moms_yearly'
  taxPeriod: string
  completedAt: string | null
  status: string
  dismissed?: boolean
}): Promise<void> {
  await getPool().query(
    `INSERT INTO public.deadlines
       (company_id, user_id, title, due_date, deadline_type, tax_deadline_type, tax_period,
        is_completed, completed_at, status, dismissed_at)
     VALUES ($1, $2, 'Momsdeklaration ' || $4::text, '2027-02-12', 'tax', $3, $4, $5, $6::timestamptz, $7,
             CASE WHEN $8::boolean THEN now() END)`,
    [
      params.companyId,
      params.userId,
      params.type,
      params.taxPeriod,
      params.completedAt !== null,
      params.completedAt,
      params.status,
      params.dismissed ?? false,
    ],
  )
}

async function insertOperationDecision(params: {
  companyId: string
  userId: string
  journalEntryId: string
  pendingOperationId: string
  outcome: 'manual' | 'changed'
  createdAt: string
}): Promise<string> {
  const changed = params.outcome === 'changed'
  const suggestions = changed
    ? JSON.stringify([{ source: 'pending_operation', source_id: params.pendingOperationId, rank: 0, proposal: { operation_type: 'create_voucher' } }])
    : '[]'
  const { rows } = await getPool().query<{ id: string }>(
    `INSERT INTO public.suggestion_log
       (company_id, kind, pending_operation_id, suggestions, acted_on, final, outcome, actor_type, resolved_by, created_at)
     VALUES ($1, 'operation', $2, $3::jsonb, $4, $5::jsonb, $6, 'user', $7, $8::timestamptz)
     RETURNING id`,
    [
      params.companyId,
      params.pendingOperationId,
      suggestions,
      changed ? 0 : null,
      JSON.stringify({ journal_entry_id: params.journalEntryId, operation_type: 'create_voucher' }),
      params.outcome,
      params.userId,
      params.createdAt,
    ],
  )
  return rows[0].id
}

async function committedAt(entryId: string): Promise<Date> {
  const { rows } = await getPool().query<{ committed_at: Date }>(
    `SELECT committed_at FROM public.journal_entries WHERE id = $1`,
    [entryId],
  )
  return rows[0].committed_at
}

describe('journal_entry_followups', () => {
  // Company A: open 2026, locked 2025.
  let a: { userId: string; companyId: string; fiscalPeriodId: string }
  let a2025PeriodId: string
  // Company B: one entry, its own decision and rättelse.
  let b: { userId: string; companyId: string; fiscalPeriodId: string }
  // Company C: a broken räkenskapsår 2025-07-01 .. 2026-06-30.
  let c: { userId: string; companyId: string; fiscalPeriodId: string }

  const e: Record<string, string> = {}
  const decision: Record<string, string> = {}
  const pendingOperation = { older: randomUUID(), newer: randomUUID() }

  beforeAll(async () => {
    a = await seedCompany()
    a2025PeriodId = await insertFiscalPeriod({
      userId: a.userId,
      companyId: a.companyId,
      name: '2025',
      periodStart: '2025-01-01',
      periodEnd: '2025-12-31',
    })
    b = await seedCompany()
    const cUser = await insertAuthUser()
    const cCompany = await insertCompany({ createdBy: cUser })
    await insertCompanyMember({ companyId: cCompany, userId: cUser, role: 'owner' })
    c = {
      userId: cUser,
      companyId: cCompany,
      fiscalPeriodId: await insertFiscalPeriod({
        userId: cUser,
        companyId: cCompany,
        name: '2025/2026',
        periodStart: '2025-07-01',
        periodEnd: '2026-06-30',
      }),
    }

    const postA = (entryDate: string) => postEntry({ ...a, entryDate })
    e.decided = await postA('2026-06-15')
    e.reversed = await postA('2026-03-10')
    e.corrected = await postA('2026-08-05')
    e.dismissedVat = await postA('2026-09-03')
    e.covered = await postEntry({ ...a, fiscalPeriodId: a2025PeriodId, entryDate: '2025-02-10' })
    e.lockedOnly = await postEntry({ ...a, fiscalPeriodId: a2025PeriodId, entryDate: '2025-05-15' })
    e.storno = await reverseEntry(a.companyId, e.reversed)
    e.b = await postEntry({ ...b, entryDate: '2026-06-15' })
    e.c = await postEntry({ ...c, entryDate: '2026-02-10' })

    // A draft is not a booked entry.
    const draftId = randomUUID()
    await getPool().query(
      `INSERT INTO public.journal_entries
         (id, user_id, company_id, fiscal_period_id, voucher_number, voucher_series,
          entry_date, description, source_type, status)
       VALUES ($1, $2, $3, $4, 0, 'A', '2026-06-20', 'Utkast', 'manual', 'draft')`,
      [draftId, a.userId, a.companyId, a.fiscalPeriodId],
    )
    e.draft = draftId

    // Two inline rättelser on one entry; one in company B.
    await correctDescription(a.companyId, e.corrected, 'Rättad text', a.userId)
    await correctDescription(a.companyId, e.corrected, 'Rättad text igen', a.userId)
    await correctDescription(b.companyId, e.b, 'Rättad i B', b.userId)

    // Two decisions booked e.decided (the newer one wins); company B logs a
    // decision naming A's entry, which must not count for A.
    decision.older = await insertOperationDecision({
      companyId: a.companyId, userId: a.userId, journalEntryId: e.decided,
      pendingOperationId: pendingOperation.older, outcome: 'manual', createdAt: '2026-06-15T08:00:00Z',
    })
    decision.newer = await insertOperationDecision({
      companyId: a.companyId, userId: a.userId, journalEntryId: e.decided,
      pendingOperationId: pendingOperation.newer, outcome: 'changed', createdAt: '2026-06-15T09:00:00Z',
    })
    await insertOperationDecision({
      companyId: b.companyId, userId: b.userId, journalEntryId: e.decided,
      pendingOperationId: randomUUID(), outcome: 'manual', createdAt: '2026-06-15T10:00:00Z',
    })

    // VAT filing records: the period's completed moms deadline.
    await insertVatDeadline({ ...a, type: 'moms_monthly', taxPeriod: '2026-06', completedAt: '2026-07-12T10:00:00Z', status: 'confirmed' })
    await insertVatDeadline({ ...a, type: 'moms_quarterly', taxPeriod: '2026-Q1', completedAt: '2026-05-12T12:00:00Z', status: 'submitted' })
    await insertVatDeadline({ ...a, type: 'moms_monthly', taxPeriod: '2026-08', completedAt: null, status: 'upcoming' })
    await insertVatDeadline({ ...a, type: 'moms_monthly', taxPeriod: '2026-09', completedAt: '2026-10-12T12:00:00Z', status: 'submitted', dismissed: true })
    await insertVatDeadline({ ...a, type: 'moms_yearly', taxPeriod: '2025', completedAt: '2026-02-20T12:00:00Z', status: 'submitted' })
    await insertVatDeadline({ ...c, type: 'moms_yearly', taxPeriod: '2025/2026', completedAt: '2026-09-01T12:00:00Z', status: 'confirmed' })
    // B's filing of the same month is B's alone.
    await insertVatDeadline({ ...b, type: 'moms_monthly', taxPeriod: '2026-03', completedAt: '2026-04-12T12:00:00Z', status: 'confirmed' })

    // Close the books on 2025: the period is locked (lockPeriod), and the
    // company lock date covers only the first quarter.
    await getPool().query(`UPDATE public.fiscal_periods SET locked_at = now() WHERE id = $1`, [a2025PeriodId])
    await getPool().query(
      `INSERT INTO public.company_settings (company_id, bookkeeping_locked_through) VALUES ($1, '2025-03-31')
       ON CONFLICT (company_id) DO UPDATE SET bookkeeping_locked_through = EXCLUDED.bookkeeping_locked_through`,
      [a.companyId],
    )
  })

  async function rowsAs(userId: string, where = '', params: unknown[] = []): Promise<FollowupRow[]> {
    return withUserContext(userId, async (client) => (await client.query<FollowupRow>(`${SELECT_FOLLOWUPS} ${where}`, params)).rows)
  }

  async function rowOf(entryId: string): Promise<FollowupRow> {
    const rows = await rowsAs(a.userId, 'WHERE journal_entry_id = $1', [entryId])
    expect(rows).toHaveLength(1)
    return rows[0]
  }

  describe('(a) tenancy', () => {
    it('is created with security_invoker', async () => {
      const { rows } = await getPool().query<{ reloptions: string[] | null }>(
        `SELECT reloptions FROM pg_class WHERE oid = 'public.journal_entry_followups'::regclass`,
      )
      expect(rows[0].reloptions).toContain('security_invoker=true')
    })

    it("shows a member their company's booked entries and none of another company's", async () => {
      const rows = await rowsAs(a.userId)
      expect(new Set(rows.map((r) => r.company_id))).toEqual(new Set([a.companyId]))
      expect(rows.map((r) => r.journal_entry_id).sort()).toEqual(
        [e.decided, e.reversed, e.corrected, e.dismissedVat, e.covered, e.lockedOnly, e.storno].sort(),
      )
      expect(await rowsAs(a.userId, 'WHERE company_id = $1', [b.companyId])).toEqual([])
      expect(await rowsAs(a.userId, 'WHERE journal_entry_id = $1', [e.b])).toEqual([])
    })

    it("reads the other company's row only for its own member", async () => {
      const rows = await rowsAs(b.userId)
      expect(rows.map((r) => r.journal_entry_id)).toEqual([e.b])
      // Company B's rättelse and decision are B's; A's decision naming no B entry is not.
      expect(rows[0].inline_correction_count).toBe(1)
      expect(rows[0].suggestion_count).toBe(0)
    })

    it('shows a signed-in user without membership nothing', async () => {
      const stranger = await insertAuthUser()
      expect(await rowsAs(stranger)).toEqual([])
    })
  })

  describe('(b) derivations', () => {
    it('carries the identity and commit stamp of the entry', async () => {
      const row = await rowOf(e.decided)
      expect(row).toMatchObject({
        company_id: a.companyId,
        voucher_series: 'A',
        entry_date: '2026-06-15',
        status: 'posted',
        source_type: 'manual',
        committed_by: a.userId,
        committed_actor_type: 'user',
        fiscal_period_id: a.fiscalPeriodId,
      })
      expect(row.voucher_number).toBeGreaterThan(0)
      expect(row.committed_at).toBeInstanceOf(Date)
    })

    it('names the newest decision that booked the entry, its outcome and operation', async () => {
      const row = await rowOf(e.decided)
      expect(row).toMatchObject({
        suggestion_log_id: decision.newer,
        suggestion_kind: 'operation',
        suggestion_outcome: 'changed',
        suggestion_count: 2,
        pending_operation_id: pendingOperation.newer,
      })
      const plain = await rowOf(e.corrected)
      expect(plain).toMatchObject({ suggestion_log_id: null, suggestion_outcome: null, suggestion_count: 0, pending_operation_id: null })
    })

    it('sets reversed_at and days_to_reversal on a reversed entry', async () => {
      const row = await rowOf(e.reversed)
      expect(row.status).toBe('reversed')
      expect(row.storno_journal_entry_id).toBe(e.storno)
      expect(row.reversed_at?.getTime()).toBe((await committedAt(e.storno)).getTime())
      expect(row.days_to_reversal).toBe(0)

      const live = await rowOf(e.decided)
      expect(live).toMatchObject({ storno_journal_entry_id: null, reversed_at: null, days_to_reversal: null })

      // The storno is a booked entry of its own, never reversed itself.
      const storno = await rowOf(e.storno)
      expect(storno).toMatchObject({ source_type: 'storno', status: 'posted', storno_journal_entry_id: null })
    })

    it('counts inline rättelser and keeps the first one', async () => {
      const row = await rowOf(e.corrected)
      const { rows: log } = await getPool().query<{ first: Date }>(
        `SELECT min(created_at) AS first FROM public.journal_entry_rattelse_log WHERE journal_entry_id = $1`,
        [e.corrected],
      )
      expect(row.inline_correction_count).toBe(2)
      expect(row.first_inline_correction_at?.getTime()).toBe(log[0].first.getTime())

      const untouched = await rowOf(e.decided)
      expect(untouched).toMatchObject({ inline_correction_count: 0, first_inline_correction_at: null })
    })

    it('reads the VAT declaration of the period containing the entry', async () => {
      // June 2026, filed monthly and confirmed by Skatteverket.
      const june = await rowOf(e.decided)
      expect(june).toMatchObject({ vat_period_declared: true, vat_declaration_source: 'skatteverket' })
      expect(june.vat_declared_at?.toISOString()).toBe('2026-07-12T10:00:00.000Z')

      // March 2026, in a quarter marked filed by hand; B's March filing is B's.
      const march = await rowOf(e.reversed)
      expect(march).toMatchObject({ vat_period_declared: true, vat_declaration_source: 'manual' })
      expect(march.vat_declared_at?.toISOString()).toBe('2026-05-12T12:00:00.000Z')

      // August: the deadline is not completed. September: completed but dismissed.
      for (const id of [e.corrected, e.dismissedVat]) {
        expect(await rowOf(id)).toMatchObject({ vat_period_declared: false, vat_declared_at: null, vat_declaration_source: null })
      }

      // 2025, a calendar räkenskapsår declared yearly.
      const yearly = await rowOf(e.lockedOnly)
      expect(yearly).toMatchObject({ vat_period_declared: true, vat_declaration_source: 'manual' })
      expect(yearly.vat_declared_at?.toISOString()).toBe('2026-02-20T12:00:00.000Z')

      // A broken räkenskapsår is filed under tax_period YYYY-1/YYYY.
      const [broken] = await rowsAs(c.userId, 'WHERE journal_entry_id = $1', [e.c])
      expect(broken).toMatchObject({ vat_period_declared: true, vat_declaration_source: 'skatteverket' })
      expect(broken.vat_declared_at?.toISOString()).toBe('2026-09-01T12:00:00.000Z')
    })

    it('shows the period lock and whether the company lock date covers the entry', async () => {
      const covered = await rowOf(e.covered)
      expect(covered).toMatchObject({
        fiscal_period_id: a2025PeriodId,
        fiscal_period_closed: false,
        fiscal_period_closed_at: null,
        company_lock_date: '2025-03-31',
        covered_by_lock_date: true,
      })
      expect(covered.fiscal_period_locked_at).toBeInstanceOf(Date)

      const lockedOnly = await rowOf(e.lockedOnly)
      expect(lockedOnly.fiscal_period_locked_at).toBeInstanceOf(Date)
      expect(lockedOnly.covered_by_lock_date).toBe(false)

      const open = await rowOf(e.decided)
      expect(open).toMatchObject({ fiscal_period_locked_at: null, fiscal_period_closed: false, covered_by_lock_date: false })
    })

    it('shows when a closed period was closed', async () => {
      await getPool().query(
        `UPDATE public.fiscal_periods SET is_closed = true, closed_at = '2026-03-01T09:00:00Z' WHERE id = $1`,
        [a2025PeriodId],
      )
      const row = await rowOf(e.covered)
      expect(row.fiscal_period_closed).toBe(true)
      expect(row.fiscal_period_closed_at?.toISOString()).toBe('2026-03-01T09:00:00.000Z')
    })
  })
})
