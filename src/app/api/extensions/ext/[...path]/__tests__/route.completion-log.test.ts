import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createMockRequest } from '@/tests/helpers'

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(),
}))

vi.mock('@/lib/init', () => ({
  ensureInitialized: vi.fn(),
}))

// Capture every line the dispatcher writes; child() keeps the same sink.
const lines = vi.hoisted(() => [] as Array<{ level: string; msg: string; ctx?: Record<string, unknown> }>)
vi.mock('@/lib/logger', () => {
  const make = (): Record<string, unknown> => {
    const logger: Record<string, unknown> = {
      info: (msg: string, ctx?: Record<string, unknown>) => lines.push({ level: 'info', msg, ctx }),
      warn: (msg: string, ctx?: Record<string, unknown>) => lines.push({ level: 'warn', msg, ctx }),
      error: (msg: string, ctx?: Record<string, unknown>) => lines.push({ level: 'error', msg, ctx }),
      debug: () => {},
    }
    logger.child = () => logger
    return logger
  }
  return { createLogger: () => make() }
})

import { extensionRegistry } from '@/lib/extensions/registry'
import { noteCompletionLog } from '@/lib/extensions/completion-log'
import { POST } from '../route'

function completionLines() {
  return lines.filter((line) => line.msg === 'extension call completed')
}

function register(handler: (request: Request) => Promise<Response>) {
  extensionRegistry.register({
    id: 'probe-ext',
    name: 'Probe',
    version: '1.0.0',
    apiRoutes: [{ method: 'POST', path: '/rpc', handler, skipAuth: true }],
  })
}

async function call() {
  const request = createMockRequest('/api/extensions/ext/probe-ext/rpc', { method: 'POST', body: {} })
  return POST(request, { params: Promise.resolve({ path: ['probe-ext', 'rpc'] }) })
}

describe('extension dispatcher completion line (skipAuth routes)', () => {
  beforeEach(() => {
    lines.length = 0
    extensionRegistry.clear()
  })

  it('writes one line with status and duration when the handler notes nothing', async () => {
    register(async () => new Response('ok', { status: 200 }))
    const response = await call()
    expect(response.status).toBe(200)
    const written = completionLines()
    expect(written).toHaveLength(1)
    expect(written[0].ctx).toMatchObject({ status: 200 })
    expect(typeof written[0].ctx?.durationMs).toBe('number')
  })

  it('carries the fields the handler noted on the same single line', async () => {
    register(async (request) => {
      noteCompletionLog(request, { fields: { mcpMethod: 'tools/call', tool: 'gnubok_list_accounts' } })
      noteCompletionLog(request, { fields: { outcome: 'error', errorCode: 'VALIDATION_ERROR' } })
      return new Response('{}', { status: 200 })
    })
    await call()
    const written = completionLines()
    expect(written).toHaveLength(1)
    expect(written[0].ctx).toMatchObject({
      status: 200,
      mcpMethod: 'tools/call',
      tool: 'gnubok_list_accounts',
      outcome: 'error',
      errorCode: 'VALIDATION_ERROR',
    })
  })

  it('writes no line for a call the handler marked quiet', async () => {
    register(async (request) => {
      noteCompletionLog(request, { quiet: true })
      return new Response(null, { status: 202 })
    })
    await call()
    expect(completionLines()).toHaveLength(0)
  })

  it('still writes the line when a quiet call fails with a 5xx', async () => {
    register(async (request) => {
      noteCompletionLog(request, { quiet: true })
      return new Response('boom', { status: 500 })
    })
    await call()
    const written = completionLines()
    expect(written).toHaveLength(1)
    expect(written[0].ctx).toMatchObject({ status: 500 })
  })
})
