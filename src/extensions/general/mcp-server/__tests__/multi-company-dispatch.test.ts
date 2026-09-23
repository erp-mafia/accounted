import { beforeEach, describe, expect, it, vi } from 'vitest'
import { eventBus } from '@/lib/events/bus'

const DEFAULT_COMPANY_ID = '11111111-1111-4111-8111-111111111111'
const OTHER_COMPANY_ID = '22222222-2222-4222-8222-222222222222'

const mocks = vi.hoisted(() => ({
  membership: {
    data: {
      company_id: '22222222-2222-4222-8222-222222222222',
      role: 'owner',
    } as Record<string, unknown> | null,
    error: null as { message: string } | null,
  },
  companyIds: [] as string[],
  hasCapability: vi.fn(),
}))

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(),
  createServiceClient: vi.fn(),
}))

vi.mock('@/lib/auth/api-keys', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/auth/api-keys')>()
  return {
    ...actual,
    extractBearerToken: vi.fn().mockReturnValue('test-token'),
    validateApiKey: vi.fn().mockResolvedValue({
      userId: 'user-1',
      companyId: '11111111-1111-4111-8111-111111111111',
      scopes: ['companies:read', 'invoices:write', 'reports:read'],
      apiKeyId: 'key-1',
      apiKeyName: 'Test Key',
    }),
    createServiceClientNoCookies: vi.fn(() => ({
      from: vi.fn((table: string) => {
        if (table !== 'company_members') throw new Error(`Unexpected table: ${table}`)
        const chain: Record<string, ReturnType<typeof vi.fn>> = {
          select: vi.fn(() => chain),
          eq: vi.fn((column: string, value: string) => {
            if (column === 'company_id') mocks.companyIds.push(value)
            return chain
          }),
          is: vi.fn(() => chain),
          maybeSingle: vi.fn(async () => mocks.membership),
        }
        return chain
      }),
    })),
  }
})

vi.mock('@/lib/entitlements/has-capability', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/entitlements/has-capability')>()
  return { ...actual, hasCapability: mocks.hasCapability }
})

// Multi-user seat gate: entitled here, so the strict company_members-only
// table mock above stays valid for non-owner roles (the gate would otherwise
// read companies + capability_grants). Gate behavior is covered in
// company-routing.test.ts and lib/entitlements/__tests__/multi-user.test.ts.
vi.mock('@/lib/entitlements/multi-user', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/entitlements/multi-user')>()
  return {
    ...actual,
    getMultiUserState: vi.fn().mockResolvedValue({ state: 'entitled', graceEndsAt: null }),
  }
})

import { handleMcpRequest } from '../server'

function toolCall(args: Record<string, unknown>): Request {
  return new Request('http://localhost:3000/api/extensions/ext/mcp-server/mcp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-token' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'gnubok_send_invoice', arguments: args },
    }),
  })
}

async function parseToolResult(response: Response) {
  const json = await response.json()
  const result = json.result as { isError?: boolean; content: Array<{ text: string }> }
  return {
    isError: result.isError === true,
    payload: JSON.parse(result.content[0].text) as Record<string, unknown>,
  }
}

describe('MCP multi-company dispatch', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    eventBus.clear()
    mocks.companyIds.length = 0
    mocks.membership = {
      data: { company_id: OTHER_COMPANY_ID, role: 'owner' },
      error: null,
    }
    mocks.hasCapability.mockResolvedValue(false)
  })

  it('routes a tool call to an accessible requested company', async () => {
    const result = await parseToolResult(
      await handleMcpRequest(
        toolCall({ invoice_id: 'invoice-1', company_id: OTHER_COMPANY_ID })
      )
    )

    expect(result.isError).toBe(true)
    expect((result.payload.error as Record<string, unknown>).capability_blocked).toBe(true)
    expect(mocks.companyIds).toEqual([OTHER_COMPANY_ID])
    expect(mocks.hasCapability).toHaveBeenCalledWith(
      expect.anything(),
      OTHER_COMPANY_ID,
      'email_send'
    )
  })

  it('revalidates and uses the API key default company when company_id is omitted', async () => {
    mocks.membership.data = { company_id: DEFAULT_COMPANY_ID, role: 'admin' }

    await handleMcpRequest(toolCall({ invoice_id: 'invoice-1' }))

    expect(mocks.companyIds).toEqual([DEFAULT_COMPANY_ID])
    expect(mocks.hasCapability).toHaveBeenCalledWith(
      expect.anything(),
      DEFAULT_COMPANY_ID,
      'email_send'
    )
  })

  it('rejects a company the user does not belong to before capability or execution', async () => {
    mocks.membership.data = null

    const result = await parseToolResult(
      await handleMcpRequest(
        toolCall({ invoice_id: 'invoice-1', company_id: OTHER_COMPANY_ID })
      )
    )

    expect(result.isError).toBe(true)
    expect((result.payload.error as Record<string, unknown>).code).toBe('NOT_FOUND')
    expect(mocks.hasCapability).not.toHaveBeenCalled()
  })

  it('rejects writes for a viewer in the selected company', async () => {
    mocks.membership.data = { company_id: OTHER_COMPANY_ID, role: 'viewer' }

    const result = await parseToolResult(
      await handleMcpRequest(
        toolCall({ invoice_id: 'invoice-1', company_id: OTHER_COMPANY_ID })
      )
    )

    expect(result.isError).toBe(true)
    expect((result.payload.error as Record<string, unknown>).code).toBe('FORBIDDEN')
    expect(mocks.hasCapability).not.toHaveBeenCalled()
  })

  it('rejects malformed company_id before querying membership', async () => {
    const result = await parseToolResult(
      await handleMcpRequest(
        toolCall({ invoice_id: 'invoice-1', company_id: 'not-a-uuid' })
      )
    )

    expect(result.isError).toBe(true)
    expect((result.payload.error as Record<string, unknown>).code).toBe('VALIDATION_ERROR')
    expect(mocks.companyIds).toEqual([])
    expect(mocks.hasCapability).not.toHaveBeenCalled()
  })
})
