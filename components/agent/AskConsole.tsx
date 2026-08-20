'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import dynamic from 'next/dynamic'
import { AlertTriangle, MessageSquare, Send } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { UpgradeNote } from '@/components/billing/UpgradeNote'
import { useCapability } from '@/contexts/CompanyContext'
import { CAPABILITY } from '@/lib/entitlements/keys'
import { cn } from '@/lib/utils'

/**
 * The single-call chat console for general.help (audit Option A / rip).
 *
 * Replaces the streaming AgentChat runtime for free-form questions: one POST
 * to /api/agent/ask, one answer, no tool loop and no NDJSON stream. That is
 * exactly what lets it run on a local model (the endpoint is gated on
 * `configured`, any provider, not `assistantAvailable`). The tool-loop intents
 * (categorization, invoice draft, supplier review) still use AgentChat +
 * run-turn.ts because they stage operations; this console is only wired where
 * the intent is general.help.
 *
 * The surrounding view (ChatConversationView / ChatNewStarter) renders the
 * header, the agent avatar and the context chip, so this component is just the
 * thread + composer, the same division of labour AgentChat had.
 *
 * Threads persist: every turn is written server-side to
 * agent_conversations/agent_messages (persist:true), so the /chat sidebar and
 * "resume a conversation" keep working across old streaming threads and new
 * single-call ones.
 */

// Same lazy markdown chunk AgentChat uses, so a resumed thread renders links,
// lists and tables. Loaded on demand; a plain-text fallback covers the frame
// before the chunk resolves.
const MarkdownMessage = dynamic(() => import('./MarkdownMessage'), {
  ssr: false,
  loading: () => null,
})

let markdownReady = false
let markdownPromise: Promise<unknown> | null = null
function prefetchMarkdown(): Promise<unknown> {
  if (!markdownPromise) {
    markdownPromise = import('./MarkdownMessage')
      .then((mod) => {
        markdownReady = true
        return mod
      })
      .catch(() => {
        // Keep the plain-text fallback; a failed chunk load must not blank the answer.
      })
  }
  return markdownPromise
}
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

const ANSWER_PROSE =
  'prose prose-sm max-w-none text-foreground [&>*:first-child]:mt-0 [&>*:last-child]:mb-0 prose-headings:font-display prose-headings:font-normal prose-headings:tracking-tight prose-h2:text-base prose-h2:mt-3 prose-h2:mb-2 prose-h3:text-sm prose-h3:mt-3 prose-h3:mb-1 prose-p:my-2 prose-p:leading-6 prose-strong:font-semibold prose-strong:text-foreground prose-ul:my-2 prose-li:my-0.5 prose-blockquote:border-l-2 prose-blockquote:border-foreground/30 prose-blockquote:not-italic prose-blockquote:text-muted-foreground prose-blockquote:pl-3 prose-blockquote:my-2 prose-code:bg-secondary prose-code:rounded-sm prose-code:px-1 prose-code:py-0.5 prose-code:text-xs prose-code:before:content-none prose-code:after:content-none prose-a:text-foreground prose-a:underline prose-a:underline-offset-2 prose-pre:bg-secondary prose-pre:text-foreground prose-pre:border prose-pre:border-border prose-pre:rounded-lg prose-pre:my-2 prose-pre:p-3 prose-pre:text-xs prose-pre:leading-relaxed prose-pre:overflow-x-auto [&_pre_code]:bg-transparent [&_pre_code]:p-0 [&_pre_code]:text-foreground [&_pre_code]:text-xs prose-table:my-2 prose-table:text-xs prose-table:border-collapse [&_table]:w-full [&_th]:border-b [&_th]:border-border [&_th]:py-1.5 [&_th]:px-2 [&_th]:text-left [&_th]:font-medium [&_th]:text-muted-foreground [&_th]:uppercase [&_th]:tracking-wider [&_th]:text-[10px] [&_td]:border-b [&_td]:border-border [&_td]:py-1.5 [&_td]:px-2 [&_td]:align-top [&_tbody_tr:last-child_td]:border-b-0'

// Mirrors ChatEmptyState's three so the in-console empty state and the /chat
// index offer the same way in.
const SUGGESTIONS: { label: string; prompt: string }[] = [
  {
    label: 'Vad är min största utgiftspost den här månaden?',
    prompt: 'Vad är min största utgiftspost den här månaden? Visa de fem största kategorierna.',
  },
  {
    label: 'Hur ser min momsrapport ut för senaste perioden?',
    prompt:
      'Hur ser min momsrapport ut för den senaste perioden? Vad blir moms att betala eller få tillbaka, och ser något ovanligt ut?',
  },
  {
    label: 'När är min nästa skatte- eller momsdeadline?',
    prompt: 'När är min nästa skatte- eller momsdeadline, och vad behöver jag göra inför den?',
  },
]

export interface AskConsoleMessage {
  role: 'user' | 'assistant'
  text: string
}

interface AskConsoleProps {
  /** Existing general.help thread to resume; null/undefined starts a fresh one on first send. */
  initialConversationId?: string | null
  /** Already-persisted turns to hydrate (from normalizeStoredMessages, text only). */
  initialMessages?: AskConsoleMessage[]
  /** Bound page ref ("report:vat:2026-07"); stored on a fresh thread. The header renders the chip. */
  contextRef?: string | null
  /** Fire this question once on mount (suggestion chips / ⌘K deep link). */
  seedUserMessage?: string
  /** Called with the id once a fresh thread is created, so the starter can swap the URL to /chat/[id]. */
  onConversationCreated?: (id: string) => void
  /** Vertical padding override for the scroller (the full-page chat uses px-6 py-8). */
  scrollerClassName?: string
}

export default function AskConsole({
  initialConversationId,
  initialMessages,
  contextRef,
  seedUserMessage,
  onConversationCreated,
  scrollerClassName,
}: AskConsoleProps) {
  const hasAi = useCapability(CAPABILITY.ai)
  const [messages, setMessages] = useState<AskConsoleMessage[]>(initialMessages ?? [])
  const [input, setInput] = useState('')
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Set when the endpoint 503s because no AI backend is configured (self-host
  // without AI_BASE_URL). Distinct from the paywall (hasAi handles that).
  const [unconfigured, setUnconfigured] = useState(false)
  const conversationIdRef = useRef<string | null>(initialConversationId ?? null)
  const scrollerRef = useRef<HTMLDivElement>(null)
  const seedFiredRef = useRef(false)

  // Keep the newest turn in view. A resumed thread lands at the bottom too,
  // which is where the composer is.
  useEffect(() => {
    const el = scrollerRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [messages, pending])

  const send = useCallback(
    async (raw: string) => {
      const question = raw.trim()
      if (!question || pending) return

      setInput('')
      setError(null)
      setUnconfigured(false)
      setMessages((prev) => [...prev, { role: 'user', text: question }])
      setPending(true)

      try {
        const res = await fetch('/api/agent/ask', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            question,
            persist: true,
            conversation_id: conversationIdRef.current,
            // context_ref only binds a FRESH thread; a resumed one already has it.
            context_ref: conversationIdRef.current ? undefined : (contextRef ?? undefined),
          }),
        })

        if (res.status === 503) {
          setUnconfigured(true)
          return
        }
        if (!res.ok) {
          let message = 'Något gick fel. Försök igen.'
          try {
            const b = (await res.json()) as { error?: unknown }
            if (typeof b?.error === 'string') message = b.error
          } catch {
            // keep the default
          }
          setError(message)
          return
        }

        const body = (await res.json()) as {
          data?: { answer?: string; conversation_id?: string }
        }
        const answer = body?.data?.answer ?? ''
        const convId = body?.data?.conversation_id
        if (convId && !conversationIdRef.current) {
          conversationIdRef.current = convId
          onConversationCreated?.(convId)
        }
        setMessages((prev) => [...prev, { role: 'assistant', text: answer }])
      } catch {
        setError('Kunde inte nå assistenten. Kontrollera anslutningen och försök igen.')
      } finally {
        setPending(false)
      }
    },
    [pending, contextRef, onConversationCreated],
  )

  // Auto-fire a seeded question exactly once (a suggestion chip the user
  // actually clicked, not an unprompted greeting: RIP-1 removed that).
  useEffect(() => {
    if (seedFiredRef.current) return
    const seed = seedUserMessage?.trim()
    if (!seed) return
    seedFiredRef.current = true
    void send(seed)
  }, [seedUserMessage, send])

  const showEmpty = messages.length === 0 && !pending && !unconfigured

  return (
    <div className="flex flex-1 min-h-0 flex-col">
      <div
        ref={scrollerRef}
        className={cn('flex-1 overflow-y-auto px-5 py-6 space-y-6', scrollerClassName)}
      >
        {showEmpty ? (
          <EmptyState onPick={(p) => void send(p)} canSend={hasAi} />
        ) : (
          <>
            {messages.map((m, i) => (
              <MessageRow key={i} message={m} />
            ))}
            {pending && <ThinkingRow />}
          </>
        )}

        {unconfigured && <UnconfiguredNotice />}

        {error && (
          <div className="rounded-lg border border-destructive/50 bg-destructive/10 px-4 py-3 text-sm text-destructive">
            {error}
          </div>
        )}
      </div>

      {/* Paywall parity with AgentChat: the ask endpoint 403s without CAPABILITY.ai,
          so replace the composer with an upsell rather than offer an input that can't send. */}
      {!hasAi ? (
        <div className="border-t border-border px-5 pt-4 pb-[calc(env(safe-area-inset-bottom,0px)+1rem)]">
          <UpgradeNote>AI-assistenten kräver ett abonnemang.</UpgradeNote>
        </div>
      ) : (
        <form
          className="border-t border-border px-5 pt-4 pb-[calc(env(safe-area-inset-bottom,0px)+1rem)]"
          onSubmit={(e) => {
            e.preventDefault()
            void send(input)
          }}
        >
          <div className="flex items-end gap-2">
            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="Skriv din fråga…"
              rows={1}
              disabled={pending}
              className="flex-1 resize-none rounded-lg border border-border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring max-h-32 overflow-y-auto disabled:opacity-60"
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault()
                  void send(input)
                }
              }}
            />
            <Button
              type="submit"
              size="icon"
              disabled={pending || input.trim().length === 0}
              aria-label="Skicka"
            >
              <Send className="h-4 w-4" />
            </Button>
          </div>
          <p className="mt-2 text-[11px] text-muted-foreground">
            Enter att skicka · Shift+Enter för ny rad
          </p>
        </form>
      )}
    </div>
  )
}

function MessageRow({ message }: { message: AskConsoleMessage }) {
  const isUser = message.role === 'user'
  const markdownLoaded = useMarkdownReady()

  if (isUser) {
    return (
      <div className="flex justify-end">
        <div className="max-w-[85%] rounded-lg bg-secondary px-4 py-3 text-sm leading-6 text-foreground whitespace-pre-wrap">
          {message.text}
        </div>
      </div>
    )
  }

  // Assistant answer: bare prose, no card (the sign-off design).
  return (
    <div className="flex">
      <div className={cn('max-w-[88%]', ANSWER_PROSE)}>
        {markdownLoaded ? (
          <MarkdownMessage text={message.text} />
        ) : (
          <p className="whitespace-pre-wrap">{message.text}</p>
        )}
      </div>
    </div>
  )
}

function ThinkingRow() {
  return (
    <div className="flex" aria-live="polite">
      <div className="inline-flex items-center gap-2 text-sm text-muted-foreground">
        <span className="inline-flex gap-1">
          <span className="h-1.5 w-1.5 rounded-full bg-muted-foreground/70 animate-bounce [animation-delay:-0.3s]" />
          <span className="h-1.5 w-1.5 rounded-full bg-muted-foreground/70 animate-bounce [animation-delay:-0.15s]" />
          <span className="h-1.5 w-1.5 rounded-full bg-muted-foreground/70 animate-bounce" />
        </span>
        Tänker
      </div>
    </div>
  )
}

function EmptyState({ onPick, canSend }: { onPick: (prompt: string) => void; canSend: boolean }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center py-10 text-center">
      <div className="mb-3.5 grid h-9 w-9 place-items-center rounded-lg bg-secondary text-foreground">
        <MessageSquare className="h-[18px] w-[18px]" />
      </div>
      <h3 className="mb-1.5 text-[15px] font-medium text-foreground">Fråga om det du ser</h3>
      <p className="mx-auto max-w-[34ch] text-sm text-muted-foreground">
        Assistenten svarar utifrån den här sidan och din bokföring.
      </p>
      {canSend && (
        <div className="mt-5 flex flex-col gap-2 w-full max-w-md">
          {SUGGESTIONS.map((s) => (
            <button
              key={s.label}
              type="button"
              onClick={() => onPick(s.prompt)}
              className="rounded-lg border border-border bg-card px-4 py-3 text-left text-sm text-muted-foreground transition-colors hover:border-foreground/30 hover:bg-secondary/30 hover:text-foreground"
            >
              {s.label}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

function UnconfiguredNotice() {
  return (
    <div className="flex items-start gap-3 rounded-lg border border-border bg-secondary/40 px-4 py-3 text-sm">
      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
      <div>
        <strong className="font-medium">Assistenten är inte konfigurerad</strong>
        <p className="mt-1 text-muted-foreground">
          Den här installationen har ingen AI-modell inställd. Sätt{' '}
          <code className="rounded-sm bg-secondary px-1 py-0.5 text-xs">AI_BASE_URL</code> och{' '}
          <code className="rounded-sm bg-secondary px-1 py-0.5 text-xs">AI_MODEL</code> (t.ex. en
          lokal modell) så svarar assistenten. Bokföringen och underlagstolkningen påverkas inte.
        </p>
      </div>
    </div>
  )
}
