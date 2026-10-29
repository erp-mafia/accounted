/**
 * What one annual report and one SIE export cost in trial balances and
 * Supabase reads, over three years of books in the in-memory ledger. The
 * numbers are pinned so a change that starts rebuilding a trial balance per
 * section, or walking the previous year's ledger again, shows up here.
 *
 * Before the reuse (same books): the annual report built 10 trial balances
 * in 67 reads, 10 of them of the whole chart; the SIE export read every line
 * of the previous year (5 081 line rows in 43 reads with 2 500 extra
 * vouchers, 80 rows in 16 reads without).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createLedgerFakeDb } from '@/tests/ledger-fake-db'
import { BOOKS_COMPANY_ID, reportBooks } from '@/tests/fixtures/report-books'

vi.mock('@/lib/reports/trial-balance', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/reports/trial-balance')>()
  return { ...actual, generateTrialBalance: vi.fn(actual.generateTrialBalance) }
})

import { generateTrialBalance } from '@/lib/reports/trial-balance'
import { buildCanonicalAnnualReport } from '@/lib/bokslut/arsredovisning/model'
import { generateSIEExport } from '../sie-export'

const trialBalances = () => vi.mocked(generateTrialBalance).mock.calls.length

beforeEach(() => {
  vi.mocked(generateTrialBalance).mockClear()
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-02-01T10:00:00Z'))
})
afterEach(() => {
  vi.useRealTimers()
})

describe('report query counts', () => {
  it('one annual report (PDF model and iXBRL input) builds each trial balance once on one chart read', async () => {
    const db = createLedgerFakeDb({ companyId: BOOKS_COMPANY_ID, tables: reportBooks('aktiebolag') })
    const model = await buildCanonicalAnnualReport(db.supabase as never, BOOKS_COMPANY_ID, 'fp-2025', {
      generatedAt: '2026-02-01T10:00:00.000Z',
      todayIso: '2026-02-01',
    })
    expect(model.ixbrl).not.toBeNull()

    // Two variants (full, pre-closing) for each of the three years.
    expect(trialBalances()).toBe(6)
    expect(db.counts()).toMatchObject({
      chart_of_accounts: 1,
      'rpc:get_trial_balance_aggregates': 6,
    })
    // 43: the year's framework record (fiscal_period_frameworks, BFNAR
    // 2012:4) and, for a year without one (these books), the company default.
    // 46: the specification of changes in equity reads each year's equity
    // verifikat (one get_entries_with_account_lines per year) and the years'
    // ingående balans verifikat ids (fiscal_periods).
    expect(db.total()).toBe(46)
  })

  it('one SIE export reads the previous year as sums per account, whatever its size', async () => {
    const read = async (priorYearVouchers: number) => {
      vi.mocked(generateTrialBalance).mockClear()
      const db = createLedgerFakeDb({
        companyId: BOOKS_COMPANY_ID,
        tables: reportBooks('aktiebolag', { priorYearVouchers }),
      })
      await generateSIEExport(db.supabase as never, BOOKS_COMPANY_ID, {
        fiscal_period_id: 'fp-2025',
        company_name: 'Bokföringsexempel',
        org_number: '5566778899',
      })
      return { trialBalances: trialBalances(), total: db.total(), counts: db.counts(), rows: db.rowsRead() }
    }

    const small = await read(0)
    const large = await read(2500)

    expect(small.trialBalances).toBe(1)
    expect(small.counts).toMatchObject({ chart_of_accounts: 1 })
    expect(small.total).toBe(20)
    // 2 500 more vouchers in the previous year: not one more read, and the
    // line rows read are the current year's, the IB entries and the
    // resultatavslut, not the previous year's vouchers.
    expect(large.total).toBe(small.total)
    expect(large.rows.journal_entry_lines).toBeLessThan(100)
    expect(large.rows.journal_entries).toBeLessThan(100)
  })
})
