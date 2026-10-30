/**
 * The permission shadow at the MCP door: the dispatcher tells it what the
 * write gate and the tool did, the JSON-RPC response is byte-identical
 * with the shadow on and off, and a disagreement schedules exactly one log
 * write.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { eventBus } from '@/lib/events/bus'

const mocks = vi.hoisted(() => ({
  companyId: '11111111-1111-4111-8111-111111111111',
  role: 'viewer' as string,
  scopes: ['customers:write', 'reports:read'] as string[],
  keyName: 'Skriptnyckel',
}))

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(),
  createServiceClient: vi.fn(),
}))

vi.mock('@/lib/auth/api-keys', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/auth/api-keys')>()
  const { createTableMockSupabase } = await import('@/tests/helpers')
  return {
    ...actual,
    extractBearerToken: vi.fn().mockReturnValue('test-token'),
    validateApiKey: vi.fn(async () => ({
      userId: 'user-1',
      companyId: mocks.companyId,
      scopes: mocks.scopes,
      apiKeyId: 'key-1',
      apiKeyName: mocks.keyName,
      mode: 'live',
      agentIdentityId: 'identity-1',
    })),
    // Every table reads empty but the membership, which answers the role.
    createServiceClientNoCookies: vi.fn(
      () =>
        createTableMockSupabase({
          company_members: () => ({ data: { company_id: mocks.companyId, role: mocks.role } }),
        }).supabase,
    ),
  }
})

vi.mock('@/lib/entitlements/has-capability', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/entitlements/has-capability')>()
  return { ...actual, hasCapability: vi.fn().mockResolvedValue(true) }
})
vi.mock('@/lib/entitlements/multi-user', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/entitlements/multi-user')>()
  return { ...actual, getMultiUserState: vi.fn().mockResolvedValue({ state: 'entitled', graceEndsAt: null }) }
})

import { insertShadowRow } from '@/lib/permissions/shadow-writer'
import { resetPermissionShadowForTests } from '@/lib/permissions/shadow'
import { handleMcpRequest, toolPermissionDoor, tools } from '../server'

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

function mcpToolCall(name: string, args: Record<string, unknown> = {}): Request {
  return new Request('http://localhost:3000/api/extensions/ext/mcp-server/mcp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-token' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
  })
}

async function snapshot(res: Response) {
  const headers = [...res.headers.entries()]
  return { status: res.status, headers, body: await res.text() }
}

async function callTwice(name: string, args: Record<string, unknown>) {
  process.env.PERMISSIONS_SHADOW = 'off'
  const off = await snapshot(await handleMcpRequest(mcpToolCall(name, args)))
  await flush()
  expect(insertShadowRow).not.toHaveBeenCalled()
  delete process.env.PERMISSIONS_SHADOW
  const on = await snapshot(await handleMcpRequest(mcpToolCall(name, args)))
  await flush()
  return { off, on }
}

describe('MCP dispatcher: permission shadow', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    eventBus.clear()
    resetPermissionShadowForTests()
    delete process.env.PERMISSIONS_SHADOW
    mocks.role = 'viewer'
    mocks.scopes = ['customers:write', 'reports:read']
    mocks.keyName = 'Skriptnyckel'
  })
  afterEach(() => {
    delete process.env.PERMISSIONS_SHADOW
  })

  it("logs nothing where the write gate's refusal is decide()'s too, and answers the same", async () => {
    const { off, on } = await callTwice('gnubok_create_customer', { name: 'Kund AB', customer_type: 'company' })
    expect(on).toEqual(off)
    expect(on.body).toContain('read-only (viewer)')
    expect(insertShadowRow).not.toHaveBeenCalled()
  })

  it('does not compare a missing scope, and answers the same', async () => {
    mocks.role = 'member'
    // customers:write gives the invoicing permission; the invoice tool needs invoices:write.
    const { off, on } = await callTwice('gnubok_create_invoice', {})
    expect(on).toEqual(off)
    expect(on.body).toContain('INSUFFICIENT_SCOPE')
    expect(insertShadowRow).not.toHaveBeenCalled()
  })

  it("answers the same and logs one row when an OAuth key's direct write passes where decide() would refuse it", async () => {
    mocks.role = 'member'
    mocks.scopes = ['transactions:write']
    mocks.keyName = 'MCP-klient (OAuth)'
    const { off, on } = await callTwice('gnubok_create_transactions', { transactions: [] })
    expect(on).toEqual(off)
    expect(insertShadowRow).toHaveBeenCalledTimes(1)
    expect(insertShadowRow).toHaveBeenCalledWith(
      expect.objectContaining({
        door: 'mcp:gnubok_create_transactions',
        principal_kind: 'agent',
        today_outcome: 'allow',
        decide_outcome: 'deny',
        decide_reason: 'STAGE_REQUIRED',
        permission: 'bookkeeping.write',
        expected: false,
      }),
    )
  })

  it('classifies every tool the dispatcher can reach', () => {
    const unclassified = tools.filter((t) => toolPermissionDoor(t) === null).map((t) => t.name)
    expect(unclassified).toEqual([])
  })
})
