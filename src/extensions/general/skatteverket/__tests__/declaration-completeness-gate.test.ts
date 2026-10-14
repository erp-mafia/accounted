/**
 * The dashboard routes that send a momsdeklaration to Skatteverket refuse on
 * the server-side completeness verdict (vatFilingVerdict) before their first
 * call there. The panel's own "Kontroll av underlaget" check disables the
 * buttons, but it is no gate for a caller that posts to the route directly.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockSkvRequest = vi.fn()
vi.mock('../lib/api-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/api-client')>()
  return { ...actual, skvRequest: (...args: unknown[]) => mockSkvRequest(...args) }
})

const mockBuildMomsuppgift = vi.fn()
vi.mock('../lib/declaration-prep', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/declaration-prep')>()
  return { ...actual, buildMomsuppgift: (...args: unknown[]) => mockBuildMomsuppgift(...args) }
})

const mockFindRcBasisGaps = vi.fn()
vi.mock('@/lib/reports/rc-basis-gaps', () => ({
  findRcBasisGaps: (...args: unknown[]) => mockFindRcBasisGaps(...args),
}))

vi.mock('../lib/audit', () => ({ writeSkatteverketAudit: vi.fn() }))

vi.mock('@/lib/import/sie-period-read', () => ({
  withSIEPeriodRead: (_s: unknown, _c: unknown, _k: unknown, run: () => Promise<unknown>) => run(),
}))

vi.mock('@/lib/entitlements/has-capability', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/entitlements/has-capability')>()
  return { ...actual, requireCapability: vi.fn().mockResolvedValue(null) }
})

import type { ExtensionContext } from '@/lib/extensions/types'
import { skatteverketExtension } from '../index'
import { COMPLETE_VAT_DECLARATION, INCOMPLETE_VAT_DECLARATION } from './vat-declaration-fixture'

/** The write-role gate reads company_members; this caller is a member. */
function memberSupabase() {
  const membership = {
    eq: () => membership,
    maybeSingle: async () => ({ data: { role: 'member' }, error: null }),
  }
  return { from: () => ({ select: () => membership }) }
}

function makeContext(): ExtensionContext {
  return {
    userId: 'user-1',
    companyId: 'company-1',
    extensionId: 'skatteverket',
    requestId: 'req-completeness-gate',
    supabase: memberSupabase(),
    emit: vi.fn().mockResolvedValue(undefined),
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    settings: {
      get: vi.fn().mockResolvedValue(null),
      set: vi.fn().mockResolvedValue(undefined),
      clear: vi.fn().mockResolvedValue(undefined),
    },
  } as unknown as ExtensionContext
}

function route(path: string) {
  const found = skatteverketExtension.apiRoutes?.find((r) => r.method === 'POST' && r.path === path)
  expect(found).toBeDefined()
  return found!
}

function postJson(path: string, body: unknown): Request {
  return new Request(`https://test.local/api/extensions/ext/skatteverket${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

function prep(declaration: typeof COMPLETE_VAT_DECLARATION) {
  return { redovisare: '165560000000', redovisningsperiod: '202606', momsuppgift: { momsUtgHog: 150 }, declaration }
}

const BODY = { periodType: 'monthly', year: 2026, period: 6 }

beforeEach(() => {
  vi.clearAllMocks()
  mockFindRcBasisGaps.mockResolvedValue([])
})

describe.each(['/declaration/draft', '/declaration/submit'])('POST %s: server-side completeness gate', (path) => {
  it('refuses an incomplete declaration with 422 VAT_DECLARATION_INCOMPLETE and calls Skatteverket zero times', async () => {
    mockBuildMomsuppgift.mockResolvedValue(prep(INCOMPLETE_VAT_DECLARATION))
    const ctx = makeContext()

    const response = await route(path).handler(postJson(path, BODY), ctx)
    const body = await response.json()

    expect(response.status).toBe(422)
    expect(body).toMatchObject({ code: 'VAT_DECLARATION_INCOMPLETE', stage: 'completeness' })
    expect(body.error).toMatch(/ofullständig/)
    expect(body.completeness_checks).toContainEqual(
      expect.objectContaining({ code: 'RC_BASIS_MISSING', status: 'ERROR' }),
    )
    expect(mockSkvRequest).not.toHaveBeenCalled()
    expect(ctx.settings.set).not.toHaveBeenCalled()
  })

  it('lets a complete declaration through to Skatteverket', async () => {
    mockBuildMomsuppgift.mockResolvedValue(prep(COMPLETE_VAT_DECLARATION))
    mockSkvRequest.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ kontrollResultat: { resultat: [] }, signeringsLank: 'https://skv.test/sign' }),
    })

    const response = await route(path).handler(postJson(path, BODY), makeContext())

    expect(response.status).toBe(200)
    expect(mockSkvRequest).toHaveBeenCalled()
  })

  it('scans the räkenskapsår the request names', async () => {
    mockBuildMomsuppgift.mockResolvedValue(prep(INCOMPLETE_VAT_DECLARATION))

    await route(path).handler(postJson(path, { ...BODY, periodType: 'yearly', period: 1, fiscalPeriodId: 'fp-1' }), makeContext())

    expect(mockFindRcBasisGaps).toHaveBeenCalledWith(
      expect.anything(), 'company-1', 'monthly', 2026, 6, { fiscalPeriodId: 'fp-1' },
    )
  })
})
