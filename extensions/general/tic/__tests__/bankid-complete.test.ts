import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createMockRequest, parseJsonResponse } from '@/tests/helpers'

vi.mock('../lib/bankid-client', () => ({
  startBankIdAuth: vi.fn(),
  pollBankIdSession: vi.fn(),
  collectBankIdResult: vi.fn(),
  cancelBankIdSession: vi.fn(),
  requestEnrichment: vi.fn().mockResolvedValue({ status: 'failed', completedTypes: [] }),
  fetchEnrichmentData: vi.fn(),
}))

vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: vi.fn(),
  createClient: vi.fn(),
}))

import { collectBankIdResult, requestEnrichment, fetchEnrichmentData } from '../lib/bankid-client'
import { createServiceClient } from '@/lib/supabase/server'
import { ticExtension } from '../index'

const TEST_KEY = 'a'.repeat(64)

function findCompleteHandler() {
  const route = ticExtension.apiRoutes!.find(
    (r) => r.method === 'POST' && r.path === '/bankid/complete'
  )
  if (!route) throw new Error('POST /bankid/complete route not found in ticExtension.apiRoutes')
  return route.handler
}

function makeSession(overrides: Partial<{ status: string; user: unknown }> = {}) {
  return {
    sessionId: 'test-session',
    status: 'complete',
    user: {
      personalNumber: '199001011234',
      givenName: 'Anna',
      surname: 'Andersson',
      name: 'Anna Andersson',
    },
    ...overrides,
  } as unknown as Awaited<ReturnType<typeof collectBankIdResult>>
}

type QueuedResult = { data?: unknown; error?: unknown }

function mockServiceClient(fromResults: QueuedResult[]) {
  const queue = [...fromResults]

  const chain = (): unknown => {
    const result = queue.shift() ?? { data: null, error: null }
    const handler: ProxyHandler<object> = {
      get(_t, prop) {
        if (prop === 'then') return (resolve: (v: unknown) => void) => resolve(result)
        return () => chain2(result)
      },
    }
    return new Proxy({}, handler)
  }
  const chain2 = (result: QueuedResult): unknown => {
    const handler: ProxyHandler<object> = {
      get(_t, prop) {
        if (prop === 'then') return (resolve: (v: unknown) => void) => resolve(result)
        return () => chain2(result)
      },
    }
    return new Proxy({}, handler)
  }

  const admin = {
    createUser: vi.fn().mockResolvedValue({ data: { user: { id: 'new-user-uuid' } }, error: null }),
    updateUserById: vi.fn().mockResolvedValue({ data: {}, error: null }),
    generateLink: vi.fn().mockResolvedValue({
      data: { properties: { hashed_token: 'magic-token-hash' } },
      error: null,
    }),
    getUserById: vi.fn().mockResolvedValue({
      data: { user: { id: 'existing-user', email: 'existing@example.com' } },
    }),
  }

  const client = {
    from: vi.fn().mockImplementation(() => chain()),
    auth: { admin },
  }

  vi.mocked(createServiceClient).mockReturnValue(client as unknown as ReturnType<typeof createServiceClient>)

  return { admin, client }
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubEnv('BANKID_ENCRYPTION_KEY', TEST_KEY)
})

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('POST /bankid/complete', () => {
  describe('signup mode: account_exists regression (CWE-287)', () => {
    it('returns 409 account_exists and performs NO side effects when email is already registered', async () => {
      vi.mocked(collectBankIdResult).mockResolvedValue(makeSession())
      const { admin, client } = mockServiceClient([
        { data: null }, // bankid_identities pnr lookup → not linked
        { data: { id: 'victim-user-uuid' } }, // profiles email lookup → EXISTS
      ])

      const req = createMockRequest('/api/extensions/ext/tic/bankid/complete', {
        method: 'POST',
        body: { sessionId: 'test-session', mode: 'signup', email: 'victim@example.com' },
      })
      const { status, body } = await parseJsonResponse<{ error?: string; data?: unknown }>(
        await findCompleteHandler()(req)
      )

      expect(status).toBe(409)
      expect(body.error).toBe('account_exists')
      expect(body.data).toBeUndefined()

      // Critical: none of the account-mutation or session-issuance calls ran.
      expect(admin.createUser).not.toHaveBeenCalled()
      expect(admin.updateUserById).not.toHaveBeenCalled()
      expect(admin.generateLink).not.toHaveBeenCalled()

      // No insert into bankid_identities. Only two from() calls should have happened
      // (the pnr lookup and the profile lookup), neither of which is an insert.
      const fromCalls = vi.mocked(client.from).mock.calls
      expect(fromCalls.map((c) => c[0])).toEqual(['bankid_identities', 'profiles'])
    })
  })

  describe('signup mode: happy path', () => {
    it('creates a new user, marks bankid_linked, and returns the magic link tokenHash', async () => {
      vi.mocked(collectBankIdResult).mockResolvedValue(makeSession())
      const { admin } = mockServiceClient([
        { data: null }, // pnr lookup → not linked
        { data: null }, // email lookup → not taken
        { error: null }, // bankid_identities insert OK
      ])

      const req = createMockRequest('/api/extensions/ext/tic/bankid/complete', {
        method: 'POST',
        body: { sessionId: 'test-session', mode: 'signup', email: 'fresh@example.com' },
      })
      const { status, body } = await parseJsonResponse<{
        data?: { tokenHash?: string; type?: string; isNewUser?: boolean }
      }>(await findCompleteHandler()(req))

      expect(status).toBe(200)
      expect(body.data?.tokenHash).toBe('magic-token-hash')
      expect(body.data?.type).toBe('magiclink')
      expect(body.data?.isNewUser).toBe(true)

      expect(admin.createUser).toHaveBeenCalledWith(
        expect.objectContaining({ email: 'fresh@example.com', email_confirm: true })
      )
      expect(admin.updateUserById).toHaveBeenCalledWith(
        'new-user-uuid',
        expect.objectContaining({
          app_metadata: { bankid_linked: true, has_password: false },
        })
      )
    })
  })

  describe('signup mode: pnr already linked', () => {
    it('returns 409 already_linked before email lookup', async () => {
      vi.mocked(collectBankIdResult).mockResolvedValue(makeSession())
      const { admin, client } = mockServiceClient([
        { data: { user_id: 'some-other-user' } }, // pnr lookup → LINKED
      ])

      const req = createMockRequest('/api/extensions/ext/tic/bankid/complete', {
        method: 'POST',
        body: { sessionId: 'test-session', mode: 'signup', email: 'x@example.com' },
      })
      const { status, body } = await parseJsonResponse<{ error?: string }>(
        await findCompleteHandler()(req)
      )

      expect(status).toBe(409)
      expect(body.error).toBe('already_linked')
      expect(admin.createUser).not.toHaveBeenCalled()
      // Only the pnr lookup ran: no profiles query.
      expect(vi.mocked(client.from).mock.calls.map((c) => c[0])).toEqual(['bankid_identities'])
    })
  })

  describe('login mode', () => {
    it('returns 404 no_account when the BankID pnr is not linked to any user', async () => {
      vi.mocked(collectBankIdResult).mockResolvedValue(makeSession())
      const { admin } = mockServiceClient([
        { data: null }, // pnr lookup → not linked
      ])

      const req = createMockRequest('/api/extensions/ext/tic/bankid/complete', {
        method: 'POST',
        body: { sessionId: 'test-session', mode: 'login' },
      })
      const { status, body } = await parseJsonResponse<{ error?: string }>(
        await findCompleteHandler()(req)
      )

      expect(status).toBe(404)
      expect(body.error).toBe('no_account')
      expect(admin.generateLink).not.toHaveBeenCalled()
    })
  })

  describe('enrichment: SPAR + CompanyRoles', () => {
    it('requests both SPAR and CompanyRoles, fetches data, and persists only companyRoles (no PII) to bankid_enrichment', async () => {
      vi.mocked(collectBankIdResult).mockResolvedValue(makeSession())
      vi.mocked(requestEnrichment).mockResolvedValueOnce({
        enrichmentId: 'enr-1',
        sessionId: 'test-session',
        status: 'Completed',
        requestedTypes: ['SPAR', 'CompanyRoles'],
        completedTypes: ['SPAR', 'CompanyRoles'],
        secureUrl: '/api/v1/enrichment/data/abc',
        secureUrlExpiresAtUtc: '2026-05-06T12:00:00Z',
      })
      vi.mocked(fetchEnrichmentData).mockResolvedValueOnce({
        personalNumber: '199001011234',
        name: 'Anna Andersson',
        enrichedAtUtc: '2026-05-06T11:30:00Z',
        spar: {
          Person_IdNummer: '199001011234',
          Person_PersonIdTyp: 'PERSONNR',
          Skydd_Sekretessmarkering: false,
          Skydd_SkyddadFolkbokforing: false,
          Namn_Fornamn: 'Anna',
          Namn_Efternamn: 'Andersson',
          PersonDetaljer_Kon: 'K',
          PersonDetaljer_Fodelsedatum: '1990-01-01',
          Folkbokforingsadress_SvenskAdress_Utdelningsadress1: 'Storgatan 1',
          Folkbokforingsadress_SvenskAdress_PostNr: '11122',
          Folkbokforingsadress_SvenskAdress_Postort: 'Stockholm',
        },
        companyRoles: [
          {
            companyId: 12345,
            companyRegistrationNumber: '5566778899',
            legalName: 'Exempel AB',
            legalEntityType: 'AB',
            positionTypes: ['LED'],
            positionDescriptions: ['Styrelseledamot'],
            positionStart: '2020-01-15',
            positionEnd: null,
            companyStatus: 'Aktivt',
          },
        ],
      })
      const { client } = mockServiceClient([
        { data: null }, // pnr lookup → not linked
        { data: null }, // email lookup → not taken
        { error: null }, // bankid_identities insert OK
      ])

      // Intercept the bankid_enrichment upsert so we can assert the persisted shape
      // contains no SPAR / personnummer / name. Other tables fall through to the
      // queued chain.
      const upsertSpy = vi.fn().mockResolvedValue({ error: null })
      const origFrom = client.from as unknown as ReturnType<typeof vi.fn>
      const queuedFrom = origFrom.getMockImplementation() as (table: string) => unknown
      origFrom.mockImplementation((table: string) => {
        if (table === 'bankid_enrichment') {
          return { upsert: upsertSpy }
        }
        return queuedFrom(table)
      })

      const req = createMockRequest('/api/extensions/ext/tic/bankid/complete', {
        method: 'POST',
        body: { sessionId: 'test-session', mode: 'signup', email: 'fresh@example.com' },
      })
      const { status, body } = await parseJsonResponse<{
        data?: { tokenHash?: string; isNewUser?: boolean }
      }>(await findCompleteHandler()(req))

      expect(status).toBe(200)
      expect(body.data?.isNewUser).toBe(true)
      expect(vi.mocked(requestEnrichment)).toHaveBeenCalledWith(
        'test-session',
        ['SPAR', 'CompanyRoles']
      )
      expect(vi.mocked(fetchEnrichmentData)).toHaveBeenCalledWith('/api/v1/enrichment/data/abc')

      // Persisted row must contain company_roles + enriched_at_utc only.
      // SPAR (personnummer / name / address / birth date) must NOT be stored,
      // even when TIC returns it: those fields live in bankid_identities (encrypted).
      expect(upsertSpy).toHaveBeenCalledTimes(1)
      const [persistedRow] = upsertSpy.mock.calls[0] as [Record<string, unknown>]
      expect(persistedRow).toEqual({
        user_id: expect.any(String),
        company_roles: expect.any(Array),
        enriched_at_utc: '2026-05-06T11:30:00Z',
      })
      expect(persistedRow).not.toHaveProperty('spar')
      expect(persistedRow).not.toHaveProperty('personalNumber')
      expect(persistedRow).not.toHaveProperty('name')
    })
  })

  describe('input validation', () => {
    it('returns 400 session_invalid when BankID session is not complete', async () => {
      vi.mocked(collectBankIdResult).mockResolvedValue(
        makeSession({ status: 'pending', user: undefined })
      )
      mockServiceClient([])

      const req = createMockRequest('/api/extensions/ext/tic/bankid/complete', {
        method: 'POST',
        body: { sessionId: 'test-session', mode: 'signup', email: 'x@example.com' },
      })
      const { status, body } = await parseJsonResponse<{ error?: string }>(
        await findCompleteHandler()(req)
      )

      expect(status).toBe(400)
      expect(body.error).toBe('session_invalid')
    })

    it('returns 400 when email is missing in signup mode', async () => {
      mockServiceClient([])

      const req = createMockRequest('/api/extensions/ext/tic/bankid/complete', {
        method: 'POST',
        body: { sessionId: 'test-session', mode: 'signup' },
      })
      const { status } = await parseJsonResponse(await findCompleteHandler()(req))

      expect(status).toBe(400)
      // collectBankIdResult should never be called: validation happens first.
      expect(collectBankIdResult).not.toHaveBeenCalled()
    })
  })
})
