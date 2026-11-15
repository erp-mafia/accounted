import { TOOL_SCOPE_MAP, UNSCOPED_TOOLS, scopeKind } from '@/lib/auth/scope-catalog'

/**
 * Whether an assistant turn for a read-only member (the viewer role) may get
 * this tool: a read tool by its scope. The two bridges are left out, since
 * they carry the scope of the tool they name, which is not known here. A tool
 * in neither TOOL_SCOPE_MAP nor UNSCOPED_TOOLS fails closed.
 */
export function isReadOnlyTool(name: string): boolean {
  if (name === 'gnubok_call_tool' || name === 'gnubok_stage_tool') return false
  // Unscoped because ownership is its gate, and a write all the same.
  if (name === 'gnubok_withdraw_pending_operation') return false
  if (UNSCOPED_TOOLS.has(name)) return true
  const scope = TOOL_SCOPE_MAP[name]
  return scope !== undefined && scopeKind(scope) === 'read'
}
