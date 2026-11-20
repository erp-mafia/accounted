/**
 * The MCP half of the package door guard (lib/modules/package-doors.ts):
 * every hand-written write tool of a switchable package is classified as
 * start or continue, the pending types a start tool stages are refused at
 * approval and no continue tool stages one of them, and tools/call answers
 * PACKAGE_OFF for a start tool while the package is off, before anything is
 * staged.
 */
import { readFileSync } from 'fs'
import path from 'path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { eventBus } from '@/lib/events/bus'

vi.mock('@/lib/supabase/server', () => ({ createClient: vi.fn(), createServiceClient: vi.fn() }))

vi.mock('@/lib/auth/api-keys', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/auth/api-keys')>()
  const { createTableMockSupabase } = await import('@/tests/helpers')
  // The key's company and an owner's membership; every other read finds nothing.
  const mock = createTableMockSupabase({
    company_members: { data: { company_id: '11111111-1111-4111-8111-111111111111', role: 'owner' } },
  })
  return {
    ...actual,
    extractBearerToken: vi.fn().mockReturnValue('test-token'),
    validateApiKey: vi.fn().mockResolvedValue({
      userId: 'user-1',
      companyId: '11111111-1111-4111-8111-111111111111',
      scopes: ['payroll:write', 'payroll:read', 'invoices:write', 'transactions:write'],
      apiKeyId: 'key-1',
      apiKeyName: 'Test Key',
    }),
    createServiceClientNoCookies: vi.fn(() => mock.supabase),
  }
})

import { ALL_OPERATIONS } from '@/lib/operations/registry'
import { PACKAGE_DOORS, startPackageForPendingType, startPackageForTool } from '@/lib/modules/package-doors'
import { packageOffRefusal, packageStartRefusal } from '@/lib/modules/package-gate'
import { packageForModule } from '@/lib/modules/packages'
import { handleMcpRequest, tools } from '../server'
import { moduleForTool } from '../tool-modules'

const generated = new Set(ALL_OPERATIONS.flatMap((op) => (op.mcp ? [op.mcp.name] : [])))
const toolNames = new Set(tools.map((t) => t.name))
const entries = Object.entries(PACKAGE_DOORS).flatMap(([pkg, doors]) => [
  ...doors.start.map((key) => ({ pkg, key, kind: 'start' as const })),
  ...doors.continue.map((key) => ({ pkg, key, kind: 'continue' as const })),
])
const classified = new Map(entries.map((e) => [e.key, e]))

/** The pending types each hand-written tool's block stages (stage({ type: '...' })), read from the source. */
function stagedTypesByTool(): Map<string, Set<string>> {
  const source = readFileSync(path.resolve(__dirname, '../server.ts'), 'utf8')
  const starts = [...source.matchAll(/^\s{2,6}name: '(gnubok_[a-z0-9_]+)',/gm)].map((m) => ({ name: m[1], at: m.index! }))
  const notTypes = new Set(['object', 'string', 'array', 'number', 'boolean', 'integer', 'null', 'text', 'user', 'api_key', 'anonymous'])
  const out = new Map<string, Set<string>>()
  starts.forEach((tool, i) => {
    const block = source.slice(tool.at, starts[i + 1]?.at ?? source.length)
    const types = [...block.matchAll(/\btype:\s*'([a-z_]+)'/g)].map((m) => m[1]).filter((t) => !notTypes.has(t))
    out.set(tool.name, new Set(types))
  })
  return out
}

describe('MCP package doors', () => {
  it('classifies every hand-written write tool of a switchable package', () => {
    const missing = tools
      .filter((t) => !generated.has(t.name) && t.annotations?.readOnlyHint === false)
      .filter((t) => {
        const moduleId = moduleForTool(t.name)
        const pkg = moduleId ? packageForModule(moduleId) : null
        return pkg !== null && pkg !== 'bookkeeping' && !classified.has(`mcp:${t.name}`)
      })
      .map((t) => t.name)
    expect(missing).toEqual([])
  })

  it('names only live hand-written tools', () => {
    const stale = entries
      .filter((e) => e.key.startsWith('mcp:'))
      .map((e) => e.key.slice(4))
      .filter((name) => !toolNames.has(name) || generated.has(name))
    expect(stale).toEqual([])
  })

  it('refuses at approval what a start tool stages, and nothing a continue tool stages', () => {
    const staged = stagedTypesByTool()
    for (const e of entries) {
      if (!e.key.startsWith('mcp:')) continue
      const name = e.key.slice(4)
      for (const type of staged.get(name) ?? []) {
        const refused = startPackageForPendingType(type)
        if (e.kind === 'start') expect(refused, `${name} stages ${type}`).toBe(e.pkg)
        else expect(refused, `${name} stages ${type}, a start type`).toBeNull()
      }
    }
    // Every start tool that stages declares at least one refused type.
    for (const name of ['gnubok_create_invoice', 'gnubok_create_salary_run', 'gnubok_create_asset', 'gnubok_log_mileage_trip']) {
      expect([...(staged.get(name) ?? [])].length, name).toBeGreaterThan(0)
    }
  })

  it('gates a generated start tool by its operation', () => {
    for (const op of ALL_OPERATIONS) {
      if (!op.mcp) continue
      const expected = classified.get(`op:${op.id}`)?.kind === 'start' ? classified.get(`op:${op.id}`)!.pkg : null
      expect(startPackageForTool(op.mcp.name, op.id), op.mcp.name).toBe(expected)
    }
  })
})

function toolCall(name: string, args: Record<string, unknown> = {}): Request {
  return new Request('http://localhost:3000/api/extensions/ext/mcp-server/mcp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-token' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
  })
}

async function toolResult(response: Response): Promise<{ isError: boolean; payload: Record<string, unknown> }> {
  const json = await response.json()
  const result = json.result as { isError?: boolean; content: { text: string }[] }
  return { isError: result.isError === true, payload: JSON.parse(result.content[0].text) }
}

describe('tools/call package start gate', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    eventBus.clear()
  })

  it('answers PACKAGE_OFF for a start tool while the package is off, before anything is staged', async () => {
    vi.mocked(packageStartRefusal).mockResolvedValueOnce(packageOffRefusal('payroll', 'turned_off_by_company'))
    const telemetry = new Promise<Record<string, unknown>>((resolve) => {
      const off = eventBus.on('mcp.tool_called', (payload) => {
        off()
        resolve(payload as unknown as Record<string, unknown>)
      })
    })

    const { isError, payload } = await toolResult(
      await handleMcpRequest(toolCall('gnubok_create_salary_run', { period_year: 2026, period_month: 10, payment_date: '2026-10-25' })),
    )

    expect(isError).toBe(true)
    expect(payload.error).toMatchObject({
      code: 'PACKAGE_OFF',
      retryable: false,
      remediation: { tool: 'gnubok_enable_package', args: { package_id: 'payroll' } },
    })
    expect((payload.error as { message_sv: string }).message_sv).toMatch(/Slå på Lön under Anpassa\.$/)
    expect(packageStartRefusal).toHaveBeenCalledWith(expect.anything(), '11111111-1111-4111-8111-111111111111', 'payroll')
    expect((await telemetry).errorKind).toBe('package_off')
  })

  it('never asks for a tool that settles open work', async () => {
    await handleMcpRequest(toolCall('gnubok_book_salary_run', { salary_run_id: '6f1c2a40-0000-4000-8000-000000000001' }))
    expect(packageStartRefusal).not.toHaveBeenCalled()
  })
})
