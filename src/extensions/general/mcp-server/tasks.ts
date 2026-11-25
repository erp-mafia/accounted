import type { SupabaseClient } from '@supabase/supabase-js'
import { createLogger } from '@/lib/logger'

const log = createLogger('mcp-server/tasks')

/**
 * MCP Tasks extension (io.modelcontextprotocol/tasks).
 *
 * Durable handles for long-running tool calls: a task-capable client gets a
 * CreateTaskResult (resultType: "task") immediately and polls tasks/get until
 * a terminal status. Rows live in mcp_tasks (service-role writes only) so
 * handles survive disconnects and serverless instance turnover.
 *
 * Failure mapping: a tool execution failure is stored as a COMPLETED task
 * whose result carries the standard isError envelope, because that is exactly
 * what the synchronous call would have returned. The `failed` status (and the
 * `error` column) is reserved for infrastructure failures where no tool
 * result exists.
 *
 * The one such failure there is: the work runs after the response, inside
 * the invocation that answered the call, and an invocation the platform
 * kills (time limit, memory, deploy) writes nothing. Its row stayed
 * `working` until it expired, so a client polled an export that no longer
 * existed for up to an hour. tasks/get now answers `failed` for a row still
 * working past MCP_TASK_ABANDONED_AFTER_MS (abandonMcpTaskIfStale).
 */

export const TASKS_EXTENSION_ID = 'io.modelcontextprotocol/tasks'

const DEFAULT_POLL_INTERVAL_MS = 2000
const DEFAULT_TTL_MS = 3_600_000

/**
 * A task still working this long after it was created has no process behind
 * it: the MCP route runs at most 800 s (maxDuration in
 * app/api/extensions/ext/[...path]/route.ts). 900 s leaves room for clock
 * skew and the last write.
 */
export const MCP_TASK_ABANDONED_AFTER_MS = 900_000

/** The JSON-RPC error an abandoned task carries (mcp_tasks.error). */
const ABANDONED_TASK_ERROR = {
  code: -32603,
  message: 'The task was interrupted before it finished and will not complete. Start it again.',
}

export interface McpTaskRow {
  id: string
  company_id: string
  user_id: string
  tool_name: string
  status: 'working' | 'input_required' | 'completed' | 'failed' | 'cancelled'
  status_message: string | null
  result: Record<string, unknown> | null
  error: Record<string, unknown> | null
  poll_interval_ms: number
  ttl_ms: number
  created_at: string
  /** Set by the mcp_tasks_updated_at trigger on every write. */
  updated_at?: string
}

/**
 * The extensions a 2026-07-28 client declares in this request's capabilities
 * (`_meta`): an empty object when it lists capabilities without any, null
 * when it lists no capabilities at all (a handshake-era client declared them
 * once, at initialize).
 */
export function declaredClientExtensions(requestMeta: unknown): Record<string, unknown> | null {
  if (!requestMeta || typeof requestMeta !== 'object') return null
  const caps = (requestMeta as Record<string, unknown>)['io.modelcontextprotocol/clientCapabilities']
  if (!caps || typeof caps !== 'object') return null
  const extensions = (caps as Record<string, unknown>).extensions
  return extensions && typeof extensions === 'object' ? (extensions as Record<string, unknown>) : {}
}

/**
 * Per the extension spec, a server must never return a task to a client that
 * did not declare the extension in this request's capabilities.
 */
export function isTaskCapableClient(requestMeta: Record<string, unknown>): boolean {
  const extensions = declaredClientExtensions(requestMeta)
  return !!extensions && TASKS_EXTENSION_ID in extensions
}

export async function createMcpTask(
  supabase: SupabaseClient,
  params: { companyId: string; userId: string; apiKeyId?: string | null; toolName: string }
): Promise<McpTaskRow> {
  // Storage limitation (GDPR Art. 5(1)(e)): opportunistically purge expired
  // rows on every creation so the 1-hour retention is enforced without
  // dedicated cron infrastructure (cheap via idx_mcp_tasks_expires).
  // Best-effort: a failed sweep must never block the new task.
  try {
    await supabase.from('mcp_tasks').delete().lt('expires_at', new Date().toISOString())
  } catch {
    // Ignore: the next creation retries the sweep.
  }
  const { data, error } = await supabase
    .from('mcp_tasks')
    .insert({
      company_id: params.companyId,
      user_id: params.userId,
      api_key_id: params.apiKeyId ?? null,
      tool_name: params.toolName,
      status: 'working',
      poll_interval_ms: DEFAULT_POLL_INTERVAL_MS,
      ttl_ms: DEFAULT_TTL_MS,
    })
    .select('*')
    .single()
  if (error || !data) {
    throw new Error(`Failed to create MCP task: ${error?.message ?? 'no row returned'}`)
  }
  return data as McpTaskRow
}

/**
 * Move a still-working task to a terminal state. The status='working' guard
 * makes terminal states immutable (spec) and lets a tasks/cancel that raced
 * the execution win: the late completion becomes a no-op.
 *
 * Answers whether this call moved the row. A write the database refused is
 * logged as an error here (the client never throws, so no caller's catch saw
 * it): the row stays working and tasks/get fails it once it is stale.
 */
export async function resolveMcpTask(
  supabase: SupabaseClient,
  taskId: string,
  terminal: {
    status: 'completed' | 'failed' | 'cancelled'
    result?: Record<string, unknown>
    error?: Record<string, unknown>
    statusMessage?: string
  }
): Promise<boolean> {
  // Literal payload (no conditional spreads) so the phantom-column guard can
  // resolve every column. Writing null for absent terminal fields is correct:
  // the transition sets the complete terminal state.
  const { data, error } = await supabase
    .from('mcp_tasks')
    .update({
      status: terminal.status,
      result: terminal.result ?? null,
      error: terminal.error ?? null,
      status_message: terminal.statusMessage ?? null,
    })
    .eq('id', taskId)
    .eq('status', 'working')
    .select('id')
  if (error) {
    log.error('MCP task terminal state not stored', { taskId, status: terminal.status, code: error.code, reason: error.message })
    return false
  }
  return ((data ?? []) as unknown[]).length > 0
}

/**
 * For tasks/get: a row still working past MCP_TASK_ABANDONED_AFTER_MS is
 * failed, and the failed row is answered. The write is the same guarded
 * transition as every other, so of all the polls of one task exactly one
 * moves it and logs the error; a row something else resolved in the same
 * moment is read again and answered as it is. A fresh or terminal row comes
 * back untouched.
 */
export async function abandonMcpTaskIfStale(supabase: SupabaseClient, row: McpTaskRow, now: number = Date.now()): Promise<McpTaskRow> {
  const ageMs = now - Date.parse(row.created_at)
  if (row.status !== 'working' || !(ageMs > MCP_TASK_ABANDONED_AFTER_MS)) return row

  const statusMessage = ABANDONED_TASK_ERROR.message
  if (await resolveMcpTask(supabase, row.id, { status: 'failed', error: ABANDONED_TASK_ERROR, statusMessage })) {
    log.error('MCP task abandoned: still working after the route time limit, answered as failed', {
      taskId: row.id,
      toolName: row.tool_name,
      companyId: row.company_id,
      ageMs,
    })
    // lastUpdatedAt is the database's time of the write, as on every later poll.
    const { data: written } = await supabase.from('mcp_tasks').select('updated_at').eq('id', row.id).maybeSingle()
    const updatedAt = (written as { updated_at?: string } | null)?.updated_at ?? new Date(now).toISOString()
    return { ...row, status: 'failed', error: ABANDONED_TASK_ERROR, status_message: statusMessage, updated_at: updatedAt }
  }
  const { data } = await supabase.from('mcp_tasks').select('*').eq('id', row.id).eq('user_id', row.user_id).single()
  return (data as McpTaskRow | null) ?? row
}

/**
 * Map a row to the wire Task object shared by CreateTaskResult and tasks/get.
 * createdAt, lastUpdatedAt and ttlMs are required by the extension schema;
 * Claude Code before 2.1.317 refused a task answer without any of them.
 */
export function taskToWire(row: McpTaskRow): Record<string, unknown> {
  return {
    taskId: row.id,
    status: row.status,
    createdAt: row.created_at,
    lastUpdatedAt: row.updated_at ?? row.created_at,
    ttlMs: Number(row.ttl_ms),
    pollIntervalMs: row.poll_interval_ms,
    ...(row.status_message ? { statusMessage: row.status_message } : {}),
  }
}

/**
 * The answer to a tools/call the server runs as a task: CreateTaskResult is
 * the Task flat on the result (`Result & Task`, resultType "task"); a client
 * reads taskId and status from the top level, and refuses the answer without
 * them. `task` repeats the same object for accounted CLI 0.1.0, which reads
 * the nested copy the 2025-11-25 core shape had.
 */
export function createTaskResult(row: McpTaskRow): Record<string, unknown> {
  const task = taskToWire(row)
  return { resultType: 'task', ...task, task }
}
