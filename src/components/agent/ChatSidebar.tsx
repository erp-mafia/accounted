'use client'

import { useEffect, useState, useTransition } from 'react'
import Link from 'next/link'
import { useLocale, useTranslations } from 'next-intl'
import { usePathname, useRouter } from 'next/navigation'
import { Pin, PinOff, Archive, Pencil, Search, X, PanelLeftOpen, PanelLeftClose } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useAgentSheet } from './AgentSheetProvider'
import AgentAvatar from './AgentAvatar'
import {
  type ConversationRow,
  bucketLabel,
  relativeTime,
  intentLabel,
} from './conversation-display'
import { useConversationList } from './use-conversation-list'

interface Props {
  initialConversations: ConversationRow[]
}

export default function ChatSidebar({ initialConversations }: Props) {
  const t = useTranslations('chat_sidebar')
  const tDisplay = useTranslations('agent_conversation_display')
  const locale = useLocale()
  const router = useRouter()
  const pathname = usePathname()
  const { openAgentSheet, identity } = useAgentSheet()
  const agentName = identity.displayName?.trim() || null
  // State + all three mutations live in the shared hook so this surface and the
  // in-sheet list cannot drift apart again. Pin/archive/rename here used to be
  // fire-and-forget with no rollback.
  const {
    conversations,
    query,
    setQuery,
    grouped,
    togglePin,
    archive: archiveConversation,
    editingId,
    editValue,
    setEditValue,
    startEdit,
    cancelEdit,
    commitEdit,
  } = useConversationList(initialConversations)
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


  async function archive(id: string) {
    const removed = await archiveConversation(id)
    if (removed && activeId === id) startTransition(() => router.push('/chat'))
  }

  // Collapsed rail (desktop only). Mobile keeps the existing behavior where
  // the sidebar IS the page when no conversation is open, so the rail is
  // hidden below md. On desktop the rail keeps a thin column with toggle
  // + new-chat buttons so the conversation pane runs near-edge-to-edge.
  const railAside = collapsed ? (
    <aside
      className="hidden md:flex md:w-12 flex-col items-center border-r border-border bg-card/40 shrink-0 py-3 gap-2"
      aria-label={t('collapsed_aria')}
    >
      <button
        type="button"
        onClick={toggleCollapsed}
        aria-label={t('show_conversations')}
        title={t('show_conversations')}
        className="inline-flex h-9 w-9 items-center justify-center rounded-sm text-muted-foreground hover:text-foreground hover:bg-secondary/60 transition-colors"
      >
        <PanelLeftOpen className="h-4 w-4" />
      </button>
      <div className="h-px w-6 bg-border" />
      <button
        type="button"
        onClick={() => openAgentSheet({ intentId: 'general.help' })}
        aria-label={t('new_conversation')}
        title={t('new_conversation')}
        className="inline-flex h-9 w-9 items-center justify-center rounded-sm text-muted-foreground hover:text-foreground hover:bg-secondary/60 transition-colors text-lg"
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
          <AgentAvatar avatarId={identity.avatarId} size="sm" alt={agentName ?? t('assistant')} />
          <div className="flex-1 min-w-0">
            <h2 className="font-display text-base tracking-tight truncate">
              {agentName ?? t('your_assistant')}
            </h2>
            <p className="text-[11px] text-muted-foreground">{t('conversations')}</p>
          </div>
          <button
            onClick={toggleCollapsed}
            aria-label={t('hide_conversations')}
            title={t('hide_conversations')}
            className="hidden md:inline-flex h-8 w-8 items-center justify-center rounded-sm text-muted-foreground hover:text-foreground hover:bg-secondary/60 transition-colors"
          >
            <PanelLeftClose className="h-4 w-4" />
          </button>
          <button
            onClick={() => openAgentSheet({ intentId: 'general.help' })}
            className="text-xs uppercase tracking-wider text-muted-foreground hover:text-foreground transition-colors"
          >
            {t('new_short')}
          </button>
        </div>
        <div className="relative">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t('search_placeholder')}
            className="w-full rounded-lg border border-border bg-background pl-8 pr-7 py-1.5 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
          {query.length > 0 && (
            <button
              type="button"
              onClick={() => setQuery('')}
              aria-label={t('clear_search')}
              className="absolute right-1 top-1/2 -translate-y-1/2 inline-flex h-8 w-8 items-center justify-center rounded-sm text-muted-foreground hover:bg-secondary/60 hover:text-foreground"
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
              ? t('empty')
              : t('no_matches')}
          </div>
        ) : (
          grouped.map(({ bucket, rows }) => (
            <section key={bucket} className="py-2">
              <p className="px-4 pb-1 text-[11px] uppercase tracking-wider text-muted-foreground">
                {bucketLabel(bucket, tDisplay)}
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
                          placeholder={t('rename_placeholder')}
                          maxLength={200}
                          aria-label={t('rename_aria')}
                          className="w-full rounded-lg border border-border bg-background px-2 py-1 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
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
                              {c.title ?? intentLabel(c.intent_id, tDisplay)}
                            </p>
                            <p className="text-[11px] text-muted-foreground tabular-nums shrink-0">
                              {relativeTime(c.last_message_at ?? c.created_at, tDisplay, locale)}
                            </p>
                          </div>
                          <p className="text-xs text-muted-foreground line-clamp-1 mt-0.5">
                            {c.last_message_preview ?? intentLabel(c.intent_id, tDisplay)}
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
                            title={t('rename')}
                            aria-label={t('rename_conversation')}
                            className="inline-flex h-8 w-8 items-center justify-center rounded-sm text-muted-foreground/50 hover:text-foreground hover:bg-secondary/60 transition-colors"
                          >
                            <Pencil className="h-3 w-3" />
                          </button>
                          <button
                            onClick={(e) => {
                              e.preventDefault()
                              e.stopPropagation()
                              void togglePin(c.id, c.pinned)
                            }}
                            title={c.pinned ? t('unpin') : t('pin')}
                            aria-label={c.pinned ? t('unpin_conversation') : t('pin_conversation')}
                            className={cn(
                              'inline-flex h-8 w-8 items-center justify-center rounded-sm transition-colors',
                              c.pinned
                                ? 'text-foreground'
                                : 'text-muted-foreground/50 hover:text-foreground hover:bg-secondary/60',
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
                            title={t('archive')}
                            aria-label={t('archive_conversation')}
                            className="inline-flex h-8 w-8 items-center justify-center rounded-sm text-muted-foreground/50 hover:text-foreground hover:bg-secondary/60 transition-colors"
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
