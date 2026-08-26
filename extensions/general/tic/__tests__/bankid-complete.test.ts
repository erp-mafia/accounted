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

import {
  cancelBankIdSession,
  collectBankIdResult,
  pollBankIdSession,
  requestEnrichment,
  fetchEnrichmentData,
  startBankIdAuth,
} from '../lib/bankid-client'
import { createServiceClient } from '@/lib/supabase/server'
import { ticExtension } from '../index'
import {
  BANKID_FLOW_COOKIE,
  BANKID_FLOW_ID_HEADER,
  signBankIdFlow,
  verifyBankIdFlow,
  type BankIdFlowMode,
} from '../lib/bankid-flow-cookie'

const TEST_KEY = 'a'.repeat(64)
const TEST_FLOW_ID = 'flow-1'

/**
 * The session id and the mode now arrive in a signed HttpOnly cookie rather
 * than the request body, so nothing a caller can name decides which session
 * gets completed, or as which kind of flow.
 */
async function flowCookie(
  mode: BankIdFlowMode,
  sessionId = 'test-session',
  userId = 'user-1',
): Promise<Record<string, string>> {
  const value = await signBankIdFlow({
    version: 1,
    sessionId,
    flowId: TEST_FLOW_ID,
    mode,
    // A link flow is owned by the user who opened it; login/signup have none.
    userId: mode === 'link' ? userId : undefined,
    startedAt: Date.now(),
    expiresAt: Date.now() + 60_000,
  })
  return {
    cookie: `${BANKID_FLOW_COOKIE}=${encodeURIComponent(value)}`,
    [BANKID_FLOW_ID_HEADER]: TEST_FLOW_ID,
  }
}

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

function mockServiceClient(
  fromResults: QueuedResult[],
  // The single-use claim against bankid_consumed_sessions. Routed by table name
  // rather than taken from the queue, so each test's queue keeps describing
  // only the lookups it cares about. `{ error: { code: '23505' } }` is the
  // other tab having claimed the session first.
  consumed: QueuedResult = { error: null },
) {
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
    deleteUser: vi.fn().mockResolvedValue({ data: {}, error: null }),
    generateLink: vi.fn().mockResolvedValue({
      data: { properties: { hashed_token: 'magic-token-hash' } },
      error: null,
    }),
    getUserById: vi.fn().mockResolvedValue({
      data: { user: { id: 'existing-user', email: 'existing@example.com' } },
    }),
  }

  const client = {
    from: vi.fn().mockImplementation((table: string) =>
      table === 'bankid_consumed_sessions' ? chain2(consumed) : chain()
    ),
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
      // The guard is createUser's own auth.users uniqueness check, NOT a
      // profiles.email pre-check: anonymized tombstones (account deletion)
      // have no profiles.email but still hold the address in auth.users.
      vi.mocked(collectBankIdResult).mockResolvedValue(makeSession())
      const { admin, client } = mockServiceClient([
        { data: null }, // bankid_identities pnr lookup → not linked
      ])
      admin.createUser.mockResolvedValueOnce({
        data: { user: null },
        error: { status: 422, code: 'email_exists', message: 'A user with this email address has already been registered' },
      } as never)

      const req = createMockRequest('/api/extensions/ext/tic/bankid/complete', {
        method: 'POST',
        headers: await flowCookie('signup'),
        body: { email: 'victim@example.com' },
      })
      const { status, body } = await parseJsonResponse<{ error?: string; data?: unknown }>(
        await findCompleteHandler()(req)
      )

      expect(status).toBe(409)
      expect(body.error).toBe('account_exists')
      expect(body.data).toBeUndefined()

      // Critical: no account mutation or session issuance happened.
      expect(admin.updateUserById).not.toHaveBeenCalled()
      expect(admin.generateLink).not.toHaveBeenCalled()
      expect(admin.deleteUser).not.toHaveBeenCalled()

      // No insert into bankid_identities: the only from() call is the pnr lookup.
      const fromCalls = vi.mocked(client.from).mock.calls
      expect(fromCalls.map((c) => c[0])).toEqual(['bankid_identities'])
    })

    it('returns 500 internal_error for createUser failures that are NOT email_exists', async () => {
      vi.mocked(collectBankIdResult).mockResolvedValue(makeSession())
      const { admin } = mockServiceClient([
        { data: null }, // pnr lookup → not linked
      ])
      admin.createUser.mockResolvedValueOnce({
        data: { user: null },
        error: { status: 500, code: 'unexpected_failure', message: 'boom' },
      } as never)

      const req = createMockRequest('/api/extensions/ext/tic/bankid/complete', {
        method: 'POST',
        headers: await flowCookie('signup'),
        body: { email: 'fresh@example.com' },
      })
      const { status, body } = await parseJsonResponse<{ error?: string }>(
        await findCompleteHandler()(req)
      )

      expect(status).toBe(500)
      expect(body.error).toBe('internal_error')
      expect(admin.generateLink).not.toHaveBeenCalled()
    })
  })

  describe('signup mode: happy path', () => {
    it('creates a new user, marks bankid_linked, and returns the magic link tokenHash', async () => {
      vi.mocked(collectBankIdResult).mockResolvedValue(makeSession())
      const { admin } = mockServiceClient([
        { data: null }, // pnr lookup → not linked
        { error: null }, // bankid_identities insert OK
      ])

      const req = createMockRequest('/api/extensions/ext/tic/bankid/complete', {
        method: 'POST',
        headers: await flowCookie('signup'),
        body: { email: 'fresh@example.com' },
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
        headers: await flowCookie('signup'),
        body: { email: 'x@example.com' },
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

  describe('signup mode: rollback on partial failure', () => {
    // A half-created account strands the user: retrying signup hits
    // account_exists/already_linked, but the account only has a random
    // password they never saw. Every failure after createUser must delete
    // the created user so a retry starts clean.

    it('deletes the created user when the bankid_identities insert fails', async () => {
      vi.mocked(collectBankIdResult).mockResolvedValue(makeSession())
      const { admin } = mockServiceClient([
        { data: null }, // pnr lookup → not linked
        { error: { message: 'insert boom', code: 'XX000' } }, // identity insert FAILS
      ])

      const req = createMockRequest('/api/extensions/ext/tic/bankid/complete', {
        method: 'POST',
        headers: await flowCookie('signup'),
        body: { email: 'fresh@example.com' },
      })
      const { status, body } = await parseJsonResponse<{ error?: string }>(
        await findCompleteHandler()(req)
      )

      expect(status).toBe(500)
      expect(body.error).toBe('internal_error')
      expect(admin.createUser).toHaveBeenCalled()
      expect(admin.deleteUser).toHaveBeenCalledWith('new-user-uuid')
      expect(admin.generateLink).not.toHaveBeenCalled()
    })

    it('deletes the created user when generateLink fails', async () => {
      vi.mocked(collectBankIdResult).mockResolvedValue(makeSession())
      const { admin } = mockServiceClient([
        { data: null }, // pnr lookup → not linked
        { error: null }, // identity insert OK
      ])
      admin.generateLink.mockResolvedValueOnce({
        data: null,
        error: { message: 'link boom' },
      } as never)

      const req = createMockRequest('/api/extensions/ext/tic/bankid/complete', {
        method: 'POST',
        headers: await flowCookie('signup'),
        body: { email: 'fresh@example.com' },
      })
      const { status, body } = await parseJsonResponse<{ error?: string }>(
        await findCompleteHandler()(req)
      )

      expect(status).toBe(500)
      expect(body.error).toBe('internal_error')
      expect(admin.deleteUser).toHaveBeenCalledWith('new-user-uuid')
    })

    it('deletes the created user when the app_metadata update fails', async () => {
      vi.mocked(collectBankIdResult).mockResolvedValue(makeSession())
      const { admin } = mockServiceClient([
        { data: null }, // pnr lookup → not linked
      ])
      admin.updateUserById.mockResolvedValueOnce({
        data: null,
        error: { message: 'meta boom', code: 'XX000' },
      } as never)

      const req = createMockRequest('/api/extensions/ext/tic/bankid/complete', {
        method: 'POST',
        headers: await flowCookie('signup'),
        body: { email: 'fresh@example.com' },
      })
      const { status, body } = await parseJsonResponse<{ error?: string }>(
        await findCompleteHandler()(req)
      )

      expect(status).toBe(500)
      expect(body.error).toBe('internal_error')
      expect(admin.deleteUser).toHaveBeenCalledWith('new-user-uuid')
      expect(admin.generateLink).not.toHaveBeenCalled()
    })

    it('does NOT delete anything on the happy path', async () => {
      vi.mocked(collectBankIdResult).mockResolvedValue(makeSession())
      const { admin } = mockServiceClient([
        { data: null },
        { error: null },
      ])

      const req = createMockRequest('/api/extensions/ext/tic/bankid/complete', {
        method: 'POST',
        headers: await flowCookie('signup'),
        body: { email: 'fresh@example.com' },
      })
      const { status } = await parseJsonResponse(await findCompleteHandler()(req))

      expect(status).toBe(200)
      expect(admin.deleteUser).not.toHaveBeenCalled()
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
        headers: await flowCookie('login'),
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
        headers: await flowCookie('signup'),
        body: { email: 'fresh@example.com' },
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
        headers: await flowCookie('signup'),
        body: { email: 'x@example.com' },
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
        headers: await flowCookie('signup'),
      })
      const { status } = await parseJsonResponse(await findCompleteHandler()(req))

      expect(status).toBe(400)
      // collectBankIdResult should never be called: validation happens first.
      expect(collectBankIdResult).not.toHaveBeenCalled()
    })
  })

  describe('the flow cookie is the only thing that names a session', () => {
    /** Did the handler expire the flow cookie on this response? */
    function clearedFlow(response: Response): boolean {
      return response.headers
        .getSetCookie()
        .some((c) => c.startsWith(`${BANKID_FLOW_COOKIE}=`) && /Max-Age=0/i.test(c))
    }

    it('refuses completion from a stale tab after the shared cookie was replaced', async () => {
      vi.mocked(collectBankIdResult).mockResolvedValue(makeSession())
      mockServiceClient([])
      const headers = await flowCookie('signup')
      headers[BANKID_FLOW_ID_HEADER] = 'older-flow'

      const { status } = await parseJsonResponse(
        await findCompleteHandler()(
          createMockRequest('/api/extensions/ext/tic/bankid/complete', {
            method: 'POST',
            headers,
            body: { email: 'fresh@example.com' },
          })
        )
      )

      expect(status).toBe(400)
      expect(collectBankIdResult).not.toHaveBeenCalled()
    })

    it('ignores a sessionId and mode supplied in the body', async () => {
      // The old contract took both from the body, which made /complete a
      // bearer endpoint: anyone who had seen a session id could complete it,
      // in whatever mode suited them.
      mockServiceClient([])

      const req = createMockRequest('/api/extensions/ext/tic/bankid/complete', {
        method: 'POST',
        body: { sessionId: 'attacker-session', mode: 'login' },
      })
      const { status, body } = await parseJsonResponse<{ error?: string }>(
        await findCompleteHandler()(req)
      )

      expect(status).toBe(400)
      expect(body.error).toBe('session_invalid')
      expect(collectBankIdResult).not.toHaveBeenCalled()
    })

    it('refuses to complete a session that was opened as a link flow', async () => {
      // Linking happens on the authenticated /bankid/link route. Completing a
      // link session here would create or sign in an account off a session
      // opened for something else entirely.
      mockServiceClient([])

      const req = createMockRequest('/api/extensions/ext/tic/bankid/complete', {
        method: 'POST',
        headers: await flowCookie('link'),
        body: { email: 'attacker@example.com' },
      })
      const { status, body } = await parseJsonResponse<{ error?: string }>(
        await findCompleteHandler()(req)
      )

      expect(status).toBe(400)
      expect(body.error).toBe('session_invalid')
      expect(collectBankIdResult).not.toHaveBeenCalled()
    })

    it('spends the flow on success, so a second tab cannot mint a rival magic link', async () => {
      vi.mocked(collectBankIdResult).mockResolvedValue(makeSession())
      const { admin } = mockServiceClient([
        { data: null }, // pnr lookup → not linked
        { error: null }, // bankid_identities insert OK
      ])

      const response = await findCompleteHandler()(
        createMockRequest('/api/extensions/ext/tic/bankid/complete', {
          method: 'POST',
          headers: await flowCookie('signup'),
          body: { email: 'fresh@example.com' },
        })
      )

      expect(response.status).toBe(200)
      expect(admin.generateLink).toHaveBeenCalled()
      // Without this, two tabs that both saw 'complete' would each mint a
      // magic link and the second would invalidate the first.
      expect(clearedFlow(response)).toBe(true)
    })

    it('refuses a login whose session another tab already spent', async () => {
      // The Set-Cookie clear does NOT make this single-use: two requests that
      // both already carried the cookie both reach here. The unique index on
      // bankid_consumed_sessions is what stops the second from minting a rival
      // magic link that would invalidate the first tab's.
      vi.mocked(collectBankIdResult).mockResolvedValue(makeSession())
      const { admin } = mockServiceClient(
        [{ data: { user_id: 'existing-user' } }], // pnr is linked
        { error: { code: '23505', message: 'duplicate key' } },
      )

      const { status, body } = await parseJsonResponse<{ error?: string }>(
        await findCompleteHandler()(
          createMockRequest('/api/extensions/ext/tic/bankid/complete', {
            method: 'POST',
            headers: await flowCookie('login'),
          })
        )
      )

      expect(status).toBe(400)
      expect(body.error).toBe('session_invalid')
      expect(admin.generateLink).not.toHaveBeenCalled()
    })

    it('rolls the new account back when a signup loses the same race', async () => {
      vi.mocked(collectBankIdResult).mockResolvedValue(makeSession())
      const { admin } = mockServiceClient(
        [{ data: null }, { error: null }],
        { error: { code: '23505', message: 'duplicate key' } },
      )

      const { status } = await parseJsonResponse(
        await findCompleteHandler()(
          createMockRequest('/api/extensions/ext/tic/bankid/complete', {
            method: 'POST',
            headers: await flowCookie('signup'),
            body: { email: 'fresh@example.com' },
          })
        )
      )

      expect(status).toBe(400)
      expect(admin.generateLink).not.toHaveBeenCalled()
      // A half-created account would strand the address: the retry would hit
      // account_exists on an account whose password the user never saw.
      expect(admin.deleteUser).toHaveBeenCalledWith('new-user-uuid')
    })

    it('fails closed when the single-use claim errors for any other reason', async () => {
      // Minting a second magic link is worse than asking the user to
      // authenticate again, so an unreachable table must not be waved through.
      vi.mocked(collectBankIdResult).mockResolvedValue(makeSession())
      const { admin } = mockServiceClient(
        [{ data: { user_id: 'existing-user' } }],
        { error: { code: '42P01', message: 'relation does not exist' } },
      )

      const { status } = await parseJsonResponse(
        await findCompleteHandler()(
          createMockRequest('/api/extensions/ext/tic/bankid/complete', {
            method: 'POST',
            headers: await flowCookie('login'),
          })
        )
      )

      expect(status).toBe(400)
      expect(admin.generateLink).not.toHaveBeenCalled()
    })

    it('keeps the flow alive when the e-mail is already taken, so it can be corrected', async () => {
      // account_exists consumes nothing and is usually a typo: forcing a
      // second BankID round trip to fix an address would be gratuitous.
      vi.mocked(collectBankIdResult).mockResolvedValue(makeSession())
      const { admin } = mockServiceClient([{ data: null }])
      admin.createUser.mockResolvedValueOnce({
        data: { user: null },
        error: { status: 422, code: 'email_exists', message: 'already registered' },
      } as never)

      const response = await findCompleteHandler()(
        createMockRequest('/api/extensions/ext/tic/bankid/complete', {
          method: 'POST',
          headers: await flowCookie('signup'),
          body: { email: 'taken@example.com' },
        })
      )

      expect(response.status).toBe(409)
      expect(clearedFlow(response)).toBe(false)
    })
  })
})

describe('POST /bankid/start', () => {
  function findStartHandler() {
    const route = ticExtension.apiRoutes!.find(
      (r) => r.method === 'POST' && r.path === '/bankid/start'
    )
    if (!route) throw new Error('POST /bankid/start route not found')
    return route.handler
  }

  it('rejects a request that does not name a flow', async () => {
    const { status } = await parseJsonResponse(
      await findStartHandler()(
        createMockRequest('/api/extensions/ext/tic/bankid/start', {
          method: 'POST',
          body: { mode: 'admin' },
        })
      )
    )
    expect(status).toBe(400)
    expect(startBankIdAuth).not.toHaveBeenCalled()
  })

  it('withholds the session id from the response and puts it in the cookie', async () => {
    vi.mocked(startBankIdAuth).mockResolvedValue({
      sessionId: 'secret-session',
      autoStartToken: 'ast',
      qrStartToken: 'qrt',
      qrStartSecret: 'qrs',
    } as never)

    const response = await findStartHandler()(
      createMockRequest('/api/extensions/ext/tic/bankid/start', {
        method: 'POST',
        body: { mode: 'signup' },
      })
    )
    const payload = await response.clone().text()
    const parsed = JSON.parse(payload) as { data: { flowId: string } }

    // The id is a bearer credential for a personnummer and for a session.
    // The browser gets the autostart/QR tokens, which identify nobody.
    expect(payload).not.toContain('secret-session')
    expect(payload).toContain('ast')
    expect(parsed.data.flowId).toBeTruthy()

    const flowCookieHeader = response.headers
      .getSetCookie()
      .find((c) => c.startsWith(`${BANKID_FLOW_COOKIE}=`))
    expect(flowCookieHeader).toMatch(/HttpOnly/i)

    const [, value] = /^[^=]+=([^;]*)/.exec(flowCookieHeader!)!
    const flow = await verifyBankIdFlow(decodeURIComponent(value))
    expect(flow).toMatchObject({
      sessionId: 'secret-session',
      mode: 'signup',
    })
    expect(flow?.flowId).toBe(parsed.data.flowId)
  })
})

describe('POST /bankid/poll', () => {
  function findPollHandler() {
    const route = ticExtension.apiRoutes!.find(
      (r) => r.method === 'POST' && r.path === '/bankid/poll'
    )
    if (!route) throw new Error('POST /bankid/poll route not found')
    return route.handler
  }

  it('answers 404 when the browser holds no flow, instead of polling a named session', async () => {
    const { status } = await parseJsonResponse(
      await findPollHandler()(
        createMockRequest('/api/extensions/ext/tic/bankid/poll', {
          method: 'POST',
          body: { sessionId: 'attacker-session' },
        })
      )
    )

    expect(status).toBe(404)
    expect(pollBankIdSession).not.toHaveBeenCalled()
  })

  it('never returns the personnummer', async () => {
    // This route is skipAuth, so whatever it returns is readable by whoever
    // holds the flow cookie. The UI only ever needed the names.
    vi.mocked(pollBankIdSession).mockResolvedValue({
      status: 'complete',
      user: {
        personalNumber: '199001011234',
        givenName: 'Anna',
        surname: 'Andersson',
        name: 'Anna Andersson',
      },
    } as never)

    const response = await findPollHandler()(
        createMockRequest('/api/extensions/ext/tic/bankid/poll', {
          method: 'POST',
          headers: await flowCookie('signup'),
          body: { mode: 'signup' },
        })
    )
    const payload = await response.clone().text()
    const { body } = await parseJsonResponse<{ data: { user?: Record<string, unknown> } }>(response)

    expect(payload).not.toContain('199001011234')
    expect(body.data.user).toEqual({ givenName: 'Anna', surname: 'Andersson' })
  })

  it('withholds the holder name from a probe, but gives it to the active poll', async () => {
    // The mount probe runs before the person here has confirmed the flow is
    // theirs, so the name must not reach them (it would identify a stranger on
    // a shared machine). The active poll, reached only after ownership/confirm,
    // needs the name for the signup e-mail step.
    vi.mocked(pollBankIdSession).mockResolvedValue({
      status: 'complete',
      user: { givenName: 'Anna', surname: 'Andersson', personalNumber: 'x' },
    } as never)

    const probe = await parseJsonResponse<{ data: { flowId?: string; user?: unknown } }>(
      await findPollHandler()(
        createMockRequest('/api/extensions/ext/tic/bankid/poll', {
          method: 'POST',
          headers: await flowCookie('signup'),
          body: { mode: 'signup', probe: true },
        })
      )
    )
    expect(probe.body.data.flowId).toBe(TEST_FLOW_ID)
    expect(probe.body.data.user).toBeUndefined()

    const active = await parseJsonResponse<{ data: { user?: unknown } }>(
      await findPollHandler()(
        createMockRequest('/api/extensions/ext/tic/bankid/poll', {
          method: 'POST',
          headers: await flowCookie('signup'),
          body: { mode: 'signup' },
        })
      )
    )
    expect(active.body.data.user).toEqual({ givenName: 'Anna', surname: 'Andersson' })
  })

  it('refuses to poll a flow whose mode does not match the panel asking', async () => {
    // A login session started on /login must not be pollable by the signup
    // panel: the client would render the signup e-mail step and /complete
    // would then read mode 'login' off the cookie, either signing the user in
    // from the "Skapa konto" form or burning the identification on no_account.
    const { status, body } = await parseJsonResponse<{ error?: string }>(
      await findPollHandler()(
        createMockRequest('/api/extensions/ext/tic/bankid/poll', {
          method: 'POST',
          headers: await flowCookie('login'),
          body: { mode: 'signup' },
        })
      )
    )

    expect(status).toBe(404)
    expect(body.error).toBe('no_session')
    expect(pollBankIdSession).not.toHaveBeenCalled()
  })

  it('polls when both the panel mode and tab flow id match', async () => {
    vi.mocked(pollBankIdSession).mockResolvedValue({ status: 'pending' } as never)

    const { status } = await parseJsonResponse(
      await findPollHandler()(
        createMockRequest('/api/extensions/ext/tic/bankid/poll', {
          method: 'POST',
          headers: await flowCookie('signup'),
          body: { mode: 'signup' },
        })
      )
    )
    expect(status).toBe(200)
    expect(pollBankIdSession).toHaveBeenCalledOnce()
  })

  it('refuses a stale tab after a newer same-mode flow replaced the shared cookie', async () => {
    vi.mocked(pollBankIdSession).mockResolvedValue({ status: 'complete' } as never)
    const headers = await flowCookie('signup')
    headers[BANKID_FLOW_ID_HEADER] = 'older-flow'

    const { status, body } = await parseJsonResponse<{ error?: string }>(
      await findPollHandler()(
        createMockRequest('/api/extensions/ext/tic/bankid/poll', {
          method: 'POST',
          headers,
          body: { mode: 'signup' },
        })
      )
    )

    expect(status).toBe(404)
    expect(body.error).toBe('no_session')
    expect(pollBankIdSession).not.toHaveBeenCalled()
  })

  it('does NOT clear the cookie when TIC has forgotten the session', async () => {
    // A clearing Set-Cookie cannot be aimed at one flow, so a slow response
    // about a dead session would delete whatever flow is in the jar by the
    // time it lands, including one the user just started in another tab.
    const { TICAPIError } = await import('../lib/tic-types')
    vi.mocked(pollBankIdSession).mockRejectedValueOnce(
      new TICAPIError('gone', 404)
    )

    const response = await findPollHandler()(
      createMockRequest('/api/extensions/ext/tic/bankid/poll', {
        method: 'POST',
        headers: await flowCookie('login'),
        body: { mode: 'login' },
      })
    )
    const { status, body } = await parseJsonResponse<{ error?: string }>(response)

    expect(status).toBe(404)
    expect(body.error).toBe('no_session')
    const cleared = response.headers
      .getSetCookie()
      .some((c) => c.startsWith(`${BANKID_FLOW_COOKIE}=`) && /Max-Age=0/i.test(c))
    expect(cleared).toBe(false)
  })

  it('extends the window to the verified budget once identification completes', async () => {
    // The signup e-mail step is a person typing; the order window (300s) is
    // too short for it, so completion re-issues at the longer budget.
    vi.mocked(pollBankIdSession).mockResolvedValue({
      status: 'complete',
      user: { givenName: 'Anna', surname: 'Andersson', personalNumber: 'x' },
    } as never)

    const response = await findPollHandler()(
      createMockRequest('/api/extensions/ext/tic/bankid/poll', {
        method: 'POST',
        headers: await flowCookie('signup'),
        body: { mode: 'signup' },
      })
    )

    // A fresh signed cookie is issued (Max-Age well past the 300s order window).
    const reissued = response.headers
      .getSetCookie()
      .find((c) => c.startsWith(`${BANKID_FLOW_COOKIE}=`))
    expect(reissued).toBeDefined()
    const maxAge = Number(/Max-Age=(\d+)/i.exec(reissued!)?.[1])
    expect(maxAge).toBeGreaterThan(300)
  })
})

describe('POST /bankid/cancel', () => {
  function findCancelHandler() {
    const route = ticExtension.apiRoutes!.find(
      (r) => r.method === 'POST' && r.path === '/bankid/cancel'
    )
    if (!route) throw new Error('POST /bankid/cancel route not found')
    return route.handler
  }

  function clearsFlow(response: Response): boolean {
    return response.headers
      .getSetCookie()
      .some((c) => c.startsWith(`${BANKID_FLOW_COOKIE}=`) && /Max-Age=0/i.test(c))
  }

  it('cancels the flow this browser holds, with no id to aim it', async () => {
    const response = await findCancelHandler()(
      createMockRequest('/api/extensions/ext/tic/bankid/cancel', {
        method: 'POST',
        headers: await flowCookie('signup'),
        // A named session in the body must be ignored: the old DELETE route
        // took one, which let a caller cancel a session they merely knew of.
        body: { sessionId: 'someone-elses-session' },
      })
    )

    expect(response.status).toBe(200)
    expect(clearsFlow(response)).toBe(true)
    expect(cancelBankIdSession).toHaveBeenCalledWith('test-session')
  })

  it('still clears the cookie when TIC cannot be reached', async () => {
    // Otherwise pressing Avbryt during a TIC outage leaves a flow in the
    // browser that the next page load resumes.
    vi.mocked(cancelBankIdSession).mockRejectedValueOnce(new Error('network down'))

    const response = await findCancelHandler()(
      createMockRequest('/api/extensions/ext/tic/bankid/cancel', {
        method: 'POST',
        headers: await flowCookie('signup'),
      })
    )

    expect(response.status).toBe(200)
    expect(clearsFlow(response)).toBe(true)
  })

  it('does not cancel or clear a newer flow from a stale tab', async () => {
    const headers = await flowCookie('signup')
    headers[BANKID_FLOW_ID_HEADER] = 'older-flow'

    const response = await findCancelHandler()(
      createMockRequest('/api/extensions/ext/tic/bankid/cancel', {
        method: 'POST',
        headers,
      })
    )
    const { body } = await parseJsonResponse<{
      data?: { cancelled?: boolean; replaced?: boolean }
    }>(response.clone())

    expect(response.status).toBe(200)
    expect(body.data).toEqual({ cancelled: false, replaced: true })
    expect(clearsFlow(response)).toBe(false)
    expect(cancelBankIdSession).not.toHaveBeenCalled()
  })

  it('is a no-op that still succeeds when there is no flow', async () => {
    const response = await findCancelHandler()(
      createMockRequest('/api/extensions/ext/tic/bankid/cancel', { method: 'POST' })
    )

    expect(response.status).toBe(200)
    expect(cancelBankIdSession).not.toHaveBeenCalled()
  })
})
