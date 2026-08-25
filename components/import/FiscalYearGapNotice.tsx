'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { useTranslations } from 'next-intl'
import { AlertCircle } from 'lucide-react'
import { Card, CardContent } from '@/components/ui/card'
import { QUIET_LINK_CLASS } from '@/components/ui/dry-table'
import { findFiscalYearGaps, type FiscalYearGap, type PeriodLike } from '@/lib/bookkeeping/fiscal-year-gaps'

/**
 * After a SIE import: the years the company now has, with any hole between
 * them called out. Fortnox and friends export one räkenskapsår per file, so
 * "import the next file" is the fix and this is the moment to say it.
 * Renders nothing while loading, on failure, or when the chain is whole.
 */
export function FiscalYearGapNotice() {
  const t = useTranslations('fiscal_year_gaps')
  const [gaps, setGaps] = useState<FiscalYearGap[]>([])

  useEffect(() => {
    let cancelled = false
    fetch('/api/bookkeeping/fiscal-periods')
      .then(async (res) => {
        if (!res.ok) return
        const json = await res.json()
        const periods = (Array.isArray(json) ? json : (json.data ?? [])) as PeriodLike[]
        if (!cancelled) setGaps(findFiscalYearGaps(periods))
      })
      .catch(() => {
        // Advisory only.
      })
    return () => {
      cancelled = true
    }
  }, [])

  if (gaps.length === 0) return null

  return (
    <Card className="border-attn/50">
      <CardContent className="flex items-start gap-3 pt-6">
        <AlertCircle className="mt-0.5 h-5 w-5 shrink-0 text-attn" aria-hidden="true" />
        <div className="space-y-1 text-[13px] leading-5">
          <p className="font-medium">{t('title', { count: gaps.length })}</p>
          {gaps.map((gap) => (
            <p key={`${gap.missing_from}-${gap.missing_to}`} className="text-muted-foreground tabular-nums">
              {t('gap', { from: gap.missing_from, to: gap.missing_to, after: gap.after.name, before: gap.before.name })}
            </p>
          ))}
          <p className="text-muted-foreground">
            {t('hint')}{' '}
            <Link href="/settings/bookkeeping" className={QUIET_LINK_CLASS}>
              {t('manage')}
            </Link>
          </p>
        </div>
      </CardContent>
    </Card>
  )
}
