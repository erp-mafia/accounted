'use client'

import { useMemo } from 'react'
import Link from 'next/link'
import { ArrowLeft } from 'lucide-react'
import AgentChat, { attachStagedOperations, normalizeStoredMessages } from './AgentChat'
import AskConsole, { type AskConsoleMessage } from './AskConsole'
import { CHAT_INTENT_ID } from '@/lib/agent/ask/persist'
import type { StoredStagedOperation } from '@/types'
import AgentAvatar from './AgentAvatar'
import ContextChip from './ContextChip'
import SandboxAgentPreview from './SandboxAgentPreview'
import { useAgentSheet } from './AgentSheetProvider'
import { useCompanyOptional } from '@/contexts/CompanyContext'

interface Props {
  conversationId: string
  intentId: string
  contextRef: string | null
  title: string
  rawMessages: { role: string; content: unknown; hidden?: boolean }[]
  // Proposals this conversation staged that are still awaiting an answer, so
  // the approval card reappears on resume instead of the proposal silently
  // waiting out its expiry in Granskning.
  stagedOperations?: StoredStagedOperation[]
}

// Full-page conversation view. Wraps AgentChat with a header that shows the
// title (or intent label). AgentChat handles the streaming + input + render.
export default function ChatConversationView({
  conversationId,
  intentId,
  contextRef,
  title,
  rawMessages,
  stagedOperations,
}: Props) {
  const initialMessages = useMemo(
    () => attachStagedOperations(normalizeStoredMessages(rawMessages), stagedOperations ?? []),
    [rawMessages, stagedOperations],
  )
  // general.help runs on the single-call console; it never stages operations,
  // so the thread is text-only. Empty turns (a historical pure-tool_use row
  // from the old runtime) are dropped rather than rendered as blank rows.
  const isSingleCall = intentId === CHAT_INTENT_ID
  const consoleMessages = useMemo<AskConsoleMessage[]>(
    () =>
      normalizeStoredMessages(rawMessages)
        .filter((m) => m.text.trim().length > 0)
        .map((m) => ({ role: m.role, text: m.text })),
    [rawMessages],
  )
  const { identity } = useAgentSheet()
  const companyCtx = useCompanyOptional()
  const isSandbox = companyCtx?.isSandbox ?? false
  const agentName = identity.displayName?.trim() || null

  return (
    <>
      <header className="flex items-center gap-3 border-b border-border px-5 py-4 shrink-0">
        {/* Mobile-only back-to-list arrow. On desktop the sidebar is always
            visible so a back button would be redundant. */}
        <Link
          href="/chat"
          className="md:hidden inline-flex h-9 w-9 items-center justify-center rounded-sm text-muted-foreground hover:bg-secondary hover:text-foreground transition-colors -ml-1"
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
          <h1 className="font-display text-lg leading-tight tracking-tight truncate">{title}</h1>
          {/* Was printing context_ref raw, so the subtitle read
              "invoice:5f3a-9c21-...": a database identifier, shown to an
              accountant, under the title of their own conversation. */}
          <ContextChip contextRef={contextRef} className="mt-0.5" />
        </div>
      </header>

      <div className="flex-1 min-h-0 flex flex-col">
        {isSandbox ? (
          <SandboxAgentPreview agentName={agentName} />
        ) : isSingleCall ? (
          <AskConsole
            initialConversationId={conversationId}
            initialMessages={consoleMessages}
            contextRef={contextRef}
            scrollerClassName="px-6 py-8"
          />
        ) : (
          <AgentChat
            intentId={intentId}
            contextRef={contextRef ?? undefined}
            initialConversationId={conversationId}
            initialMessages={initialMessages}
            scrollerClassName="px-6 py-8"
          />
        )}
      </div>
    </>
  )
}
