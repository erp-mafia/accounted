/**
 * crm#1869: a year whose result is booked the BAS way, one verifikat on the
 * year's last day that books årets resultat (8990-8999) against the equity
 * account and touches no other result account. A previous system closes a
 * year like that, and an SIE import brings the verifikat along.
 *
 * result_closing_entry_ids recognises it as a resultatavslut by shape, and
 * #RES took its line out of 8999: the file wrote 8999 as 0.00 while #UB held
 * the result on 2099. The year's #RES then summed to the result instead of
 * zero, and a receiving bokslut program read the result as not booked.
 *
 * The file's own arithmetic, for a year without a verifikat that zeroes the
 * result accounts: every verifikat balances, so
 *   sum(#UB) + sum(#RES) = sum(#IB)
 * for year 0 and for year -1.
 */
import { describe, expect, it } from 'vitest'
import { roundOre } from '@/lib/money'
import { createLedgerFakeDb } from '@/tests/ledger-fake-db'
import { generateSIEExport } from '../sie-export'

const COMPANY = 'company-1'
const OPTIONS = { company_name: 'Test AB', org_number: '556677-8899', program_name: 'Accounted' }

type Row = Record<string, unknown>

const entry = (id: string, period: string, date: string, extra: Row = {}): Row => ({
  id, company_id: COMPANY, fiscal_period_id: period, entry_date: date, description: id,
  voucher_series: 'A', voucher_number: Number(id.replace(/\D/g, '')) || 1, status: 'posted',
  source_type: 'import', reverses_id: null, correction_of_id: null, ...extra,
})
const line = (id: string, entryId: string, account: string, debit: number, credit: number): Row => ({
  id, journal_entry_id: entryId, account_number: account, debit_amount: debit, credit_amount: credit,
  line_description: null, dimensions: {},
})

interface Shape {
  /** The form's årets resultat equity account: 2099 aktiebolag, 2019 enskild firma. */
  equity: string
  /** The årets resultat result account the year is booked through. */
  arets: string
  /** Accounted's own year-end run after the hand booking: every result account zeroed, 899x included. */
  ownClosing?: boolean
}

/**
 * 2024 opens with 1000 in the bank, sells for 400 and pays 900 in rent: a
 * loss of 500, booked on the last day as Dr equity / Cr årets resultat (v3).
 * 2025 opens from 2024's closing balances and has one sale.
 */
function ledger({ equity, arets, ownClosing = false }: Shape) {
  return createLedgerFakeDb({
    companyId: COMPANY,
    tables: {
      fiscal_periods: [
        {
          id: 'p-2024', company_id: COMPANY, period_start: '2024-01-01', period_end: '2024-12-31',
          opening_balance_entry_id: 'ib-2024', closing_entry_id: ownClosing ? 'v4' : null,
          is_closed: true, closed_externally: !ownClosing,
        },
        {
          id: 'p-2025', company_id: COMPANY, period_start: '2025-01-01', period_end: '2025-12-31',
          opening_balance_entry_id: 'ib-2025', closing_entry_id: null, is_closed: false,
        },
      ],
      journal_entries: [
        entry('ib-2024', 'p-2024', '2024-01-01', { source_type: 'opening_balance' }),
        entry('v1', 'p-2024', '2024-03-01'),
        entry('v2', 'p-2024', '2024-06-01'),
        entry('v3', 'p-2024', '2024-12-31', { voucher_series: 'J', description: 'Arets resultat' }),
        ...(ownClosing ? [entry('v4', 'p-2024', '2024-12-31', { source_type: 'year_end' })] : []),
        entry('ib-2025', 'p-2025', '2025-01-01', { source_type: 'opening_balance' }),
        entry('v5', 'p-2025', '2025-02-01'),
      ],
      journal_entry_lines: [
        line('a1', 'ib-2024', '1930', 1000, 0),
        line('a2', 'ib-2024', '2081', 0, 1000),
        line('b1', 'v1', '1930', 400, 0),
        line('b2', 'v1', '3001', 0, 400),
        line('c1', 'v2', '5010', 900, 0),
        line('c2', 'v2', '1930', 0, 900),
        line('d1', 'v3', equity, 500, 0),
        line('d2', 'v3', arets, 0, 500),
        ...(ownClosing
          ? [line('e1', 'v4', '3001', 400, 0), line('e2', 'v4', '5010', 0, 900), line('e3', 'v4', arets, 500, 0)]
          : []),
        line('f1', 'ib-2025', '1930', 500, 0),
        line('f2', 'ib-2025', '2081', 0, 1000),
        line('f3', 'ib-2025', equity, 500, 0),
        line('g1', 'v5', '1930', 200, 0),
        line('g2', 'v5', '3001', 0, 200),
      ],
    },
  })
}

async function recordsOf(shape: Shape, fiscalPeriodId: string, excludeYearEndClosing = false): Promise<string[]> {
  const file = await generateSIEExport(ledger(shape).supabase as never, COMPANY, {
    ...OPTIONS,
    fiscal_period_id: fiscalPeriodId,
    exclude_year_end_closing: excludeYearEndClosing,
  })
  return file.split('\r\n')
}

/** Sum of the amounts of one balance item for one year, e.g. ('#RES', -1). */
function sumOf(records: string[], tag: '#IB' | '#UB' | '#RES', year: 0 | -1): number {
  return roundOre(
    records
      .filter((r) => r.startsWith(`${tag} ${year} `))
      .reduce((sum, r) => sum + Number(r.split(' ')[3]), 0),
  )
}

/** Net per account of the file's #TRANS lines. */
function transNet(records: string[]): Map<string, number> {
  const net = new Map<string, number>()
  for (const r of records) {
    const trans = r.match(/^\t#TRANS (\d+) \{[^}]*\} (-?\d+\.\d{2}) /)
    if (trans) net.set(trans[1], roundOre((net.get(trans[1]) ?? 0) + Number(trans[2])))
  }
  return net
}

const SHAPES: Shape[] = [
  { equity: '2099', arets: '8999' },
  { equity: '2019', arets: '8990' },
]

describe.each(SHAPES)('SIE export of a year booked through $arets against $equity (crm#1869)', (shape) => {
  const { equity, arets } = shape

  it('writes the booked result on årets resultat in #RES -1, not 0.00', async () => {
    const records = await recordsOf(shape, 'p-2025')

    expect(records).toContain('#RAR -1 20240101 20241231')
    expect(records).toContain('#RES -1 3001 -400.00')
    expect(records).toContain('#RES -1 5010 900.00')
    expect(records).toContain(`#RES -1 ${arets} -500.00`)
    expect(records).toContain(`#UB -1 ${equity} 500.00`)
  })

  it('year -1 holds its own arithmetic: #RES -1 sums to zero once the result is on the equity account', async () => {
    const records = await recordsOf(shape, 'p-2025')

    // The balance sheet of year -1 balances with the result on the equity
    // account, so nothing of the result is left for #RES to carry.
    expect(sumOf(records, '#IB', -1)).toBe(0)
    expect(sumOf(records, '#UB', -1)).toBe(0)
    expect(sumOf(records, '#RES', -1)).toBe(0)
    expect(roundOre(sumOf(records, '#UB', -1) + sumOf(records, '#RES', -1))).toBe(sumOf(records, '#IB', -1))
    // And year 0 opens from exactly those balances.
    for (const record of records.filter((r) => r.startsWith('#IB 0 '))) {
      const [, , account, amount] = record.split(' ')
      expect(records).toContain(`#UB -1 ${account} ${amount}`)
    }
  })

  it('year 0, still open, holds the same arithmetic: its #RES is the result #UB does not carry yet', async () => {
    const records = await recordsOf(shape, 'p-2025')

    expect(sumOf(records, '#RES', 0)).toBe(-200)
    expect(roundOre(sumOf(records, '#UB', 0) + sumOf(records, '#RES', 0))).toBe(sumOf(records, '#IB', 0))
  })

  it('follows the same rule when that year is the export year: #RES 0 equals the #TRANS of the file', async () => {
    const records = await recordsOf(shape, 'p-2024')

    expect(records).toContain(`#RES 0 ${arets} -500.00`)
    expect(records).toContain(`#UB 0 ${equity} 500.00`)
    expect(records.some((r) => r.startsWith('#VER "J" ') && r.endsWith('"Arets resultat"'))).toBe(true)
    expect(sumOf(records, '#RES', 0)).toBe(0)
    expect(roundOre(sumOf(records, '#UB', 0) + sumOf(records, '#RES', 0))).toBe(sumOf(records, '#IB', 0))

    const trans = transNet(records)
    const res = records.filter((r) => r.startsWith('#RES 0 '))
    expect(res).toHaveLength(3)
    for (const record of res) {
      const [, , account, amount] = record.split(' ')
      expect(Number(amount)).toBe(trans.get(account))
    }
  })

  it('exclude_year_end_closing leaves the file as it is: the booking is no bokslut verifikat of the year-end chain', async () => {
    const withoutGen = (records: string[]) => records.filter((r) => !r.startsWith('#GEN '))

    expect(withoutGen(await recordsOf(shape, 'p-2024', true))).toEqual(withoutGen(await recordsOf(shape, 'p-2024')))
    expect(withoutGen(await recordsOf(shape, 'p-2025', true))).toEqual(withoutGen(await recordsOf(shape, 'p-2025')))
  })

  // The owner books the result by hand through 899x and then runs Accounted's
  // year-end: v4 zeroes every result account, 899x included, and moves
  // nothing more to the equity account. #RES is read before v4, which is the
  // year as the hand booking left it.
  it('keeps the booked result when Accounted\'s own closing then zeroes every result account', async () => {
    const closed = { ...shape, ownClosing: true }

    for (const [period, year] of [['p-2025', -1], ['p-2024', 0]] as const) {
      const records = await recordsOf(closed, period)
      expect(records).toContain(`#RES ${year} 3001 -400.00`)
      expect(records).toContain(`#RES ${year} 5010 900.00`)
      expect(records).toContain(`#RES ${year} ${arets} -500.00`)
      expect(records).toContain(`#UB ${year} ${equity} 500.00`)
      expect(sumOf(records, '#RES', year)).toBe(0)
      expect(roundOre(sumOf(records, '#UB', year) + sumOf(records, '#RES', year))).toBe(sumOf(records, '#IB', year))
    }
  })
})

describe('SIE export: a resultatavslut that closes the result accounts is still taken out whole', () => {
  // 8999 carries real activity (a correction booked against it, v2), and the
  // resultatavslut v3 zeroes it together with the other result accounts
  // straight against 2099. #RES is the year before v3 on every account, 8999
  // included, as before crm#1869.
  function closedLedger() {
    return createLedgerFakeDb({
      companyId: COMPANY,
      tables: {
        fiscal_periods: [
          {
            id: 'p-2024', company_id: COMPANY, period_start: '2024-01-01', period_end: '2024-12-31',
            opening_balance_entry_id: null, closing_entry_id: 'v3', is_closed: true,
          },
          {
            id: 'p-2025', company_id: COMPANY, period_start: '2025-01-01', period_end: '2025-12-31',
            opening_balance_entry_id: null, closing_entry_id: null, is_closed: false,
          },
        ],
        journal_entries: [
          entry('v1', 'p-2024', '2024-03-01', { source_type: 'manual' }),
          entry('v2', 'p-2024', '2024-04-01', { source_type: 'manual' }),
          entry('v3', 'p-2024', '2024-12-31', { source_type: 'year_end' }),
          entry('v5', 'p-2025', '2025-02-01', { source_type: 'manual' }),
        ],
        journal_entry_lines: [
          line('b1', 'v1', '1930', 400, 0),
          line('b2', 'v1', '3001', 0, 400),
          line('c1', 'v2', '8999', 10, 0),
          line('c2', 'v2', '3001', 0, 10),
          line('d1', 'v3', '3001', 410, 0),
          line('d2', 'v3', '8999', 0, 10),
          line('d3', 'v3', '2099', 0, 400),
          line('g1', 'v5', '1930', 200, 0),
          line('g2', 'v5', '3001', 0, 200),
        ],
      },
    })
  }

  it.each<[string, 0 | -1]>([['p-2025', -1], ['p-2024', 0]])('exporting %s: #RES %i is the year before the closing', async (period, year) => {
    const records = (await generateSIEExport(closedLedger().supabase as never, COMPANY, {
      ...OPTIONS,
      fiscal_period_id: period,
    })).split('\r\n')

    expect(records).toContain(`#RES ${year} 3001 -410.00`)
    expect(records).toContain(`#RES ${year} 8999 10.00`)
    expect(records).toContain(`#UB ${year} 2099 -400.00`)
    // What the closing moved to 2099 is what #RES sums to.
    expect(sumOf(records, '#RES', year)).toBe(-400)
  })
})
