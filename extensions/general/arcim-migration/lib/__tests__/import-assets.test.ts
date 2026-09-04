import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  categoryForAssetAccount,
  monthsBetween,
  mapFortnoxAsset,
  resolveAssetType,
  isImportableStatus,
  importProviderAssets,
  fortnoxAssetMarker,
  fortnoxNumberFromNotes,
  FortnoxAssetScopesRequiredError,
  FALLBACK_USEFUL_LIFE_MONTHS,
  type FortnoxAsset,
  type FortnoxAssetType,
} from '../import-assets'

vi.mock('@/lib/providers/resolve-consent', () => ({
  resolveConsent: vi.fn(),
}))
vi.mock('@/lib/bokslut/assets/asset-service', () => ({
  createAsset: vi.fn(),
}))
// The journal engine must never be touched by the asset import: the values
// already arrived via SIE. Mock it so any call is visible as a failure.
vi.mock('@/lib/bookkeeping/engine', () => ({
  createJournalEntry: vi.fn(),
  createDraftEntry: vi.fn(),
  commitEntry: vi.fn(),
}))

import { resolveConsent } from '@/lib/providers/resolve-consent'
import { createAsset } from '@/lib/bokslut/assets/asset-service'
import * as engine from '@/lib/bookkeeping/engine'

const resolveConsentMock = vi.mocked(resolveConsent)
const createAssetMock = vi.mocked(createAsset)

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
}

function routeFetch(
  fetchSpy: ReturnType<typeof vi.spyOn>,
  routes: { match: string; respond: () => Response }[],
) {
  fetchSpy.mockImplementation(((input: RequestInfo | URL) => {
    const url = String(input)
    const route = routes.find((r) => url.includes(r.match))
    if (!route) {
      return Promise.resolve(new Response(`no mock for ${url}`, { status: 404 }))
    }
    return Promise.resolve(route.respond())
  }) as typeof fetch)
}

/** Chainable supabase mock answering the existing-assets dedupe read. */
function mockSupabaseWithExistingAssets(
  rows: { name: string; acquisition_date: string; notes?: string | null }[],
) {
  const builder = {
    select: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    range: vi.fn().mockResolvedValue({ data: rows, error: null }),
  }
  return { from: vi.fn(() => builder) } as never
}

const EQUIPMENT_TYPE: FortnoxAssetType = {
  Id: 1,
  Number: 'INV',
  Description: 'Inventarier',
  AccountAsset: 1220,
  AccountDepreciation: 1229,
  AccountValueLoss: 7832,
}

const LAPTOP: FortnoxAsset = {
  Number: 'A-1',
  Description: 'MacBook Pro',
  AcquisitionDate: '2024-03-01',
  AcquisitionStart: '2024-03-01',
  AcquisitionValue: 30000,
  DepreciationFinal: '2027-03-01',
  DepreciatedTo: '2026-06-30',
  Status: 'ACTIVE',
  TypeId: 1,
}

describe('categoryForAssetAccount', () => {
  it('maps BAS classes to categories per the assets table ranges', () => {
    expect(categoryForAssetAccount('1030')).toBe('immaterial')
    expect(categoryForAssetAccount('1110')).toBe('building')
    expect(categoryForAssetAccount('1150')).toBe('land_improvement')
    expect(categoryForAssetAccount('1210')).toBe('machinery')
    expect(categoryForAssetAccount('1220')).toBe('equipment')
    expect(categoryForAssetAccount('1240')).toBe('vehicle')
    expect(categoryForAssetAccount('1250')).toBe('computer')
    expect(categoryForAssetAccount('1280')).toBe('other_tangible')
  })

  it('rejects non-asset accounts and malformed strings', () => {
    expect(categoryForAssetAccount('1930')).toBeNull()
    expect(categoryForAssetAccount('12')).toBeNull()
    expect(categoryForAssetAccount(null)).toBeNull()
  })
})

describe('monthsBetween', () => {
  it('computes whole months and never returns less than 1', () => {
    expect(monthsBetween('2024-03-01', '2027-03-01')).toBe(36)
    expect(monthsBetween('2024-01-01', '2024-01-15')).toBe(1)
  })
})

describe('isImportableStatus', () => {
  it('keeps active and fully depreciated assets', () => {
    expect(isImportableStatus('ACTIVE')).toBe(true)
    expect(isImportableStatus('FULLY_DEPRECIATED')).toBe(true)
    expect(isImportableStatus(undefined)).toBe(true)
  })

  it('drops sold, scrapped, deleted, voided and not-yet-active assets', () => {
    expect(isImportableStatus('SOLD')).toBe(false)
    expect(isImportableStatus('SCRAPPED')).toBe(false)
    expect(isImportableStatus('DELETED')).toBe(false)
    expect(isImportableStatus('VOIDED')).toBe(false)
    expect(isImportableStatus('CANCELLED')).toBe(false)
    expect(isImportableStatus('CANCELED')).toBe(false)
    expect(isImportableStatus('NOT_ACTIVE')).toBe(false)
  })
})

describe('mapFortnoxAsset', () => {
  it('maps a Fortnox asset with its type accounts', () => {
    const mapped = mapFortnoxAsset(LAPTOP, EQUIPMENT_TYPE)
    expect('input' in mapped).toBe(true)
    if (!('input' in mapped)) return
    expect(mapped.input).toMatchObject({
      name: 'MacBook Pro',
      category: 'equipment',
      acquisition_date: '2024-03-01',
      acquisition_cost: 30000,
      useful_life_months: 36,
      bas_asset_account: '1220',
      bas_accumulated_account: '1229',
      bas_expense_account: '7832',
    })
    expect(mapped.input.notes).toContain('A-1')
    expect(mapped.input.notes).toContain('2026-06-30')
  })

  it('falls back to the K2 schablon when no depreciation window exists', () => {
    const mapped = mapFortnoxAsset({ ...LAPTOP, DepreciationFinal: null }, EQUIPMENT_TYPE)
    if (!('input' in mapped)) throw new Error('expected mapped input')
    expect(mapped.input.useful_life_months).toBe(FALLBACK_USEFUL_LIFE_MONTHS)
  })

  it('drops account overrides that are not shaped like the expected BAS class', () => {
    const type: FortnoxAssetType = {
      ...EQUIPMENT_TYPE,
      AccountDepreciation: 7832, // not a 1xx9 balance account
      AccountValueLoss: 1229, // not a 78xx cost account
    }
    const mapped = mapFortnoxAsset(LAPTOP, type)
    if (!('input' in mapped)) throw new Error('expected mapped input')
    expect(mapped.input.bas_accumulated_account).toBeUndefined()
    expect(mapped.input.bas_expense_account).toBeUndefined()
  })

  it('reports assets without value or date as unsupported', () => {
    expect(mapFortnoxAsset({ ...LAPTOP, AcquisitionValue: 0 }, EQUIPMENT_TYPE)).toEqual({
      reason: 'unsupported',
    })
    expect(
      mapFortnoxAsset(
        { ...LAPTOP, AcquisitionDate: null, AcquisitionStart: null },
        EQUIPMENT_TYPE,
      ),
    ).toEqual({ reason: 'unsupported' })
  })
})

describe('fortnoxNumberFromNotes', () => {
  it('round-trips the marker and tolerates surrounding text', () => {
    expect(fortnoxNumberFromNotes(fortnoxAssetMarker('A-1'))).toBe('A-1')
    expect(fortnoxNumberFromNotes(`${fortnoxAssetMarker('7')} Avskriven t.o.m. 2026-06-30.`)).toBe('7')
    expect(fortnoxNumberFromNotes('Egen anteckning utan markör')).toBeNull()
    expect(fortnoxNumberFromNotes(null)).toBeNull()
  })
})

describe('importProviderAssets', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    vi.clearAllMocks()
    fetchSpy = vi.spyOn(globalThis, 'fetch')
    resolveConsentMock.mockResolvedValue({
      consent: { provider: 'fortnox' },
      accessToken: 'token-1',
    } as never)
    createAssetMock.mockResolvedValue({ id: 'asset-1' } as never)
  })

  afterEach(() => {
    fetchSpy.mockRestore()
  })

  const options = {
    companyId: 'company-1',
    userId: 'user-1',
    consentId: 'consent-1',
  }

  it('imports active assets and never touches the journal engine', async () => {
    routeFetch(fetchSpy, [
      {
        match: '/assets/types',
        respond: () => jsonResponse({ Types: [EQUIPMENT_TYPE] }),
      },
      {
        match: '/assets',
        respond: () =>
          jsonResponse({
            Assets: [LAPTOP, { ...LAPTOP, Number: 'A-2', Description: 'Skrivbord', Status: 'SOLD' }],
          }),
      },
    ])

    const result = await importProviderAssets({
      ...options,
      supabase: mockSupabaseWithExistingAssets([]),
    })

    expect(result).toMatchObject({
      total: 2,
      imported: 1,
      skipped: 1,
      skipReasons: { inactive: 1 },
    })
    expect(createAssetMock).toHaveBeenCalledTimes(1)
    expect(engine.createJournalEntry).not.toHaveBeenCalled()
    expect(engine.createDraftEntry).not.toHaveBeenCalled()
  })

  it('skips an already-imported asset by its Fortnox number even after a rename', async () => {
    routeFetch(fetchSpy, [
      { match: '/assets/types', respond: () => jsonResponse({ Types: [EQUIPMENT_TYPE] }) },
      { match: '/assets', respond: () => jsonResponse({ Assets: [LAPTOP] }) },
    ])

    const result = await importProviderAssets({
      ...options,
      supabase: mockSupabaseWithExistingAssets([
        // Renamed locally after the first import: only the notes marker
        // still ties the row to Fortnox asset A-1.
        {
          name: 'Bärbar dator (byt namn)',
          acquisition_date: '2024-03-01',
          notes: fortnoxAssetMarker('A-1'),
        },
      ]),
    })

    expect(result).toMatchObject({
      total: 1,
      imported: 0,
      skipped: 1,
      skipReasons: { duplicate: 1 },
    })
    expect(createAssetMock).not.toHaveBeenCalled()
  })

  it('falls back to name + acquisition date for rows without a marker', async () => {
    routeFetch(fetchSpy, [
      { match: '/assets/types', respond: () => jsonResponse({ Types: [EQUIPMENT_TYPE] }) },
      { match: '/assets', respond: () => jsonResponse({ Assets: [{ ...LAPTOP, Number: null }] }) },
    ])

    const result = await importProviderAssets({
      ...options,
      supabase: mockSupabaseWithExistingAssets([
        { name: 'MacBook Pro', acquisition_date: '2024-03-01', notes: null },
      ]),
    })

    expect(result).toMatchObject({ imported: 0, skipped: 1, skipReasons: { duplicate: 1 } })
    expect(createAssetMock).not.toHaveBeenCalled()
  })

  it('skips a numbered asset colliding with a markerless existing row on name and date', async () => {
    routeFetch(fetchSpy, [
      { match: '/assets/types', respond: () => jsonResponse({ Types: [EQUIPMENT_TYPE] }) },
      { match: '/assets', respond: () => jsonResponse({ Assets: [LAPTOP] }) },
    ])

    const result = await importProviderAssets({
      ...options,
      supabase: mockSupabaseWithExistingAssets([
        // Hand-created before any import: no marker ties it to Fortnox, but
        // re-inserting A-1 over it would duplicate the asset.
        { name: 'MacBook Pro', acquisition_date: '2024-03-01', notes: null },
      ]),
    })

    expect(result).toMatchObject({
      total: 1,
      imported: 0,
      skipped: 1,
      skipReasons: { duplicate: 1 },
    })
    expect(createAssetMock).not.toHaveBeenCalled()
  })

  it('imports two assets sharing name and date when their Fortnox numbers differ', async () => {
    routeFetch(fetchSpy, [
      { match: '/assets/types', respond: () => jsonResponse({ Types: [EQUIPMENT_TYPE] }) },
      {
        match: '/assets',
        respond: () =>
          jsonResponse({ Assets: [LAPTOP, { ...LAPTOP, Number: 'A-9' }] }),
      },
    ])

    const result = await importProviderAssets({
      ...options,
      supabase: mockSupabaseWithExistingAssets([]),
    })

    expect(result).toMatchObject({ total: 2, imported: 2, skipped: 0 })
    expect(createAssetMock).toHaveBeenCalledTimes(2)
  })

  it('throws FortnoxAssetScopesRequiredError on a scope/licence refusal', async () => {
    routeFetch(fetchSpy, [
      {
        match: '/assets',
        respond: () =>
          new Response(
            JSON.stringify({
              ErrorInformation: {
                error: 1,
                message: 'Det finns ingen aktiv licens för önskat scope.',
                code: 2001101,
              },
            }),
            { status: 400 },
          ),
      },
    ])

    await expect(
      importProviderAssets({ ...options, supabase: mockSupabaseWithExistingAssets([]) }),
    ).rejects.toBeInstanceOf(FortnoxAssetScopesRequiredError)
    expect(createAssetMock).not.toHaveBeenCalled()
  })

  it('returns null for providers without an asset register API', async () => {
    resolveConsentMock.mockResolvedValue({
      consent: { provider: 'visma' },
      accessToken: 'token-2',
    } as never)

    const result = await importProviderAssets({
      ...options,
      supabase: mockSupabaseWithExistingAssets([]),
    })

    expect(result).toBeNull()
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('counts a per-asset insert failure without aborting the step', async () => {
    routeFetch(fetchSpy, [
      { match: '/assets/types', respond: () => jsonResponse({ Types: [EQUIPMENT_TYPE] }) },
      {
        match: '/assets',
        respond: () =>
          jsonResponse({
            Assets: [LAPTOP, { ...LAPTOP, Number: 'A-3', Description: 'Server' }],
          }),
      },
    ])
    createAssetMock
      .mockRejectedValueOnce(new Error('insert failed'))
      .mockResolvedValueOnce({ id: 'asset-2' } as never)

    const result = await importProviderAssets({
      ...options,
      supabase: mockSupabaseWithExistingAssets([]),
    })

    expect(result).toMatchObject({
      total: 2,
      imported: 1,
      skipped: 1,
      skipReasons: { failed: 1 },
      errorSample: 'insert failed',
    })
  })
})

/**
 * An asset acquired mid-month lost a month of its life: the plan running
 * 2026-05-28 to 2031-04-30 is 60 months on the calendar, and the day-counting
 * form made it 59. Every such asset then depreciated slightly too fast.
 */
describe('monthsBetween on the month grid', () => {
  it('counts a mid-month plan as the whole 60 months', () => {
    expect(monthsBetween('2026-05-01', '2031-04-30')).toBe(60)
  })

  // Fortnox does not document whether DepreciationFinal is the last day of the
  // final month or the first day after it. Both have to give the same life.
  it('reads both end-date conventions the same way', () => {
    expect(monthsBetween('2026-05-01', '2031-04-30')).toBe(
      monthsBetween('2026-05-01', '2031-05-01'),
    )
  })

  it('keeps a whole-month plan unchanged', () => {
    expect(monthsBetween('2024-03-01', '2027-03-01')).toBe(36)
  })

  it('never returns less than a month', () => {
    expect(monthsBetween('2026-05-01', '2026-05-01')).toBe(1)
  })
})

/**
 * The account triple lives on the asset type. The list endpoint reports the
 * type as a label and does not always carry TypeId, so an id-only lookup found
 * nothing and the asset fell back to its category default: a register whose
 * ledger sits on 1010 arriving on 1290.
 */
describe('resolveAssetType', () => {
  const TYPES: FortnoxAssetType[] = [
    {
      Id: 7,
      Number: '1300',
      Description: 'Utveckling',
      AccountAsset: 1010,
      AccountDepreciation: 1019,
      AccountValueLoss: 7811,
    },
  ]
  const byId = new Map(TYPES.map((type) => [type.Id as number, type]))

  it('finds the type by id when the payload carries one', () => {
    expect(resolveAssetType({ TypeId: 7 }, byId, TYPES)).toBe(TYPES[0])
  })

  it('finds the type by its label when no id is given', () => {
    expect(resolveAssetType({ Type: '1300 - Utveckling' }, byId, TYPES)).toBe(TYPES[0])
  })

  it('accepts the number or the description alone', () => {
    expect(resolveAssetType({ Type: '1300' }, byId, TYPES)).toBe(TYPES[0])
    expect(resolveAssetType({ Type: 'Utveckling' }, byId, TYPES)).toBe(TYPES[0])
  })

  it('ignores case and surrounding space', () => {
    expect(resolveAssetType({ Type: '  utveckling ' }, byId, TYPES)).toBe(TYPES[0])
  })

  it('returns nothing when neither id nor label matches', () => {
    expect(resolveAssetType({ Type: 'Något annat' }, byId, TYPES)).toBeUndefined()
    expect(resolveAssetType({}, byId, TYPES)).toBeUndefined()
  })

  // The whole point: with the type found, the asset lands on the accounts its
  // ledger uses instead of the category default.
  it('puts the asset on the type accounts once the type is found', () => {
    const mapped = mapFortnoxAsset(
      {
        Number: '6',
        Description: 'Utvecklingsprojekt',
        AcquisitionDate: '2026-05-28',
        AcquisitionStart: '2026-05-01',
        AcquisitionValue: 3_500_000,
        DepreciationFinal: '2031-04-30',
        Type: '1300 - Utveckling',
      },
      resolveAssetType({ Type: '1300 - Utveckling' }, byId, TYPES),
    )
    if (!('input' in mapped)) throw new Error('expected mapped input')
    expect(mapped.input.bas_asset_account).toBe('1010')
    expect(mapped.input.category).toBe('immaterial')
    expect(mapped.input.useful_life_months).toBe(60)
  })
})

/**
 * Review of #2266 raised both of these: the label fallback picking silently
 * among several candidates, and an unresolvable type still landing the asset
 * on a category default with nothing said about it.
 */
describe('resolveAssetType refuses to guess', () => {
  const base = { AccountAsset: 1010, AccountDepreciation: 1019, AccountValueLoss: 7811 }

  it('returns nothing when two types share the number the label names', () => {
    const types: FortnoxAssetType[] = [
      { Id: 1, Number: '1300', Description: 'Utveckling', ...base },
      { Id: 2, Number: '1300', Description: 'Programvara', ...base },
    ]
    expect(resolveAssetType({ Type: '1300' }, new Map(), types)).toBeUndefined()
  })

  it('returns nothing when two types share the description the label names', () => {
    const types: FortnoxAssetType[] = [
      { Id: 1, Number: '1220', Description: 'Inventarier', ...base },
      { Id: 2, Number: '1230', Description: 'Inventarier', ...base },
    ]
    expect(resolveAssetType({ Type: 'Inventarier' }, new Map(), types)).toBeUndefined()
  })

  // The combined form identifies a type, so it still resolves even when the
  // number alone would have been ambiguous.
  it('still resolves on the combined form when only the number is shared', () => {
    const types: FortnoxAssetType[] = [
      { Id: 1, Number: '1300', Description: 'Utveckling', ...base },
      { Id: 2, Number: '1300', Description: 'Programvara', ...base },
    ]
    expect(resolveAssetType({ Type: '1300 - Programvara' }, new Map(), types)?.Id).toBe(2)
  })
})
