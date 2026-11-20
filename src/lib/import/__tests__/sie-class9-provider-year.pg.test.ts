/**
 * #3312 end to end against real SQL: the provider retry of a Fortnox year
 * with class 9 amounts, for a company whose earlier year left what the
 * provider step used to leave behind, stored 9xxx-to-9xxx mappings and the
 * 9xxx rows in the chart.
 *
 * The mappings are built as GET /sie-data builds them (the merged dataset,
 * the company chart first, then BAS) and completed as the onboarding step
 * completes them. The job then runs through the production preparation and
 * worker against the real RPCs: before #3312 its class check refused the
 * year at admission, here it must complete with every verifikat balanced,
 * nothing posted on class 9, and the stored mappings moved to 2999 so the
 * next fetch starts from the same decision.
 */
import { createHash, randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { PoolClient } from 'pg'
import { getPool } from '@/tests/pg/setup'
import { stagingSIEClient } from '@/tests/pg/sie-client'
import { BAS_REFERENCE } from '@/lib/bookkeeping/bas-data'
import { resolveOnboardingMappings } from '@/lib/onboarding-books/mappings'
import { prepareSIEJob } from '../sie-job-preparation'
import { runSIEWorker } from '../sie-job-worker'
import { suggestSIEMappings } from '../sie-preview-mappings'
import { parseSIEFile } from '../sie-parser'
import { mergeParsedSIEFiles } from '../sie-merge'
import { isSystemAccount } from '../account-mapper'
import { SIE_JOB_VERSION, type SIEJob } from '../sie-job-contract'
import type { SIEAccountMappingRecord } from '../types'

const CHART = [
  '#KONTO 1930 "Företagskonto"', '#KONTO 2099 "Årets resultat"', '#KONTO 3001 "Försäljning tjänster"',
  '#KONTO 9000 "Debiterbar tid"', '#KONTO 9010 "Motkonto tid"', '#KONTO 9999 "OBS-konto"',
]
const FY2025 = [
  '#FLAGGA 0', '#PROGRAM "Fortnox" 3.0', '#SIETYP 4', '#FNAMN "Konsultbolaget AB"', '#RAR 0 20250101 20251231', ...CHART,
  '#VER A 1 20250115 "Faktura 1"', '{', '#TRANS 1930 {} 1000.00', '#TRANS 3001 {} -1000.00', '}',
].join('\n')
const FY2026 = [
  '#FLAGGA 0', '#PROGRAM "Fortnox" 3.0', '#SIETYP 4', '#FNAMN "Konsultbolaget AB"',
  '#RAR 0 20260101 20261231', '#RAR -1 20250101 20251231', ...CHART,
  '#IB 0 1930 1000.00', '#IB 0 2099 -1000.00',
  '#VER A 1 20260110 "Tidrapport vecka 2"', '{', '#TRANS 9000 {} 4000.00', '#TRANS 9010 {} -4000.00', '}',
  '#VER A 2 20260131 "Faktura 2"', '{', '#TRANS 1930 {} 2500.00', '#TRANS 3001 {} -2500.00',
  '#TRANS 9000 {} 1200.00', '#TRANS 9010 {} -1200.00', '}',
  '#VER A 3 20260215 "Okänd inbetalning"', '{', '#TRANS 1930 {} 500.00', '#TRANS 9999 {} -500.00', '}',
  '#RES 0 3001 -2500.00', '#RES 0 9000 5200.00', '#RES 0 9010 -5200.00',
].join('\n')

let client: PoolClient

beforeAll(async () => {
  client = await getPool().connect()
  await client.query('BEGIN')
})
afterAll(async () => {
  if (client) { await client.query('ROLLBACK'); client.release() }
})

describe('#3312: a provider year with class 9 amounts', () => {
  it('completes through the real job with class 9 amounts on 2999 and every verifikat balanced', async () => {
    const [company, actor, period, worker] = Array.from({ length: 4 }, () => randomUUID())
    await client.query(`INSERT INTO auth.users(id,email,instance_id) VALUES($1,$2,'00000000-0000-0000-0000-000000000000')`, [actor, `sie9-${actor}@test.invalid`])
    await client.query(`INSERT INTO companies(id,name,entity_type,created_by) VALUES($1,'Konsultbolaget AB','aktiebolag',$2)`, [company, actor])
    await client.query(`INSERT INTO company_members(company_id,user_id,role) VALUES($1,$2,'owner')`, [company, actor])
    await client.query(`INSERT INTO fiscal_periods(id,company_id,user_id,name,period_start,period_end) VALUES($1,$2,$3,'2026','2026-01-01','2026-12-31')`, [period, company, actor])
    // What the FY2025 provider import left: its chart, class 9 definitions
    // included (#2605), and every mapping it ran with, 9xxx onto itself.
    const earlier: Array<[string, string, string, number, string]> = [
      ['1930', 'Företagskonto', 'asset', 1, 'debit'], ['2099', 'Årets resultat', 'equity', 2, 'credit'],
      ['3001', 'Försäljning tjänster', 'revenue', 3, 'credit'], ['9000', 'Debiterbar tid', 'expense', 9, 'debit'],
      ['9010', 'Motkonto tid', 'expense', 9, 'debit'], ['9999', 'OBS-konto', 'expense', 9, 'debit'],
    ]
    for (const [number, name, type, cls, normal] of earlier) {
      await client.query(`INSERT INTO chart_of_accounts(company_id,user_id,account_number,account_name,account_type,account_class,normal_balance)
        VALUES($1,$2,$3,$4,$5,$6,$7)`, [company, actor, number, name, type, cls, normal])
      await client.query(`INSERT INTO sie_account_mappings(company_id,user_id,source_account,source_name,target_account,confidence,match_type)
        VALUES($1,$2,$3,$4,$3,1,'exact')`, [company, actor, number, name])
    }

    // GET /sie-data: the merged dataset, the company chart first, then BAS.
    // PostgREST answers numeric as a JSON number; node-postgres as a string.
    const stored = (await client.query(`SELECT * FROM sie_account_mappings WHERE company_id=$1`, [company])).rows
      .map((row) => ({ ...row, confidence: Number(row.confidence) })) as SIEAccountMappingRecord[]
    const chart = (await client.query(`SELECT account_number, account_name FROM chart_of_accounts WHERE company_id=$1 ORDER BY account_number`, [company])).rows
    const own = new Set(chart.map((row) => row.account_number))
    const targets = [...chart, ...BAS_REFERENCE.filter((a) => !own.has(a.account_number))]
    const merged = mergeParsedSIEFiles([parseSIEFile(FY2025), parseSIEFile(FY2026)])
    const decided = suggestSIEMappings(merged, targets, stored, merged.accounts.filter((a) => !isSystemAccount(a.number))).mappings
    // The onboarding step: nothing left to create, nothing unresolved.
    const resolved = resolveOnboardingMappings(decided, merged.accounts)
    expect(resolved.unresolved).toEqual([])
    expect(resolved.create).toEqual([])

    // Admission as the job receives it (the archive upload is the only part replaced).
    const hash = createHash('sha256').update(FY2026).digest('hex')
    const input = { version: SIE_JOB_VERSION, sourceHash: hash, mappings: resolved.mappings,
      options: { filename: 'migration-sie-2026-01-01.se', createFiscalPeriod: true, importOpeningBalances: true,
        importTransactions: true, updateAccountNames: true, markImportedNoDocRequired: false, onExistingPeriod: 'block' },
      fiscalYear: { start: '2026-01-01', end: '2026-12-31' } }
    await client.query(`SELECT set_config('request.jwt.claims','{"role":"service_role"}',true)`)
    await client.query(`SELECT set_config('request.jwt.claim.role','service_role',true)`)
    await client.query('SET LOCAL ROLE service_role')
    const started = await client.query(`SELECT (start_sie_import_job($1,$2,$3,'migration-sie-2026-01-01.se',$4,$5)).id`,
      [company, actor, period, hash, JSON.stringify({ input, file_storage_path: 'fy2026.se' })])
    const job = started.rows[0].id as string
    const claimed = await client.query(`SELECT j.* FROM claim_sie_import_job($1,$2) j`, [worker, job])
    const attempt = claimed.rows[0].job_attempt
    await client.query('RESET ROLE')
    await client.query('UPDATE sie_imports SET manifest=$1,file_hash=$2,file_storage_path=$3 WHERE id=$4',
      [JSON.stringify({ input, prior_activity: false }), hash, `${company}/sie-jobs/${hash}.se`, job])
    await client.query('SET LOCAL ROLE service_role')
    const state = (await client.query('SELECT * FROM sie_imports WHERE id=$1', [job])).rows[0] as SIEJob
    const supabase = stagingSIEClient(client, FY2026)
    expect(await prepareSIEJob(supabase, state, Date.now() + 30_000)).toBe(true)
    await client.query('SELECT yield_sie_import_job($1,$2,$3,$4)', [company, job, worker, attempt])
    await runSIEWorker({ supabase, importId: job, budgetMs: 60_000 })
    await client.query('RESET ROLE')

    const finished = (await client.query('SELECT * FROM sie_imports WHERE id=$1', [job])).rows[0]
    expect(finished.error_message).toBeNull()
    expect(finished.job_state).toBe('completed')
    // The IB entry and the three source verifikat; nothing skipped.
    expect(finished.job_result.journalEntriesCreated).toBe(4)
    expect(finished.job_result.details.skippedVouchers.total).toBe(0)

    const perEntry = (await client.query(`SELECT e.id, sum(l.debit_amount) d, sum(l.credit_amount) c
      FROM journal_entries e JOIN journal_entry_lines l ON l.journal_entry_id = e.id WHERE e.company_id=$1 GROUP BY e.id`, [company])).rows
    expect(perEntry).toHaveLength(4)
    for (const row of perEntry) {
      expect(Number(row.d)).toBe(Number(row.c))
      expect(Number(row.d)).toBeGreaterThan(0)
    }
    const net = Object.fromEntries((await client.query(`SELECT l.account_number, sum(l.debit_amount - l.credit_amount)::float8 n
      FROM journal_entries e JOIN journal_entry_lines l ON l.journal_entry_id = e.id WHERE e.company_id=$1
      GROUP BY l.account_number`, [company])).rows.map((row) => [row.account_number, row.n]))
    // Nothing on class 9; the OBS amount keeps its counterpart on 2999, and
    // the internal hour pairs net to zero there.
    expect(net).toEqual({ '1930': 4000, '2099': -1000, '3001': -2500, '2999': -500 })

    // The next fetch starts from 2999, not from the refused 9xxx self-maps.
    const after = (await client.query(`SELECT source_account, target_account, match_type FROM sie_account_mappings
      WHERE company_id=$1 AND source_account LIKE '9%' ORDER BY source_account`, [company])).rows
    expect(after).toEqual(['9000', '9010', '9999'].map((source_account) => ({ source_account, target_account: '2999', match_type: 'class' })))
  }, 60_000)
})
