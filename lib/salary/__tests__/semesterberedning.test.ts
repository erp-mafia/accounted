/**
 * Semesterberedning + semesterårsavslut (payroll gap-closure 3.3).
 *
 * Table-driven beredning math (min-20 floor, 5-year expiry, proration) and
 * the SEK reconcile + commit flow with mocked trial balance / engine.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createQueuedMockSupabase } from '@/tests/helpers'

const mockTrialBalance = vi.fn()
vi.mock('@/lib/reports/trial-balance', () => ({
  generateTrialBalance: (...a: unknown[]) => mockTrialBalance(...a),
}))

const mockSync = vi.fn()
vi.mock('@/lib/salary/vacation-ledger', async () => {
  const actual = await vi.importActual<typeof import('@/lib/salary/vacation-ledger')>(
    '@/lib/salary/vacation-ledger',
  )
  return {
    ...actual,
    getVacationYearBasis: vi.fn().mockResolvedValue('calendar'),
    syncVacationLedgerForEmployees: (...a: unknown[]) => mockSync(...a),
  }
})

const mockCreateJournalEntry = vi.fn()
vi.mock('@/lib/bookkeeping/engine', () => ({
  createJournalEntry: (...a: unknown[]) => mockCreateJournalEntry(...a),
}))

const mockCheckPeriodLock = vi.fn()
vi.mock('@/lib/api/v1/check-period-lock', () => ({
  checkPeriodLock: (...a: unknown[]) => mockCheckPeriodLock(...a),
}))

// Only decryption is mocked ('mock_born_YYYY' resolves to a mid-year birth
// in YYYY); the age-tier math runs the real calculateAgeAtYearStart.
vi.mock('@/lib/salary/personnummer', async () => {
  const actual = await vi.importActual<typeof import('@/lib/salary/personnummer')>(
    '@/lib/salary/personnummer',
  )
  return {
    ...actual,
    decryptPersonnummer: (encrypted: string) => {
      const m = /^mock_born_(\d{4})$/.exec(encrypted)
      if (!m) throw new Error('not an encrypted fixture')
      return `${m[1]}06151234`
    },
  }
})

import { previewVacationYearClose, commitVacationYearClose } from '@/lib/salary/semesterberedning'

const COMPANY_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const EMPLOYEE_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'

const ROSTER_ROW = {
  id: EMPLOYEE_ID,
  first_name: 'Anna',
  last_name: 'Andersson',
  vacation_rule: 'sammaloneregeln',
  vacation_days_per_year: 25,
  salary_type: 'monthly',
  monthly_salary: 30000,
  hourly_rate: null,
  hours_per_week: 40,
  workdays_per_week: 5,
  employment_start: '2024-01-01',
  employment_end: null,
}

let mock: ReturnType<typeof createQueuedMockSupabase>
let supabase: SupabaseClient

beforeEach(() => {
  vi.clearAllMocks()
  mock = createQueuedMockSupabase()
  supabase = mock.supabase as unknown as SupabaseClient
  mockSync.mockResolvedValue({ ok: true })
  mockCheckPeriodLock.mockResolvedValue({ locked: false })
  mockTrialBalance.mockResolvedValue({
    rows: [
      { account_number: '2920', closing_credit: 10000, closing_debit: 0 },
      { account_number: '2940', closing_credit: 3142, closing_debit: 0 },
    ],
    totalDebit: 0,
    totalCredit: 0,
    isBalanced: true,
  })
})

/** Queue the preview's supabase calls: closure check, roster, ledger rows,
 * fiscal period (for the booked-balance read). */
function queuePreview(over: {
  ledger?: Array<Record<string, unknown>>
  closure?: { id: string } | null
} = {}) {
  mock.enqueue({ data: over.closure ?? null }) // vacation_year_closures check
  mock.enqueue({ data: [ROSTER_ROW] }) // roster
  mock.enqueue({ data: over.ledger ?? [] }) // ledger rows for the closing year
  mock.enqueue({ data: { id: 'fp-2025', period_start: '2025-01-01', period_end: '2025-12-31' } }) // fiscal period
}

describe('previewVacationYearClose: beredning math', () => {
  it('rolls only days above the 20-day floor and flags the rest', async () => {
    queuePreview({
      ledger: [
        {
          id: 'vb-1',
          employee_id: EMPLOYEE_ID,
          vacation_year_start: '2025-01-01',
          entitled_days: 25,
          accrued_days: 0,
          taken_days: 15,
          saved_days: {},
          forced_payout_days: 0,
          status: 'open',
        },
      ],
    })

    const result = await previewVacationYearClose(supabase, COMPANY_ID, '2025-01-01')
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const row = result.data.rows[0]
    // remaining 10, but only entitled - 20 = 5 are saveable.
    expect(row.remaining_days).toBe(10)
    expect(row.saveable_days).toBe(5)
    expect(row.untaken_below_floor_days).toBe(5)
    expect(row.saved_days_after).toEqual({ '2025': 5 })
    expect(row.next_year_entitled).toBe(25)
  })

  it('expires saved days older than 5 years into forced payout', async () => {
    queuePreview({
      ledger: [
        {
          id: 'vb-1',
          employee_id: EMPLOYEE_ID,
          vacation_year_start: '2025-01-01',
          entitled_days: 25,
          accrued_days: 0,
          taken_days: 25,
          // 2020 was saveable through 2025: expires at THIS close.
          saved_days: { '2020': 3, '2022': 2 },
          forced_payout_days: 0,
          status: 'open',
        },
      ],
    })

    const result = await previewVacationYearClose(supabase, COMPANY_ID, '2025-01-01')
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const row = result.data.rows[0]
    expect(row.expiring_days).toBe(3)
    expect(row.saved_days_after).toEqual({ '2022': 2 })
  })

  it('computes the SEK drift against the booked 2920/2940', async () => {
    queuePreview({
      ledger: [
        {
          id: 'vb-1',
          employee_id: EMPLOYEE_ID,
          vacation_year_start: '2025-01-01',
          entitled_days: 25,
          accrued_days: 0,
          taken_days: 15,
          saved_days: { '2023': 2 },
          forced_payout_days: 0,
          status: 'open',
        },
      ],
    })

    const result = await previewVacationYearClose(supabase, COMPANY_ID, '2025-01-01')
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const { sek, rows } = result.data
    // Day value sammalöneregeln: 30000/21 + 30000 x 0.0043 = 1428.57 + 129 = 1557.57.
    expect(rows[0].day_value_sek).toBe(1557.57)
    // Liability days = remaining 10 + saved 2 = 12.
    expect(rows[0].computed_liability_sek).toBe(18690.84)
    expect(sek.computed_liability).toBe(18690.84)
    expect(sek.booked_2920).toBe(10000)
    expect(sek.drift_2920).toBe(8690.84)
    expect(sek.adjustment_needed).toBe(true)
  })

  it('applies per-employee age-tier avgifter to the 2940 target', async () => {
    const EMPLOYEE_2 = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
    const EMPLOYEE_3 = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
    const ledgerRow = (employeeId: string) => ({
      id: `vb-${employeeId}`,
      employee_id: employeeId,
      vacation_year_start: '2025-01-01',
      entitled_days: 25,
      accrued_days: 0,
      taken_days: 15,
      saved_days: {},
      forced_payout_days: 0,
      status: 'open',
    })
    mock.enqueue({ data: null }) // closure check
    mock.enqueue({
      data: [
        { ...ROSTER_ROW, personnummer: 'mock_born_1990' },
        { ...ROSTER_ROW, id: EMPLOYEE_2, first_name: 'Sven', personnummer: 'mock_born_1957' },
        { ...ROSTER_ROW, id: EMPLOYEE_3, first_name: 'Ulla', personnummer: 'mock_born_1935' },
      ],
    }) // roster
    mock.enqueue({
      data: [ledgerRow(EMPLOYEE_ID), ledgerRow(EMPLOYEE_2), ledgerRow(EMPLOYEE_3)],
    }) // ledger rows
    mock.enqueue({ data: { id: 'fp-2025', period_start: '2025-01-01', period_end: '2025-12-31' } })

    const result = await previewVacationYearClose(supabase, COMPANY_ID, '2025-01-01')
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const { rows, sek } = result.data

    // Settlement year 2026: born 1990 standard, born 1957 fyllt 67 vid
    // årets ingång (10.21%), born 1935 exempt (0%).
    expect(rows.map((r) => r.avgifter_rate)).toEqual([0.3142, 0.1021, 0])
    // Each employee: 10 remaining days x 1557.57 = 15 575.70 liability.
    // 15575.70 x 0.3142 = 4893.88, 15575.70 x 0.1021 = 1590.28, exempt 0.
    expect(sek.computed_avgifter).toBe(6484.16)
    expect(sek.drift_2940).toBe(3342.16)
  })

  it('refuses to close a year that has not ended', async () => {
    const currentYear = new Date().getFullYear()
    const result = await previewVacationYearClose(supabase, COMPANY_ID, `${currentYear}-01-01`)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('VACATION_YEAR_NOT_ENDED')
  })

  it('refuses to preview an already-closed year', async () => {
    queuePreview({ closure: { id: 'closure-1' } })
    const result = await previewVacationYearClose(supabase, COMPANY_ID, '2025-01-01')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('VACATION_YEAR_ALREADY_CLOSED')
  })
})

describe('commitVacationYearClose', () => {
  function queueCommitAfterPreview() {
    mock.enqueue({ data: { id: 'closure-1' } }) // closure insert
    mock.enqueue({ data: null }) // ledger close update
    mock.enqueue({ data: null }) // next-year upsert
    mock.enqueue({ data: { id: 'fp-2025' } }) // fiscal period for adjustment
    mock.enqueue({ data: null }) // closure update with entry id
  }

  it('closes the year, rolls balances, and books the drift adjustment', async () => {
    queuePreview({
      ledger: [
        {
          id: 'vb-1',
          employee_id: EMPLOYEE_ID,
          vacation_year_start: '2025-01-01',
          entitled_days: 25,
          accrued_days: 0,
          taken_days: 15,
          saved_days: {},
          forced_payout_days: 0,
          status: 'open',
        },
      ],
    })
    queueCommitAfterPreview()
    mockCreateJournalEntry.mockResolvedValue({ id: 'je-adjust-1' })

    const result = await commitVacationYearClose(supabase, COMPANY_ID, 'user-1', '2025-01-01', {
      bookAdjustment: true,
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.data.closure_id).toBe('closure-1')
    expect(result.data.adjustment_entry_id).toBe('je-adjust-1')

    // The adjustment entry goes through the bookkeeping engine with balanced
    // 7290/2920 + 7519/2940 legs.
    const input = mockCreateJournalEntry.mock.calls[0][3] as {
      entry_date: string
      source_type: string
      lines: Array<{ account_number: string; debit_amount: number; credit_amount: number }>
    }
    expect(input.entry_date).toBe('2025-12-31')
    expect(input.source_type).toBe('salary_payment')
    const totalDebit = input.lines.reduce((s, l) => s + l.debit_amount, 0)
    const totalCredit = input.lines.reduce((s, l) => s + l.credit_amount, 0)
    expect(totalDebit).toBeCloseTo(totalCredit, 2)
    expect(input.lines.map((l) => l.account_number).sort()).toEqual(['2920', '2940', '7290', '7519'])
  })

  it('fails cleanly when the adjustment period is locked (before any writes)', async () => {
    queuePreview({
      ledger: [
        {
          id: 'vb-1',
          employee_id: EMPLOYEE_ID,
          vacation_year_start: '2025-01-01',
          entitled_days: 25,
          accrued_days: 0,
          taken_days: 15,
          saved_days: {},
          forced_payout_days: 0,
          status: 'open',
        },
      ],
    })
    mockCheckPeriodLock.mockResolvedValue({ locked: true, reason: 'period_closed' })

    const result = await commitVacationYearClose(supabase, COMPANY_ID, 'user-1', '2025-01-01', {
      bookAdjustment: true,
    })

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('PERIOD_LOCKED')
    expect(mockCreateJournalEntry).not.toHaveBeenCalled()
  })

  it('maps a closure-insert conflict to VACATION_YEAR_ALREADY_CLOSED (replay)', async () => {
    queuePreview({
      ledger: [
        {
          id: 'vb-1',
          employee_id: EMPLOYEE_ID,
          vacation_year_start: '2025-01-01',
          entitled_days: 25,
          accrued_days: 0,
          taken_days: 25,
          saved_days: {},
          forced_payout_days: 0,
          status: 'open',
        },
      ],
    })
    mock.enqueue({ data: null, error: { code: '23505', message: 'duplicate' } }) // closure insert races

    const result = await commitVacationYearClose(supabase, COMPANY_ID, 'user-1', '2025-01-01', {
      bookAdjustment: false,
    })

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('VACATION_YEAR_ALREADY_CLOSED')
  })
})
