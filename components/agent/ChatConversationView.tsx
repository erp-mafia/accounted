'use client'

import { useMemo } from 'react'
import Link from 'next/link'
import { ArrowLeft } from 'lucide-react'
import AgentChat, { normalizeStoredMessages } from './AgentChat'
import AgentAvatar from './AgentAvatar'
import { useAgentSheet } from './AgentSheetProvider'

interface Props {
  conversationId: string
  intentId: string
  contextRef: string | null
  title: string
  rawMessages: { role: string; content: unknown; hidden?: boolean }[]
}

// Full-page conversation view. Wraps AgentChat with a header that shows the
// title (or intent label). AgentChat handles the streaming + input + render.
export default function ChatConversationView({
  conversationId,
  intentId,
  contextRef,
  title,
  rawMessages,
}: Props) {
  const initialMessages = useMemo(() => normalizeStoredMessages(rawMessages), [rawMessages])
  const { identity } = useAgentSheet()

  return (
    <>
      <header className="flex items-center gap-3 border-b border-border px-5 py-4 shrink-0">
        {/* Mobile-only back-to-list arrow. On desktop the sidebar is always
            visible so a back button would be redundant. */}
        <Link
          href="/chat"
          className="md:hidden inline-flex h-9 w-9 items-center justify-center rounded-md text-muted-foreground hover:bg-secondary hover:text-foreground transition-colors -ml-1"
          aria-label="Tillbaka till konversationer"
        >
          <ArrowLeft className="h-4 w-4" />
        </Link>
        <AgentAvatar
          avatarId={identity.avatarId}
          size="sm"
          alt={identity.displayName ?? 'Assistent'}
        />
        <div className="min-w-0">
          <h1 className="font-display text-lg tracking-tight truncate">{title}</h1>
          {contextRef && (
            <p className="text-xs text-muted-foreground truncate">{contextRef}</p>
          )}
        </div>
      </header>

      <div className="flex-1 min-h-0">
        <AgentChat
          intentId={intentId}
          contextRef={contextRef ?? undefined}
          initialConversationId={conversationId}
          initialMessages={initialMessages}
          scrollerClassName="px-6 py-8"
        />
      </div>
    </>
  )
}
