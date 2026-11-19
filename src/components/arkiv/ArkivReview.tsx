'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslations } from 'next-intl'
import { HelpPopover } from '@/components/ui/help-popover'
import { PageHeader } from '@/components/ui/page-header'
import { LateReveal, Skeleton } from '@/components/ui/skeleton'
import { EmptyState, LoadError } from '@/components/ui/empty-state'
import { AttnLine } from '@/components/ui/attn-line'
import { CheckIcon } from '@/components/icons'
import { useToast } from '@/components/ui/use-toast'
import type { ReviewData } from '@/app/api/arkiv/review/route'
import type { FindingView } from '@/app/api/arkiv/findings/route'
import { questionsFrom, type ArkivQuestion } from '@/lib/arkiv/questions'
import { DocumentDecision, type DecisionDocument } from './DocumentDecision'
import { QuestionCard, decisionDocumentFor } from './QuestionCard'

/**
 * Granska: the questions Arkiv has for a person,
 * each answered with one tap: the card fades out and a toast says what
 * happens next. The count sits in the top bar. The decision sheet is one
 * link away for an answer that is not on a chip.
 */
export function ArkivReview() {
  const t = useTranslations('arkiv')
  const tCommon = useTranslations('common')
  const { toast } = useToast()
  const [data, setData] = useState<ReviewData | null>(null)
  const [findings, setFindings] = useState<FindingView[] | null>(null)
  const [failed, setFailed] = useState(false)
  const [open, setOpen] = useState<DecisionDocument | null>(null)
  const [answered, setAnswered] = useState<Set<string>>(new Set())

  const load = useCallback(async () => {
    try {
      const [review, found] = await Promise.all([fetch('/api/arkiv/review'), fetch('/api/arkiv/findings')])
      // Findings come from the company brain; without it the page asks the document questions alone.
      if (!review.ok || (!found.ok && found.status !== 404)) throw new Error('load')
      setData(((await review.json()) as { data: ReviewData }).data)
      setFindings(found.ok ? ((await found.json()) as { data: FindingView[] }).data : [])
      setAnswered(new Set())
      setFailed(false)
    } catch {
      setFailed(true)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const questions = useMemo(() => questionsFrom(data, findings), [data, findings])
  const groups = useMemo(
    () => [
      { id: 'dorr', key: 'held' as const, title: t('held_title') },
      { id: 'typ', key: 'type' as const, title: t('unclassified_title') },
      { id: 'falt', key: 'field' as const, title: t('fields_title') },
      { id: 'fynd', key: 'finding' as const, title: t('findings_title') },
    ],
    [t],
  )
  // An answered card fades out and then reports itself answered: from then on
  // it is gone from its group and from the count in the top bar.
  const unanswered = questions.filter((q) => !answered.has(q.id))
  const left = unanswered.length

  const openSheet = (q: ArkivQuestion) => setOpen(decisionDocumentFor(q))

  return (
    <div className="space-y-6">
      <PageHeader
        title={t('review_title')}
        help={<HelpPopover>{t('review_help')}</HelpPopover>}
        meta={data ? t('review_count', { count: left }) : undefined}
      />

      {failed && data && (
        <AttnLine action={{ label: tCommon('retry'), onClick: () => void load() }}>{tCommon('refresh_failed')}</AttnLine>
      )}
      {failed && !data && (
        <LoadError
          onRetry={() => {
            setFailed(false)
            void load()
          }}
        />
      )}
      {!data && !failed && (
        <LateReveal className="space-y-3">
          <Skeleton className="h-6 w-1/3" />
          <Skeleton className="h-6 w-2/3" />
        </LateReveal>
      )}

      {data && (
        <div>
          {left === 0 && <EmptyState tone="done" icon={CheckIcon} title={t('review_all_clear')} />}
          {groups.map((group) => {
            const list = unanswered.filter((q) => q.kind === group.key)
            if (list.length === 0) return null
            return (
              <section key={group.id} id={group.id}>
                <div className="px-1 pb-1 pt-5 text-xs font-medium text-muted-foreground">{group.title}</div>
                {list.map((q) => (
                  <QuestionCard key={q.id} question={q} onMore={openSheet} onAnswered={(a) => setAnswered((prev) => new Set(prev).add(a.id))} />
                ))}
              </section>
            )
          })}
        </div>
      )}

      <DocumentDecision
        doc={open}
        onClose={() => setOpen(null)}
        onSaved={(message) => {
          toast({ title: message })
          setOpen(null)
          void load()
        }}
        onFailed={() => toast({ title: t('action_failed'), variant: 'destructive' })}
      />
    </div>
  )
}
