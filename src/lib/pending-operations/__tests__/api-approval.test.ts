/**
 * Who an API-key approval records as the commit actor: the key (api_key), an
 * OAuth connection (mcp_oauth), or a service account (service_account, named
 * after the account, acting for its sponsor).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const commitMock = vi.hoisted(() => vi.fn())
const appendMock = vi.hoisted(() => vi.fn())
vi.mock('../commit', () => ({ commitPendingOperation: commitMock }))
vi.mock('@/lib/processing-history/append', () => ({ appendProcessingHistory: appendMock }))

import { credentialActor, OAUTH_MCP_KEY_NAME } from '@/lib/auth/api-keys'
import { approvePendingOperationAsApiKey } from '../api-approval'
import type { Logger } from '@/lib/logger'

const COMPANY_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const OPERATION_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'

const log = { warn: vi.fn(), info: vi.fn(), error: vi.fn(), child: vi.fn() } as unknown as Logger

function supabase() {
  const chain = {
    select: () => chain,
    eq: () => chain,
    maybeSingle: async () => ({
      data: {
        id: OPERATION_ID,
        company_id: COMPANY_ID,
        status: 'pending',
        risk_level: 'low',
        operation_type: 'categorize_transaction',
        params: {},
      },
      error: null,
    }),
  }
  return {
    from: () => chain,
    auth: { admin: { getUserById: async () => ({ data: { user: { email: 'sponsor@example.se' } } }) } },
  } as never
}

async function approveAs(approver: Parameters<typeof approvePendingOperationAsApiKey>[1]['approver']) {
  await approvePendingOperationAsApiKey(supabase(), {
    companyId: COMPANY_ID,
    operationId: OPERATION_ID,
    confirmed: false,
    approver,
    log,
  })
  return commitMock.mock.calls[0]![4] as { commitMethod: string; actor: Record<string, unknown> }
}

beforeEach(() => {
  commitMock.mockReset()
  commitMock.mockResolvedValue({ status: 'committed', data: {} })
  appendMock.mockReset()
  appendMock.mockResolvedValue('event-1')
})

/** The actor of the PendingOperationApproved processing_history row. */
const historyActor = () => (appendMock.mock.calls[0]![0] as { actor: Record<string, unknown> }).actor

describe('approvePendingOperationAsApiKey commit actor', () => {
  it('records a person key as api_key with its name', async () => {
    const opts = await approveAs({
      userId: 'u1',
      apiKeyId: 'k1',
      actor: credentialActor({ apiKeyName: 'Integration', serviceAccount: null }),
      unattendedCommitLimit: 500,
    })
    expect(opts).toMatchObject({
      commitMethod: 'api_key',
      actor: { type: 'api_key', label: 'Integration', unattendedCommitLimit: 500 },
    })
    expect(historyActor()).toEqual({ type: 'api_key', id: 'k1', label: 'Integration' })
  })

  it('records an OAuth connection as mcp_oauth, named as its client, as the MCP door does', async () => {
    const opts = await approveAs({
      userId: 'u1',
      apiKeyId: 'k1',
      actor: credentialActor({ apiKeyName: OAUTH_MCP_KEY_NAME, client: 'claude', serviceAccount: null }),
      unattendedCommitLimit: null,
    })
    expect(opts.actor).toMatchObject({ type: 'mcp_oauth', label: 'Claude (Anthropic)' })
    expect(historyActor()).toEqual({ type: 'api_key', id: 'k1', label: 'Claude (Anthropic)' })
  })

  it("records a service account's key as service_account, named after the account, keeping the key's ceiling", async () => {
    const opts = await approveAs({
      userId: 'sponsor-1',
      apiKeyId: 'k-sa',
      actor: credentialActor({ apiKeyName: 'Nyckel 1', serviceAccount: { id: 'sa-1', name: 'Nattlig synk' } }),
      unattendedCommitLimit: 1000,
    })
    expect(opts).toMatchObject({
      commitMethod: 'api_key',
      actor: { type: 'service_account', label: 'Nattlig synk', unattendedCommitLimit: 1000 },
    })
    // The commit runs as the sponsor: the user the rows carry.
    expect(commitMock.mock.calls[0]![1]).toBe('sponsor-1')
    // The processing history names the service account too, not api_key.
    expect(historyActor()).toEqual({ type: 'service_account', id: 'k-sa', label: 'Nattlig synk' })
  })
})
