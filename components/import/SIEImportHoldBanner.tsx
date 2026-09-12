'use client'

import { useEffect,useState } from 'react'
import { useTranslations } from 'next-intl'
import Link from 'next/link'
import { AttnLine } from '@/components/ui/attn-line'

export function SIEImportHoldBanner({companyId}:{companyId:string|null}) {
  const t = useTranslations('import.sie_job')
  const reviewText = useTranslations('import')
  const [periods,setPeriods] = useState<Array<{id:string;name:string;import_hold:string|null;opening_balance_review_token?:string|null}>>([])
  useEffect(() => {
    if (!companyId) return
    const controller = new AbortController()
    let timer:ReturnType<typeof setTimeout>
    async function refresh() {
      try {
        const response = await fetch('/api/import/sie/holds',{signal:controller.signal,cache:'no-store'})
        if (response.ok && !controller.signal.aborted) setPeriods((await response.json()).data)
      } catch { /* Keep the last known hold visible while disconnected. */ }
      if (!controller.signal.aborted) timer = setTimeout(refresh,5000)
    }
    void refresh()
    return () => {controller.abort();clearTimeout(timer)}
  },[companyId])
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
