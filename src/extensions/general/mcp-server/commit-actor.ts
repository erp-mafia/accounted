/**
 * WHO an MCP connection acts as in the records it writes, as a commit actor
 * (lib/bookkeeping/actor-context.ts). One definition for the two places that
 * need it: the actor scope every authenticated tool call runs in, and the
 * actor a relayed approval commits under (commitStagedOperation).
 */
import type { CommitActor } from '@/lib/bookkeeping/actor-context'

/** The connection facts that decide it (server.ts ActorContext). */
export interface McpActorFacts {
  type: string
  label?: string
  oauthKey?: boolean
  serviceAccountId?: string | null
}

/**
 * Every MCP key is `type: 'api_key'` on the connection, which decides company
 * access and limits. In the records it is what credentialActor (lib/auth/
 * api-keys.ts) made it when handleMcpRequest built the connection: oauthKey,
 * serviceAccountId and the label come from there. Anything that is not a key
 * (the in-app chat dispatching the same tools) is the user.
 */
export function mcpCommitActorType(actor: McpActorFacts | undefined): CommitActor['type'] {
  if (actor?.type !== 'api_key') return 'user'
  if (actor.serviceAccountId) return 'service_account'
  return actor.oauthKey === true ? 'mcp_oauth' : 'api_key'
}

/**
 * The actor scope an authenticated MCP tool call runs in: the credential and
 * the person it acts for (the key's user, a service account's sponsor), so
 * every record the call writes names them, the audit rows of its
 * service-role writes included (lib/supabase/actor-header.ts). Null for an
 * anonymous caller, who only reaches the public read tools.
 *
 * The key's unattended ceiling stays out: MCP tools that write directly were
 * never bound by it (a relayed approval prices its operation itself), and
 * binding them is a decision of its own, not a side effect of naming who acts.
 */
export function mcpToolCallActor(actor: McpActorFacts | undefined, userId: string): CommitActor | null {
  if (actor?.type !== 'api_key' || !userId) return null
  return { type: mcpCommitActorType(actor), ...(actor.label ? { label: actor.label } : {}), userId }
}
