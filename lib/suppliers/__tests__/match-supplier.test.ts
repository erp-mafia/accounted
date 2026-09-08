import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  matchSupplierByIdentity,
  matchSupplierId,
  supplierIdentityFrom,
  vatNumberKey,
  vatNumbersMatch,
} from '../match-supplier'

/**
 * Minimal suppliers-table stub. The matcher issues three shapes of query and
 * they are distinguishable by terminator: the exact org_number lookup (only
 * for values that are not Swedish org numbers) and the name lookup end in
 * maybeSingle(); the org_number and vat_number scans go through
 * fetchAllRows, end in range(), and are told apart by the `.not(column)`
 * filter that precedes them.
 */
function makeSupabase(rows: {
  byOrgNumber?: { id: string } | null
  byName?: { id: string } | null
  withOrgNumber?: { id: string; org_number: string | null }[]
  withVatNumber?: { id: string; vat_number: string | null }[]
  orgScanError?: { message: string }
  vatScanError?: { message: string }
}) {
  const calls: { column: string; value: unknown }[] = []

  const chain = (): Record<string, unknown> => {
    const self: Record<string, unknown> = {}
    let scanColumn: string | null = null
    self.select = () => self
    self.eq = (column: string, value: unknown) => {
      if (column !== 'company_id') calls.push({ column, value })
      return self
    }
    self.ilike = (column: string, value: unknown) => {
      calls.push({ column: `ilike:${column}`, value })
      return self
    }
    self.not = (column: string) => {
      scanColumn = column
      calls.push({ column: `scan:${column}`, value: null })
      return self
    }
    self.is = (column: string, value: unknown) => {
      calls.push({ column: `is:${column}`, value })
      return self
    }
    self.order = () => self
    self.limit = () => self
    self.maybeSingle = () => {
      const last = calls[calls.length - 1]
      if (last?.column === 'org_number') {
        return Promise.resolve({ data: rows.byOrgNumber ?? null, error: null })
      }
      return Promise.resolve({ data: rows.byName ?? null, error: null })
    }
    self.range = () => {
      if (scanColumn === 'org_number') {
        return Promise.resolve(
          rows.orgScanError
            ? { data: null, error: rows.orgScanError }
            : { data: rows.withOrgNumber ?? [], error: null },
        )
      }
      return Promise.resolve(
        rows.vatScanError
          ? { data: null, error: rows.vatScanError }
          : { data: rows.withVatNumber ?? [], error: null },
      )
    }
    return self
  }

  return {
    supabase: { from: () => chain() } as unknown as SupabaseClient,
    calls,
  }
}

describe('vatNumberKey', () => {
  it('strips formatting and uppercases', () => {
    expect(vatNumberKey('se 556012-5790 01')).toBe('SE556012579001')
    expect(vatNumberKey('IE6364992H')).toBe('IE6364992H')
  })

  it('rejects values too short to identify anything', () => {
    expect(vatNumberKey('SE')).toBeNull()
    expect(vatNumberKey('-')).toBeNull()
    expect(vatNumberKey('')).toBeNull()
    expect(vatNumberKey(null)).toBeNull()
    expect(vatNumberKey(undefined)).toBeNull()
  })
})

describe('vatNumbersMatch', () => {
  it('matches across formatting variants', () => {
    expect(vatNumbersMatch('IE 6364992 H', 'ie6364992h')).toBe(true)
  })

  it('matches when only one side carries the country prefix', () => {
    expect(vatNumbersMatch('SE556012579001', '556012579001')).toBe(true)
    expect(vatNumbersMatch('556012579001', 'SE556012579001')).toBe(true)
  })

  it('keeps different countries distinct', () => {
    expect(vatNumbersMatch('IE6364992H', 'SE6364992H')).toBe(false)
  })

  it('never matches on a missing value', () => {
    expect(vatNumbersMatch(null, 'IE6364992H')).toBe(false)
    expect(vatNumbersMatch('IE6364992H', null)).toBe(false)
    expect(vatNumbersMatch(null, null)).toBe(false)
  })
})

describe('supplierIdentityFrom', () => {
  it('reads the extraction schema shape', () => {
    expect(
      supplierIdentityFrom({
        name: 'Adobe Systems Software Ireland Ltd',
        orgNumber: null,
        vatNumber: 'IE6364992H',
      }),
    ).toEqual({
      name: 'Adobe Systems Software Ireland Ltd',
      orgNumber: null,
      vatNumber: 'IE6364992H',
    })
  })

  it('accepts the legacy organizationNumber spelling', () => {
    expect(supplierIdentityFrom({ organizationNumber: '5566778899' }).orgNumber).toBe('5566778899')
  })

  it('treats blank strings and non-strings as absent', () => {
    expect(supplierIdentityFrom({ name: '  ', vatNumber: 42 })).toEqual({
      name: null,
      orgNumber: null,
      vatNumber: null,
    })
    expect(supplierIdentityFrom(null)).toEqual({ name: null, orgNumber: null, vatNumber: null })
  })
})

describe('matchSupplierByIdentity', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('prefers org_number over everything else', async () => {
    const { supabase } = makeSupabase({
      withOrgNumber: [{ id: 'by-org', org_number: '5566778899' }],
      withVatNumber: [{ id: 'by-vat', vat_number: 'SE556012579001' }],
      byName: { id: 'by-name' },
    })
    const match = await matchSupplierByIdentity(supabase, 'company-1', {
      orgNumber: '5566778899',
      vatNumber: 'SE556012579001',
      name: 'Acme AB',
    })
    expect(match).toEqual({ supplierId: 'by-org', matchedOn: 'org_number' })
  })

  // #2391: the form stores 556677-8899, the extractor emits 5566778899.
  it('matches org_number across every spelling of the same identity', async () => {
    const register = [
      { id: 'hyphen', org_number: '556677-8899' },
      { id: 'other', org_number: '5560125790' },
      { id: 'twelve', org_number: '198001011231' },
    ]
    const cases: [string, string][] = [
      ['5566778899', 'hyphen'],
      ['556677-8899', 'hyphen'],
      ['165566778899', 'hyphen'],
      ['16556677-8899', 'hyphen'],
      ['556677 8899', 'hyphen'],
      ['800101-1231', 'twelve'],
      ['8001011231', 'twelve'],
    ]
    for (const [extracted, expected] of cases) {
      const { supabase, calls } = makeSupabase({ withOrgNumber: register, byName: { id: 'by-name' } })
      const match = await matchSupplierByIdentity(supabase, 'company-1', {
        orgNumber: extracted,
        name: 'A brand name that is not the registered one',
      })
      expect(match, extracted).toEqual({ supplierId: expected, matchedOn: 'org_number' })
      expect(calls.some((c) => c.column === 'ilike:name'), extracted).toBe(false)
    }
  })

  it('scans live suppliers only', async () => {
    const { supabase, calls } = makeSupabase({
      withOrgNumber: [{ id: 'live', org_number: '5566778899' }],
    })
    await matchSupplierByIdentity(supabase, 'company-1', { orgNumber: '556677-8899' })
    expect(calls).toContainEqual({ column: 'is:archived_at', value: null })
  })

  it('does not treat a VAT number or a foreign number as a Swedish org number', async () => {
    // 556677889901 is orgnr + 01; its last 10 digits are somebody else.
    const { supabase, calls } = makeSupabase({
      withOrgNumber: [{ id: 'wrong', org_number: '6677889901' }],
      byOrgNumber: null,
    })
    for (const value of ['SE556677889901', '556677889901', 'BE0123456789']) {
      const match = await matchSupplierByIdentity(supabase, 'company-1', { orgNumber: value })
      expect(match, value).toBeNull()
    }
    expect(calls.some((c) => c.column === 'scan:org_number')).toBe(false)
  })

  it('never matches junk in the register against a real org number', async () => {
    const { supabase } = makeSupabase({
      withOrgNumber: [
        { id: 'junk', org_number: '12345' },
        { id: 'foreign', org_number: 'DK12345678' },
      ],
      byName: null,
    })
    const match = await matchSupplierByIdentity(supabase, 'company-1', { orgNumber: '5566778899' })
    expect(match).toBeNull()
  })

  it('falls back to an exact lookup for a value that is not a Swedish org number', async () => {
    const { supabase, calls } = makeSupabase({ byOrgNumber: { id: 'foreign' } })
    const match = await matchSupplierByIdentity(supabase, 'company-1', { orgNumber: 'DK12345678' })
    expect(match).toEqual({ supplierId: 'foreign', matchedOn: 'org_number' })
    expect(calls).toContainEqual({ column: 'org_number', value: 'DK12345678' })
    expect(calls.some((c) => c.column === 'scan:org_number')).toBe(false)
  })

  it('falls through to vat_number and name when the org_number scan fails', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { supabase } = makeSupabase({
      orgScanError: { message: 'connection reset' },
      withVatNumber: [{ id: 'by-vat', vat_number: 'SE556677889901' }],
    })
    const match = await matchSupplierByIdentity(supabase, 'company-1', {
      orgNumber: '5566778899',
      vatNumber: 'SE556677889901',
    })
    expect(match).toEqual({ supplierId: 'by-vat', matchedOn: 'vat_number' })
    consoleSpy.mockRestore()
  })

  it('falls back to vat_number when there is no org number: the Adobe case', async () => {
    const { supabase } = makeSupabase({
      byOrgNumber: null,
      withVatNumber: [
        { id: 'other', vat_number: 'DE123456789' },
        { id: 'adobe', vat_number: 'IE6364992H' },
      ],
      byName: null,
    })
    const match = await matchSupplierByIdentity(supabase, 'company-1', {
      orgNumber: null,
      vatNumber: 'IE6364992H',
      name: 'Adobe Systems Software Ireland Ltd',
    })
    expect(match).toEqual({ supplierId: 'adobe', matchedOn: 'vat_number' })
  })

  it('falls through to name when no identifier matches', async () => {
    const { supabase, calls } = makeSupabase({
      byOrgNumber: null,
      withVatNumber: [{ id: 'other', vat_number: 'DE123456789' }],
      byName: { id: 'by-name' },
    })
    const match = await matchSupplierByIdentity(supabase, 'company-1', {
      orgNumber: null,
      vatNumber: 'IE6364992H',
      name: 'Adobe Systems Software Ireland Ltd',
    })
    expect(match).toEqual({ supplierId: 'by-name', matchedOn: 'name' })
    expect(calls.some((c) => c.column === 'ilike:name')).toBe(true)
  })

  it('escapes LIKE metacharacters in the name lookup', async () => {
    const { supabase, calls } = makeSupabase({ byName: { id: 'by-name' } })
    await matchSupplierByIdentity(supabase, 'company-1', { name: '100 % Solutions_AB' })
    const nameCall = calls.find((c) => c.column === 'ilike:name')
    expect(nameCall?.value).toBe('100 \\% Solutions\\_AB')
  })

  it('returns null when nothing matches', async () => {
    const { supabase } = makeSupabase({ byOrgNumber: null, withVatNumber: [], byName: null })
    const match = await matchSupplierByIdentity(supabase, 'company-1', {
      orgNumber: null,
      vatNumber: 'IE6364992H',
      name: 'Unknown Ltd',
    })
    expect(match).toBeNull()
  })

  it('skips lookups entirely for an empty identity', async () => {
    const { supabase, calls } = makeSupabase({})
    const match = await matchSupplierByIdentity(supabase, 'company-1', {
      orgNumber: null,
      vatNumber: null,
      name: null,
    })
    expect(match).toBeNull()
    expect(calls).toEqual([])
  })

  it('falls through to name when the vat_number scan fails', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { supabase } = makeSupabase({
      byOrgNumber: null,
      vatScanError: { message: 'connection reset' },
      byName: { id: 'by-name' },
    })
    const match = await matchSupplierByIdentity(supabase, 'company-1', {
      vatNumber: 'IE6364992H',
      name: 'Adobe Systems Software Ireland Ltd',
    })
    expect(match).toEqual({ supplierId: 'by-name', matchedOn: 'name' })
    consoleSpy.mockRestore()
  })
})

describe('matchSupplierId', () => {
  it('returns just the id', async () => {
    const { supabase } = makeSupabase({ withOrgNumber: [{ id: 'by-org', org_number: '556677-8899' }] })
    await expect(
      matchSupplierId(supabase, 'company-1', { orgNumber: '5566778899' }),
    ).resolves.toBe('by-org')
  })

  it('returns null when unmatched', async () => {
    const { supabase } = makeSupabase({ byName: null })
    await expect(matchSupplierId(supabase, 'company-1', { name: 'Nope' })).resolves.toBeNull()
  })
})
