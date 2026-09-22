'use client'

import { useEffect, useState } from 'react'
import { useTranslations } from 'next-intl'
import type { ArkivUsage } from '@/lib/arkiv/usage'

/**
 * What Arkiv did for the company the last rolling year (phase 9e): the
 * numbers sizes and packs will be priced on, shown before any of that
 * exists so nothing about the meter is a surprise later. Renders nothing
 * outside the rollout (the route is 404 there) and nothing while unknown.
 */
export function ArkivUsageSection() {
  const t = useTranslations('settings_billing')
  const [usage, setUsage] = useState<ArkivUsage | null>(null)

  useEffect(() => {
    let active = true
    fetch('/api/arkiv/usage')
      .then(async (res) => (res.ok ? ((await res.json()) as { data: ArkivUsage }).data : null))
      .then((data) => {
        if (active && data) setUsage(data)
      })
      .catch(() => undefined)
    return () => {
      active = false
    }
  }, [])

  if (!usage) return null
  return (
    <section className="mt-8 border-t border-border px-1 pt-6">
      <h2 className="text-sm font-medium">{t('arkiv_usage_title')}</h2>
      <p className="mt-1 text-[13px] tabular-nums">{t('arkiv_usage_line', { documents: usage.documents, pages: usage.pages_read, asks: usage.asks })}</p>
      <p className="mt-1 text-xs text-muted-foreground">{t('arkiv_usage_note')}</p>
    </section>
  )
}
