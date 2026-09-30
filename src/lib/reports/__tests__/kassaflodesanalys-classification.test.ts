import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { generateKassaflodesanalys, type KassaflodesanalysReport } from '../kassaflodesanalys'

// Runs the real report, trial-balance and tax-bridge modules over balanced
// journal fixtures. The in-memory client stands in for the database reads
// (the trial-balance RPC aggregates, prior opening balances); it does not
// verify SQL. All amounts are invented.
type Line = { account: string; debit: number; credit: number }
type Entry = Line[]

const round = (value: number) => Math.round(value * 100) / 100 || 0
const pair = (debit: string, credit: string, amount: number): Entry => [
  { account: debit, debit: amount, credit: 0 },
  { account: credit, debit: 0, credit: amount },
]
const lines = (...parts: [string, number, number][]): Entry =>
  parts.map(([account, debit, credit]) => ({ account, debit, credit }))

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

function makeClient(entries: Entry[], opening: Line[]) {
  const period = {
    period_start: '2026-01-01', period_end: '2026-12-31',
    opening_balance_entry_id: null, closing_entry_id: null, is_closed: false, closed_externally: false,
  }
  const from = vi.fn((table: string) => {
    const result = () => (table === 'fiscal_periods'
      ? { data: period, error: null }
      : { data: [], error: null })
    const builder: Record<string, unknown> = {}
    for (const method of ['select', 'eq', 'neq', 'in', 'order', 'range']) builder[method] = () => builder
    builder.single = async () => result()
    builder.then = (resolve: (value: ReturnType<typeof result>) => void) => resolve(result())
    return builder
  })
  const rpc = vi.fn(async (name: string) => {
    if (name === 'compute_prior_opening_balances') return { data: aggregate(opening), error: null }
    if (name === 'get_trial_balance_aggregates') {
      return { data: aggregate(entries.flat()).map((row) => ({ bucket: 'period', ...row })), error: null }
    }
    throw new Error(`Unexpected RPC: ${name}`)
  })
  return { from, rpc } as unknown as Parameters<typeof generateKassaflodesanalys>[0]
}

async function run(entries: Entry[], opening: Line[] = []) {
  for (const entry of [...entries, opening]) {
    expect(round(entry.reduce((sum, line) => sum + line.debit - line.credit, 0))).toBe(0)
  }
  return generateKassaflodesanalys(makeClient(entries, opening), 'company-1', 'period-1')
}

function expectSectionsAddUp(report: KassaflodesanalysReport) {
  const lineSum = (section: Record<string, number>) => round(
    Object.entries(section).filter(([key]) => key !== 'total').reduce((sum, [, value]) => sum + value, 0),
  )
  expect(lineSum(report.lopande)).toBe(report.lopande.total)
  expect(lineSum(report.investerings)).toBe(report.investerings.total)
  expect(lineSum(report.finansierings)).toBe(report.finansierings.total)
  expect(round(report.lopande.total + report.investerings.total + report.finansierings.total))
    .toBe(report.total_cash_flow)
  expect(report.total_cash_flow).toBe(report.reconciliation.delta_actual)
  expect(report.reconciliation.mismatch_amount).toBe(0)
  expect(report.reconciliation.is_reconciled).toBe(true)
}

beforeEach(() => { vi.stubEnv('REPORTS_TB_RPC', 'on') })
afterEach(() => { vi.unstubAllEnvs() })

describe('kassaflödesanalys classifies every account', () => {
  // Deterministic PRNG so a failure reproduces.
  function prng(seed: number) {
    return () => {
      seed = (seed + 0x6d2b79f5) | 0
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296
    }
  }

  // One or more accounts from every BAS range the report classifies, plus one
  // (9999) that no range covers. Unspecified 89xx accounts are left out: the
  // tax bridge refuses those by design (kassaflodesanalys-tax.test.ts).
  const POOL = [
    '1010', '1019', '1110', '1119', '1180', '1220', '1229', '1288', '1310', '1318', '1350', '1370',
    '1380', '1385', '1389', '1460', '1510', '1630', '1640', '1650', '1660', '1682', '1685', '1690',
    '1710', '1790', '1810', '1890', '1910', '1930', '1950', '2013', '2081', '2086', '2091', '2092',
    '2093', '2097', '2098', '2099', '2126', '2153', '2220', '2240', '2330', '2350', '2393', '2417',
    '2420', '2440', '2480', '2510', '2512', '2514', '2518', '2611', '2641', '2650', '2710', '2731',
    '2841', '2862', '2893', '2898', '2920', '2990', '3001', '3911', '3973', '4010', '5010', '6072',
    '6996', '7010', '7412', '7510', '7533', '7732', '7832', '7973', '8012', '8020', '8222', '8272',
    '8282', '8311', '8350', '8370', '8410', '8811', '8820', '8830', '8853', '8910', '8930', '8940',
    '8999', '9999',
  ]

  it('adds up to the change in 19xx for any balanced ledger', async () => {
    const random = prng(20260928)
    const pick = () => POOL[Math.floor(random() * POOL.length)]
    const amount = () => Math.max(0.01, round(random() * 100_000))

    for (let iteration = 0; iteration < 200; iteration++) {
      const opening: Line[] = []
      for (let i = Math.floor(random() * 6); i > 0; i--) {
        const account = pick()
        if (!/^[12]/.test(account)) continue
        opening.push(random() < 0.5
          ? { account, debit: amount(), credit: 0 }
          : { account, debit: 0, credit: amount() })
      }
      const openingNet = round(opening.reduce((sum, line) => sum + line.debit - line.credit, 0))
      if (openingNet !== 0) {
        opening.push({ account: '2091', debit: openingNet < 0 ? -openingNet : 0, credit: openingNet > 0 ? openingNet : 0 })
      }

      const entries: Entry[] = []
      for (let e = 1 + Math.floor(random() * 20); e > 0; e--) {
        const entry: Entry = []
        for (let l = 1 + Math.floor(random() * 3); l > 0; l--) {
          entry.push(random() < 0.5
            ? { account: pick(), debit: amount(), credit: 0 }
            : { account: pick(), debit: 0, credit: amount() })
        }
        const net = round(entry.reduce((sum, line) => sum + line.debit - line.credit, 0))
        if (net === 0) continue
        entry.push({ account: pick(), debit: net < 0 ? -net : 0, credit: net > 0 ? net : 0 })
        entries.push(entry)
      }

      const report = await run(entries, opening)
      expectSectionsAddUp(report)
      expect(report.investerings.forvarv_anlaggningar).toBeLessThanOrEqual(0)
      expect(report.investerings.avyttring_anlaggningar).toBeGreaterThanOrEqual(0)
      for (const account of report.unclassified_accounts) expect(account).toBe('9999')
    }
  })

  it('shows disposals at their proceeds, repays loans and a group liability (building and inventory sale)', async () => {
    // Opening: a building and inventarier with accumulated depreciation, a
    // bank loan and its current portion, a liability to a subsidiary.
    const opening = lines(
      ['1110', 1_000_000, 0], ['1119', 0, 200_000], ['1220', 50_000, 0], ['1229', 0, 20_000],
      ['1930', 100_000, 0], ['2350', 0, 400_000], ['2417', 0, 20_000], ['2862', 0, 60_000],
      ['2091', 0, 450_000],
    )
    const report = await run([
      pair('7821', '1119', 20_000), // depreciation up to the sale
      pair('7832', '1229', 5_000),
      // Building sold for 900 000: cost and accumulated depreciation leave
      // together, the gain is proceeds less book value (780 000).
      lines(['1930', 900_000, 0], ['1119', 220_000, 0], ['1110', 0, 1_000_000], ['3972', 0, 120_000]),
      // Inventarier sold for 10 000 plus VAT at a loss against book value 25 000.
      lines(['1930', 12_500, 0], ['1229', 25_000, 0], ['7973', 15_000, 0], ['1220', 0, 50_000], ['2611', 0, 2_500]),
      pair('2611', '1930', 2_500),
      pair('2862', '1930', 60_000), // liability to the subsidiary repaid
      pair('2350', '1930', 400_000), // loan and current portion repaid
      pair('2417', '1930', 20_000),
      pair('1710', '1930', 9_000), // rent paid in advance
      pair('1660', '8820', 30_000), pair('1930', '1660', 30_000), // koncernbidrag, then settled
      pair('1380', '1930', 40_000), pair('8272', '1389', 40_000), // a loan made, then written down
      pair('1930', '3911', 50_000),
      pair('8410', '1930', 10_000),
      pair('8999', '2099', 110_000), // resultatavslut imported with the year
    ], opening)

    expectSectionsAddUp(report)
    expect(report.reconciliation.delta_actual).toBe(451_000)
    expect(report.lopande).toEqual({
      resultat_efter_finansiella_poster: 80_000,
      avskrivningar: 25_000,
      // The written-down loan is added back; the realized result (gain 120 000,
      // loss 15 000) leaves löpande for investering.
      ovriga_ej_kassaflodesposter: -65_000,
      delta_kortfristiga_fordringar: -9_000,
      delta_varulager: 0,
      delta_kortfristiga_skulder: -60_000,
      skatt_betald: 0,
      koncernbidrag: 30_000,
      ovriga_poster: 0,
      total: 1_000,
    })
    expect(report.investerings).toEqual({
      forvarv_anlaggningar: -40_000,
      avyttring_anlaggningar: 910_000, // 900 000 for the building, 10 000 for the inventarier
      kortfristiga_placeringar: 0,
      total: 870_000,
    })
    expect(report.finansierings).toEqual({
      delta_lan: -420_000,
      utdelningar: 0, // 8999 against 2099 is not a cash flow
      nyemission: 0,
      erhallna_aktieagartillskott: 0,
      total: -420_000,
    })
    expect(report.unclassified_accounts).toEqual([])
  })

  it('keeps a loan receivable, pension tax, the owner account and a recovered write-down in their sections', async () => {
    const opening = lines(
      ['1310', 10_000, 0], ['1380', 30_000, 0], ['1389', 0, 30_000], ['1710', 6_000, 0],
      ['1930', 200_000, 0], ['2893', 0, 8_000], ['2091', 0, 208_000],
    )
    const report = await run([
      pair('1682', '1930', 100_000), // kortfristig lånefordran
      pair('7412', '1930', 20_000), // pension premium paid
      pair('7533', '2514', 4_852), // särskild löneskatt accrued, unpaid
      pair('6570', '2893', 1_000), // the owner paid a cost privately
      pair('2893', '1930', 5_000), // and was repaid
      pair('1389', '8282', 30_000), // the written-down receivable recovered
      pair('1930', '1380', 30_000),
      lines(['1930', 15_000, 0], ['1310', 0, 10_000], ['8020', 0, 5_000]), // subsidiary shares sold at a gain
      pair('5010', '1710', 6_000), // prepaid rent used
    ], opening)

    expectSectionsAddUp(report)
    expect(report.reconciliation.delta_actual).toBe(-80_000)
    expect(report.lopande.resultat_efter_finansiella_poster).toBe(3_148)
    expect(report.lopande.ovriga_ej_kassaflodesposter).toBe(-35_000)
    expect(report.lopande.delta_kortfristiga_fordringar).toBe(-94_000)
    // 2893 repaid net 4 000; the unpaid 2514 accrual keeps its expense neutral.
    expect(report.lopande.delta_kortfristiga_skulder).toBe(852)
    expect(report.lopande.total).toBe(-125_000)
    expect(report.investerings.avyttring_anlaggningar).toBe(45_000)
    expect(report.investerings.forvarv_anlaggningar).toBe(0)
    expect(report.finansierings.total).toBe(0)
  })

  it('keeps bokslutsdispositioner, provisions and deferred tax out of the cash flow', async () => {
    const report = await run([
      pair('1930', '3001', 100_000),
      pair('8811', '2126', 25_000), // periodiseringsfond
      pair('8853', '2153', 10_000), // överavskrivningar
      pair('6990', '2220', 5_000), // avsättning för garantier
      pair('8940', '2240', 2_000), // uppskjuten skatt
    ])

    expectSectionsAddUp(report)
    // Resultat efter finansiella poster comes before bokslutsdispositioner and skatt.
    expect(report.lopande.resultat_efter_finansiella_poster).toBe(95_000)
    expect(report.lopande.ovriga_ej_kassaflodesposter).toBe(5_000)
    expect(report.lopande.total).toBe(100_000)
    expect(report.investerings.total).toBe(0)
    expect(report.finansierings.total).toBe(0)
  })

  it('puts loans, the overdraft, an emission and a paid dividend in finansiering', async () => {
    const report = await run([
      pair('1930', '2480', 50_000), // kontokredit drawn
      pair('2350', '2841', 30_000), // current portion reclassified
      pair('2841', '1930', 30_000), // and repaid
      pair('1690', '2081', 25_000), // emission subscribed
      pair('1930', '1690', 25_000), // and paid in
      pair('2098', '2898', 40_000), // dividend decided
      pair('2898', '1930', 40_000), // and paid
    ])

    expectSectionsAddUp(report)
    expect(report.finansierings).toEqual({
      delta_lan: 20_000,
      utdelningar: -40_000,
      nyemission: 25_000,
      erhallna_aktieagartillskott: 0,
      total: 5_000,
    })
    expect(report.lopande.total).toBe(0)
  })

  it('reports kortfristiga placeringar with their realized result in investering', async () => {
    const report = await run([
      pair('1810', '1930', 20_000),
      lines(['1930', 26_000, 0], ['1810', 0, 20_000], ['8350', 0, 6_000]),
    ])

    expectSectionsAddUp(report)
    expect(report.investerings.kortfristiga_placeringar).toBe(6_000)
    expect(report.lopande.total).toBe(0)
  })

  it('does not count a finished project moved off pågående nyanläggningar as a second acquisition', async () => {
    const report = await run([
      pair('1110', '1180', 300_000),
      pair('1180', '1930', 50_000),
    ], lines(['1180', 300_000, 0], ['1930', 100_000, 0], ['2091', 0, 400_000]))

    expectSectionsAddUp(report)
    expect(report.investerings.forvarv_anlaggningar).toBe(-50_000)
    expect(report.investerings.avyttring_anlaggningar).toBe(0)
  })

  it('names accounts outside every range in Övriga poster instead of dropping them', async () => {
    const report = await run([pair('1930', '9999', 10_000), pair('1930', '2519', 500)])

    expectSectionsAddUp(report)
    expect(report.lopande.ovriga_poster).toBe(10_500)
    expect(report.unclassified_accounts).toEqual(['2519', '9999'])
  })
})
