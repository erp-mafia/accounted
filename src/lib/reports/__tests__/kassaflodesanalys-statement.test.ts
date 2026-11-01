import { describe, expect, it, vi } from 'vitest'
import { roundOre } from '@/lib/money'
import { generateKassaflodesanalysWithStatement, type KassaflodesanalysOptions } from '../kassaflodesanalys'
import {
  KASSAFLODESANALYS_LAYOUT,
  type KassaflodesanalysLineKey,
  type KassaflodesanalysYear,
} from '@/lib/reports/kassaflodesanalys-statement'

// The K3 chapter 7 statement over balanced journal fixtures. The real
// report, trial-balance and tax-bridge modules run; the in-memory client
// stands in for the database reads (trial-balance aggregates, opening
// balances, the voucher evidence) and does not verify SQL. Amounts invented.
type Line = { account: string; debit: number; credit: number }
type Entry = Line[] | { lines: Line[]; reverses?: number }

interface PeriodFixture {
  id: string
  start: string
  end: string
  entries: Entry[]
  opening?: Line[]
}

const round = (value: number) => roundOre(value) || 0
const pair = (debit: string, credit: string, amount: number): Line[] => [
  { account: debit, debit: amount, credit: 0 },
  { account: credit, debit: 0, credit: amount },
]
const lines = (...parts: [string, number, number][]): Line[] =>
  parts.map(([account, debit, credit]) => ({ account, debit, credit }))
const linesOf = (entry: Entry) => (Array.isArray(entry) ? entry : entry.lines)

function aggregate(all: Line[]) {
  const sums = new Map<string, { account_number: string; debit: number; credit: number }>()
  for (const line of all) {
    const sum = sums.get(line.account) ?? { account_number: line.account, debit: 0, credit: 0 }
    sum.debit = round(sum.debit + line.debit)
    sum.credit = round(sum.credit + line.credit)
    sums.set(line.account, sum)
  }
  return [...sums.values()]
}

function makeClient(periods: PeriodFixture[]) {
  const entryRows = periods.flatMap((period) => period.entries.map((entry, index) => ({
    id: `${period.id}-entry-${index}`,
    fiscal_period_id: period.id,
    reverses_id: !Array.isArray(entry) && entry.reverses !== undefined ? `${period.id}-entry-${entry.reverses}` : null,
  })))
  const lineRows = periods.flatMap((period) => period.entries.flatMap((entry, index) =>
    linesOf(entry).map((line, i) => ({
      id: `${period.id}-line-${index}-${i}`, journal_entry_id: `${period.id}-entry-${index}`,
      account_number: line.account, debit_amount: line.debit, credit_amount: line.credit,
    }))))
  const periodRow = (period: PeriodFixture) => ({
    id: period.id, period_start: period.start, period_end: period.end,
    opening_balance_entry_id: null, closing_entry_id: null, is_closed: false, closed_externally: false,
  })

  const from = vi.fn((table: string) => {
    const filters = new Map<string, unknown>()
    let bounds = [0, 999]
    const result = () => {
      if (table === 'fiscal_periods') {
        const match = periods.find((period) => (filters.has('id') ? period.id === filters.get('id') : true)
          && (filters.has('period_end') ? period.end === filters.get('period_end') : true))
        return { data: match ? periodRow(match) : null, error: null }
      }
      if (table === 'journal_entries') {
        const rows = entryRows.filter((row) => row.fiscal_period_id === filters.get('fiscal_period_id'))
        return { data: rows.slice(bounds[0], bounds[1] + 1), error: null }
      }
      if (table === 'journal_entry_lines') {
        const ids = filters.get('journal_entry_id') as string[]
        return { data: lineRows.filter((row) => ids.includes(row.journal_entry_id)).slice(bounds[0], bounds[1] + 1), error: null }
      }
      return { data: [], error: null }
    }
    const builder: Record<string, unknown> = {}
    builder.select = () => builder
    builder.eq = (key: string, value: unknown) => { filters.set(key, value); return builder }
    builder.in = (key: string, value: unknown) => { filters.set(key, value); return builder }
    for (const method of ['neq', 'not', 'order', 'limit']) builder[method] = () => builder
    builder.range = (start: number, end: number) => { bounds = [start, end]; return builder }
    builder.single = async () => result()
    builder.maybeSingle = async () => result()
    builder.then = (resolve: (value: ReturnType<typeof result>) => void) => resolve(result())
    return builder
  })
  const rpc = vi.fn(async (name: string, args: Record<string, unknown>) => {
    if (name === 'compute_prior_opening_balances') {
      const period = periods.find((p) => p.start === args.p_period_start)
      return { data: aggregate(period?.opening ?? []), error: null }
    }
    if (name === 'get_trial_balance_aggregates') {
      const period = periods.find((p) => p.id === args.p_fiscal_period_id)
      return { data: aggregate((period?.entries ?? []).flatMap(linesOf)).map((row) => ({ bucket: 'period', ...row })), error: null }
    }
    if (name === 'result_closing_entry_ids') return { data: [], error: null }
    throw new Error(`Unexpected RPC: ${name}`)
  })
  return { from, rpc } as unknown as Parameters<typeof generateKassaflodesanalysWithStatement>[0]
}

const CURRENT = { id: 'period-2026', start: '2026-01-01', end: '2026-12-31' }
const PREVIOUS = { id: 'period-2025', start: '2025-01-01', end: '2025-12-31' }

async function statement(
  entries: Entry[],
  opening: Line[] = [],
  options: KassaflodesanalysOptions & { period?: { id: string; start: string; end: string }; previous?: PeriodFixture } = {},
) {
  const period = options.period ?? CURRENT
  for (const entry of [...entries.map(linesOf), opening]) {
    expect(round(entry.reduce((sum, line) => sum + line.debit - line.credit, 0))).toBe(0)
  }
  const fixtures: PeriodFixture[] = [{ ...period, entries, opening }]
  if (options.previous) fixtures.push(options.previous)
  const report = await generateKassaflodesanalysWithStatement(makeClient(fixtures), 'company-1', period.id, options)
  return report.statement
}

/** Every line, subtotal and total adds up, and the year ties to likvida medel. */
function expectConsistent(year: KassaflodesanalysYear) {
  const a = year.amounts
  const sumOf = (...keys: KassaflodesanalysLineKey[]) => round(keys.reduce((sum, key) => sum + a[key], 0))
  expect(a.kassaflode_fore_rorelsekapital).toBe(sumOf(
    'rorelseresultat', 'justeringar_ej_kassaflode', 'erhallen_utdelning', 'erhallen_ranta', 'erlagd_ranta',
    'ovriga_finansiella_poster', 'betald_inkomstskatt', 'koncernbidrag',
  ))
  expect(a.kassaflode_lopande).toBe(sumOf(
    'kassaflode_fore_rorelsekapital', 'forandring_varulager', 'forandring_rorelsefordringar',
    'forandring_rorelseskulder', 'ovriga_poster',
  ))
  expect(a.kassaflode_investering).toBe(sumOf(
    'investering_immateriella', 'forsaljning_immateriella', 'investering_materiella', 'forsaljning_materiella',
    'investering_finansiella', 'forsaljning_finansiella', 'forandring_kortfristiga_placeringar',
    'forandring_sparrade_bankmedel',
  ))
  expect(a.kassaflode_finansiering).toBe(sumOf(
    'upptagna_lan', 'amortering_lan', 'forandring_checkrakningskredit', 'nyemission',
    'erhallna_aktieagartillskott', 'utbetald_utdelning',
  ))
  expect(a.arets_kassaflode).toBe(sumOf('kassaflode_lopande', 'kassaflode_investering', 'kassaflode_finansiering'))
  expect(a.likvida_medel_ub).toBe(sumOf('likvida_medel_ib', 'arets_kassaflode', 'kursdifferens_likvida_medel'))
  expect(a.justeringar_ej_kassaflode).toBe(round(
    year.justeringar.avskrivningar_nedskrivningar + year.justeringar.realisationsresultat
      + year.justeringar.orealiserade_kursdifferenser + year.justeringar.ovriga,
  ))
  expect(year.reconciliation.mismatch_amount).toBe(0)
  expect(year.reconciliation.is_reconciled).toBe(true)
  expect(year.likvida_medel.ib.total).toBe(a.likvida_medel_ib)
  expect(year.likvida_medel.ub.total).toBe(a.likvida_medel_ub)
  // Gross lines carry their sign.
  for (const key of ['investering_immateriella', 'investering_materiella', 'investering_finansiella', 'amortering_lan'] as const) {
    expect(a[key]).toBeLessThanOrEqual(0)
  }
  for (const key of ['forsaljning_immateriella', 'forsaljning_materiella', 'forsaljning_finansiella', 'upptagna_lan'] as const) {
    expect(a[key]).toBeGreaterThanOrEqual(0)
  }
}

describe('K3 chapter 7 statement', () => {
  it('lays out every amount key once, in sections, with a taxonomy concept where one exists', () => {
    const keys = KASSAFLODESANALYS_LAYOUT.map((row) => row.key)
    expect(new Set(keys).size).toBe(keys.length)
    const sections = KASSAFLODESANALYS_LAYOUT.map((row) => row.section)
    // Sections appear in statement order and never interleave.
    expect([...new Set(sections)]).toEqual(['lopande', 'investering', 'finansiering', 'likvida_medel'])
    for (const row of KASSAFLODESANALYS_LAYOUT) expect(row.label).not.toMatch(/[–—]/)
  })

  it('shows interest and dividends received and paid as cash, adjusted for accruals (7.14-7.15)', async () => {
    const opening = lines(['1930', 100_000, 0], ['1760', 300, 0], ['2960', 0, 1_000], ['2091', 0, 99_300])
    const result = await statement([
      pair('1930', '3001', 50_000),
      pair('1930', '8311', 700), // bank interest received
      pair('1930', '1760', 300), // last year's accrued interest received
      pair('1760', '8313', 400), // this year's accrued, not yet received
      pair('8410', '1930', 4_000), // loan interest paid
      pair('2960', '1930', 1_000), // last year's accrued interest paid
      pair('8410', '2960', 1_500), // this year's accrued, not yet paid
      pair('1930', '8012', 2_000), // dividend from a subsidiary
    ], opening)

    const a = result.current.amounts
    expectConsistent(result.current)
    expect(a.rorelseresultat).toBe(50_000)
    expect(a.erhallen_ranta).toBe(1_000) // 700 + 300 received; the 400 accrual is not cash
    expect(a.erlagd_ranta).toBe(-5_000) // 4 000 + 1 000 paid; the 1 500 accrual is not cash
    expect(a.erhallen_utdelning).toBe(2_000)
    expect(a.kassaflode_lopande).toBe(48_000)
    expect(a.arets_kassaflode).toBe(48_000)
  })

  it('keeps paid dividends in finansiering (7.16) and income tax in its own line (7.17, 7.20)', async () => {
    const opening = lines(['1930', 500_000, 0], ['2098', 0, 200_000], ['2512', 0, 30_000], ['2091', 0, 270_000])
    const result = await statement([
      pair('2098', '2898', 100_000), // dividend decided
      pair('2898', '1930', 100_000), // and paid
      pair('2512', '1930', 30_000), // last year's income tax paid
      pair('8910', '2512', 12_000), // this year's provision, unpaid
      pair('1930', '3001', 60_000),
    ], opening)

    const a = result.current.amounts
    expectConsistent(result.current)
    expect(a.utbetald_utdelning).toBe(-100_000)
    expect(a.betald_inkomstskatt).toBe(-30_000)
    expect(result.current.total_tax_payments).toBe(-30_000)
    expect(a.kassaflode_lopande).toBe(30_000)
  })

  it('shows borrowing and amortisation gross, not the net change in loans (7.11)', async () => {
    const opening = lines(['1930', 50_000, 0], ['2350', 0, 400_000], ['1110', 400_000, 0], ['2091', 0, 50_000])
    const result = await statement([
      pair('1930', '2350', 300_000), // new loan
      pair('2350', '1930', 100_000), // amortisation
      pair('2350', '2417', 50_000), // current portion reclassified: no flow
      pair('1930', '2480', 20_000), // checkräkningskredit drawn: netted (7.12)
    ], opening)

    const a = result.current.amounts
    expectConsistent(result.current)
    expect(a.upptagna_lan).toBe(300_000)
    expect(a.amortering_lan).toBe(-100_000)
    expect(a.forandring_checkrakningskredit).toBe(20_000)
    expect(a.kassaflode_finansiering).toBe(220_000)
  })

  it('nets a reversed borrowing with its storno instead of showing it twice', async () => {
    const result = await statement([
      pair('1930', '2350', 300_000),
      { lines: pair('2350', '1930', 300_000), reverses: 0 },
      pair('1930', '2350', 100_000),
      pair('2350', '1930', 40_000),
    ], lines(['1930', 100_000, 0], ['2091', 0, 100_000]))

    expectConsistent(result.current)
    expect(result.current.amounts.upptagna_lan).toBe(100_000)
    expect(result.current.amounts.amortering_lan).toBe(-40_000)
  })

  it('shows acquisitions and disposals gross per kind, the disposal at its proceeds', async () => {
    const opening = lines(
      ['1220', 80_000, 0], ['1229', 0, 30_000], ['1930', 200_000, 0], ['1310', 40_000, 0], ['2091', 0, 290_000],
    )
    const result = await statement([
      pair('1010', '1930', 20_000), // balanserade utgifter acquired
      pair('1220', '1930', 50_000), // new inventarier
      // Inventarier sold for 25 000: cost 30 000 less accumulated 10 000 is a book value of
      // 20 000, so a gain of 5 000.
      lines(['1930', 25_000, 0], ['1229', 10_000, 0], ['1220', 0, 30_000], ['3973', 0, 5_000]),
      pair('7832', '1229', 8_000), // depreciation
      pair('7811', '1019', 2_000),
      lines(['1930', 45_000, 0], ['1310', 0, 40_000], ['8020', 0, 5_000]), // subsidiary shares sold
      pair('1380', '1930', 15_000), // loan to another company
    ], opening)

    const a = result.current.amounts
    expectConsistent(result.current)
    expect(a.investering_immateriella).toBe(-20_000)
    expect(a.forsaljning_immateriella).toBe(0)
    expect(a.investering_materiella).toBe(-50_000)
    expect(a.forsaljning_materiella).toBe(25_000)
    expect(a.investering_finansiella).toBe(-15_000)
    expect(a.forsaljning_finansiella).toBe(45_000)
    expect(result.current.justeringar.avskrivningar_nedskrivningar).toBe(10_000)
    expect(result.current.justeringar.realisationsresultat).toBe(-5_000)
    // Rörelseresultat is the resultaträkning's: the gain is in it, then reversed.
    expect(a.rorelseresultat).toBe(-5_000)
  })

  it('reports the exchange difference on likvida medel outside the three categories (7.13)', async () => {
    const opening = lines(['1980', 100_000, 0], ['1930', 50_000, 0], ['2091', 0, 150_000])
    const result = await statement([
      pair('1980', '8331', 3_000), // currency account revalued at balansdagen
      lines(['1930', 20_500, 0], ['1980', 0, 20_000], ['3960', 0, 500]), // currency exchanged at a gain
      pair('1930', '3001', 10_000),
    ], opening)

    const a = result.current.amounts
    expectConsistent(result.current)
    expect(a.kursdifferens_likvida_medel).toBe(3_500)
    expect(a.rorelseresultat).toBe(10_500)
    expect(result.current.justeringar.orealiserade_kursdifferenser).toBe(-500)
    expect(a.forandring_rorelsefordringar).toBe(0)
    expect(a.arets_kassaflode).toBe(10_000)
  })

  it('keeps a revaluation of a receivable in working capital, not in the kursdifferens', async () => {
    const opening = lines(['1510', 10_000, 0], ['1930', 5_000, 0], ['2091', 0, 15_000])
    const result = await statement([pair('1510', '3960', 400), lines(['1930', 10_400, 0], ['1510', 0, 10_400])], opening)

    expectConsistent(result.current)
    expect(result.current.amounts.kursdifferens_likvida_medel).toBe(0)
    expect(result.current.amounts.kassaflode_lopande).toBe(10_400)
  })

  it('leaves spärrade bankmedel out of likvida medel and counts a koncernkonto from 2026 (7.4)', async () => {
    const opening = lines(['1930', 100_000, 0], ['1960', 40_000, 0], ['2091', 0, 140_000])
    const entries = [pair('1974', '1930', 25_000), pair('1960', '1930', 10_000)]

    const from2026 = await statement(entries, opening)
    expectConsistent(from2026.current)
    expect(from2026.current.likvida_medel.definition.koncernkonto_included).toBe(true)
    expect(from2026.current.amounts.forandring_sparrade_bankmedel).toBe(-25_000)
    expect(from2026.current.amounts.forandring_rorelsefordringar).toBe(0)
    expect(from2026.current.likvida_medel.ub).toEqual({
      kassamedel: 0, bank: 65_000, kortfristiga_placeringar: 0, koncernkonto: 50_000, total: 115_000,
    })

    const before2026 = await statement(entries, opening, { period: PREVIOUS })
    expectConsistent(before2026.current)
    expect(before2026.current.likvida_medel.definition.koncernkonto_included).toBe(false)
    expect(before2026.current.amounts.likvida_medel_ib).toBe(100_000)
    expect(before2026.current.amounts.forandring_rorelsefordringar).toBe(-10_000)
  })

  it('counts an account the caller adds as likvida medel (a klientmedelskonto, 38.16)', async () => {
    const opening = lines(['1930', 10_000, 0], ['1689', 90_000, 0], ['2091', 0, 100_000])
    const result = await statement([pair('1689', '1930', 5_000), pair('1689', '3001', 2_000)], opening, {
      extraLikvidaMedelAccounts: ['1689'],
    })

    expectConsistent(result.current)
    expect(result.current.amounts.likvida_medel_ib).toBe(100_000)
    expect(result.current.amounts.likvida_medel_ub).toBe(102_000)
    expect(result.current.amounts.forandring_rorelsefordringar).toBe(0)
  })

  it('adds the previous year as the comparative column (3.5)', async () => {
    const previous: PeriodFixture = {
      ...PREVIOUS,
      entries: [pair('1930', '3001', 70_000), pair('5010', '1930', 20_000)],
      opening: lines(['1930', 10_000, 0], ['2091', 0, 10_000]),
    }
    const result = await statement([pair('1930', '3001', 30_000)], lines(['1930', 60_000, 0], ['2091', 0, 60_000]), {
      includePreviousYear: true, previous,
    })

    expect(result.previous_status).toBe('included')
    expectConsistent(result.previous!)
    expect(result.previous!.period_start).toBe('2025-01-01')
    expect(result.previous!.amounts.rorelseresultat).toBe(50_000)
    expect(result.previous!.amounts.likvida_medel_ub).toBe(60_000)
    expect(result.current.amounts.likvida_medel_ib).toBe(60_000)
  })

  it('says why there is no comparative column', async () => {
    const opening = lines(['1930', 10_000, 0], ['2091', 0, 10_000])
    expect((await statement([], opening)).previous_status).toBe('not_requested')
    expect((await statement([], opening, { includePreviousYear: true })).previous_status).toBe('no_previous_period')
    const onlyOpening: PeriodFixture = { ...PREVIOUS, entries: [], opening }
    const result = await statement([], opening, { includePreviousYear: true, previous: onlyOpening })
    expect(result.previous_status).toBe('no_activity')
    expect(result.previous).toBeNull()
  })

  it('adds up to the change in likvida medel for any balanced ledger', async () => {
    let seed = 20261026
    const random = () => {
      seed = (seed + 0x6d2b79f5) | 0
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296
    }
    const POOL = [
      '1010', '1019', '1110', '1119', '1180', '1220', '1229', '1310', '1318', '1370', '1380', '1389', '1460',
      '1510', '1630', '1640', '1660', '1690', '1740', '1760', '1810', '1910', '1930', '1950', '1960', '1974',
      '1980', '2081', '2091', '2093', '2098', '2099', '2126', '2220', '2240', '2330', '2350', '2417', '2440',
      '2480', '2510', '2512', '2611', '2641', '2841', '2862', '2898', '2960', '3001', '3960', '3973',
      '5010', '6996', '7010', '7732', '7832', '7960', '7973', '8012', '8016', '8020', '8222', '8255',
      '8311', '8331', '8350', '8390', '8410', '8412', '8436', '8480', '8811', '8820', '8910', '8940', '8999',
      '9999',
    ]
    const pick = () => POOL[Math.floor(random() * POOL.length)]
    const amount = () => Math.max(0.01, round(random() * 100_000))

    for (let iteration = 0; iteration < 150; iteration++) {
      const opening: Line[] = []
      for (let i = Math.floor(random() * 6); i > 0; i--) {
        const account = pick()
        if (!/^[12]/.test(account)) continue
        opening.push(random() < 0.5 ? { account, debit: amount(), credit: 0 } : { account, debit: 0, credit: amount() })
      }
      const openingNet = round(opening.reduce((sum, line) => sum + line.debit - line.credit, 0))
      if (openingNet !== 0) {
        opening.push({ account: '2091', debit: openingNet < 0 ? -openingNet : 0, credit: openingNet > 0 ? openingNet : 0 })
      }
      const entries: Entry[] = []
      for (let e = 1 + Math.floor(random() * 20); e > 0; e--) {
        const entry: Line[] = []
        for (let l = 1 + Math.floor(random() * 3); l > 0; l--) {
          entry.push(random() < 0.5 ? { account: pick(), debit: amount(), credit: 0 } : { account: pick(), debit: 0, credit: amount() })
        }
        const net = round(entry.reduce((sum, line) => sum + line.debit - line.credit, 0))
        if (net === 0) continue
        entry.push({ account: pick(), debit: net < 0 ? -net : 0, credit: net > 0 ? net : 0 })
        entries.push(entry)
      }
      const result = await statement(entries, opening, iteration % 2 ? { period: PREVIOUS } : {})
      expectConsistent(result.current)
      for (const account of result.current.unclassified_accounts) expect(account).toBe('9999')
    }
  })
})
