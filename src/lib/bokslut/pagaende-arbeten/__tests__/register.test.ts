import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'

vi.mock('@/lib/posting/port', () => ({ postingPort: { draftJournalEntry: vi.fn(), commitSqlPosting: vi.fn() } }))
vi.mock('@/lib/reports/trial-balance', () => ({ generateTrialBalance: vi.fn() }))
vi.mock('@/lib/reports/vat-revenue-accounts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/reports/vat-revenue-accounts')>()),
  fetchDynamicVatAccounts: vi.fn(),
}))

import { postingPort } from '@/lib/posting/port'
import { generateTrialBalance } from '@/lib/reports/trial-balance'
import { fetchDynamicVatAccounts } from '@/lib/reports/vat-revenue-accounts'
import { ContractRevenueRefusedError } from '@/lib/bookkeeping/errors'
import {
  ContractRevenueError,
  bookContractRevenueYear,
  deleteContractRevenueSettings,
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
/** The year's fiscal_period_frameworks row. */
const yearFramework = (framework: 'k2' | 'k3') => ({ data: { fiscal_period_id: 'period-1', framework, source: 'company_default' } })
const K3 = yearFramework('k3')
/** contract_revenue_register_balances: nothing booked by the register yet. */
const NOTHING_BOOKED = { data: [] }
/** contract_revenue_account_in_use. */
const NOT_IN_USE = { data: false }
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
  vi.mocked(postingPort.draftJournalEntry).mockResolvedValue({ id: 'draft-1', fiscal_period_id: 'period-1' } as never)
  vi.mocked(postingPort.commitSqlPosting).mockResolvedValue({ entry: { id: 'entry-1' } } as never)
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

  it('refuses an account with posted lines outside the register, before pinning it', async () => {
    mock.enqueueMany([{ data: chartRow() }, { data: true }, { data: null }])
    await expect(save()).rejects.toMatchObject({ code: 'CONTRACT_REVENUE_ACCOUNT_IN_USE', details: { account: '3090' } })
    expect(mock.supabase.rpc).toHaveBeenCalledWith('contract_revenue_account_in_use', { p_company_id: 'company-1', p_account: '3090' })
    expect(mock.findCalls('chart_of_accounts', 'update')).toEqual([])
    expect(mock.findCalls('contract_revenue_settings', 'upsert')).toEqual([])
  })

  it('keeps the account the settings already name, whatever else it carries', async () => {
    mock.enqueueMany([{ data: chartRow({ default_vat_rate: '0' }) }, { data: true }, { data: SETTINGS }, { data: SETTINGS }])
    expect(await save()).toEqual(SETTINGS)
  })

  it('answers the database\'s refusal of an account in use as the same error', async () => {
    mock.enqueueMany([
      { data: chartRow({ default_vat_rate: '0' }) },
      NOT_IN_USE,
      { data: null, error: { code: 'PT409', message: 'CONTRACT_REVENUE_ACCOUNT_IN_USE' } },
    ])
    await expect(save()).rejects.toMatchObject({ code: 'CONTRACT_REVENUE_ACCOUNT_IN_USE' })
  })

  it('pins an unconfigured account at momssats 0, then saves the choice', async () => {
    mock.enqueueMany([{ data: chartRow() }, NOT_IN_USE, { data: null }, { data: SETTINGS }])
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
    mock.enqueueMany([{ data: chartRow({ default_vat_rate: '0' }) }, NOT_IN_USE, { data: SETTINGS }])
    await save()
    expect(mock.findCalls('chart_of_accounts', 'update')).toEqual([])
  })
})

describe('deleteContractRevenueSettings', () => {
  it('removes the method and account', async () => {
    mock.enqueue({ data: [{ id: 'settings-1' }] })
    await deleteContractRevenueSettings(mock.supabase as never, 'company-1')
    expect(mock.findCalls('contract_revenue_settings', 'delete')).toHaveLength(1)
  })

  it('answers not configured when there is nothing to remove', async () => {
    mock.enqueue({ data: [] })
    await expect(deleteContractRevenueSettings(mock.supabase as never, 'company-1')).rejects.toMatchObject({
      code: 'CONTRACT_REVENUE_NOT_CONFIGURED',
    })
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

  it('refuses a year not reported under K3 and drafts nothing (K3 kapitel 23)', async () => {
    mock.enqueueMany([{ data: SETTINGS }, { data: PERIOD }, yearFramework('k2'), { data: [contract()] }])
    await expect(book()).rejects.toMatchObject({ code: 'CONTRACT_REVENUE_NOT_K3', details: { framework: 'k2' } })
    expect(postingPort.draftJournalEntry).not.toHaveBeenCalled()
  })

  it('refuses figures stated for another day than balansdagen', async () => {
    mock.enqueueMany([{ data: SETTINGS }, { data: PERIOD }, K3, { data: [contract({ figures_as_of: '2025-12-31' })] }])
    await expect(book()).rejects.toMatchObject({
      code: 'CONTRACT_REVENUE_FIGURES_DATE',
      details: { balansdag: '2026-12-31', contracts: ['Ombyggnad'] },
    })
    expect(postingPort.draftJournalEntry).not.toHaveBeenCalled()
  })

  it('refuses an uppdrag with an open issue and books nothing', async () => {
    mock.enqueueMany([
      { data: SETTINGS },
      { data: PERIOD },
      K3,
      { data: [contract({ grade_method: 'fysisk', stated_grade: null })] },
      NOTHING_BOOKED,
    ])
    await expect(book()).rejects.toMatchObject({ code: 'CONTRACT_REVENUE_INCOMPLETE' })
    expect(postingPort.draftJournalEntry).not.toHaveBeenCalled()
  })

  it('answers the database\'s refusals: not K3, a register changed since (a double click), a later year booked', async () => {
    for (const [reason, code] of [
      ['stale', 'CONTRACT_REVENUE_STALE'],
      ['not_k3', 'CONTRACT_REVENUE_NOT_K3'],
      ['later_year', 'CONTRACT_REVENUE_LATER_YEAR_BOOKED'],
    ] as const) {
      mock.reset()
      mock.enqueueMany([{ data: SETTINGS }, { data: PERIOD }, K3, { data: [contract()] }, NOTHING_BOOKED])
      vi.mocked(postingPort.commitSqlPosting).mockRejectedValueOnce(new ContractRevenueRefusedError(reason))
      await expect(book()).rejects.toMatchObject({ code })
    }
  })

  it('books the change on balansdagen against the pinned account', async () => {
    mock.enqueueMany([{ data: SETTINGS }, { data: PERIOD }, K3, { data: [contract()] }, NOTHING_BOOKED])
    const { entry, result } = await book()
    expect(entry).toEqual({ id: 'entry-1' })
    // 400 000 of 800 000 done: half of 1 000 000 earned, 300 000 invoiced.
    expect(result.positions[0]).toMatchObject({ upparbetad_intakt: 500_000, netto: 200_000 })
    const call = vi.mocked(postingPort.draftJournalEntry).mock.calls[0][0]
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
      K3,
      { data: [contract(), contract({ id: 'c2', name: 'Tak', figures_as_of: '2025-12-31' })] },
      NOTHING_BOOKED,
    ])
    const preview = await previewContractRevenueYear(mock.supabase as never, 'company-1', 'period-1')
    expect(preview.balansdag).toBe('2026-12-31')
    expect(preview.framework).toBe('k3')
    expect(preview.positions).toHaveLength(2)
    expect(preview.stated_on_other_day).toEqual(['Tak'])
    expect(postingPort.draftJournalEntry).not.toHaveBeenCalled()
  })

  it('shows the year\'s framework and what the accounts hold beyond the register', async () => {
    mock.enqueueMany([
      { data: SETTINGS },
      { data: PERIOD },
      yearFramework('k2'),
      { data: [contract()] },
      { data: [{ account_number: '1620', balance: '100000.00' }] },
    ])
    vi.mocked(generateTrialBalance).mockResolvedValue({
      rows: [
        { account_number: '1620', closing_debit: 130_000, closing_credit: 0 },
        { account_number: '2290', closing_debit: 0, closing_credit: 25_000 },
        { account_number: '1930', closing_debit: 999, closing_credit: 0 },
      ],
    } as never)
    const preview = await previewContractRevenueYear(mock.supabase as never, 'company-1', 'period-1')
    expect(preview.framework).toBe('k2')
    expect(preview.unregistered).toEqual([
      { account: '1620', amount: 30_000 },
      { account: '2290', amount: -25_000 },
    ])
    // Only the register's own 100 000 is the base: the adjustment books 100 000 more.
    expect(preview.lines).toEqual([
      expect.objectContaining({ account_number: '1620', debit_amount: 100_000 }),
      expect.objectContaining({ account_number: '3090', credit_amount: 100_000 }),
    ])
  })
})
