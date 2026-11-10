/**
 * Every MCP tool is either scoped (TOOL_SCOPE_MAP) or deliberately open
 * (UNSCOPED_TOOLS), never neither: an unlisted tool used to be callable by any
 * key, which is how gnubok_get_party read customer and supplier parties
 * without a scope. The dispatcher now refuses a tool in neither list.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { eventBus } from '@/lib/events/bus'

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(),
  createServiceClient: vi.fn(),
}))

const COMPANY_ID = '11111111-1111-4111-8111-111111111111'

vi.mock('@/lib/auth/api-keys', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/auth/api-keys')>()
  return {
    ...actual,
    extractBearerToken: vi.fn().mockReturnValue('test-token'),
    validateApiKey: vi.fn(),
    createServiceClientNoCookies: vi.fn(() => ({
      from: vi.fn((table: string) => {
        if (table === 'company_members') {
          const chain: Record<string, ReturnType<typeof vi.fn>> = {}
          for (const method of ['select', 'eq', 'is']) chain[method] = vi.fn(() => chain)
          chain.maybeSingle = vi.fn().mockResolvedValue({ data: { company_id: COMPANY_ID, role: 'owner' }, error: null })
          return chain
        }
        const chain: Record<string, ReturnType<typeof vi.fn>> = {}
        for (const method of ['select', 'eq', 'is', 'not', 'in']) chain[method] = vi.fn(() => chain)
        chain.order = vi.fn().mockResolvedValue({ data: [], error: null })
        chain.range = vi.fn().mockResolvedValue({ data: [], error: null })
        chain.maybeSingle = vi.fn().mockResolvedValue({ data: null, error: null })
        return chain
      }),
    })),
  }
})

import { validateApiKey, TOOL_SCOPE_MAP, UNSCOPED_TOOLS, argumentScopeFor, type ApiKeyScope } from '@/lib/auth/api-keys'
import { handleMcpRequest, tools } from '../server'
import { PUBLIC_TOOLS } from '../public-tools'

function useKey(scopes: ApiKeyScope[]) {
  vi.mocked(validateApiKey).mockResolvedValue({
    userId: 'user-1',
    companyId: COMPANY_ID,
    scopes,
    apiKeyId: 'key-1',
    apiKeyName: 'Test Key',
  } as Awaited<ReturnType<typeof validateApiKey>>)
}

async function callTool(name: string, args: Record<string, unknown>) {
  const response = await handleMcpRequest(
    new Request('http://localhost:3000/api/extensions/ext/mcp-server/mcp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-token' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
    })
  )
  const body = (await response.json()) as { result?: { isError?: boolean; content?: Array<{ text: string }> } }
  const text = body.result?.content?.[0]?.text ?? ''
  return { isError: body.result?.isError === true, text }
}

const SUPPLIER_ID = '22222222-2222-4222-8222-222222222222'
const CUSTOMER_ID = '33333333-3333-4333-8333-333333333333'

describe('MCP tool scope coverage', () => {
  it('puts every registered tool in exactly one of TOOL_SCOPE_MAP and UNSCOPED_TOOLS', () => {
    const inBoth = tools.filter((t) => t.name in TOOL_SCOPE_MAP && UNSCOPED_TOOLS.has(t.name)).map((t) => t.name)
    const inNeither = tools.filter((t) => !(t.name in TOOL_SCOPE_MAP) && !UNSCOPED_TOOLS.has(t.name)).map((t) => t.name)
    expect(inBoth).toEqual([])
    expect(inNeither).toEqual([])
  })

  it('lists only registered tools as unscoped, and every public tool among them', () => {
    const names = new Set(tools.map((t) => t.name))
    expect([...UNSCOPED_TOOLS].filter((name) => !names.has(name))).toEqual([])
    expect([...PUBLIC_TOOLS].filter((name) => !UNSCOPED_TOOLS.has(name))).toEqual([])
  })

  it('gates gnubok_get_party on customers:read, and on suppliers:read too unless reached through a customer', () => {
    expect(TOOL_SCOPE_MAP.gnubok_get_party).toBe('customers:read')
    expect(argumentScopeFor('gnubok_get_party', { customer_id: CUSTOMER_ID })).toBeNull()
    expect(argumentScopeFor('gnubok_get_party', { supplier_id: SUPPLIER_ID })).toBe('suppliers:read')
    expect(argumentScopeFor('gnubok_get_party', { party_id: SUPPLIER_ID })).toBe('suppliers:read')
    expect(argumentScopeFor('gnubok_list_customers', { supplier_id: SUPPLIER_ID })).toBeNull()
  })

  it('gates a ledger record on gnubok_get_record by the scope of the tool that reads it alone', () => {
    expect(TOOL_SCOPE_MAP.gnubok_get_record).toBe('documents:read')
    expect(argumentScopeFor('gnubok_get_record', { record_ref: `transaction:${CUSTOMER_ID}` })).toBe('transactions:read')
    expect(argumentScopeFor('gnubok_get_record', { record_ref: ` invoice:${CUSTOMER_ID}` })).toBe('invoices:read')
    expect(argumentScopeFor('gnubok_get_record', { record_ref: `supplier_invoice:${CUSTOMER_ID}` })).toBe('suppliers:read')
    expect(argumentScopeFor('gnubok_get_record', { record_ref: `skattekonto_transaction:${CUSTOMER_ID}` })).toBe('reconciliation:read')
    // The archive kinds and a bare uuid (which resolves the archive kinds only) need documents:read alone.
    for (const record_ref of [`document:${CUSTOMER_ID}`, `journal_entry:${CUSTOMER_ID}`, CUSTOMER_ID, 42]) {
      expect(argumentScopeFor('gnubok_get_record', { record_ref })).toBeNull()
    }
  })
})

describe('MCP dispatcher scope gate', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    eventBus.clear()
  })

  it('refuses gnubok_get_party to a key without customers:read', async () => {
    useKey(['reports:read'])
    const result = await callTool('gnubok_get_party', { customer_id: CUSTOMER_ID })
    expect(result.isError).toBe(true)
    expect(result.text).toContain('INSUFFICIENT_SCOPE')
    expect(result.text).toContain('customers:read')
  })

  it('refuses a supplier party to a key with only customers:read', async () => {
    useKey(['customers:read'])
    for (const args of [{ supplier_id: SUPPLIER_ID }, { party_id: SUPPLIER_ID }]) {
      const result = await callTool('gnubok_get_party', args)
      expect(result.isError).toBe(true)
      expect(result.text).toContain('INSUFFICIENT_SCOPE')
      expect(result.text).toContain('suppliers:read')
    }
  })

  it('lets a customers:read key read a party through a customer', async () => {
    useKey(['customers:read'])
    const result = await callTool('gnubok_get_party', { customer_id: CUSTOMER_ID })
    expect(result.isError).toBe(false)
    expect(result.text).toContain('"found": false')
  })

  it('refuses an invoice through gnubok_get_record to a key with documents:read only', async () => {
    useKey(['documents:read'])
    const result = await callTool('gnubok_get_record', { record_ref: `invoice:${CUSTOMER_ID}` })
    expect(result.isError).toBe(true)
    expect(result.text).toContain('INSUFFICIENT_SCOPE')
    expect(result.text).toContain('invoices:read')
  })

  it('lets a key with both read scopes read a party through a supplier', async () => {
    useKey(['customers:read', 'suppliers:read'])
    const result = await callTool('gnubok_get_party', { supplier_id: SUPPLIER_ID })
    expect(result.isError).toBe(false)
  })

  describe('a tool in neither list', () => {
    const execute = vi.fn().mockResolvedValue({ ok: true })
    const name = 'gnubok_unlisted_test_tool'

    beforeEach(() => {
      tools.push({
        name,
        title: 'Unlisted',
        description: 'A tool registered without a scope.',
        inputSchema: { type: 'object', additionalProperties: false, properties: {} },
        annotations: { readOnlyHint: true },
        execute,
      } as unknown as (typeof tools)[number])
    })

    afterEach(() => {
      const index = tools.findIndex((t) => t.name === name)
      if (index >= 0) tools.splice(index, 1)
    })

    it('is refused before it runs, whatever the key holds', async () => {
      useKey(['customers:read', 'suppliers:read', 'reports:read', 'bookkeeping:write'])
      const result = await callTool(name, {})
      expect(result.isError).toBe(true)
      expect(result.text).toContain('FORBIDDEN')
      expect(execute).not.toHaveBeenCalled()
    })
  })
})
