/**
 * An ekonomisk förening's annual report maps every year with the förening
 * equity table (ÅRL 3 kap. 10 b §: medlemsinsatser and förlagsinsatser as
 * their own posts in bundet eget kapital, no aktiekapital or överkursfond).
 *
 * The current year's statements already did. Two mappings did not and fell
 * back to the aktiebolag table: the iXBRL input (Medlemsinsatser and
 * Förlagsinsatser folded into Reservfond under an Aktiekapital row), and the
 * earlier years of the flerårsöversikt. The first made the PDF/iXBRL
 * cross-check fail for every K2 förening, which refused to version the
 * report; the second computed earlier years' soliditet on another table than
 * the balance sheet.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createLedgerFakeDb, type LedgerRow } from '@/tests/ledger-fake-db'
import { BOOKS_COMPANY_ID, reportBooks } from '@/tests/fixtures/report-books'
import { buildCanonicalAnnualReport } from '../model'
import { calculateSoliditet } from '../build-data'
import { hasStatementIntegrityErrors } from '../version-service'
import { mapTrialBalancesToK2 } from '@/lib/bokslut/ixbrl/k2-mapper'
import { generateTrialBalance } from '@/lib/reports/trial-balance'

const OPTIONS = { generatedAt: '2026-02-01T10:00:00.000Z', todayIso: '2026-02-01' }

function foreningBooks(): Record<string, LedgerRow[]> {
  const tables = reportBooks('ekonomisk_forening')
  // 1 000 kr left on 2081 Aktiekapital in every year's IB: an account a
  // förening cannot have (EFL 1 kap.), so its table leaves it outside eget
  // kapital, and the aktiebolag table counts it in.
  for (const period of tables.fiscal_periods) {
    const ibId = period.opening_balance_entry_id
    const bank = tables.journal_entry_lines.find((l) => l.journal_entry_id === ibId && l.account_number === '1930')!
    bank.debit_amount = Number(bank.debit_amount) + 1000
    tables.journal_entry_lines.push({
      id: `jl-ib-${String(period.name)}-99`,
      journal_entry_id: ibId,
      company_id: BOOKS_COMPANY_ID,
      account_number: '2081',
      debit_amount: 0,
      credit_amount: 1000,
      line_description: null,
      dimensions: {},
    })
  }
  return tables
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-02-01T10:00:00Z'))
})
afterEach(() => {
  vi.useRealTimers()
})

describe('annual report for an ekonomisk förening', () => {
  it('versions: the iXBRL input carries the same förening statements as the PDF', async () => {
    const db = createLedgerFakeDb({ companyId: BOOKS_COMPANY_ID, tables: reportBooks('ekonomisk_forening') })
    const model = await buildCanonicalAnnualReport(db.supabase as never, BOOKS_COMPANY_ID, 'fp-2025', OPTIONS)

    expect(model.validation.issues.map((issue) => issue.code)).not.toContain('AR-IXBRL-STATEMENT-MISMATCH')
    expect(hasStatementIntegrityErrors(model)).toBe(false)

    const equity = model.report.balansrakning.equity_liabilities.map((row) => row.label)
    expect(equity).toEqual(expect.arrayContaining(['Medlemsinsatser', 'Förlagsinsatser']))
    expect(equity).not.toContain('Aktiekapital')
    expect(model.ixbrl?.br['Medlemsinsatser']).toEqual({ current: 20000, previous: 20000 })
    expect(model.ixbrl?.br['Forlagsinsatser']).toEqual({ current: 5000, previous: 5000 })
    expect(model.ixbrl?.br['Reservfond']).toEqual({ current: 0, previous: 0 })
    expect(model.ixbrl?.br['Aktiekapital']).toBeUndefined()
    expect(model.ixbrl?.warnings.join('\n')).not.toMatch(/redovisas under Reservfond/)
  })

  it('computes every flerårsöversikt year on the förening equity table', async () => {
    const tables = foreningBooks()
    const db = createLedgerFakeDb({ companyId: BOOKS_COMPANY_ID, tables })
    const model = await buildCanonicalAnnualReport(db.supabase as never, BOOKS_COMPANY_ID, 'fp-2025', {
      ...OPTIONS,
      includeIxbrl: false,
    })

    const expected = async (periodId: string) => {
      const reader = createLedgerFakeDb({ companyId: BOOKS_COMPANY_ID, tables })
      const pair = {
        full: (await generateTrialBalance(reader.supabase as never, BOOKS_COMPANY_ID, periodId, { closingEntry: 'include' })).rows,
        preClosing: (
          await generateTrialBalance(reader.supabase as never, BOOKS_COMPANY_ID, periodId, { closingEntry: 'exclude-final' })
        ).rows,
      }
      return {
        forening: calculateSoliditet(
          mapTrialBalancesToK2(pair, null, { currentIsPriorYear: true, legalForm: 'ekonomisk_forening' }),
        ),
        aktiebolag: calculateSoliditet(mapTrialBalancesToK2(pair, null, { currentIsPriorYear: true })),
      }
    }

    const rows = model.report.forvaltningsberattelse.flerarsoversikt
    for (const [year, periodId] of [['2023', 'fp-2023'], ['2024', 'fp-2024']]) {
      const soliditet = await expected(periodId)
      // The fixture is built so the two tables disagree.
      expect(soliditet.forening).not.toBe(soliditet.aktiebolag)
      expect(rows.find((row) => row.year === year)?.soliditet_pct).toBe(soliditet.forening)
    }
  })
})
