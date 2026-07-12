'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { Search, X, Loader2, MessageSquare, Pencil } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useToast } from '@/components/ui/use-toast'
import {
  type ConversationRow,
  BUCKET_LABELS,
  relativeTime,
  intentLabel,
  groupConversations,
} from './conversation-display'

interface Props {
  // Highlight the row for the conversation currently open in the sheet.
  activeConversationId?: string | null
  // Fired when the user picks a conversation to resume. The sheet fetches its
  // messages and swaps back to the chat view: the list itself stays dumb.
  onSelect: (id: string) => void
}

// In-sheet conversation picker. Renders the same grouped/searchable list as the
// /chat sidebar (shared helpers in conversation-display.ts), but instead of
// navigating to /chat/[id] it hands the id back so the conversation opens
// inline in the sheet and the user keeps chatting without leaving the page.
// Rows are renameable inline (PATCH /api/agent/conversations/[id]).
export default function AgentSessionList({ activeConversationId, onSelect }: Props) {
  const [conversations, setConversations] = useState<ConversationRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editValue, setEditValue] = useState('')
  // Set by Esc so the blur that fires when the input unmounts doesn't save.
  const cancelRef = useRef(false)
  const { toast } = useToast()

  useEffect(() => {
    let cancelled = false
    void (async () => {
      setLoading(true)
      setError(null)
      try {
        const res = await fetch('/api/agent/conversations?limit=100')
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const json = (await res.json()) as { data?: ConversationRow[] }
        if (!cancelled) setConversations(json.data ?? [])
      } catch {
        if (!cancelled) setError('Kunde inte hämta konversationer.')
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

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

  function startEdit(c: ConversationRow) {
    setEditingId(c.id)
    setEditValue(c.title ?? '')
    cancelRef.current = false
  }
  function cancelEdit() {
    cancelRef.current = true
    setEditingId(null)
  }
  async function commitEdit(id: string) {
    if (cancelRef.current) {
      cancelRef.current = false
      return
    }
    setEditingId(null)
    const title = editValue.trim()
    const current = conversations.find((c) => c.id === id)
    if (!title || title === current?.title) return
    // Capture the pre-rename title so we can roll back if the PATCH fails.
    const previousTitle = current?.title ?? null
    setConversations((prev) => prev.map((c) => (c.id === id ? { ...c, title } : c)))
    try {
      const res = await fetch(`/api/agent/conversations/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title }),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
    } catch {
      // Revert the optimistic rename so the list stays in sync with the server.
      setConversations((prev) =>
        prev.map((c) => (c.id === id ? { ...c, title: previousTitle } : c)),
      )
      toast({
        variant: 'destructive',
        title: 'Kunde inte byta namn på konversationen.',
      })
    }
  }

  return (
    <div className="flex flex-1 flex-col min-h-0">
      <div className="border-b border-border px-5 py-3">
        <div className="relative">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Sök konversationer…"
            className="w-full rounded-md border border-border bg-background pl-8 pr-7 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
          />
          {query.length > 0 && (
            <button
              type="button"
              onClick={() => setQuery('')}
              aria-label="Rensa sökning"
              className="absolute right-1 top-1/2 -translate-y-1/2 inline-flex h-8 w-8 items-center justify-center rounded text-muted-foreground hover:bg-secondary hover:text-foreground"
            >
              <X className="h-3 w-3" />
            </button>
          )}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto">
        {loading ? (
          <div className="flex items-center justify-center gap-2 p-6 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Hämtar…
          </div>
        ) : error ? (
          <div className="p-6 text-sm text-destructive">{error}</div>
        ) : grouped.length === 0 ? (
          <div className="flex flex-col items-center gap-2 p-10 text-center text-sm text-muted-foreground">
            <MessageSquare className="h-6 w-6 opacity-40" />
            {conversations.length === 0 ? 'Inga konversationer ännu.' : 'Inga träffar.'}
          </div>
        ) : (
          grouped.map(({ bucket, rows }) => (
            <section key={bucket} className="py-2">
              <p className="px-4 pb-1 text-[10px] uppercase tracking-wider text-muted-foreground">
                {BUCKET_LABELS[bucket]}
              </p>
              <ul className="space-y-1">
                {rows.map((c) => (
                  <li key={c.id}>
                    {editingId === c.id ? (
                      <div className="px-4 py-2">
                        <input
                          autoFocus
                          value={editValue}
                          onChange={(e) => setEditValue(e.target.value)}
                          onBlur={() => void commitEdit(c.id)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') {
                              e.preventDefault()
                              ;(e.target as HTMLInputElement).blur()
                            } else if (e.key === 'Escape') {
                              e.preventDefault()
                              cancelEdit()
                            }
                          }}
                          placeholder="Namnge konversationen…"
                          maxLength={200}
                          aria-label="Nytt namn på konversationen"
                          className="w-full rounded-md border border-border bg-background px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                        />
                      </div>
                    ) : (
                      <div
                        className={cn(
                          'group flex items-stretch border-l-2 transition-colors',
                          activeConversationId === c.id
                            ? 'bg-secondary/50 border-foreground'
                            : 'border-transparent hover:bg-secondary/60',
                        )}
                      >
                        <button
                          type="button"
                          onClick={() => onSelect(c.id)}
                          className="flex flex-1 min-w-0 items-start gap-2 px-4 py-2 text-left"
                        >
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-1.5">
                              <p className="text-sm font-medium truncate flex-1 min-w-0">
                                {c.title ?? intentLabel(c.intent_id)}
                              </p>
                              <p className="text-[11px] text-muted-foreground tabular-nums shrink-0">
                                {relativeTime(c.last_message_at ?? c.created_at)}
                              </p>
                            </div>
                            <p className="text-xs text-muted-foreground line-clamp-1 mt-0.5">
                              {c.last_message_preview ?? intentLabel(c.intent_id)}
                            </p>
                          </div>
                        </button>
                        <button
                          type="button"
                          onClick={() => startEdit(c)}
                          title="Byt namn"
                          aria-label="Byt namn på konversation"
                          className="shrink-0 flex w-10 items-center justify-center text-muted-foreground/50 hover:text-foreground transition-colors"
                        >
                          <Pencil className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            </section>
          ))
        )}
      </div>
    </div>
  )
}
