import { describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { spendMasterDataRequestSchema } from '@accounted/connect-contract'
import { buildSpendMasterData, loadSpendCompanyContext } from '../master-data'
import { SPEND_VAT_CODES, SPEND_VAT_CODE_NOT_REGISTERED, toContractVatCode } from '../vat-codes'
import { createFakeDb } from './fake-db'

type Row = Record<string, unknown>

function account(account_number: string, account_name: string, default_vat_treatment: string | null, extra: Row = {}): Row {
  return { company_id: 'c1', account_number, account_name, default_vat_treatment, is_active: true, ...extra }
}

// In account order: the fake ignores .order(), the real read sorts by account number.
const CHART: Row[] = [
  account('1220', 'Inventarier och verktyg', 'standard_25'),
  account('1460', 'Lager av handelsvaror', 'standard_25'),
  account('1510', 'Kundfordringar', null),
  account('1790', 'Övriga förutbetalda kostnader och upplupna intäkter', null),
  account('1930', 'Företagskonto / checkräkningskonto', null),
  account('1940', 'Övriga bankkonton', null),
  account('2641', 'Debiterad ingående moms', null),
  account('3001', 'Försäljning inom Sverige, 25 % moms', 'standard_25'),
  account('4010', 'Inköp material och varor', 'standard_25'),
  account('5410', 'Förbrukningsinventarier', 'standard_25'),
  account('5460', '   ', 'standard_25'),
  account('5800', '  Resekostnader  ', 'reduced_6'),
  account('6071', 'Representation, avdragsgill', 'reduced_12'),
  account('6110', 'Kontorsmateriel', 'standard_25', { is_active: false }),
  account('6540', 'IT-tjänster', 'reverse_charge_eu_services'),
  account('6570', 'Bankkostnader', 'exempt'),
  account('7331', 'Skattefria bilersättningar', null),
  account('8410', 'Räntekostnader för långfristiga skulder', 'exempt'),
  account('4010', 'Inköp i ett annat företag', 'standard_25', { company_id: 'c2' }),
]

const DIMENSIONS: Row[] = [
  { id: 'd1', company_id: 'c1', sie_dim_no: 1, name: 'Kostnadsställe', is_active: true, sort_order: 1 },
  { id: 'd6', company_id: 'c1', sie_dim_no: 6, name: 'Projekt', is_active: true, sort_order: 2 },
  { id: 'd7', company_id: 'c1', sie_dim_no: 7, name: 'Anställd', is_active: false, sort_order: 3 },
]

const DIMENSION_VALUES: Row[] = [
  { company_id: 'c1', dimension_id: 'd1', code: '100', name: 'Ledning', is_active: true },
  { company_id: 'c1', dimension_id: 'd1', code: '200', name: '', is_active: true },
  { company_id: 'c1', dimension_id: 'd1', code: '300', name: 'Nedlagt', is_active: false },
  { company_id: 'c1', dimension_id: 'd6', code: 'P7', name: 'Kontorsflytt', is_active: true },
  { company_id: 'c2', dimension_id: 'd1', code: '999', name: 'Ett annat företag', is_active: true },
]

function supabaseWith(seed: Record<string, Row[]>) {
  const db = createFakeDb(seed)
  const from = vi.fn((table: string) => db.client.from(table))
  return { supabase: { from } as unknown as SupabaseClient, from, db }
}

describe('loadSpendCompanyContext', () => {
  const settings: Row[] = [
    { company_id: 'c1', vat_registered: false, dimensions_enabled: true },
    { company_id: 'c2', vat_registered: true, dimensions_enabled: false },
    { company_id: 'c4', vat_registered: null, dimensions_enabled: null },
  ]

  it("reads the company's VAT registration and whether dimensions are on", async () => {
    const { supabase } = supabaseWith({ company_settings: settings })
    expect(await loadSpendCompanyContext(supabase, 'c1')).toEqual({ vatRegistered: false, dimensionsEnabled: true })
    expect(await loadSpendCompanyContext(supabase, 'c2')).toEqual({ vatRegistered: true, dimensionsEnabled: false })
  })

  it('leaves the registration unknown and dimensions off when nothing is stored', async () => {
    const { supabase } = supabaseWith({ company_settings: settings })
    expect(await loadSpendCompanyContext(supabase, 'c3')).toEqual({ vatRegistered: null, dimensionsEnabled: false })
    expect(await loadSpendCompanyContext(supabase, 'c4')).toEqual({ vatRegistered: null, dimensionsEnabled: false })
  })
})

describe('buildSpendMasterData', () => {
  it('offers the active accounts a card expense can land on, each with its usual VAT code', async () => {
    const { supabase } = supabaseWith({ chart_of_accounts: CHART })
    const { body } = await buildSpendMasterData(supabase, 'c1', { vatRegistered: true, dimensionsEnabled: false })
    expect(body.accounts).toEqual([
      { number: '1220', name: 'Inventarier och verktyg', vatCode: 'SE25' },
      { number: '1460', name: 'Lager av handelsvaror', vatCode: 'SE25' },
      { number: '1790', name: 'Övriga förutbetalda kostnader och upplupna intäkter', vatCode: null },
      { number: '1930', name: 'Företagskonto / checkräkningskonto', vatCode: null },
      { number: '1940', name: 'Övriga bankkonton', vatCode: null },
      { number: '4010', name: 'Inköp material och varor', vatCode: 'SE25' },
      { number: '5410', name: 'Förbrukningsinventarier', vatCode: 'SE25' },
      { number: '5460', name: '5460', vatCode: 'SE25' },
      { number: '5800', name: 'Resekostnader', vatCode: 'SE6' },
      { number: '6071', name: 'Representation, avdragsgill', vatCode: 'SE12' },
      { number: '6540', name: 'IT-tjänster', vatCode: 'EUTJ' },
      { number: '6570', name: 'Bankkostnader', vatCode: 'MOMSFRI' },
      { number: '7331', name: 'Skattefria bilersättningar', vatCode: null },
      { number: '8410', name: 'Räntekostnader för långfristiga skulder', vatCode: 'MOMSFRI' },
    ])
  })

  it('publishes every purchase VAT code, and EJMOMS beside the reverse-charge codes for a company that is not VAT registered', async () => {
    const { supabase } = supabaseWith({ chart_of_accounts: CHART })
    const registered = await buildSpendMasterData(supabase, 'c1', { vatRegistered: true, dimensionsEnabled: false })
    expect(registered.body.vatCodes).toEqual(SPEND_VAT_CODES.map(toContractVatCode))

    const notRegistered = await buildSpendMasterData(supabase, 'c1', { vatRegistered: false, dimensionsEnabled: false })
    expect(notRegistered.body.vatCodes).toEqual([
      toContractVatCode(SPEND_VAT_CODE_NOT_REGISTERED),
      ...SPEND_VAT_CODES.filter((d) => d.type === 'reverse').map(toContractVatCode),
    ])
    expect(new Set(notRegistered.body.accounts.map((a) => a.vatCode))).toEqual(new Set(['EJMOMS', 'EUTJ']))
  })

  it('sends no dimensions, and reads none, while the company has dimensions off', async () => {
    const { supabase, from } = supabaseWith({ chart_of_accounts: CHART, dimensions: DIMENSIONS, dimension_values: DIMENSION_VALUES })
    const { body } = await buildSpendMasterData(supabase, 'c1', { vatRegistered: true, dimensionsEnabled: false })
    expect(body.dimensions).toEqual([])
    expect(from.mock.calls.map((c) => c[0])).toEqual(['chart_of_accounts'])
  })

  it('sends the active dimensions with their active values when dimensions are on', async () => {
    const { supabase } = supabaseWith({ chart_of_accounts: CHART, dimensions: DIMENSIONS, dimension_values: DIMENSION_VALUES })
    const { body } = await buildSpendMasterData(supabase, 'c1', { vatRegistered: true, dimensionsEnabled: true })
    expect(body.dimensions).toEqual([
      {
        code: '1',
        name: 'Kostnadsställe',
        values: [
          { code: '100', name: 'Ledning' },
          { code: '200', name: '200' },
        ],
      },
      { code: '6', name: 'Projekt', values: [{ code: 'P7', name: 'Kontorsflytt' }] },
    ])
  })

  it('sends at most 20 dimensions, the most the contract takes', async () => {
    const many = Array.from({ length: 25 }, (_, i) => ({
      id: `dim-${i}`,
      company_id: 'c1',
      sie_dim_no: i + 1,
      name: `Dimension ${i + 1}`,
      is_active: true,
      sort_order: i,
    }))
    const { supabase } = supabaseWith({ chart_of_accounts: CHART, dimensions: many, dimension_values: [] })
    const { body } = await buildSpendMasterData(supabase, 'c1', { vatRegistered: true, dimensionsEnabled: true })
    expect(body.dimensions).toHaveLength(20)
    expect(body.dimensions[19].code).toBe('20')
  })

  it('builds a body the contract accepts', async () => {
    const { supabase } = supabaseWith({ chart_of_accounts: CHART, dimensions: DIMENSIONS, dimension_values: DIMENSION_VALUES })
    const { body } = await buildSpendMasterData(supabase, 'c1', { vatRegistered: true, dimensionsEnabled: true })
    expect(spendMasterDataRequestSchema.safeParse({ idempotencyKey: 'master-data-1', ...body }).success).toBe(true)
  })

  it('fingerprints the body: the same data hashes the same, a renamed account does not', async () => {
    const context = { vatRegistered: true, dimensionsEnabled: true }
    const seed = { chart_of_accounts: CHART, dimensions: DIMENSIONS, dimension_values: DIMENSION_VALUES }
    const first = await buildSpendMasterData(supabaseWith(seed).supabase, 'c1', context)
    const again = await buildSpendMasterData(supabaseWith(seed).supabase, 'c1', context)
    expect(first.sha256).toMatch(/^[0-9a-f]{64}$/)
    expect(again.sha256).toBe(first.sha256)

    const renamed = CHART.map((row) => (row.account_number === '6540' && row.company_id === 'c1' ? { ...row, account_name: 'Programvara' } : row))
    const changed = await buildSpendMasterData(supabaseWith({ ...seed, chart_of_accounts: renamed }).supabase, 'c1', context)
    expect(changed.sha256).not.toBe(first.sha256)

    const notRegistered = await buildSpendMasterData(supabaseWith(seed).supabase, 'c1', { ...context, vatRegistered: false })
    expect(notRegistered.sha256).not.toBe(first.sha256)
  })
})
