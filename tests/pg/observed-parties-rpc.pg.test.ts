import { beforeAll, describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { getClient, getPool, withUserContext } from './setup'
import { insertFiscalPeriod, insertPostedJournalEntry, insertTransaction, seedCompany } from './fixtures'
import { ledgerKey } from '@/lib/parties/ledger-key'
import { LEDGER_KEY_CASES } from '@/lib/parties/__tests__/ledger-key.test'

/**
 * Parties, phase 1b (migration 20260902170000): ledger_key() and the
 * observed-parties RPC keyed on voucher descriptions.
 *
 * The TS/SQL parity block runs the shared fixture list through both
 * implementations; a change to either side without the other fails here.
 */
describe('ledger_key parity (pg)', () => {
  it('mirrors lib/parties/ledger-key.ts on the shared fixtures', async () => {
    for (const [raw, expected] of LEDGER_KEY_CASES) {
      const { rows } = await getPool().query<{ k: string }>(`SELECT public.ledger_key($1) AS k`, [raw])
      expect(rows[0]!.k, raw).toBe(ledgerKey(raw))
      expect(rows[0]!.k, raw).toBe(expected)
    }
  })

  it('treats NULL as an empty key', async () => {
    const { rows } = await getPool().query<{ k: string }>(`SELECT public.ledger_key(NULL) AS k`)
    expect(rows[0]!.k).toBe('')
  })
})

interface Observed {
  key: string
  name: string
  occurrences: number
  variant_count: number
  expense_sek: number
  revenue_sek: number
  cadence_days: number | null
  dominant_account_number: string | null
  dominant_account_share: number | null
}

// The shipped query is an independent oracle, including JSON ordering and
// rounding. Keep the historical migration untouched when optimizing the RPC.
const originalQuery = readFileSync(
  new URL('../../supabase/migrations/20260902170000_ledger_key_and_observed_parties.sql', import.meta.url), 'utf8',
).split('AS $$')[2]!.split('$$;')[0]!
  .replaceAll('p_company_id', '$1::uuid')
  .replaceAll('p_from_date', '$2::date')
  .replaceAll('p_limit', '$3::integer')

async function observed(companyId: string, userId: string, fromDate: string | null = null): Promise<Observed[]> {
  return withUserContext(userId, async (client) => {
    const { rows } = await client.query<{ r: Observed[] }>(
      `SELECT public.get_observed_parties($1, $2, 200) AS r`,
      [companyId, fromDate],
    )
    return rows[0]!.r
  })
}

const expense = (account: string, amount: number) => [
  { accountNumber: account, debitAmount: amount, creditAmount: 0 },
  { accountNumber: '2440', debitAmount: 0, creditAmount: amount },
]

describe('get_observed_parties (pg)', () => {
  it('preserves complete results across variants, same-day recurrence, account ties, rounding and limits', async () => {
    const c = await seedCompany()
    const base = { userId: c.userId, companyId: c.companyId, fiscalPeriodId: c.fiscalPeriodId, sourceType: 'import' }
    for (let i = 0; i < 12; i++) {
      await insertPostedJournalEntry({
        ...base,
        entryDate: `2026-01-${String(1 + Math.floor(i / 2) * 2).padStart(2, '0')}`,
        description: `Levfakt Synthetic Services AB (${10000 + i})`,
        lines: [
          { accountNumber: '4000', debitAmount: 0.49, creditAmount: 0 },
          { accountNumber: '4010', debitAmount: 0.49, creditAmount: 0 },
          { accountNumber: '8310', debitAmount: 0, creditAmount: 0.01 },
          { accountNumber: '2440', debitAmount: 0, creditAmount: 0.97 },
        ],
      })
    }
    for (const description of ['Levfakt Alpha AB', 'Levfakt Alpha AB', 'Levfakt Beta AB', 'Levfakt Beta AB']) {
      await insertPostedJournalEntry({ ...base, entryDate: '2026-02-01', description, lines: expense('6542', 12.25) })
    }
    await insertPostedJournalEntry({ ...base, description: '   ', lines: expense('4000', 500) })
    await insertPostedJournalEntry({ ...base, description: '1234567890', lines: expense('4000', 500) })
    await insertPostedJournalEntry({ ...base, sourceType: 'vat_settlement', description: 'Excluded VAT', lines: expense('4000', 500) })
    await insertPostedJournalEntry({ ...base, description: 'Excluded balance', lines: expense('1930', 500) })
    await insertPostedJournalEntry({ ...base, description: 'Result boundaries', lines: [
      { accountNumber: '3000', debitAmount: 0, creditAmount: 1 },
      { accountNumber: '3999', debitAmount: 0, creditAmount: 1 },
      { accountNumber: '4000', debitAmount: 2, creditAmount: 0 },
      { accountNumber: '7999', debitAmount: 2, creditAmount: 0 },
      { accountNumber: '8000', debitAmount: 0, creditAmount: 1 },
      { accountNumber: '8999', debitAmount: 0, creditAmount: 1 },
    ] })

    await withUserContext(c.userId, async (client) => {
      for (const fromDate of [null, '2026-01-05', '2027-01-01']) {
        for (const limit of [null, 1, 2, 200, 1000, 5000]) {
          const args = [c.companyId, fromDate, limit]
          const before = await client.query(originalQuery, args)
          const after = await client.query('SELECT public.get_observed_parties($1, $2, $3) AS result', args)
          expect(after.rows[0].result, `${fromDate}/${limit}`).toEqual(Object.values(before.rows[0])[0])
        }
        // 0 and below rank nothing since 20261123005000 (they were read as 1): with no key named, nothing.
        for (const limit of [-1, 0]) {
          const after = await client.query('SELECT public.get_observed_parties($1, $2, $3) AS result', [c.companyId, fromDate, limit])
          expect(after.rows[0].result, `${fromDate}/${limit}`).toEqual([])
        }
      }
      const { rows } = await client.query('SELECT public.get_observed_parties($1, NULL, 200) AS result', [c.companyId])
      const synthetic = rows[0].result.find((row: { key: string }) => row.key === 'synthetic services')
      expect(synthetic).toMatchObject({
        occurrences: 12, variant_count: 12, cadence_days: 2,
        expense_sek: 12, dominant_account_number: '4000',
        dominant_account_count: 12, dominant_account_total: 36, dominant_account_share: 0.34,
      })
      expect(synthetic.variants).toHaveLength(8)
      expect(rows[0].result.find((row: { key: string }) => row.key === 'result boundaries')).toMatchObject({
        expense_sek: 4, revenue_sek: 2, dominant_account_number: '3000',
        dominant_account_count: 1, dominant_account_total: 6, dominant_account_share: 0.25,
      })
    })
  }, 60_000)

  it('reads each voucher lines with a per-voucher LATERAL aggregate, never a join the planner can hash (20261119223000)', async () => {
    // The join + GROUP BY let the planner scan every tenant's 3000-8999 lines
    // once a company had about ten thousand vouchers in the window (4 s warm,
    // 40 s cold in production). An aggregate subquery cannot be flattened,
    // so the probe by journal_entry_id per voucher is the only plan.
    const { rows } = await getPool().query<{ src: string }>(`
      SELECT p.prosrc AS src FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname = 'get_observed_parties'
    `)
    const money = rows[0]!.src.split('money AS MATERIALIZED')[1]!.split('descriptions AS MATERIALIZED')[0]!
    expect(money).toMatch(/CROSS JOIN LATERAL\s*\(/)
    expect(money).toMatch(/WHERE l\.journal_entry_id = e\.id/)
    expect(money).not.toMatch(/GROUP BY/)
  })

  it('retains invoker security and the authenticated/service grants without anonymous access', async () => {
    // One function, no overload: PostgREST cannot choose between a 3- and a
    // 4-argument version for a call naming three arguments (20261015160000).
    const { rows } = await getPool().query(`
      SELECT pg_get_function_identity_arguments(p.oid) AS args, p.prosecdef,
        has_function_privilege('authenticated', p.oid, 'EXECUTE') AS authenticated,
        has_function_privilege('service_role', p.oid, 'EXECUTE') AS service_role,
        has_function_privilege('anon', p.oid, 'EXECUTE') AS anon
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname = 'get_observed_parties'
    `)
    expect(rows).toEqual([{
      args: 'p_company_id uuid, p_from_date date, p_limit integer, p_keys text[]',
      prosecdef: false, authenticated: true, service_role: true, anon: false,
    }])
  })

  it('returns every key named in p_keys whatever its rank, with the stats the ranking gives it (accounted#16)', async () => {
    const c = await seedCompany()
    const base = { userId: c.userId, companyId: c.companyId, fiscalPeriodId: c.fiscalPeriodId, sourceType: 'import' }
    const previousYear = await insertFiscalPeriod({ userId: c.userId, companyId: c.companyId, name: '2025', periodStart: '2025-01-01', periodEnd: '2025-12-31' })
    await insertPostedJournalEntry({ ...base, entryDate: '2026-01-10', description: 'Levfakt Beijer Byggmaterial AB (2089)', lines: expense('4000', 1000) })
    await insertPostedJournalEntry({ ...base, entryDate: '2026-02-10', description: 'Telia Sverige AB', lines: expense('6212', 500) })
    await insertPostedJournalEntry({ ...base, fiscalPeriodId: previousYear, entryDate: '2025-03-01', description: 'Kundfaktura Acme Konsult AB', lines: [
      { accountNumber: '1510', debitAmount: 125, creditAmount: 0 },
      { accountNumber: '3011', debitAmount: 0, creditAmount: 100 },
      { accountNumber: '2611', debitAmount: 0, creditAmount: 25 },
    ] })
    await insertPostedJournalEntry({ ...base, entryDate: '2026-03-01', description: 'Kundfaktura Acme Konsult AB', lines: [
      { accountNumber: '1510', debitAmount: 125, creditAmount: 0 },
      { accountNumber: '3011', debitAmount: 0, creditAmount: 100 },
      { accountNumber: '2611', debitAmount: 0, creditAmount: 25 },
    ] })
    const beijer = ledgerKey('Levfakt Beijer Byggmaterial AB (2089)')
    const acme = ledgerKey('Kundfaktura Acme Konsult AB')

    await withUserContext(c.userId, async (client) => {
      const call = async (fromDate: string | null, limit: number, keys: string[] | null) =>
        (await client.query<{ r: Observed[] }>('SELECT public.get_observed_parties($1, $2, $3, $4) AS r', [c.companyId, fromDate, limit, keys])).rows[0]!.r
      const complete = await call(null, 200, null)
      expect(complete.map((r) => r.key)).toEqual([beijer, 'telia sverige', acme])

      // Ranked to one key, then the smallest named: both, once each, by money.
      const named = await call(null, 1, [acme, beijer, 'no such key'])
      expect(named.map((r) => r.key)).toEqual([beijer, acme])
      expect(named[1]).toEqual(complete.find((r) => r.key === acme))
      expect(named[1]).toMatchObject({ occurrences: 2, revenue_sek: 200, dominant_account_number: '3011', cadence_days: 365 })

      // NULL and an empty list leave the ranked answer as it was.
      expect(await call(null, 1, null)).toEqual(await call(null, 1, []))
      expect((await call(null, 1, null)).map((r) => r.key)).toEqual([beijer])

      // The window still applies to a named key.
      const windowed = await call('2026-01-01', 1, [acme])
      expect(windowed.find((r) => r.key === acme)).toMatchObject({ occurrences: 1, revenue_sek: 100 })
    })
  })

  it('groups posted vouchers by ledger_key, sums expense SEK, and reports cadence and dominant account', async () => {
    const c = await seedCompany()
    const base = { userId: c.userId, companyId: c.companyId, fiscalPeriodId: c.fiscalPeriodId, sourceType: 'import' }
    await insertPostedJournalEntry({ ...base, entryDate: '2026-01-10', description: 'Levfakt BEIJER BYGGMATERIAL AB (2089)', lines: expense('4000', 1000) })
    await insertPostedJournalEntry({ ...base, entryDate: '2026-02-09', description: 'Levfakt Beijer Byggmaterial AB, 097 (1001)', lines: expense('4000', 2000) })
    await insertPostedJournalEntry({ ...base, entryDate: '2026-03-11', description: 'Levfakt Beijer Byggmaterial AB (2089)', lines: expense('4010', 500) })
    await insertPostedJournalEntry({ ...base, entryDate: '2026-03-15', description: 'Inköp av varor', lines: expense('4010', 300) })

    const rows = await observed(c.companyId, c.userId)
    const beijer = rows.find((r) => r.key === 'beijer byggmaterial')
    expect(beijer).toBeDefined()
    expect(beijer!.occurrences).toBe(3)
    expect(beijer!.variant_count).toBe(3)
    expect(Number(beijer!.expense_sek)).toBe(3500)
    expect(Number(beijer!.revenue_sek)).toBe(0)
    expect(beijer!.cadence_days).toBe(30)
    expect(beijer!.dominant_account_number).toBe('4000')
    // Laplace: (2+1)/(3+2)
    expect(Number(beijer!.dominant_account_share)).toBe(0.6)
    expect(rows.find((r) => r.key === 'inköp av varor')).toBeDefined()
    // Sorted by money, so Beijer comes first.
    expect(rows[0]!.key).toBe('beijer byggmaterial')
  })

  it('counts revenue on 3xxx credits and skips pure balance-sheet vouchers', async () => {
    const c = await seedCompany()
    const base = { userId: c.userId, companyId: c.companyId, fiscalPeriodId: c.fiscalPeriodId, sourceType: 'import' }
    await insertPostedJournalEntry({
      ...base,
      entryDate: '2026-04-01',
      description: 'Kundfaktura Acme Konsult AB',
      lines: [
        { accountNumber: '1510', debitAmount: 12500, creditAmount: 0 },
        { accountNumber: '3011', debitAmount: 0, creditAmount: 10000 },
        { accountNumber: '2611', debitAmount: 0, creditAmount: 2500 },
      ],
    })
    await insertPostedJournalEntry({
      ...base,
      entryDate: '2026-04-02',
      description: 'Överföring till sparkonto',
      lines: [
        { accountNumber: '1940', debitAmount: 5000, creditAmount: 0 },
        { accountNumber: '1930', debitAmount: 0, creditAmount: 5000 },
      ],
    })
    const rows = await observed(c.companyId, c.userId)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.key).toBe('kundfaktura acme konsult')
    expect(Number(rows[0]!.revenue_sek)).toBe(10000)
  })

  it('excludes storno, opening-balance, year-end and VAT-settlement vouchers, and honours the window', async () => {
    const c = await seedCompany()
    const base = { userId: c.userId, companyId: c.companyId, fiscalPeriodId: c.fiscalPeriodId }
    const previousYear = await insertFiscalPeriod({ userId: c.userId, companyId: c.companyId, name: '2025', periodStart: '2025-01-01', periodEnd: '2025-12-31' })
    await insertPostedJournalEntry({ ...base, fiscalPeriodId: previousYear, sourceType: 'import', entryDate: '2025-06-01', description: 'Telia Sverige AB', lines: expense('6212', 100) })
    await insertPostedJournalEntry({ ...base, sourceType: 'import', entryDate: '2026-06-01', description: 'Telia Sverige AB', lines: expense('6212', 100) })
    await insertPostedJournalEntry({ ...base, sourceType: 'storno', entryDate: '2026-06-02', description: 'Telia Sverige AB', lines: expense('6212', 100) })
    await insertPostedJournalEntry({ ...base, sourceType: 'opening_balance', entryDate: '2026-01-01', description: 'Ingående balans', lines: expense('4000', 100) })
    await insertPostedJournalEntry({ ...base, sourceType: 'year_end', entryDate: '2026-12-31', description: 'Årets resultat', lines: expense('8999', 100) })

    const all = await observed(c.companyId, c.userId)
    const telia = all.find((r) => r.key === 'telia sverige')
    expect(telia!.occurrences).toBe(2)
    expect(all.find((r) => r.key === 'ingående balans')).toBeUndefined()
    expect(all.find((r) => r.key === 'årets resultat')).toBeUndefined()

    const windowed = await observed(c.companyId, c.userId, '2026-01-01')
    expect(windowed.find((r) => r.key === 'telia sverige')!.occurrences).toBe(1)
  })

  it('leaves vouchers that carry a bank merchant name to the bank-keyed RPC', async () => {
    const c = await seedCompany()
    const base = { userId: c.userId, companyId: c.companyId, fiscalPeriodId: c.fiscalPeriodId, sourceType: 'import' }
    const withBank = await insertPostedJournalEntry({ ...base, entryDate: '2026-05-01', description: 'Loopia AB', lines: [
      { accountNumber: '6542', debitAmount: 99, creditAmount: 0 },
      { accountNumber: '1930', debitAmount: 0, creditAmount: 99 },
    ] })
    await insertPostedJournalEntry({ ...base, entryDate: '2026-05-02', description: 'Loopia AB', lines: expense('6542', 99) })
    const txId = await insertTransaction({
      userId: c.userId,
      companyId: c.companyId,
      journalEntryId: withBank,
      description: 'LOOPIA AB',
      amount: -99,
      date: '2026-05-01',
    })
    await getPool().query(`UPDATE public.transactions SET merchant_name = 'LOOPIA AB' WHERE id = $1`, [txId])
    const rows = await observed(c.companyId, c.userId)
    const loopia = rows.find((r) => r.key === 'loopia')
    expect(loopia!.occurrences).toBe(1)
  })

  it('does not leak across companies and returns [] for an empty company', async () => {
    const a = await seedCompany()
    const b = await seedCompany()
    await insertPostedJournalEntry({ userId: a.userId, companyId: a.companyId, fiscalPeriodId: a.fiscalPeriodId, sourceType: 'import', description: 'Levfakt Exempelbageriet AB (167)', lines: expense('4000', 100) })
    expect(await observed(b.companyId, b.userId)).toEqual([])
    // A member of company b asking for company a's rows sees nothing: RLS.
    const cross = await withUserContext(b.userId, async (client) => {
      const { rows } = await client.query<{ r: Observed[] }>(`SELECT public.get_observed_parties($1, NULL, 200) AS r`, [a.companyId])
      return rows[0]!.r
    })
    expect(cross).toEqual([])
  })
})

interface PlanNode { 'Node Type': string; 'Relation Name'?: string; 'Index Name'?: string; 'CTE Name'?: string; 'Actual Loops'?: number; Plans?: PlanNode[] }

/** The function's own plan, with row counts: auto_explain reports the nested statement to the client. */
async function functionPlan(companyId: string, limit: number, keys: string[] | null): Promise<PlanNode> {
  const client = await getClient()
  const notices: string[] = []
  const onNotice = (notice: { message?: string }) => {
    if (notice.message) notices.push(notice.message)
  }
  client.on('notice', onNotice)
  try {
    await client.query('BEGIN')
    for (const setting of ['log_min_duration = 0', 'log_nested_statements = on', 'log_analyze = on', 'log_format = json', 'log_level = notice']) {
      await client.query(`SET LOCAL auto_explain.${setting}`)
    }
    await client.query('SELECT public.get_observed_parties($1, NULL, $2, $3)', [companyId, limit, keys])
  } finally {
    await client.query('ROLLBACK').catch(() => {})
    client.off('notice', onNotice)
    client.release()
  }
  const plans = notices.filter((m) => m.includes('"Plan"') && m.includes('journal_entry_lines')).map((m) => (JSON.parse(m.slice(m.indexOf('{'))) as { Plan: PlanNode }).Plan)
  expect(plans).toHaveLength(1)
  return plans[0]!
}

function loops(node: PlanNode, match: (n: PlanNode) => boolean): number[] {
  return [...(match(node) ? [node['Actual Loops'] ?? 0] : []), ...(node.Plans ?? []).flatMap((child) => loops(child, match))]
}

/**
 * 20261123005000: the party dossier asks for its party's keys and no ranked
 * key (p_limit 0), and the function then reads only the vouchers whose
 * description keys to a named key. It used to ask with p_limit 1, which made
 * the function read every voucher of the window (bank match, lines, key) and
 * rank every key, to return one top key the dossier dropped: past the 8 s
 * statement timeout on production for a company with 21 819 vouchers.
 *
 * The dossier's stats must not move: the shipped function (20261119223000) at
 * p_limit 1, filtered to the named keys as lib/parties/register.ts filters it,
 * is compared with the new one at p_limit 0.
 */
describe('get_observed_parties ranking nothing (20261123005000)', () => {
  const shipped = readFileSync(
    new URL('../../supabase/migrations/20261119223000_observed_parties_per_voucher_lines.sql', import.meta.url), 'utf8',
  ).split('AS $$')[1]!.split('$$;')[0]!.trim().replace(/;$/, '')
    .replaceAll('p_company_id', '$1::uuid')
    .replaceAll('p_from_date', '$2::date')
    .replaceAll('p_limit', '$3::integer')
    .replaceAll('p_keys', '$4::text[]')

  const beijer = ledgerKey('Levfakt Beijer Byggmaterial AB (2089)')
  const acme = ledgerKey('Kundfaktura Acme Konsult AB')
  const loopia = ledgerKey('Loopia AB')
  const telia = ledgerKey('Telia Sverige AB')
  let company: { userId: string; companyId: string; fiscalPeriodId: string }
  /** The vouchers whose description keys to Telia and that the function may read: posted, not storno, with money. */
  let teliaVouchers = 0

  beforeAll(async () => {
    company = await seedCompany()
    const c = company
    const base = { userId: c.userId, companyId: c.companyId, fiscalPeriodId: c.fiscalPeriodId, sourceType: 'import' }
    const previousYear = await insertFiscalPeriod({ userId: c.userId, companyId: c.companyId, name: '2025', periodStart: '2025-01-01', periodEnd: '2025-12-31' })
    const revenue = (amount: number) => [
      { accountNumber: '1510', debitAmount: amount * 1.25, creditAmount: 0 },
      { accountNumber: '3011', debitAmount: 0, creditAmount: amount },
      { accountNumber: '2611', debitAmount: 0, creditAmount: amount * 0.25 },
    ]
    // A key with many vouchers and variants, the top of the ranking.
    for (let i = 0; i < 9; i++) {
      await insertPostedJournalEntry({ ...base, entryDate: `2026-0${1 + (i % 6)}-1${i % 3}`, description: `Levfakt Beijer Byggmaterial AB (${2080 + i})`, lines: expense(i % 2 ? '4000' : '4010', 1000 + i) })
    }
    // A customer over two years.
    await insertPostedJournalEntry({ ...base, fiscalPeriodId: previousYear, entryDate: '2025-03-01', description: 'Kundfaktura Acme Konsult AB', lines: revenue(100) })
    await insertPostedJournalEntry({ ...base, entryDate: '2026-03-01', description: 'Kundfaktura Acme Konsult AB', lines: revenue(100) })
    // A small supplier, ranked last: what a dossier usually asks about.
    for (const [date, description] of [['2025-06-01', 'Telia Sverige AB'], ['2026-02-10', 'Telia Sverige AB'], ['2026-04-10', 'TELIA SVERIGE AB']] as const) {
      await insertPostedJournalEntry({ ...base, fiscalPeriodId: date.startsWith('2025') ? previousYear : c.fiscalPeriodId, entryDate: date, description, lines: expense('6212', 50) })
      teliaVouchers++
    }
    // Telia vouchers the function must leave out whatever it is asked: a storno, a balance-only voucher.
    await insertPostedJournalEntry({ ...base, sourceType: 'storno', entryDate: '2026-04-11', description: 'Telia Sverige AB', lines: expense('6212', 50) })
    await insertPostedJournalEntry({ ...base, entryDate: '2026-04-12', description: 'Telia Sverige AB', lines: expense('1930', 50) })
    // A voucher the bank side owns (a merchant name on its transaction), next to one it does not.
    const withBank = await insertPostedJournalEntry({ ...base, entryDate: '2026-05-01', description: 'Loopia AB', lines: [
      { accountNumber: '6542', debitAmount: 99, creditAmount: 0 },
      { accountNumber: '1930', debitAmount: 0, creditAmount: 99 },
    ] })
    await insertPostedJournalEntry({ ...base, entryDate: '2026-05-02', description: 'Loopia AB', lines: expense('6542', 99) })
    const txId = await insertTransaction({ userId: c.userId, companyId: c.companyId, journalEntryId: withBank, description: 'LOOPIA AB', amount: -99, date: '2026-05-01' })
    await getPool().query(`UPDATE public.transactions SET merchant_name = 'LOOPIA AB' WHERE id = $1`, [txId])
    // Others, and descriptions that key to nothing.
    await insertPostedJournalEntry({ ...base, entryDate: '2026-03-15', description: 'Inköp av varor', lines: expense('4010', 300) })
    await insertPostedJournalEntry({ ...base, entryDate: '2026-03-16', description: '1234567890', lines: expense('4000', 10) })
    await insertPostedJournalEntry({ ...base, entryDate: '2026-03-17', description: '   ', lines: expense('4000', 10) })
  })

  const keySets: Array<string[] | null> = [[telia], [beijer], [acme, 'no such key'], [loopia], [telia, beijer, acme, loopia], [''], [], null]

  it("gives the dossier its party's stats as before, in every window", async () => {
    await withUserContext(company.userId, async (client) => {
      for (const fromDate of [null, '2026-01-01', '2026-04-01', '2027-01-01']) {
        for (const keys of keySets) {
          const args = [company.companyId, fromDate]
          const before = (await client.query(`SELECT (${shipped}) AS r`, [...args, 1, keys])).rows[0].r as Array<{ key: string }>
          const after = (await client.query('SELECT public.get_observed_parties($1, $2, $3, $4) AS r', [...args, 0, keys])).rows[0].r as Array<{ key: string }>
          const named = new Set(keys ?? [])
          expect(after, `${fromDate}/${JSON.stringify(keys)}`).toEqual(before.filter((row) => named.has(row.key)))
          // And they are the named keys' rows of today's ranked answer.
          const ranked = (await client.query('SELECT public.get_observed_parties($1, $2, $3, $4) AS r', [...args, 1000, keys])).rows[0].r as Array<{ key: string }>
          expect(after, `${fromDate}/${JSON.stringify(keys)} ranked`).toEqual(ranked.filter((row) => named.has(row.key)))
          // A call that ranks gets what the shipped function gave it, keys named or not.
          for (const limit of [1, 2, 1000]) {
            const shippedRanked = (await client.query(`SELECT (${shipped}) AS r`, [...args, limit, keys])).rows[0].r
            const newRanked = (await client.query('SELECT public.get_observed_parties($1, $2, $3, $4) AS r', [...args, limit, keys])).rows[0].r
            expect(newRanked, `${fromDate}/${JSON.stringify(keys)}/${limit}`).toEqual(shippedRanked)
          }
        }
      }
      // The seed reaches the cases: a named key has rows, the bank-owned voucher stays out.
      const telias = (await client.query('SELECT public.get_observed_parties($1, NULL, 0, $2) AS r', [company.companyId, [telia]])).rows[0].r
      expect(telias).toMatchObject([{ key: telia, occurrences: teliaVouchers, variant_count: 2 }])
      const loopias = (await client.query('SELECT public.get_observed_parties($1, NULL, 0, $2) AS r', [company.companyId, [loopia]])).rows[0].r
      expect(loopias).toMatchObject([{ key: loopia, occurrences: 1 }])
    })
  })

  it("reads only the named key's vouchers when it ranks nothing", async () => {
    const plan = await functionPlan(company.companyId, 0, [telia])
    // The lines and the bank match: once per Telia voucher of the window that passes the cheap filters (the
    // balance-only one included: its money is read to find there is none), never per voucher of the company.
    const lines = loops(plan, (n) => n['Relation Name'] === 'journal_entry_lines')
    const bank = loops(plan, (n) => n['Relation Name'] === 'transactions')
    expect(lines).toEqual([teliaVouchers + 1])
    expect(bank).toEqual([teliaVouchers + 1])
  })

  it('reads every voucher when it ranks, and never works out the named descriptions', async () => {
    const plan = await functionPlan(company.companyId, 1000, [telia])
    const lines = loops(plan, (n) => n['Relation Name'] === 'journal_entry_lines')
    expect(lines[0]).toBeGreaterThan(teliaVouchers + 1)
    // The scan of the named CTE never runs: journal_entries is read by entries alone.
    const entryScans = loops(plan, (n) => n['Relation Name'] === 'journal_entries')
    expect(entryScans.filter((l) => l > 0)).toHaveLength(1)
  })
})

/**
 * 20261125233000: a SQL function's statement is planned without the values of
 * its arguments, and below money every CTE is estimated at one row, so the
 * planner joined CTE to CTE by nested loop. selected_entries compared each
 * voucher of keyed with each ranked key, and recur ran again for each ranked
 * key over all the ranked keys' vouchers: the work grew with vouchers times
 * keys, and the all-years ranking the SIE import's party suggestions ask for
 * passed the 8 s statement timeout. The function now plans with nested loops
 * off. Its answer must not move: the function it replaces (20261123005000) is
 * the oracle.
 */
describe('get_observed_parties reads each CTE once (20261125233000)', () => {
  const shipped = readFileSync(
    new URL('../../supabase/migrations/20261123005000_observed_parties_named_keys_only.sql', import.meta.url), 'utf8',
  ).split('AS $$')[1]!.split('$$;')[0]!.trim().replace(/;$/, '')
    .replaceAll('p_company_id', '$1::uuid')
    .replaceAll('p_from_date', '$2::date')
    .replaceAll('p_limit', '$3::integer')
    .replaceAll('p_keys', '$4::text[]')

  const syllables = ['ka', 'lo', 'mi', 'ne', 'ro', 'su', 'ta', 'vi']
  /** 64 names without digits: ledger_key drops digit runs, so numbered names would share one key. */
  const name = (i: number) => `${syllables[i % 8]!.toUpperCase()[0]}${syllables[i % 8]!.slice(1)}${syllables[Math.floor(i / 8) % 8]}ra`
  const resultAccounts = ['4010', '5410', '6212', '6540', '5611']
  let company: { userId: string; companyId: string; fiscalPeriodId: string }
  /** Every key of the seed, by rank. */
  let ranked: string[] = []

  beforeAll(async () => {
    company = await seedCompany()
    const c = company
    const previousYear = await insertFiscalPeriod({ userId: c.userId, companyId: c.companyId, name: '2025', periodStart: '2025-01-01', periodEnd: '2025-12-31' })
    const post = (entryDate: string, description: string, lines: Array<{ accountNumber: string; debitAmount: number; creditAmount: number }>, sourceType = 'import') =>
      insertPostedJournalEntry({
        userId: c.userId, companyId: c.companyId, sourceType, entryDate, description, lines,
        fiscalPeriodId: entryDate < '2026-01-01' ? previousYear : c.fiscalPeriodId,
      })
    const day = (offset: number) => new Date(Date.UTC(2025, 0, 1) + (offset % 700) * 86_400_000).toISOString().slice(0, 10)
    // Suppliers over two years: two to seven vouchers each, weekly, monthly,
    // quarterly or irregular, every third voucher on two result accounts.
    for (let i = 0; i < 48; i++) {
      const step = [7, 30, 91, 13][i % 4]!
      for (let n = 0; n < 2 + (i % 6); n++) {
        const amount = 100 + 37 * i + 11 * n + 0.25
        const account = resultAccounts[(i + n) % resultAccounts.length]!
        const lines = n % 3 === 2
          ? [
              { accountNumber: account, debitAmount: amount, creditAmount: 0 },
              { accountNumber: '6570', debitAmount: 10, creditAmount: 0 },
              { accountNumber: '2440', debitAmount: 0, creditAmount: amount + 10 },
            ]
          : expense(account, amount)
        await post(day(i * 5 + n * step), `Levfakt ${name(i)} Handel AB (${4000 + n})`, lines)
      }
    }
    // Two suppliers with the same money and count: the name breaks the tie.
    for (const twin of ['Tvilling Beta AB', 'Tvilling Alfa AB']) {
      for (const date of ['2025-03-03', '2026-03-03']) await post(date, twin, expense('6230', 450))
    }
    // Customers, on two revenue accounts.
    for (let i = 0; i < 12; i++) {
      for (let n = 0; n < 1 + (i % 4); n++) {
        const amount = 1000 + 250 * i + 10 * n
        await post(day(40 + 9 * i + 30 * n), `Kundfaktura ${name(48 + i)} Konsult AB`, [
          { accountNumber: '1510', debitAmount: amount * 1.25, creditAmount: 0 },
          { accountNumber: i % 2 ? '3041' : '3011', debitAmount: 0, creditAmount: amount },
          { accountNumber: '2611', debitAmount: 0, creditAmount: amount * 0.25 },
        ])
      }
    }
    // What the function leaves out: a storno, a year-end and a VAT voucher, one
    // on the balance sheet only, descriptions that key to nothing, and a
    // voucher the bank side owns.
    await post('2026-05-05', `Levfakt ${name(0)} Handel AB (4999)`, expense('4010', 99), 'storno')
    await post('2026-12-31', 'Årets resultat', expense('8999', 100), 'year_end')
    await post('2026-06-30', 'Momsredovisning', expense('4000', 100), 'vat_settlement')
    await post('2026-04-02', 'Överföring till sparkonto', expense('1940', 500))
    await post('2026-04-03', '   ', expense('4000', 500))
    await post('2026-04-04', '1234567890', expense('4000', 500))
    const withBank = await post('2026-05-01', 'Loopia AB', [
      { accountNumber: '6542', debitAmount: 99, creditAmount: 0 },
      { accountNumber: '1930', debitAmount: 0, creditAmount: 99 },
    ])
    const txId = await insertTransaction({ userId: c.userId, companyId: c.companyId, journalEntryId: withBank, description: 'LOOPIA AB', amount: -99, date: '2026-05-01' })
    await getPool().query(`UPDATE public.transactions SET merchant_name = 'LOOPIA AB' WHERE id = $1`, [txId])

    const { rows } = await getPool().query<{ r: Array<{ key: string }> }>('SELECT public.get_observed_parties($1, NULL, 1000) AS r', [c.companyId])
    ranked = rows[0]!.r.map((row) => row.key)
  }, 60_000)

  it('answers as the function it replaces did, ranked, named and windowed', async () => {
    // The seed reaches the cases: every supplier and customer and both twins are keys, the twins by name.
    expect(ranked).toHaveLength(48 + 12 + 2)
    expect(ranked.filter((k) => k.startsWith('tvilling'))).toEqual(['tvilling alfa', 'tvilling beta'])
    const low = ranked.slice(-3)
    const keySets: Array<string[] | null> = [null, [], low, [ranked[0]!, 'no such key'], ['']]
    await withUserContext(company.userId, async (client) => {
      for (const fromDate of [null, '2025-07-01', '2026-06-01', '2027-01-01']) {
        for (const limit of [null, 0, 1, 7, 1000]) {
          for (const keys of keySets) {
            const args = [company.companyId, fromDate, limit, keys]
            const before = (await client.query(`SELECT (${shipped}) AS r`, args)).rows[0].r
            const after = (await client.query('SELECT public.get_observed_parties($1, $2, $3, $4) AS r', args)).rows[0].r
            expect(after, `${fromDate}/${limit}/${JSON.stringify(keys)}`).toEqual(before)
          }
        }
      }
    })
  }, 60_000)

  /** Plan nodes that ran more than once over a CTE: a CTE read again for each row of another. */
  function cteRereads(node: PlanNode): string[] {
    const readsCte = (n: PlanNode): boolean => n['Node Type'] === 'CTE Scan' || (n.Plans ?? []).some(readsCte)
    const here = (node['Actual Loops'] ?? 0) > 1 && readsCte(node)
      ? [`${node['Node Type']}${node['CTE Name'] ? ` on ${node['CTE Name']}` : ''} x${node['Actual Loops']}`]
      : []
    return [...here, ...(node.Plans ?? []).flatMap(cteRereads)]
  }

  it('reads each CTE once, ranking every key, a few with keys named, or only named keys', async () => {
    const low = ranked.slice(-3)
    for (const [limit, keys] of [[1000, null], [7, low], [0, low]] as const) {
      const plan = await functionPlan(company.companyId, limit, keys)
      expect(cteRereads(plan), `${limit}/${JSON.stringify(keys)}`).toEqual([])
      // The vouchers are still probed one by one: the lines once per voucher read, as 20261119223000 has it.
      expect(loops(plan, (n) => n['Relation Name'] === 'journal_entry_lines')[0]).toBeGreaterThan(1)
    }
  })
})
