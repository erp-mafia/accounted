/**
 * pg-real tests for 20261120140000_support_remove_undone_sie_import (crm#1954):
 * a support operation removes an undone SIE import and its stornos and gives
 * the replacement import its old-system voucher numbers back.
 *
 * The scenario is the case itself, built once through the real SIE job RPCs:
 * a partial import of 400 verifikat (A1-A400), its undo (400 stornos,
 * A401-A800), the full import of 558 (A801-A1358, source numbers 1-558, no
 * source series), and the year locked after the import. Each test runs in a
 * savepoint of one transaction that is rolled back at the end.
 *
 *   - only the service role can call it;
 *   - the default is a dry run: the receipt says what would happen and
 *     nothing changes;
 *   - run for real: the 800 verifikat are gone, the 558 read A1-A558, equal
 *     to their source numbers, every account balance of the year is the same,
 *     the counter continues at 559, the year stays locked, the audit trail
 *     and the receipt on the undone import are written; a second call is
 *     refused;
 *   - with another verifikat in the series nothing is renumbered and the
 *     freed numbers get a gap explanation;
 *   - refused: a completed import, a storno another record points at, a
 *     closed year, a call without a reason or an actor;
 *   - the bypass does not outlive the call, and the service role cannot use
 *     it by setting the flags itself.
 */
import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { PoolClient } from 'pg'
import { getPool } from '@/tests/pg/setup'

const PARTIAL = 400
const FULL = 558
const CHUNK = 200
const DAY_MS = 86_400_000
const REASON = 'The first import was partial; the books should read as in the previous system.'
const ACTOR = 'Anna in support'
const SIGNATURE = 'public.support_remove_undone_sie_import(uuid,uuid,text,text,boolean)'
const LONG = 300_000
const TEST = 120_000

interface SeriesPlan {
  series: string
  mode: 'renumber' | 'gap_explanations'
  not_renumbered_because: string | null
  removed_numbers: Array<{ from: number; to: number }>
  replacement_import_id: string | null
  renumbered: number
  renumbered_from: { from: number; to: number } | null
  renumbered_to: { from: number; to: number } | null
  last_number_before: number | null
  last_number_after: number | null
  gap_explanations: Array<{ gap_start: number; gap_end: number }>
}

interface Receipt {
  ok: boolean
  dry_run: boolean
  import_id: string
  filename: string
  removed: { imported_verifikat: number; stornos: number; verifikat: number; lines: number }
  series: SeriesPlan[]
  reason: string
  actor_label: string
  removed_at: string | null
}

let client: PoolClient
let company: string
let actor: string
let period: string
let worker: string
let partialImport: string
let fullImport: string
let accounts: Record<'1930' | '3001', string>

function isoDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10)
}

/** One voucher of the source file: number n, its own amount, a date inside 2025/26. */
function voucher(batch: string, ordinal: number, sourceNumber: number) {
  const amount = 100 + sourceNumber
  return {
    sourceId: `A${sourceNumber}`, sourceOrdinal: ordinal, sieImportId: batch, series: 'A',
    date: isoDate(Date.UTC(2025, 4, 1) + ((sourceNumber - 1) % 365) * DAY_MS),
    description: `Synthetic voucher ${sourceNumber}`, sourceNumber, sourceType: 'import',
    lines: [
      { account_number: '1930', account_id: accounts['1930'], debit_amount: amount, credit_amount: 0, currency: 'SEK',
        line_description: null, sort_order: 0, dimensions: {} },
      { account_number: '3001', account_id: accounts['3001'], debit_amount: 0, credit_amount: amount, currency: 'SEK',
        line_description: null, sort_order: 1, dimensions: {} },
    ],
  }
}

function manifest(filename: string) {
  return {
    input: { filename, options: {}, mappings: [], fiscalYear: { start: '2025-05-01', end: '2026-04-30' } },
    file_storage_path: filename,
  }
}

/** The suite's login: the owner of the migrations' functions. */
async function asOwnerRole() {
  await client.query('RESET ROLE')
}

async function asServiceRole() {
  await client.query('RESET ROLE')
  await client.query(`SELECT set_config('request.jwt.claims','{"role":"service_role"}',true)`)
  await client.query(`SELECT set_config('request.jwt.claim.role','service_role',true)`)
  await client.query('SET LOCAL ROLE service_role')
}

async function asCompanyOwner() {
  await client.query('RESET ROLE')
  await client.query(`SELECT set_config('request.jwt.claims',$1,true)`, [JSON.stringify({ sub: actor, role: 'authenticated' })])
  await client.query(`SELECT set_config('request.jwt.claim.sub',$1,true)`, [actor])
  await client.query(`SELECT set_config('request.jwt.claim.role','authenticated',true)`)
  await client.query('SET LOCAL ROLE authenticated')
}

async function claim(id: string): Promise<number> {
  const { rows } = await client.query('SELECT j.* FROM public.claim_sie_import_job($1,$2) j', [worker, id])
  expect(rows[0].id).toBe(id)
  return rows[0].job_attempt
}

/** A durable import of source vouchers 1..count, in chunks of 200, as the worker runs it. */
async function runImport(filename: string, hash: string, count: number): Promise<string> {
  await asServiceRole()
  const input = manifest(filename)
  const id = (await client.query(`SELECT (public.start_sie_import_job($1,$2,$3,$4,$5,$6)).id`,
    [company, actor, period, filename, hash, JSON.stringify(input)])).rows[0].id as string
  const attempt = await claim(id)
  const vouchers = Array.from({ length: count }, (_, i) => voucher(id, i, i + 1))
  const chunks: unknown[][] = []
  for (let i = 0; i < vouchers.length; i += CHUNK) chunks.push(vouchers.slice(i, i + CHUNK))
  for (const [n, chunk] of chunks.entries()) {
    await client.query('SELECT public.save_sie_import_chunk($1,$2,$3,$4,$5,$6,$7)',
      [company, id, worker, attempt, 'vouchers', n, JSON.stringify(chunk)])
  }
  await client.query('SELECT public.seal_sie_import_preparation($1,$2,$3,$4,$5,$6)',
    [company, id, worker, attempt, JSON.stringify(input), chunks.length])
  for (let n = 0; n < chunks.length; n++) {
    await client.query('SELECT public.import_sie_chunk($1,$2,$3,$4,$5,$6)', [company, id, worker, attempt, 'vouchers', n])
  }
  await client.query('SELECT public.complete_sie_import_job($1,$2,$3,$4,$5,$6)', [company, id, worker, attempt,
    JSON.stringify({ success: true, journalEntriesCreated: count, warnings: [] }), JSON.stringify({ sourceSystem: 'Fortnox' })])
  return id
}

/** The batch undo, as the worker runs it: one storno per verifikat. */
async function undoImport(id: string) {
  await asServiceRole()
  await client.query('SELECT public.request_sie_import_undo($1,$2,$3)', [company, id, actor])
  const attempt = await claim(id)
  for (let step = 0; step < 10; step++) {
    const { rows } = await client.query('SELECT public.undo_sie_import_chunk($1,$2,$3,$4) AS r', [company, id, worker, attempt])
    if (rows[0].r.done) return
  }
  throw new Error('undo did not finish')
}

async function removeImport(importId: string, dryRun?: boolean): Promise<Receipt> {
  await asServiceRole()
  const { rows } = dryRun === undefined
    ? await client.query('SELECT public.support_remove_undone_sie_import($1,$2,$3,$4) AS r', [company, importId, REASON, ACTOR])
    : await client.query('SELECT public.support_remove_undone_sie_import($1,$2,$3,$4,$5) AS r',
      [company, importId, REASON, ACTOR, dryRun])
  return rows[0].r as Receipt
}

/** The error message of a statement that must be refused; everything it did is rolled back. */
async function refusal(run: () => Promise<unknown>): Promise<string> {
  await client.query('SAVEPOINT refusal')
  try {
    await run()
    return 'no refusal'
  } catch (error) {
    return (error as Error).message
  } finally {
    await client.query('ROLLBACK TO SAVEPOINT refusal')
  }
}

/** Run a test body in its own savepoint so the next test sees the scenario unchanged. */
async function inScenario(body: () => Promise<void>) {
  await asOwnerRole()
  await client.query('SAVEPOINT scenario')
  try {
    await body()
  } finally {
    await client.query('ROLLBACK TO SAVEPOINT scenario')
    await asOwnerRole()
  }
}

async function ledger() {
  await asOwnerRole()
  const { rows } = await client.query(
    `SELECT id, voucher_series, voucher_number, source_type, status, import_batch_id, source_voucher_number
       FROM public.journal_entries
      WHERE company_id = $1 AND fiscal_period_id = $2
      ORDER BY voucher_series, voucher_number`, [company, period])
  return rows as Array<{ id: string; voucher_series: string; voucher_number: number; source_type: string; status: string;
    import_batch_id: string | null; source_voucher_number: number | null }>
}

async function balances() {
  await asOwnerRole()
  const { rows } = await client.query(
    `SELECT l.account_number, round(sum(l.debit_amount - l.credit_amount), 2)::text AS net
       FROM public.journal_entry_lines l
       JOIN public.journal_entries e ON e.id = l.journal_entry_id
      WHERE e.company_id = $1 AND e.fiscal_period_id = $2 AND e.status IN ('posted', 'reversed')
      GROUP BY l.account_number
     HAVING round(sum(l.debit_amount - l.credit_amount), 2) <> 0
      ORDER BY l.account_number`, [company, period])
  return rows
}

async function lastNumber(): Promise<number> {
  await asOwnerRole()
  const { rows } = await client.query(
    `SELECT last_number FROM public.voucher_sequences WHERE company_id = $1 AND fiscal_period_id = $2 AND voucher_series = 'A'`,
    [company, period])
  return rows[0].last_number
}

/** A manual verifikat committed through commit_journal_entry, the year unlocked around it. */
async function commitManualVoucher(): Promise<number> {
  await asOwnerRole()
  await client.query('UPDATE public.fiscal_periods SET locked_at = NULL WHERE id = $1', [period])
  const id = randomUUID()
  await client.query(
    `INSERT INTO public.journal_entries(id,company_id,user_id,fiscal_period_id,voucher_series,voucher_number,
       entry_date,description,source_type,status)
     VALUES($1,$2,$3,$4,'A',0,'2026-04-30','Manual voucher','manual','draft')`, [id, company, actor, period])
  await client.query(
    `INSERT INTO public.journal_entry_lines(journal_entry_id,account_number,account_id,debit_amount,credit_amount,sort_order)
     VALUES($1,'1930',$2,50,0,0),($1,'3001',$3,0,50,1)`, [id, accounts['1930'], accounts['3001']])
  await asServiceRole()
  const { rows } = await client.query('SELECT * FROM public.commit_journal_entry($1,$2)', [company, id])
  await asOwnerRole()
  await client.query('UPDATE public.fiscal_periods SET locked_at = now() WHERE id = $1', [period])
  return rows[0].voucher_number
}

beforeAll(async () => {
  client = await getPool().connect()
  await client.query('BEGIN')
  ;[company, actor, period, worker] = Array.from({ length: 4 }, () => randomUUID())
  await client.query(`INSERT INTO auth.users(id,email,instance_id) VALUES($1,$2,'00000000-0000-0000-0000-000000000000')`,
    [actor, `sie-removal-${actor}@test.invalid`])
  await client.query(`INSERT INTO companies(id,name,entity_type,created_by) VALUES($1,'Synthetic Migration AB','aktiebolag',$2)`,
    [company, actor])
  await client.query(`INSERT INTO company_members(company_id,user_id,role) VALUES($1,$2,'owner')`, [company, actor])
  await client.query(`INSERT INTO fiscal_periods(id,company_id,user_id,name,period_start,period_end)
    VALUES($1,$2,$3,'2025/26','2025-05-01','2026-04-30')`, [period, company, actor])
  accounts = { '1930': randomUUID(), '3001': randomUUID() }
  for (const [number, kind, accountClass, balance] of [['1930', 'asset', 1, 'debit'], ['3001', 'revenue', 3, 'credit']] as const) {
    await client.query(`INSERT INTO chart_of_accounts(id,company_id,user_id,account_number,account_name,account_type,account_class,normal_balance)
      VALUES($1,$2,$3,$4,'Synthetic account',$5,$6,$7)`, [accounts[number], company, actor, number, kind, accountClass, balance])
  }

  partialImport = await runImport('partial.se', 'a'.repeat(64), PARTIAL)
  await undoImport(partialImport)
  fullImport = await runImport('full.se', 'b'.repeat(64), FULL)
  // The importer locks the year right after the import.
  await asOwnerRole()
  await client.query('UPDATE public.fiscal_periods SET locked_at = now() WHERE id = $1', [period])
}, LONG)

afterAll(async () => {
  if (client) {
    await client.query('ROLLBACK')
    client.release()
  }
})

describe('support_remove_undone_sie_import', () => {
  it('starts from the case: A1-A400 reversed, A401-A800 their stornos, A801-A1358 the full import', async () => {
    const rows = await ledger()
    expect(rows).toHaveLength(PARTIAL * 2 + FULL)
    expect(rows.slice(0, PARTIAL).every((r) => r.status === 'reversed' && r.import_batch_id === partialImport)).toBe(true)
    expect(rows.slice(PARTIAL, PARTIAL * 2).every((r) => r.source_type === 'storno' && r.status === 'posted')).toBe(true)
    const full = rows.slice(PARTIAL * 2)
    expect(full.every((r) => r.import_batch_id === fullImport && r.voucher_number - PARTIAL * 2 === r.source_voucher_number)).toBe(true)
    expect(await lastNumber()).toBe(PARTIAL * 2 + FULL)
  })

  it('is the service role\'s alone', async () => {
    await asOwnerRole()
    const { rows } = await client.query(
      `SELECT has_function_privilege('anon', $1, 'EXECUTE') AS anon,
              has_function_privilege('authenticated', $1, 'EXECUTE') AS authenticated,
              has_function_privilege('service_role', $1, 'EXECUTE') AS service_role`, [SIGNATURE])
    expect(rows[0]).toEqual({ anon: false, authenticated: false, service_role: true })

    const message = await refusal(async () => {
      await asCompanyOwner()
      await client.query('SELECT public.support_remove_undone_sie_import($1,$2,$3,$4,false)', [company, partialImport, REASON, ACTOR])
    })
    expect(message).toMatch(/permission denied for function support_remove_undone_sie_import/)
    await asOwnerRole()
    expect(await ledger()).toHaveLength(PARTIAL * 2 + FULL)
  })

  it('is a dry run by default: the receipt says what would happen and nothing changes', async () => {
    await inScenario(async () => {
      const before = await ledger()
      const receipt = await removeImport(partialImport)
      expect(receipt).toMatchObject({
        ok: true,
        dry_run: true,
        import_id: partialImport,
        filename: 'partial.se',
        removed: { imported_verifikat: PARTIAL, stornos: PARTIAL, verifikat: PARTIAL * 2, lines: PARTIAL * 4 },
        reason: REASON,
        actor_label: `Support: ${ACTOR}`,
        removed_at: null,
      })
      expect(receipt.series).toEqual([expect.objectContaining({
        series: 'A',
        mode: 'renumber',
        not_renumbered_because: null,
        removed_numbers: [{ from: 1, to: PARTIAL * 2 }],
        replacement_import_id: fullImport,
        renumbered: FULL,
        renumbered_from: { from: PARTIAL * 2 + 1, to: PARTIAL * 2 + FULL },
        renumbered_to: { from: 1, to: FULL },
        last_number_before: PARTIAL * 2 + FULL,
        last_number_after: FULL,
        gap_explanations: [],
      })])
      expect(await ledger()).toEqual(before)
      expect(await lastNumber()).toBe(PARTIAL * 2 + FULL)
      const { rows } = await client.query(
        `SELECT coalesce(job_result ? 'support_removal', false) AS removed FROM public.sie_imports WHERE id = $1`, [partialImport])
      expect(rows[0].removed).toBe(false)
    })
  }, TEST)

  it('removes the undone import and its stornos and restores the previous system\'s numbers', async () => {
    await inScenario(async () => {
      const before = await ledger()
      const removedIds = before.filter((r) => r.import_batch_id === partialImport || r.source_type === 'storno').map((r) => r.id)
      expect(removedIds).toHaveLength(PARTIAL * 2)
      const balancesBefore = await balances()
      const { rows: [{ locked_at: lockedAt }] } = await client.query('SELECT locked_at FROM public.fiscal_periods WHERE id = $1', [period])

      const receipt = await removeImport(partialImport, false)
      expect(receipt.dry_run).toBe(false)
      expect(receipt.removed_at).toEqual(expect.any(String))
      expect(receipt.series[0]).toMatchObject({ mode: 'renumber', renumbered: FULL, last_number_after: FULL })

      // 558 left, A1-A558, each on its source number; no storno, nothing of the undone import.
      const after = await ledger()
      expect(after).toHaveLength(FULL)
      expect(after.map((r) => r.voucher_number)).toEqual(Array.from({ length: FULL }, (_, i) => i + 1))
      expect(after.every((r) => r.voucher_number === r.source_voucher_number && r.import_batch_id === fullImport
        && r.status === 'posted')).toBe(true)
      expect(after.some((r) => r.source_type === 'storno')).toBe(false)

      // Every account balance of the year is what it was; the year stays locked.
      expect(await balances()).toEqual(balancesBefore)
      const { rows: [periodAfter] } = await client.query('SELECT locked_at, is_closed FROM public.fiscal_periods WHERE id = $1', [period])
      expect(periodAfter).toEqual({ locked_at: lockedAt, is_closed: false })

      // The counter continues after A558: the next verifikat is A559.
      expect(await lastNumber()).toBe(FULL)
      const { rows: gaps } = await client.query(
        'SELECT gap_start, gap_end FROM public.voucher_gap_explanations WHERE company_id = $1 AND fiscal_period_id = $2', [company, period])
      expect(gaps).toEqual([])

      // The audit trail: every deleted verifikat, every renumbered one, one summary row.
      const { rows: [deleted] } = await client.query(
        `SELECT count(*)::int AS n FROM public.audit_log
          WHERE company_id = $1 AND table_name = 'journal_entries' AND action = 'DELETE' AND record_id = ANY ($2)
            AND actor_type = 'system' AND actor_label = $3`, [company, removedIds, `Support: ${ACTOR}`])
      expect(deleted.n).toBe(PARTIAL * 2)
      const { rows: [renumbered] } = await client.query(
        `SELECT count(*)::int AS n FROM public.audit_log
          WHERE company_id = $1 AND table_name = 'journal_entries' AND action = 'UPDATE'
            AND (old_state ->> 'voucher_number') <> (new_state ->> 'voucher_number')
            AND actor_type = 'system' AND actor_label = $2`, [company, `Support: ${ACTOR}`])
      expect(renumbered.n).toBe(FULL)
      const { rows: summary } = await client.query(
        `SELECT action, actor_type, actor_label, new_state, description FROM public.audit_log
          WHERE company_id = $1 AND table_name = 'sie_imports' AND record_id = $2 AND actor_type = 'system'`,
        [company, partialImport])
      expect(summary).toHaveLength(1)
      expect(summary[0]).toMatchObject({ action: 'UPDATE', actor_label: `Support: ${ACTOR}` })
      expect(summary[0].new_state).toMatchObject({ filename: 'partial.se', reason: REASON, removed: { verifikat: PARTIAL * 2 } })
      expect(summary[0].description).toContain('partial.se')

      // The undone import stays in the history, marked removed with its receipt.
      const { rows: [job] } = await client.query(
        `SELECT job_state, job_result -> 'support_removal' AS removal FROM public.sie_imports WHERE id = $1`, [partialImport])
      expect(job.job_state).toBe('undone')
      expect(job.removal).toMatchObject({ dry_run: false, removed_at: receipt.removed_at, filename: 'partial.se' })

      // A second call is refused.
      expect(await refusal(() => removeImport(partialImport, false))).toMatch(/SIE_REMOVAL_ALREADY_REMOVED/)

      expect(await commitManualVoucher()).toBe(FULL + 1)
    })
  }, TEST)

  it('does not let the bypass outlive the call, and the service role cannot set it for itself', async () => {
    await inScenario(async () => {
      await removeImport(partialImport, false)
      const [first, second] = await ledger()

      // As the owner role, after the call: ordinary changes are refused as before.
      await asOwnerRole()
      expect(await refusal(() => client.query(`UPDATE public.journal_entries SET description = 'Changed' WHERE id = $1`, [first.id])))
        .toMatch(/Cannot modify a posted journal entry/)
      expect(await refusal(() => client.query('UPDATE public.journal_entries SET voucher_number = 9000 WHERE id = $1', [first.id])))
        .toMatch(/Cannot modify a posted journal entry/)
      expect(await refusal(() => client.query('DELETE FROM public.journal_entries WHERE id = $1', [first.id])))
        .toMatch(/Cannot delete journal entries/)

      // Even with the flags set, a posted verifikat of the import is not deletable.
      expect(await refusal(async () => {
        await client.query(`SELECT set_config('gnubok.allow_delete','true',true)`)
        await client.query(`SELECT set_config('gnubok.support_sie_removal',$1,true)`, [fullImport])
        await client.query('DELETE FROM public.journal_entries WHERE id = $1', [second.id])
      })).toMatch(/SIE batch entries cannot be deleted/)

      // The service role setting the renumber flag itself gets nothing: it is not the function's owner.
      expect(await refusal(async () => {
        await asServiceRole()
        await client.query(`SELECT set_config('gnubok.support_sie_renumber',$1,true)`, [fullImport])
        await client.query('UPDATE public.journal_entries SET voucher_number = 9000 WHERE id = $1', [first.id])
      })).toMatch(/Cannot modify a posted journal entry/)

      const after = await ledger()
      expect(after.slice(0, 2).map((r) => r.voucher_number)).toEqual([1, 2])
    })
  }, TEST)

  it('explains the freed numbers as a gap when another verifikat shares the series', async () => {
    await inScenario(async () => {
      expect(await commitManualVoucher()).toBe(PARTIAL * 2 + FULL + 1)
      const balancesBefore = await balances()

      const receipt = await removeImport(partialImport, false)
      expect(receipt.series).toEqual([expect.objectContaining({
        mode: 'gap_explanations',
        not_renumbered_because: 'other_verifikat_in_series',
        renumbered: 0,
        last_number_before: PARTIAL * 2 + FULL + 1,
        last_number_after: PARTIAL * 2 + FULL + 1,
        gap_explanations: [{ gap_start: 1, gap_end: PARTIAL * 2 }],
      })])

      const after = await ledger()
      expect(after).toHaveLength(FULL + 1)
      expect(after[0].voucher_number).toBe(PARTIAL * 2 + 1)
      expect(after.at(-1)!.voucher_number).toBe(PARTIAL * 2 + FULL + 1)
      expect(await balances()).toEqual(balancesBefore)
      expect(await lastNumber()).toBe(PARTIAL * 2 + FULL + 1)
      const { rows } = await client.query(
        `SELECT gap_start, gap_end, explanation FROM public.voucher_gap_explanations
          WHERE company_id = $1 AND fiscal_period_id = $2 AND voucher_series = 'A'`, [company, period])
      expect(rows).toHaveLength(1)
      expect(rows[0]).toMatchObject({ gap_start: 1, gap_end: PARTIAL * 2 })
      expect(rows[0].explanation).toContain('partial.se')
    })
  }, TEST)

  it('refuses an import that is not undone', async () => {
    expect(await refusal(() => removeImport(fullImport, false))).toMatch(/SIE_REMOVAL_IMPORT_NOT_UNDONE/)
    expect(await refusal(() => removeImport(fullImport))).toMatch(/SIE_REMOVAL_IMPORT_NOT_UNDONE/)
  }, TEST)

  it('refuses when another record points at one of the verifikat, and changes nothing', async () => {
    await inScenario(async () => {
      // Even a reference that would cascade away with the verifikat refuses:
      // a "no underlag needed" mark on one of the stornos.
      const storno = (await ledger()).find((r) => r.source_type === 'storno')!
      await client.query(
        `INSERT INTO public.journal_entry_no_doc_required (journal_entry_id, company_id, user_id, reason)
         VALUES ($1, $2, $3, 'Storno of an import')`, [storno.id, company, actor])
      expect(await refusal(() => removeImport(partialImport, false)))
        .toMatch(/SIE_REMOVAL_ENTRIES_REFERENCED: .*journal_entry_no_doc_required\.journal_entry_id \(1\)/)
      expect(await refusal(() => removeImport(partialImport))).toMatch(/SIE_REMOVAL_ENTRIES_REFERENCED/)
      expect(await ledger()).toHaveLength(PARTIAL * 2 + FULL)
    })
  }, TEST)

  it('refuses a closed year', async () => {
    await inScenario(async () => {
      await client.query('UPDATE public.fiscal_periods SET is_closed = true, closed_at = now() WHERE id = $1', [period])
      expect(await refusal(() => removeImport(partialImport, false))).toMatch(/SIE_REMOVAL_PERIOD_CLOSED/)
      expect(await ledger()).toHaveLength(PARTIAL * 2 + FULL)
    })
  }, TEST)

  it('refuses without a reason or a support actor', async () => {
    await asServiceRole()
    expect(await refusal(() => client.query('SELECT public.support_remove_undone_sie_import($1,$2,$3,$4)',
      [company, partialImport, 'short', ACTOR]))).toMatch(/SIE_REMOVAL_INVALID_INPUT/)
    expect(await refusal(() => client.query('SELECT public.support_remove_undone_sie_import($1,$2,$3,$4)',
      [company, partialImport, REASON, ' ']))).toMatch(/SIE_REMOVAL_INVALID_INPUT/)
    await asOwnerRole()
  })
})
