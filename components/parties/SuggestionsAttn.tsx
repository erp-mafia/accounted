'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { AttnLine } from '@/components/ui/attn-line'
import type { RegisterCounts } from '@/lib/parties/register'

/**
 * The one line on Leverantörer and Kunder that leads to the queue: how many
 * suggestions from the books are waiting for this side. Renders nothing
 * when there is nothing to do, so the pages stay as they were.
 */
export function SuggestionsAttn({ side }: { side: 'supplier' | 'customer' }) {
  const t = useTranslations('parties')
  const router = useRouter()
  const [counts, setCounts] = useState<RegisterCounts | null>(null)

  useEffect(() => {
    let cancelled = false
    fetch('/api/parties?view=suggested')
      .then(async (res) => {
        if (!res.ok) return
        const json = (await res.json()) as { data: { counts: RegisterCounts } }
        if (!cancelled) setCounts(json.data.counts)
      })
      .catch(() => {
        // The line is a convenience; a failed count shows nothing.
      })
    return () => {
      cancelled = true
    }
  }, [])

  if (!counts) return null
  const n = side === 'supplier' ? counts.suggestedSuppliers : counts.suggestedCustomers
  if (n > 0) {
    return (
      <AttnLine action={{ label: t('attn_review'), onClick: () => router.push('/parties') }}>
        {side === 'supplier' ? t('attn_suppliers', { count: n }) : t('attn_customers', { count: n })}
      </AttnLine>
    )
  }
  if (side === 'supplier' && counts.suggested === 0 && counts.observed > 0) {
    return (
      <AttnLine action={{ label: t('attn_fetch'), onClick: () => router.push('/parties?view=observed') }}>
        {t('attn_observed', { count: counts.observed })}
      </AttnLine>
    )
  }
  return null
}
