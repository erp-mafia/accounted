import { UnavailableError, UsageError } from './errors.mjs'
import { header } from './http.mjs'

// The stateless MCP revision: no initialize handshake, the version rides in
// every request's _meta, and results carry resultType.
export const PROTOCOL_VERSION = '2026-07-28'
const META_PROTOCOL_VERSION = 'io.modelcontextprotocol/protocolVersion'
const META_CLIENT_CAPABILITIES = 'io.modelcontextprotocol/clientCapabilities'
const TASKS_EXTENSION = 'io.modelcontextprotocol/tasks'

let nextId = 1

/**
 * A JSON-RPC request. `tasks` declares the Tasks extension, which lets a long
 * tool (audit_package today) answer with a task handle instead of holding the
 * connection; the server only honours it next to the protocol version.
 *
 * @param {string} method
 * @param {Record<string, unknown>} [params]
 * @param {{ tasks?: boolean }} [options]
 * @returns {{ jsonrpc: '2.0', id: number, method: string, params: Record<string, unknown> }}
 */
export function envelope(method, params = {}, { tasks = false } = {}) {
  /** @type {Record<string, unknown>} */
  const meta = { [META_PROTOCOL_VERSION]: PROTOCOL_VERSION }
  if (tasks) meta[META_CLIENT_CAPABILITIES] = { extensions: { [TASKS_EXTENSION]: {} } }
  return { jsonrpc: '2.0', id: nextId++, method, params: { ...params, _meta: meta } }
}

const BARE_NAME_RE = /^[a-z][a-z0-9_]*$/

/**
 * Accept `list_invoices`, `list-invoices`, `accounted_list_invoices` and the
 * legacy `gnubok_list_invoices`; send the accounted_* name.
 *
 * @param {string} raw
 */
export function canonicalToolName(raw) {
  const name = String(raw).trim().toLowerCase().replace(/-/g, '_')
  const bare = name.startsWith('accounted_')
    ? name.slice('accounted_'.length)
    : name.startsWith('gnubok_')
      ? name.slice('gnubok_'.length)
      : name
  if (!BARE_NAME_RE.test(bare)) throw new UsageError(`Not a tool name: ${raw}`)
  return `accounted_${bare}`
}

/**
 * The JSON-RPC result of a response, or a thrown error classified by exit
 * code. 401 never reaches here: the session handles it first.
 *
 * @param {import('./http.mjs').HttpResponse} res
 * @returns {Record<string, unknown>}
 */
export function unwrapRpc(res) {
  if (res.status === 429) {
    const seconds = Number(header(res, 'retry-after')) || 60
    throw new UnavailableError(`Rate limited by the server: retry after ${seconds} s`, {
      retryAfterSeconds: seconds,
    })
  }
  if (res.status >= 300 && res.status < 400) {
    throw new UnavailableError(
      `The server redirected to ${header(res, 'location') ?? 'another address'}; pass that address with --url`
    )
  }
  let body
  try {
    body = JSON.parse(res.text)
  } catch {
    body = undefined
  }
  if (body && typeof body === 'object' && body.error && typeof body.error === 'object') {
    throw rpcError(body.error)
  }
  if (res.status < 200 || res.status >= 300) {
    const snippet = res.text.trim().slice(0, 200)
    throw new UnavailableError(`The server answered HTTP ${res.status}${snippet ? `: ${snippet}` : ''}`)
  }
  if (!body || typeof body !== 'object' || !body.result || typeof body.result !== 'object') {
    throw new UnavailableError('The server sent an answer this version of the CLI does not understand')
  }
  return body.result
}

/** @param {{ code?: unknown, message?: unknown }} error */
function rpcError(error) {
  // The unknown-tool message ends with every tool name; the suggestions
  // before it are what helps.
  const message = String(error.message ?? 'Unknown error').split(' Available tools:')[0]
  // -32601 method not found, -32602 invalid params (unknown tool, malformed
  // company pin, missing taskId): the caller's mistake, not the server's.
  if (error.code === -32602 || error.code === -32601) return new UsageError(message)
  return new UnavailableError(`Server error ${String(error.code)}: ${message}`)
}

/**
 * Sort a tools/call (or completed task) result into what the CLI does next.
 *
 * Tool failures arrive as HTTP 200 with isError and the error object only in
 * content[0].text; successes carry structuredContent. A multi-company key also
 * gets _meta.company, outside structuredContent.
 *
 * @param {Record<string, any>} result
 * @returns {{ kind: 'task', task: Record<string, any> }
 *   | { kind: 'error', error: unknown }
 *   | { kind: 'ok', data: unknown, company: unknown }}
 */
export function classifyToolResult(result) {
  if (result.resultType === 'task' && result.task && typeof result.task === 'object') {
    return { kind: 'task', task: result.task }
  }
  const text = firstText(result)
  if (result.isError === true) {
    const parsed = parseJson(text)
    const error =
      parsed && typeof parsed === 'object' && 'error' in parsed ? parsed.error : (parsed ?? text ?? 'Unknown error')
    return { kind: 'error', error }
  }
  const data = 'structuredContent' in result ? result.structuredContent : (parseJson(text) ?? text ?? null)
  return { kind: 'ok', data, company: result._meta?.company }
}

/** @param {Record<string, any>} result */
function firstText(result) {
  const content = Array.isArray(result.content) ? result.content : []
  const block = content.find((c) => c && c.type === 'text' && typeof c.text === 'string')
  return block ? block.text : undefined
}

/** @param {string | undefined} text */
function parseJson(text) {
  if (text === undefined) return undefined
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

const TERMINAL_TASK_STATES = new Set(['completed', 'failed', 'cancelled'])

/** @param {Record<string, any>} task */
export function isTaskDone(task) {
  return TERMINAL_TASK_STATES.has(task.status)
}

/** Poll interval within sane bounds, whatever the server suggests. @param {Record<string, any>} task */
export function pollInterval(task) {
  const ms = Number(task.pollIntervalMs)
  if (!Number.isFinite(ms)) return 2000
  return Math.min(Math.max(ms, 1000), 30_000)
}
