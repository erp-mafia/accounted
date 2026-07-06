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
vi.mock('@/lib/reports/vat-declaration', () => ({
  calculateVatDeclaration: (...a: unknown[]) => mockCalculateVatDeclaration(...a),
}))

import { buildMomsuppgift, buildAgiUnderlag, resolveRedovisare } from '../lib/declaration-prep'
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
    expect(mockCalculateVatDeclaration).toHaveBeenCalledWith(expect.anything(), 'company-1', 'monthly', 2025, 3)
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
