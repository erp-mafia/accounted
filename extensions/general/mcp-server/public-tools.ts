import { requestClientIp, truncateIp } from '@/lib/api/ip'

/**
 * Tools an MCP client may call BEFORE the user has connected an account
 * (lazy authentication, issue #1814 PR 2).
 *
 * The server accepts anonymous initialize / tools/list / prompts+resources
 * listing and calls to these tools. Every other tools/call answers with a
 * transport-level 401 + WWW-Authenticate, which the client turns into its
 * Connect prompt (Claude's inline Connect card, Claude Code's /mcp login,
 * Codex's `codex mcp login`) and then retries with a token.
 *
 * Membership rules: a public tool must (1) read no tenant data, (2) need no
 * scope (it is absent from TOOL_SCOPE_MAP), and (3) be company-independent.
 * Documentation and discovery only; anything that touches a company stays
 * behind the challenge so the account is created first.
 */
export const PUBLIC_TOOLS: ReadonlySet<string> = new Set([
  'gnubok_search_tools',
  'gnubok_list_skills',
  'gnubok_load_skill',
])

export function isPublicTool(canonicalToolName: string): boolean {
  return PUBLIC_TOOLS.has(canonicalToolName)
}

/**
 * Anonymous calls have no API key to meter on, so they are limited per
 * truncated client IP. Generous for a human exploring the catalog, tight
 * enough that the documentation tools cannot be farmed. Enforced by
 * checkRateLimit (Upstash), which no-ops on deployments without Redis.
 */
export const ANONYMOUS_RATE_LIMIT = {
  maxRequests: 60,
  windowMs: 60 * 1000,
} as const

export function anonymousRateLimitIdentifier(request: Request): string {
  return truncateIp(requestClientIp(request)) ?? 'unknown'
}

/**
 * JSON-RPC methods that carry no tenant data and are needed for a client to
 * connect and orient itself before authentication.
 */
export const ANONYMOUS_METHODS: ReadonlySet<string> = new Set([
  'initialize',
  'server/discover',
  'ping',
  'notifications/initialized',
  'tools/list',
  'prompts/list',
  'resources/list',
  'resources/templates/list',
])
