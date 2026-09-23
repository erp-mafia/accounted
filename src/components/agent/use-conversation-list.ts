'use client'

import { useCallback, useMemo, useRef, useState } from 'react'
import { useToast } from '@/components/ui/use-toast'
import { type ConversationRow, type DateBucket, groupConversations } from './conversation-display'
import {
  createRevisionGuard,
  removeRow,
  restoreRow,
  runOptimisticPatch,
  setPinned,
  setTitle,
} from './conversation-mutations'

/**
 * Shared state and mutations for the agent conversation list.
 *
 * The two surfaces that show conversations (the full-page /chat sidebar and the
 * in-sheet resume list) had drifted apart in behaviour, not just chrome: the
 * sheet rolled a failed rename back and toasted, while the sidebar fired pin,
 * archive and rename blind, with no res.ok check, no rollback and no message.
 * A failed archive there removed a conversation from the list while it still
 * existed on the server, and a failed rename displayed a title the server never
 * saved, both until the next reload.
 *
 * Owning the state and all three mutations here means the two surfaces cannot
 * diverge again, and the sheet gains pin/archive it never had. The chrome
 * stays with each surface: a 320px sidebar that collapses to a rail and a sheet
 * panel are legitimately different shapes.
 *
 * The transforms and the write coordinator live in conversation-mutations.ts so
 * they are testable without a React harness (this repo's unit project is
 * node-only).
 */
export interface ConversationListApi {
  conversations: ConversationRow[]
  setConversations: React.Dispatch<React.SetStateAction<ConversationRow[]>>
  query: string
  setQuery: (q: string) => void
  grouped: { bucket: DateBucket; rows: ConversationRow[] }[]
  togglePin: (id: string, current: boolean) => Promise<void>
  archive: (id: string) => Promise<boolean>
  rename: (id: string, title: string) => Promise<void>
  // Inline rename plumbing, shared so Esc-to-cancel behaves identically.
  editingId: string | null
  editValue: string
  setEditValue: (v: string) => void
  startEdit: (c: ConversationRow) => void
  cancelEdit: () => void
  commitEdit: (id: string) => Promise<void>
}

export function useConversationList(initial: ConversationRow[]): ConversationListApi {
  const [conversations, setConversations] = useState<ConversationRow[]>(initial)
  const [query, setQuery] = useState('')
  const { toast } = useToast()
  const guard = useRef(createRevisionGuard()).current

  const [editingId, setEditingId] = useState<string | null>(null)
  const [editValue, setEditValue] = useState('')
  // Set by Esc so the blur fired when the input unmounts doesn't save.
  const cancelRef = useRef(false)

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return conversations
    return conversations.filter(
      (c) =>
        (c.title ?? '').toLowerCase().includes(q) ||
        (c.last_message_preview ?? '').toLowerCase().includes(q) ||
        (c.context_ref ?? '').toLowerCase().includes(q) ||
        c.intent_id.toLowerCase().includes(q),
    )
  }, [conversations, query])

  const grouped = useMemo(() => groupConversations(filtered), [filtered])

  const togglePin = useCallback(
    async (id: string, current: boolean) => {
      await runOptimisticPatch({
        id,
        body: { pinned: !current },
        apply: (list) => setPinned(list, id, !current),
        revert: (list) => setPinned(list, id, current),
        setList: setConversations,
        guard,
        onError: () => toast({ variant: 'destructive', title: 'Kunde inte ändra fästningen.' }),
      })
    },
    [guard, toast],
  )

  /** Resolves true when the row is really archived, so callers can navigate. */
  const archive = useCallback(
    async (id: string) => {
      const row = conversations.find((c) => c.id === id)
      return runOptimisticPatch({
        id,
        body: { archived: true },
        apply: (list) => removeRow(list, id),
        // Restore into the CURRENT list, not a snapshot: changes made while the
        // request was in flight must survive.
        revert: (list) => (row ? restoreRow(list, row) : list),
        setList: setConversations,
        guard,
        onError: () => toast({ variant: 'destructive', title: 'Kunde inte arkivera konversationen.' }),
      })
    },
    [conversations, guard, toast],
  )

  const rename = useCallback(
    async (id: string, title: string) => {
      const previousTitle = conversations.find((c) => c.id === id)?.title ?? null
      await runOptimisticPatch({
        id,
        body: { title },
        apply: (list) => setTitle(list, id, title),
        revert: (list) => setTitle(list, id, previousTitle),
        setList: setConversations,
        guard,
        onError: () =>
          toast({ variant: 'destructive', title: 'Kunde inte byta namn på konversationen.' }),
      })
    },
    [conversations, guard, toast],
  )

  const startEdit = useCallback((c: ConversationRow) => {
    setEditingId(c.id)
    setEditValue(c.title ?? '')
    cancelRef.current = false
  }, [])

  const cancelEdit = useCallback(() => {
    cancelRef.current = true
    setEditingId(null)
  }, [])

  const commitEdit = useCallback(
    async (id: string) => {
      if (cancelRef.current) {
        cancelRef.current = false
        return
      }
      setEditingId(null)
      const title = editValue.trim()
      const current = conversations.find((c) => c.id === id)
      if (!title || title === current?.title) return
      await rename(id, title)
    },
    [conversations, editValue, rename],
  )

  return {
    conversations,
    setConversations,
    query,
    setQuery,
    grouped,
    togglePin,
    archive,
    rename,
    editingId,
    editValue,
    setEditValue,
    startEdit,
    cancelEdit,
    commitEdit,
  }
}
