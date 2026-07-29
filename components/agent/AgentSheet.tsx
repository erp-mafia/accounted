'use client'

import { useEffect, useRef, useState } from 'react'
import {
  X,
  Expand,
  Shrink,
  PanelRightClose,
  Eraser,
  History,
  ChevronLeft,
  Loader2,
} from 'lucide-react'
import AgentChat, {
  attachStagedOperations,
  normalizeStoredMessages,
  type ChatMessage,
} from './AgentChat'
import type { StoredStagedOperation } from '@/types'
import type { AgentStatusEvent } from './agent-status'
import ContextChip from './ContextChip'
import { intentLabel } from './conversation-display'
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
  // Publishes what the agent is doing to the one status channel, so the
  // floating trigger can say "arbetar" / "är klar" while the panel is hidden.
  onStatus?: (event: AgentStatusEvent) => void
  // How much width the panel is claiming from the page, or null while it
  // overlays. Docking is what makes the panel a second column instead of a
  // curtain over the thing being discussed.
  onDockWidthChange?: (px: number | null) => void
  onCollapse: () => void
  onRestart: () => void
  onClose: () => void
}

// The panel is max-w-[480px]; the page gives up that plus the frame's own
// 10px gutter, so the two panels float side by side on the frame with the
// same seam as everywhere else instead of butting their borders together.
const DOCKED_WIDTH = 490

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
  onStatus,
  onDockWidthChange,
  onCollapse,
  onRestart,
  onClose,
}: Props) {
  // Live conversation id from the active AgentChat (fresh sessions report it via
  // onConversationIdChange; resumed ones we set directly on select).
  // Drops the enter class once the slide has played, so re-expanding a
  // collapsed session is instant rather than sliding in again.
  const [entering, setEntering] = useState(true)
  useEffect(() => {
    const t = setTimeout(() => setEntering(false), 320)
    return () => clearTimeout(t)
  }, [])
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
  // Dock at the compact width only. Expanded is a deliberate focus mode: at
  // 1100px there is no page left to read beside it, so it goes back to
  // overlaying. Collapsed and mobile claim nothing (below md the panel is
  // full-width and the frame layout ignores the variable anyway).
  const dockWidth = collapsed || expanded ? null : DOCKED_WIDTH
  useEffect(() => {
    onDockWidthChange?.(dockWidth)
  }, [dockWidth, onDockWidthChange])
  useEffect(() => () => onDockWidthChange?.(null), [onDockWidthChange])

  const { identity } = useAgentSheet()
  const companyCtx = useCompanyOptional()
  const isSandbox = companyCtx?.isSandbox ?? false
  const agentName = identity.displayName?.trim() || null
  const sheetTitle = intentLabel(intentId, agentName)
  const displayTitle = loaded ? (loaded.title ?? intentLabel(loaded.intentId, agentName)) : sheetTitle
  const activeConversationId = loaded?.id ?? conversationId
  // A resumed thread's stored ref wins: it says what THAT conversation was
  // about, which is the whole reason to show this. Falls back to the ref the
  // panel was opened with for a thread that has not been persisted yet.
  const activeContextRef = loaded ? loaded.contextRef : (contextRef ?? null)
  const sheetRef = useRef<HTMLDivElement | null>(null)
  // Monotonic counter so a slow conversation fetch can't clobber a newer pick.
  const selectSeqRef = useRef(0)

  // Esc: back out of the session list first, otherwise close. Never while
  // collapsed (the sheet is hidden off-screen, so Esc belongs elsewhere).
  //
  // The sheet is deliberately non-modal, so this listener sits on window while
  // the rest of the page stays interactive: it must therefore only claim the
  // key when nothing nearer the user wants it. Closing the sheet discards the
  // whole in-memory conversation, so an Esc meant for a dropdown inside an
  // approval card, the command palette, or any dialog used to destroy the
  // session outright. Three guards, cheapest first:
  //   - defaultPrevented: a Radix popover/dialog that handled Esc marks it.
  //   - an open overlay anywhere on the page (Radix marks these on the body
  //     and on the overlay elements themselves) means the key isn't ours.
  //   - focus sitting outside the sheet means the user is working elsewhere.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (collapsed || e.key !== 'Escape') return
      if (e.defaultPrevented) return

      if (typeof document !== 'undefined') {
        // Match on data-state="open", not on the popper wrapper itself: a
        // force-mounted popper stays in the DOM while closed, and keying off
        // the wrapper alone would then block Escape for the rest of the session.
        const overlayOpen = document.querySelector(
          '[data-radix-popper-content-wrapper] [data-state="open"], [role="dialog"][data-state="open"], [role="alertdialog"][data-state="open"], [role="listbox"][data-state="open"], [data-radix-menu-content][data-state="open"], [data-radix-select-content][data-state="open"]',
        )
        if (overlayOpen) return

        const active = document.activeElement
        if (active && sheetRef.current && !sheetRef.current.contains(active)) return
      }

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
    // Sequence token: picking A (slow) then B (fast) used to end with A's
    // response overwriting B, leaving the user typing into a conversation they
    // did not choose. Only the newest selection may write state.
    const seq = ++selectSeqRef.current
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
          staged_operations?: StoredStagedOperation[]
        }
      }
      const data = json.data
      if (!data) throw new Error('missing data')
      if (seq !== selectSeqRef.current) return
      setLoaded({
        id: data.conversation.id,
        intentId: data.conversation.intent_id,
        contextRef: data.conversation.context_ref,
        title: data.conversation.title,
        messages: attachStagedOperations(
          normalizeStoredMessages(data.messages),
          data.staged_operations ?? [],
        ),
      })
      setConversationId(data.conversation.id)
    } catch {
      if (seq === selectSeqRef.current) setLoadError('Kunde inte öppna konversationen.')
    } finally {
      if (seq === selectSeqRef.current) setLoadingConversation(false)
    }
  }

  return (
    <div
      ref={sheetRef}
      role="dialog"
      aria-label={displayTitle}
      // z-[60] sits above the mobile bottom nav (z-50) so on phones the sheet
      // covers the full screen including where the nav would otherwise show.
      // `hidden` (display:none) when collapsed keeps the component mounted (the
      // conversation state in AgentChat survives) while removing it from view
      // and layout entirely (no stray horizontal scroll from an off-screen box).
      className={cn(
        'fixed inset-y-0 right-0 z-[60] flex w-full flex-col border-l border-border bg-background shadow-lg transition-[max-width] duration-300 ease-[cubic-bezier(0.32,0.72,0,1)]',
        // Arrive along the same edge, on the same curve and duration, as the
        // page panel that animates its margin to make room (layout.tsx). Gated
        // on first mount only: the panel stays mounted while collapsed, and
        // display:none -> visible would otherwise replay the slide every time
        // the user re-expands the same session.
        entering && 'animate-in slide-in-from-right-full fade-in-0',
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
          <div className="min-w-0 flex-1">
            <h2 className="font-display text-lg leading-tight tracking-tight truncate">
              {displayTitle}
            </h2>
            {/* What this conversation is anchored to. context_ref has been
                stored since the first intents shipped and read by nothing, so a
                thread resumed days later gave no clue which invoice it was
                about. Matters more now the panel sits BESIDE the page. */}
            <ContextChip contextRef={activeContextRef} className="mt-0.5" />
          </div>
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
          onStatus={onStatus}
        />
      ) : (
        <AgentChat
          intentId={intentId}
          intentArgs={intentArgs}
          contextRef={contextRef}
          seedUserMessage={seedUserMessage}
          onConversationIdChange={(id) => setConversationId(id)}
          onStatus={onStatus}
        />
      )}
    </div>
  )
}


