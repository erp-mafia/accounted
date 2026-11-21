import { describe, expect, it, vi, beforeEach } from 'vitest'

vi.mock('@/lib/company/entity-type', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/company/entity-type')>()),
  resolveCompanyEntityType: vi.fn(async () => 'enskild_firma'),
}))
vi.mock('../enskild-firma/ef-declaration-preview', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../enskild-firma/ef-declaration-preview')>()),
  computeEfDeclarationPreview: vi.fn(),
}))

import { createQueuedMockSupabase } from '@/tests/helpers'
import { resolveCompanyEntityType } from '@/lib/company/entity-type'
import {
  computeEfDeclarationPreview,
  EfDeclarationNotApplicableError,
  type EfDeclarationPreview,
} from '../enskild-firma/ef-declaration-preview'
import {
  carriedInputs,
  loadNeDeclarationInputs,
  NeDeclarationInputsSchema,
  saveNeDeclarationInputs,
} from '../enskild-firma/declaration-inputs'

const RUTOR = { R12: 300_000, R13: 0, R14: 0, R29: 300_000, R30: 0, R31: 0, R32: 20_000, R33: 320_000, R34: 50_000, R35: 270_000, R36: 30_000, R37: 0, R40: 55_000, R41: 60_000, R42: 235_000, R43: 58_750 }

function preview(over: Partial<EfDeclarationPreview> = {}): EfDeclarationPreview {
  return {
    fiscalPeriod: { id: 'period-0', name: '2024', period_start: '2024-01-01', period_end: '2024-12-31' },
    bookedSurplus: 300_000,
    items: [],
    pfondFonder: [
      { cohort_year: 2018, balance: 20_000, latest_return_year: 2024, status: 'mandatory' },
      { cohort_year: 2021, balance: 15_000, latest_return_year: 2027, status: 'optional' },
    ],
    rutor: RUTOR,
    ovrigaUppgifter: [{ faltkod: '8011', label: 'Sparat fördelningsbelopp', amount: 4_000 }],
    warnings: [],
    ...over,
  } as EfDeclarationPreview
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(resolveCompanyEntityType).mockResolvedValue('enskild_firma')
})

describe('carriedInputs: what last year hands on', () => {
  it("takes R40 from last year's R43, the funds that stay plus last year's avsättning, the expansionsfond and 8011", () => {
    const carried = carriedInputs(
      { category: 'full', expansionsfondExistingBalance: 100_000, priorYearActualCharged: 61_000, kapitalunderlag: 400_000 },
      preview(),
      2024,
    )
    expect(carried).toEqual({
      category: 'full',
      priorYearSchablonavdrag: 58_750,
      pfondExistingFonder: [
        { cohort_year: 2021, balance: 15_000 },
        { cohort_year: 2024, balance: 50_000 },
      ],
      expansionsfondExistingBalance: 130_000,
      sparatFordelningsbelopp: 4_000,
    })
  })

  it('carries nothing that last year did not have, and never R41 or a kapitalunderlag', () => {
    const carried = carriedInputs(
      {},
      preview({ pfondFonder: [], rutor: { ...RUTOR, R34: 0, R36: 0, R43: 0 }, ovrigaUppgifter: [] }),
      2024,
    )
    expect(carried).toEqual({})
    expect(NeDeclarationInputsSchema.parse(carried)).toEqual({})
  })
})

describe('loadNeDeclarationInputs', () => {
  it("returns this year's saved row", async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { inputs: { category: 'pensioner', kapitalunderlag: 1_000 } } })

    const loaded = await loadNeDeclarationInputs(supabase as never, 'company-1', 'period-1')

    expect(loaded).toEqual({ inputs: { category: 'pensioner', kapitalunderlag: 1_000 }, source: 'saved' })
    expect(computeEfDeclarationPreview).not.toHaveBeenCalled()
  })

  it('treats a stored value that no longer fits the schema as not entered', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { inputs: { category: 'retired' } } })

    const loaded = await loadNeDeclarationInputs(supabase as never, 'company-1', 'period-1')

    expect(loaded).toEqual({ inputs: {}, source: 'saved' })
  })

  it("carries last year's saved inputs through last year's preview when nothing is saved", async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: null }) // this year's row
    enqueue({ data: { period_start: '2025-01-01' } }) // this year
    enqueue({ data: { id: 'period-0', name: '2024', period_end: '2024-12-31' } }) // last year
    enqueue({ data: { inputs: { category: 'full' } } }) // last year's row
    vi.mocked(computeEfDeclarationPreview).mockResolvedValue(preview())

    const loaded = await loadNeDeclarationInputs(supabase as never, 'company-1', 'period-1')

    expect(loaded.source).toBe('carried')
    expect(loaded.carriedFrom).toEqual({ fiscalPeriodId: 'period-0', name: '2024' })
    expect(loaded.inputs.priorYearSchablonavdrag).toBe(58_750)
    expect(computeEfDeclarationPreview).toHaveBeenCalledWith(supabase, 'company-1', 'period-0', {
      category: 'full',
      entityType: 'enskild_firma',
    })
  })

  it('has nothing when neither year is saved', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: null })
    enqueue({ data: { period_start: '2025-01-01' } })
    enqueue({ data: { id: 'period-0', name: '2024', period_end: '2024-12-31' } })
    enqueue({ data: null })

    expect(await loadNeDeclarationInputs(supabase as never, 'company-1', 'period-1')).toEqual({ inputs: {}, source: 'none' })
  })

  it('refuses a form that does not file NE-bilagan', async () => {
    const { supabase } = createQueuedMockSupabase()
    vi.mocked(resolveCompanyEntityType).mockResolvedValue('aktiebolag')

    await expect(loadNeDeclarationInputs(supabase as never, 'company-1', 'period-1')).rejects.toBeInstanceOf(
      EfDeclarationNotApplicableError,
    )
    await expect(
      saveNeDeclarationInputs(supabase as never, 'company-1', 'period-1', 'user-1', {}),
    ).rejects.toBeInstanceOf(EfDeclarationNotApplicableError)
  })
})
