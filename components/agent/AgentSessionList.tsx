'use client'

import { useEffect, useState } from 'react'
import { Search, X, Loader2, MessageSquare, Pencil, Pin, PinOff, Archive } from 'lucide-react'
import { cn } from '@/lib/utils'
import {
  type ConversationRow,
  BUCKET_LABELS,
  relativeTime,
  intentLabel,
} from './conversation-display'
import { useConversationList } from './use-conversation-list'

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
  // Same hook the /chat sidebar uses, so pin/archive/rename behave identically
  // on both surfaces (optimistic, rolled back on failure, with a message).
  // Pin and archive are new here: the sheet could only rename before.
  const {
    conversations,
    setConversations,
    query,
    setQuery,
    grouped,
    togglePin,
    archive,
    editingId,
    editValue,
    setEditValue,
    startEdit,
    cancelEdit,
    commitEdit,
  } = useConversationList([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

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
    // setConversations is the hook's stable useState setter; listing it would
    // not change when this runs, and this must fire exactly once on mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

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
            className="w-full rounded-lg border border-border bg-background pl-8 pr-7 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
          />
          {query.length > 0 && (
            <button
              type="button"
              onClick={() => setQuery('')}
              aria-label="Rensa sökning"
              className="absolute right-1 top-1/2 -translate-y-1/2 inline-flex h-8 w-8 items-center justify-center rounded-sm text-muted-foreground hover:bg-secondary hover:text-foreground"
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
                          className="w-full rounded-lg border border-border bg-background px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
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
                        <div className="shrink-0 flex items-center pr-1">
                          <button
                            type="button"
                            onClick={() => void togglePin(c.id, c.pinned)}
                            title={c.pinned ? 'Lossa' : 'Fäst överst'}
                            aria-label={
                              c.pinned ? 'Lossa konversationen' : 'Fäst konversationen överst'
                            }
                            aria-pressed={c.pinned}
                            className="flex h-8 w-8 items-center justify-center text-muted-foreground/50 hover:text-foreground transition-colors"
                          >
                            {c.pinned ? (
                              <PinOff className="h-3.5 w-3.5" />
                            ) : (
                              <Pin className="h-3.5 w-3.5" />
                            )}
                          </button>
                          <button
                            type="button"
                            onClick={() => startEdit(c)}
                            title="Byt namn"
                            aria-label="Byt namn på konversation"
                            className="flex h-8 w-8 items-center justify-center text-muted-foreground/50 hover:text-foreground transition-colors"
                          >
                            <Pencil className="h-3.5 w-3.5" />
                          </button>
                          <button
                            type="button"
                            onClick={() => void archive(c.id)}
                            title="Arkivera"
                            aria-label="Arkivera konversationen"
                            className="flex h-8 w-8 items-center justify-center text-muted-foreground/50 hover:text-foreground transition-colors"
                          >
                            <Archive className="h-3.5 w-3.5" />
                          </button>
                        </div>
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
