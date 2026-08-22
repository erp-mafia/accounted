'use client'

import { useEffect, useLayoutEffect, useRef, useState, useCallback } from 'react'
import Link from 'next/link'
import {
  Send,
  Square,
  RotateCw,
  BookmarkCheck,
  BookmarkX,
  Check,
  Brain,
  Copy,
  ThumbsUp,
  ThumbsDown,
  ArrowDown,
} from 'lucide-react'
import dynamic from 'next/dynamic'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { useCapability } from '@/contexts/CompanyContext'
import { CAPABILITY } from '@/lib/entitlements/keys'
import { UpgradeNote } from '@/components/billing/UpgradeNote'
import ApprovalCard from './ApprovalCard'
import { getErrorMessage as getUserErrorMessage } from '@/lib/errors/get-error-message'
import type { StoredStagedOperation } from '@/types'
import type { AgentStatusEvent } from './agent-status'
import { sendFeedback, type FeedbackSentiment } from './feedback-client'
import { Skeleton } from '@/components/ui/skeleton'

// New messages arrive one at a time, so they enter on the short bubble curve.
// The whole loaded history must NOT: `.animate-slide-up` is the 500ms
// once-per-navigation page-entry animation, so resuming a 20-message thread
// used to fire 20 simultaneous 500ms slides.
const MESSAGE_ENTER_CLASS =
  'animate-in fade-in-0 slide-in-from-bottom-2 duration-200 ease-[cubic-bezier(0.23,1,0.32,1)]'

// Markdown parser loads separately from the chat surface: react-markdown +
// remark-gfm pull in the whole unified/remark tree.
//
// It used to render `null` while the chunk loaded. That is invisible while a
// reply streams (nobody reads that fast) but very visible on RESUME: every
// assistant bubble in a hydrated conversation was an empty bordered card until
// the chunk landed, then all the text appeared at once and reflowed the thread.
// Two changes: the chunk is prefetched as soon as any chat surface mounts, and
// until it resolves the raw text renders in place of nothing, so a bubble is
// never blank.
const MarkdownMessage = dynamic(() => import('./MarkdownMessage'), {
  ssr: false,
  loading: () => null,
})

// Module-scoped so the chunk is fetched once per page load and every later
// chat surface (sheet, /chat, a resumed conversation) renders markdown on its
// first frame instead of falling back to plain text again.
let markdownReady = false
let markdownPromise: Promise<unknown> | null = null

/** Start the markdown chunk before anything needs to render with it. */
function prefetchMarkdown(): Promise<unknown> {
  if (!markdownPromise) {
    markdownPromise = import('./MarkdownMessage')
      .then((mod) => {
        markdownReady = true
        return mod
      })
      .catch(() => {
        // A chunk can 404 after a deploy, or the network can blip. Clear the
        // cached promise so a later surface retries, instead of every bubble
        // for the rest of the session being stuck on the plain-text fallback,
        // and swallow the rejection so it is not an unhandled one.
        markdownPromise = null
        return null
      })
  }
  return markdownPromise
}

/** True once the markdown chunk is usable; triggers the fetch if it isn't. */
function useMarkdownReady(): boolean {
  const [ready, setReady] = useState(markdownReady)
  useEffect(() => {
    if (ready) return
    let alive = true
    void prefetchMarkdown().then(() => {
      if (alive) setReady(true)
    })
    return () => {
      alive = false
    }
  }, [ready])
  return ready
}

// Reusable chat surface: used both inside the right-hand AgentSheet and on
// the full-page /chat route. Owns:
//   * Message state (rendered list)
//   * NDJSON stream consumer for /api/agent/invoke
//   * Markdown rendering + tool-call badges + approval cards
//   * Input form
//
// What it does NOT own:
//   * Sheet chrome (title bar, close button): wrapper's job
//   * Page layout / sidebar: wrapper's job
//
// Two modes:
//   * Fresh start (initialMessages empty, initialConversationId null):
//     mount fires the first POST /api/agent/invoke with intent_args, which
//     creates a new conversation_id and streams the intent's templated first
//     turn back.
//   * Resume (initialMessages + initialConversationId supplied): hydrate from
//     DB rows, skip the first-turn template, just await user input.

export interface ChatMessage {
  role: 'user' | 'assistant'
  text: string
  // Extended-thinking reasoning, streamed token-by-token via reasoning_delta.
  // Shown in a collapsible "Tänkte…" block. Stream-time only: not hydrated.
  reasoning?: string
  // Tool-use chips. `completed` flips true when the matching `tool_result`
  // event arrives so the UI can swap the pulsing dot for a static check
  // instead of yanking the chip out from under the user. Hydrated messages
  // are always completed (they would not have been persisted otherwise).
  toolCalls?: { tool_use_id: string; name: string; completed?: boolean }[]
  staged?: StagedOperation[]
  memoryEvents?: MemoryEvent[]
  // Set when the user pressed Stop mid-stream: the partial text stays, with a
  // marker so a truncated answer is never mistaken for a complete one.
  interrupted?: boolean
}

// Emitted by run-turn.ts after a successful remember_fact / forget_fact call
// so the chat surface can render a quiet "Sparat som minne: …" chip below the
// assistant message. Stream-time only: not hydrated on /chat resume.
interface MemoryEvent {
  tool_use_id: string
  action: 'remembered' | 'forgotten'
  memory_id: string
  memory_kind?: 'fact' | 'preference' | 'pattern' | 'correction'
  content?: string
}

interface StagedOperation {
  tool_use_id: string
  operation_id?: string
  risk_level: 'low' | 'medium' | 'high'
  message: string
  // The originating tool name (e.g. 'gnubok_categorize_transaction'), as
  // carried by live staged_operation stream events.
  tool_name?: string
  // The stored pending_operations.operation_type (e.g.
  // 'categorize_transaction'), set on hydrated cards. ApprovalCard prefers
  // this for preview dispatch and derives it from tool_name otherwise.
  operation_type?: string
  // pending_operations.params (the staging tool's input): some previews
  // read it (attach_document's DocumentViewButton needs params.document_id).
  params?: Record<string, unknown>
  // The structured operation preview from the staged envelope. Shape varies
  // by tool; ApprovalCard's renderers do the type-narrowing.
  preview?: unknown
  // Period state at the operation's effective date. Surfaced as a small
  // badge: open|locked|closed.
  period_status?: {
    period_id?: string | null
    status: 'open' | 'locked' | 'closed'
    lock_date?: string | null
  }
}

export interface AgentChatProps {
  intentId: string
  intentArgs?: Record<string, unknown>
  contextRef?: string
  initialMessages?: ChatMessage[]
  initialConversationId?: string | null
  onConversationIdChange?: (id: string) => void
  // Fires after the first turn_complete in a fresh-start session: used by
  // bootstrap starters (ChatNewStarter, ChatIntakeStarter) to defer the URL
  // swap until streaming is done. Swapping on the early `conversation`
  // event unmounts the component mid-stream and the assistant reply is
  // never persisted before /chat/[id] hydrates.
  onFirstTurnComplete?: (id: string) => void
  // Optional vertical padding override: defaults to py-6 inside the
  // scroller. The full-page chat uses py-8 for breathing room.
  scrollerClassName?: string
  // Publishes turn boundaries and the current tool to the shared status
  // channel. Optional: /chat is its own surface and has nothing to notify.
  onStatus?: (event: AgentStatusEvent) => void
  // Pre-baked first user message. When set, the mount effect fires the first
  // turn with this verbatim (skipping the intent's promptTemplate path) AND
  // renders it as a user-side message in the timeline. Used by /chat empty
  // state suggestion chips.
  seedUserMessage?: string
}

export default function AgentChat({
  intentId,
  intentArgs,
  contextRef,
  initialMessages,
  initialConversationId,
  onConversationIdChange,
  onFirstTurnComplete,
  scrollerClassName,
  seedUserMessage,
  onStatus,
}: AgentChatProps) {
  const [conversationId, setConversationId] = useState<string | null>(initialConversationId ?? null)
  // "Clear the proposals I didn't approve" — rejects the conversation's
  // still-pending staged operations in one call so they don't linger in
  // Granskning, then drops the cards from view.
  const [clearingProposals, setClearingProposals] = useState(false)
  async function handleClearProposals() {
    const convId = conversationId
    if (!convId || clearingProposals) return
    setClearingProposals(true)
    try {
      await fetch(`/api/agent/conversations/${convId}/reject-pending`, { method: 'POST' })
      // Committed proposals are already booked (their card was only a
      // confirmation); pending ones the server just rejected. Either way, drop
      // the cards so the conversation reads as resolved.
      setMessages((prev) => prev.map((m) => (m.staged ? { ...m, staged: undefined } : m)))
    } catch {
      // best-effort: leave the cards if the request failed
    } finally {
      setClearingProposals(false)
    }
  }
  // Track whether the first-turn callback has fired so the bootstrap
  // starters get exactly one notification even if a turn fires before
  // the conversation_id event (defensive: order shouldn't matter).
  const firstTurnFiredRef = useRef(false)
  const conversationIdRef = useRef<string | null>(initialConversationId ?? null)
  const [messages, setMessages] = useState<ChatMessage[]>(initialMessages ?? [])
  // How many messages were already on screen when this thread mounted. Anything
  // at or past this index is new and animates in; the resumed history does not.
  const historyBaselineRef = useRef((initialMessages ?? []).length)
  // Read by the announcement effect, which must not re-run on every token: a
  // `messages` dependency would fire it hundreds of times per turn. Written in
  // an effect rather than during render: React may replay a render, and a
  // render-phase ref write can therefore leave the announcement reading a
  // snapshot the user never saw. Declared BEFORE the announcement effect so it
  // is already current when that one runs for the same commit.
  const messagesRef = useRef(messages)
  useEffect(() => {
    messagesRef.current = messages
  }, [messages])
  // Where the current turn's messages start. Without it the announcement
  // searches the whole thread, so a turn that produces no text of its own (a
  // tool-only turn, an error) finds the PREVIOUS answer and reads it out as
  // though it were the new one.
  const turnStartRef = useRef(0)
  const hasAi = useCapability(CAPABILITY.ai)
  const [input, setInput] = useState('')
  const [streaming, setStreaming] = useState(false)
  // Turn boundaries for the status channel are derived from the streaming flag
  // rather than published at each call site: a turn can end by completing,
  // erroring, aborting or being stopped, and a channel that misses one of
  // those leaves the trigger claiming the agent is still working forever.
  const turnOpenRef = useRef(false)
  // Screen-reader announcement for the turn. Deliberately NOT the streaming
  // text: a live region over token deltas re-announces on every delta and
  // renders the chat unusable with a screen reader. Announce the two states
  // that matter instead, and the finished answer once, when it is finished.
  const [announcement, setAnnouncement] = useState('')
  useEffect(() => {
    if (streaming) {
      turnOpenRef.current = true
      turnStartRef.current = messagesRef.current.length
      onStatus?.({ type: 'turn_start' })
      setAnnouncement('Assistenten skriver ett svar.')
    } else if (turnOpenRef.current) {
      turnOpenRef.current = false
      onStatus?.({ type: 'turn_end' })
      setAnnouncement(announceableAnswer(messagesRef.current.slice(turnStartRef.current)))
    }
  }, [streaming, onStatus])
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  // True between a stream_restart event and the retried stream's first sign of
  // life: renders a discreet "Försöker igen…" line so the reset bubble doesn't
  // read as the assistant silently going blank.
  const [retryNotice, setRetryNotice] = useState(false)
  const scrollerRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  // Active turn's controller, kept in a ref (not state) so the stop button
  // can read it without re-renders churning the AbortController identity.
  const activeControllerRef = useRef<AbortController | null>(null)
  // Set when a tool call runs; consumed by the NEXT text_delta to insert a
  // single paragraph break so post-tool narration starts on its own line.
  // A ref (not state) because it must be read/cleared synchronously inside
  // the streaming loop without triggering re-renders, and because the
  // break must fire exactly once per resume, not on every delta.
  const breakBeforeNextTextRef = useRef(false)
  // Fresh-start vs. resume: only kick off the first turn when we have neither
  // a hydrated conversation nor pre-existing messages. React 19 Strict Mode
  // runs effects twice in dev; the first call's cleanup aborts its fetch, the
  // second completes. The invoke endpoint is idempotent on first-turn when
  // no conversation_id is supplied (it creates a fresh row each time, so a
  // transient duplicate just orphans the first conversation: harmless).
  useEffect(() => {
    // Only bootstrap a first turn on a genuine fresh start: i.e. NO
    // conversation id. A present id means the conversation already exists
    // (or is mid-creation elsewhere), so we must not fire an invoke.
    //
    // Why id-alone, not id+messages: the intake flow fires an invoke with
    // no conversation_id, then swaps the URL to /chat/[id] the moment the
    // `conversation` event lands: which can beat the greeting being
    // persisted. /chat/[id] then hydrates with 0 messages. If we keyed the
    // guard on messages.length we'd auto-fire a SECOND invoke against the
    // same conversation and render two greetings. Keying on id presence
    // alone closes that race.
    const hasResumeState = !!initialConversationId
    if (hasResumeState) return

    // Paywall: never auto-fire the first invoke without the ai capability;
    // the composer is already replaced by the upgrade note.
    if (!hasAi) return

    // Seed-message path: render the user's pre-baked starter in the timeline
    // and send it as the first turn's user_message (skips intent.capture +
    // promptTemplate). Empty seed runs the normal capture-driven flow.
    if (seedUserMessage && seedUserMessage.trim().length > 0) {
      setMessages([{ role: 'user', text: seedUserMessage.trim() }])
      void startTurn({
        conversationId: initialConversationId ?? null,
        userMessage: seedUserMessage.trim(),
      })
    } else {
      void startTurn({
        conversationId: initialConversationId ?? null,
        userMessage: '',
      })
    }
    return () => {
      activeControllerRef.current?.abort()
      activeControllerRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Autoscroll on new content, but only if the user was already pinned to the
  // bottom. Scrolling up to re-read a long answer should NOT yank the user
  // back on every streaming token. Threshold accounts for sub-pixel rounding.
  const wasAtBottomRef = useRef(true)
  // True when the user has scrolled up AND new content has landed below them.
  // Without this, reading back through a long answer while the next one streams
  // silently buries the reply: no yank (that would be worse), but a way back.
  const [hasUnseenBelow, setHasUnseenBelow] = useState(false)
  useEffect(() => {
    const el = scrollerRef.current
    if (!el) return
    const onScroll = () => {
      const distance = el.scrollHeight - (el.scrollTop + el.clientHeight)
      wasAtBottomRef.current = distance < 64
      if (wasAtBottomRef.current) setHasUnseenBelow(false)
    }
    el.addEventListener('scroll', onScroll, { passive: true })
    return () => el.removeEventListener('scroll', onScroll)
  }, [])
  useEffect(() => {
    const el = scrollerRef.current
    if (!el) return
    if (wasAtBottomRef.current) {
      el.scrollTop = el.scrollHeight
      setHasUnseenBelow(false)
    } else {
      setHasUnseenBelow(true)
    }
  }, [messages])

  function jumpToLatest() {
    const el = scrollerRef.current
    if (!el) return
    el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' })
    wasAtBottomRef.current = true
    setHasUnseenBelow(false)
  }

  async function startTurn(body: {
    conversationId: string | null
    userMessage: string
    // When true, the user_message is persisted for agent context but flagged
    // hidden so it never renders as a user bubble (e.g. a rejection correction
    // fed back into the chat). The caller also skips adding a visible bubble.
    hidden?: boolean
    // Resolves false when the turn never reached the server (network error or
    // a non-2xx), so the caller can hand the user's text back to the composer
    // instead of stranding a bubble that was never persisted.
  }): Promise<boolean> {
    // Abort any in-flight turn before starting a new one: guards against
    // racing two turns when handleSend is triggered twice fast.
    activeControllerRef.current?.abort()
    const controller = new AbortController()
    activeControllerRef.current = controller
    const signal = controller.signal

    // Reset the post-tool paragraph-break ref at the start of every turn so a
    // prior turn that ended on tool_use can't leak a leading "\n\n" into the
    // next turn's first text delta.
    breakBeforeNextTextRef.current = false

    setStreaming(true)
    setErrorMessage(null)
    setRetryNotice(false)

    let response: Response
    try {
      response = await fetch('/api/agent/invoke', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          intent_id: intentId,
          intent_args: intentArgs,
          context_ref: contextRef,
          conversation_id: body.conversationId,
          user_message: body.userMessage,
          user_message_hidden: body.hidden ?? false,
        }),
        signal,
      })
    } catch (err) {
      if (signal.aborted) return false
      setErrorMessage(err instanceof Error ? getUserErrorMessage(err) : 'Kunde inte nå assistenten.')
      setStreaming(false)
      activeControllerRef.current = null
      return false
    }

    if (!response.ok || !response.body) {
      // Surface the server's friendly Swedish message (rate-limit sentence,
      // "ingen aktiv firma", etc.) rather than a raw "HTTP 429".
      let msg = 'Kunde inte nå assistenten. Försök igen om en stund.'
      try {
        const errBody = await response.json()
        if (errBody && typeof errBody.error === 'string' && errBody.error.trim()) {
          msg = errBody.error
        }
      } catch {
        // non-JSON / empty body: keep the generic message
      }
      setErrorMessage(msg)
      setStreaming(false)
      activeControllerRef.current = null
      return false
    }

    // Assistant bubble is appended LAZILY: only when the first event that
    // produces user-visible content arrives. Eagerly appending here would
    // leave an empty bubble dangling if the stream errors or yields zero
    // events (e.g. proxy hiccup) before any content.
    let assistantBubbleAppended = false
    const ensureAssistantBubble = () => {
      if (assistantBubbleAppended) return
      assistantBubbleAppended = true
      setMessages((prev) => [...prev, { role: 'assistant', text: '' }])
    }

    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        let nl: number
        while ((nl = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, nl).trim()
          buffer = buffer.slice(nl + 1)
          if (!line) continue
          // Guard JSON.parse per line: a malformed line (proxy split,
          // partial buffer flush) must NOT abort the entire stream. Skip and
          // continue; the next well-formed line will be handled normally.
          let parsed: unknown
          try {
            parsed = JSON.parse(line)
          } catch {
            continue
          }
          // First user-visible event lazily mounts the bubble. `conversation`
          // is a metadata event with no visible payload so it does not.
          const ev = parsed as { kind?: string } | null
          if (
            ev &&
            typeof ev.kind === 'string' &&
            ev.kind !== 'conversation' &&
            ev.kind !== 'turn_complete'
          ) {
            ensureAssistantBubble()
          }
          handleEvent(parsed)
        }
      }
    } catch (err) {
      if (!signal.aborted) {
        setErrorMessage(err instanceof Error ? getUserErrorMessage(err) : 'Streamen avbröts.')
      }
    } finally {
      try {
        reader.releaseLock()
      } catch {
        // already released
      }
      // Guard against an aborted prior turn clobbering the new turn's
      // streaming flag: only the active controller may reset the state.
      if (activeControllerRef.current === controller) {
        setStreaming(false)
        activeControllerRef.current = null
      }
    }

    // The request reached the server. A mid-stream failure is reported through
    // errorMessage and leaves whatever streamed on screen, so it does not count
    // as "never sent".
    return true
  }

  function handleStop() {
    activeControllerRef.current?.abort()
    activeControllerRef.current = null
    setStreaming(false)
    // Keep whatever streamed, but mark it: a half-finished answer that looks
    // finished is worse than no answer, especially when it stopped mid-figure.
    setMessages((prev) => {
      const last = prev[prev.length - 1]
      if (!last || last.role !== 'assistant' || last.interrupted) return prev
      return [...prev.slice(0, -1), { ...last, interrupted: true }]
    })
  }

  function handleRegenerate() {
    if (!hasAi) return
    // Re-run the last user message and let the agent produce a fresh
    // response. UI truncates back to the last user message; DB rows are
    // append-only, so the previous assistant turn stays in agent_messages
    // (audit trail intact). The new turn is appended on top.
    let lastUserIdx = -1
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === 'user') {
        lastUserIdx = i
        break
      }
    }
    if (lastUserIdx === -1) return
    const userMsg = messages[lastUserIdx]

    // Anything the discarded turn staged has to be withdrawn BEFORE the
    // replacement runs. Otherwise the operation stays pending server-side while
    // the regenerated turn stages a second proposal for the same booking: two
    // live proposals for one action, each with its own 30-day expiry. Rejecting
    // is the same path the Avslå button uses, so the audit trail records why it
    // went away.
    const abandoned = messages
      .slice(lastUserIdx + 1)
      .flatMap((m) => m.staged ?? [])
      .map((s) => s.operation_id)
      .filter((id): id is string => typeof id === 'string')

    void (async () => {
      const withdrawn = await Promise.all(
        abandoned.map(async (operationId) => {
          try {
            const res = await fetch(`/api/pending-operations/${operationId}/reject`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                rejection_category: 'other',
                rejection_reason: 'Ersatt: användaren begärde ett nytt svar.',
              }),
            })
            // 409 means someone already resolved it (approved in Granskning, or
            // a parallel client): it is no longer pending either way, which is
            // all we need.
            return res.ok || res.status === 409
          } catch {
            return false
          }
        }),
      )

      if (withdrawn.some((ok) => !ok)) {
        // Leave the turn on screen: hiding a card whose operation is still
        // pending is the failure mode this whole change exists to remove.
        setErrorMessage(
          'Kunde inte dra tillbaka det tidigare förslaget, så svaret behölls. Försök igen.',
        )
        return
      }

      setMessages((prev) => prev.slice(0, lastUserIdx + 1))
      void startTurn({ conversationId, userMessage: userMsg.text })
    })()
  }

  // Fired after the user rejects a proposal with a reason. The rejection is
  // already recorded server-side; here we feed the correction back as a HIDDEN
  // user turn so the agent re-proposes inline: no synthetic user bubble (we
  // don't add a user row, and the turn is persisted hidden).
  function handleCorrection(correctionMessage: string) {
    if (!hasAi) return
    void startTurn({ conversationId, userMessage: correctionMessage, hidden: true })
  }

  function handleEvent(event: unknown) {
    if (typeof event !== 'object' || event === null) return
    const ev = event as { kind: string } & Record<string, unknown>

    switch (ev.kind) {
      case 'conversation': {
        const id = ev.conversation_id as string
        setConversationId(id)
        conversationIdRef.current = id
        onConversationIdChange?.(id)
        break
      }
      case 'reasoning_delta':
        // Extended-thinking tokens. Accumulate onto the active assistant
        // message; the ReasoningBlock renders them live, then collapses.
        setMessages((prev) =>
          updateLastAssistant(prev, (m) => ({
            ...m,
            reasoning: (m.reasoning ?? '') + (ev.delta as string),
          })),
        )
        break
      case 'stream_restart': {
        // The server's model stream died on a transient error and is being
        // retried. Nothing from the dead attempt was persisted: reset the
        // in-progress bubble to the server's pre-attempt snapshot, drop tool
        // chips that never completed (eager chips from the dead stream), and
        // discard the dead attempt's reasoning so the retried attempt's
        // thinking doesn't render twice. The post-tool paragraph break is
        // re-armed only when restored text exists: the snapshot always ends
        // at an iteration boundary (after tool results), so the retried
        // continuation should open its own paragraph there.
        setRetryNotice(true)
        const restored = typeof ev.assistant_text === 'string' ? ev.assistant_text : ''
        breakBeforeNextTextRef.current = restored.length > 0
        setMessages((prev) =>
          updateLastAssistant(prev, (m) => ({
            ...m,
            text: restored,
            reasoning: undefined,
            toolCalls: m.toolCalls?.filter((tc) => tc.completed),
          })),
        )
        break
      }
      case 'text_delta':
        setRetryNotice(false)
        // Insert a paragraph break ONCE when text resumes after a tool
        // call, so post-tool narration starts on its own line instead of
        // gluing onto the previous sentence ("kategoriseras.Inget historik").
        // breakBeforeNextTextRef is set by tool_use/tool_result and consumed
        // here on the first delta. Critically, the break is applied to the
        // delta exactly once: NOT re-evaluated per delta, which previously
        // split mid-word ("minnes\n\nno\n\nterna") because streaming deltas
        // arrive in sub-word chunks.
        setMessages((prev) =>
          updateLastAssistant(prev, (m) => {
            let delta = ev.delta as string
            if (breakBeforeNextTextRef.current) {
              breakBeforeNextTextRef.current = false
              // Only add the break if the buffer has content and doesn't
              // already end with whitespace, and the delta isn't itself
              // starting with a newline.
              if (m.text.length > 0 && !/\s$/.test(m.text) && !/^\s/.test(delta)) {
                delta = '\n\n' + delta
              }
            }
            return { ...m, text: m.text + delta }
          }),
        )
        break
      case 'tool_use':
        // Next text_delta should open a fresh paragraph.
        breakBeforeNextTextRef.current = true
        // Same label the in-thread chip shows, so a hidden panel and a visible
        // one describe the step identically.
        onStatus?.({ type: 'step', label: prettyToolName(ev.name as string) })
        setMessages((prev) =>
          updateLastAssistant(prev, (m) => ({
            ...m,
            toolCalls: [
              ...(m.toolCalls ?? []),
              { tool_use_id: ev.tool_use_id as string, name: ev.name as string },
            ],
          })),
        )
        break
      case 'tool_result':
        // Mark the matching chip as completed instead of removing it. Tools
        // run in 100-500 ms so yanking the chip the moment it finishes makes
        // the indicator feel like a flicker rather than a record of what
        // happened. Leaving the chip in place (with a static check dot,
        // no pulse) gives the user a stable trace of which calls ran.
        setMessages((prev) =>
          updateLastAssistant(prev, (m) => ({
            ...m,
            toolCalls: m.toolCalls?.map((tc) =>
              tc.tool_use_id === (ev.tool_use_id as string) ? { ...tc, completed: true } : tc,
            ),
          })),
        )
        break
      case 'memory_captured': {
        const evt: MemoryEvent = {
          tool_use_id: ev.tool_use_id as string,
          action: (ev.action as 'remembered' | 'forgotten') ?? 'remembered',
          memory_id: ev.memory_id as string,
          memory_kind: ev.memory_kind as MemoryEvent['memory_kind'],
          content: ev.content as string | undefined,
        }
        setMessages((prev) =>
          updateLastAssistant(prev, (m) => ({
            ...m,
            memoryEvents: [...(m.memoryEvents ?? []), evt],
            // Drop the matching tool_use chip: the richer memory chip
            // replaces it and they convey the same event.
            toolCalls: m.toolCalls?.filter((tc) => tc.tool_use_id !== evt.tool_use_id),
          })),
        )
        break
      }
      case 'staged_operation': {
        const stagedRaw = ev.staged as {
          operation_id?: string
          risk_level: 'low' | 'medium' | 'high'
          message: string
          preview?: unknown
          period_status?: {
            period_id?: string | null
            status: 'open' | 'locked' | 'closed'
            lock_date?: string | null
          }
        }
        setMessages((prev) =>
          updateLastAssistant(prev, (m) => ({
            ...m,
            staged: [
              ...(m.staged ?? []),
              {
                tool_use_id: ev.tool_use_id as string,
                tool_name: (ev.tool_name as string | undefined) ?? undefined,
                params: (ev.params as Record<string, unknown> | undefined) ?? undefined,
                operation_id: stagedRaw.operation_id,
                risk_level: stagedRaw.risk_level,
                message: stagedRaw.message,
                preview: stagedRaw.preview,
                period_status: stagedRaw.period_status,
              },
            ],
          })),
        )
        break
      }
      case 'error':
        setRetryNotice(false)
        setErrorMessage(ev.message as string)
        break
      case 'turn_complete': {
        setRetryNotice(false)
        if (!firstTurnFiredRef.current && conversationIdRef.current) {
          firstTurnFiredRef.current = true
          onFirstTurnComplete?.(conversationIdRef.current)
        }
        break
      }
    }
  }

  async function handleSend() {
    const text = input.trim()
    if (!text || streaming) return
    setInput('')
    setMessages((prev) => [...prev, { role: 'user', text }])
    const ok = await startTurn({ conversationId, userMessage: text })
    if (!ok) {
      // The turn never reached the server, so nothing was persisted and the
      // dangling user bubble would vanish on reload. Put the text back in the
      // composer instead of making the user retype it, and drop the bubble so
      // what is on screen matches what was actually sent.
      setMessages((prev) => {
        const last = prev[prev.length - 1]
        return last?.role === 'user' && last.text === text ? prev.slice(0, -1) : prev
      })
      setInput((current) => (current.length > 0 ? current : text))
    }
  }

  // Auto-resize the textarea as the user types. Capped at 8rem (~128px) so
  // the input bar never devours the message list. Shrinks back when the
  // user clears or backspaces.
  useLayoutEffect(() => {
    const el = textareaRef.current
    if (!el) return
    el.style.height = 'auto'
    const max = 128
    el.style.height = `${Math.min(el.scrollHeight, max)}px`
  }, [input])

  // Index of the last assistant bubble: used to gate the Regenerate
  // affordance so it only appears on the latest response.
  let lastAssistantIdx = -1
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'assistant') {
      lastAssistantIdx = i
      break
    }
  }

  // A vote needs the thread it belongs to. Without a conversation id there is
  // nothing to attach the report to, so the buttons stay inert rather than
  // posting a vote the backlog cannot trace to an answer.
  const handleVote = useCallback(
    async (sentiment: FeedbackSentiment) => {
      const id = conversationIdRef.current
      if (!id) return false
      return sendFeedback({ conversationId: id, sentiment })
    },
    [],
  )

  return (
    <div className="relative flex flex-col h-full min-h-0">
      {/* The chat had no live region at all, so a screen-reader user got no
          signal that the assistant had answered: the reply simply appeared for
          people who could see it. role="status" is the polite variant, which
          waits for a pause rather than interrupting. */}
      <div className="sr-only" role="status" aria-live="polite" aria-atomic="true">
        {announcement}
      </div>
      {/* The pill is positioned against THIS box, not the whole component: the
          composer below grows as the user types, and a fixed offset from the
          bottom would slide the pill under it. */}
      <div className="relative flex-1 min-h-0 flex flex-col">
      <div
        ref={scrollerRef}
        className={cn(
          'flex-1 overflow-y-auto px-5 py-6 space-y-6',
          scrollerClassName,
        )}
      >
        {messages.length === 0 && streaming && <SkeletonBubble />}

        {messages.map((m, i) => (
          <div key={i} className={i >= historyBaselineRef.current ? MESSAGE_ENTER_CLASS : undefined}>
            <MessageBubble
              message={m}
              streamingTail={streaming && i === messages.length - 1}
              showRegenerate={
                !streaming &&
                hasAi &&
                i === lastAssistantIdx &&
                m.role === 'assistant' &&
                m.text.length > 0
              }
              onRegenerate={handleRegenerate}
              onCorrection={handleCorrection}
              onVote={handleVote}
            />
          </div>
        ))}

        {retryNotice && !errorMessage && (
          <div className="text-xs text-muted-foreground px-1">
            Anslutningen bröts, försöker igen…
          </div>
        )}

        {errorMessage && (
          <div className="rounded-lg border border-destructive/50 bg-destructive/10 px-4 py-3 text-sm text-destructive">
            {errorMessage}
          </div>
        )}
      </div>

      {hasUnseenBelow && (
        <button
          type="button"
          onClick={jumpToLatest}
          className="absolute left-1/2 -translate-x-1/2 bottom-3 z-10 inline-flex items-center gap-1.5 rounded-full border border-border bg-card px-3 py-1.5 text-[11px] text-foreground shadow-md hover:bg-secondary transition-colors"
        >
          <ArrowDown className="h-3 w-3" />
          Nytt svar
        </button>
      )}
      </div>

      {/* One-tap cleanup: when the assistant staged several proposals and the
          user only approved some, clear the rest here instead of rejecting each
          one in Granskning. */}
      {conversationId && messages.some((m) => m.staged && m.staged.length > 0) && (
        <div className="flex justify-end border-t border-border px-5 py-2">
          <button
            type="button"
            onClick={() => void handleClearProposals()}
            disabled={clearingProposals}
            className="text-xs text-muted-foreground hover:text-foreground transition-colors disabled:opacity-50"
          >
            {clearingProposals ? 'Rensar…' : 'Rensa förslag som inte godkänts'}
          </button>
        </div>
      )}

      {/* Paywall: /api/agent/invoke 403s without the ai capability. Replace
          the composer with an upsell so an already-open conversation (or a
          deep link to /chat/*) never offers an input that can't send. */}
      {!hasAi ? (
        <div className="border-t border-border px-5 pt-4 pb-[calc(env(safe-area-inset-bottom,0px)+1rem)]">
          <UpgradeNote>AI-assistenten kräver ett abonnemang.</UpgradeNote>
        </div>
      ) : (
      <form
        // padding-bottom = base 1rem + safe-area-inset-bottom on phones so
        // the iOS home indicator / Android gesture bar doesn't overlap the
        // input.
        className="border-t border-border px-5 pt-4 pb-[calc(env(safe-area-inset-bottom,0px)+1rem)]"
        onSubmit={(e) => {
          e.preventDefault()
          void handleSend()
        }}
      >
        <div className="flex items-end gap-2">
          <textarea
            ref={textareaRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Skriv din fråga…"
            rows={1}
            className="flex-1 resize-none rounded-lg border border-border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring max-h-32 overflow-y-auto"
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                void handleSend()
              }
            }}
          />
          {streaming ? (
            // Stop button while the agent is producing tokens: biggest
            // pain killer. Aborts the in-flight fetch + reader.
            <Button
              type="button"
              size="icon"
              variant="outline"
              onClick={handleStop}
              aria-label="Avbryt"
              title="Avbryt strömning"
            >
              <Square className="h-3.5 w-3.5 fill-current" />
            </Button>
          ) : (
            <Button
              type="submit"
              size="icon"
              disabled={input.trim().length === 0}
              aria-label="Skicka"
            >
              <Send className="h-4 w-4" />
            </Button>
          )}
        </div>
        <p className="mt-2 text-[11px] text-muted-foreground">
          Enter att skicka · Shift+Enter för ny rad
        </p>
      </form>
      )}
    </div>
  )
}

function MessageBubble({
  message,
  streamingTail,
  showRegenerate,
  onRegenerate,
  onCorrection,
  onVote,
}: {
  message: ChatMessage
  streamingTail: boolean
  showRegenerate?: boolean
  onRegenerate?: () => void
  onCorrection?: (message: string) => void
  onVote?: (sentiment: FeedbackSentiment) => Promise<boolean>
}) {
  const isUser = message.role === 'user'
  // An assistant turn that contains only tool calls (no text, no streaming
  // tail) is the LLM's "I want to call tool X" handshake. Rendering the
  // empty border-card around nothing looks like a broken bubble; show the
  // chips standalone in that case.
  // While the model is still in its extended-thinking phase (reasoning streamed
  // but no answer text yet), the ReasoningBlock is the activity indicator, so
  // suppress the empty cursor bubble underneath it.
  const isThinking = !isUser && streamingTail && !message.text && !!message.reasoning
  const hideEmptyBubble = (!isUser && !message.text && !streamingTail) || isThinking
  const markdownLoaded = useMarkdownReady()
  return (
    <div
      className={cn('group/msg flex flex-col gap-2', isUser ? 'items-end' : 'items-start')}
    >
      {!isUser && message.reasoning && (
        <ReasoningBlock reasoning={message.reasoning} active={isThinking} />
      )}
      {!hideEmptyBubble && (
      <div
        className={cn(
          'max-w-[85%] rounded-lg px-4 py-3 text-sm leading-6',
          isUser
            ? 'bg-secondary text-foreground whitespace-pre-wrap'
            : 'border border-border bg-card',
        )}
      >
        {isUser ? (
          message.text || (streamingTail ? <Cursor /> : '')
        ) : message.text ? (
          <div className="prose prose-sm max-w-none text-foreground [&>*:first-child]:mt-0 [&>*:last-child]:mb-0 prose-headings:font-display prose-headings:font-normal prose-headings:tracking-tight prose-h2:text-base prose-h2:mt-3 prose-h2:mb-2 prose-h3:text-sm prose-h3:mt-3 prose-h3:mb-1 prose-p:my-2 prose-p:leading-6 prose-strong:font-semibold prose-strong:text-foreground prose-ul:my-2 prose-li:my-0.5 prose-blockquote:border-l-2 prose-blockquote:border-foreground/30 prose-blockquote:not-italic prose-blockquote:text-muted-foreground prose-blockquote:pl-3 prose-blockquote:my-2 prose-code:bg-secondary prose-code:rounded-sm prose-code:px-1 prose-code:py-0.5 prose-code:text-xs prose-code:before:content-none prose-code:after:content-none prose-a:text-foreground prose-a:underline prose-a:underline-offset-2 prose-pre:bg-secondary prose-pre:text-foreground prose-pre:border prose-pre:border-border prose-pre:rounded-lg prose-pre:my-2 prose-pre:p-3 prose-pre:text-xs prose-pre:leading-relaxed prose-pre:overflow-x-auto [&_pre_code]:bg-transparent [&_pre_code]:p-0 [&_pre_code]:text-foreground [&_pre_code]:text-xs prose-table:my-2 prose-table:text-xs prose-table:border-collapse [&_table]:w-full [&_th]:border-b [&_th]:border-border [&_th]:py-1.5 [&_th]:px-2 [&_th]:text-left [&_th]:font-medium [&_th]:text-muted-foreground [&_th]:uppercase [&_th]:tracking-wider [&_th]:text-[10px] [&_td]:border-b [&_td]:border-border [&_td]:py-1.5 [&_td]:px-2 [&_td]:align-top [&_tbody_tr:last-child_td]:border-b-0">
            {markdownLoaded ? (
              <MarkdownMessage text={message.text} />
            ) : (
              // One frame at most, and only before the chunk resolves. Plain
              // text keeps a resumed thread readable instead of showing a
              // column of empty cards.
              <p className="whitespace-pre-wrap">{message.text}</p>
            )}
          </div>
        ) : streamingTail ? (
          <Cursor />
        ) : null}
      </div>
      )}

      {message.interrupted && (
        <p className="text-[11px] text-muted-foreground border-t border-dashed border-border pt-1.5">
          Avbrutet. Det som hann skrivas står kvar.
        </p>
      )}

      {message.toolCalls && message.toolCalls.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {message.toolCalls.map((tc) => (
            <span
              key={tc.tool_use_id}
              className={cn(
                'inline-flex items-center gap-1.5 text-[11px] rounded-full border border-border px-2 py-0.5',
                tc.completed
                  ? 'text-muted-foreground/70 bg-card'
                  : 'text-muted-foreground bg-secondary/40',
              )}
            >
              {tc.completed ? (
                <Check className="h-2.5 w-2.5 text-muted-foreground/60" strokeWidth={3} />
              ) : (
                <span className="relative inline-flex h-1.5 w-1.5">
                  <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-foreground/40 opacity-75" />
                  <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-foreground/60" />
                </span>
              )}
              {prettyToolName(tc.name)}
            </span>
          ))}
        </div>
      )}

      {message.memoryEvents && message.memoryEvents.length > 0 && (
        <div className="flex flex-col gap-1.5 max-w-[85%]">
          {message.memoryEvents.map((m) => (
            <MemoryChip key={m.tool_use_id} event={m} />
          ))}
        </div>
      )}

      {message.staged && message.staged.length > 0 && (
        <div className="w-full max-w-[85%] space-y-2">
          {message.staged.map((s) =>
            s.operation_id ? (
              <ApprovalCard
                key={s.tool_use_id}
                operationId={s.operation_id}
                riskLevel={s.risk_level}
                message={s.message}
                toolName={s.tool_name}
                operationType={s.operation_type}
                params={s.params}
                preview={s.preview}
                periodStatus={s.period_status}
                onRequestCorrection={onCorrection}
              />
            ) : (
              <div
                key={s.tool_use_id}
                className="rounded-lg border border-border bg-card px-4 py-3 text-sm text-muted-foreground"
              >
                Förslag stageat men ingen operation-id mottagen. Granska i accounted under <em>Förslag</em>.
              </div>
            ),
          )}
        </div>
      )}

      {!isUser && message.text && !streamingTail && (
        <MessageActions
          text={message.text}
          onRegenerate={showRegenerate ? onRegenerate : undefined}
          onVote={onVote}
        />
      )}
    </div>
  )
}

/**
 * Hover row under a finished assistant answer: copy, feedback, regenerate.
 *
 * The thumbs used to be local-only: they lit up and the vote died in component
 * state. They now report to /api/agent/feedback, and the pressed state is set
 * only once the server has accepted the vote, so the button never claims a
 * report that did not happen.
 *
 * A vote does not toggle off. It emits an append-only telemetry event, and
 * there is no un-emitting one, so offering an undo would be a control that
 * lies. Changing your mind sends the other sentiment, which is a thing the
 * backlog can actually see.
 */
function MessageActions({
  text,
  onRegenerate,
  onVote,
}: {
  text: string
  onRegenerate?: () => void
  onVote?: (sentiment: FeedbackSentiment) => Promise<boolean>
}) {
  const [copied, setCopied] = useState(false)
  const [vote, setVote] = useState<'up' | 'down' | null>(null)
  const [voting, setVoting] = useState(false)

  async function handleVote(next: 'up' | 'down') {
    if (voting || vote === next || !onVote) return
    setVoting(true)
    const ok = await onVote(next === 'up' ? 'positive' : 'negative')
    setVoting(false)
    if (ok) setVote(next)
  }

  useEffect(() => {
    if (!copied) return
    const t = setTimeout(() => setCopied(false), 2000)
    return () => clearTimeout(t)
  }, [copied])

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
    } catch {
      // Clipboard can be blocked (permissions, insecure context). Silent: the
      // user can still select the text, and an error toast here would be noise.
    }
  }

  const btn =
    'inline-flex items-center gap-1.5 rounded-sm px-1.5 py-1 text-[11px] text-muted-foreground hover:bg-secondary hover:text-foreground transition-colors'

  return (
    <div className="flex items-center gap-0.5 opacity-0 focus-within:opacity-100 group-hover/msg:opacity-100 transition-opacity">
      <button type="button" onClick={handleCopy} className={btn} title="Kopiera svaret">
        {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
        {copied ? 'Kopierat' : 'Kopiera'}
      </button>
      <button
        type="button"
        onClick={() => handleVote('up')}
        disabled={voting || !onVote}
        className={cn(btn, vote === 'up' && 'text-foreground', voting && 'opacity-60')}
        title="Bra svar"
        aria-pressed={vote === 'up'}
      >
        <ThumbsUp className="h-3 w-3" />
        <span className="sr-only">Bra svar</span>
      </button>
      <button
        type="button"
        onClick={() => handleVote('down')}
        disabled={voting || !onVote}
        className={cn(btn, vote === 'down' && 'text-foreground', voting && 'opacity-60')}
        title="Dåligt svar"
        aria-pressed={vote === 'down'}
      >
        <ThumbsDown className="h-3 w-3" />
        <span className="sr-only">Dåligt svar</span>
      </button>
      {onRegenerate && (
        <button type="button" onClick={onRegenerate} className={btn} title="Generera om svaret">
          <RotateCw className="h-3 w-3" />
          Generera om
        </button>
      )}
    </div>
  )
}

// Pre-token "typing" indicator. Three staggered pulsing dots: reads as
// "Anna is typing" much faster than the single blinking caret it replaced.
// Stays only until the first text_delta lands, then the message body takes
// over.
function Cursor() {
  return (
    <span className="inline-flex items-center gap-1 align-middle" aria-label="Skriver" role="status">
      <span className="inline-block h-1.5 w-1.5 rounded-full bg-foreground/50 animate-typing-dot" style={{ animationDelay: '0ms' }} />
      <span className="inline-block h-1.5 w-1.5 rounded-full bg-foreground/50 animate-typing-dot" style={{ animationDelay: '150ms' }} />
      <span className="inline-block h-1.5 w-1.5 rounded-full bg-foreground/50 animate-typing-dot" style={{ animationDelay: '300ms' }} />
    </span>
  )
}

// Collapsible extended-thinking trace. While the model is still reasoning
// (active), it auto-expands and streams: doubling as the "working" indicator
// in place of the typing cursor. Once the answer starts it collapses to a
// quiet toggle so the reply stays the focus and the surface stays calm.
function ReasoningBlock({ reasoning, active }: { reasoning: string; active: boolean }) {
  const [open, setOpen] = useState(false)
  const show = open || active
  return (
    <div className="w-full max-w-[85%]">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="inline-flex items-center gap-1.5 text-[11px] text-muted-foreground hover:text-foreground transition-colors"
        aria-expanded={show}
      >
        {active ? (
          <span className="relative inline-flex h-1.5 w-1.5">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-foreground/40 opacity-75" />
            <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-foreground/60" />
          </span>
        ) : (
          <Brain className="h-3 w-3" />
        )}
        {active ? 'Tänker…' : show ? 'Dölj resonemang' : 'Visa resonemang'}
      </button>
      {show && (
        <div className="mt-1.5 rounded-lg border border-border bg-muted/30 px-3 py-2 text-xs leading-5 text-muted-foreground whitespace-pre-wrap">
          {reasoning}
        </div>
      )}
    </div>
  )
}

const MEMORY_KIND_LABEL: Record<'fact' | 'preference' | 'pattern' | 'correction', string> = {
  fact: 'Fakta',
  preference: 'Preferens',
  pattern: 'Mönster',
  correction: 'Korrigering',
}

function MemoryChip({ event }: { event: MemoryEvent }) {
  const Icon = event.action === 'remembered' ? BookmarkCheck : BookmarkX
  const verb = event.action === 'remembered' ? 'Sparat som minne' : 'Glömt minne'
  const kindLabel = event.memory_kind ? MEMORY_KIND_LABEL[event.memory_kind] : null
  const snippet = event.content
    ? event.content.length > 140
      ? `${event.content.slice(0, 140).trim()}…`
      : event.content
    : null
  return (
    <Link
      href="/settings/assistant?view=memory"
      className="group inline-flex items-start gap-2 rounded-lg border border-border bg-card px-3 py-2 text-xs text-muted-foreground transition-colors hover:border-foreground/30 hover:text-foreground"
      title="Visa i Assistentens minne"
    >
      <Icon className="mt-0.5 h-3.5 w-3.5 shrink-0 text-foreground/70" />
      <span className="flex-1 min-w-0">
        <span className="font-medium text-foreground">{verb}</span>
        {kindLabel && <span className="ml-1 text-muted-foreground">· {kindLabel}</span>}
        {snippet && (
          <span className="block text-muted-foreground mt-0.5 leading-snug break-words">
            {snippet}
          </span>
        )}
      </span>
    </Link>
  )
}

// Rendered for the brief moment between sending the first request and the
// first text_delta. Three pulsing lines that fade out as soon as a real
// bubble takes their place.
function SkeletonBubble() {
  return (
    <div className="flex flex-col gap-2 items-start animate-fade-in">
      <div className="max-w-[85%] rounded-lg border border-border bg-card px-4 py-3 space-y-2 w-72">
        <Skeleton className="h-3 w-full" />
        <Skeleton className="h-3 w-[85%]" />
        <Skeleton className="h-3 w-[60%]" />
      </div>
    </div>
  )
}

function updateLastAssistant(
  prev: ChatMessage[],
  update: (m: ChatMessage) => ChatMessage,
): ChatMessage[] {
  if (prev.length === 0) return prev
  const last = prev[prev.length - 1]
  if (last.role !== 'assistant') return prev
  return [...prev.slice(0, -1), update(last)]
}

// Swedish present-progressive labels for the most common MCP tools, so the
// inline badge reads as "what the agent is doing right now" rather than
// dumping the raw tool slug. Anything not in the map falls back to a
// humanized stem ("gnubok_foo_bar" → "kör foo bar…").
const TOOL_BADGE_LABELS: Record<string, string> = {
  // Discovery
  gnubok_search_tools: 'Letar efter verktyg…',
  gnubok_list_skills: 'Letar bland kunskap…',
  gnubok_load_skill: 'Slår upp regelverk…',
  // Reading / context
  gnubok_get_document_content: 'Läser underlaget…',
  gnubok_get_counterparty_templates: 'Letar i mottagar­mallar…',
  gnubok_get_supplier_ledger: 'Hämtar leverantörshistorik…',
  gnubok_get_ar_ledger: 'Hämtar kundreskontra…',
  gnubok_get_trial_balance: 'Hämtar saldobalans…',
  gnubok_get_balance_sheet: 'Hämtar balansräkning…',
  gnubok_get_income_statement: 'Hämtar resultatrapport…',
  gnubok_get_general_ledger: 'Slår i huvudboken…',
  gnubok_get_kpi_report: 'Beräknar nyckeltal…',
  gnubok_get_vat_report: 'Hämtar momsrapport…',
  gnubok_vat_close_check: 'Kontrollerar momsperiod…',
  gnubok_query_journal: 'Söker i bokföringen…',
  gnubok_year_end_readiness: 'Kontrollerar bokslutsläge…',
  gnubok_list_customers: 'Söker bland kunder…',
  gnubok_list_invoices: 'Listar fakturor…',
  // Writes (staged)
  gnubok_categorize_transaction: 'Förbereder bokning…',
  gnubok_match_transaction_to_invoice: 'Matchar mot faktura…',
  gnubok_create_customer: 'Skapar kund…',
  gnubok_create_invoice: 'Förbereder faktura…',
  gnubok_create_voucher: 'Förbereder verifikation…',
  gnubok_create_transactions: 'Förbereder transaktioner…',
  gnubok_approve_supplier_invoice: 'Stagear attestering…',
  gnubok_credit_supplier_invoice: 'Förbereder kreditfaktura…',
  gnubok_propose_accruals: 'Räknar fram periodiseringar…',
  gnubok_propose_annual_depreciation: 'Beräknar avskrivningar…',
  gnubok_propose_dispositioner: 'Förbereder dispositioner…',
  gnubok_preview_arsredovisning: 'Förhandsgranskar årsredovisning…',
  gnubok_preview_ef_declaration: 'Förbereder NE-bilaga…',
  gnubok_post_annual_depreciation: 'Bokar avskrivningar…',
  // Memory
  gnubok_remember_fact: 'Sparar i minnet…',
  gnubok_forget_fact: 'Tar bort från minnet…',
}

function prettyToolName(name: string): string {
  if (TOOL_BADGE_LABELS[name]) return TOOL_BADGE_LABELS[name]
  return `kör ${name.replace(/^gnubok_/, '').replace(/_/g, ' ')}…`
}

// Helper used by /chat/[id] server component to normalize agent_messages
// rows into the ChatMessage shape this component expects. Exported here so
// both the sheet (for future "resume" support) and the page can use it.
/**
 * Re-attach unanswered proposals to a hydrated thread.
 *
 * Approval cards ride on streamed events that are never persisted, so without
 * this a resumed conversation shows the tool trace and the answer but no card,
 * and the proposal quietly waits out its 30-day expiry in Granskning. They land
 * on the last assistant message so they read as that turn's proposal, which is
 * where they were when the turn streamed.
 */
export function attachStagedOperations(
  messages: ChatMessage[],
  staged: StoredStagedOperation[],
): ChatMessage[] {
  if (staged.length === 0) return messages

  const cards: StagedOperation[] = staged.map((op) => ({
    // Hydrated cards have no tool_use_id (it lived only in the stream); the
    // operation id is the stable key and the only thing commit/reject need.
    tool_use_id: `hydrated:${op.id}`,
    operation_id: op.id,
    risk_level:
      op.risk_level === 'high' || op.risk_level === 'medium' ? op.risk_level : 'low',
    message: op.title ?? 'Förslag väntar på granskning.',
    // The stored bare operation_type drives the preview dispatch directly.
    // Its predecessor mapped it onto an MCP tool name here ('gnubok_' +
    // type) for ApprovalCard's old 4-case tool-name switch, so every other
    // hydrated type silently lost its specialized preview.
    operation_type: op.operation_type,
    params: (op.params ?? undefined) as Record<string, unknown> | undefined,
    preview: op.preview_data,
  }))

  const lastAssistantIdx = messages.map((m) => m.role).lastIndexOf('assistant')
  if (lastAssistantIdx === -1) {
    return [...messages, { role: 'assistant', text: '', staged: cards }]
  }
  return messages.map((m, i) =>
    i === lastAssistantIdx ? { ...m, staged: [...(m.staged ?? []), ...cards] } : m,
  )
}

export function normalizeStoredMessages(
  rows: { role: string; content: unknown; hidden?: boolean | null }[],
): ChatMessage[] {
  const out: ChatMessage[] = []
  for (const r of rows) {
    if (r.role === 'tool') continue // tool_result blocks aren't shown in the timeline
    if (r.hidden === true) continue // synthetic first-turn templates + hidden correction turns
    const content = r.content
    if (typeof content === 'string') {
      out.push({ role: r.role === 'assistant' ? 'assistant' : 'user', text: content })
      continue
    }
    if (!Array.isArray(content)) continue
    let text = ''
    const toolCalls: { tool_use_id: string; name: string; completed?: boolean }[] = []
    for (const block of content as { type: string; text?: string; id?: string; name?: string }[]) {
      if (block.type === 'text' && block.text) text += block.text
      else if (block.type === 'tool_use' && block.id && block.name) {
        // Hydrated rows are historical: the tool already finished by
        // definition (otherwise the assistant content wouldn't have been
        // persisted). Mark every chip as completed so the rendered state
        // matches the live tool_result-handled state.
        toolCalls.push({ tool_use_id: block.id, name: block.name, completed: true })
      }
    }
    out.push({
      role: r.role === 'assistant' ? 'assistant' : 'user',
      text,
      ...(toolCalls.length > 0 ? { toolCalls } : {}),
    })
  }
  return out
}

/**
 * What to read out when a turn finishes.
 *
 * Takes only the CURRENT turn's messages: given the whole thread, a turn that
 * produced no text of its own would find the previous answer and announce it
 * again as if it were new.
 *
 * The cap exists because a screen reader reads a live region straight through:
 * a 900-word bokslut explanation announced in one uninterruptible burst is
 * worse than not announcing it. It covers the WHOLE announcement, suffix
 * included, so the promise the constant makes is the one the output keeps.
 */
export const ANNOUNCEMENT_LIMIT = 400
const CONTINUES = '… Svaret fortsätter i meddelandet.'

export function announceableAnswer(messages: ChatMessage[]): string {
  const last = [...messages].reverse().find((m) => m.role === 'assistant')

  // Stop leaves the partial text in place with a visible marker. Reading it
  // out as a finished answer would tell a screen-reader user the opposite of
  // what the marker tells everyone else.
  if (last?.interrupted) return 'Assistenten avbröts. Ett ofullständigt svar står i meddelandet.'

  const text = last?.text?.trim()
  if (!text) return 'Assistenten är klar.'
  if (text.length <= ANNOUNCEMENT_LIMIT) return text
  return text.slice(0, ANNOUNCEMENT_LIMIT - CONTINUES.length).trimEnd() + CONTINUES
}
