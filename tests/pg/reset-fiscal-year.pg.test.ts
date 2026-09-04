/**
 * pg-real tests for the fiscal-year reset RPCs (migration 20260825150000,
 * next-year dependency narrowed in 20260904163000).
 *
 * Pins: the actor gate (service-role p_user_id, owner/admin only), every
 * eligibility guard (locked, closed, company lock date, year-end state,
 * next-year dependency, VAT declared evidence, ROT/RUT reliance, cross-year
 * rättelse/storno references), the typed-confirmation mismatch, the happy
 * path (all source types and statuses deleted, documents DETACHED never
 * deleted, sie_imports flipped to undone, dimension registry lockstep,
 * voucher_sequences reset, RESET_SNAPSHOT content archive), and the
 * all-or-nothing rollback when an entry is referenced by another record
 * (RESTRICT FK).
 */
import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { getPool, runAsServiceRole } from '@/tests/pg/setup'
import {
  seedCompany,
  insertAuthUser,
  insertCompanyMember,
  insertDraftJournalEntry,
  insertBalancedLines,
  insertFiscalPeriod,
} from '@/tests/pg/fixtures'

type RpcResult = {
  ok: boolean
  code?: string
  eligible?: boolean
  blockers?: Array<{ code: string; count?: number; date?: string }>
  counts?: { vouchers: number; documents_to_detach: number }
  next_period?: { id: string; name: string; has_opening_balances: boolean } | null
  deleted?: number
  detached_documents?: number
  period_name?: string
}

async function callReset(
  companyId: string,
  periodId: string,
  confirmedName: string | null,
  actor: string | null,
): Promise<RpcResult> {
  const res = await runAsServiceRole((client) =>
    client.query<{ result: RpcResult }>(
      `SELECT public.reset_fiscal_year($1::uuid, $2::uuid, $3::text, $4::uuid) AS result`,
      [companyId, periodId, confirmedName, actor],
    ),
  )
  return res.rows[0].result
}

async function callEligibility(
  companyId: string,
  periodId: string,
  actor: string | null,
): Promise<RpcResult> {
  const res = await runAsServiceRole((client) =>
    client.query<{ result: RpcResult }>(
      `SELECT public.get_fiscal_year_reset_eligibility($1::uuid, $2::uuid, $3::uuid) AS result`,
      [companyId, periodId, actor],
    ),
  )
  return res.rows[0].result
}

/** Post an entry (any source_type/status) with balanced lines. */
async function insertPostedEntry(params: {
  companyId: string
  userId: string
  fiscalPeriodId: string
  sourceType?: string
  voucherNumber?: number
  entryDate?: string
}): Promise<string> {
  const jeId = await insertDraftJournalEntry({
    userId: params.userId,
    companyId: params.companyId,
    fiscalPeriodId: params.fiscalPeriodId,
    sourceType: params.sourceType ?? 'manual',
    status: 'draft',
    voucherNumber: params.voucherNumber ?? 1,
    entryDate: params.entryDate,
  })
  await insertBalancedLines(jeId, 1000)
  await getPool().query(`UPDATE public.journal_entries SET status = 'posted' WHERE id = $1`, [
    jeId,
  ])
  return jeId
}

async function entryCount(companyId: string, periodId: string): Promise<number> {
  const { rows } = await getPool().query<{ n: string }>(
    `SELECT count(*)::text AS n FROM public.journal_entries
      WHERE company_id = $1 AND fiscal_period_id = $2`,
    [companyId, periodId],
  )
  return Number(rows[0].n)
}

describe('reset_fiscal_year: actor gate', () => {
  it('refuses without an authorising identity', async () => {
    const { companyId, fiscalPeriodId } = await seedCompany()
    const result = await callReset(companyId, fiscalPeriodId, '2026', null)
    expect(result).toMatchObject({ ok: false, code: 'FISCAL_YEAR_RESET_FORBIDDEN' })
  })

  it('refuses a plain member', async () => {
    const { companyId, fiscalPeriodId } = await seedCompany()
    const memberId = await insertAuthUser()
    await insertCompanyMember({ companyId, userId: memberId, role: 'member' })

    const result = await callReset(companyId, fiscalPeriodId, '2026', memberId)
    expect(result).toMatchObject({ ok: false, code: 'FISCAL_YEAR_RESET_FORBIDDEN' })
  })

  it('refuses an owner of a DIFFERENT company', async () => {
    const { companyId, fiscalPeriodId } = await seedCompany()
    const other = await seedCompany()

    const result = await callReset(companyId, fiscalPeriodId, '2026', other.userId)
    expect(result).toMatchObject({ ok: false, code: 'FISCAL_YEAR_RESET_FORBIDDEN' })
  })
})

describe('get_fiscal_year_reset_eligibility', () => {
  it('reports a clean open year as eligible with correct counts', async () => {
    const { companyId, userId, fiscalPeriodId } = await seedCompany()
    await insertPostedEntry({ companyId, userId, fiscalPeriodId, sourceType: 'import' })
    await insertPostedEntry({
      companyId,
      userId,
      fiscalPeriodId,
      sourceType: 'manual',
      voucherNumber: 2,
    })

    const result = await callEligibility(companyId, fiscalPeriodId, userId)
    expect(result.ok).toBe(true)
    expect(result.eligible).toBe(true)
    expect(result.blockers).toEqual([])
    expect(result.counts?.vouchers).toBe(2)
  })

  it('returns NOT_FOUND for a period of another company', async () => {
    const a = await seedCompany()
    const b = await seedCompany()

    const result = await callEligibility(a.companyId, b.fiscalPeriodId, a.userId)
    expect(result).toMatchObject({ ok: false, code: 'FISCAL_YEAR_RESET_NOT_FOUND' })
  })
})

describe('reset_fiscal_year: eligibility guards', () => {
  it('refuses a locked year and leaves it untouched', async () => {
    const { companyId, userId, fiscalPeriodId } = await seedCompany()
    await insertPostedEntry({ companyId, userId, fiscalPeriodId })
    await getPool().query(
      `UPDATE public.fiscal_periods SET locked_at = now() WHERE id = $1`,
      [fiscalPeriodId],
    )

    const result = await callReset(companyId, fiscalPeriodId, '2026', userId)
    expect(result).toMatchObject({ ok: false, code: 'FISCAL_YEAR_RESET_INELIGIBLE' })
    expect(result.blockers).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'period_locked' })]),
    )
    expect(await entryCount(companyId, fiscalPeriodId)).toBe(1)
  })

  it('refuses a closed year', async () => {
    const { companyId, userId, fiscalPeriodId } = await seedCompany({ isClosed: true })

    const result = await callReset(companyId, fiscalPeriodId, '2026', userId)
    expect(result).toMatchObject({ ok: false, code: 'FISCAL_YEAR_RESET_INELIGIBLE' })
    expect(result.blockers).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'period_closed' })]),
    )
  })

  it('refuses when the company lock date covers any part of the year', async () => {
    const { companyId, userId, fiscalPeriodId } = await seedCompany()
    await getPool().query(
      `INSERT INTO public.company_settings (user_id, company_id, bookkeeping_locked_through)
       VALUES ($1, $2, '2026-03-31')`,
      [userId, companyId],
    )

    const result = await callReset(companyId, fiscalPeriodId, '2026', userId)
    expect(result).toMatchObject({ ok: false, code: 'FISCAL_YEAR_RESET_INELIGIBLE' })
    expect(result.blockers).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'company_lock_date' })]),
    )
  })

  it('refuses a year with an executed year-end closing', async () => {
    const { companyId, userId, fiscalPeriodId } = await seedCompany()
    const closingId = await insertPostedEntry({
      companyId,
      userId,
      fiscalPeriodId,
      sourceType: 'year_end',
    })
    await getPool().query(
      `UPDATE public.fiscal_periods SET closing_entry_id = $1 WHERE id = $2`,
      [closingId, fiscalPeriodId],
    )

    const result = await callReset(companyId, fiscalPeriodId, '2026', userId)
    expect(result).toMatchObject({ ok: false, code: 'FISCAL_YEAR_RESET_INELIGIBLE' })
    expect(result.blockers).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'year_end_state' })]),
    )
  })

  it('refuses when a later year is finalised on top of this one (closed)', async () => {
    const { companyId, userId, fiscalPeriodId } = await seedCompany()
    const nextId = await insertFiscalPeriod({
      userId,
      companyId,
      name: '2027',
      periodStart: '2027-01-01',
      periodEnd: '2027-12-31',
      isClosed: true,
    })
    await getPool().query(
      `UPDATE public.fiscal_periods SET previous_period_id = $1 WHERE id = $2`,
      [fiscalPeriodId, nextId],
    )

    const result = await callReset(companyId, fiscalPeriodId, '2026', userId)
    expect(result).toMatchObject({ ok: false, code: 'FISCAL_YEAR_RESET_INELIGIBLE' })
    expect(result.blockers).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'next_year_dependency' })]),
    )
  })

  it('refuses when a later year has its own closing entry', async () => {
    const { companyId, userId, fiscalPeriodId } = await seedCompany()
    const nextId = await insertFiscalPeriod({
      userId,
      companyId,
      name: '2027',
      periodStart: '2027-01-01',
      periodEnd: '2027-12-31',
    })
    const nextClosingId = await insertPostedEntry({
      companyId,
      userId,
      fiscalPeriodId: nextId,
      sourceType: 'year_end',
      entryDate: '2027-12-31',
    })
    await getPool().query(
      `UPDATE public.fiscal_periods
          SET previous_period_id = $1, closing_entry_id = $2
        WHERE id = $3`,
      [fiscalPeriodId, nextClosingId, nextId],
    )

    const result = await callReset(companyId, fiscalPeriodId, '2026', userId)
    expect(result).toMatchObject({ ok: false, code: 'FISCAL_YEAR_RESET_INELIGIBLE' })
    expect(result.blockers).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'next_year_dependency' })]),
    )
  })

  it('does not treat the later year\'s own opening balances as a dependency', async () => {
    // The backfill shape: the first imported year carries its own IB (from
    // the SIE file's #IB, or resynced from the backfilled year's #UB). Its
    // IB is a verifikat of its own and survives the reset untouched; the
    // preview discloses it instead of refusing.
    const { companyId, userId, fiscalPeriodId } = await seedCompany()
    await insertPostedEntry({ companyId, userId, fiscalPeriodId, sourceType: 'import' })
    const nextId = await insertFiscalPeriod({
      userId,
      companyId,
      name: '2027',
      periodStart: '2027-01-01',
      periodEnd: '2027-12-31',
    })
    const nextIbId = await insertPostedEntry({
      companyId,
      userId,
      fiscalPeriodId: nextId,
      sourceType: 'opening_balance',
      entryDate: '2027-01-01',
    })
    await getPool().query(
      `UPDATE public.fiscal_periods
          SET previous_period_id = $1,
              opening_balance_entry_id = $2,
              opening_balances_set = true
        WHERE id = $3`,
      [fiscalPeriodId, nextIbId, nextId],
    )

    const eligibility = await callEligibility(companyId, fiscalPeriodId, userId)
    expect(eligibility).toMatchObject({
      ok: true,
      eligible: true,
      blockers: [],
      next_period: { id: nextId, name: '2027', has_opening_balances: true },
    })

    const result = await callReset(companyId, fiscalPeriodId, '2026', userId)
    expect(result.ok).toBe(true)
    expect(result.deleted).toBe(1)

    expect(await entryCount(companyId, nextId)).toBe(1)
    const { rows } = await getPool().query<{ opening_balance_entry_id: string; opening_balances_set: boolean }>(
      `SELECT opening_balance_entry_id, opening_balances_set FROM public.fiscal_periods WHERE id = $1`,
      [nextId],
    )
    expect(rows[0]).toEqual({ opening_balance_entry_id: nextIbId, opening_balances_set: true })
  })

  it('allows a later year that carries no dependency yet', async () => {
    const { companyId, userId, fiscalPeriodId } = await seedCompany()
    await insertPostedEntry({ companyId, userId, fiscalPeriodId })
    const nextId = await insertFiscalPeriod({
      userId,
      companyId,
      name: '2027',
      periodStart: '2027-01-01',
      periodEnd: '2027-12-31',
    })
    await getPool().query(
      `UPDATE public.fiscal_periods SET previous_period_id = $1 WHERE id = $2`,
      [fiscalPeriodId, nextId],
    )

    const eligibility = await callEligibility(companyId, fiscalPeriodId, userId)
    expect(eligibility).toMatchObject({
      ok: true,
      eligible: true,
      next_period: { id: nextId, name: '2027', has_opening_balances: false },
    })

    const result = await callReset(companyId, fiscalPeriodId, '2026', userId)
    expect(result.ok).toBe(true)
    expect(result.deleted).toBe(1)
  })

  it('refuses a year with a booked momsdeklaration (vat_settlement)', async () => {
    const { companyId, userId, fiscalPeriodId } = await seedCompany()
    await insertPostedEntry({
      companyId,
      userId,
      fiscalPeriodId,
      sourceType: 'vat_settlement',
    })

    const result = await callReset(companyId, fiscalPeriodId, '2026', userId)
    expect(result).toMatchObject({ ok: false, code: 'FISCAL_YEAR_RESET_INELIGIBLE' })
    expect(result.blockers).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'vat_declared' })]),
    )
  })

  it('refuses when an entry in another year corrects an entry in this year', async () => {
    const { companyId, userId, fiscalPeriodId } = await seedCompany()
    const targetId = await insertPostedEntry({ companyId, userId, fiscalPeriodId })
    const nextId = await insertFiscalPeriod({
      userId,
      companyId,
      name: '2027',
      periodStart: '2027-01-01',
      periodEnd: '2027-12-31',
    })
    // A draft in 2027 correcting a 2026 entry: deleting the target would
    // fire the FK's ON DELETE SET NULL as an UPDATE on the referrer, which
    // either trips the immutability trigger (posted) or silently severs the
    // chain (draft). Both must be refused up front.
    const referrerId = await insertDraftJournalEntry({
      userId,
      companyId,
      fiscalPeriodId: nextId,
      sourceType: 'manual',
      status: 'draft',
      voucherNumber: 0,
      entryDate: '2027-03-15',
    })
    await getPool().query(
      `UPDATE public.journal_entries SET correction_of_id = $1 WHERE id = $2`,
      [targetId, referrerId],
    )

    const result = await callReset(companyId, fiscalPeriodId, '2026', userId)
    expect(result).toMatchObject({ ok: false, code: 'FISCAL_YEAR_RESET_INELIGIBLE' })
    expect(result.blockers).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'cross_year_reference' })]),
    )
    expect(await entryCount(companyId, fiscalPeriodId)).toBe(1)
  })

  it('refuses when a filed rot/rut payout request relies on the year', async () => {
    const { companyId, userId, fiscalPeriodId } = await seedCompany()
    const settlementId = await insertPostedEntry({ companyId, userId, fiscalPeriodId })
    await getPool().query(
      `INSERT INTO public.rot_rut_payout_requests
         (company_id, user_id, deduction_type, name, status, requested_total,
          file_name, settlement_journal_entry_id, submitted_at)
       VALUES ($1, $2, 'rot', 'Begaran 1', 'submitted', 12500, 'begaran.xml', $3, now())`,
      [companyId, userId, settlementId],
    )

    const result = await callReset(companyId, fiscalPeriodId, '2026', userId)
    expect(result).toMatchObject({ ok: false, code: 'FISCAL_YEAR_RESET_INELIGIBLE' })
    expect(result.blockers).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'rot_rut_state' })]),
    )
    expect(await entryCount(companyId, fiscalPeriodId)).toBe(1)
  })
})

describe('reset_fiscal_year: typed confirmation', () => {
  it('refuses a wrong name and deletes nothing', async () => {
    const { companyId, userId, fiscalPeriodId } = await seedCompany()
    await insertPostedEntry({ companyId, userId, fiscalPeriodId })

    const result = await callReset(companyId, fiscalPeriodId, 'fel namn', userId)
    expect(result).toMatchObject({
      ok: false,
      code: 'FISCAL_YEAR_RESET_CONFIRMATION_MISMATCH',
    })
    expect(await entryCount(companyId, fiscalPeriodId)).toBe(1)
  })
})

describe('reset_fiscal_year: happy path', () => {
  it('deletes all statuses and source types, detaches documents, resets state', async () => {
    const { companyId, userId, fiscalPeriodId } = await seedCompany()

    const importedId = await insertPostedEntry({
      companyId,
      userId,
      fiscalPeriodId,
      sourceType: 'import',
      voucherNumber: 1,
    })
    await insertPostedEntry({
      companyId,
      userId,
      fiscalPeriodId,
      sourceType: 'manual',
      voucherNumber: 2,
    })
    // A draft too: the reset covers every status, not just posted.
    await insertDraftJournalEntry({
      userId,
      companyId,
      fiscalPeriodId,
      sourceType: 'manual',
      status: 'draft',
      voucherNumber: 0,
    })

    // A linked document: must survive the reset, detached (BFL 7 kap).
    const docId = randomUUID()
    await getPool().query(
      `INSERT INTO public.document_attachments
         (id, user_id, company_id, storage_path, file_name, sha256_hash, journal_entry_id)
       VALUES ($1, $2, $3, 'test/reset.pdf', 'reset.pdf', $4, $5)`,
      [docId, userId, companyId, `hash-${docId}`, importedId],
    )

    // A completed SIE import on the year: must flip to 'undone'.
    const importId = randomUUID()
    await getPool().query(
      `INSERT INTO public.sie_imports
         (id, user_id, company_id, filename, file_hash, sie_type,
          accounts_count, transactions_count, status, fiscal_period_id, imported_at)
       VALUES ($1, $2, $3, 'reset-test.se', $4, 4, 0, 1, 'completed', $5, now())`,
      [importId, userId, companyId, `hash-${importId}`, fiscalPeriodId],
    )

    // A voucher sequence with a nonzero cursor: must reset to 0.
    await getPool().query(
      `INSERT INTO public.voucher_sequences
         (user_id, company_id, fiscal_period_id, voucher_series, last_number)
       VALUES ($1, $2, $3, 'A', 2)`,
      [userId, companyId, fiscalPeriodId],
    )

    // A dimension + value the import introduced: registry lockstep (mirrors
    // undo_sie_import) must remove them once nothing references them, since
    // undo_sie_import can never run for an import the reset marked undone.
    const dimId = randomUUID()
    await getPool().query(
      `INSERT INTO public.dimensions (id, company_id, sie_dim_no, name, created_by_import_id)
       VALUES ($1, $2, 7, 'Projekt (import)', $3)`,
      [dimId, companyId, importId],
    )
    await getPool().query(
      `INSERT INTO public.dimension_values (company_id, dimension_id, code, name, created_by_import_id)
       VALUES ($1, $2, 'P1', 'Testprojekt', $3)`,
      [companyId, dimId, importId],
    )

    const result = await callReset(companyId, fiscalPeriodId, '2026', userId)
    expect(result.ok).toBe(true)
    expect(result.deleted).toBe(3)
    expect(result.detached_documents).toBe(1)
    expect(result.period_name).toBe('2026')

    expect(await entryCount(companyId, fiscalPeriodId)).toBe(0)

    const { rows: docRows } = await getPool().query<{
      journal_entry_id: string | null
    }>(`SELECT journal_entry_id FROM public.document_attachments WHERE id = $1`, [docId])
    expect(docRows).toHaveLength(1)
    expect(docRows[0].journal_entry_id).toBeNull()

    const { rows: impRows } = await getPool().query<{ status: string }>(
      `SELECT status FROM public.sie_imports WHERE id = $1`,
      [importId],
    )
    expect(impRows[0].status).toBe('undone')

    const { rows: seqRows } = await getPool().query<{ last_number: number }>(
      `SELECT last_number FROM public.voucher_sequences
        WHERE company_id = $1 AND fiscal_period_id = $2 AND voucher_series = 'A'`,
      [companyId, fiscalPeriodId],
    )
    expect(seqRows[0].last_number).toBe(0)

    // Behandlingshistorik: the summary row exists.
    const { rows: auditRows } = await getPool().query<{ n: string }>(
      `SELECT count(*)::text AS n FROM public.audit_log
        WHERE company_id = $1 AND record_id = $2
          AND description LIKE 'Fiscal year reset%'`,
      [companyId, fiscalPeriodId],
    )
    expect(Number(auditRows[0].n)).toBe(1)

    // Räkenskapsinformation archive: one company-scoped RESET_SNAPSHOT row
    // per deleted verifikat, with the full lines (accounts + amounts).
    const { rows: snapRows } = await getPool().query<{
      old_state: { lines: Array<Record<string, unknown>> }
    }>(
      `SELECT old_state FROM public.audit_log
        WHERE company_id = $1 AND action = 'RESET_SNAPSHOT'
          AND table_name = 'journal_entries'`,
      [companyId],
    )
    expect(snapRows).toHaveLength(3)
    const withLines = snapRows.filter(
      (r) => Array.isArray(r.old_state.lines) && r.old_state.lines.length > 0,
    )
    expect(withLines.length).toBeGreaterThanOrEqual(2)
    expect(withLines[0].old_state.lines[0]).toHaveProperty('account_number')
    expect(withLines[0].old_state.lines[0]).toHaveProperty('debit_amount')
    expect(withLines[0].old_state.lines[0]).toHaveProperty('credit_amount')

    // Dimension registry lockstep: the import-created dimension and value
    // are gone (nothing references them any more).
    const { rows: dimRows } = await getPool().query(
      `SELECT id FROM public.dimensions WHERE id = $1`,
      [dimId],
    )
    expect(dimRows).toHaveLength(0)
    const { rows: dimValRows } = await getPool().query(
      `SELECT id FROM public.dimension_values WHERE dimension_id = $1`,
      [dimId],
    )
    expect(dimValRows).toHaveLength(0)
  })
})

describe('reset_fiscal_year: linked entries roll back everything', () => {
  it('refuses when an entry is referenced by a RESTRICT FK and leaves all state intact', async () => {
    const { companyId, userId, fiscalPeriodId } = await seedCompany()
    const freeId = await insertPostedEntry({
      companyId,
      userId,
      fiscalPeriodId,
      voucherNumber: 1,
    })
    const linkedId = await insertPostedEntry({
      companyId,
      userId,
      fiscalPeriodId,
      voucherNumber: 2,
    })

    // Reference the second entry from a depreciation schedule (ON DELETE
    // RESTRICT), the smallest seedable RESTRICT link.
    const assetId = randomUUID()
    await getPool().query(
      `INSERT INTO public.assets
         (id, user_id, company_id, name, category, acquisition_date,
          acquisition_cost, useful_life_months,
          bas_asset_account, bas_accumulated_account, bas_expense_account)
       VALUES ($1, $2, $3, 'Test asset', 'equipment', '2026-01-15',
               10000, 60, '1220', '1229', '7832')`,
      [assetId, userId, companyId],
    )
    await getPool().query(
      `INSERT INTO public.depreciation_schedules
         (user_id, company_id, asset_id, fiscal_period_id,
          planned_depreciation, journal_entry_id, posted_at)
       VALUES ($1, $2, $3, $4, 1000, $5, now())`,
      [userId, companyId, assetId, fiscalPeriodId, linkedId],
    )

    // A document on the FREE entry: must still be attached after the failed
    // reset (all-or-nothing).
    const docId = randomUUID()
    await getPool().query(
      `INSERT INTO public.document_attachments
         (id, user_id, company_id, storage_path, file_name, sha256_hash, journal_entry_id)
       VALUES ($1, $2, $3, 'test/rollback.pdf', 'rollback.pdf', $4, $5)`,
      [docId, userId, companyId, `hash-${docId}`, freeId],
    )

    const result = await callReset(companyId, fiscalPeriodId, '2026', userId)
    expect(result).toMatchObject({ ok: false, code: 'FISCAL_YEAR_RESET_LINKED_ENTRIES' })

    // Nothing was deleted or detached.
    expect(await entryCount(companyId, fiscalPeriodId)).toBe(2)
    const { rows: docRows } = await getPool().query<{
      journal_entry_id: string | null
    }>(`SELECT journal_entry_id FROM public.document_attachments WHERE id = $1`, [docId])
    expect(docRows[0].journal_entry_id).toBe(freeId)
  })
})
