import type { SupabaseClient } from '@supabase/supabase-js'
import type { ApiKeyScope } from '@/lib/auth/api-keys'
// Pure data module (no server imports): the same classifier the settings UI
// and the v1 REST wrapper use, so "what counts as a write" has one owner.
import { scopeKind } from '@/lib/auth/scope-catalog'
import { getMultiUserState, isMembershipDormant } from '@/lib/entitlements/multi-user'
import { getUserCompanies } from '@/lib/company/context'
import { fetchAllRows } from '@/lib/supabase/fetch-all'
import {
  resolveCompanyScope,
  type CompanyScopeInput,
  type ResolvedCompanyScope,
  type ScopedCompany,
} from '@/lib/portfolio/scope'
import type { CompanyRole } from '@/types'

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

const COMPANY_INDEPENDENT_TOOLS = new Set([
  'gnubok_search_tools',
  'gnubok_list_skills',
  'gnubok_load_skill',
  'gnubok_list_companies',
  // Creates the company: by definition it runs before one exists.
  'gnubok_create_company',
  // Public-registry lookup that feeds gnubok_create_company: same pre-company
  // stage of onboarding, no company data touched at all.
  'gnubok_lookup_company',
  // Scoped tools take a set of companies (`scope`) instead of one company_id
  // and membership-check every company in the set themselves (see
  // resolveMcpCompanyScope). Listed here so the dispatcher projects no
  // company_id property onto them and skips the single-company resolution.
  'gnubok_client_overview',
  'gnubok_portfolio_readiness',
  'gnubok_run_across_companies',
  'gnubok_stage_across_companies',
])

/**
 * Company-independent tools that still USE a company when one is available:
 * they run without one (anonymous or not-yet-onboarded callers, issue #1814)
 * but accept an explicit company_id, which is then membership-checked like
 * on any company-dependent tool. gnubok_list_skills filters skills by the
 * company's entity type, employees and VAT registration.
 */
const OPTIONAL_COMPANY_TOOLS = new Set(['gnubok_list_skills'])

export function isOptionalCompanyTool(toolName: string): boolean {
  return OPTIONAL_COMPANY_TOOLS.has(toolName)
}

/**
 * Tools whose company is the one the named pending operation belongs to.
 *
 * Operation ids are global UUIDs, so a caller approving or rejecting one
 * should not have to repeat the company it was staged for. When such a call
 * names an operation_id and no company_id, the dispatcher looks the company
 * up from the row and routes the call there; membership, seat gate, viewer
 * gate and telemetry attribution then run exactly as for an explicit
 * company_id. An explicit company_id still wins (and must match the row, or
 * the tool reports not found).
 */
const OPERATION_SCOPED_TOOLS = new Set([
  'gnubok_approve_pending_operation',
  'gnubok_reject_pending_operation',
])

export function isOperationScopedTool(toolName: string): boolean {
  return OPERATION_SCOPED_TOOLS.has(toolName)
}

/**
 * Company of a pending operation, or null when the id is absent, malformed
 * or unknown (the tool itself then answers "not found" for the default
 * company, exactly as before). Never throws: a lookup failure must not turn
 * an approval into a routing error.
 */
export async function resolveOperationCompanyId(
  supabase: SupabaseClient,
  operationId: unknown
): Promise<string | null> {
  if (typeof operationId !== 'string' || !UUID_PATTERN.test(operationId)) return null
  try {
    const { data } = await supabase
      .from('pending_operations')
      .select('company_id')
      .eq('id', operationId)
      .maybeSingle()
    const companyId = (data as { company_id?: unknown } | null)?.company_id
    return typeof companyId === 'string' && UUID_PATTERN.test(companyId) ? companyId : null
  } catch {
    return null
  }
}

/**
 * Tools that take a `scope` (a set of companies) instead of one company_id.
 * They are company-independent for the dispatcher (no company_id property is
 * projected onto their schema, no single membership check up front) and
 * resolve their set through resolveMcpCompanyScope, which membership-checks
 * every company in it.
 */
const SCOPED_TOOLS = new Set([
  'gnubok_client_overview',
  'gnubok_portfolio_readiness',
  'gnubok_run_across_companies',
  'gnubok_stage_across_companies',
])

export function isScopedTool(toolName: string): boolean {
  return SCOPED_TOOLS.has(toolName)
}

/**
 * Tools that only earn their place when the key reaches several companies:
 * the company switch and the cross-company tools. Hidden from tools/list and
 * tool search in simple company mode; still callable by name, where they
 * simply answer for the one company.
 */
export function isMultiCompanyOnlyTool(toolName: string): boolean {
  return toolName === 'gnubok_list_companies' || isScopedTool(toolName)
}

// ── Simple company mode ──────────────────────────────────────
// Nine users in ten have one company. For them everything the multi-company
// surface adds is noise: a company block on every result, a company_id
// property on every tool schema (~3K tokens of tools/list), a company switch
// and cross-company tools they cannot use. The server therefore shows two
// faces, chosen per request from how many companies the key reaches.

const REACHABLE_COUNT_TTL_MS = 60_000
const REACHABLE_COUNT_CACHE_MAX = 5_000
const reachableCountCache = new Map<string, { count: number; expiresAt: number }>()

/** Test hook: the cache is module state and would leak between cases. */
export function resetReachableCompanyCountCache(): void {
  reachableCountCache.clear()
}

/**
 * How many non-archived companies the user is a member of, optionally
 * intersected with a restriction (a key allowlist). null = unknown (the
 * lookup failed), which callers read as multi-company: the informative face
 * is the safe fallback. Cached in-process for a minute per user and
 * restriction, so a session pays one lookup, not one per call; a stale count
 * only delays the switch between the two faces by that minute. Unknown is
 * never cached.
 */
export async function getReachableCompanyCount(
  supabase: SupabaseClient,
  userId: string,
  restrictTo?: readonly string[] | null,
  now: () => number = Date.now
): Promise<number | null> {
  if (!userId) return 0
  const key = `${userId}|${restrictTo ? [...restrictTo].map((id) => id.toLowerCase()).sort().join(',') : '*'}`
  const cached = reachableCountCache.get(key)
  if (cached && cached.expiresAt > now()) return cached.count
  try {
    type MembershipRow = {
      company_id: string
      companies: { archived_at: string | null } | Array<{ archived_at: string | null }> | null
    }
    const memberships = (await getUserCompanies(supabase, userId)) as unknown as MembershipRow[]
    const allowed = restrictTo ? new Set(restrictTo.map((id) => id.toLowerCase())) : null
    const count = memberships.filter((membership) => {
      const company = Array.isArray(membership.companies)
        ? membership.companies[0]
        : membership.companies
      if (!company || company.archived_at !== null) return false
      return allowed ? allowed.has(String(membership.company_id).toLowerCase()) : true
    }).length
    if (reachableCountCache.size >= REACHABLE_COUNT_CACHE_MAX) reachableCountCache.clear()
    reachableCountCache.set(key, { count, expiresAt: now() + REACHABLE_COUNT_TTL_MS })
    return count
  } catch {
    return null
  }
}

/** One company or none: the single-company face. Unknown stays multi-company. */
export function isSimpleCompanyMode(reachableCount: number | null): boolean {
  return reachableCount !== null && reachableCount <= 1
}

const COMPANY_ID_INPUT_PROPERTY = {
  type: 'string',
  format: 'uuid',
  description: 'Target company ID. Omit for default.',
} as const

export interface McpCompanyContext {
  companyId: string
  /** Display name (company_settings.company_name, else companies.name). */
  companyName: string
  role: CompanyRole
  isDefault: boolean
}

/** What every company-scoped tool result announces first (qualified id, as everywhere on this surface). */
export interface CompanyEcho {
  company_id: string
  name: string
  is_default: boolean
}

export function companyEchoFromContext(context: McpCompanyContext): CompanyEcho {
  return { company_id: context.companyId, name: context.companyName, is_default: context.isDefault }
}

/**
 * The text payload of a company-scoped tool result: the company first, then
 * the tool's own result. Only the TEXT content block carries the echo; the
 * structuredContent stays the tool's own result so it still validates
 * against the tool's outputSchema (most declare additionalProperties:false,
 * and the SDK client rejects a structuredContent that fails validation).
 * A tool that already returns a `company` key (the briefing, for one) is
 * left alone.
 */
export function companyEchoPayload(result: unknown, company: CompanyEcho): unknown {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return result
  const record = result as Record<string, unknown>
  if ('company' in record) return result
  return { company, ...record }
}

/**
 * Companies the caller could have meant, for a NOT_FOUND / FORBIDDEN company
 * answer: the same set gnubok_list_companies returns, reduced to id and
 * name. Best effort: a lookup failure yields an empty list, never an error
 * on top of the error being reported.
 */
export async function listAccessibleCompanies(
  supabase: SupabaseClient,
  userId: string
): Promise<Array<{ company_id: string; name: string }>> {
  try {
    type MembershipRow = {
      company_id: string
      companies:
        | { id: string; name: string; archived_at: string | null }
        | Array<{ id: string; name: string; archived_at: string | null }>
        | null
    }
    const memberships = (await getUserCompanies(supabase, userId)) as unknown as MembershipRow[]
    const accessible = memberships.flatMap((membership) => {
      const company = Array.isArray(membership.companies)
        ? membership.companies[0]
        : membership.companies
      return company && company.archived_at === null ? [company] : []
    })
    if (accessible.length === 0) return []
    const displayNames = new Map<string, string>()
    try {
      const settings = await fetchAllRows<{ company_id: string; company_name: string | null }>(
        ({ from, to }) =>
          supabase
            .from('company_settings')
            .select('company_id, company_name')
            .in(
              'company_id',
              accessible.map((company) => company.id)
            )
            .order('company_id', { ascending: true })
            .range(from, to)
      )
      for (const row of settings) {
        if (row.company_name) displayNames.set(row.company_id, row.company_name)
      }
    } catch {
      // companies.name is the fallback below.
    }
    return accessible.map((company) => ({
      company_id: company.id,
      name: displayNames.get(company.id) ?? company.name,
    }))
  } catch {
    return []
  }
}

interface ToolSchemaSource {
  name: string
  inputSchema: Record<string, unknown>
}

export function codedError(
  code: 'VALIDATION_ERROR' | 'NOT_FOUND' | 'FORBIDDEN' | 'INTERNAL_ERROR' | 'NO_COMPANY_YET',
  message: string
) {
  return Object.assign(new Error(message), { code })
}

/**
 * Thrown when a company-scoped operation runs on a key whose user has no
 * company at all (minted from the OAuth popup before onboarding, issue
 * #1814). Maps to the NO_COMPANY_YET structured error with its remediation.
 */
export function noCompanyYetError(): Error {
  return codedError(
    'NO_COMPANY_YET',
    'This account has no company yet. Create the company in the web app, then retry.'
  )
}

function isCompanyRole(value: unknown): value is CompanyRole {
  return value === 'owner' || value === 'admin' || value === 'member' || value === 'viewer'
}

export function isCompanyDependentTool(toolName: string): boolean {
  return !COMPANY_INDEPENDENT_TOOLS.has(toolName)
}

/**
 * Does a tool that requires `scope` change tenant state?
 *
 * Every scope that is not `:read` counts: `:write`, `:approve`, `:manage` and
 * `:signoff` today (sign-off attests on the company's behalf, a write for the
 * role guard even though the scope is deliberately not `:write`), and any
 * suffix added later. Deriving from `scopeKind` instead of an allowlist of
 * suffixes means a new elevated scope is write-gated for viewers by default
 * rather than silently open until someone remembers this function.
 *
 * `undefined` (a tool absent from TOOL_SCOPE_MAP) is not a tenant write: the
 * unscoped tools are discovery, skills and the feedback channel, and
 * strict-schemas.test.ts pins that every write-annotated tool has a scope.
 */
export function isTenantWriteScope(scope: ApiKeyScope | undefined): boolean {
  return scope !== undefined && scopeKind(scope) === 'write'
}

export function projectToolInputSchema(
  tool: ToolSchemaSource,
  options: { omitCompanyId?: boolean } = {}
): Record<string, unknown> {
  // Simple company mode (the key reaches at most one company): no tool gains
  // company_id, there is nothing to choose between. The dispatcher still
  // tolerates the argument, so a caller that sends it anyway keeps working.
  if (options.omitCompanyId) return tool.inputSchema
  if (!isCompanyDependentTool(tool.name) && !isOptionalCompanyTool(tool.name)) return tool.inputSchema

  const properties =
    tool.inputSchema.properties && typeof tool.inputSchema.properties === 'object'
      ? (tool.inputSchema.properties as Record<string, unknown>)
      : {}

  return {
    ...tool.inputSchema,
    properties: {
      ...properties,
      company_id: COMPANY_ID_INPUT_PROPERTY,
    },
  }
}

export function extractRequestedCompany(
  rawArgs: Record<string, unknown>
): { requestedCompanyId: string | undefined; toolArgs: Record<string, unknown> } {
  const { company_id: rawCompanyId, ...toolArgs } = rawArgs
  if (rawCompanyId === undefined) return { requestedCompanyId: undefined, toolArgs }
  if (typeof rawCompanyId !== 'string' || !UUID_PATTERN.test(rawCompanyId)) {
    throw codedError('VALIDATION_ERROR', 'company_id must be a valid UUID')
  }
  return { requestedCompanyId: rawCompanyId, toolArgs }
}

export async function resolveMcpCompanyContext(args: {
  supabase: SupabaseClient
  userId: string
  /** null while the key's user has no company (see validateApiKey). */
  defaultCompanyId: string | null
  requestedCompanyId?: string
}): Promise<McpCompanyContext> {
  const companyId = args.requestedCompanyId ?? args.defaultCompanyId
  if (!companyId) {
    throw noCompanyYetError()
  }

  // One query: the membership row, the archived flag, and both name sources
  // (company_settings is one-to-one on company_id, so PostgREST embeds it as
  // an object; the parser below also accepts the array shape).
  const { data: membership, error } = await args.supabase
    .from('company_members')
    .select('company_id, role, companies!inner(archived_at, name, company_settings(company_name))')
    .eq('user_id', args.userId)
    .eq('company_id', companyId)
    .is('companies.archived_at', null)
    .maybeSingle()

  if (error) {
    throw codedError('INTERNAL_ERROR', `Failed to resolve company membership: ${error.message}`)
  }
  if (!membership) {
    throw codedError('NOT_FOUND', 'Company not found')
  }
  if (!isCompanyRole(membership.role)) {
    throw codedError('FORBIDDEN', 'Company membership has an unsupported role')
  }
  const companyName = displayNameFromMembership(
    (membership as { companies?: unknown }).companies,
    companyId
  )

  // Multi-user seat gate: the MCP surface is a chokepoint like the HTTP
  // routes, so a non-owner membership in a frozen company (multi_user lapsed
  // past its 20-day grace) is refused here, before any tool touches tenant
  // data. Owners always pass; self-hosted/dev return 'entitled' outright.
  if (membership.role !== 'owner') {
    const access = await getMultiUserState(args.supabase, companyId)
    if (isMembershipDormant(membership.role, access.state)) {
      throw codedError(
        'FORBIDDEN',
        'This company is paused for your account: multiple users require a paid plan. Ask the company owner to upgrade.'
      )
    }
  }

  return {
    companyId,
    companyName,
    role: membership.role,
    isDefault: companyId === args.defaultCompanyId,
  }
}

/**
 * Display name out of the embedded `companies(...)` shape: the settings
 * display name when present, else companies.name, else the id (tests and
 * older mocks embed nothing; a missing name must never fail routing).
 */
function displayNameFromMembership(embedded: unknown, companyId: string): string {
  const company = Array.isArray(embedded) ? embedded[0] : embedded
  if (!company || typeof company !== 'object') return companyId
  const record = company as { name?: unknown; company_settings?: unknown }
  const settings = Array.isArray(record.company_settings)
    ? record.company_settings[0]
    : record.company_settings
  const displayName =
    settings && typeof settings === 'object'
      ? (settings as { company_name?: unknown }).company_name
      : undefined
  if (typeof displayName === 'string' && displayName.trim().length > 0) return displayName
  if (typeof record.name === 'string' && record.name.trim().length > 0) return record.name
  return companyId
}

export interface McpCompanyScope extends ResolvedCompanyScope {
  /** Companies dropped by the multi-user seat gate (non-owner in a frozen company). */
  dormant: string[]
}

/**
 * Resolve a scope (all | team | explicit ids) for the MCP surface: the lib
 * resolver intersects with memberships and archived state; this wrapper adds
 * the multi-user seat gate per company, the same gate resolveMcpCompanyContext
 * applies to a single company. Owners always pass. Explicit ids that are not
 * accessible come back in `unresolved` (the tool decides whether that is an
 * error); companies frozen for this user come back in `dormant`.
 */
export async function resolveMcpCompanyScope(args: {
  supabase: SupabaseClient
  userId: string
  scope: CompanyScopeInput | undefined
}): Promise<McpCompanyScope> {
  const resolved = await resolveCompanyScope(args.supabase, args.userId, args.scope ?? {})
  const dormant: string[] = []
  const kept: ScopedCompany[] = []
  const gates = await Promise.all(
    resolved.companies.map(async (company) => {
      if (company.role === 'owner') return { company, dormant: false }
      const access = await getMultiUserState(args.supabase, company.companyId)
      return { company, dormant: isMembershipDormant(company.role, access.state) }
    })
  )
  for (const gate of gates) {
    if (gate.dormant) dormant.push(gate.company.companyId)
    else kept.push(gate.company)
  }
  return { ...resolved, companies: kept, dormant }
}

/**
 * Parse the `scope` argument of a scoped tool. Accepts the object form
 * ({ companies: "all" | "team" | [ids], exclude?: [ids] }) and, for
 * convenience, a bare "all" / "team" string or a bare id array. Anything
 * else is a VALIDATION_ERROR that names the accepted shapes.
 */
export function parseScopeArgument(raw: unknown): CompanyScopeInput {
  if (raw === undefined || raw === null) return {}
  if (raw === 'all' || raw === 'team') return { companies: raw }
  if (Array.isArray(raw)) return { companies: assertIdList(raw, 'scope') }
  if (typeof raw === 'object') {
    const record = raw as Record<string, unknown>
    const input: CompanyScopeInput = {}
    if (record.companies !== undefined) {
      if (record.companies === 'all' || record.companies === 'team') {
        input.companies = record.companies
      } else if (Array.isArray(record.companies)) {
        input.companies = assertIdList(record.companies, 'scope.companies')
      } else {
        throw codedError(
          'VALIDATION_ERROR',
          'scope.companies must be "all", "team" or an array of company ids'
        )
      }
    }
    if (record.exclude !== undefined) {
      if (!Array.isArray(record.exclude)) {
        throw codedError('VALIDATION_ERROR', 'scope.exclude must be an array of company ids')
      }
      input.exclude = assertIdList(record.exclude, 'scope.exclude')
    }
    return input
  }
  throw codedError(
    'VALIDATION_ERROR',
    'scope must be { companies: "all" | "team" | [company ids], exclude?: [company ids] }'
  )
}

function assertIdList(values: unknown[], field: string): string[] {
  const ids: string[] = []
  for (const value of values) {
    if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
      throw codedError('VALIDATION_ERROR', `${field} must contain company ids (UUIDs)`)
    }
    ids.push(value)
  }
  return ids
}

/**
 * Read-only role gate for the MCP tools/call path.
 *
 * Called by the dispatcher (server.ts, tools/call) right after
 * `resolveMcpCompanyContext` for every company-scoped call, including calls
 * routed through the gnubok_call_tool bridge, and before execute(). The MCP
 * surface runs as the service role, so RLS never sees the viewer: this is
 * the only place the role is enforced for API-key callers. Read tools pass
 * unchanged; a viewer's key with write scopes is still refused, because the
 * key's scopes bound what the key MAY do and the role bounds what the user
 * may do, and the effective permission is the intersection.
 */
export function assertMcpCompanyWriteAccess(
  context: McpCompanyContext,
  scope: ApiKeyScope | undefined
): void {
  if (context.role === 'viewer' && isTenantWriteScope(scope)) {
    throw codedError(
      'FORBIDDEN',
      `This company membership is read-only (viewer): tools that require the "${scope}" scope change company data and are refused. Use read tools only, or ask a company owner or admin to change the role.`
    )
  }
}

export function addCompanyToNextHint(next: unknown, companyId: string): unknown {
  if (!next || typeof next !== 'object' || Array.isArray(next)) return next
  const hint = next as Record<string, unknown>
  if (typeof hint.tool !== 'string' || !isCompanyDependentTool(hint.tool)) return next
  const args =
    hint.args && typeof hint.args === 'object' && !Array.isArray(hint.args)
      ? (hint.args as Record<string, unknown>)
      : {}
  return {
    ...hint,
    args: { ...args, company_id: companyId },
  }
}

export function addCompanyToTopLevelNext(result: unknown, companyId: string): unknown {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return result
  const record = result as Record<string, unknown>
  if (!record.next) return result
  return {
    ...record,
    next: addCompanyToNextHint(record.next, companyId),
  }
}
