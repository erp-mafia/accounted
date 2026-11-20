import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/posting/port', () => ({
  postingPort: { postJournalEntry: vi.fn(), reverseJournalEntry: vi.fn() },
}))
vi.mock('../currency-revaluation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../currency-revaluation')>()),
  previewCurrencyRevaluation: vi.fn(),
  requireFxExposureScope: vi.fn(),
}))

import { postingPort } from '@/lib/posting/port'
import { previewCurrencyRevaluation, requireFxExposureScope, ClosingRateUnavailableError } from '../currency-revaluation'
import {
  MonthlyRevaluationError,
  assertMonthEndInsidePeriod,
  executeMonthlyCurrencyRevaluation,
  isMonthEnd,
} from '../currency-revaluation-monthly'

let enabled = true
let existing = 0

function supabase() {
  return {
    from: vi.fn((table: string) => {
      const builder: Record<string, unknown> = {}
      for (const method of ['select', 'eq', 'in']) builder[method] = () => builder
      builder.maybeSingle = async () => ({ data: table === 'company_settings' ? { fx_revaluation_monthly: enabled } : null, error: null })
      builder.single = async () => ({ data: { period_start: '2026-01-01', period_end: '2026-12-31' }, error: null })
      builder.then = (resolve: (value: unknown) => void) => resolve({ count: existing, error: null })
      return builder
    }),
  } as never
}

const preview = {
  items: [{ type: 'receivable', source_id: 'i1' }],
  lines: [
    { account_number: '1510', debit_amount: 500, credit_amount: 0 },
    { account_number: '3960', debit_amount: 0, credit_amount: 500 },
  ],
  closingRates: { EUR: 11.5 },
  totalGain: 500,
  totalLoss: 0,
  netEffect: 500,
  unconvertedFx: [],
  unconvertedFxCount: 0,
  missingClosingRates: [],
}

beforeEach(() => {
  vi.clearAllMocks()
  enabled = true
  existing = 0
  vi.mocked(requireFxExposureScope).mockResolvedValue('all')
  vi.mocked(previewCurrencyRevaluation).mockResolvedValue(preview as never)
  vi.mocked(postingPort.postJournalEntry).mockResolvedValue({ id: 'reval-1' } as never)
  vi.mocked(postingPort.reverseJournalEntry).mockResolvedValue({ id: 'storno-1' } as never)
})

describe('month ends', () => {
  it('knows a month end and refuses the balansdag and dates outside the year', () => {
    expect(isMonthEnd('2026-02-28')).toBe(true)
    expect(isMonthEnd('2028-02-28')).toBe(false)
    expect(isMonthEnd('2026-06-15')).toBe(false)
    expect(() => assertMonthEndInsidePeriod('2026-06-30', '2026-01-01', '2026-12-31')).not.toThrow()
    expect(() => assertMonthEndInsidePeriod('2026-12-31', '2026-01-01', '2026-12-31')).toThrow(MonthlyRevaluationError)
    expect(() => assertMonthEndInsidePeriod('2025-12-31', '2026-01-01', '2026-12-31')).toThrow(MonthlyRevaluationError)
  })
})

describe('executeMonthlyCurrencyRevaluation', () => {
  it('posts the month-end revaluation and reverses it on the first day of the next month', async () => {
    const result = await executeMonthlyCurrencyRevaluation(supabase(), 'company-1', 'period-1', '2026-06-30', 'user-1')
    expect(result?.entry).toEqual({ id: 'reval-1' })
    expect(result?.reversal).toEqual({ id: 'storno-1' })
    expect(vi.mocked(previewCurrencyRevaluation).mock.calls[0][2]).toBe('2026-06-30')
    expect(vi.mocked(postingPort.postJournalEntry).mock.calls[0][0].input).toMatchObject({
      entry_date: '2026-06-30',
      source_type: 'currency_revaluation',
      lines: preview.lines,
    })
    expect(vi.mocked(postingPort.reverseJournalEntry).mock.calls[0][0]).toMatchObject({
      entryId: 'reval-1',
      reversalDate: '2026-07-01',
      role: 'reversal',
    })
  })

  it('refuses while the option is off, and a second run for the same month end', async () => {
    enabled = false
    await expect(executeMonthlyCurrencyRevaluation(supabase(), 'company-1', 'period-1', '2026-06-30', 'user-1'))
      .rejects.toMatchObject({ code: 'FX_MONTHLY_REVALUATION_NOT_ENABLED' })
    enabled = true
    existing = 1
    await expect(executeMonthlyCurrencyRevaluation(supabase(), 'company-1', 'period-1', '2026-06-30', 'user-1'))
      .rejects.toMatchObject({ code: 'FX_MONTHLY_REVALUATION_EXISTS' })
    expect(postingPort.postJournalEntry).not.toHaveBeenCalled()
  })

  it('refuses rather than estimate a missing rate, and books nothing without open items', async () => {
    vi.mocked(previewCurrencyRevaluation).mockResolvedValueOnce({
      ...preview, missingClosingRates: [{ currency: 'EUR', date: '2026-06-30' }],
    } as never)
    await expect(executeMonthlyCurrencyRevaluation(supabase(), 'company-1', 'period-1', '2026-06-30', 'user-1'))
      .rejects.toBeInstanceOf(ClosingRateUnavailableError)
    vi.mocked(previewCurrencyRevaluation).mockResolvedValueOnce({ ...preview, items: [], lines: [] } as never)
    expect(await executeMonthlyCurrencyRevaluation(supabase(), 'company-1', 'period-1', '2026-06-30', 'user-1')).toBeNull()
    expect(postingPort.postJournalEntry).not.toHaveBeenCalled()
  })
})
