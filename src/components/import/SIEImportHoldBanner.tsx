'use client'

import { useEffect, useState } from 'react'
import { useTranslations } from 'next-intl'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { AttnLine } from '@/components/ui/attn-line'

type HeldPeriod = {
  id: string
  name: string
  import_hold: string | null
  opening_balance_review_token?: string | null
}

export function SIEImportHoldBanner({ companyId }: { companyId: string | null }) {
  const t = useTranslations('import.sie_job')
  const reviewText = useTranslations('import')
  const pathname = usePathname()
  const [snapshot, setSnapshot] = useState<{ companyId: string; periods: HeldPeriod[] } | null>(null)
  useEffect(() => {
    if (!companyId) return
    const activeCompanyId = companyId
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    let inFlight = false
    let hasActiveImport = false
    const isVisible = () => document.visibilityState !== 'hidden'

    async function refresh() {
      clearTimeout(timer)
      if (!isVisible() || inFlight || controller.signal.aborted) return
      inFlight = true
      try {
        const response = await fetch('/api/import/sie/holds', { signal: controller.signal, cache: 'no-store' })
        if (response.ok) {
          const { data } = await response.json() as { data: HeldPeriod[] }
          if (!controller.signal.aborted) {
            hasActiveImport = data.some(period => period.import_hold)
            setSnapshot({ companyId: activeCompanyId, periods: data })
          }
        }
      } catch {
        // Keep the last known hold visible while disconnected.
      } finally {
        inFlight = false
        if (!controller.signal.aborted && isVisible()) {
          timer = setTimeout(refresh, hasActiveImport ? 5000 : 60000)
        }
      }
    }

    // Refresh on navigation or return to the tab. Idle pages need only a slow
    // safety poll; hidden tabs do not poll at all.
    document.addEventListener('visibilitychange', refresh)
    window.addEventListener('focus', refresh)
    void refresh()
    return () => {
      controller.abort()
      clearTimeout(timer)
      document.removeEventListener('visibilitychange', refresh)
      window.removeEventListener('focus', refresh)
    }
  }, [companyId, pathname])
  const periods = snapshot?.companyId === companyId ? snapshot.periods : []
  const holds = periods.filter(period => period.import_hold)
  const reviews = periods.filter(period => period.opening_balance_review_token)
  if (!holds.length && !reviews.length) return null
  if (!holds.length) return <aside className="mb-6" role="status"><AttnLine>
    {reviewText('next_year_review', { name: reviews.map(period => period.name).join(', ') })}{' '}
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
