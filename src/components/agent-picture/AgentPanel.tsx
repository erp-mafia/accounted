'use client'

import { useEffect, useState, type ReactNode } from 'react'
import Link from 'next/link'
import { useLocale, useTranslations } from 'next-intl'
import { operationLabel } from '@/components/pending-operations/vocabulary'
import { operationText } from '@/components/questions/question-items'
import { LoadError } from '@/components/ui/empty-state'
import { Skeleton } from '@/components/ui/skeleton'
import { getErrorMessage, type ErrorLocale } from '@/lib/errors/get-error-message'
import { AGENT_RESOLVED_DAYS } from '@/lib/agent-context/agent-cards'
import type { PictureActivity, PictureAgentCard } from '@/lib/agent-context/agent-picture'
import type { AgentCardWork } from '@/lib/agent-context/agent-work'
import type { PictureWords } from './agent-card-text'
import { PROPOSALS_HREF, QUESTIONS_HREF, agentPanelParts, connectedBy, type AgentPanelProposals, type AgentPanelQuestions } from './agent-panel-parts'

/** Where the connections are managed. */
const CONNECTIONS_HREF = '/settings/api'

/** The calls a card made today, for the panel's one line about them. */
export interface AgentPanelCalls {
  count: number
  last_call_at: string
  /** True when the day held more calls than were read. */
  capped: boolean
}

/** What the card did, as the panel has it: on its way, read, or not readable. */
export type AgentPanelWork = { state: 'loading' } | { state: 'ok'; data: AgentCardWork } | { state: 'failed'; description: string; onRetry: () => void }

const ROW_CLASS = 'border-b-hairline py-2.5 last:border-b-0'
const ROW_LINK_CLASS = 'break-words text-[13px] text-strong underline-offset-2 hover:underline'
const SMALL_LINK_CLASS = 'text-xs font-medium text-strong underline-offset-2 hover:underline'
const COUNT_LINE_CLASS = 'pt-2 text-xs tabular-nums text-muted-foreground'

/**
 * What is behind an agent card, in the picture's side panel: the questions
 * the card's connections asked that wait for an answer, the proposals they
 * prepared that wait for approval, the calls they made today, and the
 * connections themselves with a way to where they are managed. A part with
 * nothing in it is left out; a card that asked and prepared nothing says so
 * in one line.
 *
 * The questions and the proposals are read when the panel opens (GET
 * /api/wiki/picture/agent); the calls and the connections are the picture's
 * own, so they show while that read is on its way and when it fails.
 */
export function AgentPanel({
  card,
  calls,
  activity,
  words,
}: {
  card: PictureAgentCard
  calls: AgentPanelCalls | null
  activity: PictureActivity | null
  words: PictureWords
}) {
  const locale = useLocale() as ErrorLocale
  const [work, setWork] = useState<{ state: 'loading' } | { state: 'ok'; data: AgentCardWork } | { state: 'failed'; description: string }>({ state: 'loading' })

  // One read per attempt. Every state change happens in the answer's callback.
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    let cancelled = false
    fetch(`/api/wiki/picture/agent?card=${encodeURIComponent(card.id)}`)
      .then(async (res) => {
        const body = (await res.json().catch(() => null)) as { data?: AgentCardWork } | null
        if (cancelled) return
        if (res.ok && body?.data) setWork({ state: 'ok', data: body.data })
        else setWork({ state: 'failed', description: getErrorMessage(body, { locale, statusCode: res.status }) })
      })
      .catch((err: unknown) => {
        if (!cancelled) setWork({ state: 'failed', description: getErrorMessage(err, { locale }) })
      })
    return () => {
      cancelled = true
    }
  }, [card.id, attempt, locale])
  const retry = () => {
    setWork({ state: 'loading' })
    setAttempt((n) => n + 1)
  }

  return <AgentPanelBody card={card} work={work.state === 'failed' ? { ...work, onRetry: retry } : work} calls={calls} activity={activity} words={words} />
}

/** The panel's content for what was read. Exported for its render test. */
export function AgentPanelBody({
  card,
  work,
  calls,
  activity,
  words,
}: {
  card: PictureAgentCard
  work: AgentPanelWork
  calls: AgentPanelCalls | null
  activity: PictureActivity | null
  words: PictureWords
}) {
  const t = useTranslations('wiki')
  const parts = work.state === 'ok' ? agentPanelParts(work.data) : null

  return (
    <>
      {work.state === 'loading' && (
        <div aria-busy className="space-y-2">
          <Skeleton className="h-4 w-3/4 rounded-sm" />
          <Skeleton className="h-4 w-1/2 rounded-sm" />
        </div>
      )}
      {work.state === 'failed' && <LoadError title={t('picture.agent_work_failed')} description={work.description} onRetry={work.onRetry} />}
      {parts?.nothing && <div className="text-[13px] text-foreground/80">{t(parts.questionList ? 'picture.agent_nothing' : 'picture.agent_nothing_proposals')}</div>}
      {parts?.questions && <QuestionsPart questions={parts.questions} />}
      {parts?.proposals && <ProposalsPart proposals={parts.proposals} />}

      {calls && (
        <Part title={t('picture.agent_read')}>
          <div className="text-[13px] tabular-nums text-foreground">
            {t(calls.capped ? 'picture.calls_today_capped' : 'picture.calls_today', { count: calls.count, time: words.time(calls.last_call_at) })}
          </div>
        </Part>
      )}

      <Part title={t('picture.agent_connections_title')}>
        <ul>
          {card.connections.map((connection) => {
            const by = connectedBy(connection)
            const when = words.when(connection.connected_at)
            // The newest call the log holds for the connection, else when its key was last used. Of a connection
            // made in another company only this company's own calls are known: without one, nothing is said of its use.
            const lastUsed = (activity ? activity.actors[connection.id]?.last_call_at : connection.last_call_at) ?? connection.last_used_at
            return (
              <li key={connection.id} className={ROW_CLASS}>
                <div className="break-words text-[13px] text-strong" data-ph-mask="">
                  {by.message === 'agent_connected_by'
                    ? t('picture.agent_connected_by', { name: by.name, when })
                    : by.message === 'agent_connected_by_you'
                      ? t('picture.agent_connected_by_you', { when })
                      : t('picture.agent_connected', { when })}
                </div>
                {(lastUsed || !connection.elsewhere) && (
                  <div className="text-xs tabular-nums text-muted-foreground">{lastUsed ? t('picture.last_used', { when: words.when(lastUsed) }) : t('picture.never_used')}</div>
                )}
              </li>
            )
          })}
        </ul>
        <div className="pt-2">
          <Link href={CONNECTIONS_HREF} className={SMALL_LINK_CLASS}>
            {t('picture.agent_manage')}
          </Link>
        </div>
      </Part>
    </>
  )
}

/** One part of the panel: its name, then what it holds. */
function Part({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section aria-label={title}>
      <div className="pb-1 text-xs font-medium text-foreground/80">{title}</div>
      {children}
    </section>
  )
}

/** The questions that wait for an answer, each its text leading to the question list, then how many were answered. */
function QuestionsPart({ questions }: { questions: AgentPanelQuestions }) {
  const t = useTranslations('wiki')
  return (
    <Part title={t('picture.agent_questions')}>
      {questions.waiting.length > 0 && (
        <ul>
          {questions.waiting.map((question) => (
            <li key={question.question_id} className={ROW_CLASS}>
              <Link href={QUESTIONS_HREF} className={ROW_LINK_CLASS} data-ph-mask="">
                {question.question}
              </Link>
            </li>
          ))}
        </ul>
      )}
      {questions.more > 0 && (
        <div className="pt-2">
          <Link href={QUESTIONS_HREF} className={SMALL_LINK_CLASS}>
            {t('picture.agent_more', { count: questions.more })}
          </Link>
        </div>
      )}
      {questions.answered > 0 && <div className={COUNT_LINE_CLASS}>{t('picture.agent_answered', { count: questions.answered })}</div>}
    </Part>
  )
}

/**
 * The proposals that wait for approval, each written as the question list
 * writes a prepared operation and leading to its own page, then how many
 * were approved and rejected lately.
 */
function ProposalsPart({ proposals }: { proposals: AgentPanelProposals }) {
  const t = useTranslations('wiki')
  const tQuestions = useTranslations('questions')
  const tPending = useTranslations('pending')
  const typeName = (operationType: string) => operationLabel(operationType, tPending)
  const days = AGENT_RESOLVED_DAYS
  const resolved =
    proposals.approved > 0 && proposals.rejected > 0
      ? t('picture.agent_resolved_both', { approved: proposals.approved, rejected: proposals.rejected, days })
      : proposals.approved > 0
        ? t('picture.agent_resolved_approved', { count: proposals.approved, days })
        : proposals.rejected > 0
          ? t('picture.agent_resolved_rejected', { count: proposals.rejected, days })
          : null
  return (
    <Part title={t('picture.agent_proposals')}>
      {proposals.waiting.length > 0 && (
        <ul>
          {proposals.waiting.map((line) => (
            <li key={line.operation_id} className={ROW_CLASS}>
              <Link href={line.href ?? PROPOSALS_HREF} className={ROW_LINK_CLASS} data-ph-mask="">
                {operationText(line, tQuestions, typeName)}
              </Link>
            </li>
          ))}
        </ul>
      )}
      {proposals.more > 0 && (
        <div className="pt-2">
          <Link href={PROPOSALS_HREF} className={SMALL_LINK_CLASS}>
            {t('picture.agent_more', { count: proposals.more })}
          </Link>
        </div>
      )}
      {resolved && <div className={COUNT_LINE_CLASS}>{resolved}</div>}
    </Part>
  )
}
