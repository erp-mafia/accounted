import { describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { getPool, withUserContext } from '@/tests/pg/setup'
import { insertFiscalPeriod, seedCompany } from '@/tests/pg/fixtures'

/**
 * Covers 20261124183000_inline_rattelse_refuses_stornoed_original.
 *
 * A verifikat in a locked year is corrected with a storno in the first open
 * period, and the original stays 'posted' in its own year. Once that year is
 * unlocked, correct_entry_lines_inline and correct_entry_metadata checked the
 * status only, so a write member calling them directly could change the
 * original under the storno that already reverses it. This proves:
 *
 *   1. both RPCs refuse such an original, for the service role and for a
 *      signed-in member calling them directly, with the sentence the
 *      application answers (JOURNAL_RATTELSE_REFUSED), and nothing is written:
 *      its lines, text and date stay, and no rättelse is logged;
 *   2. inline rättelse still works in the same reopened year for a verifikat
 *      no storno reverses, and for one whose storno is only a draft;
 *   3. both functions keep one signature, SECURITY DEFINER, search_path
 *      public and their grants.
 */

const REFUSAL = /Verifikationen är redan rättad med storno i en senare period/

async function insertDraft(opts: {
  userId: string
  companyId: string
  fiscalPeriodId: string
  entryDate: string
  sourceType: string
  description: string
  reversesId?: string | null
}): Promise<string> {
  const id = randomUUID()
  await getPool().query(
    `INSERT INTO public.journal_entries
       (id, user_id, company_id, fiscal_period_id, voucher_number, voucher_series,
        entry_date, description, source_type, status, reverses_id)
     VALUES ($1, $2, $3, $4, 0, 'A', $5, $6, $7, 'draft', $8)`,
    [
      id,
      opts.userId,
      opts.companyId,
      opts.fiscalPeriodId,
      opts.entryDate,
      opts.description,
      opts.sourceType,
      opts.reversesId ?? null,
    ],
  )
  return id
}

async function insertLines(entryId: string, debitAcc: string, creditAcc: string, amount: number): Promise<void> {
  await getPool().query(
    `INSERT INTO public.journal_entry_lines
       (journal_entry_id, account_number, debit_amount, credit_amount, sort_order)
     VALUES ($1, $2, $3, 0, 1), ($1, $4, 0, $3, 2)`,
    [entryId, debitAcc, amount, creditAcc],
  )
}

async function commit(companyId: string, entryId: string): Promise<void> {
  await getPool().query(`SELECT * FROM public.commit_journal_entry($1::uuid, $2::uuid)`, [companyId, entryId])
}

/** A posted 6110 / 1930 verifikat in 2025, and the id of its 6110 line. */
async function postOriginal(
  w: { userId: string; companyId: string; fp2025: string },
  description: string,
): Promise<{ id: string; expenseLineId: string }> {
  const id = await insertDraft({
    userId: w.userId,
    companyId: w.companyId,
    fiscalPeriodId: w.fp2025,
    entryDate: '2025-11-15',
    sourceType: 'manual',
    description,
  })
  await insertLines(id, '6110', '1930', 1250)
  await commit(w.companyId, id)
  const { rows } = await getPool().query<{ id: string }>(
    `SELECT id FROM public.journal_entry_lines WHERE journal_entry_id = $1 AND account_number = '6110'`,
    [id],
  )
  return { id, expenseLineId: rows[0]!.id }
}

/**
 * 2025 holds three posted verifikat: one a posted storno in 2026 reverses
 * (booked while 2025 was locked), one with only a draft storno, one with
 * none. Then 2025 is unlocked again, so the period checks let every inline
 * rättelse through and only the new refusal can stop one.
 */
async function world() {
  const { userId, companyId, fiscalPeriodId: fp2026 } = await seedCompany()
  const fp2025 = await insertFiscalPeriod({
    userId,
    companyId,
    name: '2025',
    periodStart: '2025-01-01',
    periodEnd: '2025-12-31',
  })
  // The replacement line's account must be in the chart (the RPC's chart check).
  await getPool().query(
    `INSERT INTO public.chart_of_accounts
       (user_id, company_id, account_number, account_name, account_class, account_type, normal_balance)
     VALUES ($1, $2, '5460', 'Förbrukningsmaterial', 5, 'expense', 'debit')
     ON CONFLICT DO NOTHING`,
    [userId, companyId],
  )
  const w = { userId, companyId, fp2025, fp2026 }

  const stornoed = await postOriginal(w, 'Kontorsmaterial')
  const draftStornoed = await postOriginal(w, 'Pennor')
  const plain = await postOriginal(w, 'Papper')

  await getPool().query(`UPDATE public.fiscal_periods SET locked_at = now() WHERE id = $1`, [fp2025])

  const stornoId = await insertDraft({
    userId,
    companyId,
    fiscalPeriodId: fp2026,
    entryDate: '2026-03-02',
    sourceType: 'storno',
    description: 'Storno av verifikat (2025-11-15): Kontorsmaterial',
    reversesId: stornoed.id,
  })
  await insertLines(stornoId, '1930', '6110', 1250)
  await commit(companyId, stornoId)

  // Never posted: a draft storno reverses nothing.
  const draftStornoId = await insertDraft({
    userId,
    companyId,
    fiscalPeriodId: fp2026,
    entryDate: '2026-03-02',
    sourceType: 'storno',
    description: 'Storno av verifikat (2025-11-15): Pennor',
    reversesId: draftStornoed.id,
  })
  await insertLines(draftStornoId, '1930', '6110', 1250)

  await getPool().query(`UPDATE public.fiscal_periods SET locked_at = NULL WHERE id = $1`, [fp2025])

  return { ...w, stornoed, draftStornoed, plain, stornoId }
}

/** The struck 6110 debit, replaced by the same amount on 5460. */
const REPLACEMENT = JSON.stringify([{ account_number: '5460', debit_amount: 1250, credit_amount: 0 }])

const LINES_SQL = `SELECT public.correct_entry_lines_inline(
  p_company_id => $1::uuid, p_entry_id => $2::uuid, p_strike_line_ids => ARRAY[$3::uuid],
  p_new_lines => $4::jsonb, p_user_id => $5::uuid) AS result`

const METADATA_SQL = `SELECT public.correct_entry_metadata(
  p_company_id => $1::uuid, p_entry_id => $2::uuid, p_description => $3,
  p_entry_date => $4::date, p_user_id => $5::uuid) AS result`

async function state(entryId: string) {
  const [{ rows: entry }, { rows: lines }, { rows: log }] = await Promise.all([
    getPool().query<{ status: string; description: string; entry_date: string }>(
      `SELECT status, description, entry_date::text FROM public.journal_entries WHERE id = $1`,
      [entryId],
    ),
    getPool().query<{ account_number: string; debit: string; credit: string }>(
      `SELECT account_number, debit_amount::text AS debit, credit_amount::text AS credit
         FROM public.journal_entry_lines WHERE journal_entry_id = $1 ORDER BY account_number`,
      [entryId],
    ),
    getPool().query<{ rattelse_type: string }>(
      `SELECT rattelse_type FROM public.journal_entry_rattelse_log WHERE journal_entry_id = $1 ORDER BY created_at`,
      [entryId],
    ),
  ])
  return {
    entry: entry[0]!,
    lines: lines.map((l) => `${l.account_number} ${Number(l.debit)} ${Number(l.credit)}`),
    log: log.map((l) => l.rattelse_type),
  }
}

describe('inline rättelse of a verifikat a posted storno already reverses (pg-real)', () => {
  it('refuses the lines and the text and date through the service role, writing nothing', async () => {
    const w = await world()
    // The moved storno stands in 2026; the original stays posted in its reopened year.
    const { rows: storno } = await getPool().query<{ status: string; reverses_id: string; fiscal_period_id: string }>(
      `SELECT status, reverses_id, fiscal_period_id FROM public.journal_entries WHERE id = $1`,
      [w.stornoId],
    )
    expect(storno[0]).toEqual({ status: 'posted', reverses_id: w.stornoed.id, fiscal_period_id: w.fp2026 })
    const before = await state(w.stornoed.id)
    expect(before.entry).toMatchObject({ status: 'posted', description: 'Kontorsmaterial', entry_date: '2025-11-15' })

    await expect(
      getPool().query(LINES_SQL, [w.companyId, w.stornoed.id, w.stornoed.expenseLineId, REPLACEMENT, w.userId]),
    ).rejects.toThrow(REFUSAL)
    await expect(
      getPool().query(METADATA_SQL, [w.companyId, w.stornoed.id, 'Annan text', '2025-11-20', w.userId]),
    ).rejects.toThrow(REFUSAL)
    // A no-op text change is refused too: the verifikat is not a rättelse target at all.
    await expect(
      getPool().query(METADATA_SQL, [w.companyId, w.stornoed.id, null, null, w.userId]),
    ).rejects.toThrow(REFUSAL)

    expect(await state(w.stornoed.id)).toEqual(before)
    expect(before.lines).toEqual(['1930 0 1250', '6110 1250 0'])
    expect(before.log).toEqual([])
  })

  it('refuses a signed-in member calling the RPCs directly', async () => {
    const w = await world()
    const before = await state(w.stornoed.id)

    await expect(
      withUserContext(w.userId, (client) =>
        client.query(LINES_SQL, [w.companyId, w.stornoed.id, w.stornoed.expenseLineId, REPLACEMENT, null]),
      ),
    ).rejects.toThrow(REFUSAL)
    await expect(
      withUserContext(w.userId, (client) =>
        client.query(METADATA_SQL, [w.companyId, w.stornoed.id, 'Annan text', null, null]),
      ),
    ).rejects.toThrow(REFUSAL)

    expect(await state(w.stornoed.id)).toEqual(before)
  })

  it('still corrects a verifikat no storno reverses, in the same reopened year', async () => {
    const w = await world()

    const { rows } = await getPool().query<{ result: { log_id: string; struck_count: number; added_count: number } }>(
      LINES_SQL,
      [w.companyId, w.plain.id, w.plain.expenseLineId, REPLACEMENT, w.userId],
    )
    expect(rows[0]!.result).toMatchObject({ struck_count: 1, added_count: 1 })
    const { rows: meta } = await getPool().query<{ result: { changed: boolean } }>(METADATA_SQL, [
      w.companyId,
      w.plain.id,
      'Papper, rättad text',
      '2025-11-20',
      w.userId,
    ])
    expect(meta[0]!.result.changed).toBe(true)

    expect(await state(w.plain.id)).toEqual({
      entry: { status: 'posted', description: 'Papper, rättad text', entry_date: '2025-11-20' },
      lines: ['1930 0 1250', '5460 1250 0'],
      log: ['lines', 'metadata'],
    })
  })

  it('still corrects a verifikat whose storno is only a draft', async () => {
    const w = await world()

    const { rows } = await getPool().query<{ result: { struck_count: number } }>(LINES_SQL, [
      w.companyId,
      w.draftStornoed.id,
      w.draftStornoed.expenseLineId,
      REPLACEMENT,
      w.userId,
    ])
    expect(rows[0]!.result.struck_count).toBe(1)
    expect(await state(w.draftStornoed.id)).toMatchObject({
      lines: ['1930 0 1250', '5460 1250 0'],
      log: ['lines'],
    })
  })
})

describe('signatures, security and grants', () => {
  it.each(['correct_entry_metadata', 'correct_entry_lines_inline'])(
    '%s keeps one signature, SECURITY DEFINER with search_path public, executable by authenticated and service_role only',
    async (name) => {
      const { rows } = await getPool().query<{
        sig: string
        definer: boolean
        config: string[] | null
        anon: boolean
        authenticated: boolean
        service_role: boolean
        public_exec: boolean
      }>(
        `SELECT p.oid::regprocedure::text AS sig,
                p.prosecdef AS definer,
                p.proconfig AS config,
                has_function_privilege('anon', p.oid, 'EXECUTE') AS anon,
                has_function_privilege('authenticated', p.oid, 'EXECUTE') AS authenticated,
                has_function_privilege('service_role', p.oid, 'EXECUTE') AS service_role,
                EXISTS (SELECT 1 FROM aclexplode(p.proacl) a WHERE a.grantee = 0) AS public_exec
           FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname = $1`,
        [name],
      )
      expect(rows).toHaveLength(1)
      expect(rows[0]!.sig).toMatch(/,text,text\)$/)
      expect(rows[0]!.config).toEqual(['search_path=public'])
      expect(rows[0]).toMatchObject({
        definer: true,
        anon: false,
        authenticated: true,
        service_role: true,
        public_exec: false,
      })
    },
  )
})
