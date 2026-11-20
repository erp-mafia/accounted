/**
 * The annual report over three years of books in the in-memory ledger.
 *
 * The aktiebolag and enskild firma snapshots were written before the report
 * started reusing the trial balances and K2 mapping it builds once (the
 * iXBRL input rebuilt both, and every trial balance read the chart again):
 * the canonical model, the iXBRL input and the balance sheet must stay
 * identical. The query counts pin what one report costs.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createLedgerFakeDb } from '@/tests/ledger-fake-db'
import { BOOKS_COMPANY_ID, reportBooks, type BooksForm } from '@/tests/fixtures/report-books'
import { buildCanonicalAnnualReport } from '../model'
import { buildIxbrlInput } from '@/lib/bokslut/ixbrl/build-input'
import { generateBalanceSheet } from '@/lib/reports/balance-sheet'

const OPTIONS = { generatedAt: '2026-02-01T10:00:00.000Z', todayIso: '2026-02-01' }

function ledger(form: BooksForm) {
  return createLedgerFakeDb({ companyId: BOOKS_COMPANY_ID, tables: reportBooks(form) })
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-02-01T10:00:00Z'))
})
afterEach(() => {
  vi.useRealTimers()
})

describe.each(['aktiebolag', 'enskild_firma'] as const)('annual report over a ledger: %s', (form) => {
  it('builds the canonical model, iXBRL input included, unchanged', async () => {
    const db = ledger(form)
    const model = await buildCanonicalAnnualReport(db.supabase as never, BOOKS_COMPANY_ID, 'fp-2025', OPTIONS)
    expect(model.ixbrl).not.toBeNull()
    expect(model).toMatchSnapshot()
  })

  it('builds the iXBRL input on its own (the file and preflight path) unchanged', async () => {
    const db = ledger(form)
    const input = await buildIxbrlInput(db.supabase as never, BOOKS_COMPANY_ID, 'fp-2025', {
      todayIso: OPTIONS.todayIso,
      signatureRequests: [],
    })
    expect(input).toMatchSnapshot()
  })

  it('builds the balance sheet of every year unchanged', async () => {
    const db = ledger(form)
    for (const periodId of ['fp-2023', 'fp-2024', 'fp-2025']) {
      expect(await generateBalanceSheet(db.supabase as never, BOOKS_COMPANY_ID, periodId)).toMatchSnapshot(periodId)
    }
  })
})
