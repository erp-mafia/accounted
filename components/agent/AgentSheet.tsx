'use client'

import { useEffect, useState } from 'react'
import { X, Expand, Shrink, PanelRightClose, Eraser, History, ChevronLeft, Loader2 } from 'lucide-react'
import AgentChat, { normalizeStoredMessages, type ChatMessage } from './AgentChat'
import AgentAvatar from './AgentAvatar'
import AgentSessionList from './AgentSessionList'
import SandboxAgentPreview from './SandboxAgentPreview'
import { useAgentSheet } from './AgentSheetProvider'
import { useCompanyOptional } from '@/contexts/CompanyContext'
import { cn } from '@/lib/utils'

// Undimmed non-modal side sheet: sits above the page on a hairline border +
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
  // Hidden (display:none) but still mounted so the conversation survives. The
  // provider keeps rendering this component; we just visually remove it.
  collapsed: boolean
  onCollapse: () => void
  onRestart: () => void
  onClose: () => void
}

interface LoadedConversation {
  id: string
  intentId: string
  contextRef: string | null
  title: string | null
  messages: ChatMessage[]
}

export default function AgentSheet({
  intentId,
  intentArgs,
  contextRef,
  seedUserMessage,
  collapsed,
  onCollapse,
  onRestart,
  onClose,
}: Props) {
  // Live conversation id from the active AgentChat (fresh sessions report it via
  // onConversationIdChange; resumed ones we set directly on select).
  const [conversationId, setConversationId] = useState<string | null>(null)
  // 'chat' shows the conversation; 'list' shows the session picker.
  const [view, setView] = useState<'chat' | 'list'>('chat')
  // A past conversation the user picked from the list, hydrated for resume. When
  // set, it replaces the intent-driven fresh chat.
  const [loaded, setLoaded] = useState<LoadedConversation | null>(null)
  const [loadingConversation, setLoadingConversation] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  // Enlarge the panel IN PLACE (no navigation): the user stays on the current
  // page (e.g. /bookkeeping) with a wider reading/verifying surface.
  const [expanded, setExpanded] = useState(false)
  const { identity } = useAgentSheet()
  const companyCtx = useCompanyOptional()
  const isSandbox = companyCtx?.isSandbox ?? false
  const agentName = identity.displayName?.trim() || null
  const sheetTitle = intentToTitle(intentId, agentName)
  const displayTitle = loaded ? (loaded.title ?? intentToTitle(loaded.intentId, agentName)) : sheetTitle
  const activeConversationId = loaded?.id ?? conversationId

  // Esc: back out of the session list first, otherwise close. Never while
  // collapsed (the sheet is hidden off-screen, so Esc belongs elsewhere).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (collapsed || e.key !== 'Escape') return
      if (view === 'list') setView('chat')
      else onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose, collapsed, view])

  // Move focus off the sheet before hiding it, so it never sits on a
  // display:none node (accessibility).
  const handleCollapse = () => {
    if (typeof document !== 'undefined') {
      ;(document.activeElement as HTMLElement | null)?.blur()
    }
    onCollapse()
  }

  // Resume a past conversation inline: fetch its messages, hydrate, and swap the
  // sheet back to the chat view. Picking the one already open just closes the
  // list (keeps its live in-memory state instead of re-hydrating it).
  async function handleSelectConversation(id: string) {
    if (id === activeConversationId) {
      setView('chat')
      return
    }
    setView('chat')
    setLoaded(null)
    setLoadingConversation(true)
    setLoadError(null)
    try {
      const res = await fetch(`/api/agent/conversations/${id}`)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const json = (await res.json()) as {
        data?: {
          conversation: {
            id: string
            intent_id: string
            context_ref: string | null
            title: string | null
          }
          messages: { role: string; content: unknown; hidden?: boolean | null }[]
        }
      }
      const data = json.data
      if (!data) throw new Error('missing data')
      setLoaded({
        id: data.conversation.id,
        intentId: data.conversation.intent_id,
        contextRef: data.conversation.context_ref,
        title: data.conversation.title,
        messages: normalizeStoredMessages(data.messages),
      })
      setConversationId(data.conversation.id)
    } catch {
      setLoadError('Kunde inte öppna konversationen.')
    } finally {
      setLoadingConversation(false)
    }
  }

  return (
    <div
      role="dialog"
      aria-label={displayTitle}
      // z-[60] sits above the mobile bottom nav (z-50) so on phones the sheet
      // covers the full screen including where the nav would otherwise show.
      // `hidden` (display:none) when collapsed keeps the component mounted (the
      // conversation state in AgentChat survives) while removing it from view
      // and layout entirely (no stray horizontal scroll from an off-screen box).
      className={cn(
        'fixed inset-y-0 right-0 z-[60] flex w-full flex-col border-l border-border bg-background shadow-lg transition-[max-width] duration-200 ease-out',
        collapsed && 'hidden',
        // Expanded grows the panel leftward over the page (still non-modal: the
        // page stays interactive); normal is the compact side sheet.
        expanded ? 'max-w-[min(100vw,1100px)]' : 'max-w-[480px]',
      )}
      style={{
        // iOS notch / Android cutout: the sheet top edge needs to clear the
        // status bar. Bottom is handled inside the form below.
        paddingTop: 'env(safe-area-inset-top, 0px)',
      }}
    >
      {view === 'list' ? (
        <header className="flex items-center gap-3 border-b border-border px-5 py-4">
          <button
            onClick={() => setView('chat')}
            className="h-9 w-9 -ml-1 inline-flex items-center justify-center rounded-md text-muted-foreground hover:bg-secondary hover:text-foreground transition-colors"
            aria-label="Tillbaka"
            title="Tillbaka"
          >
            <ChevronLeft className="h-4 w-4" />
          </button>
          <h2 className="font-display text-lg tracking-tight truncate">Konversationer</h2>
          <button
            onClick={onClose}
            className="ml-auto h-9 w-9 inline-flex items-center justify-center rounded-md text-muted-foreground hover:bg-secondary hover:text-foreground transition-colors"
            aria-label="Stäng"
            title="Avsluta sessionen"
          >
            <X className="h-4 w-4" />
          </button>
        </header>
      ) : (
        <header className="flex items-center gap-2 border-b border-border px-4 py-4">
          {!isSandbox && (
            <button
              onClick={() => setView('list')}
              className="h-9 w-9 inline-flex items-center justify-center rounded-md text-muted-foreground hover:bg-secondary hover:text-foreground transition-colors"
              aria-label="Tidigare konversationer"
              title="Tidigare konversationer"
            >
              <History className="h-4 w-4" />
            </button>
          )}
          <AgentAvatar avatarId={identity.avatarId} size="sm" alt={agentName ?? 'Assistent'} />
          <h2 className="font-display text-lg tracking-tight truncate">{displayTitle}</h2>
          <div className="ml-auto flex items-center gap-1">
            {/* Grow/shrink the panel in place: NEVER navigates away, so the
                user stays on the current page. Hidden on mobile where the sheet
                is already full-width (the toggle would be a no-op). */}
            {!isSandbox && (
              <button
                onClick={() => setExpanded((v) => !v)}
                className="hidden md:inline-flex h-9 w-9 items-center justify-center rounded-md text-muted-foreground hover:bg-secondary hover:text-foreground transition-colors"
                aria-label={expanded ? 'Förminska' : 'Förstora'}
                title={expanded ? 'Förminska' : 'Förstora'}
              >
                {expanded ? <Shrink className="h-4 w-4" /> : <Expand className="h-4 w-4" />}
              </button>
            )}
            {/* Labeled (not icon-only) so it isn't mistaken for close/minimize,
                and gated on an existing conversation so there's nothing to
                mis-click on a fresh, empty chat. */}
            {activeConversationId && !isSandbox && (
              <button
                onClick={onRestart}
                className="h-9 inline-flex items-center gap-2 rounded-md px-2 text-xs font-medium text-muted-foreground hover:bg-secondary hover:text-foreground transition-colors"
                aria-label="Rensa: börja en ny konversation"
                title="Rensa: börja en ny konversation"
              >
                <Eraser className="h-4 w-4" />
                Rensa
              </button>
            )}
            <button
              onClick={handleCollapse}
              className="h-9 w-9 inline-flex items-center justify-center rounded-md text-muted-foreground hover:bg-secondary hover:text-foreground transition-colors"
              aria-label="Minimera"
              title="Minimera: behåll sessionen"
            >
              <PanelRightClose className="h-4 w-4" />
            </button>
            <button
              onClick={onClose}
              className="h-9 w-9 inline-flex items-center justify-center rounded-md text-muted-foreground hover:bg-secondary hover:text-foreground transition-colors"
              aria-label="Stäng"
              title="Avsluta sessionen"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </header>
      )}

      {isSandbox ? (
        <SandboxAgentPreview agentName={agentName} />
      ) : view === 'list' ? (
        <AgentSessionList
          activeConversationId={activeConversationId}
          onSelect={handleSelectConversation}
        />
      ) : loadingConversation ? (
        <div className="flex flex-1 items-center justify-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" /> Öppnar konversation…
        </div>
      ) : loadError ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center text-sm">
          <p className="text-destructive">{loadError}</p>
          <button
            onClick={() => setView('list')}
            className="text-xs font-medium text-foreground hover:underline"
          >
            Tillbaka till konversationer
          </button>
        </div>
      ) : loaded ? (
        <AgentChat
          key={loaded.id}
          intentId={loaded.intentId}
          contextRef={loaded.contextRef ?? undefined}
          initialConversationId={loaded.id}
          initialMessages={loaded.messages}
          onConversationIdChange={(id) => setConversationId(id)}
        />
      ) : (
        <AgentChat
          intentId={intentId}
          intentArgs={intentArgs}
          contextRef={contextRef}
          seedUserMessage={seedUserMessage}
          onConversationIdChange={(id) => setConversationId(id)}
        />
      )}
    </div>
  )
}

function intentToTitle(intentId: string, agentName: string | null): string {
  switch (intentId) {
    case 'general.help':
      return agentName ? `Fråga ${agentName}` : 'Fråga din assistent'
    case 'transaction.categorization':
      return 'Hjälp med transaktion'
    case 'verifikation.draft':
      return 'Hjälp med verifikation'
    case 'invoice.draft':
      return 'Hjälp med faktura'
    case 'supplier_invoice.review':
      return 'Granska leverantörsfaktura'
    default:
      return agentName ? `Fråga ${agentName}` : 'Fråga din assistent'
  }
}
