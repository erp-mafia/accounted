/**
 * WHO stamps on an approval made through an OAuth connector (claude.ai,
 * ChatGPT). credentialActor (lib/auth/api-keys.ts) names the key, on this door
 * as on v1: mcp_oauth, labelled with the client's display name. The stamp used
 * to compare the label with the reserved name, so every connector commit said
 * api_key.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { eventBus } from '@/lib/events/bus'

// Hoisted with the vi.mock factories that read them.
const { COMPANY_ID, OPERATION_ID } = vi.hoisted(() => ({
  COMPANY_ID: '11111111-1111-4111-8111-111111111111',
  OPERATION_ID: '11111111-1111-4111-8111-111111111112',
}))

const commitSpy = vi.fn()
vi.mock('@/lib/pending-operations/commit', () => ({
  commitPendingOperation: (...args: unknown[]) => commitSpy(...args),
}))

vi.mock('@/lib/processing-history/append', () => ({
  appendProcessingHistory: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(),
  createServiceClient: vi.fn(),
}))

const keyFixture = vi.hoisted(() => ({
  apiKeyName: 'MCP-klient (OAuth)',
  client: 'claude' as string | null,
  serviceAccount: null as { id: string; name: string } | null,
  unattendedCommitLimit: null as number | null,
}))

vi.mock('@/lib/auth/api-keys', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/auth/api-keys')>()
  const { createTableMockSupabase } = await import('@/tests/helpers')
  // Each table answers with the row it holds: company_members an owner seat,
  // pending_operations the staged operation; everything else nothing.
  const { supabase } = createTableMockSupabase({
    company_members: { data: { company_id: COMPANY_ID, role: 'owner' } },
    pending_operations: {
      data: {
        id: OPERATION_ID,
        company_id: COMPANY_ID,
        operation_type: 'create_invoice',
        status: 'pending',
        risk_level: 'medium',
        params: {},
      },
    },
  })
  return {
    ...actual,
    extractBearerToken: vi.fn().mockReturnValue('test-token'),
    validateApiKey: vi.fn(async () => ({
      userId: 'user-1',
      companyId: COMPANY_ID,
      scopes: ['pending_operations:approve', 'pending_operations:read'],
      apiKeyId: 'key-oauth-1',
      apiKeyName: keyFixture.apiKeyName,
      client: keyFixture.client,
      mode: 'live',
      serviceAccount: keyFixture.serviceAccount,
      unattendedCommitLimit: keyFixture.unattendedCommitLimit,
    })),
    createServiceClientNoCookies: vi.fn(() => supabase),
  }
})

vi.mock('@/lib/auth/rate-limit-http', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/auth/rate-limit-http')>()
  return { ...actual, getRedis: vi.fn(() => null) }
})

vi.mock('@/lib/entitlements/has-capability', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/entitlements/has-capability')>()
  return { ...actual, hasCapability: vi.fn().mockResolvedValue(true) }
})

import { handleMcpRequest } from '../server'
import { appendProcessingHistory } from '@/lib/processing-history/append'
import { getActor } from '@/lib/bookkeeping/actor-context'

function approveRequest(): Request {
  return new Request('http://localhost:3000/api/extensions/ext/mcp-server/mcp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-token' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'gnubok_approve_pending_operation', arguments: { operation_id: OPERATION_ID } },
    }),
  })
}

async function approveAndReadCommitOptions(): Promise<{ commitMethod?: string; actor?: Record<string, unknown> }> {
  const response = await handleMcpRequest(approveRequest())
  const json = (await response.json()) as { result?: { isError?: boolean; content?: { text: string }[] } }
  expect(json.result?.isError, json.result?.content?.[0]?.text).not.toBe(true)
  expect(commitSpy).toHaveBeenCalledTimes(1)
  return commitSpy.mock.calls[0][4] as { commitMethod?: string; actor?: Record<string, unknown> }
}

describe('MCP approval through an OAuth connector: commit actor', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    eventBus.clear()
    keyFixture.apiKeyName = 'MCP-klient (OAuth)'
    keyFixture.client = 'claude'
    keyFixture.serviceAccount = null
    keyFixture.unattendedCommitLimit = null
    commitSpy.mockResolvedValue({ status: 'committed' })
  })

  it('stamps mcp_oauth for a claude.ai key and keeps the display name as the label', async () => {
    const options = await approveAndReadCommitOptions()
    expect(options.commitMethod).toBe('api_key')
    expect(options.actor).toMatchObject({ type: 'mcp_oauth', label: 'Claude (Anthropic)' })
  })

  it('stamps mcp_oauth for a ChatGPT key', async () => {
    keyFixture.client = 'chatgpt'
    const options = await approveAndReadCommitOptions()
    expect(options.actor).toMatchObject({ type: 'mcp_oauth', label: 'ChatGPT (OpenAI)' })
  })

  it('stamps mcp_oauth when the provider is unknown and the reserved name stays the label', async () => {
    keyFixture.client = null
    const options = await approveAndReadCommitOptions()
    expect(options.actor).toMatchObject({ type: 'mcp_oauth', label: 'MCP-klient (OAuth)' })
  })

  it('keeps api_key for a key a person created, whatever it is called', async () => {
    keyFixture.apiKeyName = 'Claude (Anthropic)'
    keyFixture.client = null
    const options = await approveAndReadCommitOptions()
    expect(options.actor).toMatchObject({ type: 'api_key', label: 'Claude (Anthropic)' })
  })

  it("stamps service_account for a service account's key, on the commit and in the processing history", async () => {
    keyFixture.apiKeyName = 'Nyckel 1'
    keyFixture.serviceAccount = { id: 'sa-1', name: 'Nattlig synk' }
    const options = await approveAndReadCommitOptions()
    expect(options.actor).toMatchObject({ type: 'service_account', label: 'Nattlig synk' })
    expect(appendProcessingHistory).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'PendingOperationApproved',
        actor: { type: 'service_account', id: 'key-oauth-1', label: 'Nattlig synk' },
      }),
    )
  })

  it('keeps api_key in the processing history for a person key', async () => {
    keyFixture.apiKeyName = 'Integration'
    keyFixture.client = null
    await approveAndReadCommitOptions()
    expect(appendProcessingHistory).toHaveBeenCalledWith(
      expect.objectContaining({ actor: { type: 'api_key', id: 'key-oauth-1', label: 'Integration' } }),
    )
  })
})

describe('MCP tool call: the actor scope it runs in', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    eventBus.clear()
    keyFixture.apiKeyName = 'MCP-klient (OAuth)'
    keyFixture.client = 'claude'
    keyFixture.serviceAccount = null
    keyFixture.unattendedCommitLimit = null
  })

  /** What the scope looked like while the tool ran (the commit happens inside the approve tool). */
  async function actorDuringToolCall(): Promise<ReturnType<typeof getActor>> {
    let seen: ReturnType<typeof getActor>
    commitSpy.mockImplementation(async () => {
      seen = getActor()
      return { status: 'committed' }
    })
    await approveAndReadCommitOptions()
    return seen
  }

  it("names the connector and the key's user, so the audit rows of its service-role writes name them", async () => {
    // commitPendingOperation is mocked, so this is the tool call's own scope,
    // the one every service-role request of the call sends as x-accounted-actor.
    expect(await actorDuringToolCall()).toEqual({ type: 'mcp_oauth', label: 'Claude (Anthropic)', userId: 'user-1' })
    // Nothing leaks past the request.
    expect(getActor()).toBeUndefined()
  })

  it("names a service account and its sponsor for a service account's key", async () => {
    keyFixture.apiKeyName = 'Nyckel 1'
    keyFixture.serviceAccount = { id: 'sa-1', name: 'Nattlig synk' }
    expect(await actorDuringToolCall()).toEqual({ type: 'service_account', label: 'Nattlig synk', userId: 'user-1' })
  })

  it("leaves the key's unattended ceiling out of the scope: direct MCP writes were never bound by it", async () => {
    keyFixture.apiKeyName = 'Integration'
    keyFixture.client = null
    keyFixture.unattendedCommitLimit = 5000
    const seen = await actorDuringToolCall()
    expect(seen).toEqual({ type: 'api_key', label: 'Integration', userId: 'user-1' })
    expect(seen).not.toHaveProperty('unattendedCommitLimit')
  })
})
