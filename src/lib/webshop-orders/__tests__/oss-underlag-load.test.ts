import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createTableMockSupabase } from '@/tests/helpers'

const fetchEcbEuroRate = vi.fn()
vi.mock('@/lib/currency/ecb', () => ({
  fetchEcbEuroRate: (...args: unknown[]) => fetchEcbEuroRate(...args),
}))

import { generateOssUnderlag, getOssUnderlag } from '../oss-underlag'

type Chain = Array<{ method: string; args: unknown[] }>

const inArg = (chain: Chain, column: string): unknown[] | undefined =>
  chain.find((call) => call.method === 'in' && call.args[0] === column)?.args[1] as unknown[] | undefined
const eqArg = (chain: Chain, column: string): unknown =>
  chain.find((call) => call.method === 'eq' && call.args[0] === column)?.args[1]

const ORDER = {
  id: 'o1',
  platform: 'shopify',
  row_type: 'order',
  parent_order_id: null,
  order_number: '#1001',
  customer_country: 'DE',
  currency: 'SEK',
  exchange_rate: 1,
  vat_breakdown: [{ rate: 19, net: 1000, tax: 190 }],
  journal_entry_id: 'e1',
  manually_booked_journal_entry_id: null,
  manually_booked_at: null,
  invoice_id: null,
  legacy_transaction_id: null,
  is_paid: true,
  paid_date: '2026-08-15',
  order_date: '2026-08-15',
}

// A refund in Q3 of a sale booked in Q2.
const REFUND = {
  ...ORDER,
  id: 'r1',
  row_type: 'refund',
  parent_order_id: 'o0',
  order_number: '#1000',
  vat_breakdown: [{ rate: 19, net: 200, tax: 38 }],
  journal_entry_id: 'e2',
}

const ENTRIES = [
  {
    id: 'e1', voucher_series: 'A', voucher_number: 11, entry_date: '2026-08-15', description: 'Order #1001',
    status: 'posted', source_type: 'webshop_order', source_id: 'o1', reverses_id: null, correction_of_id: null,
    lines: [
      { id: 'l1', account_number: '2670', debit_amount: 0, credit_amount: 190 },
      { id: 'l2', account_number: '3106', debit_amount: 0, credit_amount: 1000 },
    ],
  },
  {
    id: 'e2', voucher_series: 'A', voucher_number: 12, entry_date: '2026-08-20', description: 'Retur #1000',
    status: 'posted', source_type: 'webshop_order', source_id: 'r1', reverses_id: null, correction_of_id: null,
    lines: [
      { id: 'l3', account_number: '2670', debit_amount: 38, credit_amount: 0 },
      { id: 'l4', account_number: '3106', debit_amount: 200, credit_amount: 0 },
    ],
  },
]

function mockSupabase(entriesAnswer: { data?: unknown; error?: unknown }) {
  const mock = createTableMockSupabase({
    chart_of_accounts: { data: [{ account_number: '3106' }] },
    webshop_store_settings: { data: [{ country_account_rules: [] }] },
    'rpc:get_entries_with_account_lines': entriesAnswer,
    webshop_orders: (chain: Chain) => {
      if (inArg(chain, 'journal_entry_id')) return { data: [ORDER, REFUND] }
      if (inArg(chain, 'manually_booked_journal_entry_id')) return { data: [] }
      if (inArg(chain, 'id')) return { data: [{ id: 'o0', journal_entry_id: 'e0', manually_booked_journal_entry_id: null }] }
      if (eqArg(chain, 'platform') === 'shopify') return { data: [] }
      return { data: [] }
    },
    journal_entries: (chain: Chain) => {
      if (inArg(chain, 'id')) return { data: [{ id: 'e0', entry_date: '2026-05-10' }] }
      // The paged fallback read of the quarter's verifikat.
      return {
        data: ENTRIES.map(({ lines, ...entry }) => ({
          ...entry,
          journal_entry_lines: lines.map(({ account_number, debit_amount, credit_amount }) => ({ account_number, debit_amount, credit_amount })),
        })),
      }
    },
    journal_entry_lines: { data: [{ id: 'l0', journal_entry_id: 'e0' }] },
  })
  return mock
}

const LOG = { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() }

beforeEach(() => {
  vi.clearAllMocks()
  fetchEcbEuroRate.mockImplementation(async (currency: string, date: string) => ({
    ok: true,
    rate: { currency, rate: date === '2026-09-30' ? 11.331 : 10.9, date },
  }))
})

describe('generateOssUnderlag', () => {
  it('reads the quarter\'s OSS verifikat, their orders and the refunded orders\' quarters, and converts at the ECB rates', async () => {
    const { supabase, findCall } = mockSupabase({ data: ENTRIES })

    const result = await generateOssUnderlag(supabase as never, 'company-1', 2026, 3)

    expect(findCall('rpc:get_entries_with_account_lines', 'rpc')?.[0]).toEqual({
      p_company_id: 'company-1',
      p_start: '2026-07-01',
      p_end: '2026-09-30',
      p_accounts: ['2670', '3106'],
      p_statuses: ['posted', 'reversed'],
      p_all_lines: false,
    })
    expect(result.rows).toEqual([
      { country: 'DE', vat_rate: 19, net_eur: 88.25, vat_eur: 16.77, net_sek: 1000, vat_sek: 190, order_count: 1 },
    ])
    expect(result.corrections).toEqual([
      // -38 / 10.9 at the Q2 rate.
      { country: 'DE', period: { year: 2026, quarter: 2, label: 'Q2 2026' }, vat_eur: -3.49, vat_sek: -38, refund_count: 1 },
    ])
    expect(result.ledger_vat_sek).toBe(152)
    expect(result.unaccounted).toEqual([])
    expect(fetchEcbEuroRate.mock.calls).toEqual([
      ['SEK', '2026-06-30'],
      ['SEK', '2026-09-30'],
    ])
  })

  it('reads the same verifikat the paged way on a database without get_entries_with_account_lines', async () => {
    const { supabase, findCalls } = mockSupabase({ data: null, error: { code: 'PGRST202', message: 'not found' } })

    const result = await generateOssUnderlag(supabase as never, 'company-1', 2026, 3)

    expect(findCalls('journal_entries', 'select').map((args) => String(args[0]))).toContainEqual(
      expect.stringContaining('journal_entry_lines!inner'),
    )
    expect(result.rows).toHaveLength(1)
    expect(result.corrections).toHaveLength(1)
  })

  it('looks for the quarter\'s unbooked EU orders among Shopify rows to other EU countries', async () => {
    const { supabase, findCalls } = mockSupabase({ data: ENTRIES })

    await generateOssUnderlag(supabase as never, 'company-1', 2026, 3)

    const countries = findCalls('webshop_orders', 'in').find((args) => args[0] === 'customer_country')?.[1] as string[]
    expect(countries).toContain('DE')
    expect(countries).not.toContain('SE')
    // Paid in the quarter, or (unpaid) ordered in it.
    expect(findCalls('webshop_orders', 'gte')).toEqual([['paid_date', '2026-07-01'], ['order_date', '2026-07-01']])
    expect(findCalls('webshop_orders', 'lte')).toEqual([['paid_date', '2026-09-30'], ['order_date', '2026-09-30']])
    expect(findCalls('webshop_orders', 'is')).toEqual([['paid_date', null]])
  })
})

describe('getOssUnderlag', () => {
  it('answers OSS_UNDERLAG_FAILED when the ledger cannot be read', async () => {
    const { supabase } = mockSupabase({ data: null, error: { code: '57014', message: 'canceling statement due to statement timeout' } })

    const outcome = await getOssUnderlag(
      { supabase: supabase as never, companyId: 'company-1', userId: 'user-1', log: LOG as never },
      { year: 2026, quarter: 3 },
    )

    expect(outcome).toMatchObject({ ok: false, code: 'OSS_UNDERLAG_FAILED' })
    expect(LOG.error).toHaveBeenCalled()
  })
})
