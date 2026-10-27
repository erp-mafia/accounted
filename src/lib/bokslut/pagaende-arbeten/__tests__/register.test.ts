import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'

vi.mock('@/lib/posting/port', () => ({ postingPort: { postJournalEntry: vi.fn() } }))
vi.mock('@/lib/reports/trial-balance', () => ({ generateTrialBalance: vi.fn() }))
vi.mock('@/lib/reports/vat-revenue-accounts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/reports/vat-revenue-accounts')>()),
  fetchDynamicVatAccounts: vi.fn(),
}))

import { postingPort } from '@/lib/posting/port'
import { generateTrialBalance } from '@/lib/reports/trial-balance'
import { fetchDynamicVatAccounts } from '@/lib/reports/vat-revenue-accounts'
import {
  ContractRevenueError,
  bookContractRevenueYear,
  previewContractRevenueYear,
  saveContractRevenueSettings,
  type ContractRow,
} from '../register'

const contract = (overrides: Partial<ContractRow> = {}): ContractRow => ({
  id: 'c1',
  company_id: 'company-1',
  name: 'Ombyggnad',
  kind: 'fast_pris',
  figures_as_of: '2026-12-31',
  contract_value: '1000000.00',
  expected_total_cost: '800000.00',
  costs_to_date: '400000.00',
  billed_to_date: '300000.00',
  retained_amounts: '0',
  reliable_outcome: true,
  grade_method: 'utgifter',
  stated_grade: null,
  reimbursable_costs: null,
  value_worked: null,
  substantially_complete: false,
  ...overrides,
})

const SETTINGS = { method: 'successiv', revenue_account: '3090' }
const PERIOD = { id: 'period-1', period_end: '2026-12-31' }
const chartRow = (overrides: Record<string, unknown> = {}) => ({
  account_number: '3090',
  account_name: 'Förändring upparbetad intäkt',
  account_class: 3,
  default_vat_rate: null,
  default_vat_treatment: null,
  vat_box: null,
  ...overrides,
})

let mock: ReturnType<typeof createQueuedMockSupabase>

beforeEach(() => {
  vi.clearAllMocks()
  mock = createQueuedMockSupabase()
  vi.mocked(postingPort.postJournalEntry).mockResolvedValue({ id: 'entry-1' } as never)
  vi.mocked(generateTrialBalance).mockResolvedValue({ rows: [] } as never)
  vi.mocked(fetchDynamicVatAccounts).mockResolvedValue({ explicitAccounts: new Set(), mappingByAccount: new Map() } as never)
})

describe('saveContractRevenueSettings', () => {
  const save = (account = '3090') =>
    saveContractRevenueSettings(mock.supabase as never, 'company-1', 'user-1', { method: 'successiv', revenue_account: account })

  it('refuses an account missing from the chart', async () => {
    mock.enqueue({ data: null })
    await expect(save()).rejects.toMatchObject({ code: 'CONTRACT_REVENUE_ACCOUNT_MISSING' })
  })

  it('refuses an account a momsruta reads: the fixed map, a momskod, a momssats, inference', async () => {
    for (const row of [
      chartRow({ account_number: '3001' }),
      chartRow({ default_vat_treatment: 'exempt' }),
      chartRow({ default_vat_rate: '0.25' }),
      chartRow({ account_number: '3011', account_name: 'Försäljning 25 % moms' }),
    ]) {
      mock.reset()
      mock.enqueue({ data: row })
      const error = await save(row.account_number as string).catch((e: unknown) => e)
      expect(error, row.account_number as string).toBeInstanceOf(ContractRevenueError)
      expect(error).toMatchObject({ code: 'CONTRACT_REVENUE_ACCOUNT_VAT' })
    }
    expect(mock.findCalls('contract_revenue_settings', 'upsert')).toEqual([])
  })

  it('pins an unconfigured account at momssats 0, then saves the choice', async () => {
    mock.enqueueMany([{ data: chartRow() }, { data: null }, { data: SETTINGS }])
    expect(await save()).toEqual(SETTINGS)
    expect(mock.findCall('chart_of_accounts', 'update')).toEqual([{ default_vat_rate: 0 }])
    expect(mock.findCall('contract_revenue_settings', 'upsert')?.[0]).toEqual({
      company_id: 'company-1',
      user_id: 'user-1',
      method: 'successiv',
      revenue_account: '3090',
    })
  })

  it('keeps an account already at momssats 0 as it is', async () => {
    mock.enqueueMany([{ data: chartRow({ default_vat_rate: '0' }) }, { data: SETTINGS }])
    await save()
    expect(mock.findCalls('chart_of_accounts', 'update')).toEqual([])
  })
})

describe('bookContractRevenueYear', () => {
  const book = () => bookContractRevenueYear(mock.supabase as never, 'company-1', 'user-1', 'period-1')

  it('is refused before a method and account are chosen', async () => {
    mock.enqueue({ data: null })
    await expect(book()).rejects.toMatchObject({ code: 'CONTRACT_REVENUE_NOT_CONFIGURED' })
  })

  it('is refused for a financial year outside the company', async () => {
    mock.enqueueMany([{ data: SETTINGS }, { data: null }])
    await expect(book()).rejects.toMatchObject({ code: 'CONTRACT_REVENUE_NO_PERIOD' })
  })

  it('refuses figures stated for another day than balansdagen', async () => {
    mock.enqueueMany([{ data: SETTINGS }, { data: PERIOD }, { data: [contract({ figures_as_of: '2025-12-31' })] }])
    await expect(book()).rejects.toMatchObject({
      code: 'CONTRACT_REVENUE_FIGURES_DATE',
      details: { balansdag: '2026-12-31', contracts: ['Ombyggnad'] },
    })
    expect(postingPort.postJournalEntry).not.toHaveBeenCalled()
  })

  it('refuses an uppdrag with an open issue and books nothing', async () => {
    mock.enqueueMany([
      { data: SETTINGS },
      { data: PERIOD },
      { data: [contract({ grade_method: 'fysisk', stated_grade: null })] },
    ])
    await expect(book()).rejects.toMatchObject({ code: 'CONTRACT_REVENUE_INCOMPLETE' })
    expect(postingPort.postJournalEntry).not.toHaveBeenCalled()
  })

  it('books the change on balansdagen against the pinned account', async () => {
    mock.enqueueMany([{ data: SETTINGS }, { data: PERIOD }, { data: [contract()] }])
    const { entry, result } = await book()
    expect(entry).toEqual({ id: 'entry-1' })
    // 400 000 of 800 000 done: half of 1 000 000 earned, 300 000 invoiced.
    expect(result.positions[0]).toMatchObject({ upparbetad_intakt: 500_000, netto: 200_000 })
    const call = vi.mocked(postingPort.postJournalEntry).mock.calls[0][0]
    expect(call.input).toMatchObject({ entry_date: '2026-12-31', source_type: 'year_end', fiscal_period_id: 'period-1' })
    expect(call.input.lines).toEqual([
      expect.objectContaining({ account_number: '1620', debit_amount: 200_000 }),
      expect.objectContaining({ account_number: '3090', credit_amount: 200_000 }),
    ])
  })
})

describe('previewContractRevenueYear', () => {
  it('shows the positions, the lines and the uppdrag stated for another day without booking', async () => {
    mock.enqueueMany([
      { data: SETTINGS },
      { data: PERIOD },
      { data: [contract(), contract({ id: 'c2', name: 'Tak', figures_as_of: '2025-12-31' })] },
    ])
    const preview = await previewContractRevenueYear(mock.supabase as never, 'company-1', 'period-1')
    expect(preview.balansdag).toBe('2026-12-31')
    expect(preview.positions).toHaveLength(2)
    expect(preview.stated_on_other_day).toEqual(['Tak'])
    expect(postingPort.postJournalEntry).not.toHaveBeenCalled()
  })
})
