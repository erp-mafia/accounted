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
const likeArg = (chain: Chain, column: string): unknown =>
  chain.find((call) => call.method === 'like' && call.args[0] === column)?.args[1]

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

const SHARED_CHART = {
  sales: [{ account_number: '3106', account_name: 'Försäljning varor till annat EU-land, momspliktig', oss_country: null, oss_vat_rate: null }],
  class26: [
    { account_number: '2650', account_name: 'Redovisningskonto för moms', oss_country: null, oss_vat_rate: null },
    { account_number: '2670', account_name: 'Utgående moms på försäljning inom EU, OSS', oss_country: null, oss_vat_rate: null },
  ],
}

function mockSupabase(
  entriesAnswer: { data?: unknown; error?: unknown },
  chart: { sales: unknown[]; class26: unknown[] } = SHARED_CHART,
  linkedEntries: Array<{ id: string; entry_date: string }> = [{ id: 'e0', entry_date: '2026-05-10' }],
  rules: unknown[] = [],
) {
  const mock = createTableMockSupabase({
    chart_of_accounts: (chain: Chain) =>
      likeArg(chain, 'account_number') === '26%' ? { data: chart.class26 } : { data: chart.sales },
    webshop_store_settings: { data: [{ country_account_rules: rules }] },
    'rpc:get_entries_with_account_lines': entriesAnswer,
    webshop_orders: (chain: Chain) => {
      if (inArg(chain, 'journal_entry_id')) return { data: [ORDER, REFUND] }
      if (inArg(chain, 'manually_booked_journal_entry_id')) return { data: [] }
      if (inArg(chain, 'id')) return { data: [{ id: 'o0', journal_entry_id: 'e0', manually_booked_journal_entry_id: null }] }
      if (eqArg(chain, 'platform') === 'shopify') return { data: [] }
      return { data: [] }
    },
    journal_entries: (chain: Chain) => {
      const ids = inArg(chain, 'id')
      if (ids) return { data: linkedEntries.filter((entry) => ids.includes(entry.id)) }
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
      { country: 'DE', vat_rate: 19, net_eur: 88.25, vat_eur: 16.77, net_sek: 1000, vat_sek: 190, order_count: 1, voucher_count: 0, rate_mismatch: false },
    ])
    expect(result.corrections).toEqual([
      // -38 / 10.9 at the Q2 rate.
      { country: 'DE', period: { year: 2026, quarter: 2, label: 'Q2 2026' }, vat_eur: -3.49, vat_sek: -38, refund_count: 1, voucher_count: 0 },
    ])
    expect(result.ledger_vat_sek).toBe(152)
    expect(result.unaccounted).toEqual([])
    // Orders on the shared pair: no account names a country, and none waits for one.
    expect(result.accounts).toEqual([])
    expect(fetchEcbEuroRate.mock.calls).toEqual([
      ['SEK', '2026-06-30'],
      ['SEK', '2026-09-30'],
    ])
  })

  it('places the verifikat that book no order by the country their accounts name, and reads the quarter a storno corrects', async () => {
    const chart = {
      sales: [
        { account_number: '3149', account_name: 'Försäljning OSS Tyskland 19 %', oss_country: 'DE', oss_vat_rate: 19 },
        { account_number: '3150', account_name: 'Försäljning OSS Frankrike 20 %', oss_country: null, oss_vat_rate: null },
      ],
      class26: [
        { account_number: '2650', account_name: 'Redovisningskonto för moms', oss_country: 'DE', oss_vat_rate: null },
        { account_number: '2671', account_name: 'Utgående moms OSS Tyskland', oss_country: 'DE', oss_vat_rate: null },
        { account_number: '2672', account_name: 'Utgående moms OSS Frankrike', oss_country: null, oss_vat_rate: null },
      ],
    }
    const line = (account_number: string, value: number) =>
      value >= 0 ? { account_number, debit_amount: 0, credit_amount: value } : { account_number, debit_amount: -value, credit_amount: 0 }
    const manual = (id: string, voucher_number: number, lines: unknown[], extra: Record<string, unknown> = {}) => ({
      id, voucher_series: 'A', voucher_number, entry_date: '2026-08-15', description: `Faktura ${voucher_number}`,
      status: 'posted', source_type: 'manual', source_id: null, reverses_id: null, correction_of_id: null, lines, ...extra,
    })
    const { supabase, findCall } = mockSupabase(
      {
        data: [
          manual('m1', 21, [line('3149', 1000), line('2671', 190)]),
          manual('m2', 22, [line('3149', -500), line('2671', -95)], { reverses_id: 'q2' }),
          manual('m3', 23, [line('3150', 300)]),
        ],
      },
      chart,
      [{ id: 'q2', entry_date: '2026-06-01' }],
    )

    const result = await generateOssUnderlag(supabase as never, 'company-1', 2026, 3)

    // 2650 never holds OSS VAT, whatever its row says; 2672 names no country yet.
    expect((findCall('rpc:get_entries_with_account_lines', 'rpc')?.[0] as { p_accounts: string[] }).p_accounts).toEqual(['2670', '2671', '3149', '3150'])
    expect(result.rows).toEqual([
      { country: 'DE', vat_rate: 19, net_eur: 88.25, vat_eur: 16.77, net_sek: 1000, vat_sek: 190, order_count: 0, voucher_count: 1, rate_mismatch: false },
    ])
    expect(result.corrections).toEqual([
      { country: 'DE', period: { year: 2026, quarter: 2, label: 'Q2 2026' }, vat_eur: -8.72, vat_sek: -95, refund_count: 0, voucher_count: 1 },
    ])
    expect(result.unaccounted.map((voucher) => voucher.journal_entry_id)).toEqual(['m3'])
    expect(result.accounts).toEqual([
      { account_number: '2671', account_name: 'Utgående moms OSS Tyskland', kind: 'vat', country: 'DE', vat_rate: null, suggested_country: null, suggested_vat_rate: null, blocks_vouchers: false },
      { account_number: '2672', account_name: 'Utgående moms OSS Frankrike', kind: 'vat', country: null, vat_rate: null, suggested_country: 'FR', suggested_vat_rate: null, blocks_vouchers: false },
      { account_number: '3149', account_name: 'Försäljning OSS Tyskland 19 %', kind: 'sales', country: 'DE', vat_rate: 19, suggested_country: null, suggested_vat_rate: null, blocks_vouchers: false },
      { account_number: '3150', account_name: 'Försäljning OSS Frankrike 20 %', kind: 'sales', country: null, vat_rate: null, suggested_country: 'FR', suggested_vat_rate: 20, blocks_vouchers: true },
    ])
  })

  it('reads a VAT account a country rule names for one country as that country\'s, so its VAT stays with it', async () => {
    const chart = {
      sales: [
        { account_number: '3149', account_name: 'Försäljning OSS Tyskland 19 %', oss_country: 'DE', oss_vat_rate: 19 },
        { account_number: '3150', account_name: 'Försäljning OSS Frankrike 20 %', oss_country: 'FR', oss_vat_rate: 20 },
      ],
      // Neither VAT account names a country on its own row: the rules do.
      class26: [
        { account_number: '2671', account_name: 'Moms 1', oss_country: null, oss_vat_rate: null },
        { account_number: '2672', account_name: 'Moms 2', oss_country: null, oss_vat_rate: null },
      ],
    }
    const rules = [
      { country: 'DE', vat_rate: null, mode: 'accounts', revenue_account: '3149', vat_account: '2671' },
      { country: 'FR', vat_rate: null, mode: 'accounts', revenue_account: '3150', vat_account: '2672' },
    ]
    const line = (account_number: string, value: number) => ({ account_number, debit_amount: 0, credit_amount: value })
    const { supabase } = mockSupabase(
      {
        data: [
          {
            id: 'm1', voucher_series: 'A', voucher_number: 31, entry_date: '2026-08-15', description: 'Faktura 31',
            status: 'posted', source_type: 'manual', source_id: null, reverses_id: null, correction_of_id: null,
            // Germany's VAT is booked 10 kr too high; France's is right.
            lines: [line('3149', 1000), line('3150', 500), line('2671', 200), line('2672', 100)],
          },
        ],
      },
      chart,
      [],
      rules,
    )

    const result = await generateOssUnderlag(supabase as never, 'company-1', 2026, 3)

    // Shared between the two, the 10 kr would spread over both rows and mark both.
    expect(result.rows.map((row) => [row.country, row.vat_sek, row.rate_mismatch])).toEqual([
      ['DE', 200, true],
      ['FR', 100, false],
    ])
    expect(result.unaccounted).toEqual([])
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
