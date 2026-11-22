import type { SupabaseClient } from '@supabase/supabase-js'
import type { ApiKeyScope } from '@/lib/auth/api-keys'
// Pure data module (no server imports): the same classifier the settings UI
// and the v1 REST wrapper use, so "what counts as a write" has one owner.
import { scopeKind } from '@/lib/auth/scope-catalog'
import { roleAllowsScope } from '@/lib/auth/invoicer-role'
import { getMultiUserState, isMembershipDormant } from '@/lib/entitlements/multi-user'
import { getUserCompanies } from '@/lib/company/context'
import { readLiveMembership, type LiveMembership } from '@/lib/company/company-access'
import { readOnlyRefusal, type ReadOnlyReason } from '@/lib/auth/require-write'
import { resolveDormantCompanyIds } from '@/lib/company/active-company'
import { fetchAllRows } from '@/lib/supabase/fetch-all'
import {
  resolveCompanyScope,
  type CompanyScopeInput,
  type ResolvedCompanyScope,
} from '@/lib/portfolio/scope'
import type { CompanyRole } from '@/types'
import { getErrorEntry } from '@/lib/errors/structured-errors'
import { createLogger } from '@/lib/logger'
import { COMPANY_PIN_QUERY_PARAM } from './tool-namespace'
import { handleAwareInputSchema } from './handle-args'
import { RECONNECT_ADVICE } from './tool-reach'

const log = createLogger('mcp-company-routing')

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

/**
 * Per-key company allowlist (validateApiKey().allowedCompanyIds): null means
 * the key reaches every membership; a list means only those companies. Ids
 * compare case-insensitively because a caller may spell a UUID in upper
 * case while the DB returns lower case.
 */
export type CompanyAllowlist = readonly string[] | null | undefined

export function isCompanyAllowed(allowlist: CompanyAllowlist, companyId: string): boolean {
  if (!allowlist) return true
  const wanted = companyId.toLowerCase()
  return allowlist.some((id) => id.toLowerCase() === wanted)
}

/**
 * Is the key read-only in this company (validateApiKey().readOnlyCompanyIds,
 * api_key_companies.access = 'read')? null or undefined means no company is
 * read-only. Same case-insensitive comparison as the allowlist.
 */
export function isCompanyReadOnly(readOnlyCompanyIds: CompanyAllowlist, companyId: string): boolean {
  if (!readOnlyCompanyIds) return false
  const wanted = companyId.toLowerCase()
  return readOnlyCompanyIds.some((id) => id.toLowerCase() === wanted)
}

/**
 * The company set a tool may enumerate for this actor: the pin alone when
 * the connection is pinned, else the key allowlist, else null (every
 * membership). For gnubok_list_companies and the all_companies listing,
 * which enumerate rather than resolve one company.
 */
export function effectiveCompanyRestriction(actor: {
  allowedCompanyIds?: string[] | null
  pinnedCompanyId?: string | null
} | undefined): string[] | null {
  if (!actor) return null
  if (actor.pinnedCompanyId) return [actor.pinnedCompanyId]
  return actor.allowedCompanyIds ?? null
}

/**
 * `?company=<uuid>` on the MCP endpoint URL. Absent: no pin. Present but not
 * a UUID: malformed, which the dispatcher answers with a JSON-RPC error
 * before anything else runs. The value is normalised to lower case, the
 * spelling the DB and every company_id echo use.
 */
export function parseCompanyPin(request: Request): { pin: string | null; malformed: boolean } {
  const raw = new URL(request.url).searchParams.get(COMPANY_PIN_QUERY_PARAM)
  if (raw === null) return { pin: null, malformed: false }
  const trimmed = raw.trim()
  if (!UUID_PATTERN.test(trimmed)) return { pin: null, malformed: true }
  return { pin: trimmed.toLowerCase(), malformed: false }
}

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
  // A company formation belongs to the user and comes before its company.
  'gnubok_formation',
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
const OPTIONAL_COMPANY_TOOLS = new Set(['gnubok_list_skills', 'gnubok_load_skill'])

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
  'gnubok_approve_from_view',
  'gnubok_reject_pending_operation',
  'gnubok_withdraw_pending_operation',
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

/**
 * No `format: 'uuid'`: the dispatcher also takes a cmp_ handle here
 * (handle-args.ts), and a host that enforces formats would refuse it. Nor
 * the handle-or-UUID pattern the other id fields carry: this property rides
 * on every company-scoped tool in the multi-company catalog, where the
 * pattern would cost about 1 100 tokens. extractRequestedCompany refuses
 * anything that is not a company id.
 */
const COMPANY_ID_INPUT_PROPERTY = {
  type: 'string',
  description: 'Target company ID. Omit for default.',
} as const

export interface McpCompanyContext {
  companyId: string
  /** Display name (company_settings.company_name, else companies.name). */
  companyName: string
  role: CompanyRole
  isDefault: boolean
  /**
   * What the key may do in this company: 'read' when the connection was
   * given read-only access here (api_key_companies.access), else 'write'
   * (its scopes apply as granted). Independent of `role`: the write gate
   * refuses when either says read.
   */
  keyAccess: 'read' | 'write'
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
 * answer, and the cross-company pending list: the same set
 * gnubok_list_companies returns, reduced to id and name, minus companies the
 * multi-user seat gate pauses for this user (the shared rule,
 * resolveDormantCompanyIds). Best effort: a lookup failure yields an empty
 * list, never an error on top of the error being reported.
 */
export async function listAccessibleCompanies(
  supabase: SupabaseClient,
  userId: string,
  allowedCompanyIds?: CompanyAllowlist
): Promise<Array<{ company_id: string; name: string }>> {
  try {
    type MembershipRow = {
      company_id: string
      role: string
      companies:
        | { id: string; name: string; archived_at: string | null }
        | Array<{ id: string; name: string; archived_at: string | null }>
        | null
    }
    const memberships = (await getUserCompanies(supabase, userId)) as unknown as MembershipRow[]
    const dormant = await resolveDormantCompanyIds(supabase, memberships)
    const accessible = memberships.flatMap((membership) => {
      const company = Array.isArray(membership.companies)
        ? membership.companies[0]
        : membership.companies
      return company &&
        company.archived_at === null &&
        isCompanyAllowed(allowedCompanyIds, company.id) &&
        !dormant.has(membership.company_id)
        ? [company]
        : []
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

/**
 * Is this refusal a "not found"? Every registry code a door answers 404 for:
 * NOT_FOUND and the domain codes (BATCH_TX_NOT_FOUND, INVOICE_NOT_FOUND,
 * DOCUMENT_UPLOAD_NOT_FOUND, ...). The registry decides, so a code added
 * later is covered without being listed here.
 */
export function isNotFoundCode(code: string): boolean {
  return getErrorEntry(code)?.httpStatus === 404
}

/** How many other companies a "not found" names; gnubok_list_companies has them all. */
export const OTHER_COMPANY_CANDIDATES_MAX = 10

/**
 * What a "not found" from a tool says next to its candidates. The last
 * sentence is for a client whose tool list predates the key's second
 * company: a single-company list carries no company_id (simple company
 * mode), some connectors fetch the list once, and such an agent read its own
 * copy as "this tool has no company_id" (crm#1953).
 */
export const OTHER_COMPANY_NOTE =
  'Not found in the company this call ran for (company). candidates are other companies this key reaches ' +
  '(gnubok_list_companies lists all): if the record belongs to one of them, repeat the call with its company_id. ' +
  `Every company-scoped tool takes company_id; if your copy of the tool does not show it, your client kept an older tools/list: ${RECONNECT_ADVICE}.`

/**
 * A "not found" from a tool itself, on a key that reaches several companies:
 * the answer names the company the call ran for and the others the key
 * reaches (crm#1953).
 *
 * A wrong company_id was already answered with candidates, but that is the
 * company resolution refusing. Once the company resolves (the default, when
 * none was named), the tool looks its record up inside that company, and a
 * record that lives in another reachable company came back as a bare "not
 * found" with nothing saying company_id was the fix. One answer for every
 * such refusal, whichever tool raised it and whether the call ran
 * synchronously or as a task.
 *
 * Unchanged when there is nothing to add: a tool that takes no company, a
 * refusal that is not a "not found", a key that reaches one company or a
 * pinned connection (simple company mode), no other company in reach. Best
 * effort like listAccessibleCompanies: a failed lookup leaves the refusal as
 * it was, never an error on top of the error being reported.
 */
export async function withOtherCompanyCandidates<T extends { error: { code: string } }>(
  refusal: T,
  call: {
    supabase: SupabaseClient
    userId: string
    /** The company the tool ran for; null for a tool that takes none. */
    company: CompanyEcho | null
    /** The key's company allowlist, as for a wrong company_id's candidates. */
    allowedCompanyIds?: CompanyAllowlist
    /** The dispatcher's memoised answer; a pinned connection is simple. */
    isSimpleCompanyMode: () => Promise<boolean>
  }
): Promise<
  | T
  | (T & { company: CompanyEcho; candidates: Array<{ company_id: string; name: string }>; candidates_note: string })
> {
  const { company } = call
  if (!company || !isNotFoundCode(refusal.error.code)) return refusal
  try {
    if (await call.isSimpleCompanyMode()) return refusal
    const ranFor = company.company_id.toLowerCase()
    const others = (await listAccessibleCompanies(call.supabase, call.userId, call.allowedCompanyIds)).filter(
      (candidate) => candidate.company_id.toLowerCase() !== ranFor
    )
    if (others.length === 0) return refusal
    return {
      company,
      ...refusal,
      candidates: others.slice(0, OTHER_COMPANY_CANDIDATES_MAX),
      candidates_note: OTHER_COMPANY_NOTE,
    }
  } catch (error) {
    log.warn('other-company candidates not added: the refusal goes out as it was', {
      code: refusal.error.code,
      error: error instanceof Error ? error.message : String(error),
    })
    return refusal
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
  return value === 'owner' || value === 'admin' || value === 'member' || value === 'viewer' || value === 'invoicer'
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

/**
 * The tool's inputSchema as tools/list shows it: company-dependent tools
 * (and the optional-company ones) gain the company_id property. In simple
 * company mode (`options.omitCompanyId`: the key reaches at most one company,
 * or the connection is pinned to one) nothing gains it: there is nothing to
 * choose between. The dispatcher still tolerates the argument from a
 * single-company caller, and refuses a different company under a pin.
 * Typed id fields admit their handle (handleAwareInputSchema), as the
 * dispatcher does.
 */
export function projectToolInputSchema(
  tool: ToolSchemaSource,
  options: { omitCompanyId?: boolean } = {}
): Record<string, unknown> {
  const inputSchema = handleAwareInputSchema(tool.inputSchema)
  if (options.omitCompanyId) return inputSchema
  if (!isCompanyDependentTool(tool.name) && !isOptionalCompanyTool(tool.name)) return inputSchema

  const properties =
    inputSchema.properties && typeof inputSchema.properties === 'object'
      ? (inputSchema.properties as Record<string, unknown>)
      : {}

  return {
    ...inputSchema,
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
    throw Object.assign(codedError('VALIDATION_ERROR', 'company_id must be a valid UUID'), {
      malformedCompanyId: true,
    })
  }
  return { requestedCompanyId: rawCompanyId, toolArgs }
}

/**
 * The refusal of a company_id that is not a UUID (a name, an org number, a
 * placeholder). It stays a VALIDATION_ERROR, but it is a wrong company_id
 * like an unknown one, so the dispatcher answers it with the same candidates
 * (the server instructions promise them for a wrong company_id).
 */
export function isMalformedCompanyIdError(err: unknown): boolean {
  return (err as { malformedCompanyId?: unknown } | null)?.malformedCompanyId === true
}

export async function resolveMcpCompanyContext(args: {
  supabase: SupabaseClient
  userId: string
  /** null while the key's user has no company (see validateApiKey). */
  defaultCompanyId: string | null
  requestedCompanyId?: string
  /**
   * The key's company allowlist (validateApiKey().allowedCompanyIds). A
   * company outside it is refused as NOT_FOUND before the membership query,
   * with the same answer a non-member company gets: the allowlist never
   * reveals more than membership would.
   */
  allowedCompanyIds?: CompanyAllowlist
  /**
   * The key's read-only companies (validateApiKey().readOnlyCompanyIds).
   * Decides `keyAccess` on the returned context; a read-only company is
   * still reached, only its writes are refused (assertMcpCompanyWriteAccess).
   */
  readOnlyCompanyIds?: CompanyAllowlist
}): Promise<McpCompanyContext> {
  const companyId = args.requestedCompanyId ?? args.defaultCompanyId
  if (!companyId) {
    throw noCompanyYetError()
  }
  if (!isCompanyAllowed(args.allowedCompanyIds, companyId)) {
    throw codedError('NOT_FOUND', 'Company not reachable with this key')
  }

  let membership: LiveMembership | null
  try {
    membership = await readLiveMembership(args.supabase, args.userId, companyId)
  } catch (error) {
    throw codedError(
      'INTERNAL_ERROR',
      `Failed to resolve company membership: ${error instanceof Error ? error.message : (error as { message?: string }).message}`
    )
  }
  if (!membership) {
    throw codedError('NOT_FOUND', 'Company not found')
  }
  if (!isCompanyRole(membership.role)) {
    throw codedError('FORBIDDEN', 'Company membership has an unsupported role')
  }
  const companyName = membership.companyName ?? companyId

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
    keyAccess: isCompanyReadOnly(args.readOnlyCompanyIds, companyId) ? 'read' : 'write',
  }
}

/** The MCP door's scope: the lib's, which carries `dormant` (the seat gate) itself. */
export type McpCompanyScope = ResolvedCompanyScope

/**
 * Resolve a scope (all | team | explicit ids) for the MCP surface: the lib
 * resolver intersects with memberships, archived state and the multi-user
 * seat gate (frozen companies come back in `dormant`); this wrapper maps the
 * key's company allowlist onto it. Explicit ids that are not accessible come
 * back in `unresolved` (the tool decides whether that is an error).
 */
export async function resolveMcpCompanyScope(args: {
  supabase: SupabaseClient
  userId: string
  scope: CompanyScopeInput | undefined
  /** The key's company allowlist: the scope is intersected with it. */
  allowedCompanyIds?: CompanyAllowlist
}): Promise<McpCompanyScope> {
  const input: CompanyScopeInput = args.scope ?? {}
  return resolveCompanyScope(
    args.supabase,
    args.userId,
    args.allowedCompanyIds ? { ...input, restrictTo: [...args.allowedCompanyIds] } : input
  )
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

/** Why the write gate refuses a call: the invoicing-only role, a viewer, or a read-only connection. */
export type McpWriteRefusal = 'ROLE_SCOPE_LIMITED' | ReadOnlyReason

/** The write gate's verdict, null when the call may proceed (assertMcpCompanyWriteAccess throws on it). */
export function mcpCompanyWriteRefusal(
  context: McpCompanyContext,
  scope: ApiKeyScope | undefined
): McpWriteRefusal | null {
  if (!roleAllowsScope(context.role, scope)) return 'ROLE_SCOPE_LIMITED'
  if (!isTenantWriteScope(scope)) return null
  if (context.role === 'viewer') return 'ROLE_READ_ONLY'
  if (context.keyAccess === 'read') return 'CONNECTION_READ_ONLY'
  return null
}

/**
 * Read-only gate for the MCP tools/call path: the user's role and the
 * connection's access level in the company.
 *
 * Called by the dispatcher (server.ts, tools/call) right after
 * `resolveMcpCompanyContext` for every company-scoped call, including calls
 * routed through the gnubok_call_tool bridge, and before execute(); also per
 * company by the cross-company staging and batch approval. The MCP surface
 * runs as the service role, so RLS never sees the viewer: this is the only
 * place the role is enforced for API-key callers. Read tools pass unchanged;
 * a write-scoped tool is refused when the user is a viewer OR the connection
 * was given read-only access to this company, because the effective
 * permission is the intersection of the key's scopes, the company's access
 * level and the user's role. The role is checked first so a viewer keeps
 * the message that names the actual fix (the role, not the connection).
 *
 * The invoicing-only role (lib/auth/invoicer-role.ts) is refused every tool,
 * read or write, outside the customer, invoice and article scopes, and every
 * company-scoped tool without a scope.
 *
 * `observe` hears the verdict before it is acted on (the permission shadow,
 * ./permission-shadow.ts); it never changes it, and a throwing observer is
 * ignored.
 */
export function assertMcpCompanyWriteAccess(
  context: McpCompanyContext,
  scope: ApiKeyScope | undefined,
  observe?: (refusal: McpWriteRefusal | null) => void
): void {
  const refusal = mcpCompanyWriteRefusal(context, scope)
  if (observe) {
    try {
      observe(refusal)
    } catch {
      // An observer never decides.
    }
  }
  if (refusal === 'ROLE_SCOPE_LIMITED') {
    throw codedError(
      'FORBIDDEN',
      `This company membership has the Invoicing role: only tools for customers, invoices (quotes and orders included) and articles are allowed${scope ? `, and this one requires the "${scope}" scope` : ''}. Ask a company owner or admin to change the role.`
    )
  }
  if (refusal === 'ROLE_READ_ONLY') {
    throw readOnlyToolError(
      refusal,
      `This company membership is read-only (viewer): tools that require the "${scope}" scope change company data and are refused. Use read tools only, or ask a company owner or admin to change the role.`
    )
  }
  if (refusal === 'CONNECTION_READ_ONLY') {
    throw readOnlyToolError(
      refusal,
      `This connection has read-only access to ${context.companyName}: tools that require the "${scope}" scope change company data and are refused there. Use read tools only, or give the connection write access to this company under Agents > Connect an agent.`
    )
  }
}

/** readOnlyRefusal as a thrown tool error: the dispatch carries `details` to the agent (tool-result.ts). */
function readOnlyToolError(reason: ReadOnlyReason, message: string): Error {
  return Object.assign(codedError('FORBIDDEN', message), { details: readOnlyRefusal(reason).details })
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
