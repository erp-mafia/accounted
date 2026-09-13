/**
 * Client-side reach of a tool: what a client that only knows tools/list can
 * invoke.
 *
 * Server-side every tool has always been callable by name: the tools/call
 * dispatcher resolves against the whole registry and isDefaultCatalogTool
 * gates only what tools/list SHOWS. The gap is on the client: claude.ai,
 * Cursor, grok and Claude Code cannot name a tool they never saw, and
 * gnubok_call_tool bridges reads only. Search results and the briefing's
 * recommended_tools used to be computed from the full catalog while
 * callability depends on the key's scopes and on the client, so agents chased
 * search-only writes and reported them as missing tools (feedback seq 372962,
 * 335021, 381082, 414922, 371965).
 *
 * Pure module with no server imports so recommended-tools.ts and server.ts
 * share one classification without an import cycle.
 */

export type ToolCallableVia = 'tools_list' | 'call_tool' | 'none'

export function isDefaultCatalogTool(tool: { catalogVisibility?: 'default' | 'search' }): boolean {
  return tool.catalogVisibility !== 'search'
}

/**
 *   tools_list: in the default catalog, listed by tools/list.
 *   call_tool:  search-only READ, reachable through gnubok_call_tool.
 *   none:       search-only WRITE: absent from tools/list and refused by the
 *               bridge, so a client that cannot name an unlisted tool has no
 *               way to invoke it.
 */
export function toolCallableVia(tool: {
  catalogVisibility?: 'default' | 'search'
  annotations: { readOnlyHint?: boolean }
}): ToolCallableVia {
  if (isDefaultCatalogTool(tool)) return 'tools_list'
  return tool.annotations.readOnlyHint === true ? 'call_tool' : 'none'
}

/** One-line reason attached wherever a search-only WRITE is reported. */
export const SEARCH_ONLY_WRITE_NOTE =
  'search-only WRITE: not in tools/list and not bridged by gnubok_call_tool. Only a client that can name unlisted tools reaches it; otherwise ask for the tool to be enabled or use the web app.'

/** Reach note for a search-only READ: callable, but not through tools/list. */
export const SEARCH_ONLY_READ_NOTE = 'not in tools/list: invoke it through gnubok_call_tool'
