import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createMockRequest, createMockRouteParams, parseJsonResponse } from '@/tests/helpers'
import { eventBus } from '@/lib/events'

vi.mock('@/lib/init', () => ({
  ensureInitialized: vi.fn(),
}))

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(),
  createServiceClient: vi.fn(),
}))

vi.mock('@/lib/auth/require-auth', () => ({
  requireAuth: vi.fn(),
}))

// The mail extension's seam. Absent by default, as in a build without it.
const { mailService } = vi.hoisted(() => ({
  mailService: {} as { endCompanyGrants?: (companyId: string, userId: string) => Promise<unknown> },
}))
vi.mock('@/lib/mail-search/service', () => ({ getMailSearchService: () => mailService }))

// Where the user lands after the archive (the middleware's resolver).
vi.mock('@/lib/company/active-company', () => ({
  getActiveCompanyId: vi.fn(),
}))

// The company's Stripe subscription (crm#1373): its own unit is
// lib/stripe/__tests__/company-subscription.test.ts. By default the company
// never reached checkout, so Stripe is never asked.
const { stripeClient, subscriptionMocks } = vi.hoisted(() => ({
  stripeClient: { stripe: true },
  subscriptionMocks: { readRef: vi.fn(), end: vi.fn() },
}))
vi.mock('@/lib/stripe/client', () => ({ getStripe: () => stripeClient }))
vi.mock('@/lib/stripe/company-subscription', () => ({
  readCompanyStripeRef: (...args: unknown[]) => subscriptionMocks.readRef(...args),
  endCompanySubscriptions: (...args: unknown[]) => subscriptionMocks.end(...args),
}))

import { createServiceClient } from '@/lib/supabase/server'
import { requireAuth } from '@/lib/auth/require-auth'
import { getActiveCompanyId } from '@/lib/company/active-company'
import { POST } from '../route'

const mockRequireAuth = vi.mocked(requireAuth)
const mockCreateServiceClient = vi.mocked(createServiceClient)
const mockGetActiveCompanyId = vi.mocked(getActiveCompanyId)

type Row = { data: unknown; error: unknown }

function mockService(
  rowsByTable: Record<string, Row[]>,
  updateResults: Record<string, Row> = {},
) {
  const insertSpy = vi.fn().mockResolvedValue({ data: null, error: null })
  const updateSpies: Record<string, ReturnType<typeof vi.fn>> = {}

  const from = vi.fn().mockImplementation((table: string) => {
    const queue = rowsByTable[table] ?? []
    const next = queue.shift() ?? { data: null, error: null }

    // Awaitable at any depth: update().eq(...), update().eq(...).eq(...),
    // update().eq(...).neq(...).select(...) all resolve to the table's
    // configured update result (default: one revoked row, no error).
    const updateResult = updateResults[table] ?? { data: [{ id: `${table}-1` }], error: null }
    const updateChain: {
      eq: ReturnType<typeof vi.fn>
      neq: ReturnType<typeof vi.fn>
      select: ReturnType<typeof vi.fn>
      then: (resolve: (v: unknown) => void) => void
    } = {
      eq: vi.fn(() => updateChain),
      neq: vi.fn(() => updateChain),
      select: vi.fn(() => updateChain),
      then: (resolve: (v: unknown) => void) => resolve(updateResult),
    }
    const updateFn = vi.fn().mockReturnValue(updateChain)
    updateSpies[table] = updateFn

    return {
      select: vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            maybeSingle: vi.fn().mockResolvedValue(next),
          }),
          maybeSingle: vi.fn().mockResolvedValue(next),
        }),
      }),
      update: updateFn,
      insert: insertSpy,
    }
  })

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  mockCreateServiceClient.mockReturnValue({ from } as any)
  return { from, insertSpy, updateSpies }
}

// The caller's own session client, distinct from the service client.
const sessionClient = { session: true }

function mockAuth(userId: string | null) {
  if (userId) {
    mockRequireAuth.mockResolvedValue({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      user: { id: userId, email: 'u@example.com' } as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      supabase: sessionClient as any,
      error: null,
    })
  } else {
    mockRequireAuth.mockResolvedValue({
      user: null,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      supabase: {} as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      error: { status: 401 } as any,
    })
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  eventBus.clear()
  delete mailService.endCompanyGrants
  mockGetActiveCompanyId.mockResolvedValue('c2')
  subscriptionMocks.readRef.mockResolvedValue(null)
  subscriptionMocks.end.mockResolvedValue([])
})

describe('POST /api/company/[id]/delete', () => {
  it('returns 401 when unauthenticated', async () => {
    mockAuth(null)
    const req = createMockRequest('/api/company/c1/delete', {
      method: 'POST',
      body: { confirm_name: 'Acme' },
    })
    const res = await POST(req, createMockRouteParams({ id: 'c1' }))
    // requireAuth already returned the error response
    expect(res.status).toBe(401)
    expect(mockCreateServiceClient).not.toHaveBeenCalled()
  })

  it('returns 400 when confirm_name does not match', async () => {
    mockAuth('user-1')
    mockService({
      companies: [{ data: { id: 'c1', name: 'Acme AB', archived_at: null }, error: null }],
      company_members: [{ data: { role: 'owner' }, error: null }],
    })

    const req = createMockRequest('/api/company/c1/delete', {
      method: 'POST',
      body: { confirm_name: 'Wrong Name' },
    })
    const { status, body } = await parseJsonResponse(
      await POST(req, createMockRouteParams({ id: 'c1' }))
    )
    expect(status).toBe(400)
    expect(body).toHaveProperty('error')
  })

  it('accepts the settings display name when companies.name is stale', async () => {
    // Regression: the UI shows company_settings.company_name (the dialog,
    // label and the enable-gate all use it), but companies.name can be stale.
    // The server must accept the displayed name, not just the raw column.
    mockAuth('user-1')
    mockService({
      companies: [{ data: { id: 'c1', name: 'Gammalt namn', archived_at: null }, error: null }],
      company_members: [{ data: { role: 'owner' }, error: null }],
      company_settings: [{ data: { company_name: 'Nytt namn' }, error: null }],
    })

    const req = createMockRequest('/api/company/c1/delete', {
      method: 'POST',
      body: { confirm_name: 'Nytt namn' },
    })
    const { status } = await parseJsonResponse(
      await POST(req, createMockRouteParams({ id: 'c1' }))
    )
    expect(status).toBe(200)
  })

  it('rejects the stale companies.name when a settings name exists (only the displayed name is accepted)', async () => {
    // Security: the UI only ever shows company_settings.company_name when set, so
    // the server must not accept the stale companies.name as an alternative
    // confirmation: that would be a delete path the user was never shown.
    mockAuth('user-1')
    mockService({
      companies: [{ data: { id: 'c1', name: 'Gammalt namn', archived_at: null }, error: null }],
      company_members: [{ data: { role: 'owner' }, error: null }],
      company_settings: [{ data: { company_name: 'Nytt namn' }, error: null }],
    })

    const req = createMockRequest('/api/company/c1/delete', {
      method: 'POST',
      body: { confirm_name: 'Gammalt namn' },
    })
    const { status } = await parseJsonResponse(
      await POST(req, createMockRouteParams({ id: 'c1' }))
    )
    expect(status).toBe(400)
  })

  it('returns 403 when caller is member but not owner', async () => {
    mockAuth('user-1')
    mockService({
      companies: [{ data: { id: 'c1', name: 'Acme AB', archived_at: null }, error: null }],
      company_members: [{ data: { role: 'member' }, error: null }],
    })

    const req = createMockRequest('/api/company/c1/delete', {
      method: 'POST',
      body: { confirm_name: 'Acme AB' },
    })
    const { status } = await parseJsonResponse(
      await POST(req, createMockRouteParams({ id: 'c1' }))
    )
    expect(status).toBe(403)
  })

  it('returns 404 when company is already archived', async () => {
    mockAuth('user-1')
    mockService({
      companies: [
        {
          data: {
            id: 'c1',
            name: 'Acme AB',
            archived_at: '2026-01-01T00:00:00Z',
          },
          error: null,
        },
      ],
    })

    const req = createMockRequest('/api/company/c1/delete', {
      method: 'POST',
      body: { confirm_name: 'Acme AB' },
    })
    const { status } = await parseJsonResponse(
      await POST(req, createMockRouteParams({ id: 'c1' }))
    )
    expect(status).toBe(404)
  })

  it('archives company, writes audit log, emits event on happy path', async () => {
    mockAuth('user-1')
    const { insertSpy, updateSpies } = mockService({
      companies: [{ data: { id: 'c1', name: 'Acme AB', archived_at: null }, error: null }],
      company_members: [{ data: { role: 'owner' }, error: null }],
    })

    const emitted: unknown[] = []
    eventBus.on('company.deleted', (payload) => {
      emitted.push(payload)
    })

    const req = createMockRequest('/api/company/c1/delete', {
      method: 'POST',
      body: { confirm_name: 'Acme AB' },
    })
    const { status, body } = await parseJsonResponse<{
      data: { companyId: string; archivedAt: string }
    }>(await POST(req, createMockRouteParams({ id: 'c1' })))

    expect(status).toBe(200)
    expect(body.data.companyId).toBe('c1')
    expect(body.data.archivedAt).toBeTruthy()

    // Verified the companies.update was called (archived_at + archived_by)
    expect(updateSpies.companies).toHaveBeenCalledWith(
      expect.objectContaining({
        archived_at: expect.any(String),
        archived_by: 'user-1',
      })
    )

    // Audit log row written
    expect(insertSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'DELETE',
        table_name: 'companies',
        record_id: 'c1',
        user_id: 'user-1',
      })
    )

    // Event emitted
    expect(emitted).toHaveLength(1)
    expect(emitted[0]).toMatchObject({ companyId: 'c1', userId: 'user-1' })
  })

  it('revokes store connections on archive so the store-uniqueness indexes free up', async () => {
    // Regression: archived companies are hidden by user_company_ids(), so an
    // 'active' connection left behind blocks reconnecting the same store from
    // a new company ("Butiken är redan ansluten till ett företag") with no
    // user-reachable disconnect.
    mockAuth('user-1')
    const { updateSpies } = mockService({
      companies: [{ data: { id: 'c1', name: 'Acme AB', archived_at: null }, error: null }],
      company_members: [{ data: { role: 'owner' }, error: null }],
    })

    const req = createMockRequest('/api/company/c1/delete', {
      method: 'POST',
      body: { confirm_name: 'Acme AB' },
    })
    const { status } = await parseJsonResponse(
      await POST(req, createMockRouteParams({ id: 'c1' }))
    )
    expect(status).toBe(200)

    expect(updateSpies.woocommerce_connections).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'revoked',
        disconnected_at: expect.any(String),
        consumer_key_encrypted: null,
        consumer_secret_encrypted: null,
        oauth_state: null,
      })
    )
    expect(updateSpies.shopify_connections).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'revoked',
        disconnected_at: expect.any(String),
        client_id_encrypted: null,
        client_secret_encrypted: null,
      })
    )
    expect(updateSpies.zettle_connections).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'revoked',
        disconnected_at: expect.any(String),
        refresh_token_encrypted: null,
        oauth_state: null,
      })
    )
    expect(updateSpies.stripe_connections).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'revoked',
        disconnected_at: expect.any(String),
        oauth_state: null,
      })
    )
  })

  it('writes audit_log rows for each revoked connection', async () => {
    mockAuth('user-1')
    const { insertSpy } = mockService({
      companies: [{ data: { id: 'c1', name: 'Acme AB', archived_at: null }, error: null }],
      company_members: [{ data: { role: 'owner' }, error: null }],
    })

    const req = createMockRequest('/api/company/c1/delete', {
      method: 'POST',
      body: { confirm_name: 'Acme AB' },
    })
    const { status } = await parseJsonResponse(
      await POST(req, createMockRouteParams({ id: 'c1' }))
    )
    expect(status).toBe(200)

    // One audit insert per revoked connection row.
    for (const table of [
      'woocommerce_connections',
      'shopify_connections',
      'zettle_connections',
      'stripe_connections',
    ]) {
      expect(insertSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'UPDATE',
          table_name: table,
          record_id: `${table}-1`,
          company_id: 'c1',
          user_id: 'user-1',
          new_state: expect.objectContaining({ status: 'revoked' }),
        }),
      )
    }
  })

  it('still archives the company when a connection revoke update fails', async () => {
    mockAuth('user-1')
    const { insertSpy, updateSpies } = mockService(
      {
        companies: [{ data: { id: 'c1', name: 'Acme AB', archived_at: null }, error: null }],
        company_members: [{ data: { role: 'owner' }, error: null }],
      },
      {
        woocommerce_connections: { data: null, error: { message: 'boom' } },
      },
    )

    const req = createMockRequest('/api/company/c1/delete', {
      method: 'POST',
      body: { confirm_name: 'Acme AB' },
    })
    const { status } = await parseJsonResponse(
      await POST(req, createMockRouteParams({ id: 'c1' }))
    )

    // Non-fatal by design: the archive already happened.
    expect(status).toBe(200)
    expect(updateSpies.companies).toHaveBeenCalled()
    // No audit rows for the failed table, but the other tables still processed.
    expect(insertSpy).not.toHaveBeenCalledWith(
      expect.objectContaining({ table_name: 'woocommerce_connections' }),
    )
    expect(insertSpy).toHaveBeenCalledWith(
      expect.objectContaining({ table_name: 'shopify_connections' }),
    )
    expect(insertSpy).toHaveBeenCalledWith(
      expect.objectContaining({ table_name: 'zettle_connections' }),
    )
  })
})

/**
 * crm#1373: a deleted company's subscription went on charging every period,
 * out of everyone's reach. The delete ends it first, and fails closed.
 */
describe('POST /api/company/[id]/delete: the company subscription', () => {
  const REF = { customerId: 'cus_1', subscriptionId: 'sub_monthly' }

  function archiveRequest() {
    return createMockRequest('/api/company/c1/delete', {
      method: 'POST',
      body: { confirm_name: 'Acme AB' },
    })
  }

  function ownerOfAcme() {
    mockAuth('user-1')
    return mockService({
      companies: [{ data: { id: 'c1', name: 'Acme AB', archived_at: null }, error: null }],
      company_members: [{ data: { role: 'owner' }, error: null }],
    })
  }

  it('ends the subscription before the company is archived', async () => {
    subscriptionMocks.readRef.mockResolvedValue(REF)
    subscriptionMocks.end.mockResolvedValue(['sub_monthly'])
    const { updateSpies } = ownerOfAcme()

    const { status } = await parseJsonResponse(await POST(archiveRequest(), createMockRouteParams({ id: 'c1' })))

    expect(status).toBe(200)
    expect(subscriptionMocks.end).toHaveBeenCalledWith(stripeClient, 'c1', REF)
    expect(subscriptionMocks.end.mock.invocationCallOrder[0]).toBeLessThan(
      updateSpies.companies.mock.invocationCallOrder[0],
    )
  })

  it('does not archive (502) when Stripe cannot end the subscription', async () => {
    subscriptionMocks.readRef.mockResolvedValue(REF)
    subscriptionMocks.end.mockRejectedValue(new Error('stripe down'))
    const emitted: unknown[] = []
    eventBus.on('company.deleted', (payload) => {
      emitted.push(payload)
    })
    const { updateSpies } = ownerOfAcme()

    const { status, body } = await parseJsonResponse<{ error: string }>(
      await POST(archiveRequest(), createMockRouteParams({ id: 'c1' })),
    )

    expect(status).toBe(502)
    expect(body.error).toContain('abonnemang')
    expect(updateSpies.companies).not.toHaveBeenCalled()
    expect(emitted).toHaveLength(0)
  })

  it('does not archive when the subscription row cannot be read', async () => {
    subscriptionMocks.readRef.mockRejectedValue(new Error('db down'))
    const { updateSpies } = ownerOfAcme()

    const { status } = await parseJsonResponse(await POST(archiveRequest(), createMockRouteParams({ id: 'c1' })))

    expect(status).toBe(502)
    expect(updateSpies.companies).not.toHaveBeenCalled()
  })

  it('asks Stripe nothing for a company that never reached checkout', async () => {
    const { updateSpies } = ownerOfAcme()

    const { status } = await parseJsonResponse(await POST(archiveRequest(), createMockRouteParams({ id: 'c1' })))

    expect(status).toBe(200)
    expect(subscriptionMocks.end).not.toHaveBeenCalled()
    expect(updateSpies.companies).toHaveBeenCalled()
  })

  it('ends nothing for someone who may not archive the company', async () => {
    mockAuth('user-1')
    mockService({
      companies: [{ data: { id: 'c1', name: 'Acme AB', archived_at: null }, error: null }],
      company_members: [{ data: { role: 'member' }, error: null }],
    })

    const { status } = await parseJsonResponse(await POST(archiveRequest(), createMockRouteParams({ id: 'c1' })))

    expect(status).toBe(403)
    expect(subscriptionMocks.readRef).not.toHaveBeenCalled()
    expect(subscriptionMocks.end).not.toHaveBeenCalled()
  })
})

/**
 * An archived company is hidden from its members, so nobody could disconnect
 * its mailboxes afterwards: the archive ends them, through the seam the mail
 * extension registers (core never imports it).
 */
describe('POST /api/company/[id]/delete: mailbox grants', () => {
  function archiveRequest() {
    return createMockRequest('/api/company/c1/delete', {
      method: 'POST',
      body: { confirm_name: 'Acme AB' },
    })
  }

  function ownerOfAcme(updateResults: Record<string, Row> = {}) {
    mockAuth('user-1')
    return mockService(
      {
        companies: [{ data: { id: 'c1', name: 'Acme AB', archived_at: null }, error: null }],
        company_members: [{ data: { role: 'owner' }, error: null }],
      },
      updateResults,
    )
  }

  it('ends the company\'s mailbox grants, as the archiving owner', async () => {
    mailService.endCompanyGrants = vi.fn().mockResolvedValue({ ended: 2, failed: 0 })
    ownerOfAcme()

    const { status } = await parseJsonResponse(await POST(archiveRequest(), createMockRouteParams({ id: 'c1' })))

    expect(status).toBe(200)
    expect(mailService.endCompanyGrants).toHaveBeenCalledWith('c1', 'user-1')
  })

  it('still archives when the grants cannot be ended', async () => {
    mailService.endCompanyGrants = vi.fn().mockRejectedValue(new Error('google down'))
    const { updateSpies } = ownerOfAcme()

    const { status } = await parseJsonResponse(await POST(archiveRequest(), createMockRouteParams({ id: 'c1' })))

    expect(status).toBe(200)
    expect(updateSpies.companies).toHaveBeenCalled()
  })

  it('ends nothing when the archive itself failed', async () => {
    mailService.endCompanyGrants = vi.fn()
    ownerOfAcme({ companies: { data: null, error: { message: 'boom' } } })

    const { status } = await parseJsonResponse(await POST(archiveRequest(), createMockRouteParams({ id: 'c1' })))

    expect(status).toBe(500)
    expect(mailService.endCompanyGrants).not.toHaveBeenCalled()
  })

  it('ends nothing for someone who may not archive the company', async () => {
    mailService.endCompanyGrants = vi.fn()
    mockAuth('user-1')
    mockService({
      companies: [{ data: { id: 'c1', name: 'Acme AB', archived_at: null }, error: null }],
      company_members: [{ data: { role: 'member' }, error: null }],
    })

    const { status } = await parseJsonResponse(await POST(archiveRequest(), createMockRouteParams({ id: 'c1' })))

    expect(status).toBe(403)
    expect(mailService.endCompanyGrants).not.toHaveBeenCalled()
  })
})

/**
 * Deleting the last company is usually the step before deleting the account,
 * which requires owning none. The response says where the user lands so the
 * client can take a now company-less user to the delete-account action
 * instead of a page the middleware bounces to onboarding (crm#1042).
 */
describe('POST /api/company/[id]/delete: where the user lands next', () => {
  function archiveRequest() {
    return createMockRequest('/api/company/c1/delete', {
      method: 'POST',
      body: { confirm_name: 'Acme AB' },
    })
  }

  function ownerOfAcme() {
    mockAuth('user-1')
    return mockService({
      companies: [{ data: { id: 'c1', name: 'Acme AB', archived_at: null }, error: null }],
      company_members: [{ data: { role: 'owner' }, error: null }],
    })
  }

  it('answers nextCompanyId null when no company remains', async () => {
    ownerOfAcme()
    mockGetActiveCompanyId.mockResolvedValue(null)

    const { status, body } = await parseJsonResponse<{
      data: { companyId: string; nextCompanyId?: string | null }
    }>(await POST(archiveRequest(), createMockRouteParams({ id: 'c1' })))

    expect(status).toBe(200)
    expect(body.data.companyId).toBe('c1')
    expect(body.data.nextCompanyId).toBeNull()
  })

  it('answers the company the user lands in when another one remains', async () => {
    ownerOfAcme()
    mockGetActiveCompanyId.mockResolvedValue('c2')

    const { status, body } = await parseJsonResponse<{
      data: { nextCompanyId?: string | null }
    }>(await POST(archiveRequest(), createMockRouteParams({ id: 'c1' })))

    expect(status).toBe(200)
    expect(body.data.nextCompanyId).toBe('c2')
  })

  it('resolves after the archive, through the caller\'s own session', async () => {
    const { updateSpies } = ownerOfAcme()
    mockGetActiveCompanyId.mockImplementation(async () => {
      // The archive and the preference clear have already been written.
      expect(updateSpies.companies).toHaveBeenCalled()
      expect(updateSpies.user_preferences).toHaveBeenCalledWith({ active_company_id: null })
      return null
    })

    const { status } = await parseJsonResponse(
      await POST(archiveRequest(), createMockRouteParams({ id: 'c1' })),
    )

    expect(status).toBe(200)
    expect(mockGetActiveCompanyId).toHaveBeenCalledWith(sessionClient, 'user-1')
  })

  it('leaves nextCompanyId out when the resolution fails: unknown is not "none left"', async () => {
    const { updateSpies } = ownerOfAcme()
    mockGetActiveCompanyId.mockRejectedValue(new Error('resolution_failed'))

    const { status, body } = await parseJsonResponse<{
      data: { companyId: string; nextCompanyId?: string | null }
    }>(await POST(archiveRequest(), createMockRouteParams({ id: 'c1' })))

    // The archive stands; only the landing hint is missing.
    expect(status).toBe(200)
    expect(updateSpies.companies).toHaveBeenCalled()
    expect(body.data.companyId).toBe('c1')
    expect(body.data).not.toHaveProperty('nextCompanyId')
  })

  it('returns 404 without resolving anything for a company already deleted', async () => {
    mockAuth('user-1')
    mockService({
      companies: [{ data: { id: 'c1', name: 'Acme AB', archived_at: '2026-01-01T00:00:00Z' }, error: null }],
    })

    const { status } = await parseJsonResponse(
      await POST(archiveRequest(), createMockRouteParams({ id: 'c1' })),
    )

    expect(status).toBe(404)
    expect(mockGetActiveCompanyId).not.toHaveBeenCalled()
  })
})
