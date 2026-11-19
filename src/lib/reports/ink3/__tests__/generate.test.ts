import { beforeEach, describe, expect, it, vi } from 'vitest'
import { renderToBuffer } from '@react-pdf/renderer'
import { createTableMockSupabase } from '@/tests/helpers'
import { pdfTextStrings } from '@/tests/pdf-text'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { TrialBalanceRow } from '@/types'

const trialBalance = vi.fn()
vi.mock('@/lib/reports/trial-balance', () => ({
  generateTrialBalance: (...args: unknown[]) => trialBalance(...args),
}))
vi.mock('@/lib/bokslut/reserves/periodiseringsfond-service', async (orig) => ({
  ...(await orig<typeof import('@/lib/bokslut/reserves/periodiseringsfond-service')>()),
  listExistingPeriodiseringsfonder: vi.fn().mockResolvedValue([]),
}))

import { generateInk3Underlag, Ink3WrongLegalFormError } from '../ink3-engine'
import { Ink3PeriodNotSupportedError } from '../field-table'
import { Ink3UnderlagPDF } from '../pdf-template'
import { putInk3UnderlagInputs, getInk3UnderlagInputs } from '../inputs-service'

const COMPANY = 'company-1'
const PERIOD = '11111111-1111-4111-8111-111111111111'

function rows(balances: Record<string, number>): TrialBalanceRow[] {
  return Object.entries(balances).map(([account, balance]) => ({
    account_number: account,
    account_name: `Konto ${account}`,
    account_class: Number(account.charAt(0)),
    opening_debit: 0,
    opening_credit: 0,
    period_debit: 0,
    period_credit: 0,
    closing_debit: balance > 0 ? balance : 0,
    closing_credit: balance < 0 ? -balance : 0,
  }))
}

function setup(opts: { entityType?: string; periodEnd?: string; period?: boolean; inputs?: unknown } = {}) {
  const { supabase, setTable, findCall } = createTableMockSupabase()
  setTable(
    'fiscal_periods',
    opts.period === false
      ? { data: null, error: { message: 'not found' } }
      : {
          data: {
            id: PERIOD,
            name: '2026',
            period_start: '2026-01-01',
            period_end: opts.periodEnd ?? '2026-12-31',
            is_closed: true,
            closing_entry_id: 'closing-1',
            opening_balance_entry_id: null,
          },
        },
  )
  setTable('company_settings', { data: { company_name: 'Föreningen', org_number: '802400-0000', entity_type: opts.entityType ?? 'ideell_forening' } })
  setTable('companies', { data: { entity_type: opts.entityType ?? 'ideell_forening' } })
  setTable('ink3_underlag_inputs', { data: opts.inputs ?? null })
  return { supabase: supabase as unknown as SupabaseClient, setTable, findCall }
}

beforeEach(() => {
  vi.clearAllMocks()
  trialBalance.mockImplementation(async (_s: unknown, _c: unknown, _p: unknown, options: { closingEntry: string }) => ({
    rows:
      options.closingEntry === 'include'
        ? rows({ '1930': 30_000, '2069': -10_000, '2068': -20_000 })
        : rows({ '1930': 30_000, '2068': -20_000, '3901': -15_000, '3010': -5_000, '5010': 10_000 }),
    totalDebit: 0,
    totalCredit: 0,
    isBalanced: true,
  }))
})

describe('generateInk3Underlag', () => {
  it('reads the period, the form, the inputs and both trial balances', async () => {
    const { supabase } = setup({
      inputs: { allmannyttig: true, account_treatments: { '3010': 'taxable', '5010': 'exempt' }, field_overrides: { '8822': true } },
    })
    const underlag = await generateInk3Underlag(supabase, COMPANY, PERIOD)
    expect(underlag.beskattningsperiod).toBe('2026P4')
    expect(underlag.fieldTable.files).toContain('INK3R_SKV2003-33-02-26-07.xls')
    expect(underlag.companyInfo).toEqual({ companyName: 'Föreningen', orgNumber: '802400-0000' })
    expect(underlag.allmannyttig).toBe(true)
    expect(underlag.filing).toMatchObject({ '8650': 15_000, '8653': 5_000, '8673': 5_000, '8751': 10_000, '8663': 10_000, '8822': 'X' })
    expect(underlag.complete).toBe(true)
    expect(trialBalance.mock.calls.map((c) => (c[3] as { closingEntry: string }).closingEntry)).toEqual(['include', 'exclude-final'])
  })

  it('refuses a form that does not file INK3', async () => {
    const { supabase } = setup({ entityType: 'aktiebolag' })
    await expect(generateInk3Underlag(supabase, COMPANY, PERIOD)).rejects.toBeInstanceOf(Ink3WrongLegalFormError)
  })

  it('refuses a räkenskapsår without a pinned field table', async () => {
    const { supabase } = setup({ periodEnd: '2026-06-30' })
    await expect(generateInk3Underlag(supabase, COMPANY, PERIOD)).rejects.toBeInstanceOf(Ink3PeriodNotSupportedError)
  })

  it('throws for a period that is not the company\'s', async () => {
    const { supabase } = setup({ period: false })
    await expect(generateInk3Underlag(supabase, COMPANY, PERIOD)).rejects.toThrow('Fiscal period not found')
  })
})

describe('Ink3UnderlagPDF', () => {
  it('renders the rutor, both columns and the note that nothing is filed', async () => {
    const { supabase } = setup({
      inputs: { allmannyttig: true, account_treatments: { '3010': 'taxable', '5010': 'shared' }, field_overrides: { '8822': true } },
    })
    const underlag = await generateInk3Underlag(supabase, COMPANY, PERIOD)
    const pdf = await renderToBuffer(Ink3UnderlagPDF({ underlag, generatedAt: '2026-10-15T10:00:00Z' }))
    const text = pdfTextStrings(Buffer.from(pdf)).join(' ')
    expect(text).toContain('Inkomstdeklaration 3, underlag')
    expect(text).toContain('Detta är inte en inlämnad')
    expect(text).toContain('Som ska tas upp/dras av')
    expect(text).toContain('8673')
    expect(text).toContain('15 000')
    expect(text).toContain('INK3SUF')
    expect(text).toContain('rutor markerade med *')
  })
})

describe('INK3 inputs service', () => {
  const ctx = (supabase: SupabaseClient) => ({
    supabase,
    companyId: COMPANY,
    userId: 'user-1',
    log: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn(), child: vi.fn() } as never,
  })
  const body = { allmannyttig: true, account_treatments: { '3010': 'taxable' as const }, field_overrides: { '8671': 1_000 } }

  it('404s a period that is not the company\'s, and reads the saved inputs of one that is', async () => {
    const other = createTableMockSupabase()
    other.setTable('fiscal_periods', { data: null })
    const outcome = await getInk3UnderlagInputs(ctx(other.supabase as unknown as SupabaseClient), PERIOD)
    expect(outcome).toMatchObject({ ok: false, code: 'FISCAL_PERIOD_NOT_FOUND' })

    const own = setup({ inputs: { allmannyttig: false, account_treatments: { '3010': 'exempt', '1930': 'taxable' }, field_overrides: {} } })
    expect(await getInk3UnderlagInputs(ctx(own.supabase), PERIOD)).toEqual({
      ok: true,
      data: { allmannyttig: false, accountTreatments: { '3010': 'exempt' }, fieldOverrides: {} },
    })
  })

  it('refuses a form that does not file INK3, an unpinned period and an invalid override', async () => {
    const ab = setup({ entityType: 'aktiebolag' })
    expect(await putInk3UnderlagInputs(ctx(ab.supabase), PERIOD, body)).toMatchObject({
      ok: false,
      code: 'TAX_DECL_INK3_WRONG_LEGAL_FORM',
    })

    const p2 = setup({ periodEnd: '2026-06-30' })
    expect(await putInk3UnderlagInputs(ctx(p2.supabase), PERIOD, body)).toMatchObject({
      ok: false,
      code: 'TAX_DECL_INK3_PERIOD_NOT_SUPPORTED',
      details: { beskattningsperiod: '2026P2', supported: ['2026P4'] },
    })

    const ok = setup()
    const bad = await putInk3UnderlagInputs(ctx(ok.supabase), PERIOD, {
      ...body,
      field_overrides: { '8695': 5, '8688': -1, '8822': 3, '9999': 1, '8040': true, '8041': true },
    })
    expect(bad).toMatchObject({ ok: false, code: 'VALIDATION_ERROR' })
    const codes = (bad as unknown as { details: { issues: Array<{ code: string }> } }).details.issues.map((i) => i.code)
    expect(codes.sort()).toEqual(['8041', '8688', '8695', '8822', '9999'])
  })

  it('saves in the caller\'s name, upserting the one row for the period', async () => {
    const { supabase, findCall } = setup({
      inputs: { allmannyttig: true, account_treatments: { '3010': 'taxable' }, field_overrides: { '8671': 1_000 } },
    })
    const outcome = await putInk3UnderlagInputs(ctx(supabase), PERIOD, body)
    expect(outcome).toMatchObject({
      ok: true,
      data: { allmannyttig: true, accountTreatments: { '3010': 'taxable' }, fieldOverrides: { '8671': 1_000 } },
    })
    expect(findCall('ink3_underlag_inputs', 'upsert')).toEqual([
      {
        company_id: COMPANY,
        fiscal_period_id: PERIOD,
        allmannyttig: true,
        account_treatments: { '3010': 'taxable' },
        field_overrides: { '8671': 1_000 },
        updated_by: 'user-1',
      },
      { onConflict: 'company_id,fiscal_period_id' },
    ])
  })
})
