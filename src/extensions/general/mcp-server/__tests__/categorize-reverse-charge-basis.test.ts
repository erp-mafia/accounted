/**
 * gnubok_categorize_transaction: the reverse-charge basis pair (#2919).
 *
 * Categorizing a purchase as reverse charge used to stage only the fiktiv
 * pair (2645/2614): ruta 30 and 48 filled, rutor 20-24 empty, which
 * Skatteverket rejects (FK004). These tests pin, at the MCP boundary:
 *   - the named variants (reverse_charge_eu_services / _non_eu_services /
 *     _eu_goods) resolve to vat_treatment 'reverse_charge' + a kind, and the
 *     kind rides along in the staged params for the commit executor;
 *   - plain reverse_charge takes the box the pinned underlag's seller and
 *     the category give, and is refused when they cannot tell it: never ruta
 *     21 by default (#94);
 *   - an override onto a basis account gets no second basis pair, and its
 *     own box is the one reported, never the EU default (crm#1454);
 *   - nor does a cost account whose momskod reports ruta 20-24 (crm#1096).
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

// The booking service's chart pre-validation and period-lock pre-check have
// their own tests; complete and open here.
vi.mock('@/lib/bookkeeping/account-validation', async (importActual) => ({
  ...(await importActual<typeof import('@/lib/bookkeeping/account-validation')>()),
  findUnresolvableAccounts: vi.fn().mockResolvedValue([]),
}))
vi.mock('@/lib/api/v1/check-period-lock', () => ({
  checkPeriodLock: vi.fn().mockResolvedValue({ locked: false }),
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

const settingsRow = { entity_type: 'aktiebolag', fiscal_year_start_month: 1 }

type Line = { account_number: string; debit_amount: number; credit_amount: number }
type Staged = { staged: boolean; preview: Record<string, unknown> }

async function stage(
  args: Record<string, unknown>,
  overrideRow?: Record<string, unknown>,
  momskoder: Array<Record<string, unknown>> = [],
  document?: Record<string, unknown>,
) {
  const { supabase, enqueue, findCall } = createQueuedMockSupabase()
  enqueue({ data: document ? { ...coreTxRow, document_id: 'doc-1' } : coreTxRow }) // core: transactions
  enqueue({ data: [] }) // the gate: no posted verifikat booked from the row (#203)
  enqueue({ data: settingsRow }) // core: company_settings
  if (document) enqueue({ data: { id: 'doc-1', extracted_data: document } }) // core: the pinned underlag
  enqueue({ data: [] }) // resolveSettlementAccount: no enabled cash accounts -> 1930
  if (overrideRow) enqueue({ data: overrideRow }) // applyAccountOverride: chart row
  // reconcileRcBasisWithChart reads the momskoder once the mapping carries a basis pair.
  if (String(args.vat_treatment ?? '').startsWith('reverse_charge')) enqueue({ data: momskoder })
  enqueue({ data: null }) // resolvePeriodStatusForDate: company_settings
  enqueue({ data: null }) // resolvePeriodStatusForDate: fiscal_periods
  enqueue({ data: [], error: null }) // open operations on these rows: none (crm#1264)
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

  it('refuses plain reverse_charge when no underlag tells the seller country, and stages nothing (#94)', async () => {
    const { supabase, enqueue, findCall } = createQueuedMockSupabase()
    enqueue({ data: coreTxRow })
    enqueue({ data: [] }) // the gate: no posted verifikat booked from the row (#203)
    enqueue({ data: settingsRow })
    enqueue({ data: [] }) // resolveSettlementAccount
    enqueue({ data: [] }) // momskoder
    await expect(
      categorize.execute(
        { transaction_id: TX_ID, category: 'expense_software', vat_treatment: 'reverse_charge' },
        'company-1',
        'user-1',
        supabase as never,
        { type: 'api_key' },
      ),
    ).rejects.toMatchObject({
      code: 'TX_CATEGORIZE_REVERSE_CHARGE_BOX_UNKNOWN',
      message: expect.stringContaining('reverse_charge_non_eu_services'),
    })
    expect(findCall('pending_operations', 'insert')).toBeUndefined()
  })

  it('books a US seller on the pinned underlag in ruta 22 and stages that box (#94)', async () => {
    const usSeller = { supplier: { address: '548 Market St, San Francisco, California 94104, United States' }, totals: { vatAmount: 0 } }
    const { params, lines, result } = await stage({ vat_treatment: 'reverse_charge' }, undefined, [], usSeller)

    expect(params.reverse_charge_kind).toBe('non_eu_services')
    expect(lines.find((l) => l.account_number === '4531')?.debit_amount).toBe(250)
    expect(lines.map((l) => l.account_number)).not.toContain('4535')
    expect(result.preview.reverse_charge).toMatchObject({ kind: 'non_eu_services', kind_source: 'underlag', ruta: 'ruta22' })
  })

  it('books an EU seller on the pinned underlag in ruta 21', async () => {
    const ieSeller = { supplier: { vatNumber: 'IE3668997OH' }, totals: { vatAmount: 0 } }
    const { params, result } = await stage({ vat_treatment: 'reverse_charge' }, undefined, [], ieSeller)
    expect(params.reverse_charge_kind).toBe('eu_services')
    expect(result.preview.reverse_charge).toMatchObject({ basis_account: '4535', ruta: 'ruta21', kind_source: 'underlag' })
  })

  it('books EU goods on 4515 (ruta 20)', async () => {
    const { lines, result } = await stage({ vat_treatment: 'reverse_charge_eu_goods' })
    expect(lines.find((l) => l.account_number === '4515')?.debit_amount).toBe(250)
    expect(result.preview.reverse_charge).toMatchObject({ basis_account: '4515', ruta: 'ruta20' })
  })

  it('adds no second basis pair when account_override is itself a basis account', async () => {
    const { lines, result } = await stage(
      { vat_treatment: 'reverse_charge_non_eu_services', account_override: '4531' },
      { account_number: '4531', account_class: 4, is_active: true },
    )
    expect(lines.map((l) => l.account_number).sort()).toEqual(['1930', '2614', '2645', '4531'])
    expect(lines.find((l) => l.account_number === '4531')?.debit_amount).toBe(250)
    expect(balanced(lines)).toBe(true)
    expect(result.preview.reverse_charge).toMatchObject({
      kind: 'non_eu_services', kind_source: 'account', basis_account: null, ruta: 'ruta22',
    })
  })

  it('reads the box off a basis override when plain reverse_charge names none, never the EU default (crm#1454)', async () => {
    const { lines, params, result } = await stage(
      { vat_treatment: 'reverse_charge', account_override: '4531' },
      { account_number: '4531', account_class: 4, is_active: true },
    )
    expect(lines.map((l) => l.account_number).sort()).toEqual(['1930', '2614', '2645', '4531'])
    expect(params.reverse_charge_kind).toBeUndefined()
    expect(result.preview.reverse_charge).toMatchObject({
      kind: 'non_eu_services', kind_source: 'account', basis_account: null, ruta: 'ruta22',
    })
  })

  it('refuses a named box that the override account contradicts, and stages nothing (crm#1454)', async () => {
    const { supabase, enqueue, findCall } = createQueuedMockSupabase()
    enqueue({ data: coreTxRow })
    enqueue({ data: [] }) // the gate: no posted verifikat booked from the row (#203)
    enqueue({ data: settingsRow })
    enqueue({ data: [] }) // resolveSettlementAccount
    enqueue({ data: { account_number: '4531', account_class: 4, is_active: true } }) // override chart row
    enqueue({ data: [] }) // momskoder
    await expect(
      categorize.execute(
        { transaction_id: TX_ID, category: 'expense_software', vat_treatment: 'reverse_charge_eu_services', account_override: '4531' },
        'company-1',
        'user-1',
        supabase as never,
        { type: 'api_key' },
      ),
    ).rejects.toThrow(/account 4531 reports ruta22 itself/)
    expect(findCall('pending_operations', 'insert')).toBeUndefined()
  })

  it('stages no basis pair on a cost account whose momskod reports ruta 20-24 itself (crm#1096)', async () => {
    const { lines, result } = await stage(
      { vat_treatment: 'reverse_charge' },
      undefined,
      [{ account_number: '5420', default_vat_treatment: 'reverse_charge_eu_services' }],
    )
    expect(lines.map((l) => [l.account_number, l.debit_amount, l.credit_amount]).sort()).toEqual([
      ['1930', 0, 250],
      ['2614', 0, 62.5],
      ['2645', 62.5, 0],
      ['5420', 250, 0],
    ])
    expect(balanced(lines)).toBe(true)
    expect(result.preview.reverse_charge).toMatchObject({
      kind: 'eu_services', kind_source: 'account', basis_account: null, ruta: 'ruta21',
    })
  })

  it('keeps the basis pair on the issue override account (6540)', async () => {
    const { lines } = await stage(
      { vat_treatment: 'reverse_charge_eu_services', account_override: '6540' },
      { account_number: '6540', account_class: 6, is_active: true },
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

// crm#1765: a foreign seller that wrongly charged its own country's VAT. The
// buyer is still liable in Sweden on everything the seller was paid, and the
// foreign VAT is never ingående moms (docs/decisions/2026-11/
// 2026-11-12-reverse-charge-with-foreign-seller-vat.md). Refused unless the
// caller states it with confirm_foreign_seller_vat.
describe('gnubok_categorize_transaction: reverse charge on an underlag with the seller\'s VAT', () => {
  // The bank row is what the seller was paid: 250 = 206.61 price + 43.39 VAT at 21 %.
  const dutchVat = { supplier: { vatNumber: 'NL123456789B01' }, totals: { total: 250, vatAmount: 43.39 }, invoice: { currency: 'SEK' } }
  const usSeller = { supplier: { address: '548 Market St, San Francisco, California 94104, United States' }, totals: { total: 250, vatAmount: 50 } }
  const rows = (lines: Line[]) => lines.map((l) => [l.account_number, l.debit_amount, l.credit_amount])

  it('names the flag in the tool schema', () => {
    const schema = categorize.inputSchema as { properties: Record<string, { type: string }> }
    expect(schema.properties.confirm_foreign_seller_vat).toMatchObject({ type: 'boolean' })
  })

  it('refuses without the flag, and the refusal names it', async () => {
    await expect(stage({ vat_treatment: 'reverse_charge_eu_services' }, undefined, [], dutchVat)).rejects.toMatchObject({
      code: 'TX_CATEGORIZE_REVERSE_CHARGE_SELLER_VAT',
      details: { reason: 'not_confirmed', confirm_with: 'confirm_foreign_seller_vat', seller_vat_amount: 43.39 },
    })
  })

  it('EU seller, with the flag: the whole amount paid is cost and basis in ruta 21, and no line deducts the seller\'s VAT', async () => {
    const { result, params, lines } = await stage(
      { vat_treatment: 'reverse_charge_eu_services', confirm_foreign_seller_vat: true },
      undefined,
      [],
      dutchVat,
    )

    expect(result.staged).toBe(true)
    expect(rows(lines)).toEqual(expect.arrayContaining([
      ['5420', 250, 0],
      ['1930', 0, 250],
      ['2645', 62.5, 0],
      ['2614', 0, 62.5],
      ['4535', 250, 0],
      ['4598', 0, 250],
    ]))
    expect(lines).toHaveLength(6)
    expect(balanced(lines)).toBe(true)
    expect(lines.map((l) => l.account_number)).not.toContain('2641')
    // The approval books under the same statement, and the approver reads what it means.
    expect(params.confirm_foreign_seller_vat).toBe(true)
    expect(result.preview.compliance_warning).toMatch(/inte avdragsgill i Sverige/)
    expect(result.preview.compliance_warning).toMatch(/kreditfaktura/)
    // 21 % is not the Swedish rate: no doubt to raise about whose VAT it is.
    expect(result.preview.compliance_warning).not.toMatch(/25 %/)
  })

  it('non-EU seller, with the flag: the same lines on ruta 22, with the warning when the charge is 25 % of the price', async () => {
    const { result, lines } = await stage(
      { vat_treatment: 'reverse_charge_non_eu_services', confirm_foreign_seller_vat: true },
      undefined,
      [],
      usSeller,
    )

    expect(rows(lines)).toEqual(expect.arrayContaining([
      ['5420', 250, 0],
      ['2645', 62.5, 0],
      ['2614', 0, 62.5],
      ['4531', 250, 0],
      ['4598', 0, 250],
    ]))
    expect(lines.map((l) => l.account_number)).not.toContain('4535')
    expect(lines.map((l) => l.account_number)).not.toContain('2641')
    expect(balanced(lines)).toBe(true)
    expect(result.preview.compliance_warning).toMatch(/Kontrollera att det är utländsk moms/)
  })

  it('keeps refusing a seller with a Swedish VAT number, flag or not: that VAT is Swedish', async () => {
    const swedish = { supplier: { vatNumber: 'SE556677889901' }, totals: { total: 250, vatAmount: 50 } }
    await expect(
      stage({ vat_treatment: 'reverse_charge_eu_services', confirm_foreign_seller_vat: true }, undefined, [], swedish),
    ).rejects.toMatchObject({
      code: 'TX_CATEGORIZE_REVERSE_CHARGE_SELLER_VAT',
      details: { reason: 'seller_vat_swedish' },
    })
  })

  it('stages nothing about the flag on an underlag without the seller\'s VAT', async () => {
    const { result, params } = await stage(
      { vat_treatment: 'reverse_charge_eu_services', confirm_foreign_seller_vat: true },
      undefined,
      [],
      { supplier: { vatNumber: 'NL123456789B01' }, totals: { total: 250, vatAmount: 0 } },
    )
    expect(params).not.toHaveProperty('confirm_foreign_seller_vat')
    expect(result.preview).not.toHaveProperty('compliance_warning')
  })
})
