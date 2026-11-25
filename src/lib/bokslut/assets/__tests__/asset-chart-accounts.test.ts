/**
 * crm#1452: a register row may not point at an account the company's chart
 * lacks, and the category default follows the company's own chart.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createQueuedMockSupabase } from '@/tests/helpers'
import { AccountsNotInChartError } from '@/lib/bookkeeping/errors'
import {
  chartAwareDefaultAccounts,
  ensureAssetAccountsInChart,
  ensureCompanyImpairmentAccount,
  unusableAssetAccounts,
} from '../asset-chart-accounts'
import { createAsset, DEFAULT_ACCOUNTS_BY_CATEGORY, updateAsset } from '../asset-service'
import { checkCreateAssetGates } from '../asset-api'

// The year's framework (frameworkOnDate): K2 for these cases.
const frameworkOnDateMock = vi.hoisted(() => vi.fn(async () => 'k2'))
vi.mock('@/lib/bokslut/framework-for-year', () => ({
  frameworkOnDate: frameworkOnDateMock,
  frameworkForYear: vi.fn(async () => 'k2'),
}))
vi.mock('@/lib/company/accounting-framework', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/company/accounting-framework')>()),
  frameworkOnDate: frameworkOnDateMock,
}))
vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}))

const COMPANY = 'company-1'
const USER = 'user-1'
const COMPUTER = DEFAULT_ACCOUNTS_BY_CATEGORY.computer // 1224 / 1229 / 7832
const LEGACY = { bas_asset_account: '1250', bas_accumulated_account: '1259', bas_expense_account: '7835' }

function chartRows(active: string[], inactive: string[] = []) {
  return [
    ...active.map((account_number) => ({ account_number, is_active: true })),
    ...inactive.map((account_number) => ({ account_number, is_active: false })),
  ]
}

let mock: ReturnType<typeof createQueuedMockSupabase>
let supabase: SupabaseClient

beforeEach(() => {
  vi.clearAllMocks()
  mock = createQueuedMockSupabase()
  supabase = mock.supabase as unknown as SupabaseClient
})

describe('chartAwareDefaultAccounts', () => {
  it('keeps the BAS 2026 default when the chart has all three accounts', async () => {
    mock.enqueue({ data: [LEGACY] }) // an earlier computer on the old accounts
    mock.enqueue({ data: chartRows(['1224', '1229', '7832', '1250', '1259', '7835']) })
    await expect(chartAwareDefaultAccounts(supabase, COMPANY, 'computer', COMPUTER)).resolves.toEqual(COMPUTER)
  })

  it('follows an earlier asset of the category when the default is not in the chart', async () => {
    mock.enqueue({ data: [LEGACY] })
    mock.enqueue({ data: chartRows(['1229', '7832', '1250', '1259', '7835']) })
    await expect(chartAwareDefaultAccounts(supabase, COMPANY, 'computer', COMPUTER)).resolves.toEqual({
      asset: '1250',
      accumulated: '1259',
      expense: '7835',
    })
  })

  it('falls back to the default when no earlier asset sits on active accounts', async () => {
    mock.enqueue({ data: [LEGACY] })
    mock.enqueue({ data: chartRows(['1229', '7832', '1250', '1259'], ['7835']) })
    await expect(chartAwareDefaultAccounts(supabase, COMPANY, 'computer', COMPUTER)).resolves.toEqual(COMPUTER)
  })

  it('leaves the framework-driven intangible default alone', async () => {
    const defaults = { asset: '1090', accumulated: '1099', expense: '7810' }
    await expect(chartAwareDefaultAccounts(supabase, COMPANY, 'immaterial', defaults)).resolves.toBe(defaults)
    expect(mock.supabase.from).not.toHaveBeenCalled()
  })
})

describe('unusableAssetAccounts', () => {
  it('flags inactive accounts and missing non-BAS numbers, not missing BAS accounts', async () => {
    mock.enqueue({ data: chartRows(['1229'], ['7839']) })
    await expect(
      unusableAssetAccounts(supabase, COMPANY, ['1224', '1229', '7839', '7833']),
    ).resolves.toEqual(['7839', '7833'])
  })
})

describe('ensureAssetAccountsInChart', () => {
  it('adds a missing standard BAS account to the chart', async () => {
    mock.enqueue({ data: chartRows(['1229', '7832']) }) // chart state
    mock.enqueue({ data: [] }) // backfill: nothing exists yet
    mock.enqueue({ data: null }) // backfill insert
    await ensureAssetAccountsInChart(supabase, COMPANY, USER, ['1224', '1229', '7832'])
    const insert = mock.findCalls('chart_of_accounts', 'insert')
    expect(insert).toHaveLength(1)
    expect((insert[0][0] as Array<{ account_number: string }>).map((row) => row.account_number)).toEqual(['1224'])
  })

  it('refuses an inactive account without reactivating it', async () => {
    mock.enqueue({ data: chartRows(['1299'], ['1290', '7839']) })
    await expect(
      ensureAssetAccountsInChart(supabase, COMPANY, USER, ['1290', '1299', '7839']),
    ).rejects.toBeInstanceOf(AccountsNotInChartError)
    expect(mock.findCalls('chart_of_accounts', 'insert')).toHaveLength(0)
  })

  it('refuses a missing number that is not a BAS account', async () => {
    mock.enqueue({ data: chartRows(['1250', '1259']) })
    await expect(
      ensureAssetAccountsInChart(supabase, COMPANY, USER, ['1250', '1259', '7833']),
    ).rejects.toMatchObject({ accountNumbers: ['7833'] })
  })
})

describe('ensureCompanyImpairmentAccount', () => {
  it('adds 1128 beside 1129 in the post Förbättringsutgifter på annans fastighet', async () => {
    mock.enqueue({ data: [] }) // chart state: 1128 missing
    mock.enqueue({ data: null }) // upsert
    await ensureCompanyImpairmentAccount(supabase, COMPANY, USER, '1128', '1129')
    const upsert = mock.findCalls('chart_of_accounts', 'upsert')
    expect(upsert).toHaveLength(1)
    expect(upsert[0][0]).toMatchObject({
      company_id: COMPANY,
      account_number: '1128',
      account_name: 'Ackumulerade nedskrivningar på förbättringsutgifter på annans fastighet',
      account_type: 'asset',
      normal_balance: 'credit',
      sru_code: '7216',
      is_active: true,
    })
  })

  it('leaves a standard BAS account to the engine and an active account alone', async () => {
    await ensureCompanyImpairmentAccount(supabase, COMPANY, USER, '1118', '1119')
    mock.enqueue({ data: chartRows(['1128']) })
    await ensureCompanyImpairmentAccount(supabase, COMPANY, USER, '1128', '1129')
    expect(mock.findCalls('chart_of_accounts', 'upsert')).toHaveLength(0)
  })

  it('refuses an inactive account without reactivating it', async () => {
    mock.enqueue({ data: chartRows([], ['1128']) })
    await expect(
      ensureCompanyImpairmentAccount(supabase, COMPANY, USER, '1128', '1129'),
    ).rejects.toMatchObject({ accountNumbers: ['1128'] })
    expect(mock.findCalls('chart_of_accounts', 'upsert')).toHaveLength(0)
  })
})

describe('createAsset against the company chart (crm#1452)', () => {
  const input = {
    name: 'Laptop',
    category: 'computer' as const,
    acquisition_date: '2026-10-01',
    acquisition_cost: 20000,
    useful_life_months: 36,
  }

  it('registers a computer on the company\'s own datorkonton when 1224 is not in its chart', async () => {
    mock.enqueue({ data: [LEGACY] }) // earlier computer asset
    mock.enqueue({ data: chartRows(['1229', '7832', '1250', '1259', '7835']) }) // default resolution
    mock.enqueue({ data: chartRows(['1250', '1259', '7835']) }) // ensure: all present
    mock.enqueue({ data: { id: 'asset-1', ...LEGACY } }) // insert
    await createAsset(supabase, COMPANY, USER, input)
    const [row] = mock.findCall('assets', 'insert') as [Record<string, unknown>]
    expect(row).toMatchObject(LEGACY)
    expect(mock.findCalls('chart_of_accounts', 'insert')).toHaveLength(0)
  })

  it('adds 1224 to the chart before registering the first computer', async () => {
    mock.enqueue({ data: [] }) // no earlier computer
    mock.enqueue({ data: chartRows(['1229', '7832']) }) // default resolution
    mock.enqueue({ data: chartRows(['1229', '7832']) }) // ensure: 1224 missing
    mock.enqueue({ data: [] }) // backfill existing check
    mock.enqueue({ data: null }) // backfill insert
    mock.enqueue({ data: { id: 'asset-1' } }) // asset insert
    await createAsset(supabase, COMPANY, USER, input)
    const [seeded] = mock.findCall('chart_of_accounts', 'insert') as [Array<{ account_number: string }>]
    expect(seeded.map((row) => row.account_number)).toEqual(['1224'])
    const [row] = mock.findCall('assets', 'insert') as [Record<string, unknown>]
    expect(row).toMatchObject({ bas_asset_account: '1224', bas_accumulated_account: '1229', bas_expense_account: '7832' })
  })

  it('writes no register row when an account cannot be used', async () => {
    mock.enqueue({ data: [] })
    mock.enqueue({ data: chartRows(['1224', '1229', '7832']) })
    mock.enqueue({ data: chartRows(['1250', '1259']) }) // ensure: 7833 missing, not BAS
    await expect(
      createAsset(supabase, COMPANY, USER, { ...input, bas_asset_account: '1250', bas_accumulated_account: '1259', bas_expense_account: '7833' }),
    ).rejects.toBeInstanceOf(AccountsNotInChartError)
    expect(mock.findCalls('assets', 'insert')).toHaveLength(0)
  })

  it('holds a K3 component asset to the same chart, before its row is written', async () => {
    const components = [
      { name: 'Chassi', cost: 15000, useful_life_months: 60, salvage_value: 0 },
      { name: 'Skärm', cost: 5000, useful_life_months: 24, salvage_value: 0 },
    ]
    mock.enqueue({ data: [] })
    mock.enqueue({ data: chartRows(['1224', '1229', '7832']) })
    mock.enqueue({ data: chartRows(['1250', '1259']) }) // ensure: 7833 missing, not BAS
    await expect(
      createAsset(supabase, COMPANY, USER, {
        ...input,
        k3_components: components,
        bas_asset_account: '1250',
        bas_accumulated_account: '1259',
        bas_expense_account: '7833',
      }),
    ).rejects.toBeInstanceOf(AccountsNotInChartError)
    expect(mock.findCalls('assets', 'insert')).toHaveLength(0)
    expect(mock.findCalls('asset_components', 'insert')).toHaveLength(0)
  })
})

describe('updateAsset against the company chart (crm#1452)', () => {
  const equipment = {
    id: 'asset-1',
    company_id: COMPANY,
    user_id: USER,
    name: 'Kassaregister',
    category: 'equipment',
    acquisition_date: '2026-01-01',
    acquisition_cost: 30000,
    salvage_value: 0,
    useful_life_months: 60,
    bas_asset_account: '1220',
    bas_accumulated_account: '1229',
    bas_expense_account: '7832',
    k3_components: null,
    components: [],
    disposed_at: null,
  }

  it('refuses moving the row onto an account the chart has deactivated, before the update', async () => {
    mock.enqueue({ data: equipment }) // getAsset
    mock.enqueue({ data: chartRows([], ['1221']) }) // ensure: 1221 inactive
    await expect(updateAsset(supabase, COMPANY, 'asset-1', { bas_asset_account: '1221' })).rejects.toBeInstanceOf(
      AccountsNotInChartError,
    )
    expect(mock.findCalls('assets', 'update')).toHaveLength(0)
  })

  it('adds a missing standard BAS account the row moves onto', async () => {
    mock.enqueue({ data: equipment }) // getAsset
    mock.enqueue({ data: [] }) // ensure: 1221 missing
    mock.enqueue({ data: [] }) // backfill existing check
    mock.enqueue({ data: null }) // backfill insert
    mock.enqueue({ data: { ...equipment, bas_asset_account: '1221' } }) // update
    await updateAsset(supabase, COMPANY, 'asset-1', { bas_asset_account: '1221' })
    const [seeded] = mock.findCall('chart_of_accounts', 'insert') as [Array<{ account_number: string }>]
    expect(seeded.map((row) => row.account_number)).toEqual(['1221'])
    expect(mock.findCalls('assets', 'update')).toHaveLength(1)
  })
})

describe('checkCreateAssetGates: ACCOUNTS_NOT_IN_CHART', () => {
  const body = {
    name: 'Laptop',
    category: 'computer' as const,
    acquisition_date: '2026-10-01',
    acquisition_cost: 20000,
    useful_life_months: 36,
  }

  it('refuses at staging an account the commit would refuse', async () => {
    mock.enqueue({ data: { accounting_framework: 'k2', entity_type: 'aktiebolag' } }) // gate framework
    mock.enqueue({ data: { accounting_framework: 'k2', entity_type: 'aktiebolag' } }) // resolveCreateAccounts
    mock.enqueue({ data: [] }) // earlier computers
    mock.enqueue({ data: chartRows(['1224', '1229'], ['7832']) }) // default resolution
    mock.enqueue({ data: chartRows(['1224', '1229'], ['7832']) }) // unusable check
    const gate = await checkCreateAssetGates(supabase, COMPANY, body)
    expect(gate).toMatchObject({ code: 'ACCOUNTS_NOT_IN_CHART', status: 422, details: { account_numbers: ['7832'] } })
  })

  // F1: the v1 and MCP gates judge the year the asset is acquired in. A
  // company whose next year is K3 still refuses components in its K2 year.
  it('judges the framework of the year the asset is acquired in', async () => {
    const { frameworkOnDate } = await import('@/lib/company/accounting-framework')
    mock.enqueue({ data: { entity_type: 'aktiebolag' } })
    const gate = await checkCreateAssetGates(supabase, COMPANY, {
      ...body,
      k3_components: [{ name: 'Skärm', cost: 20000, useful_life_months: 36 }],
    } as never)
    expect(gate).toMatchObject({ code: 'K3_REQUIRED_FOR_COMPONENTS' })
    expect(frameworkOnDate).toHaveBeenCalledWith(supabase, COMPANY, body.acquisition_date)
  })

  it('passes when the missing default is a BAS account the create will add', async () => {
    mock.enqueue({ data: { accounting_framework: 'k2', entity_type: 'aktiebolag' } })
    mock.enqueue({ data: { accounting_framework: 'k2', entity_type: 'aktiebolag' } })
    mock.enqueue({ data: [] })
    mock.enqueue({ data: chartRows(['1229', '7832']) })
    mock.enqueue({ data: chartRows(['1229', '7832']) })
    await expect(checkCreateAssetGates(supabase, COMPANY, body)).resolves.toBeNull()
  })
})
