'use client'

import { useTranslations } from 'next-intl'
import { Button } from '@/components/ui/button'
import { TH_CLASS, TD_CLASS, QUIET_LINK_CLASS } from '@/components/ui/dry-table'
import { cn, formatCurrency, formatDate } from '@/lib/utils'
import { formatVoucher } from '@/lib/bookkeeping/voucher-series-resolver'

/**
 * The automatic matcher's dry-run preview, inline on the Avstämning page:
 * candidate transaction↔verifikat pairs with confidence, applied per row or
 * all strong ones at once. Same endpoint and same server-side intersection
 * guard as the old bank view; this is only the surface. Pairs at or above
 * STRONG_CONFIDENCE mirror the old view's preselect floor.
 */

export const STRONG_CONFIDENCE = 0.85

export interface MatcherMatch {
  transaction_id: string
  transaction_date: string
  transaction_description: string
  transaction_amount: number
  journal_entry_id: string
  voucher_number: number
  voucher_series: string
  entry_date: string
  entry_description: string
  method: string
  confidence: number
}

interface MatcherPreviewProps {
  matches: MatcherMatch[]
  currency: string
  busy: boolean
  onApply: (pairs: MatcherMatch[], strongOnly: boolean) => void
  onClose: () => void
}

export function MatcherPreview({ matches, currency, busy, onApply, onClose }: MatcherPreviewProps) {
  const t = useTranslations('reconciliation')
  const strong = matches.filter((m) => m.confidence >= STRONG_CONFIDENCE)

  if (matches.length === 0) {
    return (
      <p className="text-[13px] text-muted-foreground">
        {t('matcher_none')}{' '}
        <button type="button" onClick={onClose} className={QUIET_LINK_CLASS}>
          {t('matcher_close')}
        </button>
      </p>
    )
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <p className="text-[13px]">
          {t('matcher_title', { count: matches.length })}
        </p>
        {strong.length > 0 && (
          <Button size="sm" onClick={() => onApply(strong, true)} disabled={busy}>
            {t('matcher_apply_strong', { count: strong.length })}
          </Button>
        )}
        <button type="button" onClick={onClose} disabled={busy} className={cn(QUIET_LINK_CLASS, 'ml-auto')}>
          {t('matcher_close')}
        </button>
      </div>
      <div className="-mx-4 overflow-x-auto sm:mx-0">
        <table className="w-full text-[13px]">
          <thead>
            <tr>
              <th className={cn(TH_CLASS, 'w-[110px]')}>{t('col_date')}</th>
              <th className={TH_CLASS}>{t('col_event')}</th>
              <th className={cn(TH_CLASS, 'w-[140px] text-right')}>{t('col_amount')}</th>
              <th className={cn(TH_CLASS, 'w-[34%]')}>{t('col_proposal')}</th>
              <th className={cn(TH_CLASS, 'w-[120px]')} />
            </tr>
          </thead>
          <tbody className="stagger-enter">
            {matches.map((m) => (
              <tr key={`${m.transaction_id}:${m.journal_entry_id}`} className="group">
                <td className={cn(TD_CLASS, 'whitespace-nowrap tabular-nums text-muted-foreground')}>
                  {formatDate(m.transaction_date)}
                </td>
                <td className={cn(TD_CLASS, 'max-w-0')}>
                  <span className="block truncate" data-ph-mask title={m.transaction_description}>
                    {m.transaction_description}
                  </span>
                </td>
                <td className={cn(TD_CLASS, 'whitespace-nowrap text-right tabular-nums')} data-ph-mask>
                  {formatCurrency(m.transaction_amount, currency)}
                </td>
                <td className={cn(TD_CLASS, 'max-w-0')}>
                  <span className="flex items-center gap-2">
                    <span className="tabular-nums" data-ph-mask>
                      {formatVoucher({ voucher_series: m.voucher_series, voucher_number: m.voucher_number })}
                    </span>
                    <span className="text-[11.5px] tabular-nums text-muted-foreground">{formatDate(m.entry_date)}</span>
                    <span
                      className={cn(
                        'whitespace-nowrap rounded-full px-1.5 py-px text-[10.5px]',
                        m.confidence >= STRONG_CONFIDENCE
                          ? 'bg-success/10 text-success'
                          : 'bg-muted text-muted-foreground',
                      )}
                    >
                      {m.confidence >= STRONG_CONFIDENCE
                        ? t('matcher_strong')
                        : t('confidence', { percent: Math.round(m.confidence * 100) })}
                    </span>
                  </span>
                  <span className="block truncate text-[12px] text-muted-foreground" data-ph-mask>
                    {m.entry_description}
                  </span>
                </td>
                <td className={cn(TD_CLASS, 'text-right')}>
                  <Button size="sm" variant="outline" onClick={() => onApply([m], false)} disabled={busy}>
                    {t('row_match')}
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
