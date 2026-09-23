/**
 * Tests for the MCP Tasks extension (io.modelcontextprotocol/tasks):
 * capability gating, CreateTaskResult, post-response completion writes,
 * and the tasks/get / tasks/update / tasks/cancel methods. Does NOT re-test
 * audit-package generation itself (covered by audit-package.test.ts).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { eventBus } from '@/lib/events/bus'
import { isTaskCapableClient, TASKS_EXTENSION_ID } from '../tasks'

const mocks = vi.hoisted(() => ({
  scopes: [] as string[],
  taskInserts: [] as Record<string, unknown>[],
  taskUpdates: [] as Record<string, unknown>[],
  taskRow: null as Record<string, unknown> | null,
}))

vi.mock('@/lib/auth/api-keys', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/auth/api-keys')>()
  mocks.scopes = [...actual.ALL_SCOPES]

  const membershipChain: unknown = new Proxy(
    {},
    {
      get(_t, prop) {
        if (prop === 'then') {
          return (resolve: (v: unknown) => void) =>
            resolve({
              data: { company_id: '11111111-1111-4111-8111-111111111111', role: 'owner' },
              error: null,
            })
        }
        return () => membershipChain
      },
    }
  )

  const makeChain = (result: unknown): unknown =>
    new Proxy(
      {},
      {
        get(_t, prop) {
          if (prop === 'then') {
            return (resolve: (v: unknown) => void) => resolve(result)
          }
          if (prop === 'single') {
            return () => Promise.resolve(result)
          }
          return () => makeChain(result)
        },
      }
    )

  const tasksBuilder = {
    delete: () => makeChain({ data: null, error: null }),
    insert: (row: Record<string, unknown>) => {
      mocks.taskInserts.push(row)
      return {
        select: () => ({
          single: async () => ({
            data: {
              id: 'task-1',
              company_id: row.company_id,
              user_id: row.user_id,
              tool_name: row.tool_name,
              status: 'working',
              status_message: null,
              result: null,
              error: null,
              poll_interval_ms: 2000,
              ttl_ms: 3600000,
              created_at: '2026-07-29T09:00:00.000Z',
            },
            error: null,
          }),
        }),
      }
    },
    update: (patch: Record<string, unknown>) => {
      mocks.taskUpdates.push(patch)
      return makeChain({ data: null, error: null })
    },
    select: () =>
      makeChain(
        mocks.taskRow
          ? { data: mocks.taskRow, error: null }
          : { data: null, error: { message: 'not found' } }
      ),
  }

  return {
    ...actual,
    extractBearerToken: vi.fn().mockReturnValue('test-token'),
    validateApiKey: vi.fn().mockResolvedValue({
      userId: 'user-1',
      companyId: '11111111-1111-4111-8111-111111111111',
      scopes: mocks.scopes,
      apiKeyId: 'key-1',
      apiKeyName: 'Test key',
      mode: 'live',
    }),
    createServiceClientNoCookies: vi.fn(() => ({
      from: (table: string) => {
        if (table === 'mcp_tasks') return tasksBuilder
        if (table === 'company_members') return membershipChain
        // fiscal_periods (and everything else) resolves to no rows, so the
        // audit-package execution fails fast with "Fiscal period not found".
        return makeChain({ data: null, error: { message: 'not found' }, count: 0 })
      },
    })),
  }
})

import { handleMcpRequest } from '../server'

const TASK_META = {
  'io.modelcontextprotocol/protocolVersion': '2026-07-28',
  'io.modelcontextprotocol/clientCapabilities': {
    extensions: { [TASKS_EXTENSION_ID]: {} },
  },
}

function mcpRequest(method: string, params?: Record<string, unknown>): Request {
  return new Request('http://localhost:3000/api/extensions/ext/mcp-server/mcp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-token' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, ...(params ? { params } : {}) }),
  })
}

async function readBody(request: Request): Promise<{
  result?: Record<string, unknown>
  error?: { code: number; message: string }
}> {
  const response = await handleMcpRequest(request)
  const body = await response.json()
  return { result: body.result, error: body.error }
}

/** The after() fallback runs the job as a floating promise: let it settle. */
async function settleBackgroundWork(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0))
  await new Promise((resolve) => setTimeout(resolve, 0))
}

describe('MCP Tasks extension', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    eventBus.clear()
    mocks.taskInserts.length = 0
    mocks.taskUpdates.length = 0
    mocks.taskRow = null
  })

  describe('capability detection', () => {
    it('detects the tasks extension in per-request capabilities', () => {
      expect(isTaskCapableClient(TASK_META as Record<string, unknown>)).toBe(true)
      expect(isTaskCapableClient({})).toBe(false)
      expect(
        isTaskCapableClient({
          'io.modelcontextprotocol/clientCapabilities': { extensions: {} },
        })
      ).toBe(false)
    })

    it('advertises the tasks extension in server/discover', async () => {
      const { result } = await readBody(mcpRequest('server/discover'))
      const capabilities = result?.capabilities as { extensions: Record<string, unknown> }
      expect(capabilities.extensions[TASKS_EXTENSION_ID]).toEqual({})
    })
  })

  describe('CreateTaskResult', () => {
    it('returns a task handle to a task-capable client and completes after the response', async () => {
      const { result } = await readBody(
        mcpRequest('tools/call', {
          name: 'gnubok_audit_package',
          arguments: { fiscal_period_id: '22222222-2222-4222-8222-222222222222' },
          _meta: TASK_META,
        })
      )
      expect(result?.resultType).toBe('task')
      const task = result?.task as Record<string, unknown>
      expect(task.taskId).toBe('task-1')
      expect(task.status).toBe('working')
      expect(typeof task.pollIntervalMs).toBe('number')
      expect(typeof task.ttlMs).toBe('number')
      expect(mocks.taskInserts).toHaveLength(1)

      await settleBackgroundWork()
      // The mocked DB has no fiscal period, so the execution fails and the
      // task completes with the standard isError envelope.
      expect(mocks.taskUpdates).toHaveLength(1)
      expect(mocks.taskUpdates[0].status).toBe('completed')
      const stored = mocks.taskUpdates[0].result as Record<string, unknown>
      expect(stored.isError).toBe(true)
      expect(stored.resultType).toBe('complete')
    })

    it('never returns a task to a client that did not declare the extension', async () => {
      const { result } = await readBody(
        mcpRequest('tools/call', {
          name: 'gnubok_audit_package',
          arguments: { fiscal_period_id: '22222222-2222-4222-8222-222222222222' },
          _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28' },
        })
      )
      expect(result?.resultType).not.toBe('task')
      expect(result?.isError).toBe(true)
      expect(mocks.taskInserts).toHaveLength(0)
    })

    it('keeps estimate_only synchronous even for task-capable clients', async () => {
      const { result } = await readBody(
        mcpRequest('tools/call', {
          name: 'gnubok_audit_package',
          arguments: {
            fiscal_period_id: '22222222-2222-4222-8222-222222222222',
            estimate_only: true,
          },
          _meta: TASK_META,
        })
      )
      expect(result?.resultType).not.toBe('task')
      expect(mocks.taskInserts).toHaveLength(0)
    })
  })

  describe('tasks/get', () => {
    it('returns the working state while the task runs', async () => {
      mocks.taskRow = {
        id: 'task-1',
        company_id: '11111111-1111-4111-8111-111111111111',
        user_id: 'user-1',
        tool_name: 'gnubok_audit_package',
        status: 'working',
        status_message: null,
        result: null,
        error: null,
        poll_interval_ms: 2000,
        ttl_ms: 3600000,
        created_at: '2026-07-29T09:00:00.000Z',
      }
      const { result } = await readBody(mcpRequest('tasks/get', { taskId: 'task-1' }))
      expect(result?.status).toBe('working')
      expect(result?.result).toBeUndefined()
      expect(result?.resultType).toBe('complete')
    })

    it('returns the stored tool result on completion', async () => {
      const storedResult = {
        resultType: 'complete',
        content: [{ type: 'text', text: '{"file_name":"arkiv.zip"}' }],
        structuredContent: { file_name: 'arkiv.zip' },
      }
      mocks.taskRow = {
        id: 'task-1',
        company_id: '11111111-1111-4111-8111-111111111111',
        user_id: 'user-1',
        tool_name: 'gnubok_audit_package',
        status: 'completed',
        status_message: null,
        result: storedResult,
        error: null,
        poll_interval_ms: 2000,
        ttl_ms: 3600000,
        created_at: '2026-07-29T09:00:00.000Z',
      }
      const { result } = await readBody(mcpRequest('tasks/get', { taskId: 'task-1' }))
      expect(result?.status).toBe('completed')
      expect(result?.result).toEqual(storedResult)
    })

    it('rejects unknown task ids with invalid params', async () => {
      const { error } = await readBody(mcpRequest('tasks/get', { taskId: 'nope' }))
      expect(error?.code).toBe(-32602)
    })

    it('requires taskId', async () => {
      const { error } = await readBody(mcpRequest('tasks/get', {}))
      expect(error?.code).toBe(-32602)
    })
  })

  describe('tasks/cancel and tasks/update', () => {
    it('acknowledges cancellation and flips a working row', async () => {
      const { result } = await readBody(mcpRequest('tasks/cancel', { taskId: 'task-1' }))
      expect(result?.resultType).toBe('complete')
      expect(mocks.taskUpdates).toHaveLength(1)
      expect(mocks.taskUpdates[0].status).toBe('cancelled')
    })

    it('acknowledges tasks/update as a no-op (no input_required flows yet)', async () => {
      const { result } = await readBody(
        mcpRequest('tasks/update', { taskId: 'task-1', inputResponses: {} })
      )
      expect(result?.resultType).toBe('complete')
    })
  })
})
