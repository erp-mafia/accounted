'use client'

import { useCallback, useEffect, useState } from 'react'
import { useTranslations } from 'next-intl'
import { ChevronDownIcon, ChevronRightIcon } from '@/components/icons'
import useSWR from 'swr'
import { useBookingScreenEnabled, useCapability, useCompany } from '@/contexts/CompanyContext'
import { toBookDoor } from '@/lib/bookkeeping/to-book'
import { useBranding } from '@/lib/branding/brand-context'
import { CAPABILITY } from '@/lib/entitlements/keys'
import { useFormat } from '@/lib/hooks/use-format'
import { AI_CLIENTS } from '@/lib/onboarding/ai-clients'
import { AI_TASK_LABEL_KEY, aiTaskHref, foundTasksStartOpen, listAiTasks, type AiTaskCategory } from '@/lib/worklist/ai-task'
import type { WorklistCounts } from '@/lib/worklist/types'
import { AiTaskAction } from '@/components/dashboard/AiTaskAction'
import { InkText } from '@/components/onboarding/journey/ink'
import { Confetti } from '../ui/Confetti'
import { AgentChips } from '../ui/AgentChips'
import { FactsImport } from '../ui/FactsImport'
import { useAiConnection } from '../ui/use-ai-connection'
import type { BooksCtx } from '../context'
import { Button } from '@/components/ui/button'

async function fetchWorklistCounts(): Promise<WorklistCounts> {
  const res = await fetch('/api/worklist/counts')
  if (!res.ok) throw new Error(`/api/worklist/counts ${res.status}`)
  return ((await res.json()) as { data: WorklistCounts }).data
}

/**
 * Klart: a few flecks let go, the card of what got connected, the three
 * agent chips, then what the app already found to do (open when bank rows
 * wait to be booked, otherwise folded until asked; each row opens the page
 * in the app or hands the row to a connected agent), and the door to Hem.
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
  const { findings, state } = ctx
  const hasAi = useCapability(CAPABILITY.ai)
  const bookingScreen = useBookingScreenEnabled()
  // null until the toggle is clicked: the list then follows what it holds (foundTasksStartOpen).
  const [toggled, setToggled] = useState<boolean | null>(null)
  const { data: worklist, isValidating, error, mutate } = useSWR(
    ['worklist-counts', company?.id ?? null] as const,
    fetchWorklistCounts,
  )
  // A bank row task opens where every "book these" link leads (Att bokföra with the booking screen).
  const taskHref = (category: AiTaskCategory) => {
    const href = aiTaskHref(category, worklist?.inboxHref)
    return category === 'book_transaction' ? toBookDoor(bookingScreen, href) : href
  }
  const refetch = useCallback(() => {
    void mutate()
  }, [mutate])
  const { connection, connected, preferredClient, onConnect } = useAiConnection(findings)
  const sourcesFlow = ctx.flags.sourcesFlow === true
  const connectionKey = connected.join(',')
  const tasks = worklist && !error ? listAiTasks(worklist.counts, { hasAi }) : []
  const open = toggled ?? foundTasksStartOpen(tasks)

  // Refresh the same queue Hem uses when OAuth finishes or the user returns
  // from their agent (SWR revalidates on focus). Do not keep offering work
  // they have already completed.
  useEffect(() => {
    if (connectionKey) refetch()
  }, [connectionKey, refetch])

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
  if (sourcesFlow) {
    const names = connected.map((id) => AI_CLIENTS.find((c) => c.id === id)?.name ?? id)
    rows.splice(2, 0, [t('card_ai'), names.length > 0 ? names.join(', ') : connection.connected ? t('ai_agent') : t('card_not_connected')])
  }
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

      {!sourcesFlow && (
        <>
          <h2 className="agent-title">{t('ai_title')}</h2>
          <p className="agent-lead">{t('ai_lead')}</p>
          <AgentChips connection={connection} onConnect={onConnect} />
          {/* Once an AI is connected: let it tell Accounted what it already remembers (skill company-facts-import). */}
          <FactsImport clients={connected} preferredClient={preferredClient} disabled={leaving} />
        </>
      )}

      {error ? (
        <p className="found-note" role="alert">
          {t('ai_handoff_failed')}{' '}
          <Button variant="ghost" className="text-muted-foreground" onClick={refetch} disabled={isValidating}>
            {t('ai_handoff_retry')}
          </Button>
        </p>
      ) : tasks.length > 0 && (
        <div className="found">
          <Button variant="ghost" className="found-toggle gap-2 text-muted-foreground" aria-expanded={open} onClick={() => setToggled(!open)}>
            {t('tasks_found', { count: tasks.length })}
            <ChevronDownIcon aria-hidden="true" className="size-3.5 chev" />
          </Button>
          {open && (
            <ul className="found-list">
              {tasks.map((task) => (
                <li key={task.category} className="found-row">
                  <span className="l">
                    {d(AI_TASK_LABEL_KEY[task.category])}
                    <span className="n">{task.count}</span>
                  </span>
                  <span className="a">
                    <Button variant="outline" disabled={leaving} onClick={() => onLeave('done', taskHref(task.category))}>
                      {t('task_open')}
                    </Button>
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

      {/* Without the sources arrangement the door is a quiet link: the chips and the found rows are what this step is for. */}
      <div className="done-door">
        {sourcesFlow ? (
          <Button size="lg" disabled={leaving} onClick={() => onLeave('done')}>
            {t('open_app', { appName })}
          </Button>
        ) : (
          <Button variant="ghost" className="gap-1 text-muted-foreground" disabled={leaving} onClick={() => onLeave('done')}>
            {t('open_app', { appName })}
            <ChevronRightIcon className="size-[13px]" aria-hidden="true" />
          </Button>
        )}
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
