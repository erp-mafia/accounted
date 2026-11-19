'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { usePathname } from 'next/navigation'
import { useLocale, useTranslations } from 'next-intl'
import { cn } from '@/lib/utils'
import { EnvelopeIcon, HandThumbDownIcon, HandThumbUpIcon, PaperAirplaneIcon } from '@/components/icons'
import { Button } from '@/components/ui/button'
import { DialogFooter } from '@/components/ui/dialog'
import { Textarea } from '@/components/ui/textarea'
import { MarkdownMessage, useMarkdownReady } from '@/components/agent/lazy-markdown'
import { captureAnalyticsEvent } from '@/lib/analytics/client'
import { getErrorMessage, type ErrorLocale } from '@/lib/errors/get-error-message'
import { composeHandoffMessage } from '@/lib/support/assistant-handoff'
import {
  clearSupportAskSession,
  readSupportAskSession,
  writeSupportAskSession,
  type SupportAskTurn,
} from '@/lib/support/assistant-session'
import { createSupportEventReader, type SupportStreamEvent } from '@/lib/support/assistant-stream'

/**
 * The AI assistant in the support dialog (components/ui/support-link.tsx).
 *
 * A labelled choice beside the form to a person, never in place of it: the
 * way to the support staff is on screen the whole time, and any answer can be
 * sent on to them with the conversation attached. The assistant reads and
 * explains (POST /api/support/ask); it changes nothing in the company.
 *
 * The answer is shown as it is written. What the assistant says before it
 * reads something ("Jag kollar sidan...") is dropped when the reading starts,
 * and the finished answer replaces whatever was streamed.
 */

interface SupportAskProps {
  companyId: string
  /** The user's tickets with the support staff, so they are one step away. */
  ticketCount: number
  onShowTickets: () => void
  /** To the form to a person, with nothing carried over. */
  onWriteToSupport: () => void
  /** To the form to a person, opened with the conversation as its message. */
  onHandoff: (message: string) => void
  /**
   * A link in an answer was followed: the dialog gets out of the page's way.
   * Left out by the docked panel, which is beside the page and stays.
   */
  onNavigate?: () => void
}

const ANSWER_PROSE =
  'prose prose-sm max-w-none break-words text-foreground [&>*:first-child]:mt-0 [&>*:last-child]:mb-0 prose-p:my-2 prose-p:leading-5 prose-headings:font-sans prose-headings:font-medium prose-h2:text-sm prose-h3:text-sm prose-strong:font-semibold prose-strong:text-foreground prose-ul:my-2 prose-ol:my-2 prose-li:my-0.5 prose-a:text-foreground prose-a:underline prose-a:underline-offset-2 prose-code:rounded-sm prose-code:bg-secondary prose-code:px-1 prose-code:py-0.5 prose-code:text-xs prose-code:before:content-none prose-code:after:content-none'

/** What the assistant is doing while no answer text is on screen yet. */
type Activity = 'thinking' | 'app' | 'books'

function activityOf(names: string[], current: Activity): Activity {
  if (names.some((name) => name === 'read_page' || name === 'find_in_app')) return 'app'
  if (names.some((name) => name !== 'offer_human_support')) return 'books'
  return current
}

export function SupportAsk({
  companyId,
  ticketCount,
  onShowTickets,
  onWriteToSupport,
  onHandoff,
  onNavigate,
}: SupportAskProps) {
  const t = useTranslations('support_link')
  const locale = useLocale()
  const pathname = usePathname()
  const markdownReady = useMarkdownReady()

  const [turns, setTurns] = useState<SupportAskTurn[]>(() => readSupportAskSession(companyId).turns)
  const conversationIdRef = useRef<string | null>(readSupportAskSession(companyId).conversationId)
  const [input, setInput] = useState('')
  const [pending, setPending] = useState(false)
  const [streaming, setStreaming] = useState('')
  const [activity, setActivity] = useState<Activity>('thinking')
  const [error, setError] = useState<string | null>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const abortRef = useRef<AbortController | null>(null)

  // What the dialog shows survives its closing (assistant-session.ts).
  useEffect(() => {
    writeSupportAskSession({ companyId, conversationId: conversationIdRef.current, turns })
  }, [companyId, turns])

  // The dialog closed mid-answer: stop reading. The server finishes and
  // stores the answer either way.
  useEffect(() => () => abortRef.current?.abort(), [])

  useEffect(() => {
    const el = listRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [turns, streaming, pending])

  const ask = useCallback(
    async (raw: string) => {
      const question = raw.trim()
      if (!question || pending) return
      setInput('')
      setError(null)
      setStreaming('')
      setActivity('thinking')
      setTurns((prev) => [...prev, { role: 'user', text: question }])
      setPending(true)
      captureAnalyticsEvent('support_assistant_asked', { route: pathname ?? null })

      const controller = new AbortController()
      abortRef.current = controller
      let settled = false
      const onEvent = (event: SupportStreamEvent) => {
        if (event.type === 'start') {
          conversationIdRef.current = event.conversation_id
        } else if (event.type === 'text') {
          setStreaming((prev) => prev + event.delta)
        } else if (event.type === 'tools') {
          setStreaming('')
          setActivity((current) => activityOf(event.names, current))
        } else if (event.type === 'done') {
          settled = true
          setTurns((prev) => [...prev, { role: 'assistant', text: event.answer, handoff: event.handoff }])
          captureAnalyticsEvent('support_assistant_answered', { handoff_offered: event.handoff !== null })
        } else {
          settled = true
          setError(event.message)
        }
      }

      try {
        const res = await fetch('/api/support/ask', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            question,
            conversation_id: conversationIdRef.current,
            route: pathname ?? undefined,
            locale,
          }),
          signal: controller.signal,
        })
        if (!res.ok || !res.body) {
          const fallback = t('ask_failed')
          const body = (await res.json().catch(() => null)) as { error?: unknown } | null
          setError(body?.error ? getErrorMessage(body, { locale: locale as ErrorLocale, fallback }) : fallback)
          return
        }
        const reader = res.body.getReader()
        const decoder = new TextDecoder()
        const events = createSupportEventReader(onEvent)
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          events.push(decoder.decode(value, { stream: true }))
        }
        events.end()
        if (!settled) setError(t('ask_interrupted'))
      } catch {
        if (!controller.signal.aborted) setError(t('ask_failed'))
      } finally {
        setStreaming('')
        setPending(false)
      }
    },
    [pending, pathname, locale, t],
  )

  function vote(index: number, sentiment: 'positive' | 'negative') {
    if (turns[index]?.vote === sentiment) return
    setTurns((prev) => prev.map((turn, i) => (i === index ? { ...turn, vote: sentiment } : turn)))
    captureAnalyticsEvent('support_assistant_feedback', { sentiment })
    const conversationId = conversationIdRef.current
    if (!conversationId) return
    // The rating joins the product team's feedback log. A reader-only member
    // may not write there: their rating still reaches the analytics above.
    const answerNumber = turns.slice(0, index + 1).filter((turn) => turn.role === 'assistant').length - 1
    void fetch('/api/agent/feedback', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ conversation_id: conversationId, sentiment, message_index: answerNumber }),
    }).catch(() => {
      // Safe to ignore: the rating is already on screen and in the analytics
      // event above, and a failed write here is nothing the user can act on.
    })
  }

  function handOff(offeredByAssistant: boolean) {
    const lastAnswer = [...turns].reverse().find((turn) => turn.role === 'assistant')
    captureAnalyticsEvent('support_assistant_handoff', { offered_by_assistant: offeredByAssistant })
    onHandoff(
      composeHandoffMessage({
        turns,
        route: pathname,
        summary: lastAnswer?.handoff?.summary,
        labels: {
          heading: t('handoff_heading'),
          page: t('handoff_page'),
          summary: t('handoff_summary'),
          you: t('you'),
          assistant: t('handoff_assistant'),
        },
      }),
    )
  }

  function startOver() {
    abortRef.current?.abort()
    conversationIdRef.current = null
    clearSupportAskSession()
    setTurns([])
    setError(null)
  }

  const lastIndex = turns.length - 1
  const answer = (text: string) => (
    <div className={ANSWER_PROSE}>
      {markdownReady ? <MarkdownMessage text={text} /> : <p className="whitespace-pre-wrap">{text}</p>}
    </div>
  )

  return (
    <div className="flex flex-col gap-4">
      {ticketCount > 0 && (
        <div className="flex items-center justify-between gap-3">
          <span className="text-xs text-muted-foreground">{t('ask_tickets_hint', { count: ticketCount })}</span>
          <Button type="button" variant="ghost" className="-mr-3 shrink-0" onClick={onShowTickets}>
            {t('ask_show_tickets')}
          </Button>
        </div>
      )}

      {(turns.length > 0 || pending) && (
        <div
          ref={listRef}
          className="flex max-h-[45dvh] flex-col gap-4 overflow-y-auto pr-1"
          onClick={(event) => {
            const link = (event.target as HTMLElement).closest('a')
            if (link?.getAttribute('href')?.startsWith('/')) onNavigate?.()
          }}
        >
          {turns.map((turn, index) =>
            turn.role === 'user' ? (
              <div key={index} className="flex flex-col items-end gap-1">
                <span className="text-xs text-muted-foreground">{t('you')}</span>
                <div className="max-w-[85%] whitespace-pre-wrap break-words rounded-lg bg-secondary px-3 py-2 text-sm">
                  {turn.text}
                </div>
              </div>
            ) : (
              <div key={index} className="flex flex-col items-start gap-1">
                <span className="text-xs text-muted-foreground">{t('ask_assistant_name')}</span>
                {answer(turn.text)}
                <div className="flex w-full flex-wrap items-center gap-1">
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className={cn('-ml-1.5', turn.vote === 'positive' ? 'text-foreground' : 'text-muted-foreground')}
                    aria-label={t('ask_good_answer')}
                    aria-pressed={turn.vote === 'positive'}
                    onClick={() => vote(index, 'positive')}
                  >
                    <HandThumbUpIcon className="h-4 w-4" />
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className={turn.vote === 'negative' ? 'text-foreground' : 'text-muted-foreground'}
                    aria-label={t('ask_bad_answer')}
                    aria-pressed={turn.vote === 'negative'}
                    onClick={() => vote(index, 'negative')}
                  >
                    <HandThumbDownIcon className="h-4 w-4" />
                  </Button>
                  {index === lastIndex && !pending && (
                    <>
                      <Button
                        type="button"
                        variant={turn.handoff ? 'outline' : 'ghost'}
                        onClick={() => handOff(Boolean(turn.handoff))}
                      >
                        <EnvelopeIcon className="h-3.5 w-3.5" />
                        {t('ask_send_to_support')}
                      </Button>
                      <Button type="button" variant="ghost" className="ml-auto" onClick={startOver}>
                        {t('ask_start_over')}
                      </Button>
                    </>
                  )}
                </div>
              </div>
            ),
          )}
          {pending && (
            <div className="flex flex-col items-start gap-1" aria-live="polite">
              <span className="text-xs text-muted-foreground">{t('ask_assistant_name')}</span>
              {streaming ? (
                answer(streaming)
              ) : (
                <span className="text-sm text-muted-foreground">{t(`ask_activity_${activity}`)}</span>
              )}
            </div>
          )}
        </div>
      )}

      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}

      <form
        onSubmit={(event) => {
          event.preventDefault()
          void ask(input)
        }}
      >
        <Textarea
          value={input}
          onChange={(event) => setInput(event.target.value)}
          placeholder={t('ask_placeholder')}
          className="min-h-[80px] resize-none"
          maxLength={4000}
          disabled={pending}
          autoFocus
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault()
              void ask(input)
            }
          }}
        />
        <p className="mt-1.5 text-xs text-muted-foreground">{t('ask_disclaimer')}</p>
        <DialogFooter className="mt-4">
          <Button type="button" variant="ghost" onClick={onWriteToSupport}>
            {t('ask_write_to_support')}
          </Button>
          <Button type="submit" disabled={input.trim().length === 0} loading={pending}>
            {!pending && <PaperAirplaneIcon className="h-4 w-4" />}
            {t('ask_send')}
          </Button>
        </DialogFooter>
      </form>
    </div>
  )
}
