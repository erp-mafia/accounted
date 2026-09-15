'use client'

import { useEffect, useState } from 'react'
import { useTranslations } from 'next-intl'
import { ChevronDown, ChevronRight } from 'lucide-react'
import { useCapability, useCompany } from '@/contexts/CompanyContext'
import { useBranding } from '@/lib/branding/brand-context'
import { CAPABILITY } from '@/lib/entitlements/keys'
import { useFetch } from '@/lib/hooks/use-fetch'
import { useFormat } from '@/lib/hooks/use-format'
import type { AiClient } from '@/lib/onboarding/ai-clients'
import { AI_TASK_HREF, AI_TASK_LABEL_KEY, listAiTasks } from '@/lib/worklist/ai-task'
import type { WorklistCounts } from '@/lib/worklist/types'
import { AiTaskAction } from '@/components/dashboard/AiTaskAction'
import { InkText } from '@/components/onboarding/journey/ink'
import { Confetti } from '../ui/Confetti'
import { AgentChips } from '../ui/AgentChips'
import type { BooksCtx } from '../context'

/** How often the Done step asks whether an AI client has signed in, while it is showing. */
export const AI_POLL_MS = 4000

/**
 * Klart: a few flecks let go, the card of what got connected, the three
 * agent chips, then what the app already found to do (folded until asked;
 * each row opens the page in the app or hands the row to a connected
 * agent), and the door to Hem.
 */
export function DoneStep({ ctx, onLeave, leaving }: {
  ctx: BooksCtx
  /** Leaves the act; `href` is where to land (Hem by default). */
  onLeave: (outcome: 'done', href?: string) => void
  leaving: boolean
}) {
  const t = useTranslations('books')
  const d = useTranslations('dashboard')
  const { company } = useCompany()
  const { appName } = useBranding()
  const { formatDateLong } = useFormat()
  const { findings, state, loadFindings } = ctx
  const hasAi = useCapability(CAPABILITY.ai)
  const [preferredClient, setPreferredClient] = useState<AiClient>()
  const [open, setOpen] = useState(false)
  const { data: worklist, loading, error, refetch } = useFetch<{ data: WorklistCounts }, WorklistCounts>(
    '/api/worklist/counts',
    { select: (body) => body.data },
  )
  const connected = findings?.ai.connected ?? []
  const connectionKey = connected.join(',')
  const tasks = worklist && !error ? listAiTasks(worklist.counts, { hasAi }) : []

  // Refresh the same queue Hem uses when OAuth finishes or the user returns
  // from their agent. Do not keep offering work they have already completed.
  useEffect(() => {
    if (connectionKey) refetch()
  }, [connectionKey, refetch])
  useEffect(() => {
    window.addEventListener('focus', refetch)
    return () => window.removeEventListener('focus', refetch)
  }, [refetch])

  // The OAuth sign-in happens in another tab. Poll the findings while this
  // step is on screen so the client's chip turns green the moment the token
  // route has minted its key; stop once all three are connected.
  const allConnected = (findings?.ai.connected.length ?? 0) >= 3
  useEffect(() => {
    const refresh = () => {
      if (document.visibilityState !== 'hidden') void loadFindings()
    }
    window.addEventListener('focus', refresh)
    const id = allConnected ? null : window.setInterval(refresh, AI_POLL_MS)
    return () => {
      window.removeEventListener('focus', refresh)
      if (id !== null) window.clearInterval(id)
    }
  }, [allConnected, loadFindings])
  const b = findings?.books
  const rows: [string, string][] = [
    [
      t('card_books'),
      b && b.entries > 0
        ? t('card_books_value', { count: b.entries, years: b.periods.length })
        : state.path === 'fresh'
          ? t('answer_fresh')
          : t('card_books_none'),
    ],
    [t('card_bank'), findings?.bank.connected ? (findings.bank.bankName ?? t('answer_connected')) : t('card_not_connected')],
    [t('card_skv'), findings?.skv.connected ? t('answer_connected') : t('card_not_connected')],
  ]
  const next = findings?.skv.nextDeadlines[0]
  if (next) rows.push([t('card_next'), `${t(`deadline_${next.type}`)} ${formatDateLong(next.dueDate)}`])

  return (
    <div className="jny-qstep bks-done" style={{ position: 'relative' }}>
      <Confetti />
      <h1 className="jny-qtitle">
        <InkText text={t('done_title', { name: company?.name?.split(' ')[0] ?? '' })} />
      </h1>
      <p className="done-sub">{t('done_sub')}</p>
      <div className="jny-card">
        <div className="jny-card-name">{company?.name}</div>
        <dl>
          {rows.map(([k, v], i) => (
            <CardRow key={k} label={k} value={v} delay={250 + i * 140} />
          ))}
        </dl>
      </div>

      <h2 className="agent-title">{t('ai_title')}</h2>
      <p className="agent-lead">{t('ai_lead')}</p>
      <AgentChips connected={connected} onConnect={setPreferredClient} />

      {error ? (
        <p className="found-note" role="alert">
          {t('ai_handoff_failed')}{' '}
          <button type="button" className="jny-btn-quiet" onClick={refetch} disabled={loading}>
            {t('ai_handoff_retry')}
          </button>
        </p>
      ) : tasks.length > 0 && (
        <div className="found">
          <button type="button" className="found-toggle" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
            {t('tasks_found', { count: tasks.length })}
            <ChevronDown size={14} aria-hidden="true" className="chev" />
          </button>
          {open && (
            <ul className="found-list">
              {tasks.map((task) => (
                <li key={task.category} className="found-row">
                  <span className="l">
                    {d(AI_TASK_LABEL_KEY[task.category])}
                    <span className="n">{task.count}</span>
                  </span>
                  <span className="a">
                    <button type="button" className="open" disabled={leaving} onClick={() => onLeave('done', AI_TASK_HREF[task.category])}>
                      {t('task_open')}
                    </button>
                    <AiTaskAction
                      clients={connected}
                      task={task}
                      preferredClient={preferredClient}
                      onOpen={() => onLeave('done')}
                      disabled={leaving}
                    />
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {/* The door is a quiet link, not the primary: the chips and the found rows are what this step is for (founder direction 2026-09-14). */}
      <div className="done-door">
        <button type="button" className="jny-btn-quiet" disabled={leaving} onClick={() => onLeave('done')}>
          {t('open_app', { appName })}
          <ChevronRight size={13} aria-hidden="true" />
        </button>
      </div>
    </div>
  )
}

function CardRow({ label, value, delay }: { label: string; value: string; delay: number }) {
  const [on, setOn] = useState(false)
  useEffect(() => {
    const id = window.setTimeout(() => setOn(true), delay)
    return () => window.clearTimeout(id)
  }, [delay])
  return (
    <div className={`jny-card-row${on ? ' is-on' : ''}`}>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  )
}
