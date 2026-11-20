import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { EnrichmentCompanyRole } from '@/lib/company-lookup/types'

vi.mock('@/lib/supabase/server', () => ({ createClient: vi.fn() }))
vi.mock('next/headers', () => ({ cookies: vi.fn(async () => ({ get: () => undefined })) }))
vi.mock('next/navigation', () => ({
  redirect: vi.fn((url: string) => {
    throw new Error(`NEXT_REDIRECT:${url}`)
  }),
}))
vi.mock('@/lib/company/pending-invites', () => ({
  acceptPendingInviteByToken: vi.fn(),
  hasPendingInviteForEmail: vi.fn(async () => false),
}))
vi.mock('@/lib/company/context', () => ({ setActiveCompany: vi.fn() }))
vi.mock('@/lib/parties/scb/config', () => ({ isScbConfigured: () => false }))
vi.mock('@/components/onboarding/journey/OnboardingJourney', () => ({ default: () => null }))

import { createClient } from '@/lib/supabase/server'
import { setActiveCompany } from '@/lib/company/context'
import OnboardingPage from '../page'

/**
 * The BankID picker's pick reaches /onboarding as an opaque TIC companyId
 * (#58): the registration number of a sole trader is the owner's
 * personnummer, and a page URL lands in analytics ($current_url) and request
 * logs. The page resolves the pick against the user's own roles, prefills
 * the 10-digit org number the journey accepts, and answers a legacy
 * ?org_number= link with the same page without the number.
 */

// TIC's shape for an enskild firma: century-prefixed personnummer + serial.
const SOLE_TRADER: EnrichmentCompanyRole = {
  companyId: 222,
  companyRegistrationNumber: '1982010223430001',
  legalName: 'Exempel Firma',
  legalEntityType: 'Enskild firma',
  positionTypes: ['owner'],
  positionDescriptions: ['Innehavare'],
  positionStart: '2020-01-01',
  positionEnd: null,
}
const AKTIEBOLAG: EnrichmentCompanyRole = {
  ...SOLE_TRADER,
  companyId: 111,
  companyRegistrationNumber: '5560125790',
  legalName: 'Exempel AB',
  legalEntityType: 'Aktiebolag',
}

function setup(options: { roles?: EnrichmentCompanyRole[]; memberships?: Array<{ id: string; org_number: string }> } = {}) {
  const tableResult = (table: string) => {
    if (table === 'bankid_enrichment') return { data: { company_roles: options.roles ?? [] }, error: null }
    if (table === 'company_members') {
      return { data: (options.memberships ?? []).map((c) => ({ company: { ...c, archived_at: null } })), error: null }
    }
    return { data: null, error: null }
  }
  const from = vi.fn((table: string) => {
    const result = tableResult(table)
    const builder: Record<string, unknown> = {}
    for (const method of ['select', 'eq']) builder[method] = vi.fn(() => builder)
    builder.maybeSingle = vi.fn(async () => result)
    builder.then = (resolve: (value: unknown) => void) => resolve(result)
    return builder
  })
  const client = {
    from,
    rpc: vi.fn(async () => ({ data: 'personal-team', error: null })),
    auth: { getUser: vi.fn(async () => ({ data: { user: { id: 'user-1', email: null } } })) },
  }
  vi.mocked(createClient).mockResolvedValue(client as never)
  return client
}

describe('/onboarding: the BankID pick', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('prefills a sole trader from ?pick= with the 10-digit org number the journey looks up', async () => {
    setup({ roles: [AKTIEBOLAG, SOLE_TRADER] })

    const element = await OnboardingPage({ searchParams: Promise.resolve({ pick: '222' }) })

    expect(element.props.initialOrgNumber).toBe('8201022343')
    expect(element.props.initialEntityType).toBe('enskild_firma')
    expect(element.props.initialLegalName).toBe('Exempel Firma')
  })

  it('prefills an aktiebolag from ?pick=', async () => {
    setup({ roles: [AKTIEBOLAG, SOLE_TRADER] })

    const element = await OnboardingPage({ searchParams: Promise.resolve({ pick: '111' }) })

    expect(element.props.initialOrgNumber).toBe('5560125790')
    expect(element.props.initialLegalName).toBe('Exempel AB')
  })

  it('starts an empty journey for a pick that is not one of the user\'s roles', async () => {
    setup({ roles: [AKTIEBOLAG] })

    const element = await OnboardingPage({ searchParams: Promise.resolve({ pick: '999' }) })

    expect(element.props.initialOrgNumber).toBeUndefined()
    expect(element.props.initialLegalName).toBeUndefined()
  })

  it('opens the company the user already has instead of a duplicate', async () => {
    setup({ roles: [SOLE_TRADER], memberships: [{ id: 'ef-1', org_number: '8201022343' }] })

    await expect(OnboardingPage({ searchParams: Promise.resolve({ pick: '222' }) })).rejects.toThrow(/^NEXT_REDIRECT:\/$/)
    expect(setActiveCompany).toHaveBeenCalledWith(expect.anything(), 'user-1', 'ef-1')
  })

  it('answers a legacy ?org_number= link with the same pick, minus the number', async () => {
    setup({ roles: [SOLE_TRADER] })

    await expect(
      OnboardingPage({ searchParams: Promise.resolve({ org_number: '1982010223430001' }) }),
    ).rejects.toThrow('NEXT_REDIRECT:/onboarding?pick=222')
  })

  it('drops a legacy ?org_number= that matches no role', async () => {
    setup({ roles: [] })

    await expect(
      OnboardingPage({ searchParams: Promise.resolve({ org_number: '5591715734' }) }),
    ).rejects.toThrow(/^NEXT_REDIRECT:\/onboarding$/)
  })
})

describe('/onboarding: Tillbaka on the first question', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('leads back to the BankID picker while it has companies to offer', async () => {
    setup({ roles: [AKTIEBOLAG] })

    const element = await OnboardingPage({ searchParams: Promise.resolve({ pick: '111' }) })

    expect(element.props.backHref).toBe('/select-company')
  })

  it('leads to the company the user has when the picker has nothing left to offer', async () => {
    setup({ roles: [AKTIEBOLAG], memberships: [{ id: 'ab-1', org_number: '5560125790' }] })

    const element = await OnboardingPage({ searchParams: Promise.resolve({}) })

    expect(element.props.backHref).toBe('/')
  })

  it('leads nowhere for a first company without BankID engagements', async () => {
    // The browser's previous page is /login or /select-company, and both send
    // this user straight back to the journey: the dead Tillbaka.
    setup({ roles: [] })

    const element = await OnboardingPage({ searchParams: Promise.resolve({}) })

    expect(element.props.backHref).toBeNull()
  })
})
