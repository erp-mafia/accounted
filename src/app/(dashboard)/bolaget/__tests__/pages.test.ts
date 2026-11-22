import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Bolaget became one place (product decision 2026-10-30): the overview at
// /bolaget, Avtal och åtaganden at /bolaget/avtal, and /commitments sending
// old links there. None of it may open outside BOLAGET_COMPANY_IDS.

const notFound = vi.fn(() => {
  throw new Error('NEXT_NOT_FOUND')
})
const redirect = vi.fn((url: string) => {
  throw new Error(`NEXT_REDIRECT:${url}`)
})
vi.mock('next/navigation', () => ({ notFound: () => notFound(), redirect: (url: string) => redirect(url) }))
vi.mock('@/components/bolaget/BolagetOverview', () => ({ BolagetOverview: () => null }))
vi.mock('@/components/commitments/CommitmentsRegister', () => ({ CommitmentsRegister: () => null }))

const COMPANY = 'c0ffee00-0000-4000-8000-000000000001'
let entityType = 'aktiebolag'
let companyId: string | null = COMPANY
vi.mock('../../request-context', () => ({
  getDashboardCompanyId: async () => companyId,
  getDashboardAuthContext: async () => ({
    supabase: {
      from: () => {
        const chain = { select: () => chain, eq: () => chain, maybeSingle: async () => ({ data: { entity_type: entityType }, error: null }) }
        return chain
      },
    },
  }),
}))

const { default: OverviewPage } = await import('../page')
const { default: AgreementsPage } = await import('../avtal/page')
const { default: CommitmentsPage } = await import('../../commitments/page')

beforeEach(() => {
  vi.clearAllMocks()
  entityType = 'aktiebolag'
  companyId = COMPANY
})

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('/bolaget, the overview', () => {
  it('answers 404 outside the rollout', async () => {
    vi.stubEnv('BOLAGET_COMPANY_IDS', '')
    await expect(OverviewPage()).rejects.toThrow('NEXT_NOT_FOUND')
    vi.stubEnv('BOLAGET_COMPANY_IDS', 'another-company')
    await expect(OverviewPage()).rejects.toThrow('NEXT_NOT_FOUND')
  })

  it('answers 404 without an active company', async () => {
    vi.stubEnv('BOLAGET_COMPANY_IDS', '*')
    companyId = null
    await expect(OverviewPage()).rejects.toThrow('NEXT_NOT_FOUND')
  })

  it('renders for an aktiebolag in the rollout, with every half open', async () => {
    vi.stubEnv('BOLAGET_COMPANY_IDS', COMPANY)
    const page = (await OverviewPage()) as { props: { access: unknown } }
    expect(page.props.access).toEqual({ registers: true, money: true, agreements: true })
    expect(notFound).not.toHaveBeenCalled()
  })

  it('renders for a form without an aktiebok in the rollout, with Avtal only', async () => {
    vi.stubEnv('BOLAGET_COMPANY_IDS', '*')
    entityType = 'enskild_firma'
    const page = (await OverviewPage()) as { props: { access: unknown } }
    expect(page.props.access).toEqual({ registers: false, money: false, agreements: true })
  })
})

describe('/bolaget/avtal and the old /commitments', () => {
  it('both answer 404 outside the rollout', async () => {
    vi.stubEnv('BOLAGET_COMPANY_IDS', '')
    await expect(AgreementsPage()).rejects.toThrow('NEXT_NOT_FOUND')
    await expect(CommitmentsPage()).rejects.toThrow('NEXT_NOT_FOUND')
    expect(redirect).not.toHaveBeenCalled()
  })

  it('renders the Avtal tab, and sends an old /commitments link there', async () => {
    vi.stubEnv('BOLAGET_COMPANY_IDS', COMPANY)
    await expect(AgreementsPage()).resolves.toBeTruthy()
    await expect(CommitmentsPage()).rejects.toThrow('NEXT_REDIRECT:/bolaget/avtal')
  })
})
