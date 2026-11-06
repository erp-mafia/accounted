/**
 * Client-side reach of a tool: what a client that only knows tools/list can
 * invoke.
 *
 * Server-side every tool has always been callable by name: the tools/call
 * dispatcher resolves against the whole registry and isDefaultCatalogTool
 * gates only what tools/list SHOWS. The gap is on the client: claude.ai,
 * Cursor, grok and Claude Code cannot name a tool they never saw. Two listed
 * bridges close it: gnubok_call_tool carries reads, gnubok_stage_tool carries
 * writes that only STAGE a pending operation (issue #2800), and since
 * 2026-10-18 gnubok_call_tool carries those staging writes too, for a client
 * whose copy of tools/list predates gnubok_stage_tool. Search results and
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

/** The MCP Apps marker a host reads (`_meta.ui.visibility`); absent means model and app. */
interface ToolUiVisibility {
  _meta?: { ui?: { visibility?: ReadonlyArray<'model' | 'app'> } }
}

/**
 * A tool only an MCP Apps view calls (`_meta.ui.visibility` without 'model';
 * today the approval view's door, view-approval.ts): listed to a connection
 * that has the view, where the host keeps it from the model, and otherwise
 * unreachable. No search hit, bridge, suggestion or briefing ever names it.
 */
export function isViewOnlyTool(tool: ToolUiVisibility): boolean {
  const visibility = tool._meta?.ui?.visibility
  return Array.isArray(visibility) && !visibility.includes('model')
}

/** In the default catalog: neither search-only nor a view-only tool. */
export function isDefaultCatalogTool(tool: { catalogVisibility?: 'default' | 'search' } & ToolUiVisibility): boolean {
  return tool.catalogVisibility !== 'search' && !isViewOnlyTool(tool)
}

/**
 *   tools_list: in THIS caller's tools/list.
 *   call_tool:  a READ outside it, reachable through gnubok_call_tool.
 *   stage_tool: a WRITE outside the default catalog that only stages a pending
 *               operation, reachable through gnubok_stage_tool (and through
 *               gnubok_call_tool, for a client that does not show the
 *               former). Nothing reaches the books until
 *               gnubok_approve_pending_operation, a separate listed step.
 *   none:       a WRITE outside it that neither bridge carries: it commits
 *               directly, or it is a default-catalog write this caller's list
 *               omits (gnubok_stage_tool carries only what is absent from the
 *               default catalog, see bridgeRefusalReason in server.ts).
 *
 * `listed` is the caller's own tools/list membership, never the registry
 * tier: server.ts derives it from isListedFor, the predicate the tools/list
 * handler filters with, so a hit can never say tools_list for a tool the
 * caller's list omits (agent feedback seq 995216). Both fields are required:
 * a call site that forgot `stages` would report every staging write as
 * unreachable, one that guessed `listed` would reopen the drift.
 */
export function toolCallableVia(
  tool: {
    catalogVisibility?: 'default' | 'search'
    annotations: { readOnlyHint?: boolean }
  } & ToolUiVisibility,
  reach: { listed: boolean; stages: boolean },
): ToolCallableVia {
  if (reach.listed) return 'tools_list'
  if (tool.annotations.readOnlyHint === true) return 'call_tool'
  return reach.stages && !isDefaultCatalogTool(tool) ? 'stage_tool' : 'none'
}

/** One-line reason attached wherever a search-only, directly-committing WRITE is reported. */
export const SEARCH_ONLY_WRITE_NOTE =
  'search-only WRITE that commits directly: not in tools/list and refused by both bridges. Only a client that can name unlisted tools reaches it; otherwise ask for the tool to be enabled or use the web app.'

/** Reach note for a search-only READ: callable, but not through tools/list. */
export const SEARCH_ONLY_READ_NOTE = 'not in tools/list: invoke it through gnubok_call_tool'

/** Reach note for a search-only staging WRITE: callable, but not through tools/list. */
export const SEARCH_ONLY_STAGED_NOTE =
  'not in tools/list: stage it through gnubok_stage_tool (gnubok_call_tool if your client lacks it), then approve with gnubok_approve_pending_operation'

/**
 * What a refresh or reconnect does NOT do on its own: a chat that is already
 * running keeps the tool list it started with. A ChatGPT connector added
 * before gnubok_call_tool existed was reconnected, the new connection fetched
 * a fresh tools/list (bridge included), and the agent in the same chat still
 * reported the bridge missing four minutes later; a later session on that
 * connection reached a bridge-only tool (crm#1628). Every place that tells an
 * agent to have the connector refreshed says this too.
 */
export const RECONNECT_ADVICE =
  'ask the user to refresh or reconnect the Accounted connector, then start a new chat (a chat keeps the tools it began with)'

/**
 * What callable_via "tools_list" cannot know: the server lists the tool today,
 * but some clients keep the tools/list they fetched when the connector was
 * added. A ChatGPT connector worked for weeks on its setup copy and never saw
 * gnubok_update_invoice, listed two days after that copy was taken (agent
 * feedback seq 995216). Said once per search response and in the bridge
 * refusals that send an agent to a direct call, the two places an agent with
 * a stale copy lands.
 */
export const STALE_TOOLS_LIST_NOTE =
  `tools_list = in this server's tools/list now. A client holding an older copy of the list (some connectors fetch it once, when added) does not show tools listed since: ${RECONNECT_ADVICE}, and call the tool by name there.`

/**
 * The same gap one step out: a tool reached through a bridge is reachable only
 * if the client shows the bridge. gnubok_stage_tool was listed on 2026-09-21,
 * weeks after gnubok_call_tool, so a connector added in between read payment
 * orders through one bridge and told its user the other was "not available",
 * with no word on what unblocks it (support case 2026-10-18). A reconnect did
 * not fetch a new list either, so the note now names the bridge that works
 * with the old copy: gnubok_call_tool carries every stage_tool target, and
 * the client's cached description of it still says writes are refused. Said
 * once per search response and briefing that names a bridge.
 */
export const STALE_BRIDGE_NOTE =
  `A bridge named in callable_via or a note that your client does not show means it kept an older copy of tools/list. Without gnubok_stage_tool, stage the same tool through gnubok_call_tool({tool, arguments}): it carries every stage_tool target and only stages, whatever its older description says. Otherwise ${RECONNECT_ADVICE}. The tool exists; do not report it as unavailable.`

/**
 * The same advice for one named tool, appended to a refusal that says "call it
 * directly". A client that defers tool loading (a large connector, Claude
 * Code's tool search) has the tool but has not loaded it, and loading it is
 * the fix there: the advice used to go straight to reconnecting, and about a
 * third of the sessions refused this way in 30 days never reached the tool.
 */
export function staleToolsListAdvice(toolName: string): string {
  return `If your client does not show ${toolName}, load it through your client's tool search first when it defers tools; if not, the client kept an older copy of tools/list: ${RECONNECT_ADVICE}.`
}
