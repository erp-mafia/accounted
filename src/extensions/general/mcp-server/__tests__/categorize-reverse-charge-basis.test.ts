/**
 * gnubok_categorize_transaction: the reverse-charge basis pair (#2919).
 *
 * Categorizing a purchase as reverse charge used to stage only the fiktiv
 * pair (2645/2614): ruta 30 and 48 filled, rutor 20-24 empty, which
 * Skatteverket rejects (FK004). These tests pin, at the MCP boundary:
 *   - the named variants (reverse_charge_eu_services / _non_eu_services /
 *     _eu_goods) resolve to vat_treatment 'reverse_charge' + a kind, and the
 *     kind rides along in the staged params for the commit executor;
 *   - plain reverse_charge keeps working and books the EU-services default,
 *     which the preview states;
 *   - an override onto a basis account gets no second basis pair.
 * Companion suites: lib/bookkeeping/__tests__/category-mapping.test.ts (the
 * mapping), account-override.test.ts (override reconciliation) and
 * lib/pending-operations/__tests__ (commit threading).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'
import { eventBus } from '@/lib/events'

const mockDetectDup = vi.fn()
vi.mock('@/lib/transactions/booking-duplicate-detection', () => ({
  detectBookingDuplicate: (...args: unknown[]) => mockDetectDup(...args),
}))

import { tools } from '../server'

const categorize = tools.find((t) => t.name === 'gnubok_categorize_transaction')!

const TX_ID = '00000000-0000-4000-8000-0000000002f9'

/** Synthetic `transactions` row: the issue's illustrative Google Play charge. */
const coreTxRow = {
  id: TX_ID,
  date: '2026-09-10',
  amount: -250,
  currency: 'SEK',
  amount_sek: -250,
  exchange_rate: 1,
  description: 'GOOGLE PLAY',
  merchant_name: null,
  cash_account_id: null,
  document_id: null,
  journal_entry_id: null,
  is_business: true,
}

const guardTxRow = {
  description: 'GOOGLE PLAY',
  merchant_name: null,
  amount: -250,
  currency: 'SEK',
  amount_sek: -250,
  exchange_rate: 1,
  date: '2026-09-10',
  cash_account_id: null,
}

const settingsRow = { entity_type: 'aktiebolag', fiscal_year_start_month: 1 }

type Line = { account_number: string; debit_amount: number; credit_amount: number }
type Staged = { staged: boolean; preview: Record<string, unknown> }

async function stage(args: Record<string, unknown>, overrideRow?: Record<string, unknown>) {
  const { supabase, enqueue, findCall } = createQueuedMockSupabase()
  enqueue({ data: coreTxRow }) // core: transactions
  enqueue({ data: settingsRow }) // core: company_settings
  enqueue({ data: [] }) // resolveSettlementAccount: no enabled cash accounts -> 1930
  if (overrideRow) enqueue({ data: overrideRow }) // applyAccountOverride: chart row
  enqueue({ data: guardTxRow }) // tool: transactions re-fetch
  enqueue({ data: null }) // resolvePeriodStatusForDate: company_settings
  enqueue({ data: null }) // resolvePeriodStatusForDate: fiscal_periods
  enqueue({ data: { id: 'op-rc-1' } }) // pending_operations insert

  const result = (await categorize.execute(
    { transaction_id: TX_ID, category: 'expense_software', ...args },
    'company-1',
    'user-1',
    supabase as never,
    { type: 'api_key' },
  )) as Staged
  const insertArgs = findCall('pending_operations', 'insert') as unknown[]
  const params = (insertArgs[0] as { params: Record<string, unknown> }).params
  return { result, params, lines: result.preview.lines as Line[] }
}

const balanced = (lines: Line[]) => {
  const debit = lines.reduce((s, l) => s + l.debit_amount, 0)
  const credit = lines.reduce((s, l) => s + l.credit_amount, 0)
  return Math.round(debit * 100) === Math.round(credit * 100)
}

beforeEach(() => {
  vi.clearAllMocks()
  eventBus.clear()
  mockDetectDup.mockResolvedValue(null)
})

describe('gnubok_categorize_transaction: reverse-charge basis pair', () => {
  it('accepts the named reverse-charge variants and keeps plain reverse_charge', () => {
    const schema = categorize.inputSchema as { properties: { vat_treatment: { enum: string[] } } }
    expect(schema.properties.vat_treatment.enum).toEqual(expect.arrayContaining([
      'reverse_charge',
      'reverse_charge_eu_services',
      'reverse_charge_non_eu_services',
      'reverse_charge_eu_goods',
    ]))
  })

  it('stages the full four-line reverse-charge set on ruta 22 for reverse_charge_non_eu_services', async () => {
    const { result, params, lines } = await stage({ vat_treatment: 'reverse_charge_non_eu_services' })

    expect(result.staged).toBe(true)
    // The commit executor keeps one VatTreatment; the box travels as a kind.
    expect(params.vat_treatment).toBe('reverse_charge')
    expect(params.reverse_charge_kind).toBe('non_eu_services')

    const rows = lines.map((l) => [l.account_number, l.debit_amount, l.credit_amount])
    expect(rows).toEqual(expect.arrayContaining([
      ['5420', 250, 0],
      ['1930', 0, 250],
      ['2645', 62.5, 0],
      ['2614', 0, 62.5],
      ['4531', 250, 0],
      ['4598', 0, 250],
    ]))
    expect(lines).toHaveLength(6)
    expect(balanced(lines)).toBe(true)
    expect(result.preview.reverse_charge).toMatchObject({
      kind: 'non_eu_services',
      kind_source: 'vat_treatment',
      basis_account: '4531',
      ruta: 'ruta22',
    })
  })

  it('books plain reverse_charge on EU services and says it defaulted', async () => {
    const { params, lines, result } = await stage({ vat_treatment: 'reverse_charge' })

    expect(params.vat_treatment).toBe('reverse_charge')
    expect(params).not.toHaveProperty('reverse_charge_kind')
    expect(lines.map((l) => l.account_number)).toEqual(expect.arrayContaining(['2645', '2614', '4535', '4598']))
    expect(balanced(lines)).toBe(true)
    const summary = result.preview.reverse_charge as Record<string, unknown>
    expect(summary).toMatchObject({ kind: 'eu_services', kind_source: 'default', basis_account: '4535', ruta: 'ruta21' })
    expect(summary.note).toMatch(/reverse_charge_non_eu_services/)
  })

  it('books EU goods on 4515 (ruta 20)', async () => {
    const { lines, result } = await stage({ vat_treatment: 'reverse_charge_eu_goods' })
    expect(lines.find((l) => l.account_number === '4515')?.debit_amount).toBe(250)
    expect(result.preview.reverse_charge).toMatchObject({ basis_account: '4515', ruta: 'ruta20' })
  })

  it('adds no second basis pair when account_override is itself a basis account', async () => {
    const { lines, result } = await stage(
      { vat_treatment: 'reverse_charge_non_eu_services', account_override: '4531' },
      { account_number: '4531', account_class: 4, is_active: true, default_vat_treatment: null },
    )
    expect(lines.map((l) => l.account_number).sort()).toEqual(['1930', '2614', '2645', '4531'])
    expect(lines.find((l) => l.account_number === '4531')?.debit_amount).toBe(250)
    expect(balanced(lines)).toBe(true)
    expect(result.preview.reverse_charge).toMatchObject({ basis_account: null, ruta: null })
  })

  it('keeps the basis pair on the issue override account (6540)', async () => {
    const { lines } = await stage(
      { vat_treatment: 'reverse_charge', account_override: '6540' },
      { account_number: '6540', account_class: 6, is_active: true, default_vat_treatment: null },
    )
    expect(lines.map((l) => [l.account_number, l.debit_amount, l.credit_amount])).toEqual(expect.arrayContaining([
      ['6540', 250, 0],
      ['4535', 250, 0],
      ['4598', 0, 250],
    ]))
    expect(balanced(lines)).toBe(true)
  })

  it('sends no reverse_charge summary for an ordinary purchase', async () => {
    const { result } = await stage({ vat_treatment: 'standard_25' })
    expect(result.preview).not.toHaveProperty('reverse_charge')
  })
})
