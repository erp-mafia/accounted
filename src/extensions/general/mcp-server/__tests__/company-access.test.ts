/**
 * An archived company is out of reach for an API key at every door. The same
 * owner key names the same company at the v1 gate, MCP routing and
 * /api/events: a live company answers, an archived one reads as no company.
 * The fake honours the embedded filter the way PostgREST does, so a door that
 * reads the membership without it reaches the handler here as it did in
 * production.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { NextResponse } from 'next/server'
import { z } from 'zod'

vi.mock('@/lib/import/sie-period-read', () => ({
  withSIEExternalReport: (_s: unknown, _c: unknown, _o: unknown, fn: () => unknown) => fn(),
}))
vi.mock('@/lib/auth/api-keys', async () => {
  const actual = await vi.importActual<typeof import('@/lib/auth/api-keys')>('@/lib/auth/api-keys')
  return { ...actual, validateApiKey: vi.fn(), createServiceClientNoCookies: vi.fn() }
})

import { validateApiKey, createServiceClientNoCookies } from '@/lib/auth/api-keys'
import { withApiV1 } from '@/lib/api/v1/with-api-v1'
import { registerEndpoint } from '@/lib/api/v1/registry'
import { ok } from '@/lib/api/v1/response'
import { resolveMcpCompanyContext } from '@/extensions/general/mcp-server/company-routing'
import { GET as eventsGET } from '@/app/api/events/route'
import { readLiveMembership } from '@/lib/company/company-access'

const COMPANY = '11111111-1111-4111-8111-111111111111'
const OTHER_COMPANY = '33333333-3333-4333-8333-333333333333'
const USER = '22222222-2222-4222-8222-222222222222'

interface Membership {
  role: string
  archived: boolean
  name?: string
  displayName?: string | null
}

/** A client that answers company_members as PostgREST would, the embedded filter included. */
function fakeDb(membership: Membership | null, failure: { message: string } | null = null) {
  const from = (table: string) => {
    let liveOnly = false
    const query: Record<string, unknown> = {}
    for (const method of ['select', 'eq', 'in', 'order', 'limit', 'gt', 'not']) query[method] = () => query
    query.is = (column: string) => {
      if (column === 'companies.archived_at') liveOnly = true
      return query
    }
    query.maybeSingle = async () => {
      if (table !== 'company_members') return { data: null, error: null }
      if (failure) return { data: null, error: failure }
      if (!membership || (liveOnly && membership.archived)) return { data: null, error: null }
      return {
        data: {
          company_id: COMPANY,
          role: membership.role,
          companies: {
            archived_at: membership.archived ? '2026-05-01T00:00:00Z' : null,
            name: membership.name ?? 'Bolaget AB',
            company_settings: { company_name: membership.displayName ?? null },
          },
        },
        error: null,
      }
    }
    query.then = (resolve: (value: unknown) => void) => resolve({ data: [], error: null })
    return query
  }
  return { from, rpc: async () => ({ data: null, error: null }) }
}

const key = {
  userId: USER,
  companyId: OTHER_COMPANY,
  apiKeyId: 'key-1',
  apiKeyName: 'Integration',
  scopes: ['reports:read', 'bookkeeping:write', 'events:read'],
  mode: 'live',
  unattendedCommitLimit: null,
  allowedCompanyIds: null,
  readOnlyCompanyIds: null,
  serviceAccount: null,
}

async function throughV1(method: 'GET' | 'POST', archived: boolean) {
  vi.mocked(validateApiKey).mockResolvedValue(key as never)
  vi.mocked(createServiceClientNoCookies).mockReturnValue(fakeDb({ role: 'owner', archived }) as never)
  let handlerRan = false
  const route = withApiV1<{ params: Promise<{ companyId: string }> }>(
    method === 'GET' ? 'journal-entries.list' : 'journal-entries.create',
    async (_request, ctx) => {
      handlerRan = true
      return ok({ reached: ctx.companyId }, { requestId: ctx.requestId }) as unknown as NextResponse
    },
  )
  const response = await route(
    new Request(`http://localhost/api/v1/companies/${COMPANY}/journal-entries`, {
      method,
      headers: { authorization: 'Bearer gnubok_sk_test' },
    }),
    { params: Promise.resolve({ companyId: COMPANY }) },
  )
  const body = (await response.json()) as { error?: { code?: string } }
  return { status: response.status, handlerRan, code: body.error?.code ?? null }
}

function throughMcp(archived: boolean) {
  return resolveMcpCompanyContext({
    supabase: fakeDb({ role: 'owner', archived }) as never,
    userId: USER,
    defaultCompanyId: OTHER_COMPANY,
    requestedCompanyId: COMPANY,
    allowedCompanyIds: null,
    readOnlyCompanyIds: null,
  })
}

async function throughEvents(archived: boolean) {
  vi.mocked(validateApiKey).mockResolvedValue({ ...key, companyId: COMPANY } as never)
  vi.mocked(createServiceClientNoCookies).mockReturnValue(fakeDb({ role: 'owner', archived }) as never)
  const response = await eventsGET(
    new Request('http://localhost/api/events', { headers: { authorization: 'Bearer gnubok_sk_test' } }),
  )
  return response.status
}

beforeAll(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL ||= 'http://localhost:54321'
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||= 'test-anon-key'
  for (const [operation, method, scope] of [
    ['journal-entries.list', 'GET', 'reports:read'],
    ['journal-entries.create', 'POST', 'bookkeeping:write'],
  ] as const) {
    registerEndpoint({
      operation,
      method,
      path: '/api/v1/companies/:companyId/journal-entries',
      summary: 'x',
      description: 'x',
      useWhen: 'x',
      doNotUseFor: 'x',
      pitfalls: [],
      example: { response: {} },
      scope,
      risk: 'low',
      idempotent: true,
      reversible: false,
      dryRunSupported: false,
      response: { success: z.object({}) },
    })
  }
})

beforeEach(() => vi.clearAllMocks())

describe('an API key at every door', () => {
  it('reaches a live company', async () => {
    expect(await throughV1('GET', false)).toMatchObject({ status: 200, handlerRan: true })
    expect(await throughV1('POST', false)).toMatchObject({ status: 200, handlerRan: true })
    await expect(throughMcp(false)).resolves.toMatchObject({ companyId: COMPANY, role: 'owner' })
    expect(await throughEvents(false)).toBe(200)
  })

  it('v1: a read naming an archived company is a 404, and the handler never runs', async () => {
    expect(await throughV1('GET', true)).toEqual({ status: 404, handlerRan: false, code: 'NOT_FOUND' })
  })

  it('v1: a write naming an archived company is a 404, and the handler never runs', async () => {
    expect(await throughV1('POST', true)).toEqual({ status: 404, handlerRan: false, code: 'NOT_FOUND' })
  })

  it('MCP refuses an archived company as not found', async () => {
    await expect(throughMcp(true)).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  it('/api/events refuses an archived company as not found', async () => {
    expect(await throughEvents(true)).toBe(404)
  })
})

describe('readLiveMembership', () => {
  const read = (membership: Membership | null, failure: { message: string } | null = null) =>
    readLiveMembership(fakeDb(membership, failure) as never, USER, COMPANY)

  it('answers the role and the display name of a live company', async () => {
    await expect(read({ role: 'member', archived: false, name: 'Bolaget AB', displayName: 'Bolaget' })).resolves.toEqual({
      role: 'member',
      companyName: 'Bolaget',
    })
  })

  it('falls back to the company name when the settings name is blank', async () => {
    await expect(read({ role: 'owner', archived: false, name: 'Bolaget AB', displayName: '  ' })).resolves.toEqual({
      role: 'owner',
      companyName: 'Bolaget AB',
    })
  })

  it('reads an archived company and no membership alike', async () => {
    await expect(read({ role: 'owner', archived: true })).resolves.toBeNull()
    await expect(read(null)).resolves.toBeNull()
  })

  it('throws when the read fails, so "could not check" never reads as "no"', async () => {
    await expect(read(null, { message: 'boom' })).rejects.toEqual({ message: 'boom' })
  })
})
