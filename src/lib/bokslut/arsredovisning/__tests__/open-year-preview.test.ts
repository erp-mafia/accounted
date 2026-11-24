/**
 * The årsredovisning of a year whose result is not closed yet, over the
 * in-memory ledger: the same books as the closed year with the resultatavslut
 * left out. The preview shows the statements as the close books them and says
 * the year is not closed; it cannot be locked for signing until it is. Also:
 * where the framework comes from, and the aktiebok against the share count
 * the aktiekapital note prints.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createLedgerFakeDb, type LedgerRow } from '@/tests/ledger-fake-db'
import { BOOKS_COMPANY_ID, reportBooks } from '@/tests/fixtures/report-books'
import { buildCanonicalAnnualReport } from '../model'

const OPTIONS = { generatedAt: '2026-02-01T10:00:00.000Z', todayIso: '2026-02-01' }

type Tables = Record<string, LedgerRow[]>

/** The books before the 2025 close: no resultatavslut, no closing_entry_id. */
function beforeClose(tables: Tables): Tables {
  const closingId = tables.fiscal_periods.find((p) => p.id === 'fp-2025')?.closing_entry_id
  expect(closingId).toBeTruthy()
  return {
    ...tables,
    fiscal_periods: tables.fiscal_periods.map((p) => (p.id === 'fp-2025' ? { ...p, closing_entry_id: null } : p)),
    journal_entries: tables.journal_entries.filter((e) => e.id !== closingId),
    journal_entry_lines: tables.journal_entry_lines.filter((l) => l.journal_entry_id !== closingId),
  }
}

async function build(tables: Tables, stage: 'draft' | 'signing' = 'draft') {
  const db = createLedgerFakeDb({ companyId: BOOKS_COMPANY_ID, tables })
  return buildCanonicalAnnualReport(db.supabase as never, BOOKS_COMPANY_ID, 'fp-2025', { ...OPTIONS, stage })
}

const codes = (model: Awaited<ReturnType<typeof build>>) => model.validation.issues.map((issue) => issue.code)

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-02-01T10:00:00Z'))
})
afterEach(() => {
  vi.useRealTimers()
})

describe('årsredovisning of a year not closed yet', () => {
  it('shows the statements the close books, and no false balance errors', async () => {
    const closed = await build(reportBooks('aktiebolag'))
    const open = await build(beforeClose(reportBooks('aktiebolag')))

    expect(open.report.resultatrakning).toEqual(closed.report.resultatrakning)
    expect(open.report.balansrakning).toEqual(closed.report.balansrakning)
    expect(open.report.balansrakning.total_assets).toBe(open.report.balansrakning.total_equity_liabilities)
    expect(open.report.forvaltningsberattelse.resultatdisposition_amounts).toEqual(
      closed.report.forvaltningsberattelse.resultatdisposition_amounts,
    )
    expect(open.report.equity_specification?.current.totals).toEqual(closed.report.equity_specification?.current.totals)
    expect(open.report.equity_specification?.integrity_issues).toEqual([])

    expect(codes(open)).not.toContain('AR-BALANCE-MISMATCH')
    expect(codes(open)).not.toContain('AR-RESULT-MISMATCH')
    expect(codes(open)).not.toContain('AR-EQUITY-SPECIFICATION-MISMATCH')
    expect(codes(open)).not.toContain('AR-IXBRL-STATEMENT-MISMATCH')
    const notClosed = open.validation.issues.find((issue) => issue.code === 'AR-YEAR-NOT-CLOSED')
    expect(notClosed?.severity).toBe('warning')
    // Honest about what the close and the bokslut entries still change.
    expect(notClosed?.message).toContain('preliminära')
    expect(notClosed?.message).toContain('bokslutstransaktioner som inte är bokförda')
    expect(notClosed?.message).toContain('utländsk valuta')
    // Exact in öre; the statements show it in whole kronor.
    expect(Math.round(open.report.result_pending_close?.result ?? 0)).toBe(
      open.report.resultatrakning.find((row) => row.semantic_key === 'income_statement_result')?.current,
    )
  })

  it('cannot be locked for signing until the close is booked', async () => {
    const open = await build(beforeClose(reportBooks('aktiebolag')), 'signing')
    const notClosed = open.validation.issues.find((issue) => issue.code === 'AR-YEAR-NOT-CLOSED')
    expect(notClosed?.severity).toBe('error')
    expect(open.validation.ok).toBe(false)
  })

  it('reads a closed year as booked: nothing derived, nothing said', async () => {
    const closed = await build(reportBooks('aktiebolag'))
    expect(closed.report.result_pending_close).toBeUndefined()
    expect(codes(closed)).not.toContain('AR-YEAR-NOT-CLOSED')
  })
})

describe('the framework the report is built under', () => {
  it('a company default is not a confirmed choice for the year', async () => {
    const model = await build(reportBooks('aktiebolag'))
    expect(model.report.accounting_framework).toBe('k2')
    expect(model.framework_source).toBe('company_fallback')
    expect(model.framework_confirmed).toBe(false)
  })

  it('an election for the year is', async () => {
    const tables = reportBooks('aktiebolag')
    const model = await build({
      ...tables,
      fiscal_period_frameworks: [
        { company_id: BOOKS_COMPANY_ID, fiscal_period_id: 'fp-2025', framework: 'k2', source: 'election' },
      ],
    })
    expect(model.framework_source).toBe('election')
    expect(model.framework_confirmed).toBe(true)
  })
})

describe('the aktiekapital note against the aktiebok', () => {
  /** An aktiebok whose shares were all issued at the formation. */
  const register = (shares: number): LedgerRow[] => [
    {
      id: 'ev-1',
      company_id: BOOKS_COMPANY_ID,
      event_number: 1,
      event_date: '2020-01-10',
      kind: 'bildande',
      share_class_id: 'class-a',
      to_party_id: 'party-1',
      range_start: 1,
      range_end: shares,
      created_at: '2020-01-10T10:00:00Z',
    },
  ]
  const MISMATCH = 'AR-SHARE-COUNT-REGISTER-MISMATCH'

  it('warns when the settings (250 shares, what the note prints) and the aktiebok disagree', async () => {
    const model = await build({ ...reportBooks('aktiebolag'), share_register_events: register(500) })
    const issue = model.validation.issues.find((i) => i.code === MISMATCH)
    expect(issue?.severity).toBe('warning')
    expect(issue?.message).toContain('(250)')
    expect(issue?.message).toContain('(500)')
  })

  it('says nothing when they agree, or when no aktiebok is kept here', async () => {
    const agree = await build({ ...reportBooks('aktiebolag'), share_register_events: register(250) })
    const noRegister = await build(reportBooks('aktiebolag'))
    expect(codes(agree)).not.toContain(MISMATCH)
    expect(codes(noRegister)).not.toContain(MISMATCH)
  })
})
