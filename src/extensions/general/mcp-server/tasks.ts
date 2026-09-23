import type { SupabaseClient } from '@supabase/supabase-js'

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
 */

export const TASKS_EXTENSION_ID = 'io.modelcontextprotocol/tasks'

const DEFAULT_POLL_INTERVAL_MS = 2000
const DEFAULT_TTL_MS = 3_600_000

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
}

/**
 * Per the extension spec, a server must never return a task to a client that
 * did not declare the extension in this request's capabilities.
 */
export function isTaskCapableClient(requestMeta: Record<string, unknown>): boolean {
  const caps = requestMeta['io.modelcontextprotocol/clientCapabilities']
  if (!caps || typeof caps !== 'object') return false
  const extensions = (caps as Record<string, unknown>).extensions
  if (!extensions || typeof extensions !== 'object') return false
  return TASKS_EXTENSION_ID in (extensions as Record<string, unknown>)
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
): Promise<void> {
  // Literal payload (no conditional spreads) so the phantom-column guard can
  // resolve every column. Writing null for absent terminal fields is correct:
  // the transition sets the complete terminal state.
  await supabase
    .from('mcp_tasks')
    .update({
      status: terminal.status,
      result: terminal.result ?? null,
      error: terminal.error ?? null,
      status_message: terminal.statusMessage ?? null,
    })
    .eq('id', taskId)
    .eq('status', 'working')
}

/** Map a row to the wire Task object shared by CreateTaskResult and tasks/get. */
export function taskToWire(row: McpTaskRow): Record<string, unknown> {
  return {
    taskId: row.id,
    status: row.status,
    createdAt: row.created_at,
    ttlMs: Number(row.ttl_ms),
    pollIntervalMs: row.poll_interval_ms,
    ...(row.status_message ? { statusMessage: row.status_message } : {}),
  }
}
