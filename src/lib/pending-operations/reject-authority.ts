/**
 * Who may reject (withdraw) a pending operation over an API key.
 *
 * Rejecting only flips a pending proposal to `rejected`: it never writes to
 * the ledger, so it does not need the approval authority approving needs.
 * Founder decision 2026-10-03 (follow-up to issue #3408): a key that holds a
 * write scope may reject proposals without pending_operations:approve, but
 * only its own, so an agent cannot dismiss a proposal a human or another
 * connection made.
 *
 *   - 'any':  the key holds pending_operations:approve. It may reject every
 *             pending operation in the companies it reaches (unchanged).
 *   - 'own':  no approve, but at least one REJECT_OWN_SCOPES member (a
 *             scope some MCP tool stages through). It may reject only
 *             operations it staged itself: actor_type 'api_key' and actor_id
 *             equal to this key's id, the attribution stagePendingOperation
 *             records on every MCP staging.
 *   - 'none': neither, so nothing (a read-only key cannot have staged
 *             anything either).
 *
 * "Staged by this key" is the strongest rule the rows support: a key's scopes
 * cannot be changed after it is created, and every MCP staging tool requires
 * a REJECT_OWN_SCOPES member (a test in the MCP server pins this), so a key
 * that staged an operation held the write scope its tool needs. An OAuth refresh keeps the same key, so the rule holds
 * across a long chat; reconnecting mints a new key, which then cannot reject
 * the old connection's proposals. Proposals made in the app (actor_type
 * 'user') are never reachable through 'own'.
 *
 * Approve is not touched here: it still requires pending_operations:approve.
 */
import { REJECT_OWN_SCOPES, type ApiKeyScope } from '@/lib/auth/scope-catalog'

export type RejectAuthority = 'any' | 'own' | 'none'

export function rejectAuthority(scopes: readonly string[]): RejectAuthority {
  if (scopes.includes('pending_operations:approve')) return 'any'
  return REJECT_OWN_SCOPES.some((scope: ApiKeyScope) => scopes.includes(scope)) ? 'own' : 'none'
}

/** The attribution columns a pending_operations row carries. */
export interface PendingOperationActor {
  actor_type?: string | null
  actor_id?: string | null
}

/** True when the row was staged through the API key `keyId`. */
export function isStagedByKey(operation: PendingOperationActor, keyId: string | null | undefined): boolean {
  return typeof keyId === 'string' && keyId.length > 0 && operation.actor_type === 'api_key' && operation.actor_id === keyId
}

export function canRejectOperation(
  authority: RejectAuthority,
  keyId: string | null | undefined,
  operation: PendingOperationActor,
): boolean {
  if (authority === 'any') return true
  if (authority === 'own') return isStagedByKey(operation, keyId)
  return false
}
