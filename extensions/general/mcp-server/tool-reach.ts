/**
 * Client-side reach of a tool: what a client that only knows tools/list can
 * invoke.
 *
 * Server-side every tool has always been callable by name: the tools/call
 * dispatcher resolves against the whole registry and isDefaultCatalogTool
 * gates only what tools/list SHOWS. The gap is on the client: claude.ai,
 * Cursor, grok and Claude Code cannot name a tool they never saw. Two listed
 * bridges close it: gnubok_call_tool carries reads, gnubok_stage_tool carries
 * writes that only STAGE a pending operation (issue #2800). Search results and
 * the briefing's recommended_tools used to be computed from the full catalog
 * while callability depends on the key's scopes and on the client, so agents
 * chased search-only writes and reported them as missing tools (feedback seq
 * 372962, 335021, 381082, 414922, 371965).
 *
 * Pure module with no server imports so recommended-tools.ts and server.ts
 * share one classification without an import cycle. That is why `stages` is
 * passed in rather than derived here: the staged-operation schema is private
 * to server.ts, and isStagingTool there is the single source of truth.
 */

export type ToolCallableVia = 'tools_list' | 'call_tool' | 'stage_tool' | 'none'

export function isDefaultCatalogTool(tool: { catalogVisibility?: 'default' | 'search' }): boolean {
  return tool.catalogVisibility !== 'search'
}

/**
 *   tools_list: in the default catalog, listed by tools/list.
 *   call_tool:  search-only READ, reachable through gnubok_call_tool.
 *   stage_tool: search-only WRITE that only stages a pending operation,
 *               reachable through gnubok_stage_tool. Nothing reaches the books
 *               until gnubok_approve_pending_operation, a separate listed step.
 *   none:       search-only WRITE that commits directly: absent from
 *               tools/list and refused by both bridges, so a client that
 *               cannot name an unlisted tool has no way to invoke it.
 *
 * `stages` is required, not optional: a call site that forgot it would
 * silently report every staging write as unreachable.
 */
export function toolCallableVia(
  tool: {
    catalogVisibility?: 'default' | 'search'
    annotations: { readOnlyHint?: boolean }
  },
  stages: boolean,
): ToolCallableVia {
  if (isDefaultCatalogTool(tool)) return 'tools_list'
  if (tool.annotations.readOnlyHint === true) return 'call_tool'
  return stages ? 'stage_tool' : 'none'
}

/** One-line reason attached wherever a search-only, directly-committing WRITE is reported. */
export const SEARCH_ONLY_WRITE_NOTE =
  'search-only WRITE that commits directly: not in tools/list and refused by both bridges. Only a client that can name unlisted tools reaches it; otherwise ask for the tool to be enabled or use the web app.'

/** Reach note for a search-only READ: callable, but not through tools/list. */
export const SEARCH_ONLY_READ_NOTE = 'not in tools/list: invoke it through gnubok_call_tool'

/** Reach note for a search-only staging WRITE: callable, but not through tools/list. */
export const SEARCH_ONLY_STAGED_NOTE =
  'not in tools/list: stage it through gnubok_stage_tool, then approve with gnubok_approve_pending_operation'
