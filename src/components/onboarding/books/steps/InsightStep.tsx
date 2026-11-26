'use client'

import { useTranslations } from 'next-intl'
import Question from '@/components/onboarding/journey/Question'
import { yearsOfBooks } from '@/lib/onboarding/books-years'
import { InsightPanel } from '../ui/InsightPanel'
import type { BooksCtx } from '../context'
import { Button } from '@/components/ui/button'

/**
 * Genomlysningen on its own: only reached from the source step's shortcut
 * when the books were already here (a reload after an import). After an
 * import in this session the same panel sits under the theater instead.
 */
export function InsightStep({ ctx }: { ctx: BooksCtx }) {
  const t = useTranslations('books')
  const tCommon = useTranslations('common')
  const { dispatch, flags, findings, findingsFailed, loadingFindings, loadFindings } = ctx
  const next = flags.hasBanking ? t('to_bank') : flags.hasSkatteverket ? t('to_skv') : t('to_done')
  // A failed read is not "nothing imported": it says so, with the retry.
  const failed = !findings && findingsFailed
  // With the sources arrangement the way on sits right under the headline,
  // before the detail panel, so it is in view without scrolling.
  const nextFirst = flags.sourcesFlow === true && !failed
  const nextButton = (
    <div className={nextFirst ? 'jny-qactions is-first' : 'jny-qactions'}>
      <Button size="lg" onClick={() => dispatch({ type: 'AFTER_BOOKS', flags })}>
        {next}
      </Button>
    </div>
  )
  return (
    <Question
      title={
        failed
          ? t('insight_title_failed')
          : findings && findings.books.entries > 0
            ? t('insight_title', { count: findings.books.entries, years: yearsOfBooks(findings.books) })
            : t('insight_title_empty')
      }
      sub={failed ? undefined : t('insight_sub')}
    >
      {nextFirst ? nextButton : null}
      {failed ? (
        <div className="jny-qactions">
          <Button variant="outline" loading={loadingFindings} onClick={() => void loadFindings()}>
            {tCommon('retry')}
          </Button>
        </div>
      ) : (
        <InsightPanel ctx={ctx} />
      )}
      {nextFirst ? null : nextButton}
    </Question>
  )
}
