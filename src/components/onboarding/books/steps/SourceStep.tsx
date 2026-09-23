'use client'

import { useTranslations } from 'next-intl'
import { Lock } from 'lucide-react'
import { BRANCH_PROVIDERS } from '@/lib/onboarding-journey/branch'
import Question from '@/components/onboarding/journey/Question'
import { Pill } from '../ui/Pills'
import type { BooksCtx } from '../context'

/**
 * Var fanns bokföringen innan? One column of equal rows: the providers with
 * their logo, the SIE file as the last row of the same list, a new business
 * as one quiet row below it. Visma and Bokio go SIE first (their API does
 * not hand out the ledger); the rest log in. No skip: the books come in, or
 * the business is new. Under the list, before anything leaves the old
 * system: where the data will live, in the two facts the privacy policy and
 * the DPA already state (Stockholm, TLS 1.3 and AES-256). Nothing here that
 * is not yet true.
 */

/** The Swedish flag at chip size: 16:10, the cross at 5:2:9 by 4:2:4. */
function SwedishFlag() {
  return (
    <svg className="trust-flag" viewBox="0 0 16 10" aria-hidden="true">
      <rect width="16" height="10" fill="#005293" />
      <rect x="5" width="2" height="10" fill="#FECB00" />
      <rect y="4" width="16" height="2" fill="#FECB00" />
    </svg>
  )
}
export function SourceStep({ ctx }: { ctx: BooksCtx }) {
  const t = useTranslations('books')
  const { dispatch, flags } = ctx
  const providers = flags.hasMigration ? BRANCH_PROVIDERS : []

  return (
    <Question title={t('source_title')}>
      <div className="srclist">
        {providers.map((p, i) => (
          <Pill key={p.id} index={i} logo={p.logo} onClick={() => dispatch({ type: 'PICK_PROVIDER', provider: p.id })}>
            {p.name}
          </Pill>
        ))}
        <Pill index={providers.length} text onClick={() => dispatch({ type: 'PICK_SIE' })}>
          {t('source_sie')}
        </Pill>
        <hr className="srclist-sep" />
        <Pill index={providers.length + 1} text onClick={() => dispatch({ type: 'PICK_FRESH', flags })}>
          {t('source_fresh')}
        </Pill>
      </div>
      <div className="trust" aria-label={t('trust_line')}>
        <p className="trust-line">{t('trust_line')}</p>
        <ul className="trust-chips">
          <li><SwedishFlag />{t('trust_region')}</li>
          <li><Lock size={14} aria-hidden="true" />{t('trust_encryption')}</li>
        </ul>
      </div>
    </Question>
  )
}
