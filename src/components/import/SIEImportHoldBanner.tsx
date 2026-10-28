'use client'

import { useEffect, useRef, useState } from 'react'
import { useTranslations } from 'next-intl'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { AttnLine } from '@/components/ui/attn-line'
import { createVisiblePoller, type VisiblePoller } from '@/lib/browser/visible-poller'
import {
  createSIEHoldClock,
  fetchSIEHolds,
  onSIEHoldsChanged,
  sieHoldPollInterval,
  sieHoldStaleAfter,
  SIE_HOLD_RETRY_MS,
  type HeldPeriod,
} from '@/lib/import/sie-holds-client'

export function SIEImportHoldBanner({ companyId }: { companyId: string | null }) {
  const t = useTranslations('import.sie_job')
  const reviewText = useTranslations('import')
  const pathname = usePathname()
  const [snapshot, setSnapshot] = useState<{ companyId: string; periods: HeldPeriod[] } | null>(null)
  const pollerRef = useRef<VisiblePoller | null>(null)
  useEffect(() => {
    if (!companyId) return
    const activeCompanyId = companyId
    // Mounted on every dashboard page: follow a new hold every 5 s and an
    // old one every minute, otherwise refetch only when it can have changed
    // (lib/import/sie-holds-client.ts).
    const clock = createSIEHoldClock()
    const poller = createVisiblePoller({
      load: fetchSIEHolds,
      onResult: (periods) => setSnapshot({ companyId: activeCompanyId, periods }),
      intervalMs: (last) => sieHoldPollInterval(last, clock.heldFor(last)),
      staleAfterMs: sieHoldStaleAfter,
      retryMs: SIE_HOLD_RETRY_MS,
      isVisible: () => document.visibilityState !== 'hidden',
    })
    pollerRef.current = poller
    const unsubscribe = onSIEHoldsChanged(() => {
      clock.restart()
      poller.refresh()
    })
    document.addEventListener('visibilitychange', poller.nudge)
    window.addEventListener('focus', poller.nudge)
    poller.refresh()
    return () => {
      poller.stop()
      pollerRef.current = null
      unsubscribe()
      document.removeEventListener('visibilitychange', poller.nudge)
      window.removeEventListener('focus', poller.nudge)
    }
  }, [companyId])
  // A navigation is a nudge, not a fetch.
  useEffect(() => {
    pollerRef.current?.nudge()
  }, [pathname])
  const periods = snapshot?.companyId === companyId ? snapshot.periods : []
  const holds = periods.filter(period => period.import_hold)
  const reviews = periods.filter(period => period.opening_balance_review_token)
  if (!holds.length && !reviews.length) return null
  // A year without an IB verifikat had its IB derived from the undone year:
  // "not changed automatically" would be untrue for it.
  const derived = reviews.every(period => !period.opening_balance_entry_id)
  if (!holds.length) return <aside className="mb-6" role="status"><AttnLine>
    {reviewText(derived ? 'next_year_review_derived' : 'next_year_review', { name: reviews.map(period => period.name).join(', ') })}{' '}
    <Link className="underline underline-offset-2" href="/settings/bookkeeping">{reviewText('next_year_review_action')}</Link>
  </AttnLine></aside>
  return <aside className="mb-6" role="status">
    <AttnLine>
      {t('hold')}{' '}
      {holds.map((hold, index) => <span key={hold.id}>
        {index > 0 && ', '}
        <Link className="underline underline-offset-2" href={`/import?mode=sie&job=${hold.import_hold}`}>
          {hold.name}: {t('open')}
        </Link>
      </span>)}
    </AttnLine>
  </aside>
}
