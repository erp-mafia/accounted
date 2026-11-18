/**
 * Mirror of each MCP tool call to PostHog as one `$mcp_tool_call` event, the
 * event PostHog's MCP analytics reads (tool failures, tool stats, harness
 * breakdown, sessions).
 *
 * What leaves the server is a FIXED set of fields, listed in
 * TOOL_CALL_EVENT_PROPERTIES and locked by a test. Never an argument, a
 * result, an error message, a description, an amount, a name or any other
 * free text. Every field a caller can influence is reduced to a closed
 * vocabulary or a fixed shape before it is sent:
 *  - the tool name only when the server recognised it (an invented name is
 *    free text: it becomes "unknown"),
 *  - the error as a code and a kind, never the message,
 *  - the client as one of the known harness labels, else "other",
 *  - the session id only when it is a UUID (the server mints UUIDs; a client
 *    may send anything else, which is dropped).
 *
 * Who the event is about (product decision 2026-11-13: every call is
 * counted, and the person's choice decides whether it is tied to them):
 *  1. getPostHogServer() is null when isAnalyticsEnabled() is false:
 *     self-hosted, or no project token. Nothing is sent, nothing is read.
 *  2. A person who switched analytics off (user_preferences.analytics_consent
 *     = false, Inställningar, Konto) is counted without being named: the
 *     event carries no user id, no company and no session id, one shared
 *     distinct id, and tells PostHog to keep no person profile for it.
 *  3. Sandbox companies are never sent, as the dashboard layout never
 *     identifies them.
 * A failed read of 2 or 3 sends nothing.
 *
 * Never throws and never blocks: the dispatcher schedules it after the
 * response (emitAfterResponse), and every failure ends here in one log line.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { flushAnalytics, getPostHogServer } from '@/lib/analytics/posthog-server'
import { createServiceClientNoCookies } from '@/lib/auth/api-keys'
import { getErrorEntry } from '@/lib/errors/structured-errors'
import { UUID_RE } from '@/lib/invariants/uuid'
import { createLogger } from '@/lib/logger'

const log = createLogger('mcp/posthog-tool-call')

export const MCP_TOOL_CALL_EVENT = '$mcp_tool_call'

/**
 * Every property the event may carry. `$mcp_*` and `$session_id` are
 * PostHog's MCP analytics schema; `mcp_error_code` and `mcp_error_kind` are
 * ours. The test fails on any key outside this list.
 */
export const TOOL_CALL_EVENT_PROPERTIES = [
  '$mcp_tool_name',
  '$mcp_is_error',
  '$mcp_error_type',
  'mcp_error_code',
  'mcp_error_kind',
  '$mcp_duration_ms',
  '$mcp_client_name',
  '$session_id',
  '$mcp_session_id',
  '$mcp_server_name',
  '$mcp_server_version',
  '$mcp_source',
  '$process_person_profile',
] as const

export type ToolCallEventProperty = (typeof TOOL_CALL_EVENT_PROPERTIES)[number]
export type ToolCallEventProperties = Partial<Record<ToolCallEventProperty, string | number | boolean>>

/** The dispatcher's errorKind union, as emitToolCallTelemetry carries it. */
const ERROR_KIND_TO_TYPE: Readonly<Record<string, string>> = {
  invalid_arguments: 'validation',
  unknown_tool: 'validation',
  bridge_refused: 'validation',
  scope_denied: 'permission',
  capability_denied: 'permission',
  company_access_denied: 'permission',
  test_key_write_blocked: 'permission',
  unattended_write_blocked: 'permission',
  package_off: 'permission',
}

// Same shape public.agent_telemetry_tool_label accepts for a registry name.
const TOOL_NAME_RE = /^[a-z][a-z0-9_.]{0,79}$/
// A structured error code is an upper snake constant from the source.
const ERROR_CODE_RE = /^[A-Z][A-Z0-9_]{1,63}$/

const CLIENT_LABELS: ReadonlySet<string> = new Set([
  'claude-code',
  'claude-desktop',
  'claude-connector',
  'chatgpt',
  'codex',
  'cursor',
  'gemini',
  'grok',
  'openclaw',
  'opencode',
  'accounted-cli',
  'vscode',
  'zed',
  'antigravity',
  'hermes',
  'base44',
])

// A marker may carry a suffix ("claude-code-plugin"): it keeps its family,
// as public.agent_client_family buckets it. Longest prefixes first.
const CLIENT_FAMILY_PREFIXES: readonly string[] = [
  'claude-code',
  'claude-desktop',
  'accounted-cli',
  'antigravity',
  'chatgpt',
  'openclaw',
  'opencode',
  'base44',
  'cursor',
  'gemini',
  'hermes',
  'vscode',
  'codex',
  'grok',
  'zed',
]

/** The harness label reduced to the closed vocabulary; anything else is "other". */
export function clientNameForPostHog(client: string | null | undefined): string {
  if (!client) return 'other'
  const label = client.toLowerCase()
  if (CLIENT_LABELS.has(label)) return label
  return CLIENT_FAMILY_PREFIXES.find((prefix) => label.startsWith(prefix)) ?? 'other'
}

/**
 * PostHog's semantic failure bucket. The dispatcher's own refusals map by
 * kind; a failure inside the tool maps by the HTTP status its structured
 * code is registered with.
 */
export function errorTypeForPostHog(errorKind: string | null, errorCode: string | null): string {
  if (errorKind && Object.hasOwn(ERROR_KIND_TO_TYPE, errorKind)) return ERROR_KIND_TO_TYPE[errorKind]
  const status = errorCode ? getErrorEntry(errorCode)?.httpStatus : undefined
  if (status === 429) return 'rate_limited'
  if (status === 408 || status === 504) return 'timeout'
  if (status === 401 || status === 403) return 'permission'
  if (status === 400 || status === 422) return 'validation'
  if (status !== undefined && status >= 400 && status < 500) return 'api_4xx'
  return 'internal'
}

export interface ToolCallMirrorInput {
  tool: string
  isError: boolean
  errorCode: string | null
  errorKind: string | null
  latencyMs: number
  client: string | null | undefined
  sessionId: string | null | undefined
  serverVersion: string
}

/** Pure: the whole event body. Nothing here reads a message, an argument or a result. */
export function buildToolCallProperties(input: ToolCallMirrorInput): ToolCallEventProperties {
  const known = input.errorKind !== 'unknown_tool' && TOOL_NAME_RE.test(input.tool)
  const duration = Number.isFinite(input.latencyMs) ? Math.max(0, Math.round(input.latencyMs)) : 0
  const properties: ToolCallEventProperties = {
    $mcp_tool_name: known ? input.tool : 'unknown',
    $mcp_is_error: input.isError === true,
    $mcp_duration_ms: duration,
    $mcp_client_name: clientNameForPostHog(input.client),
    $mcp_server_name: 'accounted',
    $mcp_server_version: input.serverVersion.slice(0, 32),
    // The value PostHog's per-tool analytics filter on. This server does not
    // run the @posthog/mcp SDK; it emits the SDK's event shape by hand.
    $mcp_source: 'posthog_mcp_analytics',
  }
  if (input.isError) {
    const code = input.errorCode && ERROR_CODE_RE.test(input.errorCode) ? input.errorCode : 'unknown'
    const kind =
      input.errorKind && (input.errorKind === 'execution' || Object.hasOwn(ERROR_KIND_TO_TYPE, input.errorKind))
        ? input.errorKind
        : 'unknown'
    properties.$mcp_error_type = errorTypeForPostHog(input.errorKind, code === 'unknown' ? null : code)
    properties.mcp_error_code = code
    properties.mcp_error_kind = kind
  }
  if (input.sessionId && UUID_RE.test(input.sessionId)) {
    properties.$session_id = input.sessionId
    properties.$mcp_session_id = input.sessionId
  }
  return properties
}

/** The distinct id every unnamed call shares: no person, no company, no session behind it. */
export const ANONYMOUS_AGENT_DISTINCT_ID = 'anonymous-agent-call'

/** 'person': sent as the person. 'anonymous': counted, tied to nobody. 'none': not sent. */
export type ToolCallMirrorMode = 'person' | 'anonymous' | 'none'

/**
 * The person's own analytics choice and the sandbox rule, read with the
 * service client (an agent call has no browser session). 'none' on any
 * failed read: without an answer nothing is sent.
 */
export async function mayMirrorToolCall(
  supabase: SupabaseClient,
  userId: string,
  companyId: string,
): Promise<ToolCallMirrorMode> {
  const [prefs, settings] = await Promise.all([
    supabase.from('user_preferences').select('analytics_consent').eq('user_id', userId).maybeSingle(),
    supabase.from('company_settings').select('is_sandbox').eq('company_id', companyId).maybeSingle(),
  ])
  if (prefs.error || settings.error) return 'none'
  if ((settings.data as { is_sandbox?: boolean | null } | null)?.is_sandbox === true) return 'none'
  // Null (never asked) is on, as in the browser.
  if ((prefs.data as { analytics_consent?: boolean | null } | null)?.analytics_consent === false) return 'anonymous'
  return 'person'
}

export interface ToolCallMirrorDeps {
  mayMirror: (userId: string, companyId: string) => Promise<ToolCallMirrorMode>
}

const defaultDeps: ToolCallMirrorDeps = {
  mayMirror: (userId, companyId) => mayMirrorToolCall(createServiceClientNoCookies(), userId, companyId),
}

/**
 * Send one tool call to PostHog. Resolves in every case; the caller runs it
 * after the response and does not look at the outcome.
 */
export async function mirrorToolCallToPostHog(
  input: ToolCallMirrorInput & { userId: string; companyId: string },
  deps: ToolCallMirrorDeps = defaultDeps,
): Promise<void> {
  try {
    const posthog = getPostHogServer()
    if (!posthog) return
    if (!input.userId || !input.companyId) return
    const mode = await deps.mayMirror(input.userId, input.companyId)
    if (mode === 'none') return
    if (mode === 'anonymous') {
      // Counted, tied to nobody: no user id, no company group, and no
      // session id (a session would string one person's calls together).
      posthog.capture({
        distinctId: ANONYMOUS_AGENT_DISTINCT_ID,
        event: MCP_TOOL_CALL_EVENT,
        properties: { ...buildToolCallProperties({ ...input, sessionId: null }), $process_person_profile: false },
      })
    } else {
      posthog.capture({
        // The same id the browser identifies the person with.
        distinctId: input.userId,
        event: MCP_TOOL_CALL_EVENT,
        properties: buildToolCallProperties(input),
        groups: { company: input.companyId },
      })
    }
    await flushAnalytics()
  } catch (err) {
    // Analytics never gets to break a tool call. The class name only: an
    // error message can quote what it failed on.
    log.info('tool call not mirrored to PostHog', { reason: err instanceof Error ? err.name : 'unknown' })
  }
}
