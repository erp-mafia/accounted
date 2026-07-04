/**
 * Transaction-scoped actor context for journal-entry commits: isomorphic half.
 *
 * Carries WHO is relaying a commit (api_key | user | agent_chat | …) from the
 * approval entry points down to commitEntry() without threading a parameter
 * through every pending-operation executor and entry-generator in between.
 * commitEntry() reads it as a fallback and forwards it to the
 * commit_journal_entry RPC, which stamps journal_entries.committed_actor_* and
 * the audit_log COMMIT row (migration 20260619120000).
 *
 * engine.ts is reachable from client component bundles (e.g. the invoice
 * detail page), and client chunks cannot load node:async_hooks: so this
 * module holds only the type + a storage registry, and the AsyncLocalStorage
 * implementation lives in ./actor-context-node (server-only, imported by the
 * approval paths). In a client bundle the registry stays empty and getActor()
 * returns undefined: the same no-attribution default as a server call
 * outside a runWithActor() scope.
 */
export interface CommitActor {
  /** Matches the journal_entries.committed_actor_type CHECK constraint. */
  type: 'user' | 'api_key' | 'mcp_oauth' | 'cron' | 'system' | 'agent_chat'
  /** Human-readable credential label, e.g. the API key name. */
  label?: string
}

export interface ActorStore {
  getStore(): CommitActor | undefined
}

let store: ActorStore | null = null

/** Bind the server-side AsyncLocalStorage. Called by ./actor-context-node. */
export function bindActorStore(s: ActorStore): void {
  store = s
}

/** The actor for the current async execution scope, if any. */
export function getActor(): CommitActor | undefined {
  return store?.getStore()
}
