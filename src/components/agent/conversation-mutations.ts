import type { ConversationRow } from './conversation-display'

/**
 * The list transforms and the optimistic-write coordinator behind
 * useConversationList. Pure and React-free so they can be tested directly:
 * the hook is a thin binding over these, which means a test that deletes the
 * rollback here fails, rather than passing against a copy of the logic.
 */

export function setPinned(
  list: ConversationRow[],
  id: string,
  pinned: boolean,
): ConversationRow[] {
  return list.map((c) => (c.id === id ? { ...c, pinned } : c))
}

export function setTitle(
  list: ConversationRow[],
  id: string,
  title: string | null,
): ConversationRow[] {
  return list.map((c) => (c.id === id ? { ...c, title } : c))
}

export function removeRow(list: ConversationRow[], id: string): ConversationRow[] {
  return list.filter((c) => c.id !== id)
}

/**
 * Put a row back after a failed archive, into whatever the list looks like NOW.
 *
 * Restoring a render-time snapshot of the whole list would discard any pin,
 * rename or archive the user made while the request was in flight. Position
 * follows the server's ordering (pinned first, then most recent first) so the
 * row reappears where it belongs rather than at the end.
 */
export function restoreRow(list: ConversationRow[], row: ConversationRow): ConversationRow[] {
  if (list.some((c) => c.id === row.id)) return list
  const sortKey = (c: ConversationRow) => c.last_message_at ?? c.created_at ?? ''
  const idx = list.findIndex((c) => {
    if (row.pinned !== c.pinned) return row.pinned && !c.pinned
    return sortKey(row) > sortKey(c)
  })
  if (idx === -1) return [...list, row]
  return [...list.slice(0, idx), row, ...list.slice(idx)]
}

/** PATCH one conversation. Resolves false for a non-2xx AND for a thrown fetch. */
export async function patchConversation(
  id: string,
  body: Record<string, unknown>,
): Promise<boolean> {
  try {
    const res = await fetch(`/api/agent/conversations/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    return res.ok
  } catch {
    return false
  }
}

/**
 * Per-row revision guard.
 *
 * Two writes to the same row can overlap (a double-click on pin, a rename
 * while an archive is in flight). Without this, a failing FIRST request would
 * roll back over the SECOND request's newer value. Each write claims a
 * revision; a rollback only applies while its revision is still the latest for
 * that row.
 */
export function createRevisionGuard() {
  const revisions = new Map<string, number>()
  return {
    claim(id: string): number {
      const next = (revisions.get(id) ?? 0) + 1
      revisions.set(id, next)
      return next
    },
    isCurrent(id: string, revision: number): boolean {
      return revisions.get(id) === revision
    },
  }
}

export interface OptimisticPatchArgs {
  id: string
  body: Record<string, unknown>
  /** Optimistic transform, applied immediately. */
  apply: (list: ConversationRow[]) => ConversationRow[]
  /** Undo, applied to the CURRENT list only if this write is still the latest. */
  revert: (list: ConversationRow[]) => ConversationRow[]
  setList: (updater: (prev: ConversationRow[]) => ConversationRow[]) => void
  guard: ReturnType<typeof createRevisionGuard>
  onError: () => void
  patch?: typeof patchConversation
}

/**
 * Apply a change optimistically, send it, and undo it if the server refuses.
 * Returns whether the change stuck.
 */
export async function runOptimisticPatch({
  id,
  body,
  apply,
  revert,
  setList,
  guard,
  onError,
  patch = patchConversation,
}: OptimisticPatchArgs): Promise<boolean> {
  const revision = guard.claim(id)
  setList(apply)

  const ok = await patch(id, body)
  if (ok) return true

  // A newer write for this row has since been issued: undoing here would clobber
  // it. That write owns the row's state and will report its own failure.
  if (!guard.isCurrent(id, revision)) return false

  setList(revert)
  onError()
  return false
}
