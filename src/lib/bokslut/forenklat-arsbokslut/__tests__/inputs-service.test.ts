import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createTableMockSupabase } from '@/tests/helpers'
import { getForenklatArsbokslutInputs, saveForenklatArsbokslutInputs } from '../inputs-service'
import { updateForenklatArsbokslutInputs } from '../service'
import type { OperationContext } from '@/lib/operations/types'

const COMPANY = 'company-1'
const PERIOD = 'period-1'
const STORED = {
  eligibility_confirmed_at: '2027-03-01T10:00:00Z',
  eligibility_confirmed_by: 'user-0',
  notes: 'Not 1',
  signatories: [{ name: 'Ledamot A', role: 'ordförande' }, { name: '  ', role: null }],
  updated_at: '2027-03-01T10:00:00Z',
}

let mock: ReturnType<typeof createTableMockSupabase>

beforeEach(() => {
  vi.clearAllMocks()
  mock = createTableMockSupabase({ forenklat_arsbokslut_inputs: { data: STORED } })
})

describe('forenklat årsbokslut inputs', () => {
  it('reads the stored row, dropping a nameless signatory, and defaults when there is none', async () => {
    expect(await getForenklatArsbokslutInputs(mock.supabase as never, COMPANY, PERIOD)).toEqual({
      eligibility_confirmed_at: '2027-03-01T10:00:00Z',
      notes: 'Not 1',
      signatories: [{ name: 'Ledamot A', role: 'ordförande' }],
      updated_at: '2027-03-01T10:00:00Z',
    })
    mock.setTable('forenklat_arsbokslut_inputs', { data: null })
    expect(await getForenklatArsbokslutInputs(mock.supabase as never, COMPANY, PERIOD)).toEqual({
      eligibility_confirmed_at: null,
      notes: null,
      signatories: [],
      updated_at: null,
    })
  })

  it('replaces the fields given, trimmed, keeps the others, and writes in the caller\'s name', async () => {
    await saveForenklatArsbokslutInputs(mock.supabase as never, COMPANY, 'user-1', PERIOD, {
      notes: '  ',
      signatories: [{ name: ' Ledamot B ', role: ' ' }],
    })
    const [payload, options] = mock.findCall('forenklat_arsbokslut_inputs', 'upsert')!
    expect(payload).toEqual({
      company_id: COMPANY,
      fiscal_period_id: PERIOD,
      eligibility_confirmed_at: '2027-03-01T10:00:00Z',
      eligibility_confirmed_by: 'user-0',
      notes: null,
      signatories: [{ name: 'Ledamot B', role: null }],
      updated_by: 'user-1',
    })
    expect(options).toEqual({ onConflict: 'company_id,fiscal_period_id' })

    await saveForenklatArsbokslutInputs(mock.supabase as never, COMPANY, 'user-1', PERIOD, { notes: 'Not 2' })
    const kept = mock.findCalls('forenklat_arsbokslut_inputs', 'upsert').at(-1)![0] as Record<string, unknown>
    expect(kept).toMatchObject({ notes: 'Not 2', signatories: STORED.signatories })
  })

  it('keeps an existing confirmation\'s who and when, records a new one, and withdraws on false', async () => {
    await saveForenklatArsbokslutInputs(mock.supabase as never, COMPANY, 'user-2', PERIOD, { eligibility_confirmed: true })
    expect(mock.findCall('forenklat_arsbokslut_inputs', 'upsert')![0]).toMatchObject({
      eligibility_confirmed_at: '2027-03-01T10:00:00Z',
      eligibility_confirmed_by: 'user-0',
    })

    mock.setTable('forenklat_arsbokslut_inputs', { data: null })
    await saveForenklatArsbokslutInputs(mock.supabase as never, COMPANY, 'user-2', PERIOD, { eligibility_confirmed: true })
    const recorded = mock.findCalls('forenklat_arsbokslut_inputs', 'upsert').at(-1)![0] as Record<string, unknown>
    expect(recorded.eligibility_confirmed_by).toBe('user-2')
    expect(typeof recorded.eligibility_confirmed_at).toBe('string')
    expect(recorded).toMatchObject({ notes: null, signatories: [] })

    mock.setTable('forenklat_arsbokslut_inputs', { data: STORED })
    await saveForenklatArsbokslutInputs(mock.supabase as never, COMPANY, 'user-2', PERIOD, { eligibility_confirmed: false })
    const withdrawn = mock.findCalls('forenklat_arsbokslut_inputs', 'upsert').at(-1)![0] as Record<string, unknown>
    expect(withdrawn).toMatchObject({ eligibility_confirmed_at: null, eligibility_confirmed_by: null, notes: 'Not 1' })
  })

  it('rethrows a database error untouched so the route keeps its SQLSTATE', async () => {
    mock.setTable('forenklat_arsbokslut_inputs', { data: null, error: { code: '23514', message: 'check violation' } })
    await expect(
      saveForenklatArsbokslutInputs(mock.supabase as never, COMPANY, 'user-1', PERIOD, { notes: 'x' }),
    ).rejects.toMatchObject({ code: '23514' })
  })
})

describe('updateForenklatArsbokslutInputs', () => {
  const ctx = (): OperationContext => ({
    supabase: mock.supabase as never,
    companyId: COMPANY,
    userId: 'user-1',
    log: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() } as never,
  })

  it('saves for an ideell förening\'s own period', async () => {
    mock.setTable('fiscal_periods', { data: { id: PERIOD } })
    mock.setTable('company_settings', { data: { entity_type: 'ideell_forening' } })
    const outcome = await updateForenklatArsbokslutInputs(ctx(), PERIOD, { notes: 'Not 2' })
    expect(outcome).toMatchObject({ ok: true })
  })

  it('answers 404 for a foreign period and refuses another form', async () => {
    mock.setTable('fiscal_periods', { data: null })
    expect(await updateForenklatArsbokslutInputs(ctx(), PERIOD, { notes: 'x' })).toEqual({
      ok: false,
      code: 'FISCAL_PERIOD_NOT_FOUND',
    })
    mock.setTable('fiscal_periods', { data: { id: PERIOD } })
    mock.setTable('company_settings', { data: { entity_type: 'aktiebolag' } })
    expect(await updateForenklatArsbokslutInputs(ctx(), PERIOD, { notes: 'x' })).toEqual({
      ok: false,
      code: 'FORENKLAT_ARSBOKSLUT_WRONG_LEGAL_FORM',
    })
    expect(mock.findCall('forenklat_arsbokslut_inputs', 'upsert')).toBeUndefined()
  })
})
