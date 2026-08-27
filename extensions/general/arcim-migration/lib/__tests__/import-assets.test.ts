import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  categoryForAssetAccount,
  monthsBetween,
  mapFortnoxAsset,
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
