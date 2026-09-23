import type { SupabaseClient } from '@supabase/supabase-js'

// Actor context for the tool dispatch. Mirrors the shape the MCP server's
// ActorContext type uses (extensions/general/mcp-server/server.ts:70) so a
// registered handler receives the same actor object regardless of which
// caller wired it. The chat agent always passes `type: 'agent_chat'` with
// the conversation id as `id`.
export interface AgentActorContext {
  type: 'user' | 'api_key' | 'mcp_oauth' | 'cron' | 'agent_chat'
  id?: string
  label?: string
}

// Slim, core-defined tool contract. Extensions register tools that satisfy
// this shape via registerAgentTools(); the chat agent dispatches against it
// without importing @/extensions/* directly (CI rule).
//
// The shape intentionally mirrors the MCP McpTool definition so the
// mcp-server extension can pass its tool array through verbatim, but is
// declared in core so a build with extensions disabled still compiles.
export interface AgentTool {
  name: string
  description: string
  inputSchema: Record<string, unknown>
  outputSchema?: Record<string, unknown>
  // Anthropic SDK tool blocks don't carry annotation hints: these stay in
  // the registry for our own scoping/policy logic.
  annotations?: {
    readOnlyHint?: boolean
    destructiveHint?: boolean
    idempotentHint?: boolean
    openWorldHint?: boolean
  }
  execute: (
    args: Record<string, unknown>,
    companyId: string,
    userId: string,
    supabase: SupabaseClient,
    actor?: AgentActorContext,
  ) => Promise<unknown>
}

// Shape of the staged-operation envelope returned by write tools. Copied from
// the MCP server's STAGED_OPERATION_SCHEMA (server.ts:506) so the chat loop
// can detect a staged result without depending on the extension's symbol.
export interface StagedOperationResult {
  staged: true
  operation_id?: string
  risk_level: 'low' | 'medium' | 'high'
  actor: { type: string; id?: string; label?: string }
  message: string
  preview: unknown
  period_status?: {
    period_id?: string | null
    status: 'open' | 'locked' | 'closed'
    lock_date?: string | null
  }
  next?: unknown
}

export function isStagedOperation(value: unknown): value is StagedOperationResult {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { staged?: unknown }).staged === true &&
    typeof (value as { risk_level?: unknown }).risk_level === 'string'
  )
}
