/**
 * Tests for the shared declaration-prep functions. These are the single
 * source of truth for what gets filed to Skatteverket: the HTTP route
 * handlers and the commit-side services both go through them, so a regression
 * here would mean different numbers filed than the user reviewed (no-drift
 * compliance guarantee).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'
import type { VatDeclarationRutor } from '@/types'

const mockCalculateVatDeclaration = vi.fn()
const mockResolvePeriodDates = vi.fn()
vi.mock('@/lib/reports/vat-declaration', () => ({
  calculateVatDeclaration: (...a: unknown[]) => mockCalculateVatDeclaration(...a),
  resolvePeriodDates: (...a: unknown[]) => mockResolvePeriodDates(...a),
}))
const mockGenerateAgiDeclaration = vi.fn()
vi.mock('@/lib/salary/agi/generate-declaration', () => ({
  generateAgiDeclaration: (...a: unknown[]) => mockGenerateAgiDeclaration(...a),
}))

import {
  buildMomsuppgift,
  buildAgiUnderlag,
  refreshAgiUnderlag,
  resolveRedovisare,
  resolveRedovisningsperiod,
} from '../lib/declaration-prep'
import { rutorToMomsuppgift } from '../lib/mappers'

const READ_KEYS = [
  'ruta05', 'ruta06', 'ruta07', 'ruta08', 'ruta10', 'ruta11', 'ruta12',
  'ruta20', 'ruta21', 'ruta22', 'ruta23', 'ruta24', 'ruta30', 'ruta31', 'ruta32',
  'ruta35', 'ruta36', 'ruta37', 'ruta38', 'ruta39', 'ruta40', 'ruta41', 'ruta42',
  'ruta48', 'ruta50', 'ruta60', 'ruta61', 'ruta62',
]

function zeroRutor(): VatDeclarationRutor {
  return Object.fromEntries(READ_KEYS.map((k) => [k, 0])) as unknown as VatDeclarationRutor
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('resolveRedovisare', () => {
  it('formats an aktiebolag org number to the 12-digit redovisare', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { org_number: '5560000000', entity_type: 'aktiebolag' } })
    const redovisare = await resolveRedovisare(supabase as never, 'company-1')
    expect(redovisare).toBe('165560000000')
  })

  it('throws when org number is missing', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { org_number: null, entity_type: 'aktiebolag' } })
    await expect(resolveRedovisare(supabase as never, 'company-1')).rejects.toThrow(/Organisationsnummer saknas/)
  })
})

describe('resolveRedovisningsperiod', () => {
  it('formats a calendar period as YYYYMM', async () => {
    const { supabase } = createQueuedMockSupabase()
    await expect(
      resolveRedovisningsperiod(supabase as never, 'company-1', { periodType: 'quarterly', year: 2026, period: 1 }),
    ).resolves.toBe('202603')
  })

  it('refuses to produce a period Skatteverket cannot read, before any request is built', async () => {
    const { supabase } = createQueuedMockSupabase()
    // The shape that reached Skatteverket as "undefinedundefined" (7 requests,
    // all 400): a caller that passed neither year nor a known period.
    for (const input of [
      { periodType: 'monthly', year: undefined, period: undefined },
      { periodType: 'weekly', year: 2026, period: 1 },
      { periodType: 'monthly', year: 2026, period: undefined },
      { periodType: 'quarterly', year: 2026, period: 5 },
    ]) {
      await expect(
        resolveRedovisningsperiod(supabase as never, 'company-1', input as never),
        JSON.stringify(input),
      ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' })
    }
  })
})

describe('buildMomsuppgift', () => {
  it('produces the same momsuppgift the route handler would (rutorToMomsuppgift over the GL rutor)', async () => {
    const rutor = zeroRutor()
    rutor.ruta10 = 250 // output VAT 25%
    rutor.ruta48 = 100 // input VAT
    mockCalculateVatDeclaration.mockResolvedValue({ rutor })

    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { org_number: '5560000000', entity_type: 'aktiebolag' } }) // resolveRedovisare

    const result = await buildMomsuppgift(supabase as never, 'company-1', { periodType: 'monthly', year: 2025, period: 3 })

    expect(result.redovisare).toBe('165560000000')
    expect(result.redovisningsperiod).toBe('202503')
    // Identical to the direct mapper output: locks the no-drift guarantee.
    expect(result.momsuppgift).toEqual(rutorToMomsuppgift(rutor))
    expect(result.momsuppgift.momsForsaljningUtgaendeHog).toBe(250)
    expect(result.momsuppgift.ingaendeMomsAvdrag).toBe(100)
    expect(result.momsuppgift.summaMoms).toBe(150)
    expect(mockCalculateVatDeclaration).toHaveBeenCalledWith(
      expect.anything(), 'company-1', 'monthly', 2025, 3, { fiscalPeriodId: undefined },
    )
    // Sub-annual periods are calendar periods: no fiscal-period lookup.
    expect(mockResolvePeriodDates).not.toHaveBeenCalled()
  })

  it('targets the FY-end month for a broken-FY yearly filer (SFL 26 kap 10-11 §§)', async () => {
    mockCalculateVatDeclaration.mockResolvedValue({ rutor: zeroRutor() })
    // Räkenskapsår 2025-07-01 → 2026-06-30: redovisningsperiod is 202606, not 202612.
    mockResolvePeriodDates.mockResolvedValue({ start: '2025-07-01', end: '2026-06-30' })

    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { org_number: '5560000000', entity_type: 'aktiebolag' } }) // resolveRedovisare

    const result = await buildMomsuppgift(supabase as never, 'company-1', {
      periodType: 'yearly', year: 2026, period: 1, fiscalPeriodId: 'fp-1',
    })

    expect(result.redovisningsperiod).toBe('202606')
    expect(mockResolvePeriodDates).toHaveBeenCalledWith(
      expect.anything(), 'company-1', 'yearly', 2026, 1, 'fp-1',
    )
    // The figures must describe the same räkenskapsår as the period id.
    expect(mockCalculateVatDeclaration).toHaveBeenCalledWith(
      expect.anything(), 'company-1', 'yearly', 2026, 1, { fiscalPeriodId: 'fp-1' },
    )
  })

  it('keeps the calendar-year fallback for yearly without a fiscal period', async () => {
    mockCalculateVatDeclaration.mockResolvedValue({ rutor: zeroRutor() })
    mockResolvePeriodDates.mockResolvedValue({ start: '2025-01-01', end: '2025-12-31' })

    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { org_number: '5560000000', entity_type: 'aktiebolag' } })

    const result = await buildMomsuppgift(supabase as never, 'company-1', {
      periodType: 'yearly', year: 2025, period: 1,
    })

    expect(result.redovisningsperiod).toBe('202512')
  })
})

describe('buildAgiUnderlag', () => {
  it('loads the latest XML and formats arbetsgivare + period', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { status: 'booked' } }) // salary_runs status guard
    enqueue({ data: { org_number: '5560000000', entity_type: 'aktiebolag' } }) // resolveRedovisare
    enqueue({ data: { xml_content: '<agi/>', period_year: 2026, period_month: 3 } }) // agi_declarations

    const result = await buildAgiUnderlag(supabase as never, 'company-1', 'sr-1')

    expect(result).toMatchObject({
      arbetsgivare: '165560000000',
      period: '202603',
      salaryRunId: 'sr-1',
      xml: '<agi/>',
      periodYear: 2026,
      periodMonth: 3,
    })
  })

  it('throws when the salary run is not past draft', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { status: 'draft' } })
    await expect(buildAgiUnderlag(supabase as never, 'company-1', 'sr-1')).rejects.toThrow(/efter granskning/)
  })

  it('throws when salaryRunId is missing', async () => {
    const { supabase } = createQueuedMockSupabase()
    await expect(buildAgiUnderlag(supabase as never, 'company-1', '')).rejects.toThrow(/salaryRunId/)
  })

  it('throws when no AGI XML exists', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { status: 'booked' } })
    enqueue({ data: { org_number: '5560000000', entity_type: 'aktiebolag' } })
    enqueue({ data: { xml_content: null, period_year: 2026, period_month: 3 } })
    await expect(buildAgiUnderlag(supabase as never, 'company-1', 'sr-1')).rejects.toThrow(/AGI-XML saknas/)
  })
})

describe('refreshAgiUnderlag (issue #69: submit regenerates an unfiled underlag)', () => {
  const GENERATED = { ok: true, xml: '<fresh/>', agiDeclarationId: 'agi-1', periodYear: 2026, periodMonth: 9 }
  const BOOKED_RUN = { status: 'booked', agi_generated_at: '2026-10-10T10:00:00Z', agi_submitted_at: null }

  it('regenerates an unfiled declaration through the one generator, comparing before it writes', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: BOOKED_RUN })
    enqueue({ data: { id: 'agi-1', status: 'generated', submitted_at: null } })
    mockGenerateAgiDeclaration.mockResolvedValue(GENERATED)

    const result = await refreshAgiUnderlag(supabase as never, 'company-1', 'user-1', 'sr-1')

    expect(result).toEqual({ ok: true, outcome: 'replaced' })
    expect(mockGenerateAgiDeclaration).toHaveBeenCalledTimes(1)
    expect(mockGenerateAgiDeclaration.mock.calls[0][0]).toMatchObject({
      supabase,
      companyId: 'company-1',
      userId: 'user-1',
      salaryRunId: 'sr-1',
      writeOnlyIfChanged: true,
    })
  })

  it('answers unchanged when the stored underlag already matches the fresh generation', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: BOOKED_RUN })
    enqueue({ data: { id: 'agi-1', status: 'pending_signature', submitted_at: null } })
    mockGenerateAgiDeclaration.mockResolvedValue({ ...GENERATED, unchanged: true })

    await expect(refreshAgiUnderlag(supabase as never, 'company-1', 'user-1', 'sr-1')).resolves.toEqual({
      ok: true,
      outcome: 'unchanged',
    })
  })

  it('answers filed when the declaration is filed between this check and the generator\'s own read', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: BOOKED_RUN })
    enqueue({ data: { id: 'agi-1', status: 'pending_signature', submitted_at: null } })
    mockGenerateAgiDeclaration.mockResolvedValue({ ...GENERATED, unchanged: true, filed: true })

    await expect(refreshAgiUnderlag(supabase as never, 'company-1', 'user-1', 'sr-1')).resolves.toEqual({
      ok: true,
      outcome: 'filed',
    })
  })

  it('regenerates a declaration Skatteverket refused at kontroll, the crm#1265 case', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: BOOKED_RUN })
    enqueue({ data: { id: 'agi-1', status: 'rejected', submitted_at: null } })
    mockGenerateAgiDeclaration.mockResolvedValue(GENERATED)

    await expect(refreshAgiUnderlag(supabase as never, 'company-1', 'user-1', 'sr-1')).resolves.toEqual({
      ok: true,
      outcome: 'replaced',
    })
  })

  it('generates a run that has no declaration yet', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { ...BOOKED_RUN, agi_generated_at: null } })
    enqueue({ data: null })
    mockGenerateAgiDeclaration.mockResolvedValue(GENERATED)

    await expect(refreshAgiUnderlag(supabase as never, 'company-1', 'user-1', 'sr-1')).resolves.toEqual({
      ok: true,
      outcome: 'replaced',
    })
  })

  it('never touches a declaration the run has filed (its own kvittens stamp)', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { ...BOOKED_RUN, agi_submitted_at: '2026-10-11T09:00:00Z' } })

    await expect(refreshAgiUnderlag(supabase as never, 'company-1', 'user-1', 'sr-1')).resolves.toEqual({
      ok: true,
      outcome: 'filed',
    })
    expect(mockGenerateAgiDeclaration).not.toHaveBeenCalled()
  })

  it('never touches an accepted declaration whose receipt covers the run\'s XML, even without the run stamp', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: BOOKED_RUN })
    enqueue({ data: { id: 'agi-1', status: 'submitted', submitted_at: '2026-10-11T09:00:00Z' } })

    await expect(refreshAgiUnderlag(supabase as never, 'company-1', 'user-1', 'sr-1')).resolves.toEqual({
      ok: true,
      outcome: 'filed',
    })
    expect(mockGenerateAgiDeclaration).not.toHaveBeenCalled()
  })

  it('regenerates a correction run whose row still carries the original\'s older receipt', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: BOOKED_RUN })
    // The original filed 29 Sept; the correction run regenerated over the row on 10 Oct.
    enqueue({ data: { id: 'agi-1', status: 'submitted', submitted_at: '2026-09-29T18:00:00Z' } })
    mockGenerateAgiDeclaration.mockResolvedValue(GENERATED)

    await expect(refreshAgiUnderlag(supabase as never, 'company-1', 'user-1', 'sr-1')).resolves.toEqual({
      ok: true,
      outcome: 'replaced',
    })
    expect(mockGenerateAgiDeclaration).toHaveBeenCalledTimes(1)
  })

  it('leaves a run that may not be submitted to buildAgiUnderlag\'s refusal', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { ...BOOKED_RUN, status: 'draft' } })

    await expect(refreshAgiUnderlag(supabase as never, 'company-1', 'user-1', 'sr-1')).resolves.toEqual({
      ok: true,
      outcome: 'skipped',
    })
    expect(mockGenerateAgiDeclaration).not.toHaveBeenCalled()
  })

  it('refuses with the generator\'s own Swedish message, never falling back to the stored XML', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: BOOKED_RUN })
    enqueue({ data: { id: 'agi-1', status: 'generated', submitted_at: null } })
    mockGenerateAgiDeclaration.mockResolvedValue({
      ok: false,
      code: 'AGI_INCOMPLETE_DATA',
      details: { missing_fields: ['telefon'], message: 'AGI kräver telefon.' },
    })

    const result = await refreshAgiUnderlag(supabase as never, 'company-1', 'user-1', 'sr-1')

    expect(result).toEqual({
      ok: false,
      code: 'AGI_INCOMPLETE_DATA',
      httpStatus: 400,
      error: 'AGI kräver telefon.',
      details: { missing_fields: ['telefon'], message: 'AGI kräver telefon.' },
    })
  })

  it('falls back to the registry sentence for a refusal without a message', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: BOOKED_RUN })
    enqueue({ data: { id: 'agi-1', status: 'generated', submitted_at: null } })
    mockGenerateAgiDeclaration.mockResolvedValue({
      ok: false,
      code: 'AGI_PERIOD_CONFLICT',
      details: { period: '2026-09', other_salary_run_id: 'sr-0', other_run_period: '2026-08' },
    })

    const result = await refreshAgiUnderlag(supabase as never, 'company-1', 'user-1', 'sr-1')

    expect(result).toMatchObject({ ok: false, code: 'AGI_PERIOD_CONFLICT', httpStatus: 409 })
    expect(result.ok === false && result.error).toMatch(/redovisningsperiod/)
  })
})
