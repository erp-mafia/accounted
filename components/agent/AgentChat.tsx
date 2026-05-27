'use client'

import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import Link from 'next/link'
import {
  Send,
  Square,
  RotateCw,
  BookmarkCheck,
  BookmarkX,
  Check,
  Brain,
} from 'lucide-react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import ApprovalCard from './ApprovalCard'

// Reusable chat surface — used both inside the right-hand AgentSheet and on
// the full-page /chat route. Owns:
//   * Message state (rendered list)
//   * NDJSON stream consumer for /api/agent/invoke
//   * Markdown rendering + tool-call badges + approval cards
//   * Input form
//
// What it does NOT own:
//   * Sheet chrome (title bar, close button) — wrapper's job
//   * Page layout / sidebar — wrapper's job
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
  // Shown in a collapsible "Tänkte…" block. Stream-time only — not hydrated.
  reasoning?: string
  // Tool-use chips. `completed` flips true when the matching `tool_result`
  // event arrives so the UI can swap the pulsing dot for a static check
  // instead of yanking the chip out from under the user. Hydrated messages
  // are always completed (they would not have been persisted otherwise).
  toolCalls?: { tool_use_id: string; name: string; completed?: boolean }[]
  staged?: StagedOperation[]
  memoryEvents?: MemoryEvent[]
}

// Emitted by run-turn.ts after a successful remember_fact / forget_fact call
// so the chat surface can render a quiet "Sparat som minne: …" chip below the
// assistant message. Stream-time only — not hydrated on /chat resume.
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
  // The originating tool name (e.g. 'gnubok_categorize_transaction'). Lets
  // ApprovalCard pick the right structured-preview renderer.
  tool_name?: string
  // The structured operation preview from the staged envelope. Shape varies
  // by tool; ApprovalCard's renderers do the type-narrowing.
  preview?: unknown
  // Period state at the operation's effective date. Surfaced as a small
  // badge — open|locked|closed.
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
  // Fires after the first turn_complete in a fresh-start session — used by
  // bootstrap starters (ChatNewStarter, ChatIntakeStarter) to defer the URL
  // swap until streaming is done. Swapping on the early `conversation`
  // event unmounts the component mid-stream and the assistant reply is
  // never persisted before /chat/[id] hydrates.
  onFirstTurnComplete?: (id: string) => void
  // Optional vertical padding override — defaults to py-6 inside the
  // scroller. The full-page chat uses py-8 for breathing room.
  scrollerClassName?: string
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
}: AgentChatProps) {
  const [conversationId, setConversationId] = useState<string | null>(initialConversationId ?? null)
  // Track whether the first-turn callback has fired so the bootstrap
  // starters get exactly one notification even if a turn fires before
  // the conversation_id event (defensive — order shouldn't matter).
  const firstTurnFiredRef = useRef(false)
  const conversationIdRef = useRef<string | null>(initialConversationId ?? null)
  const [messages, setMessages] = useState<ChatMessage[]>(initialMessages ?? [])
  const [input, setInput] = useState('')
  const [streaming, setStreaming] = useState(false)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const scrollerRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  // Active turn's controller, kept in a ref (not state) so the stop button
  // can read it without re-renders churning the AbortController identity.
  const activeControllerRef = useRef<AbortController | null>(null)
  // Set when a tool call runs; consumed by the NEXT text_delta to insert a
  // single paragraph break so post-tool narration starts on its own line.
  // A ref (not state) because it must be read/cleared synchronously inside
  // the streaming loop without triggering re-renders — and because the
  // break must fire exactly once per resume, not on every delta.
  const breakBeforeNextTextRef = useRef(false)
  // Fresh-start vs. resume — only kick off the first turn when we have neither
  // a hydrated conversation nor pre-existing messages. React 19 Strict Mode
  // runs effects twice in dev; the first call's cleanup aborts its fetch, the
  // second completes. The invoke endpoint is idempotent on first-turn when
  // no conversation_id is supplied (it creates a fresh row each time, so a
  // transient duplicate just orphans the first conversation — harmless).
  useEffect(() => {
    // Only bootstrap a first turn on a genuine fresh start — i.e. NO
    // conversation id. A present id means the conversation already exists
    // (or is mid-creation elsewhere), so we must not fire an invoke.
    //
    // Why id-alone, not id+messages: the intake flow fires an invoke with
    // no conversation_id, then swaps the URL to /chat/[id] the moment the
    // `conversation` event lands — which can beat the greeting being
    // persisted. /chat/[id] then hydrates with 0 messages. If we keyed the
    // guard on messages.length we'd auto-fire a SECOND invoke against the
    // same conversation and render two greetings. Keying on id presence
    // alone closes that race.
    const hasResumeState = !!initialConversationId
    if (hasResumeState) return

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

  // Autoscroll on new content — but only if the user was already pinned to the
  // bottom. Scrolling up to re-read a long answer should NOT yank the user
  // back on every streaming token. Threshold accounts for sub-pixel rounding.
  const wasAtBottomRef = useRef(true)
  useEffect(() => {
    const el = scrollerRef.current
    if (!el) return
    const onScroll = () => {
      const distance = el.scrollHeight - (el.scrollTop + el.clientHeight)
      wasAtBottomRef.current = distance < 64
    }
    el.addEventListener('scroll', onScroll, { passive: true })
    return () => el.removeEventListener('scroll', onScroll)
  }, [])
  useEffect(() => {
    const el = scrollerRef.current
    if (!el) return
    if (wasAtBottomRef.current) {
      el.scrollTop = el.scrollHeight
    }
  }, [messages])

  async function startTurn(body: {
    conversationId: string | null
    userMessage: string
    // When true, the user_message is persisted for agent context but flagged
    // hidden so it never renders as a user bubble (e.g. a rejection correction
    // fed back into the chat). The caller also skips adding a visible bubble.
    hidden?: boolean
  }): Promise<void> {
    // Abort any in-flight turn before starting a new one — guards against
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
      if (signal.aborted) return
      setErrorMessage(err instanceof Error ? err.message : 'Kunde inte nå assistenten.')
      setStreaming(false)
      activeControllerRef.current = null
      return
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
        // non-JSON / empty body — keep the generic message
      }
      setErrorMessage(msg)
      setStreaming(false)
      activeControllerRef.current = null
      return
    }

    // Assistant bubble is appended LAZILY — only when the first event that
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
          // Guard JSON.parse per line — a malformed line (proxy split,
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
        setErrorMessage(err instanceof Error ? err.message : 'Streamen avbröts.')
      }
    } finally {
      try {
        reader.releaseLock()
      } catch {
        // already released
      }
      // Guard against an aborted prior turn clobbering the new turn's
      // streaming flag — only the active controller may reset the state.
      if (activeControllerRef.current === controller) {
        setStreaming(false)
        activeControllerRef.current = null
      }
    }
  }

  function handleStop() {
    activeControllerRef.current?.abort()
    activeControllerRef.current = null
    setStreaming(false)
  }

  function handleRegenerate() {
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
    setMessages(messages.slice(0, lastUserIdx + 1))
    void startTurn({ conversationId, userMessage: userMsg.text })
  }

  // Fired after the user rejects a proposal with a reason. The rejection is
  // already recorded server-side; here we feed the correction back as a HIDDEN
  // user turn so the agent re-proposes inline — no synthetic user bubble (we
  // don't add a user row, and the turn is persisted hidden).
  function handleCorrection(correctionMessage: string) {
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
      case 'text_delta':
        // Insert a paragraph break ONCE when text resumes after a tool
        // call, so post-tool narration starts on its own line instead of
        // gluing onto the previous sentence ("kategoriseras.Inget historik").
        // breakBeforeNextTextRef is set by tool_use/tool_result and consumed
        // here on the first delta. Critically, the break is applied to the
        // delta exactly once — NOT re-evaluated per delta, which previously
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
        // run in 100–500 ms so yanking the chip the moment it finishes makes
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
            // Drop the matching tool_use chip — the richer memory chip
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
        setErrorMessage(ev.message as string)
        break
      case 'turn_complete': {
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
    await startTurn({ conversationId, userMessage: text })
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

  // Index of the last assistant bubble — used to gate the Regenerate
  // affordance so it only appears on the latest response.
  let lastAssistantIdx = -1
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'assistant') {
      lastAssistantIdx = i
      break
    }
  }

  return (
    <div className="relative flex flex-col h-full min-h-0">
      <div
        ref={scrollerRef}
        className={cn(
          'flex-1 overflow-y-auto px-5 py-6 space-y-6',
          scrollerClassName,
        )}
      >
        {messages.length === 0 && streaming && <SkeletonBubble />}

        {messages.map((m, i) => (
          <div key={i} className="animate-slide-up">
            <MessageBubble
              message={m}
              streamingTail={streaming && i === messages.length - 1}
              showRegenerate={
                !streaming &&
                i === lastAssistantIdx &&
                m.role === 'assistant' &&
                m.text.length > 0
              }
              onRegenerate={handleRegenerate}
              onCorrection={handleCorrection}
            />
          </div>
        ))}

        {errorMessage && (
          <div className="rounded-lg border border-destructive/50 bg-destructive/10 px-4 py-3 text-sm text-destructive">
            {errorMessage}
          </div>
        )}
      </div>

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
            // Stop button while the agent is producing tokens — biggest
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
    </div>
  )
}

function MessageBubble({
  message,
  streamingTail,
  showRegenerate,
  onRegenerate,
  onCorrection,
}: {
  message: ChatMessage
  streamingTail: boolean
  showRegenerate?: boolean
  onRegenerate?: () => void
  onCorrection?: (message: string) => void
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
  return (
    <div className={cn('flex flex-col gap-2', isUser ? 'items-end' : 'items-start')}>
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
          <div className="prose prose-sm max-w-none text-foreground [&>*:first-child]:mt-0 [&>*:last-child]:mb-0 prose-headings:font-display prose-headings:font-normal prose-headings:tracking-tight prose-h2:text-base prose-h2:mt-3 prose-h2:mb-2 prose-h3:text-sm prose-h3:mt-3 prose-h3:mb-1 prose-p:my-2 prose-p:leading-6 prose-strong:font-semibold prose-strong:text-foreground prose-ul:my-2 prose-li:my-0.5 prose-blockquote:border-l-2 prose-blockquote:border-foreground/30 prose-blockquote:not-italic prose-blockquote:text-muted-foreground prose-blockquote:pl-3 prose-blockquote:my-2 prose-code:bg-secondary prose-code:rounded prose-code:px-1 prose-code:py-0.5 prose-code:text-xs prose-code:before:content-none prose-code:after:content-none prose-a:text-foreground prose-a:underline prose-a:underline-offset-2 prose-pre:bg-secondary prose-pre:text-foreground prose-pre:border prose-pre:border-border prose-pre:rounded-lg prose-pre:my-2 prose-pre:p-3 prose-pre:text-xs prose-pre:leading-relaxed prose-pre:overflow-x-auto [&_pre_code]:bg-transparent [&_pre_code]:p-0 [&_pre_code]:text-foreground [&_pre_code]:text-xs prose-table:my-2 prose-table:text-xs prose-table:border-collapse [&_table]:w-full [&_th]:border-b [&_th]:border-border [&_th]:py-1.5 [&_th]:px-2 [&_th]:text-left [&_th]:font-medium [&_th]:text-muted-foreground [&_th]:uppercase [&_th]:tracking-wider [&_th]:text-[10px] [&_td]:border-b [&_td]:border-border [&_td]:py-1.5 [&_td]:px-2 [&_td]:align-top [&_tbody_tr:last-child_td]:border-b-0">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{message.text}</ReactMarkdown>
          </div>
        ) : streamingTail ? (
          <Cursor />
        ) : null}
      </div>
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
                preview={s.preview}
                periodStatus={s.period_status}
                onRequestCorrection={onCorrection}
              />
            ) : (
              <div
                key={s.tool_use_id}
                className="rounded-lg border border-border bg-card px-4 py-3 text-sm text-muted-foreground"
              >
                Förslag stageat men ingen operation-id mottagen. Granska i gnubok under <em>Förslag</em>.
              </div>
            ),
          )}
        </div>
      )}

      {showRegenerate && onRegenerate && (
        <button
          type="button"
          onClick={onRegenerate}
          className="inline-flex items-center gap-1.5 text-[11px] text-muted-foreground hover:text-foreground transition-colors"
          title="Generera om svaret"
        >
          <RotateCw className="h-3 w-3" />
          Generera om
        </button>
      )}
    </div>
  )
}

// Pre-token "typing" indicator. Three staggered pulsing dots — reads as
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
// (active), it auto-expands and streams — doubling as the "working" indicator
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
      href="/settings/assistant"
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
        <div className="h-3 rounded bg-muted-foreground/15 animate-pulse w-full" />
        <div className="h-3 rounded bg-muted-foreground/15 animate-pulse w-[85%]" />
        <div className="h-3 rounded bg-muted-foreground/15 animate-pulse w-[60%]" />
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
        // Hydrated rows are historical — the tool already finished by
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
