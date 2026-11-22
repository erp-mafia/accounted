'use client'

import { useCallback, useState } from 'react'
import Link from 'next/link'
import { useLocale, useTranslations } from 'next-intl'
import { EllipsisHorizontalIcon } from '@/components/icons'
import { Button } from '@/components/ui/button'
import { LIST_BLEED_CLASS } from '@/components/ui/dry-table'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { EmptyState, LoadError } from '@/components/ui/empty-state'
import { HelpPopover } from '@/components/ui/help-popover'
import { PageHeader } from '@/components/ui/page-header'
import { StatusGlyph } from '@/components/ui/status-glyph'
import { Textarea } from '@/components/ui/textarea'
import { useViewerLock } from '@/components/ui/viewer-lock'
import { notifySessionExpired } from '@/lib/auth/session-timeout-shared'
import { getResponseErrorMessage } from '@/lib/errors/get-error-message'
import type { AppQuestion } from '@/lib/questions/app-answer'
import type { EvidenceLine } from '@/lib/questions/evidence-lines'
import { cn, formatDate, formatRowAmount } from '@/lib/utils'
import {
  answeredState,
  closedState,
  listItems,
  ownWordsBody,
  type AppCloseChoice,
  type QuestionItem,
} from './question-items'

/** The longest answer in the person's own words (APP_ANSWER_MAX in lib/questions/app-answer.ts). */
const OWN_WORDS_MAX = 1000

type T = ReturnType<typeof useTranslations>

function EvidenceRow({ line, t }: { line: EvidenceLine; t: T }) {
  const body = (
    <>
      <span className="date-figures w-[84px] shrink-0 text-muted-foreground">{line.date ? formatDate(line.date) : ''}</span>
      <span className="min-w-0 flex-1 truncate" data-ph-mask="">
        {line.found ? (
          <>
            <span className="text-foreground">{line.label ?? line.detail}</span>
            {line.label && line.detail && <span className="text-muted-foreground"> · {line.detail}</span>}
          </>
        ) : (
          <span className="text-muted-foreground">{t('evidence_missing')}</span>
        )}
      </span>
      {line.amount !== null && (
        <span className="shrink-0 text-right tabular-nums text-strong" data-ph-mask="">
          {formatRowAmount(line.amount, line.currency)}
        </span>
      )}
    </>
  )
  const rowClass = 'flex min-h-9 items-center gap-3 border-b-hairline px-2 py-1.5 text-[13px]'
  return (
    <li>
      {line.href ? (
        <Link
          href={line.href}
          className={cn(
            rowClass,
            'transition-colors duration-150 hover:bg-secondary/35 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/70',
          )}
        >
          {body}
        </Link>
      ) : (
        <div className={rowClass}>{body}</div>
      )}
    </li>
  )
}

function QuestionBlock({
  item,
  canWrite,
  t,
  onAnswer,
  onClose,
  onUndo,
}: {
  item: QuestionItem
  canWrite: boolean
  t: T
  onAnswer: (item: QuestionItem, body: { option_id: string } | { text: string }) => void
  onClose: (item: QuestionItem, reason: AppCloseChoice) => void
  onUndo: (item: QuestionItem) => void
}) {
  const [ownOpen, setOwnOpen] = useState(false)
  const [ownText, setOwnText] = useState('')
  const { question, ended, busy, error } = item
  const own = ownWordsBody(ownText)

  if (ended) {
    return (
      <li className="border-b-hairline px-2 py-3">
        <div className="flex min-h-7 flex-wrap items-center gap-x-2 gap-y-1 text-[13px]">
          <StatusGlyph tone="ok" />
          <span className="min-w-0 flex-1 basis-64" data-ph-mask="">
            {ended.kind === 'answered' ? t('saved', { fact: ended.fact }) : t(ended.reason === 'dont_know' ? 'closed_dont_know' : 'closed_not_relevant')}
          </span>
          <Button variant="ghost" onClick={() => onUndo(item)} loading={busy}>
            {t('undo')}
          </Button>
        </div>
        {error && (
          <p role="alert" className="mt-1 text-[13px] text-destructive">
            {error}
          </p>
        )}
      </li>
    )
  }

  return (
    <li className="space-y-3 border-b-hairline px-2 py-4">
      <h2 className="text-[13px] font-medium text-strong" data-ph-mask="">
        {question.question}
      </h2>
      {question.evidence.length > 0 && (
        <ul aria-label={t('evidence_label')} className="-mx-2 border-t-hairline">
          {question.evidence.map((line) => (
            <EvidenceRow key={`${line.kind}:${line.id}`} line={line} t={t} />
          ))}
        </ul>
      )}
      {question.why && (
        <p className="text-xs text-muted-foreground" data-ph-mask="">
          {question.why}
        </p>
      )}
      {canWrite && (
        <div className="flex flex-wrap items-center gap-2">
          {question.options.map((option) => (
            <Button key={option.id} variant="outline" disabled={busy} onClick={() => onAnswer(item, { option_id: option.id })}>
              <span data-ph-mask="">{option.label}</span>
            </Button>
          ))}
          <Button variant="ghost" disabled={busy} onClick={() => onClose(item, 'dont_know')}>
            {t('dont_know')}
          </Button>
          <Button variant="ghost" disabled={busy} aria-expanded={ownOpen} onClick={() => setOwnOpen((open) => !open)}>
            {t('own_words')}
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon" disabled={busy} aria-label={t('more')}>
                <EllipsisHorizontalIcon className="h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start">
              <DropdownMenuItem onSelect={() => onClose(item, 'not_relevant')}>{t('mute')}</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      )}
      {canWrite && ownOpen && (
        <form
          className="max-w-[560px] space-y-2"
          onSubmit={(event) => {
            event.preventDefault()
            if (own) onAnswer(item, own)
          }}
        >
          <Textarea
            value={ownText}
            onChange={(event) => setOwnText(event.target.value)}
            maxLength={OWN_WORDS_MAX}
            rows={2}
            className="min-h-16"
            aria-label={t('own_words_label')}
            placeholder={t('own_words_label')}
            autoFocus
          />
          <div className="flex items-center gap-2">
            <Button type="submit" variant="outline" disabled={!own} loading={busy}>
              {t('save')}
            </Button>
            <Button
              type="button"
              variant="ghost"
              onClick={() => {
                setOwnOpen(false)
                setOwnText('')
              }}
            >
              {t('cancel')}
            </Button>
          </div>
        </form>
      )}
      {error && (
        <p role="alert" className="text-[13px] text-destructive">
          {error}
        </p>
      )}
    </li>
  )
}

/**
 * The question list: each open question as a block with the records it rests
 * on, why it is asked and its answers. One press answers; the block then
 * shows what was saved, with Ångra. `initial` is null when the server could
 * not read the list.
 */
export function QuestionList({ initial }: { initial: AppQuestion[] | null }) {
  const t = useTranslations('questions')
  const locale = useLocale() === 'en' ? 'en' : 'sv'
  const { canWrite } = useViewerLock()
  const [items, setItems] = useState<QuestionItem[] | null>(() => (initial ? listItems(initial) : null))
  const [loading, setLoading] = useState(false)

  const patch = useCallback((id: string, change: Partial<QuestionItem>) => {
    setItems((current) => current?.map((item) => (item.question.question_id === id ? { ...item, ...change } : item)) ?? null)
  }, [])

  const reload = useCallback(async () => {
    setLoading(true)
    try {
      const res = await fetch('/api/questions')
      if (!res.ok) {
        notifySessionExpired(res)
        return
      }
      const body = (await res.json()) as { data?: AppQuestion[] }
      setItems(listItems(body.data ?? []))
    } catch {
      // The page keeps offering to read the list again.
    } finally {
      setLoading(false)
    }
  }, [])

  /** One write for a question: `done` reads the answer and says how the block looks afterwards. */
  const send = useCallback(
    async (item: QuestionItem, path: string, body: unknown, fallback: string, done: (data: unknown) => Partial<QuestionItem>) => {
      const id = item.question.question_id
      patch(id, { busy: true, error: null })
      try {
        const res = await fetch(`/api/questions/${id}/${path}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        })
        if (!res.ok) {
          notifySessionExpired(res)
          patch(id, { busy: false, error: (await getResponseErrorMessage(res, undefined, locale)) || fallback })
          return
        }
        const answer = (await res.json()) as { data?: unknown }
        patch(id, { busy: false, error: null, ...done(answer.data) })
      } catch {
        patch(id, { busy: false, error: fallback })
      }
    },
    [locale, patch],
  )

  const onAnswer = useCallback(
    (item: QuestionItem, body: { option_id: string } | { text: string }) =>
      void send(item, 'answer', body, t('action_failed'), (data) => ({ ended: answeredState(data) })),
    [send, t],
  )
  const onClose = useCallback(
    (item: QuestionItem, reason: AppCloseChoice) =>
      void send(item, 'close', { reason }, t('action_failed'), () => ({ ended: closedState(reason) })),
    [send, t],
  )
  const onUndo = useCallback(
    (item: QuestionItem) => void send(item, 'reopen', {}, t('undo_failed'), () => ({ ended: null })),
    [send, t],
  )

  return (
    <div className="space-y-8">
      <PageHeader
        title={t('title')}
        help={
          <HelpPopover>
            <p>{t('help')}</p>
          </HelpPopover>
        }
      />
      {items === null ? (
        <LoadError onRetry={() => void reload()} className={loading ? 'opacity-60' : undefined} />
      ) : items.length === 0 ? (
        <EmptyState title={t('empty')} />
      ) : (
        <ul className={cn(LIST_BLEED_CLASS, 'stagger-enter border-t-hairline')}>
          {items.map((item) => (
            <QuestionBlock
              key={item.question.question_id}
              item={item}
              canWrite={canWrite}
              t={t}
              onAnswer={onAnswer}
              onClose={onClose}
              onUndo={onUndo}
            />
          ))}
        </ul>
      )}
    </div>
  )
}
