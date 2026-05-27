'use client'

import { useEffect, useState } from 'react'
import { X, Expand } from 'lucide-react'
import Link from 'next/link'
import AgentChat from './AgentChat'
import AgentAvatar from './AgentAvatar'
import { useAgentSheet } from './AgentSheetProvider'

// Undimmed non-modal side sheet — sits above the page on a hairline border +
// shadow, but the page underneath stays fully interactive. Plan §3b.
//
// The sheet is a thin wrapper around AgentChat: it owns the title bar, close
// button, and "expand to /chat/[id]" affordance. All message rendering and
// streaming live in AgentChat so the full-page chat view can reuse them.

interface Props {
  intentId: string
  intentArgs?: Record<string, unknown>
  contextRef?: string
  seedUserMessage?: string
  onClose: () => void
}

export default function AgentSheet({
  intentId,
  intentArgs,
  contextRef,
  seedUserMessage,
  onClose,
}: Props) {
  const [conversationId, setConversationId] = useState<string | null>(null)
  const { identity } = useAgentSheet()
  const agentName = identity.displayName?.trim() || null
  const sheetTitle = intentToTitle(intentId, agentName)

  // Esc closes the sheet.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div
      role="dialog"
      aria-label={sheetTitle}
      // z-[60] sits above the mobile bottom nav (z-50) so on phones the sheet
      // covers the full screen including where the nav would otherwise show.
      className="fixed inset-y-0 right-0 z-[60] flex w-full max-w-[480px] flex-col border-l border-border bg-background shadow-lg"
      style={{
        // iOS notch / Android cutout — the sheet top edge needs to clear the
        // status bar. Bottom is handled inside the form below.
        paddingTop: 'env(safe-area-inset-top, 0px)',
      }}
    >
      <header className="flex items-center gap-3 border-b border-border px-5 py-4">
        <AgentAvatar avatarId={identity.avatarId} size="sm" alt={agentName ?? 'Assistent'} />
        <h2 className="font-display text-lg tracking-tight truncate">{sheetTitle}</h2>
        <div className="ml-auto flex items-center gap-1">
          {conversationId && (
            <Link
              href={`/chat/${conversationId}`}
              onClick={onClose}
              className="h-9 w-9 inline-flex items-center justify-center rounded-md text-muted-foreground hover:bg-secondary hover:text-foreground transition-colors"
              aria-label="Öppna i fullskärm"
              title="Öppna i fullskärm"
            >
              <Expand className="h-4 w-4" />
            </Link>
          )}
          <button
            onClick={onClose}
            className="h-9 w-9 inline-flex items-center justify-center rounded-md text-muted-foreground hover:bg-secondary hover:text-foreground transition-colors"
            aria-label="Stäng"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      </header>

      <AgentChat
        intentId={intentId}
        intentArgs={intentArgs}
        contextRef={contextRef}
        seedUserMessage={seedUserMessage}
        onConversationIdChange={(id) => setConversationId(id)}
      />
    </div>
  )
}

function intentToTitle(intentId: string, agentName: string | null): string {
  switch (intentId) {
    case 'general.help':
      return agentName ? `Fråga ${agentName}` : 'Fråga din assistent'
    case 'transaction.categorization':
      return 'Hjälp med transaktion'
    case 'invoice.draft':
      return 'Hjälp med faktura'
    case 'supplier_invoice.review':
      return 'Granska leverantörsfaktura'
    default:
      return agentName ? `Fråga ${agentName}` : 'Fråga din assistent'
  }
}
