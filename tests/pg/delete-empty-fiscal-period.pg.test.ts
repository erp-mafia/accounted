/**
 * pg-real tests for delete_empty_fiscal_period (migration 20261028030547,
 * crm#1450).
 *
 * The case that must work: an aktiebolag has an empty räkenskapsår seeded a
 * year before it existed (2025-03-01..2026-02-28), then its real first year
 * with verifikat. Removing the empty year succeeds, clears the next year's
 * previous_period_id, writes audit_log and leaves every verifikat as it was;
 * afterwards the real first year is the earliest, so the existing first-year
 * rule (BFL 3 kap. 3 §) lets it start mid-month.
 *
 * Everything else refuses with FISCAL_PERIOD_DELETE_BLOCKED and a named
 * Swedish blocker: a year after the first, the only year, a year holding a
 * draft or a verifikat, a locked or closed year, the company lock date, and
 * any row pointing at the year. Viewers and outsiders get FORBIDDEN; anon
 * cannot execute the function.
 */
import { describe, expect, it } from 'vitest'
import { getPool, runAsServiceRole } from '@/tests/pg/setup'
import {
  insertAuthUser,
  insertCompany,
  insertCompanyMember,
  insertDraftJournalEntry,
  insertFiscalPeriod,
  insertPostedJournalEntry,
} from '@/tests/pg/fixtures'

interface DeleteResult {
  ok: boolean
  code?: string
  blockers?: Array<{ code: string; message_sv: string }>
  period?: { id: string }
}

interface Book {
  userId: string
  companyId: string
  ghostId: string
  firstId: string
}

const SQL = `SELECT public.delete_empty_fiscal_period($1::uuid, $2::uuid, $3::uuid) AS result`
const PREVIEW_SQL = `SELECT public.delete_empty_fiscal_period_preview($1::uuid, $2::uuid, $3::uuid) AS result`

/** The crm#1450 shape: an empty year before the company, then the real first year. */
async function seedBook(): Promise<Book> {
  const userId = await insertAuthUser()
  const companyId = await insertCompany({ createdBy: userId, entityType: 'aktiebolag' })
  await insertCompanyMember({ companyId, userId, role: 'owner' })
  const ghostId = await insertFiscalPeriod({
    userId,
    companyId,
    periodStart: '2025-03-01',
    periodEnd: '2026-02-28',
    name: 'Räkenskapsår 2025/2026',
  })
  const firstId = await insertFiscalPeriod({
    userId,
    companyId,
    periodStart: '2026-03-01',
    periodEnd: '2027-04-30',
    name: 'Räkenskapsår 2026/2027',
  })
  await getPool().query(`UPDATE public.fiscal_periods SET previous_period_id = $1 WHERE id = $2`, [ghostId, firstId])
  await insertPostedJournalEntry({ userId, companyId, fiscalPeriodId: firstId, entryDate: '2026-03-05', voucherNumber: 1 })
  return { userId, companyId, ghostId, firstId }
}

async function remove(
  book: Book,
  periodId: string,
  opts: { actor?: string | null; dryRun?: boolean } = {},
): Promise<DeleteResult> {
  const actor = opts.actor === undefined ? book.userId : opts.actor
  const res = await runAsServiceRole((client) =>
    client.query<{ result: DeleteResult }>(opts.dryRun ? PREVIEW_SQL : SQL, [book.companyId, periodId, actor]),
  )
  return res.rows[0].result
}

async function periodExists(periodId: string): Promise<boolean> {
  const { rows } = await getPool().query(`SELECT 1 FROM public.fiscal_periods WHERE id = $1`, [periodId])
  return rows.length === 1
}

function codes(result: DeleteResult): string[] {
  return (result.blockers ?? []).map((b) => b.code)
}

describe('delete_empty_fiscal_period', () => {
  it('removes the empty first year, re-roots the chain and writes audit_log', async () => {
    const book = await seedBook()
    const { rows: before } = await getPool().query(
      `SELECT id, entry_date::text, voucher_number, fiscal_period_id FROM public.journal_entries WHERE company_id = $1`,
      [book.companyId],
    )

    const result = await remove(book, book.ghostId)

    expect(result).toMatchObject({ ok: true })
    expect(await periodExists(book.ghostId)).toBe(false)
    const { rows: first } = await getPool().query<{ previous_period_id: string | null }>(
      `SELECT previous_period_id FROM public.fiscal_periods WHERE id = $1`,
      [book.firstId],
    )
    expect(first[0].previous_period_id).toBeNull()
    const { rows: after } = await getPool().query(
      `SELECT id, entry_date::text, voucher_number, fiscal_period_id FROM public.journal_entries WHERE company_id = $1`,
      [book.companyId],
    )
    expect(after).toEqual(before)
    const { rows: audit } = await getPool().query<{ actor_id: string | null }>(
      `SELECT actor_id FROM public.audit_log
        WHERE company_id = $1 AND table_name = 'fiscal_periods' AND record_id = $2 AND action = 'DELETE'`,
      [book.companyId, book.ghostId],
    )
    expect(audit.map((a) => a.actor_id)).toContain(book.userId)
  })

  it('removes an empty first year together with the framework row seeded with it', async () => {
    const book = await seedBook()
    const framework = `SELECT 1 FROM public.fiscal_period_frameworks WHERE fiscal_period_id = $1`
    expect((await getPool().query(framework, [book.ghostId])).rowCount).toBe(1)
    expect(await remove(book, book.ghostId, { dryRun: true })).toMatchObject({ ok: true })
    expect(await remove(book, book.ghostId)).toMatchObject({ ok: true })
    expect(await periodExists(book.ghostId)).toBe(false)
    expect((await getPool().query(framework, [book.ghostId])).rowCount).toBe(0)
  })

  it('lets the real first year start on the registration day once the empty year is gone', async () => {
    const book = await seedBook()
    const redate = () =>
      runAsServiceRole((client) =>
        client.query<{ result: { ok: boolean } }>(
          `SELECT public.redate_fiscal_period($1::uuid, $2::uuid, '2026-03-04'::date, NULL::date, NULL::text, false, $3::uuid) AS result`,
          [book.companyId, book.firstId, book.userId],
        ),
      )
    // While the empty year precedes it, a mid-month start is refused (BFL 3 kap. 1 §).
    expect((await redate()).rows[0].result.ok).toBe(false)
    expect((await remove(book, book.ghostId)).ok).toBe(true)
    // Now it is the earliest year: the registration day is a legal start (BFL 3 kap. 3 §).
    expect((await redate()).rows[0].result.ok).toBe(true)
  })

  it('the preview (dry run) answers ok, writes nothing and is STABLE', async () => {
    const book = await seedBook()
    const result = await remove(book, book.ghostId, { dryRun: true })
    expect(result).toMatchObject({ ok: true })
    const { rows } = await getPool().query<{ volatility: string }>(
      `SELECT provolatile AS volatility FROM pg_proc
        WHERE oid = 'public.delete_empty_fiscal_period_preview(uuid,uuid,uuid)'::regprocedure`,
    )
    expect(rows[0].volatility).toBe('s')
    expect(await periodExists(book.ghostId)).toBe(true)
  })

  it('refuses a year that is not the first, and names that it holds verifikat', async () => {
    const book = await seedBook()
    const result = await remove(book, book.firstId)
    expect(result).toMatchObject({ ok: false, code: 'FISCAL_PERIOD_DELETE_BLOCKED' })
    expect(codes(result)).toEqual(expect.arrayContaining(['not_first_year', 'has_entries']))
    expect(await periodExists(book.firstId)).toBe(true)
  })

  it('refuses the only year', async () => {
    const book = await seedBook()
    expect((await remove(book, book.ghostId)).ok).toBe(true)
    const result = await remove(book, book.firstId)
    expect(codes(result)).toContain('only_year')
  })

  it('refuses a first year that holds a draft', async () => {
    const book = await seedBook()
    await insertDraftJournalEntry({
      userId: book.userId,
      companyId: book.companyId,
      fiscalPeriodId: book.ghostId,
      entryDate: '2025-06-01',
    })
    const result = await remove(book, book.ghostId)
    expect(codes(result)).toContain('has_entries')
    expect(await periodExists(book.ghostId)).toBe(true)
  })

  it('refuses a locked first year and one behind the company lock date', async () => {
    const book = await seedBook()
    await getPool().query(`UPDATE public.fiscal_periods SET locked_at = now() WHERE id = $1`, [book.ghostId])
    expect(codes(await remove(book, book.ghostId))).toContain('period_locked')

    const other = await seedBook()
    // The fixture company has no settings row yet: upsert, as company-grants.pg.test.ts does.
    await getPool().query(
      `INSERT INTO public.company_settings (company_id, bookkeeping_locked_through) VALUES ($1, '2025-12-31')
       ON CONFLICT (company_id) DO UPDATE SET bookkeeping_locked_through = EXCLUDED.bookkeeping_locked_through`,
      [other.companyId],
    )
    expect(codes(await remove(other, other.ghostId))).toContain('company_lock_date')
  })

  it('refuses a year with a voucher number already issued', async () => {
    const book = await seedBook()
    await getPool().query(
      `INSERT INTO public.voucher_sequences (user_id, company_id, fiscal_period_id, voucher_series, last_number)
       VALUES ($1, $2, $3, 'A', 2)`,
      [book.userId, book.companyId, book.ghostId],
    )
    expect(codes(await remove(book, book.ghostId))).toContain('voucher_numbers_issued')
  })

  it('refuses a viewer and an outsider', async () => {
    const book = await seedBook()
    const viewer = await insertAuthUser()
    await insertCompanyMember({ companyId: book.companyId, userId: viewer, role: 'viewer' })
    expect(await remove(book, book.ghostId, { actor: viewer })).toMatchObject({ ok: false, code: 'FORBIDDEN' })
    const outsider = await insertAuthUser()
    expect(await remove(book, book.ghostId, { actor: outsider })).toMatchObject({ ok: false, code: 'FORBIDDEN' })
    expect(await periodExists(book.ghostId)).toBe(true)
  })

  it('answers PERIOD_NOT_FOUND for a year of another company', async () => {
    const book = await seedBook()
    const other = await seedBook()
    expect(await remove(book, other.ghostId)).toMatchObject({ ok: false, code: 'PERIOD_NOT_FOUND' })
  })

  it('anon cannot execute it; authenticated and service_role can', async () => {
    const { rows } = await getPool().query<{ anon: boolean; auth: boolean; service: boolean }>(
      `SELECT has_function_privilege('anon', p.oid, 'EXECUTE') AS anon,
              has_function_privilege('authenticated', p.oid, 'EXECUTE') AS auth,
              has_function_privilege('service_role', p.oid, 'EXECUTE') AS service
         FROM pg_proc p
        WHERE p.oid = 'public.delete_empty_fiscal_period(uuid,uuid,uuid)'::regprocedure`,
    )
    expect(rows[0]).toEqual({ anon: false, auth: true, service: true })
  })

  it('accepts delete_fiscal_period as a pending operation type', async () => {
    const { rows } = await getPool().query<{ def: string; validated: boolean }>(
      `SELECT pg_get_constraintdef(oid) AS def, convalidated AS validated FROM pg_constraint
        WHERE conrelid = 'public.pending_operations'::regclass
          AND conname = 'pending_operations_operation_type_check'`,
    )
    expect(rows[0].def).toContain("'delete_fiscal_period'")
    expect(rows[0].validated).toBe(true)
  })
})
