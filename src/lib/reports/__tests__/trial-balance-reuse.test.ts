/**
 * A report that already holds what a statement is built from passes it on:
 * a trial balance on a chart read once, a balance sheet on trial balance rows
 * already built. Each must give exactly what the self-reading call gives.
 */
import { describe, expect, it } from 'vitest'
import { createLedgerFakeDb } from '@/tests/ledger-fake-db'
import { BOOKS_COMPANY_ID, reportBooks } from '@/tests/fixtures/report-books'
import {
  fetchTrialBalanceChart,
  generateTrialBalance,
  type ClosingEntryMode,
} from '../trial-balance'
import { balanceSheetFromTrialBalance, generateBalanceSheet } from '../balance-sheet'

const PERIODS = ['fp-2023', 'fp-2024', 'fp-2025']

describe('generateTrialBalance with a preloaded chart', () => {
  it.each<ClosingEntryMode>(['include', 'exclude-final', 'exclude-all-year-end'])(
    '%s: the same rows, and the chart is not read again',
    async (closingEntry) => {
      const db = createLedgerFakeDb({ companyId: BOOKS_COMPANY_ID, tables: reportBooks('aktiebolag') })
      const chart = await fetchTrialBalanceChart(db.supabase as never, BOOKS_COMPANY_ID)
      for (const periodId of PERIODS) {
        const reading = await generateTrialBalance(db.supabase as never, BOOKS_COMPANY_ID, periodId, { closingEntry })
        db.resetCounts()
        const preloaded = await generateTrialBalance(db.supabase as never, BOOKS_COMPANY_ID, periodId, {
          closingEntry,
          chart,
        })
        const inFlight = await generateTrialBalance(db.supabase as never, BOOKS_COMPANY_ID, periodId, {
          closingEntry,
          chart: Promise.resolve(chart),
        })
        expect(preloaded).toEqual(reading)
        expect(inFlight).toEqual(reading)
        expect(db.counts().chart_of_accounts).toBeUndefined()
      }
    },
  )
})

describe('balanceSheetFromTrialBalance', () => {
  it.each(['aktiebolag', 'enskild_firma'] as const)(
    '%s: equals generateBalanceSheet over the same include trial balance, every year',
    async (form) => {
      const db = createLedgerFakeDb({ companyId: BOOKS_COMPANY_ID, tables: reportBooks(form) })
      for (const periodId of PERIODS) {
        const { rows } = await generateTrialBalance(db.supabase as never, BOOKS_COMPANY_ID, periodId, {
          closingEntry: 'include',
        })
        expect(await balanceSheetFromTrialBalance(db.supabase as never, BOOKS_COMPANY_ID, periodId, rows)).toEqual(
          await generateBalanceSheet(db.supabase as never, BOOKS_COMPANY_ID, periodId),
        )
      }
    },
  )
})
