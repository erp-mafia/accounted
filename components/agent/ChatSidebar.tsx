'use client'

import { useEffect, useMemo, useRef, useState, useTransition } from 'react'
import Link from 'next/link'
import { usePathname, useRouter } from 'next/navigation'
import { Pin, PinOff, Archive, Pencil, Search, X, PanelLeftOpen, PanelLeftClose } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useAgentSheet } from './AgentSheetProvider'
import AgentAvatar from './AgentAvatar'
import {
  type ConversationRow,
  BUCKET_LABELS,
  relativeTime,
  intentLabel,
  groupConversations,
} from './conversation-display'

interface Props {
  initialConversations: ConversationRow[]
}

export default function ChatSidebar({ initialConversations }: Props) {
  const router = useRouter()
  const pathname = usePathname()
  const { openAgentSheet, identity } = useAgentSheet()
  const agentName = identity.displayName?.trim() || null
  const [conversations, setConversations] = useState<ConversationRow[]>(initialConversations)
  const [query, setQuery] = useState('')
  const [, startTransition] = useTransition()
  // Collapsed by default; persisted across reloads so power users keep
  // their preference. Hidden behind a thin rail when collapsed so the
  // conversation pane runs nearly edge-to-edge.
  const [collapsed, setCollapsed] = useState(true)
  useEffect(() => {
    const stored = localStorage.getItem('Accounted:chat-sidebar-collapsed')
    if (stored === 'false') setCollapsed(false)
  }, [])
  const toggleCollapsed = () => {
    setCollapsed(c => {
      const next = !c
      try { localStorage.setItem('Accounted:chat-sidebar-collapsed', next ? 'true' : 'false') } catch {}
      return next
    })
  }

  const activeId = pathname?.startsWith('/chat/') ? pathname.split('/')[2] : null
  const isConversationOpen = !!activeId

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return conversations
    return conversations.filter((c) => {
      return (
        (c.title ?? '').toLowerCase().includes(q) ||
        (c.last_message_preview ?? '').toLowerCase().includes(q) ||
        (c.context_ref ?? '').toLowerCase().includes(q) ||
        c.intent_id.toLowerCase().includes(q)
      )
    })
  }, [conversations, query])

  // Group filtered into ordered buckets, preserving the sort order already
  // applied server-side (pinned first, then last_message_at desc).
  const grouped = useMemo(() => groupConversations(filtered), [filtered])

  async function togglePin(id: string, current: boolean) {
    setConversations((prev) =>
      prev.map((c) => (c.id === id ? { ...c, pinned: !current } : c)),
    )
    await fetch(`/api/agent/conversations/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pinned: !current }),
    })
  }

  async function archive(id: string) {
    setConversations((prev) => prev.filter((c) => c.id !== id))
    await fetch(`/api/agent/conversations/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ archived: true }),
    })
    if (activeId === id) startTransition(() => router.push('/chat'))
  }

  // Inline rename of a conversation's title (PATCH /api/agent/conversations/[id]).
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editValue, setEditValue] = useState('')
  // Set by Esc so the blur that fires when the input unmounts doesn't save.
  const cancelRef = useRef(false)

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
    setConversations((prev) => prev.map((c) => (c.id === id ? { ...c, title } : c)))
    await fetch(`/api/agent/conversations/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title }),
    })
  }

  // Collapsed rail (desktop only). Mobile keeps the existing behavior where
  // the sidebar IS the page when no conversation is open, so the rail is
  // hidden below md. On desktop the rail keeps a thin column with toggle
  // + new-chat buttons so the conversation pane runs near-edge-to-edge.
  const railAside = collapsed ? (
    <aside
      className="hidden md:flex md:w-12 flex-col items-center border-r border-border bg-card/40 shrink-0 py-3 gap-2"
      aria-label="Konversationer (hopfälld)"
    >
      <button
        type="button"
        onClick={toggleCollapsed}
        aria-label="Visa konversationer"
        title="Visa konversationer"
        className="inline-flex h-9 w-9 items-center justify-center rounded-md text-muted-foreground hover:text-foreground hover:bg-secondary/60 transition-colors"
      >
        <PanelLeftOpen className="h-4 w-4" />
      </button>
      <div className="h-px w-6 bg-border" />
      <button
        type="button"
        onClick={() => openAgentSheet({ intentId: 'general.help' })}
        aria-label="Ny konversation"
        title="Ny konversation"
        className="inline-flex h-9 w-9 items-center justify-center rounded-md text-muted-foreground hover:text-foreground hover:bg-secondary/60 transition-colors text-lg"
      >
        +
      </button>
    </aside>
  ) : null

  return (
    <>
    {railAside}
    <aside
      className={cn(
        'flex-col border-r border-border bg-card/40 shrink-0',
        // Mobile: sidebar IS the page when no conversation; hidden otherwise.
        isConversationOpen ? 'hidden' : 'flex w-full',
        // Desktop: hidden if collapsed (rail takes its place); else 320px.
        collapsed ? 'md:hidden' : 'md:flex md:w-80',
      )}
    >
      <div className="border-b border-border px-5 py-4 space-y-3">
        <div className="flex items-center gap-2">
          <AgentAvatar avatarId={identity.avatarId} size="sm" alt={agentName ?? 'Assistent'} />
          <div className="flex-1 min-w-0">
            <h2 className="font-display text-base tracking-tight truncate">
              {agentName ?? 'Din assistent'}
            </h2>
            <p className="text-[11px] text-muted-foreground">Konversationer</p>
          </div>
          <button
            onClick={toggleCollapsed}
            aria-label="Dölj konversationer"
            title="Dölj konversationer"
            className="hidden md:inline-flex h-8 w-8 items-center justify-center rounded text-muted-foreground hover:text-foreground hover:bg-secondary/60 transition-colors"
          >
            <PanelLeftClose className="h-4 w-4" />
          </button>
          <button
            onClick={() => openAgentSheet({ intentId: 'general.help' })}
            className="text-xs uppercase tracking-wider text-muted-foreground hover:text-foreground transition-colors"
          >
            + Ny
          </button>
        </div>
        <div className="relative">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Sök…"
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
        {grouped.length === 0 ? (
          <div className="p-6 text-sm text-muted-foreground">
            {conversations.length === 0
              ? 'Inga konversationer ännu. Klicka på + Ny för att börja.'
              : 'Inga träffar.'}
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
                      <Link
                        href={`/chat/${c.id}`}
                        className={cn(
                          'group flex items-start gap-2 px-4 py-2 hover:bg-secondary/60 transition-colors border-l-2',
                          activeId === c.id
                            ? 'bg-secondary/50 border-foreground'
                            : 'border-transparent',
                        )}
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
                        {/* Always-visible action icons. Touch-friendly, no
                            hover-only invisibility on mobile. Laid out
                            horizontally so three icons don't stack and inflate
                            the row height. */}
                        <div className="flex items-center gap-1 shrink-0 -mr-1">
                          <button
                            onClick={(e) => {
                              e.preventDefault()
                              e.stopPropagation()
                              startEdit(c)
                            }}
                            title="Byt namn"
                            aria-label="Byt namn på konversation"
                            className="inline-flex h-8 w-8 items-center justify-center rounded text-muted-foreground/50 hover:text-foreground hover:bg-secondary transition-colors"
                          >
                            <Pencil className="h-3 w-3" />
                          </button>
                          <button
                            onClick={(e) => {
                              e.preventDefault()
                              e.stopPropagation()
                              void togglePin(c.id, c.pinned)
                            }}
                            title={c.pinned ? 'Avfäst' : 'Fäst'}
                            aria-label={c.pinned ? 'Avfäst konversation' : 'Fäst konversation'}
                            className={cn(
                              'inline-flex h-8 w-8 items-center justify-center rounded transition-colors',
                              c.pinned
                                ? 'text-foreground'
                                : 'text-muted-foreground/50 hover:text-foreground hover:bg-secondary',
                            )}
                          >
                            {c.pinned ? (
                              <Pin className="h-3 w-3" fill="currentColor" />
                            ) : (
                              <PinOff className="h-3 w-3" />
                            )}
                          </button>
                          <button
                            onClick={(e) => {
                              e.preventDefault()
                              e.stopPropagation()
                              void archive(c.id)
                            }}
                            title="Arkivera"
                            aria-label="Arkivera konversation"
                            className="inline-flex h-8 w-8 items-center justify-center rounded text-muted-foreground/50 hover:text-foreground hover:bg-secondary transition-colors"
                          >
                            <Archive className="h-3 w-3" />
                          </button>
                        </div>
                      </Link>
                    )}
                  </li>
                ))}
              </ul>
            </section>
          ))
        )}
      </div>
    </aside>
    </>
  )
}
