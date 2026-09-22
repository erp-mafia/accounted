'use client'

import { useTranslations } from 'next-intl'
import Question from '@/components/onboarding/journey/Question'
import { InsightPanel } from '../ui/InsightPanel'
import type { BooksCtx } from '../context'

/**
 * Genomlysningen on its own: only reached from the source step's shortcut
 * when the books were already here (a reload after an import). After an
 * import in this session the same panel sits under the theater instead.
 */
export function InsightStep({ ctx }: { ctx: BooksCtx }) {
  const t = useTranslations('books')
  const { dispatch, flags, findings } = ctx
  const next = flags.hasBanking ? t('to_bank') : flags.hasSkatteverket ? t('to_skv') : t('to_done')
  return (
    <Question
      title={findings && findings.books.entries > 0 ? t('insight_title', { count: findings.books.entries, years: findings.books.periods.length }) : t('insight_title_empty')}
      sub={t('insight_sub')}
    >
      <InsightPanel ctx={ctx} />
      <div className="jny-qactions">
        <button type="button" className="jny-btn" onClick={() => dispatch({ type: 'AFTER_BOOKS', flags })}>
          {next}
        </button>
      </div>
    </Question>
  )
}
