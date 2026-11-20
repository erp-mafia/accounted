'use client'

import { useEffect, useState } from 'react'
import { useTranslations } from 'next-intl'
import {
  ArchiveBoxIcon,
  BookmarkIcon,
  BookmarkSlashIcon,
  ChatBubbleLeftIcon,
  MagnifyingGlassIcon,
  PencilIcon,
  XMarkIcon,
} from '@/components/icons'
import { Button } from '@/components/ui/button'
import { EmptyState, LoadError } from '@/components/ui/empty-state'
import { LateReveal, Skeleton } from '@/components/ui/skeleton'
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
  const tCommon = useTranslations('common')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  // Bumped by "Försök igen" to fetch the list again.
  const [attempt, setAttempt] = useState(0)

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
    // not change when this runs, and this must fire once on mount (and on
    // "Försök igen").
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [attempt])

  return (
    <div className="flex flex-1 flex-col min-h-0">
      <div className="border-b-hairline px-5 py-3">
        <div className="relative">
          <MagnifyingGlassIcon className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Sök konversationer…"
            className="w-full rounded-lg pl-8 pr-7 py-1.5 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring bg-control shadow-raised"
          />
          {query.length > 0 && (
            <button
              type="button"
              onClick={() => setQuery('')}
              aria-label="Rensa sökning"
              className="absolute right-1 top-1/2 -translate-y-1/2 inline-flex h-8 w-8 items-center justify-center rounded-sm text-muted-foreground hover:bg-secondary/60 hover:text-foreground"
            >
              <XMarkIcon className="h-3 w-3" />
            </button>
          )}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto">
        {loading ? (
          <LateReveal aria-label="Hämtar konversationer" className="px-4 py-2">
            {[1, 2, 3, 4].map((i) => (
              <div key={i} className="flex h-11 items-center gap-3">
                <Skeleton className="h-3.5 w-48" />
                <Skeleton className="ml-auto h-3.5 w-12" />
              </div>
            ))}
          </LateReveal>
        ) : error ? (
          <div className="px-4">
            <LoadError title={error} onRetry={() => setAttempt((n) => n + 1)} />
          </div>
        ) : grouped.length === 0 ? (
          conversations.length === 0 ? (
            <div className="px-4">
              <EmptyState icon={ChatBubbleLeftIcon} title="Inga konversationer ännu." />
            </div>
          ) : (
            <div className="flex flex-wrap items-center gap-x-3 px-4 py-3 text-[13px] text-muted-foreground">
              <span>Inga träffar.</span>
              <Button variant="link" onClick={() => setQuery('')}>
                {tCommon('clear_search')}
              </Button>
            </div>
          )
        ) : (
          grouped.map(({ bucket, rows }) => (
            <section key={bucket} className="py-2">
              <p className="px-4 pb-1 text-xs text-muted-foreground">
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
                          className="w-full rounded-lg px-2 py-1 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring bg-control shadow-raised"
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
                              <p className="text-xs text-muted-foreground tabular-nums shrink-0">
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
                            className="flex h-8 w-8 items-center justify-center text-muted-foreground hover:text-foreground transition-colors"
                          >
                            {c.pinned ? (
                              <BookmarkSlashIcon className="h-3.5 w-3.5" />
                            ) : (
                              <BookmarkIcon className="h-3.5 w-3.5" />
                            )}
                          </button>
                          <button
                            type="button"
                            onClick={() => startEdit(c)}
                            title="Byt namn"
                            aria-label="Byt namn på konversation"
                            className="flex h-8 w-8 items-center justify-center text-muted-foreground hover:text-foreground transition-colors"
                          >
                            <PencilIcon className="h-3.5 w-3.5" />
                          </button>
                          <button
                            type="button"
                            onClick={() => void archive(c.id)}
                            title="Arkivera"
                            aria-label="Arkivera konversationen"
                            className="flex h-8 w-8 items-center justify-center text-muted-foreground hover:text-foreground transition-colors"
                          >
                            <ArchiveBoxIcon className="h-3.5 w-3.5" />
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
