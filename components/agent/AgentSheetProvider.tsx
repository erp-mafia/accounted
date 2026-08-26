'use client'

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from 'react'
import dynamic from 'next/dynamic'
import type { AgentPanelState } from '@/types'
import {
  resolveAgentPanelPrefs,
  serializeAgentPanelPrefs,
  type ResolvedAgentPanelPrefs,
} from '@/lib/agent-panel/geometry'
import { persistUiState } from '@/lib/ui-state/client'
import {
  clearAgentSheetSession,
  readAgentSheetSession,
} from '@/lib/agent-panel/session-restore'
import {
  INITIAL_AGENT_STATUS,
  reduceAgentStatus,
  type AgentStatus,
  type AgentStatusEvent,
} from './agent-status'
import { Skeleton } from '@/components/ui/skeleton'

// The sheet is a lazy chunk, and it used to have no loading state at all: a
// click on the launcher produced NOTHING until the chunk arrived, then the
// whole panel appeared at once. Two fixes: a skeleton in the same geometry so
// the surface is there on the first frame, and a prefetch once the page is
// idle so the chunk is usually already loaded before anyone clicks.
const AgentSheet = dynamic(() => import('./AgentSheet'), {
  loading: () => <AgentSheetSkeleton />,
})

function AgentSheetSkeleton() {
  return (
    <div
      aria-hidden="true"
      className="fixed inset-y-0 right-0 z-[60] flex w-full flex-col border-l border-border bg-background shadow-lg"
      style={{
        // Tracks the user's persisted dock width (set by the provider below)
        // so the skeleton has the same geometry as the sheet it stands in for.
        maxWidth: 'var(--agent-panel-w, 480px)',
        paddingTop: 'env(safe-area-inset-top, 0px)',
      }}
    >
      <div className="flex items-center gap-2 border-b border-border px-4 py-4">
        <Skeleton className="h-8 w-8 shrink-0 rounded-full" />
        <Skeleton className="h-4 w-32" />
      </div>
    </div>
  )
}

/**
 * Serialize intent args into the sheet's remount key.
 *
 * The key used to be intent + contextRef + seed only, but some callers pass a
 * CONSTANT contextRef with varying args: bulk-book always uses 'inbox:bulk' and
 * carries the selected item ids. Selecting A+B, collapsing, then selecting C+D
 * produced the same key, so the sheet did not remount and the earlier
 * conversation reopened while the user believed C+D were being booked.
 *
 * Key order so the same selection reached by different routes stays one session.
 */
// Fallback identity for args that cannot be serialized (cycles, non-JSON
// values). A timestamp would be wrong twice over: two different objects created
// in the same millisecond would collide, and the same object would get a new
// key on every render tick, remounting the sheet under the user mid-session.
// A WeakMap gives each object one stable id for as long as it exists.
const argsFallbackIds = new WeakMap<object, string>()
let argsFallbackSeq = 0

function stableArgsKey(args?: Record<string, unknown>): string {
  if (!args) return ''
  try {
    const keys = Object.keys(args).sort()
    return JSON.stringify(keys.map((k) => [k, args[k]]))
  } catch {
    let id = argsFallbackIds.get(args)
    if (!id) {
      id = `unserializable:${++argsFallbackSeq}`
      argsFallbackIds.set(args, id)
    }
    return id
  }
}

/** Warm the sheet chunk when the browser is idle, never on the critical path. */
function useSheetPrefetch() {
  useEffect(() => {
    const warm = () => {
      // Swallow a failed prefetch: the real import on click will surface any
      // genuine problem, and warming must never produce an unhandled rejection.
      void import('./AgentSheet').catch(() => {})
    }
    const w = window as Window & {
      requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number
      cancelIdleCallback?: (id: number) => void
    }
    if (typeof w.requestIdleCallback === 'function') {
      // A busy page can stay non-idle indefinitely, so cap the wait: the point
      // is to have the chunk ready before the first click, not to hold out for
      // a quiet moment that may never arrive.
      const id = w.requestIdleCallback(warm, { timeout: 2000 })
      return () => w.cancelIdleCallback?.(id)
    }
    const t = setTimeout(warm, 2000)
    return () => clearTimeout(t)
  }, [])
}

export interface AgentIdentity {
  displayName: string | null
  avatarId: string | null
  // True only after the user has completed Phase B verification in
  // /onboarding/agent. Consumers (AgentTrigger, page-level Sparkle
  // buttons) should hide themselves when this is false so the FAB
  // doesn't pop up before the agent build flow has run.
  isVerified: boolean
}

// Provider exposes a single imperative function: openAgentSheet({...}). Any
// client component (top-nav button, transaction row "Fråga om" button, etc.)
// calls it to bring the sheet up with a specific intent + capture args.
//
// The sheet itself manages its own message list, streaming state, and
// dismissal. The provider just owns "what is open" and re-opens or replaces
// the panel when called again.

export interface OpenAgentSheetArgs {
  intentId: string
  // Intent-specific args passed to the server's intent.capture(), e.g.
  // { transaction_id: '...' } for transaction.categorization.
  intentArgs?: Record<string, unknown>
  // Optional ref persisted on agent_conversations.context_ref so the UI can
  // surface a back-pointer ("om transaktion 12 mar / 1 240 kr") later.
  contextRef?: string
  // Pre-populated first user message. When set, the chat skips the intent's
  // promptTemplate and sends this verbatim instead. Used by /chat empty-state
  // suggestion chips to give the user a one-click starting prompt.
  seedUserMessage?: string
  // Reopen an existing thread instead of starting one. Set by the provider
  // itself when it restores the panel after a page reload (see
  // lib/agent-panel/session-restore); the sheet loads the thread on mount
  // exactly as if it had been picked from "Tidigare konversationer".
  resumeConversationId?: string
}

interface AgentSheetContextValue {
  openAgentSheet: (args: OpenAgentSheetArgs) => void
  closeAgentSheet: () => void
  // Collapse hides the sheet WITHOUT unmounting it, so the in-memory
  // conversation (messages, streaming, pending approval cards) survives: the
  // floating trigger re-expands the same session. Distinct from close, which
  // ends the session entirely.
  collapseAgentSheet: () => void
  expandAgentSheet: () => void
  // Discard the current thread and start a fresh conversation on the same
  // intent (the header "Ny konversation" control). Implemented by remounting
  // the sheet via a nonce in its key.
  restartAgentSheet: () => void
  // True while a session exists (open or collapsed).
  isOpen: boolean
  // True while a session exists but is minimized off-screen.
  collapsed: boolean
  // What the assistant is doing, for surfaces outside the panel (today the
  // floating trigger). See agent-status.ts: one channel, so a durable
  // background run can publish to it later without a second one.
  status: AgentStatus
  publishAgentStatus: (event: AgentStatusEvent) => void
  // Width in px the docked panel is claiming from the page, or null when it is
  // overlaying instead. Set by the panel, read by the frame layout.
  setDockWidth: (px: number | null) => void
  // Panel geometry preferences (docked width, floating rect, active mode).
  // Owned here rather than in the sheet so they survive sheet remounts
  // (intent changes bump the sheet's key) and persist across sessions via
  // user_preferences.ui_state.agent_panel.
  panelPrefs: ResolvedAgentPanelPrefs
  updatePanelPrefs: (patch: Partial<ResolvedAgentPanelPrefs>) => void
  // Agent name + avatar: set once from the server-loaded agent_profile
  // and exposed through context so the trigger / chat headers can render
  // them without their own fetches. Null when the user hasn't verified a
  // profile yet (free tier or pre-onboarding).
  identity: AgentIdentity
}

const AgentSheetContext = createContext<AgentSheetContextValue | null>(null)

interface AgentSheetProviderProps {
  children: React.ReactNode
  identity?: AgentIdentity
  // Server-seeded ui_state.agent_panel, so the panel opens at the user's
  // persisted size/mode without a first-paint jump.
  initialPanelPrefs?: AgentPanelState
}

export function AgentSheetProvider({
  children,
  identity,
  initialPanelPrefs,
}: AgentSheetProviderProps) {
  useSheetPrefetch()
  const [activeArgs, setActiveArgs] = useState<OpenAgentSheetArgs | null>(null)
  // Collapsed = session alive but hidden. Kept separate from activeArgs so
  // collapsing never unmounts AgentChat (which would wipe the conversation).
  const [collapsed, setCollapsed] = useState(false)
  // Bumped by restartAgentSheet to force a fresh AgentChat mount (a new thread)
  // on the same intent, without closing the sheet.
  const [restartNonce, setRestartNonce] = useState(0)
  const [status, publishAgentStatus] = useReducer(reduceAgentStatus, INITIAL_AGENT_STATUS)
  const [dockWidth, setDockWidth] = useState<number | null>(null)

  // Geometry preferences. The ref mirrors the state so updatePanelPrefs can
  // merge and persist from event handlers without a stale closure (drag
  // commits fire from listeners installed at drag start).
  const [panelPrefs, setPanelPrefs] = useState<ResolvedAgentPanelPrefs>(() =>
    resolveAgentPanelPrefs(initialPanelPrefs),
  )
  const panelPrefsRef = useRef(panelPrefs)
  // Trailing debounce on the POST only: local state stays immediate, but key
  // auto-repeat on the resize handle (one updatePanelPrefs per repeat) must
  // not become one read-merge-write against user_preferences per repeat.
  const persistTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const updatePanelPrefs = useCallback((patch: Partial<ResolvedAgentPanelPrefs>) => {
    const next = { ...panelPrefsRef.current, ...patch }
    panelPrefsRef.current = next
    setPanelPrefs(next)
    // Fire-and-forget: cosmetic preference, a lost write self-corrects on the
    // next change.
    if (persistTimerRef.current) clearTimeout(persistTimerRef.current)
    persistTimerRef.current = setTimeout(() => {
      // Null before writing: a fired timer is no longer pending, and the
      // unmount flush below must not replay this (possibly stale) value.
      persistTimerRef.current = null
      persistUiState({ agent_panel: serializeAgentPanelPrefs(panelPrefsRef.current) })
    }, 300)
  }, [])
  useEffect(
    () => () => {
      // Flush on unmount so a pending debounced write is not lost.
      if (persistTimerRef.current) {
        clearTimeout(persistTimerRef.current)
        persistUiState({ agent_panel: serializeAgentPanelPrefs(panelPrefsRef.current) })
      }
    },
    [],
  )

  // The lazy sheet's loading skeleton renders before the sheet can report any
  // geometry, so the persisted dock width is published as a CSS variable for
  // it (and only it) to read.
  useEffect(() => {
    document.documentElement.style.setProperty('--agent-panel-w', `${panelPrefs.dockWidth}px`)
  }, [panelPrefs.dockWidth])

  // Visibility drives whether a finished turn is news or not, so it is derived
  // from the session state rather than reported by the panel: closing counts as
  // hidden just like collapsing, and a panel that never opened is neither.
  const panelVisible = activeArgs !== null && !collapsed
  useEffect(() => {
    publishAgentStatus({ type: 'visibility', visible: panelVisible })
  }, [panelVisible])

  // Dock the panel into the frame instead of over it: the page panel gives up
  // its right margin so the content the user is asking about stays readable
  // beside the answer. Written as a CSS variable rather than a class on <main>
  // because the frame layout is a server component; globals.css seeds the
  // default so the first paint is not a jump.
  useEffect(() => {
    const root = document.documentElement
    if (dockWidth === null) {
      root.style.removeProperty('--agent-dock-w')
      return
    }
    root.style.setProperty('--agent-dock-w', `${dockWidth}px`)
    return () => {
      root.style.removeProperty('--agent-dock-w')
    }
  }, [dockWidth])

  // Bring back the thread this tab had open before a full page reload. The
  // panel's state is React-only, so the deploy prompt's "Ladda om" (or any
  // refresh) used to close it and drop the thread from view; the user then
  // had to find it again under "Tidigare konversationer". The sheet records
  // the open thread per tab (sessionStorage), and this reopens it on mount.
  // Only on mount: client-side navigation keeps the provider, and a session
  // the user closed has already been cleared from storage.
  useEffect(() => {
    const stored = readAgentSheetSession()
    if (!stored) return
    // sessionStorage is client-only: reading it in the state initializer would
    // render the panel on the client but not on the server (hydration
    // mismatch), so it has to be an effect that sets state once.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setActiveArgs({
      intentId: stored.intentId,
      contextRef: stored.contextRef ?? undefined,
      resumeConversationId: stored.conversationId,
    })
    setCollapsed(stored.collapsed)
  }, [])

  const openAgentSheet = useCallback((args: OpenAgentSheetArgs) => {
    setActiveArgs(args)
    setCollapsed(false)
  }, [])

  const closeAgentSheet = useCallback(() => {
    setActiveArgs(null)
    setCollapsed(false)
    setDockWidth(null)
    // Close ends the session: a reload after this must not bring it back.
    clearAgentSheetSession()
    publishAgentStatus({ type: 'reset' })
  }, [])

  const collapseAgentSheet = useCallback(() => setCollapsed(true), [])
  const expandAgentSheet = useCallback(() => setCollapsed(false), [])
  const restartAgentSheet = useCallback(() => {
    // Discarding the thread: forget it for reload purposes too, so the old
    // one does not reappear while the new one has no id yet, and drop any
    // restore id from the args, or the remount would reopen that thread
    // instead of starting a fresh one.
    clearAgentSheetSession()
    setActiveArgs((args) =>
      args?.resumeConversationId ? { ...args, resumeConversationId: undefined } : args,
    )
    setRestartNonce((n) => n + 1)
    setCollapsed(false)
  }, [])

  const resolvedIdentity = useMemo<AgentIdentity>(
    () => identity ?? { displayName: null, avatarId: null, isVerified: false },
    [identity],
  )

  const value = useMemo<AgentSheetContextValue>(
    () => ({
      openAgentSheet,
      closeAgentSheet,
      collapseAgentSheet,
      expandAgentSheet,
      restartAgentSheet,
      isOpen: activeArgs !== null,
      collapsed,
      status,
      publishAgentStatus,
      setDockWidth,
      panelPrefs,
      updatePanelPrefs,
      identity: resolvedIdentity,
    }),
    [
      openAgentSheet,
      closeAgentSheet,
      collapseAgentSheet,
      expandAgentSheet,
      restartAgentSheet,
      activeArgs,
      collapsed,
      status,
      panelPrefs,
      updatePanelPrefs,
      resolvedIdentity,
    ],
  )

  return (
    <AgentSheetContext.Provider value={value}>
      {children}
      {activeArgs && (
        <AgentSheet
          key={`${activeArgs.intentId}:${activeArgs.contextRef ?? ''}:${stableArgsKey(activeArgs.intentArgs)}:${activeArgs.seedUserMessage ?? ''}:${activeArgs.resumeConversationId ?? ''}:${restartNonce}`}
          intentId={activeArgs.intentId}
          intentArgs={activeArgs.intentArgs}
          contextRef={activeArgs.contextRef}
          seedUserMessage={activeArgs.seedUserMessage}
          resumeConversationId={activeArgs.resumeConversationId}
          collapsed={collapsed}
          onStatus={publishAgentStatus}
          onDockWidthChange={setDockWidth}
          onCollapse={collapseAgentSheet}
          onRestart={restartAgentSheet}
          onClose={closeAgentSheet}
        />
      )}
    </AgentSheetContext.Provider>
  )
}

export function useAgentSheet(): AgentSheetContextValue {
  const ctx = useContext(AgentSheetContext)
  if (!ctx) {
    throw new Error('useAgentSheet must be used inside <AgentSheetProvider>')
  }
  return ctx
}
