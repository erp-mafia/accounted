/**
 * The SIE export's previous-year records (#IB -1, #UB -1, #RES -1), and the
 * whole file around them, over three years of books in the in-memory ledger.
 *
 * The snapshots were written by the export that walked every journal line of
 * the previous year, before it moved onto the trial balance: the file must
 * stay byte-identical. Each case covers a book shape that reads differently
 * on the two paths: an IB entry whose line order is not account order, an
 * IB pair that nets to zero, a reversed voucher with its storno, depreciation
 * booked as a year_end entry next to the resultatavslut, a year opened from
 * the compute_prior_opening_balances fallback, and a closed year without the
 * closing link (the state the statutory 'exclude-final' read refuses).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createLedgerFakeDb } from '@/tests/ledger-fake-db'
import { BOOKS_COMPANY_ID, reportBooks, type BooksForm } from '@/tests/fixtures/report-books'
import type { LedgerRow } from '@/tests/ledger-fake-db'
import { generateSIEExport } from '../sie-export'

const OPTIONS = {
  fiscal_period_id: 'fp-2025',
  company_name: 'Bokföringsexempel',
  org_number: '5566778899',
  program_name: 'Accounted',
}

type Variant = 'linked' | 'fallback-ib' | 'unlinked-closing'

/** The books, reshaped for the variant. */
function books(form: BooksForm, variant: Variant, priorYearVouchers = 0): Record<string, LedgerRow[]> {
  const tables = reportBooks(form, { priorYearVouchers })
  const prior = tables.fiscal_periods.find((p) => p.id === 'fp-2024')!
  if (variant === 'fallback-ib') {
    // A continuation import: 2024 has no IB entry and opens from the
    // compute_prior_opening_balances fallback over 2023's lines.
    const ibId = prior.opening_balance_entry_id
    prior.opening_balance_entry_id = null
    tables.journal_entries = tables.journal_entries.filter((e) => e.id !== ibId)
    tables.journal_entry_lines = tables.journal_entry_lines.filter((l) => l.journal_entry_id !== ibId)
  }
  if (variant === 'unlinked-closing') {
    // A legacy closed year whose resultatavslut was never linked.
    prior.closing_entry_id = null
  }
  return tables
}

function exportOf(form: BooksForm, variant: Variant, excludeYearEndClosing: boolean) {
  const db = createLedgerFakeDb({ companyId: BOOKS_COMPANY_ID, tables: books(form, variant) })
  return generateSIEExport(db.supabase as never, BOOKS_COMPANY_ID, {
    ...OPTIONS,
    exclude_year_end_closing: excludeYearEndClosing,
  })
}

const priorYearRecords = (file: string) => file.split('\r\n').filter((r) => /^#(IB|UB|RES) -1 /.test(r))

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-02-01T10:00:00Z'))
})
afterEach(() => {
  vi.useRealTimers()
})

describe('generateSIEExport: previous-year records over a ledger', () => {
  const cases: Array<[BooksForm, Variant, boolean]> = []
  for (const form of ['aktiebolag', 'enskild_firma'] as const) {
    for (const variant of ['linked', 'fallback-ib', 'unlinked-closing'] as const) {
      for (const exclude of [false, true]) cases.push([form, variant, exclude])
    }
  }

  it.each(cases)('%s, %s, exclude_year_end_closing=%s: the file is unchanged', async (form, variant, exclude) => {
    const file = await exportOf(form, variant, exclude)
    expect(priorYearRecords(file).length).toBeGreaterThan(0)
    expect(file).toMatchSnapshot()
  })

  it('keeps the IB entry line order for #IB -1 (descending account order in these books)', async () => {
    const records = priorYearRecords(await exportOf('aktiebolag', 'linked', false))
    const ib = records.filter((r) => r.startsWith('#IB -1 ')).map((r) => r.split(' ')[2])
    expect(ib).toEqual([...ib].sort().reverse())
    // The 1630 pair nets to zero: no record.
    expect(ib).not.toContain('1630')
  })

  it('#UB -1 equals #IB 0 account by account, and #RES -1 is read before the resultatavslut', async () => {
    const records = (await exportOf('aktiebolag', 'linked', false)).split('\r\n')
    for (const record of records.filter((r) => r.startsWith('#IB 0 '))) {
      const [, , account, amount] = record.split(' ')
      if (account === '2098') continue // 2099 carried to 2098 by the next IB
      expect(records).toContain(`#UB -1 ${account} ${amount}`)
    }
    expect(records).toContain('#RES -1 3001 -20000.00')
    expect(records).toContain('#RES -1 7832 1000.00')
    expect(records).toContain('#RES -1 6570 123.75')
    expect(records).toContain('#RES -1 6110 0.00')
    expect(records).toContain('#UB -1 1510 0.00')
  })
})
