import { createHash } from 'node:crypto'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  balanceFileYearTrialBalance,
  holdsOnlyOpeningBalances,
  loadBalanceFileYears,
} from '../balance-file-year'
import { mapTrialBalancesToK2 } from '@/lib/bokslut/ixbrl/k2-mapper'
import { CURRENT } from '@/lib/bokslut/ixbrl/__tests__/fixtures'
import { parseSIEFile } from '@/lib/import/sie-parser'
import type { TrialBalanceRow } from '@/types'

const HEAD = ['#FLAGGA 0', '#PROGRAM "Fortnox" 3.0', '#SIETYP 4', '#FNAMN "Testbolaget AB"', '#RAR 0 20240101 20241231']
const IB = ['#IB 0 1910 85000.00', '#IB 0 2081 -25000.00', '#IB 0 2091 -60000.00']
const UB = ['#UB 0 1910 185000.00', '#UB 0 2081 -25000.00', '#UB 0 2091 -60000.00', '#UB 0 2440 -60000.00']
const RES = ['#RES 0 3010 -100000.00', '#RES 0 5010 60000.00']
const file = (...lines: string[][]) => [...HEAD, '#KONTO 1910 "Bank"', '#KONTO 3010 "Försäljning"', ...lines.flat()].join('\n')
const ACCOUNT_MAP = new Map([
  ['1910', '1930'], ['2081', '2081'], ['2091', '2091'], ['2099', '2099'], ['2440', '2440'],
  ['3010', '3010'], ['5010', '5010'], ['8999', '8999'],
])
const YEAR = { period_start: '2024-01-01', period_end: '2024-12-31' }

function ibRow(account_number: string, account_name: string, debit: number, credit: number): TrialBalanceRow {
  return {
    account_number, account_name, account_class: Number(account_number[0]),
    opening_debit: debit, opening_credit: credit, period_debit: 0, period_credit: 0,
    closing_debit: debit, closing_credit: credit,
  }
}
const BOOKS = [ibRow('1930', 'Företagskonto', 85_000, 0), ibRow('2081', 'Aktiekapital', 0, 25_000), ibRow('2091', 'Balanserad vinst', 0, 60_000)]
const net = (row: TrialBalanceRow | undefined) => (row ? row.closing_debit - row.closing_credit : undefined)
const pairOf = (result: ReturnType<typeof balanceFileYearTrialBalance>) => {
  if (!('pair' in result)) throw new Error(`refused: ${result.refusal}`)
  return result.pair
}
const refusalOf = (result: ReturnType<typeof balanceFileYearTrialBalance>) => ('refusal' in result ? result.refusal : null)

describe('holdsOnlyOpeningBalances', () => {
  it('is true for a year without activity, false for one with', () => {
    expect(holdsOnlyOpeningBalances(BOOKS)).toBe(true)
    expect(holdsOnlyOpeningBalances([])).toBe(true)
    expect(holdsOnlyOpeningBalances([...BOOKS, { ...ibRow('1930', 'Bank', 0, 0), period_debit: 100 }])).toBe(false)
  })
})

describe('balanceFileYearTrialBalance', () => {
  it("opens each account on the books and moves it as the file's #UB less #IB, or #RES, says", () => {
    const pair = pairOf(balanceFileYearTrialBalance(parseSIEFile(file(IB, UB, RES)), ACCOUNT_MAP, BOOKS, YEAR))
    const row = (account: string) => pair.full.find((r) => r.account_number === account)
    // 1910 in the file is 1930 in these books, as the import mapped it.
    expect(row('1930')).toMatchObject({
      account_name: 'Företagskonto', opening_debit: 85_000, period_debit: 100_000, closing_debit: 185_000, closing_credit: 0,
    })
    expect(row('2091')).toMatchObject({ opening_credit: 60_000, period_credit: 0, closing_credit: 60_000 })
    expect(row('2440')).toMatchObject({ account_class: 2, opening_credit: 0, period_credit: 60_000 })
    expect(row('3010')).toMatchObject({ account_name: 'Försäljning', account_class: 3, closing_credit: 100_000 })
    expect(net(row('5010'))).toBe(60_000)
    expect(row('1910')).toBeUndefined()
    // No closing entry in these books: both variants are the same.
    expect(pair.preClosing).toBe(pair.full)
  })

  it("keeps what the import added to an unbalanced file's ingående balans where it was booked", () => {
    // The file opens 60 000 kr off (no 2091); the import booked the difference on 2099.
    const ib = ['#IB 0 1910 85000.00', '#IB 0 2081 -25000.00']
    const ub = ['#UB 0 1910 185000.00', '#UB 0 2081 -25000.00', '#UB 0 2440 -60000.00']
    const books = [ibRow('1930', 'Bank', 85_000, 0), ibRow('2081', 'Aktiekapital', 0, 25_000), ibRow('2099', 'Årets resultat', 0, 60_000)]
    const pair = pairOf(balanceFileYearTrialBalance(parseSIEFile(file(ib, ub, RES)), ACCOUNT_MAP, books, YEAR, '2099'))
    expect(net(pair.full.find((r) => r.account_number === '2099'))).toBe(-60_000)
    const mapping = mapTrialBalancesToK2(CURRENT, pair)
    expect(mapping.totals.tillgangar.previous).toBe(185_000)
    expect(mapping.totals.egetKapitalSkulder.previous).toBe(185_000)
  })

  it.each([
    ['a file with verifikat', file(IB, UB, RES, ['#VER A 1 20240115 "Hyra"', '{', '#TRANS 5010 {} 1000.00', '#TRANS 1910 {} -1000.00', '}']), 'verifikationer'],
    ['a file without #UB', file(IB, RES), '#UB'],
    ['a file without #RES whose balances moved', file(IB, UB), 'jämnt'],
    ['a file of another year', file(IB, UB, RES).replace('#RAR 0 20240101 20241231', '#RAR 0 20240101 20240630'), '2024-06-30'],
    ['a file that moves an account the import did not map', file(IB, UB, RES, ['#RES 0 6110 1000.00', '#UB 0 1910 184000.00']), 'konto 6110'],
    ['a file that holds unchanged balances on accounts the import did not map', file(IB, UB, RES, ['#IB 0 1510 500.00', '#UB 0 1510 500.00', '#IB 0 2890 -500.00', '#UB 0 2890 -500.00']), 'konto 1510'],
    ['a file whose close does not balance against its opening', file(IB, UB, ['#RES 0 3010 -90000.00', '#RES 0 5010 60000.00']), 'jämnt'],
  ])('refuses %s, saying why', (_label, content, words) => {
    expect(refusalOf(balanceFileYearTrialBalance(parseSIEFile(content), ACCOUNT_MAP, BOOKS, YEAR))).toContain(words)
  })

  it('refuses a year whose books open on other balances than the file', () => {
    // Continued from the books (the file's #IB never booked), with another opening.
    const carried = [ibRow('1930', 'Bank', 80_000, 0), ibRow('2081', 'Aktiekapital', 0, 25_000), ibRow('2091', 'Balanserad vinst', 0, 55_000)]
    expect(refusalOf(balanceFileYearTrialBalance(parseSIEFile(file(IB, UB, RES)), ACCOUNT_MAP, carried, YEAR))).toContain('konto 1930')
    // The import's own difference is allowed only on the account it booked it on.
    const books = [...BOOKS, ibRow('2099', 'Årets resultat', 0, 1)]
    expect(refusalOf(balanceFileYearTrialBalance(parseSIEFile(file(IB, UB, RES)), ACCOUNT_MAP, books, YEAR))).toContain('konto 2099')
  })

  it('reads a dormant year without #RES, and a close within the öre', () => {
    const dormant = file(IB, ['#UB 0 1910 85000.00', '#UB 0 2081 -25000.00', '#UB 0 2091 -60000.00'])
    const pair = pairOf(balanceFileYearTrialBalance(parseSIEFile(dormant), ACCOUNT_MAP, BOOKS, YEAR))
    expect(net(pair.full.find((r) => r.account_number === '1930'))).toBe(85_000)
    const ore = file(IB, ['#UB 0 1910 185000.01', ...UB.slice(1)], RES)
    expect('pair' in balanceFileYearTrialBalance(parseSIEFile(ore), ACCOUNT_MAP, BOOKS, YEAR)).toBe(true)
  })

  it('refuses a year whose books never got the ingående balans, and reads one that opens at zero', () => {
    expect(refusalOf(balanceFileYearTrialBalance(parseSIEFile(file(IB, UB, RES)), ACCOUNT_MAP, [], YEAR))).toContain('ingående')
    // A first year: nothing to open on, the file starts from zero too.
    const ub = ['#UB 0 1910 100000.00', '#UB 0 2081 -25000.00', '#UB 0 2440 -35000.00']
    const pair = pairOf(balanceFileYearTrialBalance(parseSIEFile(file(ub, RES)), ACCOUNT_MAP, [], YEAR))
    expect(net(pair.full.find((r) => r.account_number === '1930'))).toBe(100_000)
  })

  it.each([
    ['left open in the source system', [], []],
    ['closed in the source system (8999 against 2099)', ['#UB 0 2099 -40000.00'], ['#RES 0 8999 40000.00']],
  ])('gives the K2 mapping a balanced comparison year when %s', (_label, ub2099, res8999) => {
    const pair = pairOf(balanceFileYearTrialBalance(parseSIEFile(file(IB, UB, ub2099, RES, res8999)), ACCOUNT_MAP, BOOKS, YEAR))
    const mapping = mapTrialBalancesToK2(CURRENT, pair)
    expect(mapping.totals.aretsResultat.previous).toBe(40_000)
    expect(mapping.rr['Nettoomsattning'].previous).toBe(100_000)
    expect(mapping.totals.tillgangar.previous).toBe(185_000)
    expect(mapping.totals.egetKapitalSkulder.previous).toBe(185_000)
    expect(mapping.br['AretsResultatEgetKapital'].previous).toBe(40_000)
    expect(mapping.br['BalanseratResultat'].previous).toBe(60_000)
  })
})

describe('loadBalanceFileYears', () => {
  const CONTENT = file(IB, UB, RES)
  const HASH = createHash('sha256').update(CONTENT).digest('hex')
  const PATH = `co1/sie-jobs/${HASH}.se`
  const IMPORT = {
    // transactions_count counts the import's own ingående balans verifikat.
    id: 'imp0', company_id: 'co1', fiscal_period_id: 'fp0', filename: 'saldo-2024.se', job_state: 'completed',
    transactions_count: 1, file_storage_path: PATH, file_hash: HASH,
    manifest: {
      input: {
        sourceHash: HASH,
        mappings: [...ACCOUNT_MAP].map(([sourceAccount, targetAccount]) => ({
          sourceAccount, sourceName: sourceAccount, targetAccount, targetName: targetAccount,
          confidence: 1, matchType: 'exact', isOverride: false,
        })),
      },
    },
  }
  const download = vi.fn()
  const calls: Array<[string, unknown]> = []
  function supabase(rows: unknown[]) {
    const query = {
      select: () => query,
      eq: (column: string, value: unknown) => (calls.push([column, value]), query),
      or: (filter: string) => (calls.push(['or', filter]), query),
      in: () => Promise.resolve({ data: rows, error: null }),
    }
    return { from: vi.fn(() => query), storage: { from: () => ({ download }) } }
  }
  const YEARS = [{ periodId: 'fp0', ...YEAR, booksRows: BOOKS }]

  beforeEach(() => {
    download.mockReset()
    download.mockResolvedValue({ data: new Blob([CONTENT]), error: null })
    calls.length = 0
  })

  it("reads the year's archived file, for imports in place in the company only", async () => {
    // @ts-expect-error: partial client
    const reading = (await loadBalanceFileYears(supabase([IMPORT]), 'co1', YEARS)).get('fp0')
    expect(reading).toMatchObject({ kind: 'read', filename: 'saldo-2024.se' })
    if (reading?.kind !== 'read') throw new Error('not read')
    expect(net(reading.pair.full.find((r) => r.account_number === '1930'))).toBe(185_000)
    expect(download).toHaveBeenCalledWith(PATH)
    expect(calls).toContainEqual(['company_id', 'co1'])
    expect(calls).toContainEqual(['status', 'completed'])
  })

  it('leaves out a year without an import in place', async () => {
    // @ts-expect-error: partial client
    expect((await loadBalanceFileYears(supabase([]), 'co1', YEARS)).size).toBe(0)
  })

  it.each([
    ['two imports are in place for the year', [IMPORT, { ...IMPORT, id: 'imp1' }], 'flera'],
    ['the import is from before archived files', [{ ...IMPORT, job_state: null, file_storage_path: null }], 'sparad'],
    ['the manifest is for another file', [{ ...IMPORT, manifest: { input: { ...IMPORT.manifest.input, sourceHash: 'x' } } }], 'sparad'],
  ])('says why it reads nothing when %s', async (_label, rows, words) => {
    // @ts-expect-error: partial client
    const reading = (await loadBalanceFileYears(supabase(rows), 'co1', YEARS)).get('fp0')
    expect(reading?.kind).toBe('not_used')
    expect(reading?.kind === 'not_used' && reading.reason).toContain(words)
    expect(download).not.toHaveBeenCalled()
  })

  it("passes on the file's own refusal", async () => {
    // @ts-expect-error: partial client
    const reading = (await loadBalanceFileYears(supabase([IMPORT]), 'co1', [{ ...YEARS[0], period_end: '2025-03-31' }])).get('fp0')
    expect(reading).toMatchObject({ kind: 'not_used', filename: 'saldo-2024.se' })
  })

  it("gives a file without #RAR the year the import gave it", async () => {
    const content = file(IB, UB, RES).replace('#RAR 0 20240101 20241231\n', '')
    const hash = createHash('sha256').update(content).digest('hex')
    download.mockResolvedValue({ data: new Blob([content]), error: null })
    const row = { ...IMPORT, file_hash: hash, file_storage_path: `co1/sie-jobs/${hash}.se`,
      manifest: { input: { ...IMPORT.manifest.input, sourceHash: hash, fiscalYear: { start: '2024-01-01', end: '2024-12-31' } } } }
    // @ts-expect-error: partial client
    expect((await loadBalanceFileYears(supabase([row]), 'co1', YEARS)).get('fp0')?.kind).toBe('read')
  })

  it("allows the import's own difference on the account the manifest names", async () => {
    // The file opens 60 000 kr off (no 2091); the import booked the difference on 2099.
    const content = file(['#IB 0 1910 85000.00', '#IB 0 2081 -25000.00'],
      ['#UB 0 1910 185000.00', '#UB 0 2081 -25000.00', '#UB 0 2440 -60000.00'], RES)
    const hash = createHash('sha256').update(content).digest('hex')
    download.mockResolvedValue({ data: new Blob([content]), error: null })
    const books = [ibRow('1930', 'Bank', 85_000, 0), ibRow('2081', 'Aktiekapital', 0, 25_000), ibRow('2099', 'Årets resultat', 0, 60_000)]
    const row = { ...IMPORT, file_hash: hash, file_storage_path: `co1/sie-jobs/${hash}.se`,
      manifest: { input: { ...IMPORT.manifest.input, sourceHash: hash }, openingBalanceDifferenceAccount: '2099' } }
    const years = [{ ...YEARS[0], booksRows: books }]
    // @ts-expect-error: partial client
    expect((await loadBalanceFileYears(supabase([row]), 'co1', years)).get('fp0')?.kind).toBe('read')
    // Without the manifest naming it, the same difference is refused.
    const unnamed = { ...row, manifest: { input: row.manifest.input } }
    // @ts-expect-error: partial client
    expect((await loadBalanceFileYears(supabase([unnamed]), 'co1', years)).get('fp0')?.kind).toBe('not_used')
  })

  it('is a failed read when the archived file has changed or is gone', async () => {
    download.mockResolvedValueOnce({ data: new Blob([CONTENT + '\n#UB 0 1910 1.00']), error: null })
    // @ts-expect-error: partial client
    expect((await loadBalanceFileYears(supabase([IMPORT]), 'co1', YEARS)).get('fp0')).toEqual({ kind: 'failed', filename: 'saldo-2024.se' })
    download.mockResolvedValueOnce({ data: null, error: { message: 'not found' } })
    // @ts-expect-error: partial client
    expect((await loadBalanceFileYears(supabase([IMPORT]), 'co1', YEARS)).get('fp0')?.kind).toBe('failed')
  })

  it('asks for nothing without a year to read', async () => {
    const client = supabase([IMPORT])
    // @ts-expect-error: partial client
    expect((await loadBalanceFileYears(client, 'co1', [])).size).toBe(0)
    expect(client.from).not.toHaveBeenCalled()
  })
})
