/**
 * One OAuth key, the name it leaves behind at each door. The v1 write, the v1
 * approval and an MCP tool call each worked it out for themselves, so one agent
 * read as three actors in Behandlingshistoriken: api_key with the reserved name,
 * mcp_oauth with the reserved name, mcp_oauth with the client's name.
 */
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'

const commitSpy = vi.hoisted(() => vi.fn(async () => ({ status: 'committed', data: {} })))
vi.mock('@/lib/pending-operations/commit', () => ({ commitPendingOperation: commitSpy }))
vi.mock('@/lib/processing-history/append', () => ({ appendProcessingHistory: vi.fn(async () => {}) }))
vi.mock('@/lib/import/sie-period-read', () => ({
  withSIEExternalReport: (_s: unknown, _c: unknown, _o: unknown, fn: () => unknown) => fn(),
}))
vi.mock('@/lib/auth/api-keys', async () => {
  const actual = await vi.importActual<typeof import('@/lib/auth/api-keys')>('@/lib/auth/api-keys')
  return { ...actual, validateApiKey: vi.fn(), createServiceClientNoCookies: vi.fn() }
})

import { credentialActor, createServiceClientNoCookies, OAUTH_MCP_KEY_NAME, validateApiKey } from '@/lib/auth/api-keys'
import { withApiV1, type ApiV1Context } from '@/lib/api/v1/with-api-v1'
import { registerEndpoint } from '@/lib/api/v1/registry'
import { ok } from '@/lib/api/v1/response'
import { approvePendingOperationAsApiKey } from '@/lib/pending-operations/api-approval'
import { mcpCommitActorType, mcpToolCallActor } from '@/extensions/general/mcp-server/commit-actor'

const COMPANY = '11111111-1111-4111-8111-111111111111'
const USER = '22222222-2222-4222-8222-222222222222'
const SAME_NAME = { type: 'mcp_oauth', label: 'Claude (Anthropic)' }

const key = {
  userId: USER,
  companyId: COMPANY,
  apiKeyId: 'key-oauth',
  apiKeyName: OAUTH_MCP_KEY_NAME,
  client: 'claude',
  scopes: ['bookkeeping:write'],
  mode: 'live',
  unattendedCommitLimit: null,
  allowedCompanyIds: null,
  readOnlyCompanyIds: null,
  serviceAccount: null,
}

function db() {
  const query: Record<string, unknown> = {}
  for (const method of ['select', 'eq', 'is']) query[method] = () => query
  query.maybeSingle = async () => ({ data: { id: 'op-1', company_id: COMPANY, role: 'owner', status: 'pending', operation_type: 'create_customer', params: {}, risk_level: 'low' }, error: null })
  return { from: () => query, auth: { admin: { getUserById: async () => ({ data: { user: { email: 'a@b.se' } } }) } } }
}

async function v1Context(): Promise<ApiV1Context> {
  vi.mocked(validateApiKey).mockResolvedValue(key as never)
  vi.mocked(createServiceClientNoCookies).mockReturnValue(db() as never)
  let seen: ApiV1Context | null = null
  const route = withApiV1<{ params: Promise<{ companyId: string }> }>('journal-entries.create', async (_request, ctx) => {
    seen = ctx
    return ok({}, { requestId: ctx.requestId })
  })
  await route(
    new Request(`http://localhost/api/v1/companies/${COMPANY}/journal-entries`, {
      method: 'POST',
      headers: { authorization: 'Bearer gnubok_sk_test' },
    }),
    { params: Promise.resolve({ companyId: COMPANY }) },
  )
  if (!seen) throw new Error('the handler never ran')
  return seen
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

describe('one OAuth key at every door', () => {
  it('a v1 write', async () => {
    const ctx = await v1Context()
    expect(ctx.actor).toMatchObject(SAME_NAME)
  })

  it('a v1 approval', async () => {
    const ctx = await v1Context()
    await approvePendingOperationAsApiKey(db() as never, {
      companyId: COMPANY,
      operationId: 'op-1',
      confirmed: false,
      log: { warn() {}, info() {}, error() {} } as never,
      approver: { userId: USER, apiKeyId: 'key-oauth', actor: ctx.actor, unattendedCommitLimit: null },
    })
    expect((commitSpy.mock.calls as unknown[][])[0][4]).toMatchObject({ actor: SAME_NAME })
  })

  it('an MCP tool call and an MCP approval', () => {
    const credential = credentialActor(key as never)
    const connection = { type: 'api_key', label: credential.label, oauthKey: credential.type === 'mcp_oauth' }
    expect(mcpToolCallActor(connection, USER)).toMatchObject(SAME_NAME)
    expect(mcpCommitActorType(connection)).toBe(SAME_NAME.type)
  })
})
