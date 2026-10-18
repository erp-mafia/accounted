import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import type { PoolClient } from 'pg'
import { getPool, withUserContext } from './setup'
import {
  insertAuthUser,
  insertCompany,
  insertCompanyMember,
  insertFiscalPeriod,
  insertPostedJournalEntry,
  setActiveCompany,
} from './fixtures'

// The owner's reopen of a year closed with a year-end run in Accounted
// (migration 20261018120000, crm#1290): reopen_closed_fiscal_year is the gate
// and the state change, the engine then reverses the bokslut by storno and
// detaches closing_entry_id. Every step here runs as the authenticated owner,
// the role the app uses for both halves.

const ORG = '5560125790'

interface Seed {
  ownerId: string
  companyId: string
  closedId: string
  nextId: string
  closingId: string
  ibId: string
  appropriationId: string
  versionId: string
  signatureId: string
}

function snapshot(reports: unknown[] = [], extra: Record<string, unknown> = {}) {
  return {
    orgNumber: ORG,
    financialReports: reports,
    financialReportsComplete: true,
    ...extra,
  }
}

async function setRegistry(companyId: string, value: unknown, fetchedAt: string | null = 'now') {
  await getPool().query(
    `UPDATE public.companies
        SET tic_snapshot = $2::jsonb,
            tic_snapshot_fetched_at = CASE WHEN $3::text = 'now' THEN now() ELSE $3::timestamptz END
      WHERE id = $1`,
    [companyId, value === null ? null : JSON.stringify(value), fetchedAt],
  )
}

/**
 * A company whose 2025 is closed with a bokslut, 2026 holds the IB and the
 * 2099 -> 2098 omföring, and an unsigned årsredovisning for 2025 waits for
 * one signature. Bolagsverket (TIC) has nothing registered.
 */
async function seed(): Promise<Seed> {
  const ownerId = await insertAuthUser()
  const companyId = await insertCompany({ createdBy: ownerId })
  await insertCompanyMember({ companyId, userId: ownerId, role: 'owner' })
  await setActiveCompany(ownerId, companyId)
  await getPool().query(`UPDATE public.companies SET org_number = $2 WHERE id = $1`, [companyId, ORG])
  await setRegistry(companyId, snapshot())

  const closedId = await insertFiscalPeriod({
    userId: ownerId, companyId, name: '2025', periodStart: '2025-01-01', periodEnd: '2025-12-31',
  })
  const nextId = await insertFiscalPeriod({
    userId: ownerId, companyId, name: '2026', periodStart: '2026-01-01', periodEnd: '2026-12-31',
  })
  await getPool().query(`UPDATE public.fiscal_periods SET previous_period_id = $2 WHERE id = $1`, [nextId, closedId])

  const closingId = await insertPostedJournalEntry({
    userId: ownerId, companyId, fiscalPeriodId: closedId, entryDate: '2025-12-31',
    description: 'Årsbokslut 2025', sourceType: 'year_end', voucherNumber: 9001,
    lines: [
      { accountNumber: '3001', debitAmount: 1000, creditAmount: 0 },
      { accountNumber: '2099', debitAmount: 0, creditAmount: 1000 },
    ],
  })
  await getPool().query(
    `UPDATE public.fiscal_periods
        SET closing_entry_id = $2, locked_at = now(), is_closed = true, closed_at = now()
      WHERE id = $1`,
    [closedId, closingId],
  )

  const ibId = await insertPostedJournalEntry({
    userId: ownerId, companyId, fiscalPeriodId: nextId, entryDate: '2026-01-01',
    description: 'Ingående balans 2026', sourceType: 'opening_balance', voucherNumber: 9001,
    lines: [
      { accountNumber: '1930', debitAmount: 1000, creditAmount: 0 },
      { accountNumber: '2099', debitAmount: 0, creditAmount: 1000 },
    ],
  })
  await getPool().query(
    `UPDATE public.fiscal_periods
        SET opening_balance_entry_id = $2, opening_balances_set = true, continuity_verified = true
      WHERE id = $1`,
    [nextId, ibId],
  )
  const appropriationId = await insertPostedJournalEntry({
    userId: ownerId, companyId, fiscalPeriodId: nextId, entryDate: '2026-01-01',
    description: 'Omföring av föregående års resultat', sourceType: 'result_appropriation', voucherNumber: 9002,
    lines: [
      { accountNumber: '2099', debitAmount: 1000, creditAmount: 0 },
      { accountNumber: '2098', debitAmount: 0, creditAmount: 1000 },
    ],
  })

  const versionId = randomUUID()
  await getPool().query(
    `INSERT INTO public.annual_report_versions
       (id, company_id, fiscal_period_id, user_id, version_number, schema_version, framework,
        status, report_data, content_hash, validation_summary, finalized_at, finalized_by)
     VALUES ($1, $2, $3, $4, 1, '1.0', 'k2', 'ready_for_signature', '{}'::jsonb, $5, '{}'::jsonb, now(), $4)`,
    [versionId, companyId, closedId, ownerId, 'a'.repeat(64)],
  )
  const signatureId = randomUUID()
  await getPool().query(
    `INSERT INTO public.arsredovisning_signature_requests
       (id, user_id, company_id, fiscal_period_id, role, signer_name, annual_report_version_id)
     VALUES ($1, $2, $3, $4, 'Styrelseledamot', 'Anna Andersson', $5)`,
    [signatureId, ownerId, companyId, closedId, versionId],
  )

  return { ownerId, companyId, closedId, nextId, closingId, ibId, appropriationId, versionId, signatureId }
}

type RpcResult = {
  ok: boolean
  code?: string
  eligible?: boolean
  blockers?: Array<{ code: string; date?: string; name?: string }>
  entries?: Array<{ id: string; kind: string }>
  annual_report?: { versions_to_supersede: number; pending_signatures: number }
  resumed?: boolean
}

async function eligibility(client: PoolClient, s: Seed): Promise<RpcResult> {
  const { rows } = await client.query<{ r: RpcResult }>(
    `SELECT public.get_fiscal_year_reopen_eligibility($1, $2) AS r`,
    [s.companyId, s.closedId],
  )
  return rows[0].r
}

async function reopen(
  client: PoolClient,
  s: Seed,
  name = '2025',
  confirmed = true,
): Promise<RpcResult> {
  const { rows } = await client.query<{ r: RpcResult }>(
    `SELECT public.reopen_closed_fiscal_year($1, $2, $3, $4) AS r`,
    [s.companyId, s.closedId, name, confirmed],
  )
  return rows[0].r
}

async function blockerCodes(s: Seed): Promise<string[]> {
  const result = await withUserContext(s.ownerId, (client) => eligibility(client, s))
  return (result.blockers ?? []).map((b) => b.code)
}

/** A storno of `originalId` posted as the session user, as reverseEntry does it. */
async function postStorno(
  client: PoolClient,
  s: Seed,
  originalId: string,
  periodId: string,
  date: string,
): Promise<string> {
  const stornoId = randomUUID()
  await client.query(
    `INSERT INTO public.journal_entries
       (id, user_id, company_id, fiscal_period_id, voucher_number, voucher_series,
        entry_date, description, source_type, reverses_id, status)
     VALUES ($1, $2, $3, $4, 0, 'A', $5, 'Makulering', 'storno', $6, 'draft')`,
    [stornoId, s.ownerId, s.companyId, periodId, date, originalId],
  )
  await client.query(
    `INSERT INTO public.journal_entry_lines
       (journal_entry_id, account_number, debit_amount, credit_amount, sort_order)
     SELECT $1, account_number, credit_amount, debit_amount, sort_order
       FROM public.journal_entry_lines WHERE journal_entry_id = $2`,
    [stornoId, originalId],
  )
  await client.query(`SELECT * FROM public.commit_journal_entry($1, $2)`, [s.companyId, stornoId])
  const marked = await client.query(
    `UPDATE public.journal_entries SET status = 'reversed', reversed_by_id = $2
      WHERE id = $1 AND status = 'posted'`,
    [originalId, stornoId],
  )
  expect(marked.rowCount).toBe(1)
  return stornoId
}

describe('reopen_closed_fiscal_year: the owner reopens a year closed with a bokslut', () => {
  it('reopens, then the bokslut is reversed by storno and detached, all as the authenticated owner', async () => {
    const s = await seed()

    await withUserContext(s.ownerId, async (client) => {
      const preview = await eligibility(client, s)
      expect(preview).toMatchObject({ ok: true, eligible: true, blockers: [] })
      expect(preview.entries?.map((e) => e.kind)).toEqual(['result_appropriation', 'opening_balance', 'closing_entry'])
      expect(preview.annual_report).toMatchObject({ versions_to_supersede: 1, pending_signatures: 1 })

      // Closed: nothing can be booked in 2025 yet.
      await client.query('SAVEPOINT closed')
      await expect(postStorno(client, s, s.closingId, s.closedId, '2025-12-31')).rejects.toThrow()
      await client.query('ROLLBACK TO SAVEPOINT closed')

      const result = await reopen(client, s)
      expect(result).toMatchObject({ ok: true, resumed: false })

      const { rows: [period] } = await client.query(
        `SELECT is_closed, closed_at, locked_at, closing_entry_id FROM public.fiscal_periods WHERE id = $1`,
        [s.closedId],
      )
      expect(period).toMatchObject({ is_closed: false, closed_at: null, locked_at: null, closing_entry_id: s.closingId })

      const { rows: [version] } = await client.query(
        `SELECT status FROM public.annual_report_versions WHERE id = $1`, [s.versionId],
      )
      expect(version.status).toBe('superseded')
      const { rows: [next] } = await client.query(
        `SELECT continuity_verified FROM public.fiscal_periods WHERE id = $1`, [s.nextId],
      )
      expect(next.continuity_verified).toBeNull()

      const { rows: audit } = await client.query(
        `SELECT new_state FROM public.audit_log
          WHERE company_id = $1 AND table_name = 'fiscal_periods' AND record_id = $2
            AND description LIKE 'Fiscal year reopened by the owner%'`,
        [s.companyId, s.closedId],
      )
      expect(audit).toHaveLength(1)
      expect(audit[0].new_state).toMatchObject({
        confirmation: { confirmed_name: '2025', annual_report_not_signed_adopted_or_filed: true },
        superseded_annual_report_version_ids: [s.versionId],
        voided_signature_request_ids: [s.signatureId],
      })

      // The closing entry stays attached until its storno is posted.
      await client.query('SAVEPOINT live')
      await expect(
        client.query(`UPDATE public.fiscal_periods SET closing_entry_id = NULL WHERE id = $1`, [s.closedId]),
      ).rejects.toThrow(/year-end closing is immutable/)
      await client.query('ROLLBACK TO SAVEPOINT live')

      // The engine's half, in the same order: omföring, IB, closing entry.
      await postStorno(client, s, s.appropriationId, s.nextId, '2026-01-01')
      await postStorno(client, s, s.ibId, s.nextId, '2026-01-01')
      await client.query(
        `UPDATE public.fiscal_periods SET opening_balances_set = false WHERE id = $1 AND opening_balance_entry_id = $2`,
        [s.nextId, s.ibId],
      )
      await client.query(
        `UPDATE public.fiscal_periods SET opening_balance_entry_id = NULL WHERE id = $1 AND opening_balance_entry_id = $2`,
        [s.nextId, s.ibId],
      )
      await postStorno(client, s, s.closingId, s.closedId, '2025-12-31')
      const detached = await client.query(
        `UPDATE public.fiscal_periods SET closing_entry_id = NULL WHERE id = $1 AND closing_entry_id = $2`,
        [s.closedId, s.closingId],
      )
      expect(detached.rowCount).toBe(1)

      // Nothing was deleted: the bokslut and its storno both stand.
      const { rows: closing } = await client.query(
        `SELECT status, reversed_by_id FROM public.journal_entries WHERE id = $1`, [s.closingId],
      )
      expect(closing[0].status).toBe('reversed')
      expect(closing[0].reversed_by_id).not.toBeNull()

      // And the year takes the missing booking.
      const correctionId = randomUUID()
      await client.query(
        `INSERT INTO public.journal_entries
           (id, user_id, company_id, fiscal_period_id, voucher_number, voucher_series,
            entry_date, description, source_type, status)
         VALUES ($1, $2, $3, $4, 0, 'A', '2025-06-30', 'Utdelning beslutad', 'manual', 'draft')`,
        [correctionId, s.ownerId, s.companyId, s.closedId],
      )
      await client.query(
        `INSERT INTO public.journal_entry_lines (journal_entry_id, account_number, debit_amount, credit_amount)
         VALUES ($1, '2091', 500, 0), ($1, '2898', 0, 500)`,
        [correctionId],
      )
      const committed = await client.query<{ voucher_number: number }>(
        `SELECT * FROM public.commit_journal_entry($1, $2)`, [s.companyId, correctionId],
      )
      expect(committed.rows[0].voucher_number).toBeGreaterThan(0)
    })
  })

  it('resumes a reopen that stopped before the stornos', async () => {
    const s = await seed()
    await withUserContext(s.ownerId, async (client) => {
      expect(await reopen(client, s)).toMatchObject({ ok: true, resumed: false })
      const again = await reopen(client, s)
      expect(again).toMatchObject({ ok: true, resumed: true })
      expect((again.entries ?? []).map((e) => e.kind)).toEqual([
        'result_appropriation', 'opening_balance', 'closing_entry',
      ])
    })
  })

  it('refuses everyone but the owner', async () => {
    const s = await seed()
    for (const role of ['admin', 'member'] as const) {
      const userId = await insertAuthUser()
      await insertCompanyMember({ companyId: s.companyId, userId, role })
      await setActiveCompany(userId, s.companyId)
      await withUserContext(userId, async (client) => {
        expect(await eligibility(client, s)).toEqual({ ok: false, code: 'FISCAL_YEAR_REOPEN_FORBIDDEN' })
        expect(await reopen(client, s)).toEqual({ ok: false, code: 'FISCAL_YEAR_REOPEN_FORBIDDEN' })
      })
    }
    const { rows } = await getPool().query<{ allowed: boolean }>(
      `SELECT has_function_privilege('anon', 'public.reopen_closed_fiscal_year(uuid, uuid, text, boolean, uuid)', 'EXECUTE') AS allowed`,
    )
    expect(rows[0].allowed).toBe(false)
  })

  it('requires the typed confirmation and changes nothing without it', async () => {
    const s = await seed()
    await withUserContext(s.ownerId, async (client) => {
      expect(await reopen(client, s, '2025', false)).toEqual({ ok: false, code: 'FISCAL_YEAR_REOPEN_CONFIRMATION_REQUIRED' })
      expect(await reopen(client, s, '2024', true)).toEqual({ ok: false, code: 'FISCAL_YEAR_REOPEN_CONFIRMATION_MISMATCH' })
      const { rows: [period] } = await client.query(
        `SELECT is_closed FROM public.fiscal_periods WHERE id = $1`, [s.closedId],
      )
      expect(period.is_closed).toBe(true)
    })
  })

  it('refuses a year klarmarkerad as closed in a previous system, and an open year', async () => {
    const s = await seed()
    const externalId = await insertFiscalPeriod({
      userId: s.ownerId, companyId: s.companyId, name: '2024', periodStart: '2024-01-01', periodEnd: '2024-12-31',
    })
    await getPool().query(
      `UPDATE public.fiscal_periods SET is_closed = true, closed_at = now(), locked_at = now(), closed_externally = true WHERE id = $1`,
      [externalId],
    )
    await withUserContext(s.ownerId, async (client) => {
      const external = await client.query<{ r: RpcResult }>(
        `SELECT public.get_fiscal_year_reopen_eligibility($1, $2) AS r`, [s.companyId, externalId],
      )
      expect(external.rows[0].r.blockers?.map((b) => b.code)).toContain('closed_externally')
      const open = await client.query<{ r: RpcResult }>(
        `SELECT public.get_fiscal_year_reopen_eligibility($1, $2) AS r`, [s.companyId, s.nextId],
      )
      expect(open.rows[0].r.blockers?.map((b) => b.code)).toContain('not_closed_with_bokslut')
    })
  })
})

describe('reopen_closed_fiscal_year: the årsredovisning and the books built on the year', () => {
  it('refuses once a signature is recorded', async () => {
    const s = await seed()
    await getPool().query(
      `UPDATE public.arsredovisning_signature_requests
          SET status = 'signed', signed_at = now(), signing_method = 'paper_original',
              evidence_reference = 'document:signed-original', evidence_recorded_at = now(),
              evidence_recorded_by = $2
        WHERE id = $1`,
      [s.signatureId, s.ownerId],
    )
    expect(await blockerCodes(s)).toContain('annual_report_signed')
  })

  it('refuses a filed version', async () => {
    const s = await seed()
    await getPool().query(
      `INSERT INTO public.annual_report_versions
         (company_id, fiscal_period_id, user_id, version_number, schema_version, framework,
          status, report_data, content_hash, validation_summary, finalized_at, finalized_by)
       VALUES ($1, $2, $3, 2, '1.0', 'k2', 'filed', '{}'::jsonb, $4, '{}'::jsonb, now(), $3)`,
      [s.companyId, s.closedId, s.ownerId, 'b'.repeat(64)],
    )
    expect(await blockerCodes(s)).toContain('annual_report_submitted')
  })

  it('refuses when a later year is closed', async () => {
    const s = await seed()
    await getPool().query(
      `UPDATE public.fiscal_periods SET locked_at = now(), is_closed = true, closed_at = now() WHERE id = $1`,
      [s.nextId],
    )
    expect(await blockerCodes(s)).toContain('later_year_closed')
  })

  it('refuses when the next year is locked, naming it', async () => {
    const s = await seed()
    await getPool().query(`UPDATE public.fiscal_periods SET locked_at = now() WHERE id = $1`, [s.nextId])
    const result = await withUserContext(s.ownerId, (client) => eligibility(client, s))
    expect(result.blockers).toContainEqual({ code: 'next_year_locked', name: '2026' })
  })

  it('refuses when the company lock date covers the year end', async () => {
    const s = await seed()
    await getPool().query(
      `INSERT INTO public.company_settings (company_id, bookkeeping_locked_through) VALUES ($1, '2025-12-31')
       ON CONFLICT (company_id) DO UPDATE SET bookkeeping_locked_through = EXCLUDED.bookkeeping_locked_through`,
      [s.companyId],
    )
    expect(await blockerCodes(s)).toContain('company_lock_date')
  })
})

describe('reopen_closed_fiscal_year: Bolagsverket, read from the TIC snapshot', () => {
  it('refuses when an annual report for the year (or a later one) is registered', async () => {
    const s = await seed()
    await setRegistry(s.companyId, snapshot([
      { title: 'Årsredovisning', periodStart: '2025-01-01T00:00:00', periodEnd: '2025-12-31T00:00:00', isInterimReport: false },
    ]))
    expect(await blockerCodes(s)).toContain('annual_report_registered')

    await setRegistry(s.companyId, snapshot([
      { title: 'Årsredovisning', periodStart: '2026-01-01T00:00:00', periodEnd: '2026-12-31T00:00:00', isInterimReport: false },
    ]))
    expect(await blockerCodes(s)).toContain('annual_report_registered')
  })

  it('does not count an earlier year or an interim report', async () => {
    const s = await seed()
    await setRegistry(s.companyId, snapshot([
      { title: 'Årsredovisning', periodStart: '2024-01-01T00:00:00', periodEnd: '2024-12-31T00:00:00', isInterimReport: false },
      { title: 'Delårsrapport', periodStart: '2025-01-01T00:00:00', periodEnd: '2025-12-31T00:00:00', isInterimReport: true },
    ]))
    expect(await blockerCodes(s)).toEqual([])
  })

  it('fails closed when the registry state cannot be read with confidence', async () => {
    const cases: Array<[string, unknown, string | null]> = [
      ['no snapshot', null, null],
      ['stale snapshot', snapshot(), new Date(Date.now() - 8 * 24 * 3600 * 1000).toISOString()],
      ['reports list not known to be complete', snapshot([], { financialReportsComplete: false }), 'now'],
      ['snapshot without the completeness mark', { orgNumber: ORG, financialReports: [] }, 'now'],
      ['another org number', snapshot([], { orgNumber: '5561234567' }), 'now'],
      ['unreadable report date', snapshot([{ periodEnd: 'okänt', isInterimReport: false }]), 'now'],
    ]
    for (const [label, value, fetchedAt] of cases) {
      const s = await seed()
      await setRegistry(s.companyId, value, fetchedAt)
      expect(await blockerCodes(s), label).toContain('registry_unavailable')
    }
  })
})
