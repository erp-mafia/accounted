/**
 * crm#1727: Accounted's SIE export writes #RES 0 of a closed year before the
 * resultatavslut, and keeps that voucher in #VER. Re-importing such a file
 * must book nothing extra. When vouchers are skipped, the migration
 * adjustment compares #RES with the imported movements: without taking the
 * imported resultatavslut out first, every result account's delta was the
 * whole year's result, booked a second time.
 */
import { describe, expect, it } from 'vitest'
import { generateSIEExport } from '@/lib/reports/sie-export'
import { parseSIEFile } from '@/lib/import/sie-parser'
import {
  buildSIEMigrationAdjustmentEntry,
  movementsBeforeResultClosing,
  prepareSIEVouchers,
  resultClosingMovementsOf,
} from '@/lib/import/sie-import'
import type { SIEPreparedEntry } from '@/lib/import/sie-job-contract'
import { createLedgerFakeDb } from '@/tests/ledger-fake-db'

const COMPANY = 'company-1'
const entry = (id: string, period: string, date: string, extra: Record<string, unknown> = {}) => ({
  id, company_id: COMPANY, fiscal_period_id: period, entry_date: date, description: id,
  voucher_series: 'A', voucher_number: Number(id.replace(/\D/g, '')) || 1, status: 'posted',
  source_type: 'manual', reverses_id: null, correction_of_id: null, ...extra,
})
const line = (id: string, entryId: string, account: string, debit: number, credit: number) => ({
  id, journal_entry_id: entryId, account_number: account, debit_amount: debit, credit_amount: credit,
  line_description: null, dimensions: {},
})

/**
 * 2024: two sales (A1, A2), depreciation booked as a year_end entry (A3) and
 * the resultatavslut (A4), which zeroes 3001 and 7832 into 2099.
 */
async function closedYearExport(): Promise<string> {
  const db = createLedgerFakeDb({
    companyId: COMPANY,
    tables: {
      fiscal_periods: [
        { id: 'p-2024', company_id: COMPANY, period_start: '2024-01-01', period_end: '2024-12-31', opening_balance_entry_id: null, closing_entry_id: 'e4', is_closed: true },
      ],
      journal_entries: [
        entry('e1', 'p-2024', '2024-03-01'),
        entry('e2', 'p-2024', '2024-06-01'),
        entry('e3', 'p-2024', '2024-12-31', { source_type: 'year_end' }),
        entry('e4', 'p-2024', '2024-12-31', { source_type: 'year_end' }),
      ],
      journal_entry_lines: [
        line('l1', 'e1', '1930', 500, 0),
        line('l2', 'e1', '3001', 0, 500),
        line('l3', 'e2', '1930', 300, 0),
        line('l4', 'e2', '3001', 0, 300),
        line('l5', 'e3', '7832', 100, 0),
        line('l6', 'e3', '1229', 0, 100),
        line('l7', 'e4', '3001', 800, 0),
        line('l8', 'e4', '7832', 0, 100),
        line('l9', 'e4', '2099', 0, 700),
      ],
    },
  })
  return generateSIEExport(db.supabase as never, COMPANY, {
    fiscal_period_id: 'p-2024',
    company_name: 'Test AB',
    org_number: '556677-8899',
    program_name: 'Accounted',
  })
}

function netOf(entries: SIEPreparedEntry[]): Map<string, number> {
  const net = new Map<string, number>()
  for (const e of entries) for (const l of e.lines) {
    net.set(l.account_number, Math.round(((net.get(l.account_number) ?? 0) + l.debit_amount - l.credit_amount) * 100) / 100)
  }
  return net
}

/** Re-import the file with the sale A2 skipped, the way a skipped voucher triggers the adjustment. */
function reimportSkippingA2(content: string, withGuard: boolean) {
  const parsed = parseSIEFile(content)
  const accounts = new Set(parsed.vouchers.flatMap((v) => v.lines.map((l) => l.account)))
  for (const b of [...parsed.closingBalances, ...parsed.resultBalances]) accounts.add(b.account)
  const accountMap = new Map([...accounts].map((a) => [a, a]))
  const { preparedEntries } = prepareSIEVouchers(parsed, accountMap, 'A', 'import-1', {
    startOrdinal: 0,
    accountIds: new Map([...accounts].map((a) => [a, `acc-${a}`])),
  })
  const booked = preparedEntries.filter((e) => !(e.sourceSeries === 'A' && e.sourceNumber === 2))
  expect(booked).toHaveLength(preparedEntries.length - 1)
  const closing = withGuard
    ? resultClosingMovementsOf(booked, parsed.stats.fiscalYearEnd, '2099')
    : new Map<string, number>()
  const adjustment = buildSIEMigrationAdjustmentEntry(
    'fp-1', parsed, accountMap, netOf(booked),
    [{ voucherId: 'A 2', date: '2024-06-01', reason: 'unmapped' }], 1, closing,
  )
  const lines = new Map(
    (adjustment.input?.lines ?? []).map((l) => [l.account_number, Math.round((l.debit_amount - l.credit_amount) * 100) / 100]),
  )
  return { parsed, closing, lines }
}

describe('re-importing a closed year exported by Accounted (crm#1727)', () => {
  it('the export carries #RES 0 before the resultatavslut and the resultatavslut in #VER', async () => {
    const content = await closedYearExport()
    const records = content.split('\r\n')
    expect(records).toContain('#RES 0 3001 -800.00')
    expect(records).toContain('#RES 0 7832 100.00')
    expect(records).toContain('#UB 0 2099 -700.00')
    expect(records.some((r) => r.startsWith('#VER ') && r.endsWith('"e4"'))).toBe(true)
  })

  it('finds the resultatavslut among the booked vouchers, and not the depreciation on the same day', async () => {
    const { closing } = reimportSkippingA2(await closedYearExport(), true)
    expect(Object.fromEntries(closing)).toEqual({ '3001': 800, '7832': -100, '2099': -700 })
  })

  it('books only the skipped voucher in the migration adjustment, never the year again', async () => {
    const { lines } = reimportSkippingA2(await closedYearExport(), true)
    // A2 was 1930 300 / 3001 -300: that, and nothing on 7832 or 2099.
    expect(Object.fromEntries(lines)).toEqual({ '1930': 300, '3001': -300 })
  })

  it('without the guard the adjustment would book the result accounts again', async () => {
    const { lines } = reimportSkippingA2(await closedYearExport(), false)
    expect(lines.get('3001')).toBe(-1100)
    expect(lines.get('7832')).toBe(100)
  })

  it('keeps the old comparison for a file whose #RES was written after the closing', async () => {
    // The export before crm#1727, and any program that writes #RES that way.
    const postClosing = (await closedYearExport())
      .replace('#RES 0 3001 -800.00', '#RES 0 3001 0.00')
      .replace('#RES 0 7832 100.00', '#RES 0 7832 0.00')
    const { closing, lines } = reimportSkippingA2(postClosing, true)
    expect(closing.size).toBeGreaterThan(0)
    expect(Object.fromEntries(lines)).toEqual({ '1930': 300, '3001': -300 })
  })
})

describe('movementsBeforeResultClosing', () => {
  it('leaves the movements alone when a closing through 8999 is already in #RES', () => {
    // Fortnox and Visma book 8999 against 2099: #RES 8999 equals its #TRANS.
    const imported = new Map([['8999', 700], ['2099', -700]])
    const result = movementsBeforeResultClosing(new Map([['8999', 700]]), imported, new Map([['8999', 700], ['2099', -700]]))
    expect(result).toBe(imported)
  })

  it('leaves the movements alone without a resultatavslut', () => {
    const imported = new Map([['3001', -800]])
    expect(movementsBeforeResultClosing(new Map([['3001', -800]]), imported, new Map())).toBe(imported)
  })
})
