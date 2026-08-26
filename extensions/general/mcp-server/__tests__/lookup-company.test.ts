/**
 * gnubok_lookup_company: the org-number-first onboarding entry point. Tests
 * the fact-vs-question split mirrored from lib/onboarding-journey/reducer.ts:
 * registry facts are presented for confirmation, VAT is a fact only when
 * positively registered, moms period and accounting method are always asked.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { TOOL_SCOPE_MAP } from '@/lib/auth/api-keys'
import { TICAPIError } from '@/extensions/general/tic/lib/tic-types'
import type { CompanyLookupResult } from '@/lib/company-lookup/types'

const mocks = vi.hoisted(() => ({
  lookupCompanyByOrgNumber: vi.fn(),
}))

vi.mock('@/extensions/general/tic/lib/lookup', () => ({
  lookupCompanyByOrgNumber: (...args: unknown[]) => mocks.lookupCompanyByOrgNumber(...args),
}))

import { tools } from '../server'
import { isCompanyDependentTool } from '../company-routing'

const tool = tools.find((t) => t.name === 'gnubok_lookup_company')!

function found(overrides: Partial<CompanyLookupResult> = {}): CompanyLookupResult {
  return {
    companyName: 'Testbolaget AB',
    isCeased: false,
    address: { street: 'Storgatan 1', postalCode: '111 22', city: 'Stockholm' },
    registration: { fTax: true, vat: true },
    bankAccounts: [],
    email: null,
    phone: null,
    sniCodes: [{ code: '62010', name: 'Dataprogrammering' }],
    fiscalYear: { startMonthDay: '01-01', endMonthDay: '12-31' },
    legalEntityType: 'AB',
    registrationDate: Date.UTC(2018, 2, 1),
    ...overrides,
  }
}

async function run(orgNumber: string) {
  return (await tool.execute({ org_number: orgNumber }, '', 'user-1', {} as never)) as Record<
    string,
    unknown
  >
}

describe('gnubok_lookup_company', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('is a companies:read, company-independent read tool', () => {
    expect(tool).toBeDefined()
    expect(TOOL_SCOPE_MAP.gnubok_lookup_company).toBe('companies:read')
    expect(isCompanyDependentTool('gnubok_lookup_company')).toBe(false)
    expect(tool.annotations.readOnlyHint).toBe(true)
  })

  it('rejects a malformed organisationsnummer without spending a registry call', async () => {
    await expect(run('12345')).rejects.toMatchObject({ code: 'VALIDATION_ERROR' })
    expect(mocks.lookupCompanyByOrgNumber).not.toHaveBeenCalled()
  })

  it('treats a VAT-registered AB as facts: prefill everything, ask only period and method', async () => {
    mocks.lookupCompanyByOrgNumber.mockResolvedValue(found())
    const result = await run('556000-0001')

    expect(result.status).toBe('found')
    expect(result.warnings).toEqual([])
    expect(result.suggested_create_company_input).toMatchObject({
      name: 'Testbolaget AB',
      entity_type: 'aktiebolag',
      org_number: '5560000001',
      f_skatt: true,
      vat_registered: true,
      address_line1: 'Storgatan 1',
      postal_code: '111 22',
      city: 'Stockholm',
      fiscal_year_start_month: 1,
    })

    const ask = result.still_to_ask as string[]
    expect(ask.some((q) => q.startsWith('moms_period ('))).toBe(true)
    expect(ask.some((q) => q.startsWith('accounting_method'))).toBe(true)
    // Registry facts are confirmed, never re-asked.
    expect(ask.some((q) => q.startsWith('entity_type'))).toBe(false)
    expect(ask.some((q) => q.startsWith('vat_registered'))).toBe(false)
    expect(ask.some((q) => q.startsWith('name'))).toBe(false)
    // The known fiscal year becomes a confirmation, not an open question.
    expect(ask.some((q) => q.includes('stämmer detta?'))).toBe(true)
  })

  it('never silently defaults VAT: absence of registration is a question, not a fact', async () => {
    mocks.lookupCompanyByOrgNumber.mockResolvedValue(
      found({ registration: { fTax: false, vat: false } })
    )
    const result = await run('5560000001')

    const suggested = result.suggested_create_company_input as Record<string, unknown>
    expect('vat_registered' in suggested).toBe(false)
    // f_skatt=false IS a fact (the registry answered), unlike vat=false.
    expect(suggested.f_skatt).toBe(false)

    const ask = result.still_to_ask as string[]
    expect(ask.some((q) => q.startsWith('vat_registered'))).toBe(true)
  })

  it('lets the user pick the enskild firma verksamhetsnamn instead of assuming the registered name', async () => {
    mocks.lookupCompanyByOrgNumber.mockResolvedValue(
      found({ legalEntityType: 'EF', companyName: 'Anna Andersson' })
    )
    const result = await run('5560000001')

    const ask = result.still_to_ask as string[]
    expect(ask.some((q) => q.startsWith('name'))).toBe(true)
    // The registered name still arrives as the suggestion.
    expect((result.suggested_create_company_input as Record<string, unknown>).name).toBe(
      'Anna Andersson'
    )
  })

  it('flags an unsupported legal form and asks for the entity type', async () => {
    mocks.lookupCompanyByOrgNumber.mockResolvedValue(found({ legalEntityType: 'HB' }))
    const result = await run('5560000001')

    expect((result.warnings as string[]).some((w) => w.includes('not supported'))).toBe(true)
    const suggested = result.suggested_create_company_input as Record<string, unknown>
    expect('entity_type' in suggested && suggested.entity_type !== undefined).toBe(false)
    expect((result.still_to_ask as string[]).some((q) => q.startsWith('entity_type'))).toBe(true)
  })

  it('warns about a ceased company but lets the flow continue', async () => {
    mocks.lookupCompanyByOrgNumber.mockResolvedValue(found({ isCeased: true }))
    const result = await run('5560000001')

    expect(result.status).toBe('found')
    expect((result.warnings as string[]).some((w) => w.includes('CEASED'))).toBe(true)
  })

  it('suggests a first fiscal year for a recently registered company with no closed period', async () => {
    mocks.lookupCompanyByOrgNumber.mockResolvedValue(
      found({ fiscalYear: null, registrationDate: Date.now() - 60 * 24 * 60 * 60 * 1000 })
    )
    const result = await run('5560000001')

    const ask = result.still_to_ask as string[]
    expect(ask.some((q) => q.includes('first fiscal year') || q.includes('first_fiscal_year'))).toBe(
      true
    )
    const suggested = result.suggested_create_company_input as Record<string, unknown>
    expect('fiscal_year_start_month' in suggested).toBe(false)
  })

  it('returns not_found with the full question list when no company matches', async () => {
    mocks.lookupCompanyByOrgNumber.mockResolvedValue(null)
    const result = await run('5560000001')

    expect(result.status).toBe('not_found')
    expect(result.suggested_create_company_input).toBeNull()
    expect((result.still_to_ask as string[]).length).toBeGreaterThanOrEqual(6)
  })

  it('degrades to unavailable on a TIC error instead of failing the onboarding', async () => {
    mocks.lookupCompanyByOrgNumber.mockRejectedValue(
      new TICAPIError('not configured', undefined, 'NOT_CONFIGURED')
    )
    const result = await run('5560000001')

    expect(result.status).toBe('unavailable')
    expect((result.warnings as string[])[0]).toContain('NOT_CONFIGURED')
    expect((result.still_to_ask as string[]).length).toBeGreaterThanOrEqual(6)
  })

  it('rethrows non-TIC errors', async () => {
    mocks.lookupCompanyByOrgNumber.mockRejectedValue(new Error('boom'))
    await expect(run('5560000001')).rejects.toThrow('boom')
  })
})
