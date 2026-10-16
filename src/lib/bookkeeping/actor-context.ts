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
  /**
   * Matches the journal_entries.committed_actor_type CHECK constraint.
   * 'service_account': a key of a service account (lib/service-accounts),
   * whose label is the account's name; the row's user_id is its sponsor, the
   * person the account acts for.
   */
  type: 'user' | 'api_key' | 'mcp_oauth' | 'cron' | 'system' | 'agent_chat' | 'service_account'
  /** Human-readable credential label, e.g. the API key name. */
  label?: string
  /**
   * SEK ceiling on what this credential may commit WITHOUT human approval,
   * or null/undefined for no limit. Read from api_keys by
   * validate_and_increment_api_key, which is the one place the database itself
   * verifies which credential is acting, so the value is bound to a verified
   * key rather than asserted by the caller.
   *
   * Only ever set for a key credential: `type: 'api_key'`, `'mcp_oauth'`,
   * whose OAuth access token is itself a minted key, or `'service_account'`,
   * a service account's key. Human approvals, cron
   * and the cookie-session routes cannot reach the check that reads it.
   */
  unattendedCommitLimit?: number | null
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

/**
 * The commit_method a commit records when its caller names none, read off
 * WHO is committing. Derived at the commit doors, so a new booking path
 * cannot leave HOW blank by forgetting to pass it. cron and system stay NULL:
 * no journal_entries_commit_method_check value describes them, and
 * committed_actor_type already says what they are.
 */
export function defaultCommitMethod(
  actor: CommitActor | undefined
): 'user_accept' | 'api_key' | 'agent' | null {
  switch (actor?.type) {
    case 'user':
      return 'user_accept'
    case 'api_key':
    case 'mcp_oauth':
    case 'service_account':
      return 'api_key'
    case 'agent_chat':
      return 'agent'
    default:
      return null
  }
}
