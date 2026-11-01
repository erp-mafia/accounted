/**
 * One viewer, one write, at each door, as the caller receives it. A client
 * branches on `error.code` and `error.details.code`, so they read the same at
 * the session routes, v1 and MCP; the session refusal used to be a bare string,
 * and MCP dropped the reason.
 */
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { NextResponse } from 'next/server'
import { z } from 'zod'

vi.mock('@/lib/import/sie-period-read', () => ({
  withSIEExternalReport: (_s: unknown, _c: unknown, _o: unknown, fn: () => unknown) => fn(),
  withSIEPeriodRead: (_s: unknown, _c: unknown, _o: unknown, fn: () => unknown) => fn(),
}))
vi.mock('@/lib/auth/api-keys', async () => {
  const actual = await vi.importActual<typeof import('@/lib/auth/api-keys')>('@/lib/auth/api-keys')
  return { ...actual, validateApiKey: vi.fn(), createServiceClientNoCookies: vi.fn() }
})
const requireAuthMock = vi.hoisted(() => vi.fn())
vi.mock('@/lib/auth/require-auth', () => ({ requireAuth: requireAuthMock }))

import { validateApiKey, createServiceClientNoCookies } from '@/lib/auth/api-keys'
import { withApiV1 } from '@/lib/api/v1/with-api-v1'
import { withRouteContext } from '@/lib/api/with-route-context'
import { registerEndpoint } from '@/lib/api/v1/registry'
import { assertMcpCompanyWriteAccess, type McpCompanyContext } from '@/extensions/general/mcp-server/company-routing'
import { toToolError } from '@/extensions/general/mcp-server/tool-result'
import { getErrorMessage } from '@/lib/errors/get-error-message'
import { readOnlyRefusal } from '@/lib/auth/require-write'

const COMPANY = '11111111-1111-4111-8111-111111111111'
const USER = '22222222-2222-4222-8222-222222222222'

function sessionAs(role: string) {
  return {
    rpc: async (fn: string) =>
      fn === 'resolve_active_company'
        ? { data: [{ company_id: COMPANY, locale: null, used_fallback: false, role }], error: null }
        : { data: false, error: null },
  }
}

function serviceAs(role: string) {
  const query: Record<string, unknown> = {}
  for (const method of ['select', 'eq', 'is']) query[method] = () => query
  query.maybeSingle = async () => ({ data: { company_id: COMPANY, role }, error: null })
  return { from: () => query }
}

const key = (readOnlyCompanyIds: string[] | null) => ({
  userId: USER,
  companyId: COMPANY,
  apiKeyId: 'key-1',
  apiKeyName: 'Integration',
  scopes: ['bookkeeping:write'],
  mode: 'live',
  unattendedCommitLimit: null,
  allowedCompanyIds: readOnlyCompanyIds,
  readOnlyCompanyIds,
  serviceAccount: null,
})

async function throughV1(role: string, readOnlyCompanyIds: string[] | null = null) {
  vi.mocked(validateApiKey).mockResolvedValue(key(readOnlyCompanyIds) as never)
  vi.mocked(createServiceClientNoCookies).mockReturnValue(serviceAs(role) as never)
  const route = withApiV1<{ params: Promise<{ companyId: string }> }>('journal-entries.create', async () =>
    NextResponse.json({ data: 1 }),
  )
  const response = await route(
    new Request(`http://localhost/api/v1/companies/${COMPANY}/journal-entries`, {
      method: 'POST',
      headers: { authorization: 'Bearer gnubok_sk_test' },
    }),
    { params: Promise.resolve({ companyId: COMPANY }) },
  )
  return { status: response.status, error: ((await response.json()) as { error: Record<string, unknown> }).error }
}

function throughMcp(context: Partial<McpCompanyContext>) {
  try {
    assertMcpCompanyWriteAccess(
      { companyId: COMPANY, companyName: 'Bolaget AB', role: 'member', isDefault: true, keyAccess: 'write', ...context },
      'bookkeeping:write',
    )
  } catch (err) {
    return toToolError(err, { toolName: 'gnubok_create_voucher' }).error
  }
  throw new Error('the gate let the write through')
}

beforeAll(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL ||= 'http://localhost:54321'
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||= 'test-anon-key'
  registerEndpoint({
    operation: 'journal-entries.create',
    method: 'POST',
    path: '/api/v1/companies/:companyId/journal-entries',
    summary: 'x',
    description: 'x',
    useWhen: 'x',
    doNotUseFor: 'x',
    pitfalls: [],
    example: { response: {} },
    scope: 'bookkeeping:write',
    risk: 'low',
    idempotent: true,
    reversible: false,
    dryRunSupported: false,
    response: { success: z.object({}) },
  })
})

describe('a write refused to a viewer', () => {
  it('answers FORBIDDEN with details.code ROLE_READ_ONLY on the session door', async () => {
    requireAuthMock.mockResolvedValue({ user: { id: USER, email: 'a@b.se' }, supabase: sessionAs('viewer'), error: null })
    const route = withRouteContext('test.write', async () => NextResponse.json({ data: 1 }), { requireWrite: true })

    const response = await route(new Request('http://localhost/api/x', { method: 'POST' }), {
      params: Promise.resolve({}),
    } as never)
    const body = (await response.json()) as { error: Record<string, unknown> }

    expect(response.status).toBe(403)
    expect(body.error).toMatchObject({
      code: 'FORBIDDEN',
      message_en: 'You only have read access in this company.',
      details: { code: 'ROLE_READ_ONLY' },
    })
    expect(getErrorMessage(body, { statusCode: 403 })).toBe('Du har endast läsbehörighet i detta företag.')
    expect(getErrorMessage(body, { statusCode: 403, locale: 'en' })).toBe('You only have read access in this company.')
  })

  it('answers the same on v1', async () => {
    const { status, error } = await throughV1('viewer')
    expect(status).toBe(403)
    expect(error).toMatchObject({
      code: 'FORBIDDEN',
      message: 'Du har endast läsbehörighet i detta företag.',
      details: { code: 'ROLE_READ_ONLY' },
    })
  })

  it('answers the same on MCP, where the reason used to be dropped', () => {
    expect(throughMcp({ role: 'viewer' })).toMatchObject({
      code: 'FORBIDDEN',
      retryable: false,
      details: { code: 'ROLE_READ_ONLY' },
    })
  })
})

describe('a write refused to a read-only connection', () => {
  it('names the connection on v1 and on MCP alike', async () => {
    const { status, error } = await throughV1('member', [COMPANY])
    expect(status).toBe(403)
    expect(error).toMatchObject({ code: 'FORBIDDEN', details: { code: 'CONNECTION_READ_ONLY' } })
    expect(throughMcp({ keyAccess: 'read' })).toMatchObject({
      code: 'FORBIDDEN',
      details: { code: 'CONNECTION_READ_ONLY' },
    })
  })
})

describe('readOnlyRefusal', () => {
  it('carries a sentence in both languages and the reason, for each reason', () => {
    for (const reason of ['ROLE_READ_ONLY', 'CONNECTION_READ_ONLY'] as const) {
      const refusal = readOnlyRefusal(reason)
      expect(refusal.details).toEqual({ code: reason })
      expect(refusal.messageSv).toContain('läsbehörighet')
      expect(refusal.messageEn).toContain('read access')
    }
  })
})
