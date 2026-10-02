import { describe, expect, it } from 'vitest'
import { UnavailableError, UsageError } from '../lib/errors.mjs'
import {
  PROTOCOL_VERSION,
  canonicalToolName,
  classifyToolResult,
  envelope,
  isTaskDone,
  pollInterval,
  unwrapRpc,
} from '../lib/mcp.mjs'
import { toolResult } from './helpers'

const res = (status: number, text: string, headers: Record<string, string> = {}) => ({ status, headers, text })

describe('envelope', () => {
  it('carries the protocol version in _meta on every request', () => {
    const body = envelope('tools/list')
    expect(body.jsonrpc).toBe('2.0')
    expect(body.method).toBe('tools/list')
    expect(body.params._meta).toEqual({ 'io.modelcontextprotocol/protocolVersion': PROTOCOL_VERSION })
  })

  it('declares the Tasks extension next to the version when asked', () => {
    const body = envelope('tools/call', { name: 'accounted_audit_package', arguments: {} }, { tasks: true })
    expect(body.params.name).toBe('accounted_audit_package')
    expect(body.params._meta).toEqual({
      'io.modelcontextprotocol/protocolVersion': '2026-07-28',
      'io.modelcontextprotocol/clientCapabilities': {
        extensions: { 'io.modelcontextprotocol/tasks': {} },
      },
    })
  })
})

describe('canonicalToolName', () => {
  it.each([
    ['list_invoices', 'accounted_list_invoices'],
    ['list-invoices', 'accounted_list_invoices'],
    ['accounted_list_invoices', 'accounted_list_invoices'],
    ['gnubok_list_invoices', 'accounted_list_invoices'],
    ['  Feedback ', 'accounted_feedback'],
  ])('%s -> %s', (raw, expected) => {
    expect(canonicalToolName(raw)).toBe(expected)
  })

  it('refuses things that cannot be tool names', () => {
    expect(() => canonicalToolName('list invoices')).toThrow(UsageError)
    expect(() => canonicalToolName('accounted_')).toThrow(UsageError)
    expect(() => canonicalToolName('{"limit":5}')).toThrow(UsageError)
  })
})

describe('unwrapRpc', () => {
  it('returns the result of a success', () => {
    expect(unwrapRpc(res(200, '{"jsonrpc":"2.0","id":1,"result":{"tools":[]}}'))).toEqual({ tools: [] })
  })

  it('turns a rate limit into exit-4 territory with the wait', () => {
    try {
      unwrapRpc(res(429, 'Too Many Requests', { 'retry-after': '60' }))
      expect.unreachable()
    } catch (err) {
      expect(err).toBeInstanceOf(UnavailableError)
      expect((err as UnavailableError).retryAfterSeconds).toBe(60)
      expect((err as Error).message).toContain('retry after 60 s')
    }
  })

  it('does not follow redirects', () => {
    expect(() => unwrapRpc(res(307, '', { location: 'https://app.accounted.se/x' }))).toThrow(
      /redirected to https:\/\/app\.accounted\.se\/x/
    )
  })

  it('treats an unknown tool as a usage error and drops the full tool list', () => {
    const body = JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      error: {
        code: -32602,
        message: 'Unknown tool: "accounted_lst_invoices". Did you mean: accounted_list_invoices? Available tools: a, b, c',
      },
    })
    try {
      unwrapRpc(res(200, body))
      expect.unreachable()
    } catch (err) {
      expect(err).toBeInstanceOf(UsageError)
      expect((err as Error).message).toContain('Did you mean: accounted_list_invoices?')
      expect((err as Error).message).not.toContain('Available tools')
    }
  })

  it('reports other JSON-RPC errors and non-JSON failures as unavailable', () => {
    expect(() => unwrapRpc(res(500, '{"jsonrpc":"2.0","id":1,"error":{"code":-32603,"message":"boom"}}'))).toThrow(
      'Server error -32603: boom'
    )
    expect(() => unwrapRpc(res(502, '<html>Bad gateway</html>'))).toThrow(/HTTP 502/)
    expect(() => unwrapRpc(res(200, 'not json'))).toThrow(UnavailableError)
  })
})

describe('classifyToolResult', () => {
  it('returns structuredContent and the company echo', () => {
    const outcome = classifyToolResult(
      toolResult({ invoices: [] }, { _meta: { company: { id: 'c1', name: 'Acme AB' } } })
    )
    expect(outcome).toEqual({ kind: 'ok', data: { invoices: [] }, company: { id: 'c1', name: 'Acme AB' } })
  })

  it('falls back to the JSON text when there is no structuredContent', () => {
    expect(classifyToolResult({ content: [{ type: 'text', text: '{"a":1}' }] })).toEqual({
      kind: 'ok',
      data: { a: 1 },
      company: undefined,
    })
  })

  it('reads a tool error from content[0].text, the only place it is', () => {
    const outcome = classifyToolResult({
      resultType: 'complete',
      isError: true,
      content: [{ type: 'text', text: JSON.stringify({ error: { code: 'INSUFFICIENT_SCOPE', message_en: 'Missing scope' } }) }],
    })
    expect(outcome).toEqual({ kind: 'error', error: { code: 'INSUFFICIENT_SCOPE', message_en: 'Missing scope' } })
  })

  it('keeps a plain-text tool error as text', () => {
    expect(classifyToolResult({ isError: true, content: [{ type: 'text', text: 'Something broke' }] })).toEqual({
      kind: 'error',
      error: 'Something broke',
    })
  })

  it('recognises a task handle', () => {
    const task = { taskId: 't1', status: 'working', pollIntervalMs: 2000 }
    expect(classifyToolResult({ resultType: 'task', task })).toEqual({ kind: 'task', task })
  })
})

describe('task helpers', () => {
  it('knows the terminal states', () => {
    expect(isTaskDone({ status: 'working' })).toBe(false)
    expect(isTaskDone({ status: 'completed' })).toBe(true)
    expect(isTaskDone({ status: 'failed' })).toBe(true)
    expect(isTaskDone({ status: 'cancelled' })).toBe(true)
  })

  it('keeps the poll interval within 1 to 30 seconds', () => {
    expect(pollInterval({ pollIntervalMs: 2000 })).toBe(2000)
    expect(pollInterval({ pollIntervalMs: 10 })).toBe(1000)
    expect(pollInterval({ pollIntervalMs: 600_000 })).toBe(30_000)
    expect(pollInterval({})).toBe(2000)
  })
})
