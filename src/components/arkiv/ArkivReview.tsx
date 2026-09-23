'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslations } from 'next-intl'
import { HelpPopover } from '@/components/ui/help-popover'
import { PageHeader } from '@/components/ui/page-header'
import { Skeleton } from '@/components/ui/skeleton'
import { useToast } from '@/components/ui/use-toast'
import type { ReviewData } from '@/app/api/arkiv/review/route'
import type { FindingView } from '@/app/api/arkiv/findings/route'
import { questionsFrom, type ArkivQuestion } from '@/lib/arkiv/questions'
import { DocumentDecision, type DecisionDocument } from './DocumentDecision'
import { QuestionCard, decisionDocumentFor } from './QuestionCard'

/**
 * Granska (canvas artboard Granska): the questions Arkiv has for a person,
 * each answered with one tap and its consequence stated in place. The
 * decision sheet is one link away for an answer that is not on a chip.
 */
export function ArkivReview() {
  const t = useTranslations('arkiv')
  const { toast } = useToast()
  const [data, setData] = useState<ReviewData | null>(null)
  const [findings, setFindings] = useState<FindingView[] | null>(null)
  const [failed, setFailed] = useState(false)
  const [open, setOpen] = useState<DecisionDocument | null>(null)
  const [answered, setAnswered] = useState<Set<string>>(new Set())

  const load = useCallback(async () => {
    try {
      const [review, found] = await Promise.all([fetch('/api/arkiv/review'), fetch('/api/arkiv/findings')])
      if (!review.ok || !found.ok) throw new Error('load')
      setData(((await review.json()) as { data: ReviewData }).data)
      setFindings(((await found.json()) as { data: FindingView[] }).data)
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
  const left = questions.filter((q) => !answered.has(q.id)).length

  const openSheet = (q: ArkivQuestion) => setOpen(decisionDocumentFor(q))

  return (
    <div className="space-y-6">
      <PageHeader title={t('review_title')} help={<HelpPopover>{t('review_help')}</HelpPopover>} />

      {failed && <p className="text-[13px] text-muted-foreground">{t('load_failed')}</p>}
      {!data && !failed && (
        <div className="space-y-3">
          <Skeleton className="h-6 w-1/3" />
          <Skeleton className="h-6 w-2/3" />
        </div>
      )}

      {data && (
        <div>
          <div className="flex items-baseline justify-between border-b border-border px-1 pb-2.5">
            <h2 className="text-sm font-medium">{t('review_title')}</h2>
            <span className="text-xs text-muted-foreground">{t('review_count', { count: left })}</span>
          </div>
          {questions.length === 0 && <p className="px-1 py-6 text-[13px] text-muted-foreground">{t('review_all_clear')}</p>}
          {groups.map((group) => {
            const list = questions.filter((q) => q.kind === group.key)
            if (list.length === 0) return null
            return (
              <section key={group.id} id={group.id}>
                <div className="px-1 pb-1 pt-5 text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground/80">{group.title}</div>
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
