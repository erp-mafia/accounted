/**
 * PUT /fortnox-topup, the nightly top-up's switch on a Fortnox connection.
 * The handler is called as the dispatcher calls it; the dispatcher's own
 * answers (401 without a session, 403 for a viewer) are asserted through it
 * at the end.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ExtensionContext } from '@/lib/extensions/types'
import { createTableMockSupabase, parseJsonResponse } from '@/tests/helpers'

const { mockCreateClient } = vi.hoisted(() => ({ mockCreateClient: vi.fn() }))

vi.mock('@/lib/import/sie-append', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/import/sie-append')>()),
  appendableSIEYears: vi.fn(),
}))
vi.mock('@/lib/supabase/server', () => ({ createClient: mockCreateClient, createServiceClient: vi.fn() }))
vi.mock('@/lib/init', () => ({ ensureInitialized: vi.fn() }))
vi.mock('@/lib/auth/mfa', () => ({ shouldEnforceMfa: vi.fn(() => false), mfaStepUpApplies: vi.fn(() => false) }))
vi.mock('@/lib/company/context', () => ({
  requireCompanyId: vi.fn(async () => 'company-1'),
  getActiveCompanyId: vi.fn(async () => 'company-1'),
}))

import { appendableSIEYears } from '@/lib/import/sie-append'
import { extensionRegistry } from '@/lib/extensions/registry'
import { PUT } from '@/app/api/extensions/ext/[...path]/route'
import { fortnoxTopupRoutes } from '../fortnox-topup-routes'
import { FORTNOX_TOPUP_KEY, FORTNOX_TOPUP_RUN_KEY, type FortnoxTopupSetting } from '../fortnox-topup'

const CONSENT = '11111111-1111-4111-8111-111111111111'
const route = fortnoxTopupRoutes.find((r) => r.method === 'PUT' && r.path === '/fortnox-topup')!
const handler = route.handler as (request: Request, ctx: ExtensionContext) => Promise<Response>

function put(body: unknown) {
  return new Request('https://app.example/api/extensions/ext/arcim-migration/fortnox-topup', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })
}

function context(consent: Record<string, unknown> | null = { id: CONSENT, provider: 'fortnox', status: 1 }) {
  const mock = createTableMockSupabase({ provider_consents: { data: consent } })
  const stored: Record<string, unknown> = {}
  const settings = {
    get: vi.fn(async (key: string) => stored[key] ?? null),
    set: vi.fn(async (key: string, value: unknown) => { stored[key] = value }),
    clear: vi.fn(),
  }
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
  const ctx = { supabase: mock.supabase, companyId: 'company-1', userId: 'user-1', requestId: 'req_1', settings, log } as unknown as ExtensionContext
  return { ...mock, ctx, settings, stored }
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(appendableSIEYears).mockResolvedValue([{ fiscalPeriodId: 'p-2026', name: '2026', start: '2026-01-01',
    end: '2026-12-31', baseImportId: 'base-2026', sourceYear: null }])
})

describe('PUT /fortnox-topup', () => {
  it('declares the write gate: whoever may import through the connection may turn it on', () => {
    expect((route as { requireWrite?: boolean }).requireWrite).toBe(true)
  })

  it.each([{}, { consentId: CONSENT }, { consentId: 'not-a-uuid', enabled: true }, { consentId: CONSENT, enabled: 'yes' },
    { consentId: CONSENT, enabled: true, companyId: 'other' }, 'not json'])('refuses invalid input %#', async (body) => {
    const { ctx, settings, tables } = context()
    expect((await handler(put(body), ctx)).status).toBe(400)
    expect(tables()).toEqual([])
    expect(settings.set).not.toHaveBeenCalled()
  })

  it('answers 404 for a connection the company does not have, or one not accepted', async () => {
    for (const consent of [null, { id: CONSENT, provider: 'fortnox', status: 0 }]) {
      const { ctx, settings, findCalls } = context(consent)
      const { status, body } = await parseJsonResponse<{ error: { code: string } }>(await handler(put({ consentId: CONSENT, enabled: true }), ctx))
      expect(status).toBe(404)
      expect(body.error.code).toBe('PROVIDER_CONSENT_NOT_FOUND')
      expect(findCalls('provider_consents', 'eq')).toEqual([['id', CONSENT], ['company_id', 'company-1']])
      expect(settings.set).not.toHaveBeenCalled()
    }
  })

  it('answers 400 for a connection to another system', async () => {
    const { ctx, settings } = context({ id: CONSENT, provider: 'visma', status: 1 })
    expect((await handler(put({ consentId: CONSENT, enabled: true }), ctx)).status).toBe(400)
    expect(settings.set).not.toHaveBeenCalled()
  })

  it('refuses to turn it on with no open year imported from Fortnox, so it never only stops at night', async () => {
    vi.mocked(appendableSIEYears).mockResolvedValue([])
    const { ctx, settings } = context()
    const { status, body } = await parseJsonResponse<{ error: { code: string; message: string } }>(
      await handler(put({ consentId: CONSENT, enabled: true }), ctx))
    expect(status).toBe(409)
    expect(body.error.code).toBe('PROVIDER_TOPUP_NO_OPEN_YEAR')
    expect(appendableSIEYears).toHaveBeenCalledWith(ctx.supabase, 'company-1', 'Fortnox')
    expect(settings.set).not.toHaveBeenCalled()
  })

  it('turns it on for the member who asked, and answers with what the connection shows', async () => {
    const { ctx, stored } = context()
    const { status, body } = await parseJsonResponse<{ data: unknown }>(await handler(put({ consentId: CONSENT, enabled: true }), ctx))
    expect(status).toBe(200)
    const setting = stored[FORTNOX_TOPUP_KEY] as FortnoxTopupSetting
    expect(setting).toEqual({ enabled: true, consentId: CONSENT, changedBy: 'user-1', changedAt: expect.any(String) })
    expect(body.data).toEqual({ consentId: CONSENT, enabled: true, lastRun: null })
  })

  it('turns it off without asking for a year, and the last run no longer shows', async () => {
    vi.mocked(appendableSIEYears).mockResolvedValue([])
    const { ctx, stored } = context()
    stored[FORTNOX_TOPUP_KEY] = { enabled: true, consentId: CONSENT, changedBy: 'user-1', changedAt: '2026-11-20T10:00:00.000Z' }
    stored[FORTNOX_TOPUP_RUN_KEY] = { settingChangedAt: '2026-11-20T10:00:00.000Z', startedAt: '2026-11-25T01:30:00.000Z', finishedAt: '2026-11-25T01:31:00.000Z',
      outcome: 'added', added: 2, skippedDuplicates: 0, failures: 0, reason: null }
    const { status, body } = await parseJsonResponse<{ data: unknown }>(await handler(put({ consentId: CONSENT, enabled: false }), ctx))
    expect(status).toBe(200)
    expect(appendableSIEYears).not.toHaveBeenCalled()
    expect(body.data).toEqual({ consentId: CONSENT, enabled: false, lastRun: null })
  })
})

describe('PUT /api/extensions/ext/arcim-migration/fortnox-topup through the dispatcher', () => {
  /** A cookie session for `userId` (or none), whose membership has `role`. */
  function session(userId: string | null, role = 'owner') {
    const membership: Record<string, unknown> = {}
    membership.select = () => membership
    membership.eq = () => membership
    membership.maybeSingle = () => Promise.resolve({ data: { role }, error: null })
    mockCreateClient.mockResolvedValue({
      auth: {
        getUser: vi.fn().mockResolvedValue({
          data: { user: userId ? { id: userId, app_metadata: {} } : null },
          error: userId ? null : { message: 'Auth session missing' },
        }),
      },
      from: () => membership,
      rpc: vi.fn(async () => ({ data: role === 'owner' || role === 'admin', error: null })),
    })
  }
  const params = { params: Promise.resolve({ path: ['arcim-migration', 'fortnox-topup'] }) }
  const spy = vi.fn()

  beforeEach(() => {
    vi.spyOn(console, 'info').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
    extensionRegistry.clear()
    extensionRegistry.register({ id: 'arcim-migration', name: 'Systemmigration', version: '2.0.0',
      apiRoutes: [{ ...route, handler: spy } as never] })
  })
  afterEach(() => {
    extensionRegistry.clear()
    vi.restoreAllMocks()
  })

  it('answers 401 without a session and never reaches the switch', async () => {
    session(null)
    expect((await PUT(put({ consentId: CONSENT, enabled: true }), params)).status).toBe(401)
    expect(spy).not.toHaveBeenCalled()
  })

  it('answers 403 to a viewer, who may not import through the connection', async () => {
    session('user-1', 'viewer')
    expect((await PUT(put({ consentId: CONSENT, enabled: true }), params)).status).toBe(403)
    expect(spy).not.toHaveBeenCalled()
  })
})
