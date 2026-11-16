'use client'

import { useTranslations } from 'next-intl'
import { AttnLine } from '@/components/ui/attn-line'
import { cn, formatDateTime } from '@/lib/utils'
import type { ReportDataStatusResult } from '@/lib/reports/data-status'

/**
 * How current the nyckeltal are: unbooked bank rows in the period and the bank
 * feed's last sync, read from the report data status the KPI route returns
 * (lib/reports/data-status.ts, the block the MCP tool hands agents). Without
 * it, Kassa reads as current even when the bank feed stopped weeks ago.
 *
 * A muted meta line normally. When the feed leaves rows out of the period
 * (data status bank.stale), the line becomes the page's ochre attention
 * sentence with a way to the bank connection, unless the page already shows
 * one (`quiet`): one attention line per page (UI convention 6).
 */
export function KPIFreshness({
  status,
  quiet = false,
  className,
}: {
  status: ReportDataStatusResult
  quiet?: boolean
  className?: string
}) {
  const t = useTranslations('kpi')
  const metaClass = cn('text-xs leading-5 text-muted-foreground tabular-nums', className)

  if ('unavailable' in status) {
    return <p className={metaClass}>{t('freshness_unavailable')}</p>
  }

  const unbooked = t('freshness_unbooked', { count: status.unbooked_transactions })
  const { feed_status: feed, last_sync_at: lastSync, stale } = status.bank

  if (stale && lastSync) {
    const sentence = t(feed === 'stopped' ? 'freshness_bank_stopped' : 'freshness_bank_stale', {
      date: formatDateTime(lastSync),
    })
    if (!quiet) {
      return (
        <AttnLine
          className={cn('tabular-nums', className)}
          action={{ label: t('freshness_bank_action'), href: '/settings/banking' }}
        >
          {unbooked} · {sentence}
        </AttnLine>
      )
    }
    return <p className={metaClass}>{unbooked} · {sentence}</p>
  }

  const bank =
    feed === null
      ? t('freshness_bank_none')
      : lastSync
        ? t('freshness_bank_synced', { date: formatDateTime(lastSync) })
        : t('freshness_bank_never')

  return <p className={metaClass}>{unbooked} · {bank}</p>
}
