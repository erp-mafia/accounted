import type { SupabaseClient } from '@supabase/supabase-js'
import type { ApiKeyScope } from '@/lib/auth/api-keys'
import type { CompanyRole } from '@/types'

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

const COMPANY_INDEPENDENT_TOOLS = new Set([
  'gnubok_search_tools',
  'gnubok_load_skill',
  'gnubok_list_companies',
])

export const COMPANY_ID_INPUT_PROPERTY = {
  type: 'string',
  format: 'uuid',
  description: 'Target company ID. Omit for default.',
} as const

export interface McpCompanyContext {
  companyId: string
  role: CompanyRole
  isDefault: boolean
}

interface ToolSchemaSource {
  name: string
  inputSchema: Record<string, unknown>
}

export function codedError(
  code: 'VALIDATION_ERROR' | 'NOT_FOUND' | 'FORBIDDEN' | 'INTERNAL_ERROR',
  message: string
) {
  return Object.assign(new Error(message), { code })
}

function isCompanyRole(value: unknown): value is CompanyRole {
  return value === 'owner' || value === 'admin' || value === 'member' || value === 'viewer'
}

export function isCompanyDependentTool(toolName: string): boolean {
  return !COMPANY_INDEPENDENT_TOOLS.has(toolName)
}

export function isTenantWriteScope(scope: ApiKeyScope | undefined): boolean {
  return (
    scope?.endsWith(':write') === true ||
    scope?.endsWith(':approve') === true ||
    scope?.endsWith(':manage') === true ||
    // Sign-off attests on the company's behalf: a write for the role guard
    // even though the scope is deliberately not `:write` (linking rows must
    // not imply the right to attest).
    scope?.endsWith(':signoff') === true
  )
}

export function projectToolInputSchema(tool: ToolSchemaSource): Record<string, unknown> {
  if (!isCompanyDependentTool(tool.name)) return tool.inputSchema

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
  defaultCompanyId: string
  requestedCompanyId?: string
}): Promise<McpCompanyContext> {
  const companyId = args.requestedCompanyId ?? args.defaultCompanyId

  const { data: membership, error } = await args.supabase
    .from('company_members')
    .select('company_id, role, companies!inner(archived_at)')
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

  return {
    companyId,
    role: membership.role,
    isDefault: companyId === args.defaultCompanyId,
  }
}

export function assertMcpCompanyWriteAccess(
  context: McpCompanyContext,
  scope: ApiKeyScope | undefined
): void {
  if (context.role === 'viewer' && isTenantWriteScope(scope)) {
    throw codedError('FORBIDDEN', 'Write permission required for this company')
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
