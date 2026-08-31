'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import {
  X,
  Expand,
  Shrink,
  PanelRight,
  PanelRightClose,
  PictureInPicture2,
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
import AskConsole, { type AskConsoleMessage } from './AskConsole'
import { CHAT_INTENT_ID } from '@/lib/agent/ask/persist'
import type { AgentPanelFloatRect, StoredStagedOperation } from '@/types'
import {
  DOCK_GUTTER,
  DOCK_WIDTH_MAX,
  DOCK_WIDTH_MIN,
  clampDockWidth,
  clampFloatRect,
  containFloatRect,
  defaultFloatRect,
  expandedDockWidth,
  resizeFloatRect,
  type ResizeEdges,
} from '@/lib/agent-panel/geometry'
import type { AgentStatusEvent } from './agent-status'
import ContextChip from './ContextChip'
import { intentLabel } from './conversation-display'
import AgentAvatar from './AgentAvatar'
import AgentSessionList from './AgentSessionList'
import SandboxAgentPreview from './SandboxAgentPreview'
import { useAgentSheet } from './AgentSheetProvider'
import { useCompanyOptional } from '@/contexts/CompanyContext'
import {
  clearAgentSheetSession,
  writeAgentSheetSession,
} from '@/lib/agent-panel/session-restore'
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
  // Open this existing thread on mount (a reload restore, see the provider)
  // instead of starting a fresh one on the intent.
  resumeConversationId?: string
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

// Geometry (docked width, expanded width, floating rect) lives in
// lib/agent-panel/geometry and is persisted per user via the provider
// (ui_state.agent_panel). The drag paths below write styles imperatively and
// commit ONE preference update on release, so a long conversation never
// re-renders at pointer-move frequency while the user drags.

function useViewportSize() {
  const [size, setSize] = useState(() =>
    typeof window === 'undefined'
      ? { w: 1440, h: 900 }
      : { w: window.innerWidth, h: window.innerHeight },
  )
  useEffect(() => {
    let frame = 0
    const onResize = () => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() =>
        setSize({ w: window.innerWidth, h: window.innerHeight }),
      )
    }
    window.addEventListener('resize', onResize)
    return () => {
      cancelAnimationFrame(frame)
      window.removeEventListener('resize', onResize)
    }
  }, [])
  return size
}

/** Matches Tailwind's md breakpoint: floating mode exists on desktop only. */
function useMinWidthMd() {
  const [md, setMd] = useState(
    () => typeof window !== 'undefined' && window.matchMedia('(min-width: 768px)').matches,
  )
  useEffect(() => {
    const mq = window.matchMedia('(min-width: 768px)')
    const onChange = () => setMd(mq.matches)
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [])
  return md
}

/** Current sidebar column width (--nav-w, set inline on #dash-shell). */
function readNavWidth(): number {
  if (typeof document === 'undefined') return 248
  const shell = document.getElementById('dash-shell')
  const px = shell ? parseInt(getComputedStyle(shell).getPropertyValue('--nav-w'), 10) : NaN
  return Number.isFinite(px) ? px : 248
}

/**
 * Reactive sidebar width: the nav toggle rewrites #dash-shell's inline
 * --nav-w, which fires no resize event, so observe the style attribute
 * instead of forcing a computed-style read on every render.
 */
function useNavWidth(): number {
  const [w, setW] = useState(readNavWidth)
  useEffect(() => {
    const shell = document.getElementById('dash-shell')
    if (!shell) return
    const update = () => setW(readNavWidth())
    update()
    const mo = new MutationObserver(update)
    mo.observe(shell, { attributes: true, attributeFilter: ['style'] })
    return () => mo.disconnect()
  }, [])
  return w
}

/**
 * Minimal pointer drag: capture on the handle, report cursor deltas, call
 * onEnd exactly once on release or cancel. Deliberately not a library:
 * three call sites, no gesture semantics beyond delta tracking.
 */
function startPointerDrag(
  e: React.PointerEvent,
  onMove: (dx: number, dy: number) => void,
  onEnd: () => void,
) {
  if (e.button !== 0) return
  e.preventDefault()
  const target = e.currentTarget as HTMLElement
  const startX = e.clientX
  const startY = e.clientY
  try {
    target.setPointerCapture(e.pointerId)
  } catch {
    // Capture is best-effort: without it the drag still works while the
    // cursor stays over the handle.
  }
  // Listeners live on window, NOT on the handle: if capture fails (or the
  // handle unmounts mid-drag), a pointerup outside the 8px strip would never
  // reach the handle and onEnd would never run, leaving the drag's global
  // side effects (transition suppression, data-agent-resizing) stuck for the
  // rest of the session. lostpointercapture covers the mid-drag-unmount case.
  // Window listeners see every active pointer, so a second touch or a pen
  // must not move this drag or end it early: only the initiating pointer id
  // counts. lostpointercapture carries no useful pointerId in all engines,
  // so it stays unfiltered; it can only fire for the captured pointer anyway.
  const pointerId = e.pointerId
  const move = (ev: PointerEvent) => {
    if (ev.pointerId !== pointerId) return
    onMove(ev.clientX - startX, ev.clientY - startY)
  }
  const end = () => {
    window.removeEventListener('pointermove', move)
    window.removeEventListener('pointerup', up)
    window.removeEventListener('pointercancel', up)
    target.removeEventListener('lostpointercapture', end)
    onEnd()
  }
  const up = (ev: PointerEvent) => {
    if (ev.pointerId !== pointerId) return
    end()
  }
  window.addEventListener('pointermove', move)
  window.addEventListener('pointerup', up)
  window.addEventListener('pointercancel', up)
  target.addEventListener('lostpointercapture', end)
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
  resumeConversationId,
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
  // Starts true on a restore so the first frame is the spinner, not a fresh
  // chat on the intent: a fresh tool-loop chat fires its first turn on mount
  // and would create a stray conversation before the restore replaced it.
  const [loadingConversation, setLoadingConversation] = useState(!!resumeConversationId)
  const [loadError, setLoadError] = useState<string | null>(null)
  // Enlarge the panel IN PLACE (no navigation): the user stays on the current
  // page (e.g. /bookkeeping) with a wider reading/verifying surface. Transient
  // focus mode, deliberately not persisted (unlike the dock width below).
  const [expanded, setExpanded] = useState(false)

  const { identity, panelPrefs, updatePanelPrefs } = useAgentSheet()
  const viewport = useViewportSize()
  const isDesktop = useMinWidthMd()
  const navW = useNavWidth()

  // Resolved geometry for this render. Floating exists on desktop only: below
  // md the sheet stays the full-screen mobile surface whatever the persisted
  // mode says. Everything re-clamps against the live viewport, so preferences
  // saved on another screen can never strand the panel off-screen.
  const floating = panelPrefs.mode === 'floating' && isDesktop
  const dockW = clampDockWidth(panelPrefs.dockWidth, viewport.w, navW)
  const expandedW = expandedDockWidth(viewport.w, navW)
  const floatRect = floating
    ? clampFloatRect(
        panelPrefs.float ?? defaultFloatRect(viewport.w, viewport.h),
        viewport.w,
        viewport.h,
      )
    : null

  // Open/resize-time validation of the persisted float rect: a rect saved at
  // the viewport edge (or on a larger monitor) passes clampFloatRect but
  // renders as a 48px sliver, so snap it fully on screen and persist the
  // corrected position. panelPrefs.float is read through a ref, NOT the deps:
  // putting it in the deps would re-run this on every drag commit and snap
  // the window back mid-session, killing the deliberate hang-off-the-edge
  // allowance of the live drag path. The effect fires on sheet mount (every
  // fresh open remounts, keyed by the provider) and on viewport resize only.
  const floatPrefRef = useRef(panelPrefs.float)
  useEffect(() => {
    floatPrefRef.current = panelPrefs.float
  }, [panelPrefs.float])
  useEffect(() => {
    if (!floating) return
    const rect = floatPrefRef.current
    if (!rect) return
    const contained = containFloatRect(rect, viewport.w, viewport.h)
    if (
      contained.x !== rect.x ||
      contained.y !== rect.y ||
      contained.w !== rect.w ||
      contained.h !== rect.h
    ) {
      updatePanelPrefs({ float: contained })
    }
  }, [floating, viewport.w, viewport.h, updatePanelPrefs])

  // Reserve page margin while docked, compact AND expanded: both reflow the
  // page beside the panel instead of covering it (the original complaint).
  // Floating and collapsed claim nothing; below md the margin variable is
  // inert (the frame layout gates it on md:).
  const reservedWidth = collapsed || floating ? null : (expanded ? expandedW : dockW) + DOCK_GUTTER
  useEffect(() => {
    onDockWidthChange?.(reservedWidth)
  }, [reservedWidth, onDockWidthChange])
  useEffect(() => () => onDockWidthChange?.(null), [onDockWidthChange])
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

  // ── Docked width drag ─────────────────────────────────────────────────
  // Live frames write the sheet's max-width and the page-margin variable
  // directly; data-agent-resizing suppresses the 300ms margin transition
  // (globals.css) so the page reflow tracks the cursor 1:1. One preference
  // commit on release.
  const pendingDockW = useRef<number | null>(null)
  function onDockResizeStart(e: React.PointerEvent) {
    const el = sheetRef.current
    if (!el) return
    const base = expanded ? expandedW : dockW
    document.documentElement.setAttribute('data-agent-resizing', '')
    el.style.transition = 'none'
    startPointerDrag(
      e,
      (dx) => {
        // The handle sits on the panel's left edge: dragging left widens.
        // navW from the closure: the sidebar cannot change mid-drag, and this
        // avoids a computed-style read on every pointer frame.
        const w = clampDockWidth(base - dx, window.innerWidth, navW)
        pendingDockW.current = w
        el.style.maxWidth = `${w}px`
        document.documentElement.style.setProperty('--agent-dock-w', `${w + DOCK_GUTTER}px`)
      },
      () => {
        document.documentElement.removeAttribute('data-agent-resizing')
        el.style.transition = ''
        if (pendingDockW.current !== null) {
          // Keep the final width as the inline override too: if the committed
          // value equals the previous preference, React sees identical style
          // props and writes nothing, so the DOM must already be correct.
          el.style.maxWidth = `${pendingDockW.current}px`
          // Dragging from focus mode lands on a custom width: that IS leaving
          // focus mode, so fold the result back into the normal dock.
          setExpanded(false)
          updatePanelPrefs({ dockWidth: pendingDockW.current })
          pendingDockW.current = null
        }
      },
    )
  }

  function onDockResizeKey(e: React.KeyboardEvent) {
    const step = 24
    // Step from the width the user actually sees: in focus mode that is
    // expandedW, and the first keypress folds it into a custom dock width.
    const base = expanded ? expandedW : dockW
    let next: number | null = null
    if (e.key === 'ArrowLeft') next = base + step
    if (e.key === 'ArrowRight') next = base - step
    if (next === null) return
    e.preventDefault()
    setExpanded(false)
    updatePanelPrefs({ dockWidth: clampDockWidth(next, viewport.w, navW) })
  }

  // ── Floating move / resize ────────────────────────────────────────────
  const pendingFloat = useRef<AgentPanelFloatRect | null>(null)
  const commitFloatRect = () => {
    if (pendingFloat.current !== null) {
      updatePanelPrefs({ float: pendingFloat.current })
      pendingFloat.current = null
    }
  }

  function onFloatMoveStart(e: React.PointerEvent) {
    const el = sheetRef.current
    if (!el || !floatRect) return
    // Header buttons keep their clicks; only bare header surface drags.
    if ((e.target as Element).closest('button, a, input, textarea, select, [role="button"]')) {
      return
    }
    const base = floatRect
    startPointerDrag(
      e,
      (dx, dy) => {
        const r = clampFloatRect(
          { ...base, x: base.x + dx, y: base.y + dy },
          window.innerWidth,
          window.innerHeight,
        )
        pendingFloat.current = r
        el.style.left = `${r.x}px`
        el.style.top = `${r.y}px`
      },
      commitFloatRect,
    )
  }

  function onFloatResizeStart(e: React.PointerEvent, edges: ResizeEdges) {
    const el = sheetRef.current
    if (!el || !floatRect) return
    const base = floatRect
    startPointerDrag(
      e,
      (dx, dy) => {
        const r = resizeFloatRect(base, dx, dy, edges, window.innerWidth, window.innerHeight)
        pendingFloat.current = r
        el.style.left = `${r.x}px`
        el.style.top = `${r.y}px`
        el.style.width = `${r.w}px`
        el.style.height = `${r.h}px`
      },
      commitFloatRect,
    )
  }

  function toggleFloating() {
    if (floating) {
      updatePanelPrefs({ mode: 'docked' })
    } else {
      updatePanelPrefs({
        mode: 'floating',
        float: panelPrefs.float ?? defaultFloatRect(viewport.w, viewport.h),
      })
    }
  }

  // Open a past conversation inline: fetch its messages and hydrate. Shared by
  // the session list and the reload restore below.
  const loadConversation = useCallback(async (id: string) => {
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
      if (seq === selectSeqRef.current) {
        setLoadError('Kunde inte öppna konversationen.')
        // A thread that no longer opens must not be retried on every reload.
        clearAgentSheetSession()
      }
    } finally {
      if (seq === selectSeqRef.current) setLoadingConversation(false)
    }
  }, [])

  // Reload restore: the provider remounts the sheet on the thread this tab
  // had open, and it is loaded here the same way a picked one is.
  useEffect(() => {
    if (resumeConversationId) void loadConversation(resumeConversationId)
  }, [resumeConversationId, loadConversation])

  // Remember the open thread for this tab so a reload brings it back (see
  // lib/agent-panel/session-restore). Nothing to remember until the thread
  // has an id: a fresh chat that never sent anything simply does not return.
  const activeIntentId = loaded?.intentId ?? intentId
  useEffect(() => {
    if (!activeConversationId) return
    writeAgentSheetSession({
      conversationId: activeConversationId,
      intentId: activeIntentId,
      contextRef: activeContextRef,
      collapsed,
    })
  }, [activeConversationId, activeIntentId, activeContextRef, collapsed])

  // Resume a past conversation from the list and swap the sheet back to the
  // chat view. Picking the one already open just closes the list (keeps its
  // live in-memory state instead of re-hydrating it).
  function handleSelectConversation(id: string) {
    setView('chat')
    if (id === activeConversationId) return
    void loadConversation(id)
  }

  return (
    <div
      ref={sheetRef}
      role="dialog"
      aria-label={displayTitle}
      // Interactions here must never dismiss an open (non-modal) dialog:
      // DialogContent treats data-agent-ui as inside the dialog.
      data-agent-ui=""
      // z-[60] sits above the mobile bottom nav (z-50) so on phones the sheet
      // covers the full screen including where the nav would otherwise show.
      // `hidden` (display:none) when collapsed keeps the component mounted (the
      // conversation state in AgentChat survives) while removing it from view
      // and layout entirely (no stray horizontal scroll from an off-screen box).
      className={cn(
        'fixed z-[60] flex flex-col bg-background',
        floating
          ? // Undocked window: free rect from inline styles; overlay chrome
            // (rounded, hairline border, shadow) like every other overlay.
            'overflow-hidden rounded-lg border border-border shadow-lg'
          : 'inset-y-0 right-0 w-full border-l border-border shadow-lg transition-[max-width] duration-300 ease-[cubic-bezier(0.32,0.72,0,1)]',
        // Arrive along the same edge, on the same curve and duration, as the
        // page panel that animates its margin to make room (layout.tsx). Gated
        // on first mount only: the panel stays mounted while collapsed, and
        // display:none -> visible would otherwise replay the slide every time
        // the user re-expands the same session. A floating window has no edge
        // to arrive from, so it just fades in.
        entering && (floating ? 'animate-in fade-in-0' : 'animate-in slide-in-from-right-full fade-in-0'),
        collapsed && 'hidden',
      )}
      style={
        floating && floatRect
          ? { left: floatRect.x, top: floatRect.y, width: floatRect.w, height: floatRect.h }
          : {
              // Width is the persisted dock preference; expanded (focus mode)
              // grows as far as the viewport allows while the page keeps a
              // readable column beside it.
              maxWidth: expanded ? expandedW : dockW,
              // iOS notch / Android cutout: the sheet top edge needs to clear
              // the status bar. Bottom is handled inside the form below.
              paddingTop: 'env(safe-area-inset-top, 0px)',
            }
      }
    >
      {/* Docked: left-edge width handle (desktop only; mobile is full-width). */}
      {!floating && (
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label="Ändra panelens bredd"
          aria-valuenow={expanded ? expandedW : dockW}
          aria-valuemin={DOCK_WIDTH_MIN}
          aria-valuemax={clampDockWidth(DOCK_WIDTH_MAX, viewport.w, navW)}
          tabIndex={0}
          onPointerDown={onDockResizeStart}
          onKeyDown={onDockResizeKey}
          className="group absolute inset-y-0 left-0 z-10 hidden w-2 cursor-col-resize touch-none focus-visible:outline-none md:block"
        >
          <div className="mx-auto h-full w-px bg-transparent transition-colors duration-150 group-hover:bg-border group-active:bg-border group-focus-visible:bg-ring" />
        </div>
      )}
      {/* Undocked: edge + corner resize handles. Pointer-only affordances
          (aria-hidden): the keyboard path is dock -> arrow keys on the
          separator above. */}
      {floating && (
        <>
          <div
            onPointerDown={(e) => onFloatResizeStart(e, { left: true })}
            className="absolute inset-y-0 left-0 z-10 w-2 cursor-ew-resize touch-none"
            aria-hidden="true"
          />
          <div
            onPointerDown={(e) => onFloatResizeStart(e, { right: true })}
            className="absolute inset-y-0 right-0 z-10 w-2 cursor-ew-resize touch-none"
            aria-hidden="true"
          />
          <div
            onPointerDown={(e) => onFloatResizeStart(e, { bottom: true })}
            className="absolute inset-x-0 bottom-0 z-10 h-2 cursor-ns-resize touch-none"
            aria-hidden="true"
          />
          <div
            onPointerDown={(e) => onFloatResizeStart(e, { left: true, bottom: true })}
            className="absolute bottom-0 left-0 z-10 h-4 w-4 cursor-nesw-resize touch-none"
            aria-hidden="true"
          />
          <div
            onPointerDown={(e) => onFloatResizeStart(e, { right: true, bottom: true })}
            className="absolute bottom-0 right-0 z-10 h-4 w-4 cursor-nwse-resize touch-none"
            aria-hidden="true"
          />
        </>
      )}
      {view === 'list' ? (
        <header
          onPointerDown={floating ? onFloatMoveStart : undefined}
          className={cn(
            'flex items-center gap-3 border-b border-border px-5 py-4',
            floating && 'cursor-move touch-none select-none',
          )}
        >
          <button
            onClick={() => setView('chat')}
            className="h-9 w-9 -ml-1 inline-flex items-center justify-center rounded-sm text-muted-foreground hover:bg-secondary hover:text-foreground transition-colors"
            aria-label="Tillbaka"
            title="Tillbaka"
          >
            <ChevronLeft className="h-4 w-4" />
          </button>
          <h2 className="font-display text-lg tracking-tight truncate">Konversationer</h2>
          <button
            onClick={onClose}
            className="ml-auto h-9 w-9 inline-flex items-center justify-center rounded-sm text-muted-foreground hover:bg-secondary hover:text-foreground transition-colors"
            aria-label="Stäng"
            title="Avsluta sessionen"
          >
            <X className="h-4 w-4" />
          </button>
        </header>
      ) : (
        <header
          // In floating mode the header doubles as the window's drag surface
          // (buttons excluded inside onFloatMoveStart).
          onPointerDown={floating ? onFloatMoveStart : undefined}
          className={cn(
            'flex items-center gap-2 border-b border-border px-4 py-4',
            floating && 'cursor-move touch-none select-none',
          )}
        >
          {!isSandbox && (
            <button
              onClick={() => setView('list')}
              className="h-9 w-9 inline-flex items-center justify-center rounded-sm text-muted-foreground hover:bg-secondary hover:text-foreground transition-colors"
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
            {/* Undock into a floating window the user can move and resize
                freely / dock it back to the right edge. Hidden on mobile
                where the sheet is always the full-screen surface. */}
            {!isSandbox && (
              <button
                onClick={toggleFloating}
                className="hidden md:inline-flex h-9 w-9 items-center justify-center rounded-sm text-muted-foreground hover:bg-secondary hover:text-foreground transition-colors"
                aria-label={floating ? 'Docka mot högerkanten' : 'Frigör panelen'}
                title={
                  floating
                    ? 'Docka mot högerkanten'
                    : 'Frigör panelen: flytta och ändra storlek fritt'
                }
              >
                {floating ? (
                  <PanelRight className="h-4 w-4" />
                ) : (
                  <PictureInPicture2 className="h-4 w-4" />
                )}
              </button>
            )}
            {/* Grow/shrink the panel in place: NEVER navigates away, so the
                user stays on the current page. Hidden on mobile where the sheet
                is already full-width (the toggle would be a no-op), and while
                floating (the window resizes by its edges instead). */}
            {!isSandbox && !floating && (
              <button
                onClick={() => setExpanded((v) => !v)}
                className="hidden md:inline-flex h-9 w-9 items-center justify-center rounded-sm text-muted-foreground hover:bg-secondary hover:text-foreground transition-colors"
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
                className="h-9 inline-flex items-center gap-2 rounded-sm px-2 text-xs font-medium text-muted-foreground hover:bg-secondary hover:text-foreground transition-colors"
                aria-label="Rensa: börja en ny konversation"
                title="Rensa: börja en ny konversation"
              >
                <Eraser className="h-4 w-4" />
                Rensa
              </button>
            )}
            <button
              onClick={handleCollapse}
              className="h-9 w-9 inline-flex items-center justify-center rounded-sm text-muted-foreground hover:bg-secondary hover:text-foreground transition-colors"
              aria-label="Minimera"
              title="Minimera: behåll sessionen"
            >
              <PanelRightClose className="h-4 w-4" />
            </button>
            <button
              onClick={onClose}
              className="h-9 w-9 inline-flex items-center justify-center rounded-sm text-muted-foreground hover:bg-secondary hover:text-foreground transition-colors"
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
        loaded.intentId === CHAT_INTENT_ID ? (
          // Resumed free-form thread: the single-call console (runs on a local
          // model). Its turns are text-only, so drop any empty/tool rows.
          <AskConsole
            key={loaded.id}
            initialConversationId={loaded.id}
            initialMessages={loaded.messages
              .filter((m) => m.text.trim().length > 0)
              .map((m): AskConsoleMessage => ({ role: m.role, text: m.text }))}
            contextRef={loaded.contextRef}
          />
        ) : (
          <AgentChat
            key={loaded.id}
            intentId={loaded.intentId}
            contextRef={loaded.contextRef ?? undefined}
            initialConversationId={loaded.id}
            initialMessages={loaded.messages}
            onConversationIdChange={(id) => setConversationId(id)}
            onStatus={onStatus}
          />
        )
      ) : intentId === CHAT_INTENT_ID ? (
        // Fresh free-form ask (the FAB's "Fråga min assistent" catch-all).
        <AskConsole
          seedUserMessage={seedUserMessage}
          initialConversationId={null}
          contextRef={contextRef ?? null}
          onConversationCreated={(id) => setConversationId(id)}
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


